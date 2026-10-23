/**
 * duplicate-finder.js
 *
 * Detección de duplicados **sin red ni I/O**, compartida por:
 *   • `scripts/utils/find-duplicates.js` — reporte CLI (`pnpm check:duplicates`)
 *   • `scripts/core/validate_feeds.js`   — aviso en el resumen tras validar
 *
 * Detecta:
 *
 *   Intra-DB (`feeds-database.json`):
 *     • Sitios con la misma URL normalizada (site.url)
 *     • Feeds con el mismo rss_url normalizado (global, incluso entre sitios)
 *     • Posibles sitios duplicados (mismo dominio raíz con URL distinta)
 *     • IDs de sitio duplicados
 *     • IDs de feed duplicados
 *
 *   Cross-file (`feeds-database.json` ↔ `watchlist.json`):
 *     • Sitios que viven en ambos archivos (mismo id o misma URL)
 *     • Mismo dominio raíz con URL distinta (sospechoso)
 *     • Feeds que viven en ambos archivos (mismo id o mismo rss_url)
 *
 * El cruce detecta promociones incompletas: sitios movidos de watchlist a
 * database sin eliminar la entrada original de watchlist.
 *
 * Los mapas se devuelven con las mismas claves que agrupan los elementos, y solo
 * incluyen grupos con más de un elemento (es decir, duplicados reales).
 */

/**
 * Normaliza una URL de sitio: host sin `www.` + path sin barra final, en
 * minúsculas. Si la URL es inválida devuelve el texto en minúsculas.
 * @param {string} urlStr - URL de sitio
 * @returns {string} Clave normalizada
 */
export function normalizeSiteUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.hostname.replace(/^www\./, '').toLowerCase()
      + url.pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(urlStr ?? '').toLowerCase().trim();
  }
}

/**
 * Dominio raíz de una URL: host sin `www.`, en minúsculas.
 * @param {string} urlStr - URL de sitio
 * @returns {string} Dominio raíz
 */
export function rootDomainOf(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(urlStr ?? '').toLowerCase().trim();
  }
}

/**
 * Normaliza una rss_url: host sin `www.` + path sin barra final + query, en
 * minúsculas. A diferencia de `normalizeSiteUrl`, conserva el query string para
 * no confundir feeds distintos del mismo path (p. ej. proxies `?q=site:…`).
 * @param {string} urlStr - URL del feed
 * @returns {string} Clave normalizada
 */
export function normalizeFeedUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.hostname.replace(/^www\./, '').toLowerCase()
      + url.pathname.replace(/\/$/, '').toLowerCase()
      + (url.search || '');
  } catch {
    return String(urlStr ?? '').toLowerCase().trim();
  }
}

/**
 * Agrupa elementos por una clave derivada.
 * @param {Array<any>} items - Elementos a agrupar
 * @param {(item: any) => string} keyOf - Calcula la clave de cada elemento
 * @returns {Map<string, Array<any>>} Clave → elementos
 */
function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

/**
 * Igual que `groupBy` pero descarta los grupos con un solo elemento.
 * @param {Array<any>} items - Elementos a agrupar
 * @param {(item: any) => string} keyOf - Calcula la clave de cada elemento
 * @returns {Map<string, Array<any>>} Solo grupos con duplicados
 */
function duplicateGroups(items, keyOf) {
  const map = groupBy(items, keyOf);
  for (const [key, group] of map) {
    if (group.length < 2) map.delete(key);
  }
  return map;
}

/**
 * Detecta todos los duplicados de una base de datos y, opcionalmente, el cruce
 * con la watchlist.
 * @param {Array<object>} sites - Sitios de `feeds-database.json`
 * @param {Array<object>|null} [wlSites] - Entradas de `watchlist.json`; `null` omite el cruce
 * @returns {{
 *   wlChecked: boolean,
 *   intra: {
 *     siteUrlMap: Map<string, Array<object>>,
 *     feedUrlMap: Map<string, Array<{site: object, feed: object}>>,
 *     rootDomainMap: Map<string, Array<object>>,
 *     siteIdMap: Map<string, Array<object>>,
 *     feedIdMap: Map<string, Array<{site: object, feed: object}>>
 *   },
 *   cross: {
 *     siteIds: string[], siteUrls: string[], rootDomains: string[],
 *     feedIds: string[], feedUrls: string[],
 *     dbSiteById: Map, wlSiteById: Map, dbUrlMap: Map, wlUrlMap: Map,
 *     dbRootMap: Map, wlRootMap: Map, dbFeedById: Map, wlFeedById: Map,
 *     dbRssMap: Map, wlRssMap: Map
 *   } | null,
 *   counts: Record<string, number>
 * }}
 */
export function findDuplicates(sites, wlSites = null) {
  const siteList = sites ?? [];
  const feedsOf = list => (list ?? []).flatMap(site => (site.feeds ?? []).map(feed => ({ site, feed })));

  // ── Intra-DB ──────────────────────────────────────────────────────────────
  const siteUrlMap = duplicateGroups(siteList, s => normalizeSiteUrl(s.url));
  const feedUrlMap = duplicateGroups(feedsOf(siteList), ({ feed }) => normalizeFeedUrl(feed.rss_url));
  const siteIdMap = duplicateGroups(siteList, s => s.id);
  const feedIdMap = duplicateGroups(feedsOf(siteList), ({ feed }) => feed.id);

  // Mismo dominio raíz pero con al menos dos URLs normalizadas distintas
  const rootDomainMap = new Map();
  for (const [domain, group] of duplicateGroups(siteList, s => rootDomainOf(s.url))) {
    if (new Set(group.map(s => normalizeSiteUrl(s.url))).size > 1) rootDomainMap.set(domain, group);
  }

  const intra = { siteUrlMap, feedUrlMap, rootDomainMap, siteIdMap, feedIdMap };

  // ── Cross-file (DB ↔ watchlist) ───────────────────────────────────────────
  let cross = null;

  if (Array.isArray(wlSites)) {
    const wlList = wlSites;

    const dbSiteById = new Map(siteList.map(s => [s.id, s]));
    const wlSiteById = new Map(wlList.map(s => [s.id, s]));
    const siteIds = [...dbSiteById.keys()].filter(id => wlSiteById.has(id)).sort();

    const dbUrlMap = groupBy(siteList, s => normalizeSiteUrl(s.url));
    const wlUrlMap = groupBy(wlList, s => normalizeSiteUrl(s.url));
    const siteUrls = [...dbUrlMap.keys()].filter(key => wlUrlMap.has(key)).sort();

    // Dominio raíz compartido sin solapamiento exacto de URL (lo sospechoso).
    // Si hay solapamiento exacto ya se listó en `siteUrls`.
    const dbRootMap = groupBy(siteList, s => rootDomainOf(s.url));
    const wlRootMap = groupBy(wlList, s => rootDomainOf(s.url));
    const rootDomains = [];
    for (const domain of [...dbRootMap.keys()].filter(key => wlRootMap.has(key)).sort()) {
      const dbNorm = new Set(dbRootMap.get(domain).map(s => normalizeSiteUrl(s.url)));
      const wlNorm = new Set(wlRootMap.get(domain).map(s => normalizeSiteUrl(s.url)));
      if ([...dbNorm].some(url => wlNorm.has(url))) continue;
      rootDomains.push(domain);
    }

    const dbFeedById = new Map(feedsOf(siteList).map(e => [e.feed.id, e]));
    const wlFeedById = new Map(feedsOf(wlList).map(e => [e.feed.id, e]));
    const feedIds = [...dbFeedById.keys()].filter(id => wlFeedById.has(id)).sort();

    const withRss = entries => entries.filter(({ feed }) => feed.rss_url);
    const dbRssMap = groupBy(withRss(feedsOf(siteList)), ({ feed }) => normalizeFeedUrl(feed.rss_url));
    const wlRssMap = groupBy(withRss(feedsOf(wlList)), ({ feed }) => normalizeFeedUrl(feed.rss_url));
    const feedUrls = [...dbRssMap.keys()].filter(key => wlRssMap.has(key)).sort();

    cross = {
      siteIds, siteUrls, rootDomains, feedIds, feedUrls,
      dbSiteById, wlSiteById, dbUrlMap, wlUrlMap,
      dbRootMap, wlRootMap, dbFeedById, wlFeedById, dbRssMap, wlRssMap,
    };
  }

  const counts = {
    siteUrls: siteUrlMap.size,
    feedUrls: feedUrlMap.size,
    rootDomains: rootDomainMap.size,
    siteIds: siteIdMap.size,
    feedIds: feedIdMap.size,
    crossSiteIds: cross?.siteIds.length ?? 0,
    crossSiteUrls: cross?.siteUrls.length ?? 0,
    crossRootDomains: cross?.rootDomains.length ?? 0,
    crossFeedIds: cross?.feedIds.length ?? 0,
    crossFeedUrls: cross?.feedUrls.length ?? 0,
  };
  counts.total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return { wlChecked: cross !== null, intra, cross, counts };
}
