#!/usr/bin/env node
/**
 * Revalida todos los feeds de feeds-database.json.
 *
 * Para cada feed en el JSON:
 *   1. Verifica si la rss_url actual sigue funcionando.
 *   2. Si falló, comprueba si el sitio raíz sigue activo.
 *   3. Si el sitio está activo, intenta redescubrir el feed
 *      (vía <link alternate> en el HTML y patrones comunes).
 *   4. Actualiza feeds-database.json con los resultados.
 *   5. Al terminar, avisa de duplicados (IDs/URLs/dominios, BD y BD ↔ watchlist)
 *      vía lib/duplicate-finder.js — sin red y sin cambiar estados.
 *
 * Para agregar nuevos sitios: edita feeds-database.json directamente,
 * luego corre este script para verificar y rellenar rss_url automáticamente.
 *
 * Uso: node validate_feeds.js [--update] [--automatic]
 *      node validate_feeds.js --id <site-id> [--update]
 *      node validate_feeds.js --url <URL>
 *      node validate_feeds.js --start-id <site-id> [--limit <N>]
 *      node validate_feeds.js --from <N> --to <N> [--update]
 *      pnpm validate
 *
 * Opciones:
 *   --update         Actualiza feeds-database.json con correcciones y redescubrimientos
 *                    Por defecto solo valida sin modificar el archivo
 *   --automatic      Ejecuta en modo automático (sin prompts interactivos)
 *                    Útil para CI o ejecución desatendida. Solo aprueba estados
 *                    de feeds: NO mueve sitios entre archivos (usa --move para eso)
 *   --move           Permite mover sitios entre archivos. Con --update --automatic,
 *                    los sitios sin feeds nativos activos pasan a watchlist.json
 *                    sin preguntar. En modo interactivo no hace falta: se pregunta
 *                    por sitio igual. Requiere --update
 *   --id <site-id>   Valida un sitio específico por su ID
 *   --url <URL>      Valida una URL específica directamente (test único)
 *   --start-id <id>  Comienza la validación desde este site-id (inclusive)
 *   --from <N>       Índice numérico inicial (0-based)
 *   --to <N>         Índice numérico final (inclusive)
 *   --limit <N>      Máximo de sitios a validar (se aplica al final)
 *   --missing-date   Solo valida feeds sin last_known_item_date (nunca verificados)
 *   --status <status>  Solo valida feeds con el estado especificado (active, stale, broken, offline, no_feed, feed_empty)
 *   --relay <lista>    Relays para el cross-check de red ante errores de conexión
 *                      (default: allorigins,codetabs). Solo informativo: no
 *                      modifica el estado de ningún feed. Acepta presets o una
 *                      plantilla con {url}/{urlRaw}, separados por coma.
 *   --no-relay       Desactiva el cross-check de red. En modo --automatic ya está
 *                    desactivado por defecto (salvo que se pase --relay).
 *   --watchlist      Muestra instrucciones para usar validate:watchlist
 */

import { readFileSync, writeFileSync } from 'fs';
import { checkFeedUrl, inspectFeedText } from '../../lib/feed-validator.js';
import { isValidUrl, checkSiteStatus, checkSiteReachable, tryFetchFeedInsecure } from '../../lib/network-utils.js';
import { isAutomatic, promptUser, promptUrl, promptStatus } from '../../lib/prompter.js';
import { rediscoverFeed, clearHomepageCache } from '../../lib/feed-rediscovery.js';
import { STALE_THRESHOLD_DAYS, daysSince, pathsMatch, formatError, ALLOWED_STATUSES, BROKEN_ERRORS, DUPLICATE_OVERLAP_THRESHOLD } from '../../lib/feed-utils.js';
import { containmentRatio } from '../../lib/feed-overlap.js';
import { fetchWithBrowser, closeBrowser } from '../../lib/browser-fallback.js';
import { checkFeedViaRelay, checkReachabilityViaRelay, resolveRelayList, RELAY_TIMEOUT_MS, DEFAULT_RELAY } from '../../lib/relay-fetch.js';
import { parseArgs, applyFiltersSites } from '../../lib/cli-args.js';
import { findDuplicates } from '../../lib/duplicate-finder.js';

// Códigos HTTP que indican bloqueo anti-bot (403 Forbidden, 429 Too Many
// Requests): el feed puede estar sano pero el servidor bloquea al script.
// No redescubrir (fallará igual) ni cambiar estado — solo informar.
const BOT_BLOCK_CODES = new Set([403, 429]);

/** Error devuelto por `checkFeedUrl` cuando `fetchSafe` no logra conectarse. */
const CONNECTION_ERROR = 'no responde';

// ─── Configuración ────────────────────────────────────────────────────────────

// ─── Helpers para estado de feeds ──────────────────────────────────────────

function updateFeedState(feed, { status, feedType, rssUrl, lastItemDate } = {}, shouldUpdate) {
  if (!shouldUpdate) return;
  feed.last_checked          = new Date().toISOString();
  feed.status                = status;
  feed.verified              = status === 'active';
  if (feedType !== undefined)     feed.feed_type            = feedType;
  if (rssUrl !== undefined)       feed.rss_url              = rssUrl;
  if (lastItemDate !== undefined) feed.last_known_item_date = lastItemDate;
}

function feedLabel(site, feed) {
  return `${site.name} › ${feed.name}`;
}

function trackResult(results, feed, site, status) {
  const label = feedLabel(site, feed);
  if (status === 'active') results.ok.push(label);
  else if (status === 'offline') results.offline.push(label);
  else if (status === 'broken') results.broken.push(label);
  else if (status === 'no_feed') results.noFeed.push(label);
  else if (status === 'stale') results.stale.push(label);
  else if (status === 'duplicate') results.duplicate.push(label);
  else if (status === 'feed_empty') results.other.push(label);
}

function isProxyFeed(feed) {
  return feed.id.endsWith('-proxy-google-news') || feed.id.endsWith('-proxy-bing-news');
}

async function testManualUrl(url, _feedName) {
  if (!isValidUrl(url)) {
    console.log(`     ❌ URL inválida o no permitida: ${url}`);
    return null;
  }
  const testResult = await checkFeedUrl(url);
  if (testResult.type) {
    console.log(`     ✅ URL válida: ${url} (${testResult.type})`);
    return { feedUrl: url, feedType: testResult.type, lastItemDate: testResult.lastItemDate };
  }
  console.log(`     ❌ ${testResult.error} — reintentando ignorando SSL...`);
  const insecureResult = await tryFetchFeedInsecure(url);
  if (insecureResult && insecureResult.itemCount > 0) {
    console.log(`     ✅ feed válido a pesar del SSL (${insecureResult.type}, ${insecureResult.itemCount} items)`);
    return { feedUrl: url, feedType: insecureResult.type, lastItemDate: insecureResult.lastItemDate };
  }
  console.log(`     ❌ URL no válida`);
  return null;
}

function applyFeedDecision(feed, site, results, status, shouldUpdate, extra = {}) {
  updateFeedState(feed, { status, lastItemDate: null, ...extra }, shouldUpdate);
  trackResult(results, feed, site, status);
}

async function handleRediscoveryFail(feed, site, results, defaultStatus, shouldUpdate) {
  if (!shouldUpdate || !process.stdin.isTTY || isAutomatic()) {
    applyFeedDecision(feed, site, results, defaultStatus, shouldUpdate);
    return defaultStatus;
  }
  const manualUrl = await promptUrl(feed.name, feed.rss_url);
  if (manualUrl) {
    const tested = await testManualUrl(manualUrl, feed.name);
    if (tested) {
      applyFeedDecision(feed, site, results, 'active', shouldUpdate, {
        feedType: tested.feedType, rssUrl: tested.feedUrl, lastItemDate: tested.lastItemDate
      });
      results.fixed.push(feedLabel(site, feed));
      return 'active';
    }
  }
  const chosen = await promptStatus(feed.name, feed.rss_url);
  applyFeedDecision(feed, site, results, chosen, shouldUpdate);
  return chosen;
}

// ─── Modo: URL única ──────────────────────────────────────────────────────────

async function validateSingleUrl(url) {
  console.log(`🔍 Validando URL: ${url}\n`);

  const feedResult = await checkFeedUrl(url);
  if (feedResult.type) {
    if (feedResult.redirectUrl) {
      console.log(`⚠ Redirige a ${feedResult.redirectUrl} (feed principal)`);
    }
    console.log(`✅ Feed válido: ${feedResult.type}`);
    console.log(`   Items: ${feedResult.itemCount}`);
    if (feedResult.lastItemDate) {
      console.log(`   Último item: ${feedResult.lastItemDate.slice(0, 10)}`);
    }
    return;
  }

  const errorMsg = formatError(feedResult.error, feedResult.code);
  console.log(`   ❌ ${errorMsg}`);

  console.log(`\nℹ️  Intentando con verificación SSL insegura...`);
  const insecureResult = await tryFetchFeedInsecure(url);
  if (insecureResult && insecureResult.itemCount > 0) {
    console.log(`   ✅ feed válido (${insecureResult.type}, ${insecureResult.itemCount} items)`);
    return;
  }

  const origin = new URL(url).origin;
  console.log(`\nℹ️  No es un feed directo, intentando redescubrir desde el sitio...\n`);

  const siteStatus = await checkSiteStatus(origin);
  if (siteStatus === 'down') {
    console.log(`❌ El sitio no responde (${origin})`);
    return;
  }

  process.stdout.write('🔍 Redescubriendo feeds... ');
  const found = await rediscoverFeed(origin);

  if (found.feedUrl) {
    console.log(`\n✅ Feed encontrado:\n`);
    console.log(`   URL: ${found.feedUrl}`);
    console.log(`   Tipo: ${found.feedType}`);
    console.log(`   Items: ${found.itemCount}\n`);
  } else {
    const errorMsg = formatError(found.error, found.code);
    console.log(`\n❌ ${errorMsg}`);
  }
}

// ─── Helpers de redescubrimiento contextual ──────────────────────────────────

/**
 * Determina el origen (protocolo + hostname) desde el que intentar rediscovery.
 * Si el feed está en un dominio diferente al sitio principal, usa el dominio del feed.
 */
function getFeedOrigin(feedUrl, siteUrl) {
  try {
    const feed = new URL(feedUrl);
    const site = new URL(siteUrl);
    if (feed.hostname.replace(/^www\./, '') !== site.hostname.replace(/^www\./, '')) {
      return feed.origin;
    }
  } catch { /* ignorar */ }
  return siteUrl;
}

/**
 * Infiere patrones de URL preferidos desde el feed fallido para guiar el rediscovery.
 * Combina señales de: segmentos de la URL original, nombre del feed, categoría.
 */
function getPreferredPatterns(feed, site) {
  const patterns = [];
  const name = (feed.name || '').toLowerCase();

  // 1. Segmentos de la URL original
  try {
    const urlObj = new URL(feed.rss_url);
    const segments = urlObj.pathname.split('/').filter(Boolean);
    const generic = new Set(['feed', 'rss', 'atom', 'index', 'xml']);
    for (let i = 0; i < segments.length; i++) {
      const path = '/' + segments.slice(0, i + 1).join('/') + '/';
      if (!generic.has(segments[i])) patterns.push(path);
    }
  } catch { /* URL inválida */ }

  // 2. Palabras clave en el nombre del feed
  if (/deporte(s)?|sport/.test(name)) {
    patterns.push('/deportes/feed/rss/', '/deporte/feed/rss/', '/sports/feed/rss/');
  }
  if (/noticia|news/.test(name)) {
    patterns.push('/noticias/feed/rss/', '/news/feed/rss/');
  }
  if (/econom|finanz|business/.test(name)) {
    patterns.push('/economia/feed/rss/', '/finanzas/feed/rss/');
  }
  if (/tecnolog|tech/.test(name)) {
    patterns.push('/tecnologia/feed/rss/', '/tech/feed/rss/');
  }
  if (/policial|seguridad/.test(name)) {
    patterns.push('/policial/feed/rss/', '/seguridad/feed/rss/');
  }
  if (/cultura|cultur/.test(name)) {
    patterns.push('/cultura/feed/rss/');
  }
  if (/opinion|opinión|columna/.test(name)) {
    patterns.push('/opinion/feed/rss/', '/columnas/feed/rss/');
  }

  // 3. Categoría del feed/sitio
  const category = feed.category ?? site.category;
  if (category === 'sports') patterns.push('/deportes/feed/rss/', '/deporte/feed/rss/', '/sports/feed/rss/');
  if (category === 'news' || category === 'news-international') patterns.push('/noticias/feed/rss/', '/news/feed/rss/');
  if (category === 'business') patterns.push('/economia/feed/rss/', '/finanzas/feed/rss/');
  if (category === 'technology') patterns.push('/tecnologia/feed/rss/', '/tech/feed/rss/');
  if (category === 'culture') patterns.push('/cultura/feed/rss/');
  if (category === 'opinion') patterns.push('/opinion/feed/rss/', '/columnas/feed/rss/');

  return [...new Set(patterns)];
}

/**
 * Comprueba si una URL de feed parece genérica (raíz del sitio) vs. específica de una sección.
 */
/**
 * ¿La URL es el feed "de raíz" del sitio (`/feed`, `/rss`, `feed.xml`…)?
 * La barra final se normaliza porque WordPress sirve el feed principal en `/feed`
 * y redirige desde `/feed/`: sin esto, un feed de sección 404 podía ser
 * reemplazado por el feed principal del sitio (mismo contenido en N feeds).
 * @param {string} url - URL candidata
 * @returns {boolean} true si el path es un feed genérico/principal
 */
function isGenericFeedUrl(url) {
  const genericBase = ['/feed', '/rss', '/atom', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml'];
  try {
    const path = new URL(url).pathname.toLowerCase().replace(/\/+$/, '') || '/';
    return genericBase.some(p => path === p || path.endsWith(p));
  } catch {
    return false;
  }
}

function hasSpecificPath(url) {
  const genericSegments = new Set(['feed', 'rss', 'atom', 'index', 'xml']);
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.some(s => !genericSegments.has(s));
  } catch {
    return false;
  }
}

/**
 * Decide si el feed descubierto (genérico) debería reemplazar al original (específico).
 * En modo interactivo pregunta al usuario; en automático marca como broken.
 */
async function handleRediscoveryWithGuard(feed, site, results, found, shouldUpdate) {
  const isNewUrl = found.feedUrl !== feed.rss_url;

  if (!isNewUrl) {
    // Misma URL — error intermitente
    console.log(`   🔄 misma URL (posible error intermitente) — ${found.feedType}, ${found.itemCount} item${found.itemCount > 1 ? 's' : ''}`);
    updateFeedState(feed, { status: 'active', lastItemDate: null }, shouldUpdate);
    results.ok.push(feedLabel(site, feed));
    return;
  }

  const looksGeneric = isGenericFeedUrl(found.feedUrl);
  const wasSpecific = hasSpecificPath(feed.rss_url);
  const nameHasTopic = /deporte(s)?|noticia|econom|tecnolog|cultura|policial|opinion|columna/.test((feed.name || '').toLowerCase());

  // El feed descubierto ya lo usa otro feed del mismo sitio → por definición no
  // es específico de esta sección (caso típico: los feeds de categoría
  // desaparecen del sitio y el redescubrimiento devuelve el feed principal).
  if ((site.feeds ?? []).some(f => f !== feed && f.rss_url === found.feedUrl)) {
    console.log(`   ⚠️ ${found.feedUrl} ya lo usa otro feed del sitio — omitiendo para no duplicar contenido`);
    await handleRediscoveryFail(feed, site, results, 'broken', shouldUpdate);
    return;
  }

  if (looksGeneric && (wasSpecific || nameHasTopic)) {
    if (!shouldUpdate || !process.stdin.isTTY || isAutomatic()) {
      // Modo automático — no reemplazar, marcar como roto
      console.log(`   ⚠️ feed descubierto parece genérico (${found.feedUrl}) — omitiendo para no degradar calidad`);
      await handleRediscoveryFail(feed, site, results, 'broken', shouldUpdate);
      return;
    }
    // Modo interactivo — preguntar
    const replace = await promptUser(
      `   ⚠️ El feed original (${feed.rss_url}) parece específico,\n` +
      `     pero se encontró un feed genérico (${found.feedUrl}).\n` +
      `     ¿Reemplazar de todas formas? [s/N]: `,
      { defaultYes: false }
    );
    if (!replace) {
      console.log(`   → manteniendo feed original como broken`);
      await handleRediscoveryFail(feed, site, results, 'broken', shouldUpdate);
      return;
    }
    console.log(`   → reemplazando con feed genérico (confirmado por usuario)`);
  }

  console.log(`   🔄 nueva URL: ${found.feedUrl} (${found.feedType}, ${found.itemCount} item${found.itemCount > 1 ? 's' : ''})`);
  updateFeedState(feed, { status: 'active', feedType: found.feedType, rssUrl: found.feedUrl, lastItemDate: null }, shouldUpdate);
  results.fixed.push(feedLabel(site, feed));
}

/**
 * Cache de checkSiteStatus para evitar consultas repetidas al mismo dominio.
 */
function createSiteStatusCache() {
  const cache = new Map();
  return async function getCachedSiteStatus(url) {
    if (!cache.has(url)) {
      cache.set(url, await checkSiteStatus(url));
    }
    return cache.get(url);
  };
}

/**
 * Cross-check informativo vía relay público. **Nunca** cambia el estado de un
 * feed: sirve para distinguir un fallo del sitio de un bloqueo/límite de red de
 * la máquina donde corre el script.
 * @param {Array<object>} relays - Relays resueltos (ver lib/relay-fetch.js)
 * @param {string} targetUrl - Feed o sitio a comprobar
 * @param {'feed'|'reachable'} expect - Exigir un feed válido o solo alcanzabilidad
 * @returns {Promise<{ ok: boolean, relay?: string, detail?: object }>}
 */
async function crossCheckViaRelay(relays, targetUrl, expect = 'feed') {
  for (const relay of relays) {
    const result = expect === 'feed'
      ? await checkFeedViaRelay(targetUrl, { relay, timeout: RELAY_TIMEOUT_MS })
      : await checkReachabilityViaRelay(targetUrl, { relay, timeout: RELAY_TIMEOUT_MS });

    const ok = expect === 'feed' ? !!result.type : !!result.reachable;
    if (ok && !result.relayError) return { ok: true, relay: relay.name, detail: result };
  }
  return { ok: false };
}

/**
 * Hostname normalizado (sin `www.`) para cachear el veredicto de red por host.
 * @param {string} url - URL a normalizar
 * @returns {string|null} Hostname normalizado o null si la URL es inválida
 */
function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Comprueba la red vía relay cacheando el resultado por host, de modo que un
 * sitio con muchos feeds fallidos signifique una sola consulta al relay. `first`
 * indica si el veredicto se acaba de calcular (para imprimir el mensaje una vez).
 * @param {Array<object>} relays - Relays resueltos
 * @returns {{ forFeed: Function, forSite: Function, networkRisk: Map<string,string> }}
 */
function createRelayProbe(relays) {
  const cache = new Map();
  /** Sites cuyo veredicto sugiere bloqueo/límite de red local: id → nombre */
  const networkRisk = new Map();

  async function cached(key, targetUrl, expect) {
    if (cache.has(key)) return { verdict: cache.get(key), first: false };
    const verdict = await crossCheckViaRelay(relays, targetUrl, expect);
    cache.set(key, verdict);
    // Un feed válido vía relay implica que el sitio es alcanzable
    if (expect === 'feed' && verdict.ok) cache.set(`reach:${hostnameOf(targetUrl)}`, verdict);
    return { verdict, first: true };
  }

  return {
    networkRisk,
    forFeed: feedUrl => cached(`feed:${hostnameOf(feedUrl)}`, feedUrl, 'feed'),
    forSite: siteUrl => cached(`reach:${hostnameOf(siteUrl)}`, siteUrl, 'reachable'),
  };
}

/**
 * Describe el veredicto de red de un feed para la salida por consola.
 * @param {object} verdict - Resultado de `crossCheckViaRelay`
 * @returns {string} Mensaje para el usuario
 */
function describeRelayVerdict(verdict) {
  if (!verdict.ok) return 'tampoco responde vía relay → el fallo no parece ser de tu red';
  const { detail } = verdict;
  if (detail.type) {
    return `vía relay (${verdict.relay}) SÍ responde (${detail.type}, ${detail.itemCount} item${detail.itemCount === 1 ? '' : 's'})`;
  }
  return `vía relay (${verdict.relay}) el sitio SÍ responde (HTTP ${detail.status})`;
}

/**
 * Aviso de duplicados (IDs, URLs y dominios) al terminar la validación. Reutiliza
 * la detección de `lib/duplicate-finder.js` (sin red): un `--update` puede
 * introducir un duplicado al redescubrir una rss_url ya usada en otro sitio, y es
 * preferible verlo aquí que en el CI (`pnpm check:duplicates`).
 * @param {object} db - Base de datos ya procesada
 * @param {boolean} shouldUpdate - Si se escribió el archivo en esta ejecución
 */
function printDuplicateReport(db, shouldUpdate) {
  let wlSites = null;
  try {
    const raw = JSON.parse(readFileSync('watchlist.json', 'utf-8'));
    wlSites = Array.isArray(raw) ? raw : (raw.sites ?? []);
  } catch {
    wlSites = null;
  }

  const { counts } = findDuplicates(db.sites, wlSites);

  if (counts.total === 0) {
    console.log(`🔁 Entradas duplicadas : 0${wlSites ? ' (BD, WL y BD ↔ WL)' : ' (BD)'}`);
    return;
  }

  const details = [
    [counts.siteUrls, 'site.url duplicada (BD)'],
    [counts.feedUrls, 'rss_url duplicada (BD)'],
    [counts.rootDomains, 'mismo dominio raíz (BD)'],
    [counts.siteIds, 'IDs de sitio duplicados (BD)'],
    [counts.feedIds, 'IDs de feed duplicados (BD)'],
    [counts.wlSiteIds, 'IDs de sitio duplicados (WL)'],
    [counts.wlSiteUrls, 'site.url duplicada (WL)'],
    [counts.wlRootDomains, 'mismo dominio raíz (WL)'],
    [counts.wlFeedIds, 'IDs de feed duplicados (WL)'],
    [counts.wlFeedUrls, 'rss_url duplicada (WL)'],
    [counts.crossSiteIds, 'site IDs cruzados (BD ↔ WL)'],
    [counts.crossSiteUrls, 'site URLs cruzadas (BD ↔ WL)'],
    [counts.crossRootDomains, 'dominios cruzados (BD ↔ WL)'],
    [counts.crossFeedIds, 'feed IDs cruzados (BD ↔ WL)'],
    [counts.crossFeedUrls, 'rss_url cruzadas (BD ↔ WL)'],
  ].filter(([n]) => n > 0);

  console.log(`🔁 Entradas duplicadas : ${counts.total}`);
  for (const [n, label] of details) console.log(`   • ${label}: ${n}`);
  console.log('   → detalles: pnpm check:duplicates -- --verbose');
  if (shouldUpdate) {
    console.log('   ⚠️  feeds-database.json ya fue escrito: revísalos antes de commitear');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));

  const args = parseArgs(process.argv, [
    { flag: '--url', name: 'url', type: 'value' },
    { flag: '--status', name: 'status', type: 'value' },
    { flag: '--relay', name: 'relay', type: 'value' },
    { flag: '--no-relay', name: 'noRelay', type: 'bool' },
    { flag: '--missing-date', name: 'missingDate', type: 'bool' },
    { flag: '--move', name: 'move', type: 'bool' },
    { flag: '--watchlist', name: 'watchlist', type: 'bool' },
  ]);

  if (args.status && !ALLOWED_STATUSES.includes(args.status)) {
    console.error(`❌ Error: --status requiere un estado válido (${ALLOWED_STATUSES.join(', ')})`);
    process.exit(1);
  }

  // Cross-check de red vía relay (solo lectura, no altera estados). Activado por
  // defecto ante errores de conexión; en modo --automatic solo si se pide con
  // --relay, para no depender de un tercero ni alargar el CI.
  const relayEnabled = !args.noRelay && (!!args.relay || !isAutomatic());
  let relayProbe = null;
  if (relayEnabled) {
    const { relays, invalid } = resolveRelayList(args.relay ?? DEFAULT_RELAY);
    if (invalid.length) {
      console.error(`❌ Error: relay no reconocido: ${invalid.join(', ')} (usa allorigins, codetabs o una plantilla con {url})`);
      process.exit(1);
    }
    relayProbe = createRelayProbe(relays);
  }

  const hasWatchlistMode = args.watchlist;
  const hasUrlMode = !!args.url;
  const shouldUpdate = args.update;

  if (hasUrlMode) {
    if (!args.url) {
      console.error('❌ Error: --url requiere una URL');
      process.exit(1);
    }
    await validateSingleUrl(args.url);
    return;
  }

  if (hasWatchlistMode) {
    console.log(`📢 La validación de watchlist ahora tiene su propio comando:\n`);
    console.log(`    -- [--update] [--automatic]`);
    console.log(`    -- [--update] [--automatic]\n`);
    return;
  }

  let sitesToValidate = db.sites;

  if (args.id) {
    sitesToValidate = db.sites.filter(s => s.id === args.id);
    if (sitesToValidate.length === 0) {
      console.error(`❌ Sitio con ID "${args.id}" no encontrado en feeds-database.json`);
      process.exit(1);
    }
  }

  // --missing-date: filtrar feeds sin last_known_item_date (nunca verificados)
  // Se aplica antes de los filtros de rango numérico para que --limit/--from/--to
  // operen sobre el conjunto ya filtrado
  if (args.missingDate) {
    sitesToValidate = sitesToValidate
      .map(site => ({
        ...site,
        feeds: site.feeds.filter(f => !('last_known_item_date' in f))
      }))
      .filter(site => site.feeds.length > 0);
  }

  // --status: filtrar feeds por estado actual
  if (args.status) {
    sitesToValidate = sitesToValidate
      .map(site => ({
        ...site,
        feeds: site.feeds.filter(f => f.status === args.status)
      }))
      .filter(site => site.feeds.length > 0);
  }

  sitesToValidate = applyFiltersSites(sitesToValidate, args);

  if (sitesToValidate.length === 0) {
    console.log('🏁 No hay sitios para validar en el rango especificado.');
    return;
  }

  const totalFeeds = sitesToValidate.reduce((sum, site) => sum + site.feeds.length, 0);

  console.log(`🔍 Revalidando ${sitesToValidate.length} sitio${sitesToValidate.length > 1 ? 's' : ''} (${totalFeeds} feed${totalFeeds > 1 ? 's' : ''}) desde feeds-database.json\n`);
  console.log('='.repeat(55));

  const results = { ok: [], fixed: [], stale: [], broken: [], offline: [], noFeed: [], other: [], blocked: [], duplicate: [] };
  const browserFailures = new Map();
  const getCachedSiteStatus = createSiteStatusCache();
  clearHomepageCache();

  const SITE_CONCURRENCY = 1;
  let siteIndex = 0;

  async function processSite(site) {
    console.log(`\n📌 ${site.name} (${site.feeds.length} feed${site.feeds.length > 1 ? 's' : ''})`);

    // Pre-check all feeds for this site in parallel (network-bound phase)
    const settledResults = await Promise.allSettled(
      site.feeds.map(feed => checkFeedUrl(feed.rss_url, { includeItems: true }))
    );
    const checkResults = settledResults.map(r =>
      r.status === 'fulfilled' ? r.value : { error: 'error inesperado', code: null }
    );

    let siteDecision = null;

    for (const [feedIndex, feed] of site.feeds.entries()) {
      const checkResult = checkResults[feedIndex];
      const label = `  🔍 ${feed.name}... `;
      process.stdout.write(label);

      // Feeds marcados como duplicados: verificar si siguen duplicando antes de
      // re-promoverlos a active (guarda contra la re-promoción automática).
      if (checkResult.type && feed.duplicate_of) {
        const targetFeed = site.feeds.find(f => f.id === feed.duplicate_of);
        const targetResult = targetFeed ? checkResults[site.feeds.indexOf(targetFeed)] : null;
        const comparable = targetResult?.type && targetResult.items?.length >= 5 && checkResult.items?.length >= 5;

        if (!targetFeed) {
          // Referencia colgante: el feed objetivo ya no existe en el sitio. Se
          // limpia la marca para no dejar `duplicate_of` huérfano en un feed que
          // vuelve a active (entraría a los OPML con el campo residual).
          console.log(`\n     ⚠️  duplicate_of apunta a un feed inexistente ("${feed.duplicate_of}") → se limpia la marca`);
          if (shouldUpdate) delete feed.duplicate_of;
        } else if (comparable) {
          const ratio = containmentRatio(checkResult.items, targetResult.items);
          if (ratio >= DUPLICATE_OVERLAP_THRESHOLD) {
            console.log(`\n     🔁 sigue duplicando a "${feed.duplicate_of}" (${Math.round(ratio * 100)}%) → duplicate`);
            updateFeedState(feed, { status: 'duplicate', feedType: checkResult.type, lastItemDate: checkResult.lastItemDate }, shouldUpdate);
            trackResult(results, feed, site, 'duplicate');
            continue;
          }
          console.log(`\n     ✅ ya no duplica (${Math.round(ratio * 100)}%)`);
          if (shouldUpdate) delete feed.duplicate_of;
        } else {
          // No se puede comparar (el feed objetivo no respondió o tiene <5 items):
          // se mantiene `duplicate` en vez de re-promoverlo a active sin verificar.
          console.log(`\n     🔁 sin datos para comparar con "${feed.duplicate_of}" (feed objetivo sin respuesta o con <5 items) → se mantiene duplicate`);
          updateFeedState(feed, { status: 'duplicate', feedType: checkResult.type, lastItemDate: checkResult.lastItemDate }, shouldUpdate);
          trackResult(results, feed, site, 'duplicate');
          continue;
        }
      }

      if (checkResult.type) {
        siteDecision = null;

        if (checkResult.redirectUrl) {
          const shortUrl = checkResult.redirectUrl.length > 60
            ? new URL(checkResult.redirectUrl).pathname
            : checkResult.redirectUrl;
          console.log(`\n     ⚠ Redirige a ${shortUrl} (feed principal)`);
        }

        // Self-link check: verify category feeds serve category-specific content
        if (checkResult.selfLink && feed.rss_url.includes('/category/')) {
          if (!pathsMatch(feed.rss_url, checkResult.selfLink)) {
            console.log(`⚠️  feed principal (self-link: ${checkResult.selfLink}) — no es específico de la categoría`);
            updateFeedState(feed, { status: 'broken', feedType: checkResult.type, lastItemDate: null }, shouldUpdate);
            results.broken.push(feedLabel(site, feed));
            continue;
          }
        }

        const itemCount = checkResult.itemCount;
        const lastItemDate = checkResult.lastItemDate;

        if (lastItemDate) {
          if (daysSince(lastItemDate) > STALE_THRESHOLD_DAYS) {
            console.log(`⚠️  STALE (último item: ${lastItemDate.slice(0, 10)}, ${Math.round(daysSince(lastItemDate))} días)`);
            updateFeedState(feed, { status: 'stale', feedType: checkResult.type, lastItemDate }, shouldUpdate);
            results.stale.push(feedLabel(site, feed));
            continue;
          }
        } else if (itemCount === 0) {
          console.log(`⚠️  vacío (${checkResult.type}, 0 items) — feed válido sin contenido`);
          updateFeedState(feed, { status: 'feed_empty', feedType: checkResult.type, lastItemDate: null }, shouldUpdate);
          results.other.push(feedLabel(site, feed));
          continue;
        } else {
          if (shouldUpdate && process.stdin.isTTY && !isAutomatic()) {
            const keepActive = await promptUser(
              `   ⚠️  "${feed.name}" — sin fecha en items.\n     📎 ${feed.rss_url}\n   ¿Activo? [Y/n]: `
            );
            if (!keepActive) {
              console.log(`   → marcado como stale (sin info de fecha)`);
              updateFeedState(feed, { status: 'stale', feedType: checkResult.type, lastItemDate: null }, shouldUpdate);
              results.stale.push(feedLabel(site, feed));
              continue;
            }
          } else {
            console.log(`✅ OK (${checkResult.type}, ${itemCount} item${itemCount > 1 ? 's' : ''}, sin fecha)`);
          }
        }

        if (!lastItemDate || daysSince(lastItemDate) <= STALE_THRESHOLD_DAYS) {
          if (lastItemDate) {
            console.log(`✅ OK (${checkResult.type}, ${itemCount} item${itemCount > 1 ? 's' : ''})`);
          }
          updateFeedState(feed, { status: 'active', feedType: checkResult.type, lastItemDate: lastItemDate ?? null }, shouldUpdate);
          results.ok.push(feedLabel(site, feed));
          continue;
        }
      }

      const errorMsg = formatError(checkResult.error, checkResult.code);
      console.log(`❌ ${errorMsg}`);

      // Cross-check de red (solo lectura) ante error de conexión
      if (relayProbe && checkResult.error === CONNECTION_ERROR && !checkResult.code) {
        const { verdict, first } = await relayProbe.forFeed(feed.rss_url);
        if (first) {
          process.stdout.write(`   🌐 ${describeRelayVerdict(verdict)}\n`);
          if (verdict.ok) {
            relayProbe.networkRisk.set(site.id, site.name);
            console.log('     ⚠️  probable bloqueo/límite de red local — revisa antes de marcarlo offline');
          }
        } else if (verdict.ok) {
          relayProbe.networkRisk.set(site.id, site.name);
        }
      }

      if (BOT_BLOCK_CODES.has(checkResult.code)) {
        const attempts = browserFailures.get(site.id) ?? 0;
        if (shouldUpdate && attempts < 2) {
          process.stdout.write('   🌐 intentando con navegador headless... ');
          const text = await fetchWithBrowser(feed.rss_url);
          const browserResult = text ? inspectFeedText(text) : null;
          if (browserResult?.type) {
            const stale = browserResult.lastItemDate && daysSince(browserResult.lastItemDate) > STALE_THRESHOLD_DAYS;
            console.log(
              stale
                ? `⚠️  verificado vía navegador (${browserResult.type}, ${browserResult.itemCount} items) pero STALE`
                : `✅ verificado vía navegador (${browserResult.type}, ${browserResult.itemCount} items)`
            );
            updateFeedState(feed, {
              status: stale ? 'stale' : 'active',
              feedType: browserResult.type,
              lastItemDate: browserResult.lastItemDate ?? null,
            }, shouldUpdate);
            (stale ? results.stale : results.ok).push(feedLabel(site, feed));
            continue;
          }
          browserFailures.set(site.id, attempts + 1);
        }
        console.log(`⚠️  bloqueo anti-bot (HTTP ${checkResult.code}) — feed no verificable, estado conservado`);
        results.blocked.push(feedLabel(site, feed));
        continue;
      }

      const isBroken = BROKEN_ERRORS.includes(checkResult.error);
      if (isBroken) {
        console.log(`   ⚠️  contenido inválido — intentando redescubrir...`);
        const hints = getPreferredPatterns(feed, site);
        const feedOrigin = getFeedOrigin(feed.rss_url, site.url);
        const found = await rediscoverFeed(feedOrigin, hints);
        if (!found.feedUrl && feedOrigin !== site.url) {
          console.log(`   ↪ también buscando desde ${site.url}...`);
          const fallback = await rediscoverFeed(site.url, hints);
          if (fallback.feedUrl) Object.assign(found, fallback);
        }
        if (found.feedUrl) {
          await handleRediscoveryWithGuard(feed, site, results, found, shouldUpdate);
        } else {
          console.log(`   ❌ feed no recuperable`);
          const chosen = await handleRediscoveryFail(feed, site, results, 'broken', shouldUpdate);
          if (chosen !== 'broken') siteDecision = chosen;
        }
        continue;
      }

      const siteStatus = await getCachedSiteStatus(site.url);

      if (siteStatus === 'down') {
        if (siteDecision) {
          const remaining = site.feeds.length - feedIndex;
          console.log(`     → ${siteDecision} (aplicando a ${remaining} feed${remaining > 1 ? 's restantes' : ''} del sitio)`);
          updateFeedState(feed, { status: siteDecision, lastItemDate: null }, shouldUpdate);
          trackResult(results, feed, site, siteDecision);
          continue;
        }

        const reachable = await checkSiteReachable(site.url);
        if (reachable.reachable && reachable.type === 'cert') {
          console.log(`   ⚠️  certificado SSL vencido — sitio responde pero no se puede verificar`);
        } else if (reachable.reachable && reachable.type === 'blocked') {
          console.log(`   ⚠️  HTTPS bloqueado por CDN (Cloudflare u otro) — sitio responde por HTTP`);
        } else {
          console.log(`   🔴 sitio no responde (${site.url})`);
          if (relayProbe) {
            const { verdict, first } = await relayProbe.forSite(site.url);
            if (first) process.stdout.write(`   🌐 ${describeRelayVerdict(verdict)}\n`);
            if (verdict.ok) {
              relayProbe.networkRisk.set(site.id, site.name);
              if (first) console.log('     ⚠️  probable bloqueo/límite de red local — revisa antes de marcarlo offline');
            }
          }
        }
        let confirmOffline = false;
        if (shouldUpdate && process.stdin.isTTY && !isAutomatic()) {
          confirmOffline = await promptUser(
            `     ⚠️  ¿"${site.name}" (${site.url}) realmente está caído? [s/N]: `,
            { defaultYes: false }
          );
        }
        if (confirmOffline) {
          siteDecision = 'offline';
          updateFeedState(feed, { status: 'offline', lastItemDate: null }, shouldUpdate);
          results.offline.push(feedLabel(site, feed));
          continue;
        }
        if (reachable.reachable) {
          const label = reachable.type === 'cert'
            ? 'Certificado SSL vencido'
            : 'HTTPS bloqueado por CDN';

          if (reachable.type === 'cert') {
            console.log(`     ℹ️  ${label} — intentando leer feed ignorando SSL...`);
            const feedData = await tryFetchFeedInsecure(feed.rss_url);
            if (feedData && feedData.itemCount > 0) {
              if (feedData.lastItemDate && daysSince(feedData.lastItemDate) > STALE_THRESHOLD_DAYS) {
                console.log(`     ⚠️  STALE (último item: ${feedData.lastItemDate.slice(0, 10)}, ${Math.round(daysSince(feedData.lastItemDate))} días)`);
                updateFeedState(feed, { status: 'stale', feedType: feedData.type, lastItemDate: feedData.lastItemDate }, shouldUpdate);
                results.stale.push(feedLabel(site, feed));
                continue;
              }
              console.log(`     ✅ feed válido a pesar del SSL (${feedData.type}, ${feedData.itemCount} item${feedData.itemCount > 1 ? 's' : ''})`);
              updateFeedState(feed, { status: 'active', feedType: feedData.type, lastItemDate: feedData.lastItemDate ?? null }, shouldUpdate);
              results.ok.push(feedLabel(site, feed));
              continue;
            }
            if (feedData && feedData.itemCount === 0) {
              console.log(`     ⚠️  vacío (${feedData.type}, 0 items) — feed válido sin contenido`);
              updateFeedState(feed, { status: 'feed_empty', feedType: feedData.type, lastItemDate: null }, shouldUpdate);
              results.other.push(feedLabel(site, feed));
              continue;
            }
            console.log(`     ❌ feed no válido incluso ignorando SSL`);
          } else {
            console.log(`     ℹ️  ${label} — no se puede verificar el feed (${feed.rss_url})`);
          }

          const chosen = await promptStatus(feed.name, feed.rss_url);
          siteDecision = chosen;
          updateFeedState(feed, { status: chosen, lastItemDate: null }, shouldUpdate);
          trackResult(results, feed, site, chosen);
        } else {
          console.log(`     ℹ️  El sitio no responde desde el script pero puede estar funcionando (${site.url}) — feed: ${feed.rss_url}`);
          const initialStatus = isAutomatic() ? 'offline' : 'no_feed';
          const chosen2 = await handleRediscoveryFail(feed, site, results, initialStatus, shouldUpdate);
          if (chosen2 !== initialStatus) siteDecision = chosen2;
        }
        continue;
      }

      process.stdout.write('   ⚠️  redescubriendo... ');
      const hints = getPreferredPatterns(feed, site);
      const feedOrigin = getFeedOrigin(feed.rss_url, site.url);
      const found = await rediscoverFeed(feedOrigin, hints);
      if (!found.feedUrl && feedOrigin !== site.url) {
        const fallback = await rediscoverFeed(site.url, hints);
        if (fallback.feedUrl) Object.assign(found, fallback);
      }

      if (found.feedUrl) {
        await handleRediscoveryWithGuard(feed, site, results, found, shouldUpdate);
      } else {
        const rediscoverError = formatError(found.error, found.code);
        console.log(`❌ ${rediscoverError}`);
        const chosen3 = await handleRediscoveryFail(feed, site, results, 'no_feed', shouldUpdate);
        if (chosen3 !== 'no_feed') siteDecision = chosen3;
      }
    }
  }

  // Detectar sitios con solo feeds proxy activos (candidatos a watchlist)
  const watchlistCandidates = [];

  await Promise.all(
    Array.from({ length: SITE_CONCURRENCY }, async () => {
      while (siteIndex < sitesToValidate.length) {
        const site = sitesToValidate[siteIndex++];
        await processSite(site);
        // Evaluar después de procesar todos los feeds del sitio
        if (shouldUpdate) {
          const nativeFeeds = site.feeds.filter(f => !isProxyFeed(f));
          const proxyFeeds = site.feeds.filter(f => isProxyFeed(f));
          if (nativeFeeds.length > 0) {
            const allNativeInactive = nativeFeeds.every(f => f.status !== 'active' || !f.verified);
            const someProxyActive = proxyFeeds.some(f => f.status === 'active' && f.verified);
            const allFeedsInactive = site.feeds.every(f => f.status !== 'active' || !f.verified);
            if ((allNativeInactive && someProxyActive) || allFeedsInactive) {
              watchlistCandidates.push(site);
            }
          }
        }
      }
    })
  );

  // ─── Resumen ───────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(55));
  console.log(`\n✅ Activos       : ${results.ok.length}`);
  if (results.ok.length) {
    for (const name of results.ok) console.log(`   • ${name}`);
  }

  if (results.fixed.length) {
    console.log(`🔄 URL corregida : ${results.fixed.length}`);
    for (const name of results.fixed) console.log(`   • ${name}`);
  }
  if (results.stale.length) {
    console.log(`⏳ Stale         : ${results.stale.length}`);
    for (const name of results.stale) console.log(`   • ${name}`);
  }
  if (results.broken.length) {
    console.log(`💔 Broken        : ${results.broken.length}`);
    for (const name of results.broken) console.log(`   • ${name}`);
  }
  if (results.offline.length) {
    console.log(`🔴 Sitio caído   : ${results.offline.length}`);
    for (const name of results.offline) console.log(`   • ${name}`);
  }
  if (results.noFeed.length) {
    console.log(`❌ Sin feed       : ${results.noFeed.length}`);
    for (const name of results.noFeed) console.log(`   • ${name}`);
  }
  if (results.other.length) {
    console.log(`📭 Feed vacío     : ${results.other.length}`);
    for (const name of results.other) console.log(`   • ${name}`);
  }
  if (results.duplicate.length) {
    console.log(`🔁 Duplicados     : ${results.duplicate.length}`);
    for (const name of results.duplicate) console.log(`   • ${name}`);
  }
  if (results.blocked.length) {
    console.log(`🚫 Bloqueado bot  : ${results.blocked.length}`);
    for (const name of results.blocked) console.log(`   • ${name}`);
  }

  if (relayProbe && relayProbe.networkRisk.size) {
    console.log(`🌐 Posible red local : ${relayProbe.networkRisk.size}`);
    for (const [id, name] of relayProbe.networkRisk) {
      console.log(`   • ${name} (${id}) — responde desde otra red`);
    }
    console.log('   ⚠️  revisa estos sitios antes de commitear: el fallo puede ser de tu red, no del sitio');
  }

  if (shouldUpdate) {
    // ─── Watchlist candidates ────────────────────────────────────────────────
    if (watchlistCandidates.length > 0) {
      const automaticMode = isAutomatic();
      // --automatic solo aprueba estados de feeds: mover entradas entre archivos
      // exige --move explícito. Excepción: corridas que validan solo un subconjunto
      // de feeds (--missing-date, --status) trabajan sobre copias filtradas del
      // sitio, así que su estado no refleja el de la BD y moverlo sería incorrecto.
      const subsetRun = !!(args.missingDate || args.status);
      const movesAllowed = !!args.move && !subsetRun;
      const autoMove = automaticMode && movesAllowed;
      const moveBlockedByFlag = automaticMode && !args.move;
      const moveBlockedBySubset = automaticMode && !!args.move && subsetRun;
      console.log(`\n📋 Candidatos a watchlist (todos los feeds nativos inactivos):`);
      for (const site of watchlistCandidates) {
        const allInactive = site.feeds.every(f => f.status !== 'active' || !f.verified);
        const reason = allInactive ? 'Sin actividad (todos los feeds inactivos)' : 'Solo feeds proxy activos (feeds nativos inactivos)';
        console.log(`\n   ${site.name} (${site.id})`);
        console.log(`     Estado: ${reason}`);
        const move = autoMove
          ? true
          : await promptUser(
            `   ¿Mover "${site.name}" a watchlist? [y/N]: `,
            { defaultYes: false }
          );
        if (move) {
          const dbIndex = db.sites.findIndex(s => s.id === site.id);
          if (dbIndex !== -1) {
            const [removed] = db.sites.splice(dbIndex, 1);
            removed.reason = reason;
            let watchlist = [];
            try {
              watchlist = JSON.parse(readFileSync('watchlist.json', 'utf-8'));
              if (!Array.isArray(watchlist)) watchlist = [];
            } catch { watchlist = []; }
            watchlist.push(removed);
            writeFileSync('watchlist.json', JSON.stringify(watchlist, null, 2), 'utf-8');
            console.log(`     → Movido a watchlist${autoMove ? ' (automático)' : ''}`);
          }
        } else {
          console.log(`     → Mantenido en database`);
        }
      }

      if (moveBlockedByFlag) {
        console.log(`\n   ℹ️  --automatic solo registra estados: no se movió ningún sitio a watchlist.`);
        console.log(`      Añade --move (junto a --update --automatic) para mover estos ${watchlistCandidates.length} sitio(s) automáticamente.`);
      } else if (moveBlockedBySubset) {
        console.log(`\n   ℹ️  --move está desactivado en corridas filtradas (--missing-date/--status):`);
        console.log(`      ejecuta --update --automatic --move sobre la BD completa para moverlos automáticamente.`);
      }
    }

    const activeFeedCount = db.sites.reduce(
      (sum, site) => sum + site.feeds.filter(f => f.status === 'active' && f.verified === true).length,
      0
    );
    db.total_feeds  = activeFeedCount;
    db.last_updated = new Date().toISOString();

    writeFileSync('feeds-database.json', JSON.stringify(db, null, 2), 'utf-8');
    console.log(`\n💾 feeds-database.json actualizado (${db.sites.length} sitios, ${activeFeedCount} feeds activos)`);
  } else {
    console.log(`\nℹ️  Modo solo-validación: usa --update para aplicar cambios a feeds-database.json`);
  }

  // ─── Duplicados (sin red) ──────────────────────────────────────────────────
  console.log();
  printDuplicateReport(db, shouldUpdate);

  await closeBrowser();
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
