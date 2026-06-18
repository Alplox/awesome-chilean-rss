/**
 * Valida la estructura de feeds-database.json, categories.json y watchlist.json.
 * Usado por el workflow de CI.
 */
import { readFileSync } from 'fs';
import { ALLOWED_STATUSES } from '../../lib/feed-utils.js';

const REQUIRED_SITE_FIELDS = ['id', 'name', 'url', 'category', 'feeds'];
const REQUIRED_FEED_FIELDS = ['id', 'name', 'rss_url'];
const REQUIRED_WATCH_FIELDS = ['id', 'name', 'url', 'category', 'description', 'reason', 'feeds'];

let exitCode = 0;

function error(msg) {
  console.error('❌', msg);
  exitCode = 1;
}

// ─── categories.json ─────────────────────────────────────────────────

const categories = JSON.parse(readFileSync('categories.json', 'utf-8'));
if (typeof categories !== 'object' || Array.isArray(categories) || !categories) {
  error('categories.json debe ser un objeto');
}

const categoryKeys = Object.keys(categories);
console.log(`📁 Categorías (${categoryKeys.length}): ${categoryKeys.join(', ')}`);

for (const [key, val] of Object.entries(categories)) {
  if (typeof val !== 'object' || !val.label) {
    error(`Categoría "${key}" debe tener un campo "label"`);
  }
  if (!Array.isArray(val.slugs)) {
    error(`Categoría "${key}" debe tener un array "slugs"`);
  }
  if (val.order !== undefined && (!Number.isInteger(val.order) || val.order < 1)) {
    error(`Categoría "${key}" — "order" debe ser un entero ≥ 1`);
  }
}

// ─── regions.json ────────────────────────────────────────────────────

const regions = JSON.parse(readFileSync('regions.json', 'utf-8'));
if (typeof regions !== 'object' || Array.isArray(regions) || !regions) {
  error('regions.json debe ser un objeto');
}

const regionKeys = Object.keys(regions);
console.log(`📁 Regiones (${regionKeys.length}): ${regionKeys.join(', ')}`);

// ─── feeds-database.json ─────────────────────────────────────────────

const data = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));

if (!data.sites) error("Falta clave 'sites'");
if (!Array.isArray(data.sites)) error("'sites' debe ser un array");

let totalActiveFeeds = 0;

for (const site of data.sites) {
  for (const key of REQUIRED_SITE_FIELDS) {
    if (!site[key]) error(`Sitio "${site.name ?? '?'}" sin campo '${key}'`);
  }

  if (!Array.isArray(site.feeds)) {
    error(`Sitio "${site.name}" — 'feeds' debe ser un array`);
  }

  if (site.region && !regions[site.region]) {
    error(`Sitio "${site.name}" tiene region "${site.region}" que no existe en regions.json`);
  }

  const activeFeeds = site.feeds.filter(f => f.status === 'active');
  totalActiveFeeds += activeFeeds.length;

  for (const feed of site.feeds) {
    for (const key of REQUIRED_FEED_FIELDS) {
      if (!feed[key]) error(`Feed "${feed.name ?? '?'}" en sitio "${site.name}" sin campo '${key}'`);
    }
    if (feed.category && !categories[feed.category]) {
      error(`Feed "${feed.name}" en sitio "${site.name}" tiene category "${feed.category}" que no existe en categories.json`);
    }
    if (feed.region && !regions[feed.region]) {
      error(`Feed "${feed.name}" en sitio "${site.name}" tiene region "${feed.region}" que no existe en regions.json`);
    }
  }

  for (const feed of site.feeds) {
    if (feed.status && !ALLOWED_STATUSES.includes(feed.status)) {
      error(`Feed "${feed.name}" en sitio "${site.name}" tiene status inválido: "${feed.status}"`);
    }
  }
}

if (data.total_feeds !== totalActiveFeeds) {
  error(`total_feeds (${data.total_feeds}) no coincide con feeds activos (${totalActiveFeeds})`);
}

console.log(`✅ feeds-database.json — ${data.sites.length} sitios, ${totalActiveFeeds} feeds activos`);

// ─── watchlist.json ──────────────────────────────────────────────────

const watchlist = JSON.parse(readFileSync('watchlist.json', 'utf-8'));

if (!Array.isArray(watchlist)) error("watchlist.json debe ser un array");

for (const entry of watchlist) {
  for (const key of REQUIRED_WATCH_FIELDS) {
    if (!entry[key]) error(`Watchlist "${entry.name ?? '?'}" sin campo '${key}'`);
  }
  if (!categories[entry.category]) {
    error(`Watchlist "${entry.name}" tiene category "${entry.category}" que no existe en categories.json`);
  }
  if (entry.region && !regions[entry.region]) {
    error(`Watchlist "${entry.name}" tiene region "${entry.region}" que no existe en regions.json`);
  }
  if (!Array.isArray(entry.feeds)) {
    error(`Watchlist "${entry.name}" — 'feeds' debe ser un array`);
  }
  if (entry.feeds.length > 0) {
    for (const feed of entry.feeds) {
      if (feed.category && !categories[feed.category]) {
        error(`Feed en watchlist "${entry.name}" tiene category "${feed.category}" que no existe en categories.json`);
      }
      if (feed.region && !regions[feed.region]) {
        error(`Feed en watchlist "${entry.name}" tiene region "${feed.region}" que no existe en regions.json`);
      }
      if (feed.status && !ALLOWED_STATUSES.includes(feed.status)) {
        error(`Feed en watchlist "${entry.name}" tiene status inválido: "${feed.status}"`);
      }
    }
  }
}

console.log(`✅ watchlist.json — ${watchlist.length} sitios sin feed`);

// ─── Salida ──────────────────────────────────────────────────────────

if (exitCode) process.exit(1);
