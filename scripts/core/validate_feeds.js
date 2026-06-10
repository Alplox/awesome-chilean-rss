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
 * Uso: node validate_feeds.js [--update]
 *      node validate_feeds.js --id <site-id> [--update]
 *      node validate_feeds.js --watchlist [--update]
 *      node validate_feeds.js --url <URL>
 *      npm run validate
 *
 * Opciones:
 *   --update     Actualiza feeds-database.json con correcciones y redescubrimientos
 *                Por defecto solo valida sin modificar el archivo
 *   --automatic  Ejecuta en modo automático (sin prompts interactivos)
 *                Útil para CI o ejecución desatendida
 *   --watchlist  Solo valida los elementos en la watchlist (retest rápido)
 *   --url <URL>  Valida una URL específica directamente (test único)
 */

import { readFileSync, writeFileSync } from 'fs';
import { checkFeedUrl } from '../../lib/feed-validator.js';
import { isValidUrl, checkSiteStatus, checkSiteReachable, tryFetchFeedInsecure } from '../../lib/network-utils.js';
import { isAutomatic, promptUser, promptUrl, promptStatus } from '../../lib/prompter.js';
import { rediscoverFeed } from '../../lib/feed-rediscovery.js';

// ─── Configuración ────────────────────────────────────────────────────────────

const STALE_THRESHOLD_DAYS = 365;

const BROKEN_ERRORS = [
  'HTML (no es feed)',
  'no es RSS/Atom',
  'sin canal',
  'XML inválido',
  'items sin contenido válido',
];

// ─── Helpers para estado de feeds ──────────────────────────────────────────

function updateFeedState(feed, { status, feedType, rssUrl, lastItemDate } = {}, shouldUpdate) {
  if (!shouldUpdate) return;
  feed.last_checked = new Date().toISOString();
  feed.status       = status;
  feed.verified     = status === 'active';
  if (feedType !== undefined)    feed.feed_type          = feedType;
  if (rssUrl !== undefined)      feed.rss_url            = rssUrl;
  if (lastItemDate != null)      feed.last_known_item_date = lastItemDate;
}

function feedLabel(site, feed) {
  return `${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`;
}

function trackResult(results, feed, site, status) {
  const label = feedLabel(site, feed);
  if (status === 'active') results.ok.push(label);
  else if (status === 'offline') results.offline.push(label);
  else if (status === 'broken') results.broken.push(label);
  else if (status === 'no_feed') results.noFeed.push(label);
  else if (status === 'stale') results.stale.push(label);
}

async function testManualUrl(url, feedName) {
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
  updateFeedState(feed, { status, ...extra }, shouldUpdate);
  trackResult(results, feed, site, status);
}

async function handleRediscoveryFail(feed, site, results, defaultStatus, shouldUpdate) {
  if (!shouldUpdate || !process.stdin.isTTY || isAutomatic()) {
    applyFeedDecision(feed, site, results, defaultStatus, shouldUpdate);
    return;
  }
  const manualUrl = await promptUrl(feed.name, feed.rss_url);
  if (manualUrl) {
    const tested = await testManualUrl(manualUrl, feed.name);
    if (tested) {
      applyFeedDecision(feed, site, results, 'active', shouldUpdate, {
        feedType: tested.feedType, rssUrl: tested.feedUrl, lastItemDate: tested.lastItemDate
      });
      results.fixed.push(feedLabel(site, feed));
      return;
    }
  }
  const chosen = await promptStatus(feed.name, feed.rss_url);
  applyFeedDecision(feed, site, results, chosen, shouldUpdate);
}

// ─── Modo: URL única ──────────────────────────────────────────────────────────

async function validateSingleUrl(url) {
  console.log(`🔍 Validando URL: ${url}\n`);

  const feedResult = await checkFeedUrl(url);
  if (feedResult.type) {
    console.log(`✅ Feed válido: ${feedResult.type}`);
    console.log(`   Items: ${feedResult.itemCount}`);
    if (feedResult.lastItemDate) {
      console.log(`   Último item: ${feedResult.lastItemDate.slice(0, 10)}`);
    }
    return;
  }

  const errorMsg = feedResult.code ? `${feedResult.error} (${feedResult.code})` : feedResult.error;
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
    const errorMsg = found.code ? `${found.error} (${found.code})` : found.error;
    console.log(`\n❌ ${errorMsg}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));

  const args = process.argv.slice(2);
  const shouldUpdate = args.includes('--update');

  const hasWatchlistMode = args.includes('--watchlist');
  const hasUrlMode = args.includes('--url');
  const targetId = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;
  const targetUrl = hasUrlMode ? args[args.indexOf('--url') + 1] : null;

  if (args.includes('--id') && (!targetId || targetId.startsWith('--'))) {
    console.error('❌ Error: --id requiere un valor (ID del sitio)');
    process.exit(1);
  }

  if (hasUrlMode) {
    if (!targetUrl) {
      console.error('❌ Error: --url requiere una URL');
      process.exit(1);
    }
    await validateSingleUrl(targetUrl);
    return;
  }

  if (hasWatchlistMode) {
    console.log(`📢 La validación de watchlist ahora tiene su propio comando:\n`);
    console.log(`   npm run validate:watchlist [--update] [--automatic]`);
    console.log(`   node scripts/core/validate-watchlist.js [--update] [--automatic]\n`);
    return;
  }

  let sitesToValidate = db.sites;
  if (targetId) {
    sitesToValidate = db.sites.filter(s => s.id === targetId);
    if (sitesToValidate.length === 0) {
      console.error(`❌ Sitio con ID "${targetId}" no encontrado en feeds-database.json`);
      process.exit(1);
    }
  }

  const totalFeeds = sitesToValidate.reduce((sum, site) => sum + site.feeds.length, 0);

  console.log(`🔍 Revalidando ${sitesToValidate.length} sitio${sitesToValidate.length > 1 ? 's' : ''} (${totalFeeds} feed${totalFeeds > 1 ? 's' : ''}) desde feeds-database.json\n`);
  console.log('='.repeat(55));

  const results = { ok: [], fixed: [], stale: [], broken: [], offline: [], noFeed: [] };

  for (const site of sitesToValidate) {
    console.log(`\n📌 ${site.name} (${site.feeds.length} feed${site.feeds.length > 1 ? 's' : ''})`);

    // Pre-check all feeds for this site in parallel (network-bound phase)
    const checkResults = await Promise.all(
      site.feeds.map(feed => checkFeedUrl(feed.rss_url))
    );

    let siteDecision = null;

    for (const [feedIndex, feed] of site.feeds.entries()) {
      const checkResult = checkResults[feedIndex];
      const label = site.feeds.length > 1 ? `  🔍 ${feed.name}... ` : `🔍 ${site.name}... `;
      process.stdout.write(label);

      if (checkResult.type) {
        siteDecision = null;

        const itemCount = checkResult.itemCount;
        const lastItemDate = checkResult.lastItemDate;

        if (lastItemDate) {
          const daysSince = (Date.now() - new Date(lastItemDate).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince > STALE_THRESHOLD_DAYS) {
            console.log(`⚠️  STALE (último item: ${lastItemDate.slice(0, 10)}, ${Math.round(daysSince)} días)`);
            updateFeedState(feed, { status: 'stale', feedType: checkResult.type, lastItemDate }, shouldUpdate);
            results.stale.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
            continue;
          }
        } else if (itemCount === 0) {
          console.log(`⚠️  vacío (${checkResult.type}, 0 items) — no tiene contenido`);
          updateFeedState(feed, { status: 'no_feed', feedType: checkResult.type }, shouldUpdate);
          results.noFeed.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
          continue;
        } else {
          if (shouldUpdate && process.stdin.isTTY && !isAutomatic()) {
            const keepActive = await promptUser(
              `   ⚠️  "${feed.name}" — sin fecha en items.\n     📎 ${feed.rss_url}\n   ¿Activo? [Y/n]: `
            );
            if (!keepActive) {
              console.log(`   → marcado como stale (sin info de fecha)`);
              updateFeedState(feed, { status: 'stale', feedType: checkResult.type }, shouldUpdate);
              results.stale.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
              continue;
            }
          } else {
            console.log(`✅ OK (${checkResult.type}, ${itemCount} item${itemCount > 1 ? 's' : ''}, sin fecha)`);
          }
        }

        if (!lastItemDate || (Date.now() - new Date(lastItemDate).getTime()) / (1000 * 60 * 60 * 24) <= STALE_THRESHOLD_DAYS) {
          if (lastItemDate) {
            console.log(`✅ OK (${checkResult.type}, ${itemCount} item${itemCount > 1 ? 's' : ''})`);
          }
          updateFeedState(feed, { status: 'active', feedType: checkResult.type, lastItemDate }, shouldUpdate);
          results.ok.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
          continue;
        }
      }

      const errorMsg = checkResult.code
        ? `${checkResult.error} (${checkResult.code})`
        : checkResult.error;
      console.log(`❌ ${errorMsg}`);

      const isBroken = BROKEN_ERRORS.includes(checkResult.error);
      if (isBroken) {
        console.log(`   ⚠️  contenido inválido — intentando redescubrir...`);
        const found = await rediscoverFeed(site.url);
        if (found.feedUrl) {
            if (found.feedUrl === feed.rss_url) {
            console.log(`   🔄 misma URL (posible error intermitente) — ${found.feedType}, ${found.itemCount} item${found.itemCount > 1 ? 's' : ''}`);
            updateFeedState(feed, { status: 'active' }, shouldUpdate);
            results.ok.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
          } else {
            console.log(`   🔄 nueva URL: ${found.feedUrl} (${found.feedType}, ${found.itemCount} item${found.itemCount > 1 ? 's' : ''})`);
            updateFeedState(feed, { status: 'active', feedType: found.feedType, rssUrl: found.feedUrl }, shouldUpdate);
            results.fixed.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
          }
        } else {
          console.log(`   ❌ feed no recuperable`);
          await handleRediscoveryFail(feed, site, results, 'broken', shouldUpdate);
        }
        continue;
      }

      const siteStatus = await checkSiteStatus(site.url);

      if (siteStatus === 'down') {
        if (siteDecision) {
          const remaining = site.feeds.length - feedIndex;
          console.log(`     → ${siteDecision} (aplicando a ${remaining} feed${remaining > 1 ? 's restantes' : ''} del sitio)`);
          updateFeedState(feed, { status: siteDecision }, shouldUpdate);
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
        let confirmOffline = true;
        if (shouldUpdate && process.stdin.isTTY && !isAutomatic()) {
          confirmOffline = await promptUser(
            `     ⚠️  ¿"${site.name}" (${site.url}) realmente está caído? [s/N]: `,
            { defaultYes: false }
          );
        }
        if (confirmOffline) {
          siteDecision = 'offline';
          updateFeedState(feed, { status: 'offline' }, shouldUpdate);
          results.offline.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
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
                console.log(`     ✅ feed válido a pesar del SSL (${feedData.type}, ${feedData.itemCount} item${feedData.itemCount > 1 ? 's' : ''})`);
              updateFeedState(feed, { status: 'active', feedType: feedData.type, lastItemDate: feedData.lastItemDate }, shouldUpdate);
              results.ok.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
              continue;
            }
            console.log(`     ❌ feed no válido incluso ignorando SSL`);
          } else {
            console.log(`     ℹ️  ${label} — no se puede verificar el feed (${feed.rss_url})`);
          }

          const chosen = await promptStatus(feed.name, feed.rss_url);
          siteDecision = chosen;
          updateFeedState(feed, { status: chosen }, shouldUpdate);
          trackResult(results, feed, site, chosen);
        } else {
          console.log(`     ℹ️  El sitio no responde desde el script pero puede estar funcionando (${site.url}) — feed: ${feed.rss_url}`);
          await handleRediscoveryFail(feed, site, results, 'no_feed', shouldUpdate);
        }
        continue;
      }

      process.stdout.write('   ⚠️  redescubriendo... ');
      const found = await rediscoverFeed(site.url);

        if (found.feedUrl) {
        if (found.feedUrl === feed.rss_url) {
          console.log(`🔄 misma URL (posible error intermitente) — ${found.feedType}, ${found.itemCount} item${found.itemCount > 1 ? 's' : ''}`);
          updateFeedState(feed, { status: 'active' }, shouldUpdate);
          results.ok.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
        } else {
          console.log(`🔄 nueva URL: ${found.feedUrl} (${found.feedType}, ${found.itemCount} item${found.itemCount > 1 ? 's' : ''})`);
          updateFeedState(feed, { status: 'active', feedType: found.feedType, rssUrl: found.feedUrl }, shouldUpdate);
          results.fixed.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
        }
      } else {
        const rediscoverError = found.code
          ? `${found.error} (${found.code})`
          : found.error;
        console.log(`❌ ${rediscoverError}`);
        await handleRediscoveryFail(feed, site, results, 'no_feed', shouldUpdate);
      }
    }
  }

  // ─── Resumen ───────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(55));
  console.log(`\n✅ Activos       : ${results.ok.length}`);

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

  if (shouldUpdate) {
    const activeFeedCount = db.sites.reduce(
      (sum, site) => sum + site.feeds.filter(f => f.status === 'active').length,
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
