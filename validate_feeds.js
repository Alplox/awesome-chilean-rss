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
 * Uso: node validate_feeds.js
 *      npm run validate
 */

import { XMLParser } from 'fast-xml-parser';
import { readFileSync, writeFileSync } from 'fs';

// ─── Configuración ────────────────────────────────────────────────────────────

const TIMEOUT_MS = 10_000;

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
];

// ─── HTTP helper ──────────────────────────────────────────────────────────────

/**
 * Hace un fetch con timeout. Devuelve null si falla o supera el tiempo límite.
 * @param {string} url
 * @param {'GET'|'HEAD'} [method='GET']
 * @returns {Promise<Response|null>}
 */
async function fetchSafe(url, method = 'GET') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FeedValidator/2.0)' },
    });
    clearTimeout(timer);
    return res;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── Detección de feeds ───────────────────────────────────────────────────────

const parser = new XMLParser({ ignoreAttributes: false });

/**
 * Devuelve el tipo de feed si el texto es RSS o Atom válido, o null si no lo es.
 * @param {string} text
 * @returns {'RSS' | 'Atom' | null}
 */
function detectFeedType(text) {
  if (text.trimStart().startsWith('<html') || text.trimStart().startsWith('<!DOCTYPE')) return null;
  try {
    const parsed = parser.parse(text);
    if (parsed?.rss)  return 'RSS';
    if (parsed?.feed) return 'Atom';
  } catch { /* XML inválido */ }
  return null;
}

/**
 * Verifica si una URL concreta es un feed RSS/Atom válido.
 * @param {string} url
 * @returns {Promise<'RSS' | 'Atom' | null>}
 */
async function checkFeedUrl(url) {
  const res = await fetchSafe(url);
  if (!res?.ok) return null;
  const text = await res.text();
  return detectFeedType(text);
}

/**
 * Comprueba si el sitio raíz responde.
 * Útil para distinguir "feed eliminado" de "sitio caído".
 * @param {string} baseUrl  URL base del sitio (ej. "https://www.ejemplo.cl")
 * @returns {Promise<'up'|'down'>}
 */
async function checkSiteStatus(baseUrl) {
  // HEAD primero (más rápido, no descarga body)
  const res = await fetchSafe(baseUrl, 'HEAD');
  if (res && res.status < 500) return 'up';
  // Algunos servidores bloquean HEAD, intentar GET
  const res2 = await fetchSafe(baseUrl, 'GET');
  return res2 && res2.status < 500 ? 'up' : 'down';
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
 * @returns {Promise<{ feedUrl: string, feedType: string } | null>}
 */
async function rediscoverFeed(siteUrl) {
  const base = siteUrl.replace(/\/$/, '');

  // 1. Buscar en el HTML de la página raíz
  const rootRes = await fetchSafe(base);
  if (rootRes?.ok) {
    const html = await rootRes.text();
    for (const url of extractFeedLinksFromHtml(html, base)) {
      const type = await checkFeedUrl(url);
      if (type) return { feedUrl: url, feedType: type };
    }
  }

  // 2. Probar patrones comunes
  for (const pattern of FEED_PATTERNS) {
    const candidate = base + pattern;
    const type = await checkFeedUrl(candidate);
    if (type) return { feedUrl: candidate, feedType: type };
  }

  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));

  // Contar total de feeds individuales
  const totalFeeds = db.sites.reduce((sum, site) => sum + site.feeds.length, 0);

  console.log(`🔍 Revalidando ${db.sites.length} sitios (${totalFeeds} feeds) desde feeds-database.json\n`);
  console.log('='.repeat(55));

  const results = { ok: [], fixed: [], broken: [], offline: [] };

  for (const site of db.sites) {
    console.log(`\n📌 ${site.name} (${site.feeds.length} feed${site.feeds.length > 1 ? 's' : ''})`);

    for (const feed of site.feeds) {
      const label = site.feeds.length > 1 ? `  🔍 ${feed.name}... ` : `🔍 ${site.name}... `;
      process.stdout.write(label);

      // 1. Verificar si la rss_url actual sigue funcionando
      const currentType = await checkFeedUrl(feed.rss_url);

      if (currentType) {
        console.log('✅ OK');
        feed.feed_type    = currentType;
        feed.last_checked = new Date().toISOString();
        feed.status       = 'active';
        feed.verified     = true;
        results.ok.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
        continue;
      }

      // 2. URL rota — comprobar si el sitio sigue vivo
      const siteStatus = await checkSiteStatus(site.url);

      if (siteStatus === 'down') {
        console.log('🔴 sitio caído');
        feed.status       = 'offline';
        feed.verified     = false;
        feed.last_checked = new Date().toISOString();
        results.offline.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
        continue;
      }

      // 3. Sitio activo pero URL rota → intentar redescubrir
      process.stdout.write('⚠️  URL rota, redescubriendo... ');
      const found = await rediscoverFeed(site.url);

      if (found) {
        console.log(`🔄 nueva URL: ${found.feedUrl}`);
        feed.rss_url      = found.feedUrl;
        feed.feed_type    = found.feedType;
        feed.last_checked = new Date().toISOString();
        feed.status       = 'active';
        feed.verified     = true;
        results.fixed.push(`${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`);
      } else {
        console.log('❌ sin feed');
        feed.status       = 'no_feed';
        feed.verified     = false;
        feed.last_checked = new Date().toISOString();
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

  // Actualizar conteo y timestamp
  const activeFeedCount = db.sites.reduce(
    (sum, site) => sum + site.feeds.filter(f => f.status === 'active').length,
    0
  );
  db.total_feeds  = activeFeedCount;
  db.last_updated = new Date().toISOString();

  writeFileSync('feeds-database.json', JSON.stringify(db, null, 2), 'utf-8');
  console.log(`\n💾 feeds-database.json actualizado (${db.sites.length} sitios, ${activeFeedCount} feeds activos)`);

  // ─── Reintentar watchlist ──────────────────────────────────────────────────

  if (!db.watchlist?.length) return;

  console.log(`\n${'='.repeat(55)}`);
  console.log(`\n🔭 Reintentando ${db.watchlist.length} sitios en watchlist...\n`);

  const promoted = [];

  for (const entry of db.watchlist) {
    process.stdout.write(`🔍 ${entry.name}... `);
    const found = await rediscoverFeed(entry.url);

    if (found) {
      console.log(`🎉 feed encontrado: ${found.feedUrl}`);
      promoted.push({ entry, found });
    } else {
      console.log('— sin feed aún');
    }
  }

  if (promoted.length) {
    console.log(`\n🎉 ${promoted.length} sitio(s) de watchlist ahora tienen feed. Agrégalos a 'sites':`);
    for (const { entry, found } of promoted) {
      console.log(`\n  ${entry.name} (${entry.category})`);
      console.log(`  URL sitio : ${entry.url}`);
      console.log(`  Feed URL  : ${found.feedUrl} [${found.feedType}]`);
    }
  } else {
    console.log('\nNingún sitio de watchlist tiene feed RSS aún.');
  }
}

main().catch((err) => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
