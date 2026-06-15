import { fetchSafe, checkFeedUrl, readResponseBody } from './feed-validator.js';

const homepageDataCache = new Map();

export function clearHomepageCache() {
  homepageDataCache.clear();
}

export const FEED_PATTERNS = [
  '/feed/', '/feed', '/rss/', '/rss', '/rss.xml', '/feed.xml',
  '/atom/', '/atom', '/rss/atom', '/atom.xml', '/index.xml', '/feeds', '/feeds/',

  '/feed.json',

  '/feeds/posts/default',
  '/feeds/all.atom.xml',

  '/?feed=rss2',
  '/feed/atom/',
  '/?format=feed&type=rss',

  '/.well-known/feeds',
  '/.well-known/feed',

  '/rss/chile/portada.xml',
  '/comments/feed/',
  '/category/blog/feed/',
  '/blog/feed/',
  '/rss/global.xml',
  '/deporte/feed/rss/',
  '/arc/outboundfeeds/rss/category/chile/?outputType=xml',
  '/arc/outboundfeeds/rss/?outputType=xml',
  '/noticias/feed/rss/',
];

/**
 * Extrae URLs de feed desde el header HTTP Link.
 * @param {string|null} linkHeader - Valor del header Link
 * @param {string} baseUrl - URL base para resolver rutas relativas
 * @returns {string[]} URLs de feed encontradas
 */
function parseLinkHeader(linkHeader, baseUrl) {
  if (!linkHeader) return [];
  const origin = new URL(baseUrl).origin;
  const links = linkHeader.split(/(?<=["'])\s*,\s*/);
  const feeds = [];

  for (const link of links) {
    const urlMatch = link.match(/<([^>]+)>/);
    if (!urlMatch) continue;
    let href = urlMatch[1];
    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = origin + href;
    else if (!href.startsWith('http')) continue;

    const relMatch = link.match(/rel\s*=\s*["']([^"']+)["']/i);
    const typeMatch = link.match(/type\s*=\s*["']([^"']+)["']/i);
    const rel = relMatch?.[1]?.toLowerCase();

    if (rel && rel.split(/\s+/).includes('alternate') && typeMatch) {
      const type = typeMatch[1].toLowerCase();
      if (type.includes('rss') || type.includes('atom') || type.includes('feed+json')) {
        feeds.push(href);
      }
    }
  }
  return feeds;
}

/**
 * Extrae URLs de feed desde bloques JSON-LD (<script type="application/ld+json">).
 * Busca objetos con @type: "WebFeed" y campo "url".
 * @param {string} html - HTML del sitio
 * @returns {string[]} URLs de feed encontradas
 */
function extractJsonLdFeeds(html) {
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const urls = [];
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.['@type'] === 'WebFeed' && item?.url) urls.push(item.url);
        if (item?.['@graph']) {
          for (const sub of item['@graph']) {
            if (sub?.['@type'] === 'WebFeed' && sub?.url) urls.push(sub.url);
          }
        }
      }
    } catch { /* ignore invalid JSON-LD */ }
  }
  return urls;
}

export function extractFeedLinksFromHtml(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const linkRe = /<link\b[^>]*>/gi;
  const relRe = /rel=["']alternate["']/i;
  const typeRe = /type=["']application\/(rss|atom)\+xml|application\/feed\+json["']/i;
  const hrefRe = /href=["']([^"']+)["']/i;

  return (html.match(linkRe) ?? [])
    .filter(tag => relRe.test(tag) && typeRe.test(tag))
    .map(tag => {
      const m = tag.match(hrefRe);
      if (!m) return null;
      let href = m[1];
      if (href.startsWith('//')) href = 'https:' + href;
      else if (href.startsWith('/')) href = origin + href;
      else if (!href.startsWith('http')) href = origin + '/' + href;
      return href;
    })
    .filter(Boolean);
}

async function testFeeds(urls) {
  if (urls.length === 0) return null;
  const results = await Promise.allSettled(
    urls.map(async url => {
      const result = await checkFeedUrl(url);
      if (result?.type && result.itemCount > 0) {
        return { feedUrl: url, feedType: result.type, itemCount: result.itemCount };
      }
      return null;
    })
  );
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }
  return null;
}

export async function rediscoverFeed(siteUrl, preferredPatterns = [], onProgress) {
  const base = siteUrl.replace(/\/$/, '');
  /** @type {Set<string>} URLs ya verificadas para evitar duplicados entre etapas */
  const tried = new Set();

  let html;
  let linkHeader;

  if (homepageDataCache.has(base)) {
    const cached = homepageDataCache.get(base);
    if (cached === null) return { error: 'sitio no responde', code: null };
    html = cached.html;
    linkHeader = cached.linkHeader;
  } else {
    onProgress?.('verificando homepage');
    const rootRes = await fetchSafe(base);
    if (!rootRes) {
      homepageDataCache.set(base, null);
      return { error: 'sitio no responde', code: null };
    }
    if (!rootRes.ok) {
      homepageDataCache.set(base, null);
      return { error: 'HTTP error', code: rootRes.status };
    }

    linkHeader = rootRes.headers.get('link');

    try {
      html = await readResponseBody(rootRes);
    } catch (err) {
      console.warn(`[rediscoverFeed] Error reading body from ${siteUrl.slice(0, 120)}: ${err.message}`);
      homepageDataCache.set(base, null);
      return { error: 'sitio no responde', code: null };
    }

    homepageDataCache.set(base, { html, linkHeader });
  }

  // 1. HTTP Link header (no requiere leer body)
  onProgress?.('buscando en header Link');
  const linkFeeds = parseLinkHeader(linkHeader, base);
  if (linkFeeds.length > 0) {
    for (const url of linkFeeds) tried.add(url);
    const found = await testFeeds(linkFeeds);
    if (found) return found;
  }

  // 2. HTML <link> tags (RSS/Atom/JSON Feed)
  onProgress?.('buscando en HTML <link> tags');
  const feedLinks = extractFeedLinksFromHtml(html, base);
  if (feedLinks.length > 0) {
    const newLinks = feedLinks.filter(url => !tried.has(url));
    for (const url of newLinks) tried.add(url);
    const mainFeeds = newLinks.filter(url => !url.includes('/comments/'));
    const found = await testFeeds(mainFeeds.length > 0 ? mainFeeds : newLinks);
    if (found) return found;
  }

  // 3. JSON-LD structured data
  onProgress?.('buscando en JSON-LD');
  const jsonLdFeeds = extractJsonLdFeeds(html);
  if (jsonLdFeeds.length > 0) {
    const newFeeds = jsonLdFeeds.filter(url => !tried.has(url));
    for (const url of newFeeds) tried.add(url);
    if (newFeeds.length > 0) {
      const found = await testFeeds(newFeeds);
      if (found) return found;
    }
  }

  // 4. URL pattern guessing (preferred patterns first, then generic)
  //    Early abort: si varios patrones consecutivos devuelven HTML (catch-all 404),
  //    asumimos que el servidor no tiene feeds y salimos rápido.
  onProgress?.('probando patrones de URL');
  const allPatterns = [...new Set([...preferredPatterns, ...FEED_PATTERNS])];
  let consecutiveHtml = 0;
  const MAX_CONSECUTIVE_HTML = 3;
  for (let i = 0; i < allPatterns.length; i++) {
    const pattern = allPatterns[i];
    const candidate = base + pattern;
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    onProgress?.(`patrón ${i + 1}/${allPatterns.length}`);
    const result = await checkFeedUrl(candidate);
    if (result?.type && result.itemCount > 0) return { feedUrl: candidate, feedType: result.type, itemCount: result.itemCount };
    if (result?.error === 'HTML (no es feed)') {
      consecutiveHtml++;
      if (consecutiveHtml >= MAX_CONSECUTIVE_HTML) {
        break;
      }
    }
  }

  return { error: 'sin feed RSS detectado', code: null };
}
