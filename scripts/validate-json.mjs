/**
 * Valida la estructura de feeds-database.json.
 * Usado por el workflow de CI.
 */
import { readFileSync } from 'fs';

const REQUIRED_SITE_FIELDS  = ['id', 'name', 'url', 'category', 'feeds'];
const REQUIRED_FEED_FIELDS  = ['id', 'name', 'rss_url'];

try {
  const data = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));

  if (!data.sites)                  throw new Error("Falta clave 'sites'");
  if (!data.categories)             throw new Error("Falta clave 'categories'");
  if (!Array.isArray(data.sites))   throw new Error("'sites' debe ser un array");

  let totalActiveFeeds = 0;

  for (const site of data.sites) {
    // Validar campos obligatorios del sitio
    for (const key of REQUIRED_SITE_FIELDS) {
      if (!site[key]) throw new Error(`Sitio "${site.name ?? '?'}" sin campo '${key}'`);
    }

    if (!Array.isArray(site.feeds)) {
      throw new Error(`Sitio "${site.name}" — 'feeds' debe ser un array`);
    }

    // Solo validar feeds activos — los inactivos pueden tener rss_url vacía
    const activeFeeds = site.feeds.filter(f => f.status === 'active');
    totalActiveFeeds += activeFeeds.length;

    for (const feed of activeFeeds) {
      for (const key of REQUIRED_FEED_FIELDS) {
        if (!feed[key]) throw new Error(`Feed "${feed.name ?? '?'}" en sitio "${site.name}" sin campo '${key}'`);
      }
    }
  }

  // Verificar que total_feeds coincide con feeds activos reales
  if (data.total_feeds !== totalActiveFeeds) {
    console.warn(`⚠️  total_feeds (${data.total_feeds}) no coincide con feeds activos (${totalActiveFeeds})`);
  }

  console.log(`✅ feeds-database.json válido — ${data.sites.length} sitios, ${totalActiveFeeds} feeds activos`);
  console.log(`📁 Categorías: ${Object.keys(data.categories).join(', ')}`);

  // Validar watchlist si existe
  if (data.watchlist) {
    if (!Array.isArray(data.watchlist)) throw new Error("'watchlist' debe ser un array");
    const REQUIRED_WATCH = ['id', 'name', 'url', 'category', 'reason'];
    for (const entry of data.watchlist) {
      for (const key of REQUIRED_WATCH) {
        if (!entry[key]) throw new Error(`Watchlist "${entry.name ?? '?'}" sin campo '${key}'`);
      }
    }
    console.log(`👁️  Watchlist: ${data.watchlist.length} sitios sin feed`);
  }} catch (err) {
  console.error('❌ Error de validación:', err.message);
  process.exit(1);
}
