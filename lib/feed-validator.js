import { XMLParser } from 'fast-xml-parser';
import { TextDecoder } from 'util';

export const xmlParser = new XMLParser({ ignoreAttributes: false });

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = [500, 1500, 3000];

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
async function readResponseBody(res, maxBytes = MAX_RESPONSE_BYTES) {
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
    return raw.toString('utf-8');
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
  const { timeout = DEFAULT_OPTIONS.timeout, userAgent = DEFAULT_OPTIONS.userAgent, method } = options;

  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': userAgent },
        redirect: 'follow',
        ...(method ? { method } : {})
      });

      clearTimeout(timeoutId);
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      const isLast = attempt === FETCH_RETRIES - 1;
      if (isLast) {
        console.warn(`[fetchSafe] Error fetching ${url.slice(0, 120)}: ${err?.message ?? err} (${attempt + 1} intentos)`);
        return null;
      }
      const delay = FETCH_RETRY_DELAY_MS[attempt] ?? 2000;
      console.warn(`[fetchSafe] Reintento ${attempt + 1}/${FETCH_RETRIES} para ${url.slice(0, 120)} (esperando ${delay}ms): ${err?.message ?? err}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
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

export function getMostRecentDate(items, channelDate = null) {
  const itemList = Array.isArray(items) ? items : (items ? [items] : []);
  let latest = null;

  for (const item of itemList) {
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
 * Verifica si una URL es un feed RSS/Atom/JSON válido con items
 * @param {string} url - URL del feed
 * @param {object} options - Opciones de configuración
 * @returns {Promise<{ type: 'RSS' | 'Atom' | 'JSON', itemCount: number, title?: string, lastItemDate?: string } | { error: string, code?: number } | null>}
 */
export async function checkFeedUrl(url, options = {}) {
  const { 
    minTitleLength = DEFAULT_OPTIONS.minTitleLength,
    requireValidLink = DEFAULT_OPTIONS.requireValidLink 
  } = options;
  
  const res = await fetchSafe(url, options);
  if (!res) return { error: 'no responde', code: null };
  if (!res.ok) return { error: 'HTTP error', code: res.status };

  let text;
  try {
    text = await readResponseBody(res);
  } catch (err) {
    console.warn(`[checkFeedUrl] Error reading body from ${url.slice(0, 120)}: ${err.message}`);
    return { error: 'body inválido o demasiado grande', code: null };
  }

  if (text.trimStart().startsWith('<html') || text.trimStart().startsWith('<!DOCTYPE')) {
    return { error: 'HTML (no es feed)', code: null };
  }

  const type = detectFeedType(text);
  if (!type) return { error: 'no es RSS/Atom', code: null };

  if (type === 'JSON') {
    try {
      return validateJsonFeed(text, url);
    } catch {
      return { error: 'JSON inválido', code: null };
    }
  }

  try {
    const parsed = xmlParser.parse(text);
    const channel = parsed?.rss?.channel || parsed?.feed || parsed?.['rdf:RDF']?.channel;
    if (!channel) return { error: 'sin canal', code: null };

    const items = channel.item || channel.entry || [];
    const itemCount = Array.isArray(items) ? items.length : (items ? 1 : 0);

    if (itemCount === 0) {
      const title = channel.title || '(sin título)';
      return { type, itemCount: 0, title };
    }

    const itemList = Array.isArray(items) ? items : [items];
    const hasValidItem = itemList.some(item => validateXmlItem(item, requireValidLink).valid);

    if (!hasValidItem) return { error: 'items sin contenido válido', code: null };

    const title = channel.title || '(sin título)';
    const channelDate = channel?.lastBuildDate || channel?.pubDate || null;
    const lastItemDate = getMostRecentDate(items, channelDate);
    return { type, itemCount, title, lastItemDate };

  } catch (err) {
    console.warn(`[checkFeedUrl] Parse error for ${url.slice(0, 120)}: ${err?.message ?? err}`);
    return { error: 'XML inválido', code: null };
  }
}

/**
 * Valida un JSON Feed.
 * @param {string} text - Contenido del feed en JSON
 * @param {string} url - URL del feed (para logging)
 * @returns {{ type: 'JSON', itemCount: number, title?: string, lastItemDate?: string } | { error: string, code?: number }}
 */
function validateJsonFeed(text, url) {
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


