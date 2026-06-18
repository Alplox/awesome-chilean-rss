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
 * Patrones para secciones descubiertas via sitemap.
 * Cada entrada es una función que recibe el slug de sección y devuelve el path.
 */
const SECTION_FEED_PATTERNS = [
  (s) => `/${s}/feed/`,
  (s) => `/${s}/feed`,
  (s) => `/${s}/rss/`,
  (s) => `/${s}/rss`,
  (s) => `/${s}/rss.xml`,
  (s) => `/${s}/feed.xml`,
  (s) => `/${s}/atom.xml`,
  (s) => `/${s}/feeds/`,
  (s) => `/${s}/?feed=rss2`,
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

const EXCLUDED_SITEMAP_SEGMENTS = new Set([
  'about', 'about-us', 'acerca', 'acerca-de', 'contact', 'contacto',
  'privacy', 'privacy-policy', 'politica-de-privacidad', 'terms', 'terms-of-service',
  'faq', 'faqs', 'help', 'ayuda', 'login', 'register', 'registro',
  'sitemap', 'sitemap.xml', 'feed', 'rss', 'wp-json', 'wp-admin', 'wp-content',
  'author', 'authors', 'tag', 'tags', 'page', 'pages', 'post', 'posts',
  'category', 'categories', 'search', 'buscar', 'comments', 'comment',
  '2021', '2022', '2023', '2024', '2025', '2026',
]);

/**
 * Parse a sitemap XML (or sitemap index) and extract all <loc> URLs.
 * Handles both regular sitemaps and sitemap indexes (follows <sitemap><loc>).
 * @param {string} text - XML text
 * @returns {string[]} discovered URLs
 */
export function parseSitemapXml(text) {
  const locRe = /<loc[^>]*>([^<]+)<\/loc>/gi;
  const urls = [];
  let m;
  while ((m = locRe.exec(text)) !== null) {
    urls.push(m[1].trim());
  }
  return urls;
}

const SITEMAP_WP_PREFIXES = new Set([
  'category', 'categories', 'categoria', 'categorias',
  'tag', 'tags', 'author', 'authors',
  'archivo', 'seccion', 'secciones', 'section', 'sections',
  'tema', 'temas', 'topic', 'topics',
]);

/**
 * Extract a section slug from a sitemap URL.
 * Handles WordPress-style URLs (/category/news/) by taking the second segment.
 * Filters out non-section segments (year, common pages, file extensions).
 * @param {string} url - URL from sitemap
 * @param {string} baseUrl - site base URL
 * @returns {string|null} section slug or null
 */
export function extractSectionFromSitemap(url, baseUrl) {
  try {
    const u = new URL(url);
    const base = new URL(baseUrl);
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return null;

    const path = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (path.length === 0) return null;

    // Skip WordPress-style prefixes (category/tag/author) to get the actual term slug
    let seg;
    if (SITEMAP_WP_PREFIXES.has(path[0].toLowerCase()) && path.length > 1) {
      seg = path[1].toLowerCase();
    } else {
      seg = path[0].toLowerCase();
    }

    if (EXCLUDED_SITEMAP_SEGMENTS.has(seg)) return null;
    if (seg.match(/^\d+$/)) return null;
    if (seg.match(/\.\w+$/)) return null;
    if (seg.length > 30) return null;
    if (seg.length < 2) return null;

    return seg;
  } catch {
    return null;
  }
}

/**
 * Check if two URL pathnames match, ignoring trailing slashes.
 * Returns true if the feed likely serves the requested section.
 */
function pathsMatchSelfLink(candidateUrl, selfLink) {
  try {
    const c = new URL(candidateUrl);
    const s = new URL(selfLink);
    const cPath = c.pathname.replace(/\/+$/, '');
    const sPath = s.pathname.replace(/\/+$/, '');
    return cPath === sPath;
  } catch {
    return false;
  }
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

  // 5. Sitemap discovery: extraer secciones del sitemap y probar patrones
  //    Con verificación de self-link y detección de redirecciones a feeds globales.
  //    Soporta sitemap indexes (sigue sitemaps hijo).
  onProgress?.('buscando en sitemap');
  const sitemapPaths = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap/'];

  /** @param {string} url */
  async function fetchSitemapUrls(url) {
    const res = await fetchSafe(url);
    if (!res || !res.ok) return null;
    let text;
    try { text = await readResponseBody(res); } catch { return null; }
    const urls = parseSitemapXml(text);
    if (urls.length === 0) return null;
    // Sitemap index (contains <sitemap><loc>) → fetch children
    if (text.includes('<sitemap')) {
      // Prefer category/tag sitemaps, skip post-sitemaps (article slugs)
      const relevant = urls.filter(u => /(?:category|cat|tag|section|wp-forum)/i.test(u));
      const rest = urls.filter(u => !/(?:post|page|attachment)/i.test(u));
      const ordered = [...new Set([...relevant, ...rest])];
      const children = [];
      for (const childUrl of ordered.slice(0, 8)) {
        if (tried.has(childUrl)) continue;
        tried.add(childUrl);
        const childUrls = await fetchSitemapUrls(childUrl);
        if (childUrls) children.push(...childUrls);
      }
      return children.length > 0 ? children : null;
    }
    return urls;
  }

  for (const sitemapPath of sitemapPaths) {
    const sitemapUrl = base + sitemapPath;
    if (tried.has(sitemapUrl)) continue;
    tried.add(sitemapUrl);

    const allUrls = await fetchSitemapUrls(sitemapUrl);
    if (!allUrls || allUrls.length === 0) continue;

    // Extract unique first-path segments, limit to avoid excessive requests
    const sections = [...new Set(allUrls
      .map(u => extractSectionFromSitemap(u, base))
      .filter(Boolean))]
      .slice(0, 20);

    if (sections.length === 0) continue;

    // Try feed patterns on each section
    for (const section of sections) {
      onProgress?.(`sección ${section}`);
      for (let pi = 0; pi < SECTION_FEED_PATTERNS.length; pi++) {
        const candidate = `${base}${SECTION_FEED_PATTERNS[pi](section)}`;
        if (tried.has(candidate)) continue;
        tried.add(candidate);

        const result = await checkFeedUrl(candidate);
        if (!result?.type || result.itemCount <= 0) continue;

        // Self-link check: reject if self-link doesn't match the requested section
        if (result.selfLink && !pathsMatchSelfLink(candidate, result.selfLink)) {
          continue;
        }

        // Redirect check: if the feed URL redirected to a different path,
        // it's likely serving a global feed, not a section-specific one
        if (result.redirectUrl) {
          try {
            const origPath = new URL(candidate).pathname.replace(/\/+$/, '');
            const destPath = new URL(result.redirectUrl).pathname.replace(/\/+$/, '');
            if (origPath !== destPath) continue;
          } catch { continue; }
        }

        return { feedUrl: candidate, feedType: result.type, itemCount: result.itemCount };
      }
    }
  }

  return { error: 'sin feed RSS detectado', code: null };
}
