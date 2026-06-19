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
 *
 * Para agregar nuevos sitios: edita feeds-database.json directamente,
 * luego corre este script para verificar y rellenar rss_url automáticamente.
 *
 * Uso: node validate_feeds.js [--update] [--automatic]
 *      node validate_feeds.js --id <site-id> [--update]
 *      node validate_feeds.js --url <URL>
 *      node validate_feeds.js --start-id <site-id> [--limit <N>]
 *      node validate_feeds.js --from <N> --to <N> [--update]
 *      npm run validate
 *
 * Opciones:
 *   --update         Actualiza feeds-database.json con correcciones y redescubrimientos
 *                    Por defecto solo valida sin modificar el archivo
 *   --automatic      Ejecuta en modo automático (sin prompts interactivos)
 *                    Útil para CI o ejecución desatendida
 *   --id <site-id>   Valida un sitio específico por su ID
 *   --url <URL>      Valida una URL específica directamente (test único)
 *   --start-id <id>  Comienza la validación desde este site-id (inclusive)
 *   --from <N>       Índice numérico inicial (0-based)
 *   --to <N>         Índice numérico final (inclusive)
 *   --limit <N>      Máximo de sitios a validar (se aplica al final)
 *   --missing-date   Solo valida feeds sin last_known_item_date (nunca verificados)
 *   --status <status>  Solo valida feeds con el estado especificado (active, stale, broken, offline, no_feed, feed_empty)
 *   --watchlist      Muestra instrucciones para usar validate:watchlist
 */

import { readFileSync, writeFileSync } from 'fs';
import { checkFeedUrl } from '../../lib/feed-validator.js';
import { isValidUrl, checkSiteStatus, checkSiteReachable, tryFetchFeedInsecure } from '../../lib/network-utils.js';
import { isAutomatic, promptUser, promptUrl, promptStatus } from '../../lib/prompter.js';
import { rediscoverFeed, clearHomepageCache } from '../../lib/feed-rediscovery.js';
import { STALE_THRESHOLD_DAYS, daysSince, pathsMatch, formatError, ALLOWED_STATUSES, BROKEN_ERRORS } from '../../lib/feed-utils.js';
import { parseArgs, applyFiltersSites } from '../../lib/cli-args.js';

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
function isGenericFeedUrl(url) {
  const genericBase = ['/feed/', '/rss/', '/atom/', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml'];
  try {
    const path = new URL(url).pathname.toLowerCase();
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));

  const args = parseArgs(process.argv, [
    { flag: '--url', name: 'url', type: 'value' },
    { flag: '--status', name: 'status', type: 'value' },
    { flag: '--missing-date', name: 'missingDate', type: 'bool' },
    { flag: '--watchlist', name: 'watchlist', type: 'bool' },
  ]);

  if (args.status && !ALLOWED_STATUSES.includes(args.status)) {
    console.error(`❌ Error: --status requiere un estado válido (${ALLOWED_STATUSES.join(', ')})`);
    process.exit(1);
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
    console.log(`   npm run validate:watchlist [--update] [--automatic]`);
    console.log(`   node scripts/core/validate-watchlist.js [--update] [--automatic]\n`);
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

  const results = { ok: [], fixed: [], stale: [], broken: [], offline: [], noFeed: [], other: [] };
  const getCachedSiteStatus = createSiteStatusCache();
  clearHomepageCache();

  const SITE_CONCURRENCY = 1;
  let siteIndex = 0;

  async function processSite(site) {
    console.log(`\n📌 ${site.name} (${site.feeds.length} feed${site.feeds.length > 1 ? 's' : ''})`);

    // Pre-check all feeds for this site in parallel (network-bound phase)
    const settledResults = await Promise.allSettled(
      site.feeds.map(feed => checkFeedUrl(feed.rss_url))
    );
    const checkResults = settledResults.map(r =>
      r.status === 'fulfilled' ? r.value : { error: 'error inesperado', code: null }
    );

    let siteDecision = null;

    for (const [feedIndex, feed] of site.feeds.entries()) {
      const checkResult = checkResults[feedIndex];
      const label = `  🔍 ${feed.name}... `;
      process.stdout.write(label);

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
          const chosen2 = await handleRediscoveryFail(feed, site, results, 'no_feed', shouldUpdate);
          if (chosen2 !== 'no_feed') siteDecision = chosen2;
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
          if (nativeFeeds.length > 0 && proxyFeeds.length > 0) {
            const allNativeInactive = nativeFeeds.every(f => f.status !== 'active' || !f.verified);
            const someProxyActive = proxyFeeds.some(f => f.status === 'active' && f.verified);
            if (allNativeInactive && someProxyActive) {
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

  if (shouldUpdate) {
    // ─── Watchlist candidates ────────────────────────────────────────────────
    if (watchlistCandidates.length > 0) {
      console.log(`\n📋 Sitios con solo feeds proxy activos:`);
      for (const site of watchlistCandidates) {
        const details = site.feeds
          .filter(f => isProxyFeed(f) && f.status === 'active' && f.verified)
          .map(f => `     • ${f.name}: activo`);
        console.log(`\n   ${site.name} (${site.id})`);
        for (const d of details) console.log(d);
        const move = await promptUser(
          `   ¿Mover "${site.name}" a watchlist? [y/N]: `,
          { defaultYes: false }
        );
        if (move) {
          const dbIndex = db.sites.findIndex(s => s.id === site.id);
          if (dbIndex !== -1) {
            const [removed] = db.sites.splice(dbIndex, 1);
            removed.reason = 'Solo feeds proxy activos (feeds nativos inactivos)';
            let watchlist = [];
            try {
              watchlist = JSON.parse(readFileSync('watchlist.json', 'utf-8'));
              if (!Array.isArray(watchlist)) watchlist = [];
            } catch { watchlist = []; }
            watchlist.push(removed);
            writeFileSync('watchlist.json', JSON.stringify(watchlist, null, 2), 'utf-8');
            console.log(`     → Movido a watchlist`);
          }
        } else {
          console.log(`     → Mantenido en database`);
        }
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
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
