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
 *   --watchlist  Solo valida los elementos en la watchlist (retest rápido)
 *   --url <URL>  Valida una URL específica directamente (test único)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fetchSafe, detectFeedType, checkFeedUrl, DEFAULT_OPTIONS } from '../../lib/feed-validator.js';

// ─── Configuración ────────────────────────────────────────────────────────────

const TIMEOUT_MS = DEFAULT_OPTIONS.timeout;

/** Patrones de URL probados en orden durante el redescubrimiento. */
const FEED_PATTERNS = [
  '/feed/',
  '/feed',
  '/rss/',
  '/rss',
  '/rss.xml',
  '/feed.xml',
  '/atom/',
  '/atom',
  '/atom.xml',
  '/index.xml',
  '/feeds',
  '/feeds/',

  // '.rss', // reddit
  // '/forums/-/index.rss ', // capa9

  '/rss/chile/portada.xml', // as-chile
  '/comments/feed/', // criptonoticias-chile

  '/category/blog/feed/', // alianza-ciberseguridad
  '/blog/feed/', // netsus

  '/rss/global.xml', // entreprenerd

  '/deporte/feed/rss/', // el-marino
  '/arc/outboundfeeds/rss/category/chile/?outputType=xml', // la-tercera
  '/noticias/feed/rss/'  // gobierno-chile
];

// ─── Detección de feeds ───────────────────────────────────────────────────────

/**
 * Comprueba si el sitio raíz responde.
 * Útil para distinguir "feed eliminado" de "sitio caído".
 * @param {string} baseUrl  URL base del sitio (ej. "https://www.ejemplo.cl")
 * @returns {Promise<'up'|'down'>}
 */
async function checkSiteStatus(baseUrl) {
  // HEAD primero (más rápido, no descarga body)
  const res = await fetchSafe(baseUrl, 'HEAD');
  if (res && res.ok) return 'up';
  if (res && res.status < 500) return 'up'; // 4xx errors still mean site is up

  // Algunos servidores bloquean HEAD, intentar GET
  const res2 = await fetchSafe(baseUrl, 'GET');
  if (res2 && res2.ok) return 'up';
  if (res2 && res2.status < 500) return 'up';

  return 'down';
}

/**
 * Extrae URLs de feeds del HTML buscando tags <link rel="alternate">.
 * @param {string} html
 * @param {string} baseUrl  Para resolver rutas relativas
 * @returns {string[]}
 */
function extractFeedLinksFromHtml(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const linkRe = /<link[^>]+rel=["']alternate["'][^>]*>/gi;
  const typeRe = /type=["']application\/(rss|atom)\+xml["']/i;
  const hrefRe = /href=["']([^"']+)["']/i;

  return (html.match(linkRe) ?? [])
    .filter(tag => typeRe.test(tag))
    .map(tag => {
      const m = tag.match(hrefRe);
      if (!m) return null;
      let href = m[1];
      if (href.startsWith('//')) href = 'https:' + href;
      if (href.startsWith('/'))  href = origin + href;
      return href;
    })
    .filter(Boolean);
}

/**
 * Intenta redescubrir el feed de un sitio usando:
 *   1. Tags <link alternate> en el HTML raíz
 *   2. Patrones comunes de URL
 *
 * @param {string} siteUrl  URL base del sitio
 * @returns {Promise<{ feedUrl: string, feedType: string, itemCount: number } | { error: string, code?: number } | null>}
 */
async function rediscoverFeed(siteUrl) {
  const base = siteUrl.replace(/\/$/, '');

  // 1. Verificar si el sitio está accesible
  const rootRes = await fetchSafe(base);
  if (!rootRes) {
    return { error: 'sitio no responde', code: null };
  }
  if (!rootRes.ok) {
    return { error: 'HTTP error', code: rootRes.status };
  }

  // 2. Buscar en el HTML de la página raíz
  const html = await rootRes.text();
  const feedLinks = extractFeedLinksFromHtml(html, base);

  if (feedLinks.length > 0) {
    // Priorizar feeds principales sobre feeds de comentarios
    const mainFeeds = feedLinks.filter(url => !url.includes('/comments/'));
    const feedsToCheck = mainFeeds.length > 0 ? mainFeeds : feedLinks;
    
    for (const url of feedsToCheck) {
      const result = await checkFeedUrl(url);
      if (result.type) return { feedUrl: url, feedType: result.type, itemCount: result.itemCount };
    }
    // Si encontró links pero ninguno pasó la validación
    return { error: 'feed vacío o sin items', code: null };
  }

  // 3. Probar patrones comunes
  for (const pattern of FEED_PATTERNS) {
    const candidate = base + pattern;
    const result = await checkFeedUrl(candidate);
    if (result.type) return { feedUrl: candidate, feedType: result.type, itemCount: result.itemCount };
  }

  return { error: 'sin feed RSS detectado', code: null };
}

// ─── Modo: URL única ──────────────────────────────────────────────────────────

async function validateSingleUrl(url) {
  console.log(`🔍 Validando URL: ${url}\n`);
  
  // Primero intenta como feed directo
  const feedResult = await checkFeedUrl(url);
  if (feedResult.type) {
    console.log(`✅ Feed válido: ${feedResult.type}`);
    console.log(`   Items: ${feedResult.itemCount}`);
    console.log(`   Timeout: ${feedResult.timeout}ms\n`);
    return;
  }

  // Si no es feed directo, intenta redescubrir desde la URL como sitio base
  console.log(`ℹ️  No es un feed directo, intentando redescubrir desde el sitio...\n`);
  
  const siteStatus = await checkSiteStatus(url);
  if (siteStatus === 'down') {
    console.log(`❌ El sitio no responde (${url})`);
    return;
  }

  process.stdout.write('🔍 Redescubriendo feeds... ');
  const found = await rediscoverFeed(url);
  
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

// ─── Modo: Watchlist ──────────────────────────────────────────────────────────

async function validateWatchlist(db, shouldUpdate) {
  if (!db.watchlist?.length) {
    console.log(`⚠️  No hay sitios en la watchlist\n`);
    return;
  }

  console.log(`🔭 Validando ${db.watchlist.length} sitios de watchlist\n`);
  console.log('='.repeat(55));

  const promoted = [];
  const errors = { noResponse: [], httpError: [], emptyFeed: [], noFeed: [] };

  for (const entry of db.watchlist) {
    process.stdout.write(`🔍 ${entry.name}... `);
    const result = await rediscoverFeed(entry.url);

    if (result.feedUrl) {
      console.log(`🎉 feed encontrado!`);
      console.log(`   URL: ${result.feedUrl} [${result.feedType}]`);
      console.log(`   Items: ${result.itemCount}\n`);
      promoted.push({ entry, found: result });
    } else {
      const errorMsg = result.code
        ? `${result.error} (${result.code})`
        : result.error;
      console.log(`❌ ${errorMsg}`);

      // Categorizar errores para resumen
      if (result.error === 'sitio no responde') {
        errors.noResponse.push(entry.name);
      } else if (result.error === 'HTTP error') {
        errors.httpError.push(`${entry.name} (${result.code})`);
      } else if (result.error === 'feed vacío o sin items') {
        errors.emptyFeed.push(entry.name);
      } else {
        errors.noFeed.push(entry.name);
      }
    }
  }

  // Resumen
  console.log('='.repeat(55));

  if (promoted.length) {
    console.log(`\n✅ ${promoted.length} sitio(s) en watchlist con feed encontrado:\n`);
    for (const { entry, found } of promoted) {
      console.log(`  ${entry.name} (${entry.category})`);
      console.log(`  URL sitio : ${entry.url}`);
      console.log(`  Feed URL  : ${found.feedUrl} [${found.feedType}]`);
      if (shouldUpdate) {
        console.log(`  → Agregálo a 'sites' en feeds-database.json\n`);
      }
    }
  }

  // Resumen de errores
  if (errors.noResponse.length || errors.httpError.length || errors.emptyFeed.length || errors.noFeed.length) {
    console.log(`\n❌ Resumen de watchlist:\n`);
    if (errors.noResponse.length) {
      console.log(`   🔴 No responden: ${errors.noResponse.length}`);
      errors.noResponse.forEach(name => console.log(`      • ${name}`));
    }
    if (errors.httpError.length) {
      console.log(`   🟡 HTTP errors: ${errors.httpError.length}`);
      errors.httpError.forEach(name => console.log(`      • ${name}`));
    }
    if (errors.emptyFeed.length) {
      console.log(`   ⚠️  Feed vacío: ${errors.emptyFeed.length}`);
      errors.emptyFeed.forEach(name => console.log(`      • ${name}`));
    }
    if (errors.noFeed.length) {
      console.log(`   🔵 Sin feed RSS: ${errors.noFeed.length}`);
      errors.noFeed.forEach(name => console.log(`      • ${name}`));
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));

  // Parsear argumentos de línea de comandos
  const args = process.argv.slice(2);
  const shouldUpdate = args.includes('--update');
  
  // Detectar modo
  const hasWatchlistMode = args.includes('--watchlist');
  const hasUrlMode = args.includes('--url');
  const targetId = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;
  const targetUrl = hasUrlMode ? args[args.indexOf('--url') + 1] : null;

  // Modo 1: URL única
  if (hasUrlMode) {
    if (!targetUrl) {
      console.error('❌ Error: --url requiere una URL');
      process.exit(1);
    }
    await validateSingleUrl(targetUrl);
    return;
  }

  // Modo 2: Watchlist
  if (hasWatchlistMode) {
    await validateWatchlist(db, shouldUpdate);
    return;
  }

  // Filtrar sitios si se especifica un ID
  let sitesToValidate = db.sites;
  if (targetId) {
    sitesToValidate = db.sites.filter(s => s.id === targetId);
    if (sitesToValidate.length === 0) {
      console.error(`❌ Sitio con ID "${targetId}" no encontrado en feeds-database.json`);
      process.exit(1);
    }
  }

  // Contar total de feeds individuales
  const totalFeeds = sitesToValidate.reduce((sum, site) => sum + site.feeds.length, 0);

  console.log(`🔍 Revalidando ${sitesToValidate.length} sitio${sitesToValidate.length > 1 ? 's' : ''} (${totalFeeds} feed${totalFeeds > 1 ? 's' : ''}) desde feeds-database.json\n`);
  console.log('='.repeat(55));

  const results = { ok: [], fixed: [], broken: [], offline: [] };

  for (const site of sitesToValidate) {
    console.log(`\n📌 ${site.name} (${site.feeds.length} feed${site.feeds.length > 1 ? 's' : ''})`);

    for (const feed of site.feeds) {
      const label = site.feeds.length > 1 ? `  🔍 ${feed.name}... ` : `🔍 ${site.name}... `;
      process.stdout.write(label);

      // 1. Verificar si la rss_url actual sigue funcionando
      const checkResult = await checkFeedUrl(feed.rss_url);

      if (checkResult.type) {
        const itemCount = checkResult.itemCount;
        console.log(`✅ OK (${checkResult.type}, ${itemCount} item${itemCount > 1 ? 's' : ''})`);
        if (shouldUpdate) {
          feed.feed_type    = checkResult.type;
          feed.last_checked = new Date().toISOString();
          feed.status       = 'active';
          feed.verified     = true;
        }
        results.ok.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
        continue;
      }

      // Feed no válido - mostrar error específico
      const errorMsg = checkResult.code
        ? `${checkResult.error} (${checkResult.code})`
        : checkResult.error;
      console.log(`❌ ${errorMsg}`);

      // 2. URL rota — comprobar si el sitio sigue vivo
      const siteStatus = await checkSiteStatus(site.url);

      if (siteStatus === 'down') {
        console.log(`   🔴 sitio caído`);
        if (shouldUpdate) {
          feed.status       = 'offline';
          feed.verified     = false;
          feed.last_checked = new Date().toISOString();
        }
        results.offline.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
        continue;
      }

      // 3. Sitio activo pero URL rota → intentar redescubrir
      process.stdout.write('   ⚠️  redescubriendo... ');
      const found = await rediscoverFeed(site.url);

      if (found.feedUrl) {
        console.log(`🔄 nueva URL: ${found.feedUrl} (${found.feedType}, ${found.itemCount} item${found.itemCount > 1 ? 's' : ''})`);
        if (shouldUpdate) {
          feed.rss_url      = found.feedUrl;
          feed.feed_type    = found.feedType;
          feed.last_checked = new Date().toISOString();
          feed.status       = 'active';
          feed.verified     = true;
        }
        results.fixed.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
      } else {
        const rediscoverError = found.code
          ? `${found.error} (${found.code})`
          : found.error;
        console.log(`❌ ${rediscoverError}`);
        if (shouldUpdate) {
          feed.status       = 'no_feed';
          feed.verified     = false;
          feed.last_checked = new Date().toISOString();
        }
        results.broken.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
      }
    }
  }

  // ─── Resumen ───────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(55));
  console.log(`\n✅ Sin cambios    : ${results.ok.length}`);

  if (results.fixed.length) {
    console.log(`🔄 URL corregida  : ${results.fixed.length}`);
    for (const name of results.fixed) console.log(`   • ${name}`);
  }
  if (results.broken.length) {
    console.log(`❌ Sin feed       : ${results.broken.length}`);
    for (const name of results.broken) console.log(`   • ${name}`);
  }
  if (results.offline.length) {
    console.log(`🔴 Sitio caído    : ${results.offline.length}`);
    for (const name of results.offline) console.log(`   • ${name}`);
  }

  // Actualizar conteo y timestamp solo si --update está activo
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
