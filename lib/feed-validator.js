import { XMLParser } from 'fast-xml-parser';
import { TextDecoder } from 'util';
import { acquireSlot, releaseSlot } from './rate-limiter.js';
import { extractSelfLink } from './feed-utils.js';

export const xmlParser = new XMLParser({ ignoreAttributes: false });

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = [500, 1500, 3000];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];
let uaIndex = 0;

/**
 * Detecta charset desde el header Content-Type.
 * @param {string|null} contentType - Valor del header Content-Type
 * @returns {string|null} Encoding detectado (ej. 'utf-8', 'iso-8859-1') o null
 */
function detectCharsetFromContentType(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/charset\s*=\s*["']?([^"'\s;]+)["']?/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Escanea los primeros bytes en busca de declaración XML con encoding.
 * @param {Buffer} raw - Bytes crudos del body
 * @returns {string|null} Encoding declarado en XML o null
 */
function detectEncodingFromXml(raw) {
  const head = raw.subarray(0, Math.min(raw.length, 200)).toString('utf-8');
  const match = head.match(/<\?xml[^>]+encoding\s*=\s*["']([^"']+)["']/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Resuelve la codificación a usar: Content-Type > XML declaration > utf-8.
 * @param {string|null} contentType - Content-Type header
 * @param {Buffer} raw - Bytes crudos del body
 * @returns {string} Encoding normalizado
 */
function resolveEncoding(contentType, raw) {
  return detectCharsetFromContentType(contentType)
    ?? detectEncodingFromXml(raw)
    ?? 'utf-8';
}

/**
 * Lee el body de una Response con límite de tamaño y detección de charset.
 * @param {Response} res - Objeto Response de fetch
 * @param {number} maxBytes - Límite máximo en bytes
 * @returns {Promise<string>} Texto del body
 */
export async function readResponseBody(res, maxBytes = MAX_RESPONSE_BYTES) {
  if (!res.body) throw new Error('body vacío o no disponible');
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks);
  const encoding = resolveEncoding(res.headers.get('content-type'), raw);
  try {
    const decoder = new TextDecoder(encoding, { fatal: false });
    return decoder.decode(raw);
  } catch {
    // Fallback: latin1 (ISO-8859-1) cubre caracteres españoles (tildes, ñ)
    // cuando el servidor declara charset incorrecto o no detectable
    try {
      const decoder = new TextDecoder('latin1', { fatal: false });
      return decoder.decode(raw);
    } catch {
      return raw.toString('utf-8');
    }
  }
}

/**
 * Opciones de configuración para la validación de feeds
 */
export const DEFAULT_OPTIONS = {
  timeout: 10000,
  userAgent: 'Mozilla/5.0 (compatible; FeedValidator/2.0)',
  minTitleLength: 3,
  requireValidLink: true
};

/**
 * Realiza una petición fetch con timeout y User-Agent personalizado
 * @param {string} url - URL a verificar
 * @param {object} options - Opciones de configuración
 * @returns {Promise<Response|null>} - Response o null si falla
 */
export async function fetchSafe(url, options = {}) {
  const { timeout = DEFAULT_OPTIONS.timeout, method } = options;
  const userAgent = options.userAgent || USER_AGENTS[uaIndex++ % USER_AGENTS.length];

  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    try {
      await acquireSlot(url);
    } catch {
      console.warn(`[fetchSafe] URL inválida: ${url?.slice(0, 120) ?? 'undefined'}`);
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let result = null;
    let shouldRetry = false;
    let retryDelay = 0;

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': userAgent },
        redirect: 'follow',
        ...(method ? { method } : {}),
      });
      clearTimeout(timeoutId);

      if ((res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) && attempt < FETCH_RETRIES - 1) {
        shouldRetry = true;
        retryDelay = FETCH_RETRY_DELAY_MS[attempt] ?? 2000;
        console.warn(`[fetchSafe] ${url.slice(0, 120)} (HTTP ${res.status}), reintento ${attempt + 2}/${FETCH_RETRIES} en ${retryDelay}ms`);
      } else {
        result = res;
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (attempt < FETCH_RETRIES - 1) {
        shouldRetry = true;
        retryDelay = FETCH_RETRY_DELAY_MS[attempt] ?? 2000;
        console.warn(`[fetchSafe] ${url.slice(0, 120)}, reintento ${attempt + 2}/${FETCH_RETRIES} en ${retryDelay}ms: ${err?.message ?? err}`);
      } else {
        console.warn(`[fetchSafe] ${url.slice(0, 120)}: ${err?.message ?? err} (${attempt + 1} intentos)`);
      }
    }

    releaseSlot();
    if (result) return result;
    if (shouldRetry) await new Promise(resolve => setTimeout(resolve, retryDelay));
  }

  return null;
}

/**
 * Extrae la fecha de publicación más reciente de los items de un feed.
 * Soporta RSS (<pubDate>, <dc:date>) y Atom (<published>, <updated>).
 * @param {Array|object} items - Items del feed (rss.channel.item o feed.entry)
 * @param {string|null} channelDate - Fecha del canal (<lastBuildDate>/<pubDate>) como fallback
 * @returns {string|null} ISO string de la fecha más reciente, o null si no hay fechas
 */
const SPANISH_MONTHS = {
  'ene.': 'Jan', 'feb.': 'Feb', 'mar.': 'Mar', 'abr.': 'Apr',
  'may.': 'May', 'jun.': 'Jun', 'jul.': 'Jul', 'ago.': 'Aug',
  'sep.': 'Sep', 'oct.': 'Oct', 'nov.': 'Nov', 'dic.': 'Dec',
};

/**
 * Reemplaza abreviaciones de meses en español por su equivalente en inglés
 * para que la cadena sea interpretable por new Date().
 * @param {string} raw - Cadena de fecha con posibles meses en español (ej. "10 ene. 2025")
 * @returns {string} Cadena con meses normalizados a inglés
 */
function normalizeDateString(raw) {
  for (const [es, en] of Object.entries(SPANISH_MONTHS)) {
    const re = new RegExp(es.replace('.', '\\.'), 'gi');
    if (re.test(raw)) return raw.replace(re, en);
  }
  return raw;
}

export function getMostRecentDate(items, channelDate = null, rawText = null) {
  const itemList = Array.isArray(items) ? items : (items ? [items] : []);
  let latest = null;

  for (const item of itemList) {
    if (!item) continue;
    for (const field of ['pubDate', 'dc:date', 'published', 'updated', 'date_published', 'date_modified']) {
      const raw = item[field];
      if (!raw) continue;
      const d = new Date(normalizeDateString(raw));
      if (isNaN(d.getTime())) continue;
      if (d.getFullYear() <= 1970) continue;
      if (!latest || d > latest) latest = d;
    }
  }

  if (!latest && channelDate) {
    const d = new Date(normalizeDateString(channelDate));
    if (!isNaN(d.getTime()) && d.getFullYear() > 1970) latest = d;
  }

  // Fallback: scan raw text with regex if parsed items didn't yield dates
  if (!latest && rawText) {
    const datePatterns = [
      /<pubDate[^>]*>([^<]+)<\/pubDate>/gi,
      /<dc:date[^>]*>([^<]+)<\/dc:date>/gi,
      /<published[^>]*>([^<]+)<\/published>/gi,
      /<updated[^>]*>([^<]+)<\/updated>/gi,
    ];
    for (const pattern of datePatterns) {
      let match;
      while ((match = pattern.exec(rawText)) !== null) {
        const raw = match[1].trim();
        const d = new Date(normalizeDateString(raw));
        if (isNaN(d.getTime())) continue;
        if (d.getFullYear() <= 1970) continue;
        if (!latest || d > latest) latest = d;
      }
    }
  }

  return latest ? latest.toISOString() : null;
}

/**
 * Detecta el tipo de feed (RSS, Atom, JSON o RDF/RSS 1.0)
 * @param {string} text - Contenido del feed
 * @returns {'RSS' | 'Atom' | 'JSON' | null}
 */
export function detectFeedType(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<rss')) return 'RSS';
  if (trimmed.startsWith('<feed')) return 'Atom';
  if (trimmed.startsWith('<rdf:RDF')) return 'RSS';
  if (trimmed.startsWith('{')) return 'JSON';
  if (trimmed.startsWith('<?xml')) {
    const rootMatch = trimmed.match(/<(\w+)[>\s]/);
    if (rootMatch) {
      if (rootMatch[1] === 'rss') return 'RSS';
      if (rootMatch[1] === 'feed') return 'Atom';
      if (rootMatch[1] === 'rdf:RDF') return 'RSS';
    }
  }
  return null;
}

/**
 * Valida un item de feed XML (RSS/Atom/RDF).
 * @returns {{ valid: boolean, title: string, link: string }}
 */
function validateXmlItem(item, requireValidLink) {
  let title = item?.title ? String(item.title).trim() : '';
  if (!title && item?.description) {
    const desc = String(item.description).replace(/<[^>]*>/g, '').trim();
    title = desc.substring(0, 100);
  }
  let link = '';
  if (item?.link) {
    if (typeof item.link === 'string') {
      link = item.link.trim();
    } else if (item.link['@_href']) {
      link = item.link['@_href'].trim();
    }
  }
  const valid = title.length >= 5 && (!requireValidLink || link.startsWith('http') || link.startsWith('/'));
  return { valid, title, link };
}

/**
 * Parsea el XML de un feed y extrae datos comunes (channel, items, fechas).
 * Compartido entre checkFeedUrl y tryFetchFeedInsecure.
 */
export function parseFeedXml(parsed, _type, rawText = null) {
  const channel = parsed?.rss?.channel || parsed?.feed || parsed?.['rdf:RDF']?.channel;
  if (!channel) return null;

  const items = channel.item || channel.entry || [];
  const itemCount = Array.isArray(items) ? items.length : (items ? 1 : 0);
  const title = channel.title || '(sin título)';
  const channelDate = channel?.lastBuildDate || channel?.pubDate || null;
  const lastItemDate = getMostRecentDate(items, channelDate, rawText);
  const itemList = Array.isArray(items) ? items : [items];

  return { channel, items, itemCount, title, channelDate, lastItemDate, itemList };
}

/**
 * Verifica si una URL es un feed RSS/Atom/JSON válido con items
 * @param {string} url - URL del feed
 * @param {object} options - Opciones de configuración
 * @returns {Promise<{ type: 'RSS' | 'Atom' | 'JSON', itemCount: number, title?: string, lastItemDate?: string } | { error: string, code?: number } | null>}
 */
/**
 * Detecta si la respuesta final (tras redirects) tiene un path diferente al
 * solicitado. Esto ocurre cuando /feed/?category=X redirige al feed principal.
 */
function getRedirectUrl(requestedUrl, finalUrl) {
  if (finalUrl === requestedUrl) return null;
  try {
    const reqPath = new URL(requestedUrl).pathname.replace(/\/+$/, '');
    const resPath = new URL(finalUrl).pathname.replace(/\/+$/, '');
    return reqPath !== resPath ? finalUrl : null;
  } catch {
    return null;
  }
}

export async function checkFeedUrl(url, options = {}) {
  const {
    requireValidLink = DEFAULT_OPTIONS.requireValidLink,
  } = options;
  
  const res = await fetchSafe(url, options);
  if (!res) return { error: 'no responde', code: null };
  if (!res.ok) return { error: 'HTTP error', code: res.status };

  const redirectUrl = getRedirectUrl(url, res.url);
  const redirectInfo = redirectUrl ? { redirectUrl } : {};

  let text;
  try {
    text = await readResponseBody(res);
  } catch (err) {
    console.warn(`[checkFeedUrl] Error reading body from ${url.slice(0, 120)}: ${err.message}`);
    return { error: 'body inválido o demasiado grande', code: null, ...redirectInfo };
  }

  if (text.trimStart().startsWith('<html') || text.trimStart().startsWith('<!DOCTYPE')) {
    return { error: 'HTML (no es feed)', code: null, ...redirectInfo };
  }

  const type = detectFeedType(text);
  if (!type) return { error: 'no es RSS/Atom', code: null, ...redirectInfo };

  if (type === 'JSON') {
    try {
      return { ...validateJsonFeed(text, url), ...redirectInfo };
    } catch {
      return { error: 'JSON inválido', code: null, ...redirectInfo };
    }
  }

  const selfLink = extractSelfLink(text);

  try {
    const parsed = xmlParser.parse(text);
    const feedData = parseFeedXml(parsed, type, text);
    if (!feedData) return { error: 'sin canal', code: null, ...redirectInfo };

    if (feedData.itemCount === 0) {
      return { type, itemCount: 0, title: feedData.title, selfLink, ...redirectInfo };
    }

    const itemList = feedData.itemList;
    const hasValidItem = itemList.some(item => validateXmlItem(item, requireValidLink).valid);
    if (!hasValidItem) return { error: 'items sin contenido válido', code: null, ...redirectInfo };

    return { type, itemCount: feedData.itemCount, title: feedData.title, lastItemDate: feedData.lastItemDate, selfLink, ...redirectInfo };

  } catch (err) {
    console.warn(`[checkFeedUrl] Parse error for ${url.slice(0, 120)}: ${err?.message ?? err}`);
    return { error: 'XML inválido', code: null, ...redirectInfo };
  }
}

/**
 * Valida un JSON Feed.
 * @param {string} text - Contenido del feed en JSON
 * @param {string} url - URL del feed (para logging)
 * @returns {{ type: 'JSON', itemCount: number, title?: string, lastItemDate?: string } | { error: string, code?: number }}
 */
function validateJsonFeed(text, _url) {
  const parsed = JSON.parse(text);
  if (!parsed.version) return { error: 'no es RSS/Atom', code: null };

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const itemCount = items.length;

  if (itemCount === 0) {
    return { type: 'JSON', itemCount: 0, title: parsed.title || '(sin título)' };
  }

  const hasValidItem = items.some(item => {
    const title = item?.title ? String(item.title).trim() : '';
    const link = item?.url ? String(item.url).trim() : '';
    if (title.length < 5) return false;
    if (link && !link.startsWith('http')) return false;
    return true;
  });

  if (!hasValidItem) return { error: 'items sin contenido válido', code: null };

  const lastItemDate = getMostRecentDate(items, null);
  return { type: 'JSON', itemCount, title: parsed.title || '(sin título)', lastItemDate };
}


