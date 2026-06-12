import { fetchSafe, checkFeedUrl, MAX_RESPONSE_BYTES } from './feed-validator.js';

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
  for (const url of urls) {
    const result = await checkFeedUrl(url);
    if (result?.type) return { feedUrl: url, feedType: result.type, itemCount: result.itemCount };
  }
  return null;
}

export async function rediscoverFeed(siteUrl) {
  const base = siteUrl.replace(/\/$/, '');
  /** @type {Set<string>} URLs ya verificadas para evitar duplicados entre etapas */
  const tried = new Set();

  const rootRes = await fetchSafe(base);
  if (!rootRes) {
    return { error: 'sitio no responde', code: null };
  }
  if (!rootRes.ok) {
    return { error: 'HTTP error', code: rootRes.status };
  }

  // 1. HTTP Link header (no requiere leer body)
  const linkFeeds = parseLinkHeader(rootRes.headers.get('link'), base);
  if (linkFeeds.length > 0) {
    for (const url of linkFeeds) tried.add(url);
    const found = await testFeeds(linkFeeds);
    if (found) return found;
  }

  let html;
  try {
    if (!rootRes.body) {
      console.warn(`[rediscoverFeed] Empty body from ${siteUrl.slice(0, 120)}`);
      return { error: 'sitio no responde', code: null };
    }
    const reader = rootRes.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        reader.cancel();
        console.warn(`[rediscoverFeed] HTML body too large for ${siteUrl.slice(0, 120)}`);
        return { error: 'respuesta demasiado grande', code: null };
      }
      chunks.push(value);
    }
    html = Buffer.concat(chunks).toString('utf-8');
  } catch (err) {
    console.warn(`[rediscoverFeed] Error reading body from ${siteUrl.slice(0, 120)}: ${err.message}`);
    return { error: 'sitio no responde', code: null };
  }

  // 2. HTML <link> tags (RSS/Atom/JSON Feed)
  const feedLinks = extractFeedLinksFromHtml(html, base);
  if (feedLinks.length > 0) {
    const newLinks = feedLinks.filter(url => !tried.has(url));
    for (const url of newLinks) tried.add(url);
    const mainFeeds = newLinks.filter(url => !url.includes('/comments/'));
    const found = await testFeeds(mainFeeds.length > 0 ? mainFeeds : newLinks);
    if (found) return found;
  }

  // 3. JSON-LD structured data
  const jsonLdFeeds = extractJsonLdFeeds(html);
  if (jsonLdFeeds.length > 0) {
    const newFeeds = jsonLdFeeds.filter(url => !tried.has(url));
    for (const url of newFeeds) tried.add(url);
    if (newFeeds.length > 0) {
      const found = await testFeeds(newFeeds);
      if (found) return found;
    }
  }

  // 4. URL pattern guessing
  for (const pattern of FEED_PATTERNS) {
    const candidate = base + pattern;
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    const result = await checkFeedUrl(candidate);
    if (result?.type) return { feedUrl: candidate, feedType: result.type, itemCount: result.itemCount };
  }

  return { error: 'sin feed RSS detectado', code: null };
}
