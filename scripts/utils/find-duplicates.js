#!/usr/bin/env node
/**
 * find-duplicates.js
 *
 * Detecta entradas duplicadas:
 *
 *  Intra-database (feeds-database.json):
 *   1. Sitios con la misma URL de sitio (site.url)
 *   2. Feeds con el mismo rss_url (global, incluso entre sitios distintos)
 *   3. Posibles sitios duplicados (mismo dominio raíz)
 *   4. IDs de sitio duplicados
 *   5. IDs de feed duplicados
 *
 *  Intra-watchlist (watchlist.json):
 *   6. Entradas con el mismo ID o la misma URL de sitio
 *      6a. Mismo site.id
 *      6b. Misma site.url normalizada
 *      6c. Mismo dominio raíz con URL distinta (sospechoso)
 *   7. Feeds con el mismo ID o rss_url
 *
 *  Cross-file (feeds-database.json ↔ watchlist.json):
 *   8. Sitios que viven en ambos archivos
 *      8a. Mismo site.id en ambos
 *      8b. Misma site.url normalizada en ambos
 *      8c. Mismo dominio raíz con URL distinta (sospechoso)
 *   9. Feeds que viven en ambos archivos
 *      9a. Mismo feed.id en ambos
 *      9b. Mismo rss_url en ambos
 *
 * Esto detecta promociones incompletas: sitios movidos de watchlist a
 * database sin eliminar la entrada original de watchlist, y re-apendidos
 * accidentales dentro de watchlist.
 *
 * Uso:
 *   pnpm check:duplicates
 *   pnpm check:duplicates -- --verbose        (links clicables)
 *   pnpm check:duplicates -- --all            (sin recorte)
 *   pnpm check:duplicates -- --limit 20       (límite por sección)
 *   pnpm check:duplicates -- --out reporte.txt (guarda reporte)
 *   pnpm check:duplicates -- --json reporte.json
 *   pnpm check:duplicates -- --fix --dry-run  (preview limpieza)
 *   pnpm check:duplicates -- --fix --yes      (elimina de watchlist, keep DB)
 *   pnpm check:duplicates -- --fix --keep watchlist --yes
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline';
import { findDuplicates, normalizeSiteUrl, normalizeFeedUrl } from '../../lib/duplicate-finder.js';

const rawArgs = process.argv.slice(2);
const verbose = rawArgs.includes('--verbose') || rawArgs.includes('-v');
const doAll = rawArgs.includes('--all');
const doFix = rawArgs.includes('--fix');
const dryRun = rawArgs.includes('--dry-run');
const autoYes = rawArgs.includes('--yes') || rawArgs.includes('-y') || rawArgs.includes('--automatic') || rawArgs.includes('--force');
const help = rawArgs.includes('--help') || rawArgs.includes('-h');

function getArgValue(flag) {
  const idx = rawArgs.indexOf(flag);
  if (idx !== -1 && idx + 1 < rawArgs.length && !rawArgs[idx + 1].startsWith('--')) return rawArgs[idx + 1];
  return null;
}
let keep = getArgValue('--keep') || 'db';
if (!['db', 'database', 'watchlist', 'wl'].includes(keep)) {
  console.error(`❌ --keep debe ser "db" o "watchlist" (recibido "${keep}")`);
  process.exit(1);
}
keep = (keep === 'database' ? 'db' : keep === 'wl' ? 'watchlist' : keep);

let limitArg = null;
const limitStr = getArgValue('--limit');
if (limitStr !== null) {
  limitArg = parseInt(limitStr, 10);
  if (isNaN(limitArg) || limitArg < 0) {
    console.error('❌ --limit requiere un número >= 0');
    process.exit(1);
  }
}
const outFile = getArgValue('--out');
const jsonFile = getArgValue('--json');

if (help) {
  console.log(`
Uso:  -- [opciones]

Opciones:
  --verbose, -v        Links clicables archivo:línea
  --all                Muestra todo sin recortar (sin límite)
  --limit <N>          Límite de items por sección (default 15 sitios / 10 feeds)
  --out <archivo>      Guarda el reporte completo en un archivo (texto)
  --json <archivo>     Guarda reporte machine-readable en JSON
  --fix                Elimina duplicados internos de watchlist y cruzados DB↔WL
                       (default: keep DB, borra de watchlist)
  --keep <db|watchlist> Qué archivo conservar al hacer --fix (default: db)
  --dry-run            Preview de --fix sin escribir archivos
  --yes, -y            No pide confirmación para --fix
  --help, -h           Esta ayuda

Ejemplos:
  pnpm check:duplicates -- --fix --dry-run
  pnpm check:duplicates -- --fix --yes
  pnpm check:duplicates -- --all --out reporte.txt
  pnpm check:duplicates -- --json dupes.json
`);
  process.exit(0);
}

const SITE_LIMIT = doAll ? Infinity : (limitArg ?? 15);
const FEED_LIMIT = doAll ? Infinity : (limitArg ?? 10);

const DB_FILE = 'feeds-database.json';
const WL_FILE = 'watchlist.json';
const DB_ABS  = resolve(DB_FILE);
const WL_ABS  = resolve(WL_FILE);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildLineIndex(rawText) {
  const index = new Map();
  const lines = rawText.split('\n');
  const idRe = /^\s*"id"\s*:\s*"([^"]+)"/;
  for (let i = 0; i < lines.length; i++) {
    const m = idRe.exec(lines[i]);
    if (m) {
      const id = m[1];
      if (!index.has(id)) index.set(id, i + 1);
    }
  }
  return index;
}

/** Igual que buildLineIndex pero conserva todas las líneas de un ID repetido. */
function buildLineIndexAll(rawText) {
  const index = new Map();
  const lines = rawText.split('\n');
  const idRe = /^\s*"id"\s*:\s*"([^"]+)"/;
  for (let i = 0; i < lines.length; i++) {
    const m = idRe.exec(lines[i]);
    if (m) {
      if (!index.has(m[1])) index.set(m[1], []);
      index.get(m[1]).push(i + 1);
    }
  }
  return index;
}

function fileLink(id, lineIndex, fileAbs) {
  if (!verbose) return '';
  const line = lineIndex.get(id) ?? 1;
  return `     📎 ${fileAbs}:${line}`;
}

// Alias local sobre la normalización compartida (lib/duplicate-finder.js)
const normalizeUrl = normalizeSiteUrl;

function askConfirm(question) {
  if (autoYes) return Promise.resolve(true);
  if (!process.stdin.isTTY) return Promise.resolve(true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      const v = answer.trim().toLowerCase();
      resolve(v === '' || v === 'y' || v === 'yes' || v === 's' || v === 'si');
    });
  });
}

// Capture console output for --out
const capturedLines = [];
const origLog = console.log;
if (outFile) {
  console.log = (...args) => {
    const line = args.join(' ');
    capturedLines.push(line);
    origLog(...args);
  };
}

// ─── Load data ────────────────────────────────────────────────────────────────

const rawText = readFileSync(DB_FILE, 'utf-8');
const db = JSON.parse(rawText);
const { sites } = db;
const lineIndex = buildLineIndex(rawText);

let wlSites = [];
let wlRawText = '';
let wlLineIndex = new Map();
let wlAvailable = false;
let wlParsedRaw = null;
try {
  wlRawText = readFileSync(WL_FILE, 'utf-8');
  wlParsedRaw = JSON.parse(wlRawText);
  wlSites = Array.isArray(wlParsedRaw) ? wlParsedRaw : (wlParsedRaw.sites ?? []);
  wlLineIndex = buildLineIndex(wlRawText);
  wlAvailable = true;
} catch {
  wlSites = [];
  wlAvailable = false;
}

let foundAny = false;

// For JSON report
const report = {
  dbFile: DB_FILE,
  wlFile: WL_FILE,
  dbSites: sites.length,
  wlSites: wlSites.length,
  intra: {},
  cross: {},
};

// ─── Detección (lib/duplicate-finder.js) ─────────────────────────────────────
const { intra, wlIntra, cross } = findDuplicates(sites, wlAvailable ? wlSites : null);
const { siteUrlMap, feedUrlMap, rootDomainMap, siteIdMap, feedIdMap } = intra;

// ─── 1. Duplicate site URLs ───────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════');
console.log('  🔍 Buscando duplicados en feeds-database.json');
console.log('═══════════════════════════════════════════════════════\n');
console.log('── 1. Sitios con la misma URL (site.url) ──────────────\n');
let dupSiteUrlCount = 0;
for (const [key, group] of siteUrlMap.entries()) {
  dupSiteUrlCount++;
  foundAny = true;
  console.log(`⚠️  URL duplicada: "${key}"`);
  for (const s of group) {
    console.log(`   • [${s.id}] ${s.name} — ${s.url}`);
    if (verbose) {
      console.log(fileLink(s.id, lineIndex, DB_ABS));
      for (const f of s.feeds) {
        console.log(`     ↳ feed [${f.id}]: ${f.rss_url} | ${f.status}`);
        console.log(fileLink(f.id, lineIndex, DB_ABS));
      }
    }
  }
  console.log();
}
if (dupSiteUrlCount === 0) console.log('✅ No se encontraron URLs de sitio duplicadas.\n');
report.intra.dupSiteUrlCount = dupSiteUrlCount;

// ─── 2. Duplicate feed RSS URLs ───────────────────────────────────────────────
console.log('── 2. Feeds con el mismo rss_url (global) ─────────────\n');
let dupFeedUrlCount = 0;
for (const [key, group] of feedUrlMap.entries()) {
  dupFeedUrlCount++;
  foundAny = true;
  console.log(`⚠️  RSS URL duplicada: "${key}"`);
  for (const { site, feed } of group) {
    console.log(`   • Feed [${feed.id}] en sitio [${site.id}] "${site.name}"`);
    console.log(`     rss_url: ${feed.rss_url} | status: ${feed.status}`);
    if (verbose) {
      console.log(`     Sitio  ${DB_ABS}:${lineIndex.get(site.id) ?? 1}`);
      console.log(`     Feed   ${DB_ABS}:${lineIndex.get(feed.id) ?? 1}`);
    }
  }
  console.log();
}
if (dupFeedUrlCount === 0) console.log('✅ No se encontraron rss_url de feed duplicadas.\n');
report.intra.dupFeedUrlCount = dupFeedUrlCount;

// ─── 3. Possible duplicate sites (same root domain) ──────────────────────────
console.log('── 3. Posibles sitios duplicados (mismo dominio raíz) ──\n');
let dupRootCount = 0;
for (const [domain, group] of rootDomainMap.entries()) {
  dupRootCount++;
  foundAny = true;
  console.log(`⚠️  Posibles duplicados — dominio raíz: "${domain}"`);
  for (const s of group) {
    const activeFeedCount = s.feeds.filter(f => f.status === 'active').length;
    console.log(`   • [${s.id}] ${s.name} — ${s.url} (${activeFeedCount} feeds activos)`);
    if (verbose) {
      console.log(fileLink(s.id, lineIndex, DB_ABS));
      for (const f of s.feeds) {
        console.log(`     ↳ feed [${f.id}]: ${f.rss_url} | ${f.status}`);
        console.log(fileLink(f.id, lineIndex, DB_ABS));
      }
    }
  }
  console.log();
}
if (dupRootCount === 0) console.log('✅ No se encontraron sitios con el mismo dominio raíz.\n');
report.intra.dupRootCount = dupRootCount;

// ─── 4. Duplicate site IDs ────────────────────────────────────────────────────
console.log('── 4. IDs de sitio duplicados ──────────────────────────\n');
let dupIdCount = 0;
for (const [id, group] of siteIdMap.entries()) {
  dupIdCount++;
  foundAny = true;
  console.log(`⚠️  ID de sitio duplicado: "${id}"`);
  for (const s of group) {
    console.log(`   • ${s.name} — ${s.url}`);
    if (verbose) console.log(fileLink(s.id, lineIndex, DB_ABS));
  }
  console.log();
}
if (dupIdCount === 0) console.log('✅ No se encontraron IDs de sitio duplicados.\n');
report.intra.dupIdCount = dupIdCount;

// ─── 5. Duplicate feed IDs ────────────────────────────────────────────────────
console.log('── 5. IDs de feed duplicados (global) ──────────────────\n');
let dupFeedIdCount = 0;
for (const [id, group] of feedIdMap.entries()) {
  dupFeedIdCount++;
  foundAny = true;
  console.log(`⚠️  ID de feed duplicado: "${id}"`);
  for (const { site, feed } of group) {
    console.log(`   • En sitio [${site.id}] "${site.name}" — ${feed.rss_url}`);
    if (verbose) {
      console.log(`     Sitio  ${DB_ABS}:${lineIndex.get(site.id) ?? 1}`);
      console.log(`     Feed   ${DB_ABS}:${lineIndex.get(feed.id) ?? 1}`);
    }
  }
  console.log();
}
if (dupFeedIdCount === 0) console.log('✅ No se encontraron IDs de feed duplicados.\n');
report.intra.dupFeedIdCount = dupFeedIdCount;

// ─── 6 & 7. Intra-watchlist ──────────────────────────────────────────────────
let wlDupIdCount = 0;
let wlDupUrlCount = 0;
let wlDupRootCount = 0;
let wlDupFeedIdCount = 0;
let wlDupFeedUrlCount = 0;
const wlDupIdKeys = [];
const wlDupUrlKeys = [];
const wlIntraDrop = new Set();
const wlFeedDrop = new Map();
let wlFeedDrops = 0;

if (!wlAvailable) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  🔍 Duplicados dentro de watchlist — omitido');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('⚠️  watchlist.json no encontrado o ilegible — se omite el chequeo intra-watchlist.\n');
} else {
  const wlLineIndexAll = buildLineIndexAll(wlRawText);
  const wlPos = new Map(wlSites.map((s, i) => [s, i]));
  const wlIndexById = new Map();
  wlSites.forEach((s, i) => {
    if (!wlIndexById.has(s.id)) wlIndexById.set(s.id, []);
    wlIndexById.get(s.id).push(i);
  });

  const wlPosOf = s => wlPos.get(s) ?? -1;
  const wlLink = s => {
    if (!verbose) return;
    const lines = wlLineIndexAll.get(s.id) ?? [];
    const occ = (wlIndexById.get(s.id) ?? []).indexOf(wlPosOf(s));
    console.log(`     📎 ${WL_ABS}:${lines[occ] ?? lines[0] ?? 1}`);
  };
  const wlSiteLine = s => `#${wlPosOf(s)} [${s.id}] ${s.name} — ${s.url} | ${(s.feeds ?? []).length} feeds`;

  console.log('═══════════════════════════════════════════════════════');
  console.log('  🔍 Buscando duplicados dentro de watchlist.json');
  console.log('═══════════════════════════════════════════════════════\n');

  // 6a
  console.log('── 6a. IDs de sitio duplicados ────────────────────────\n');
  for (const [id, group] of wlIntra.siteIdMap.entries()) {
    wlDupIdCount++;
    foundAny = true;
    wlDupIdKeys.push(id);
    console.log(`⚠️  ID de sitio duplicado en watchlist: "${id}" (${group.length} entradas)`);
    for (const s of group) {
      console.log(`   • ${wlSiteLine(s)}`);
      wlLink(s);
    }
    console.log();
  }
  if (wlDupIdCount === 0) console.log('✅ No se encontraron IDs de sitio duplicados en watchlist.\n');

  // 6b
  console.log('── 6b. Sitios con la misma URL ────────────────────────\n');
  for (const [key, group] of wlIntra.siteUrlMap.entries()) {
    wlDupUrlCount++;
    foundAny = true;
    wlDupUrlKeys.push(key);
    console.log(`⚠️  URL duplicada en watchlist: "${key}" (${group.length} entradas)`);
    for (const s of group) {
      console.log(`   • ${wlSiteLine(s)}`);
      wlLink(s);
    }
    console.log();
  }
  if (wlDupUrlCount === 0) console.log('✅ No se encontraron URLs de sitio duplicadas en watchlist.\n');

  // 6c
  console.log('── 6c. Mismo dominio raíz, URL distinta (sospechoso) ─\n');
  for (const [domain, group] of wlIntra.rootDomainMap.entries()) {
    wlDupRootCount++;
    foundAny = true;
    console.log(`⚠️  Posibles duplicados en watchlist — dominio raíz: "${domain}"`);
    for (const s of group) {
      console.log(`   • ${wlSiteLine(s)}`);
      wlLink(s);
    }
    console.log();
  }
  if (wlDupRootCount === 0) console.log('✅ No hay dominios repetidos con URL distinta en watchlist.\n');

  // 7
  console.log('── 7. Feeds duplicados dentro de watchlist ────────────\n');
  wlDupFeedIdCount = wlIntra.feedIdMap.size;
  wlDupFeedUrlCount = wlIntra.feedUrlMap.size;
  if (wlDupFeedIdCount === 0 && wlDupFeedUrlCount === 0) {
    console.log('✅ No se encontraron feeds duplicados en watchlist.\n');
  } else {
    foundAny = true;
    for (const [id, group] of [...wlIntra.feedIdMap.entries()].slice(0, FEED_LIMIT)) {
      console.log(`⚠️  ID de feed duplicado en watchlist: "${id}" (${group.length} entradas)`);
      for (const { site, feed } of group) {
        console.log(`   • #${wlPosOf(site)} [${site.id}] ${feed.rss_url} | ${feed.status}`);
      }
      console.log();
    }
    if (wlDupFeedIdCount > FEED_LIMIT) console.log(`   ... y ${wlDupFeedIdCount - FEED_LIMIT} IDs de feed más (usa --all).\n`);
    for (const [key, group] of [...wlIntra.feedUrlMap.entries()].slice(0, FEED_LIMIT)) {
      console.log(`⚠️  rss_url duplicada en watchlist: "${key}" (${group.length} entradas)`);
      for (const { site, feed } of group) {
        console.log(`   • #${wlPosOf(site)} [${site.id}] feed [${feed.id}] | ${feed.status}`);
      }
      console.log();
    }
    if (wlDupFeedUrlCount > FEED_LIMIT) console.log(`   ... y ${wlDupFeedUrlCount - FEED_LIMIT} rss_url más (usa --all).\n`);
  }

  // Índices que --fix eliminará: se conserva la primera aparición de cada id/URL
  const seenWlId = new Set();
  const seenWlUrl = new Set();
  wlSites.forEach((s, i) => {
    const idKey = s.id;
    const urlKey = normalizeUrl(s.url);
    if (seenWlId.has(idKey) || seenWlUrl.has(urlKey)) {
      wlIntraDrop.add(i);
    } else {
      seenWlId.add(idKey);
      seenWlUrl.add(urlKey);
    }
  });

  // Feeds repetidos dentro de una misma entrada (mismo rss_url o mismo feed.id):
  // artefacto de validaciones encadenadas, no un sitio duplicado.
  wlSites.forEach((s, i) => {
    const seen = new Set();
    (s.feeds ?? []).forEach((f, j) => {
      const urlKey = normalizeFeedUrl(f.rss_url ?? '');
      const idKey = `id:${f.id}`;
      if (seen.has(urlKey) || seen.has(idKey)) {
        if (!wlFeedDrop.has(i)) wlFeedDrop.set(i, new Set());
        wlFeedDrop.get(i).add(j);
        wlFeedDrops++;
      } else {
        seen.add(urlKey);
        seen.add(idKey);
      }
    });
  });
  report.wlIntra = {
    dupSiteIdCount: wlDupIdCount,
    dupSiteUrlCount: wlDupUrlCount,
    dupRootDomainCount: wlDupRootCount,
    dupFeedIdCount: wlDupFeedIdCount,
    dupFeedUrlCount: wlDupFeedUrlCount,
    siteIds: wlDupIdKeys,
    siteUrls: wlDupUrlKeys,
    removableIndices: [...wlIntraDrop].sort((a, b) => a - b),
    removableFeeds: [...wlFeedDrop].map(([siteIndex, feeds]) => ({
      siteIndex,
      feedIndices: [...feeds].sort((a, b) => a - b),
    })),
  };
}

// ─── 8 & 9. Cross-file duplicates ────────────────────────────────────────────
let crossSiteIdCount = 0;
let crossSiteUrlCount = 0;
let crossRootDomainCount = 0;
let crossFeedIdCount = 0;
let crossFeedUrlCount = 0;

let crossIds = [];
let crossUrlKeys = [];
let crossFeedIds = [];
let crossRssKeys = [];
let dbSiteById, wlSiteById, dbUrlMap, wlUrlMap, dbRssMap, wlRssMap;

if (!wlAvailable) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  🔀 Cruce database ↔ watchlist — omitido');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('⚠️  watchlist.json no encontrado o ilegible — se omite el chequeo cruzado.\n');
} else {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  🔀 Cruce database ↔ watchlist');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log(`  DB: ${sites.length} sitios — WL: ${wlSites.length} sitios\n`);

  // 8a
  console.log('── 8a. Sitios con el mismo ID en ambos archivos ──────\n');
  ({ dbSiteById, wlSiteById } = cross);
  crossIds = cross.siteIds;
  crossSiteIdCount = crossIds.length;
  report.cross.siteIds = crossIds;
  if (crossIds.length === 0) {
    console.log('✅ No hay site IDs que vivan en ambos archivos.\n');
  } else {
    foundAny = true;
    const toShow = crossIds.slice(0, SITE_LIMIT);
    for (const id of toShow) {
      const dbSite = dbSiteById.get(id);
      const wlSite = wlSiteById.get(id);
      const sameUrl = normalizeUrl(dbSite.url) === normalizeUrl(wlSite.url);
      const tag = sameUrl ? 'duplicado exacto' : '⚠️ URL distinta — revisar';
      console.log(`⚠️  ID duplicado cruzado: "${id}" — ${tag}`);
      console.log(`   • DB  [${dbSite.id}] ${dbSite.name} — ${dbSite.url}`);
      if (verbose) console.log(fileLink(dbSite.id, lineIndex, DB_ABS));
      console.log(`   • WL  [${wlSite.id}] ${wlSite.name} — ${wlSite.url}`);
      if (verbose) console.log(fileLink(wlSite.id, wlLineIndex, WL_ABS));
      console.log(`     → Acción: elimina la entrada de watchlist.json (ya está en database)\n`);
    }
    if (crossIds.length > SITE_LIMIT) {
      console.log(`   ... y ${crossIds.length - SITE_LIMIT} más ocultos. Usa --all o --limit <N> para ver todos, o --out para guardar reporte.\n`);
    }
  }

  // 8b
  console.log('── 8b. Sitios con la misma URL en ambos archivos ─────\n');
  dbUrlMap = cross.dbUrlMap;
  wlUrlMap = cross.wlUrlMap;
  crossUrlKeys = cross.siteUrls;
  crossSiteUrlCount = crossUrlKeys.length;
  report.cross.siteUrls = crossUrlKeys;
  if (crossUrlKeys.length === 0) {
    console.log('✅ No hay site URLs que vivan en ambos archivos.\n');
  } else {
    foundAny = true;
    const toShow = crossUrlKeys.slice(0, SITE_LIMIT);
    for (const key of toShow) {
      console.log(`⚠️  URL duplicada cruzada: "${key}"`);
      for (const s of dbUrlMap.get(key)) {
        console.log(`   • DB  [${s.id}] ${s.name} — ${s.url}`);
        if (verbose) console.log(fileLink(s.id, lineIndex, DB_ABS));
      }
      for (const s of wlUrlMap.get(key)) {
        console.log(`   • WL  [${s.id}] ${s.name} — ${s.url}`);
        if (verbose) console.log(fileLink(s.id, wlLineIndex, WL_ABS));
      }
      console.log();
    }
    if (crossUrlKeys.length > SITE_LIMIT) {
      console.log(`   ... y ${crossUrlKeys.length - SITE_LIMIT} más ocultos. Usa --all o --limit <N>.\n`);
    }
  }

  // 8c
  console.log('── 8c. Mismo dominio raíz, URL distinta (sospechoso) ─\n');
  const { dbRootMap, wlRootMap } = cross;
  const crossRootDomains = cross.rootDomains;
  const crossRootPrinted = crossRootDomains.length;
  for (const domain of crossRootDomains.slice(0, SITE_LIMIT)) {
    foundAny = true;
    console.log(`⚠️  Dominio cruzado con URL distinta: "${domain}"`);
    for (const s of dbRootMap.get(domain)) {
      console.log(`   • DB  [${s.id}] ${s.name} — ${s.url}`);
      if (verbose) console.log(fileLink(s.id, lineIndex, DB_ABS));
    }
    for (const s of wlRootMap.get(domain)) {
      console.log(`   • WL  [${s.id}] ${s.name} — ${s.url}`);
      if (verbose) console.log(fileLink(s.id, wlLineIndex, WL_ABS));
    }
    console.log();
  }
  crossRootDomainCount = crossRootPrinted;
  report.cross.rootDomains = crossRootDomains;
  if (crossRootPrinted === 0) console.log('✅ No hay dominios con URL distinta entre archivos.\n');
  else if (crossRootPrinted > SITE_LIMIT) {
    console.log(`   ... y ${crossRootPrinted - SITE_LIMIT} más ocultos. Usa --all.\n`);
  }

  // 9a
  console.log('── 9a. Feeds con el mismo ID en ambos archivos ───────\n');
  const { dbFeedById, wlFeedById } = cross;
  crossFeedIds = cross.feedIds;
  crossFeedIdCount = crossFeedIds.length;
  report.cross.feedIds = crossFeedIds;
  if (crossFeedIds.length === 0) {
    console.log('✅ No hay feed IDs que vivan en ambos archivos.\n');
  } else {
    foundAny = true;
    const toShow = crossFeedIds.slice(0, FEED_LIMIT);
    for (const id of toShow) {
      const dbEntry = dbFeedById.get(id);
      const wlEntry = wlFeedById.get(id);
      console.log(`⚠️  Feed ID duplicado cruzado: "${id}"`);
      console.log(`   • DB  [${dbEntry.site.id}] ${dbEntry.feed.rss_url} | ${dbEntry.feed.status}`);
      if (verbose) console.log(`     ${DB_ABS}:${lineIndex.get(id) ?? 1} (DB)`);
      console.log(`   • WL  [${wlEntry.site.id}] ${wlEntry.feed.rss_url} | ${wlEntry.feed.status}`);
      if (verbose) console.log(`     ${WL_ABS}:${wlLineIndex.get(id) ?? 1} (WL)`);
    }
    if (crossFeedIds.length > FEED_LIMIT) {
      console.log(`\n   ... y ${crossFeedIds.length - FEED_LIMIT} más ocultos. Usa --all o --limit <N>. Total: ${crossFeedIds.length}\n`);
      if (verbose && doAll) {
        for (const id of crossFeedIds.slice(FEED_LIMIT)) {
          const dbEntry = dbFeedById.get(id);
          const wlEntry = wlFeedById.get(id);
          console.log(`⚠️  Feed ID duplicado cruzado: "${id}"`);
          console.log(`   • DB  [${dbEntry.site.id}] ${dbEntry.feed.rss_url}`);
          console.log(`   • WL  [${wlEntry.site.id}] ${wlEntry.feed.rss_url}`);
        }
        console.log();
      }
    } else {
      console.log();
    }
  }

  // 9b
  console.log('── 9b. Feeds con el mismo rss_url en ambos archivos ──\n');
  dbRssMap = cross.dbRssMap;
  wlRssMap = cross.wlRssMap;
  crossRssKeys = cross.feedUrls;
  crossFeedUrlCount = crossRssKeys.length;
  report.cross.rssUrls = crossRssKeys;
  if (crossRssKeys.length === 0) {
    console.log('✅ No hay rss_url que vivan en ambos archivos.\n');
  } else {
    foundAny = true;
    const toShow = crossRssKeys.slice(0, FEED_LIMIT);
    for (const key of toShow) {
      console.log(`⚠️  rss_url duplicada cruzada: "${key}"`);
      for (const { site, feed } of dbRssMap.get(key)) {
        console.log(`   • DB  Feed [${feed.id}] en [${site.id}] — ${feed.rss_url} | ${feed.status}`);
        if (verbose) console.log(`     ${DB_ABS}:${lineIndex.get(feed.id) ?? 1}`);
      }
      for (const { site, feed } of wlRssMap.get(key)) {
        console.log(`   • WL  Feed [${feed.id}] en [${site.id}] — ${feed.rss_url} | ${feed.status}`);
        if (verbose) console.log(`     ${WL_ABS}:${wlLineIndex.get(feed.id) ?? 1}`);
      }
      console.log();
    }
    if (crossRssKeys.length > FEED_LIMIT) {
      console.log(`   ... y ${crossRssKeys.length - FEED_LIMIT} más ocultos. Usa --all. Total: ${crossRssKeys.length}\n`);
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════');
console.log('  📊 Resumen');
console.log('═══════════════════════════════════════════════════════\n');
console.log(`  Sitios analizados (DB) : ${sites.length}`);
if (wlAvailable) console.log(`  Sitios analizados (WL) : ${wlSites.length}`);
console.log(`  Total feeds (DB)       : ${sites.reduce((n, s) => n + (s.feeds?.length ?? 0), 0)}`);
if (wlAvailable) console.log(`  Total feeds (WL)       : ${wlSites.reduce((n, s) => n + (s.feeds?.length ?? 0), 0)}`);
console.log(`  ── Intra-DB ─────────────────────────────────`);
console.log(`  URLs de sitio dupl.   : ${dupSiteUrlCount}`);
console.log(`  rss_url duplicadas     : ${dupFeedUrlCount}`);
console.log(`  Dominios raíz dupl.   : ${dupRootCount}`);
console.log(`  IDs de sitio dupl.    : ${dupIdCount}`);
console.log(`  IDs de feed dupl.     : ${dupFeedIdCount}`);
if (wlAvailable) {
  console.log(`  ── Intra-WL ─────────────────────────────────`);
  console.log(`  IDs de sitio dupl.    : ${wlDupIdCount}`);
  console.log(`  URLs de sitio dupl.   : ${wlDupUrlCount}`);
  console.log(`  Dominios raíz dupl.   : ${wlDupRootCount}`);
  console.log(`  IDs de feed dupl.     : ${wlDupFeedIdCount}`);
  console.log(`  rss_url duplicadas    : ${wlDupFeedUrlCount}`);
  console.log(`  Entradas removibles   : ${wlIntraDrop.size}  (conserva la 1ª aparición)`);
  console.log(`  Feeds repetidos remov.: ${wlFeedDrops}  (mismo rss_url/ID dentro de una entrada)`);
  console.log(`  ── Cross DB ↔ WL ────────────────────────────`);
  console.log(`  Site IDs cruzados     : ${crossSiteIdCount}`);
  console.log(`  Site URLs cruzadas    : ${crossSiteUrlCount}`);
  console.log(`  Dominios cruzados*    : ${crossRootDomainCount}  (*misma raíz, URL distinta)`);
  console.log(`  Feed IDs cruzados     : ${crossFeedIdCount}`);
  console.log(`  rss_url cruzadas      : ${crossFeedUrlCount}`);
}
console.log();

if (!foundAny) {
  console.log('✅ No se encontraron duplicados.\n');
} else {
  console.log('⚠️  Se encontraron posibles duplicados. Revísalos manualmente.\n');
  if (crossSiteIdCount > 0 || crossSiteUrlCount > 0 || wlIntraDrop.size > 0) {
    console.log('💡 Duplicados que --fix puede limpiar: entradas repetidas dentro de watchlist.json');
    console.log('   y sitios de watchlist que ya viven en feeds-database.json.');
    console.log('   → Preview: pnpm check:duplicates -- --fix --dry-run');
    console.log('   → Fix:     pnpm check:duplicates -- --fix --yes\n');
  }
  if (!verbose && (crossFeedIdCount > FEED_LIMIT || crossSiteIdCount > SITE_LIMIT)) {
    console.log('💡 Tip: usa --verbose (-v) para links clicables, --all para ver todo sin recorte,');
    console.log('        --limit <N> para ajustar, --out <archivo> o --json <archivo> para guardar reporte completo.\n');
  } else if (!verbose) {
    console.log('💡 Tip: usa --verbose (-v) para ver links clicables a cada entrada.\n');
  }
  if (outFile) {
    // restore original log before writing file
    console.log = origLog;
  }
  // keep exit code 1 for CI (unless fix will resolve)
  if (!doFix) process.exitCode = 1;
}

// ─── JSON report ──────────────────────────────────────────────────────────────
if (jsonFile) {
  try {
    const jsonReport = {
      generatedAt: new Date().toISOString(),
      dbFile: DB_FILE,
      wlFile: WL_FILE,
      counts: {
        dbSites: sites.length,
        wlSites: wlSites.length,
        dupSiteUrlCount,
        dupFeedUrlCount,
        dupRootCount,
        dupIdCount,
        dupFeedIdCount,
        wlDupIdCount,
        wlDupUrlCount,
        wlDupRootCount,
        wlDupFeedIdCount,
        wlDupFeedUrlCount,
        wlRemovableEntries: wlIntraDrop.size,
        crossSiteIdCount,
        crossSiteUrlCount,
        crossRootDomainCount,
        crossFeedIdCount,
        crossFeedUrlCount,
      },
      crossIds,
      crossUrlKeys,
      crossFeedIds,
      crossRssKeys,
      wlIntra: report.wlIntra ?? null,
    };
    writeFileSync(jsonFile, JSON.stringify(jsonReport, null, 2) + '\n', 'utf-8');
    console.log(`📄 Reporte JSON guardado en ${resolve(jsonFile)}\n`);
  } catch (e) {
    console.error(`❌ No se pudo escribir JSON: ${e.message}`);
  }
}

// ─── Out file ─────────────────────────────────────────────────────────────────
if (outFile) {
  try {
    writeFileSync(outFile, capturedLines.join('\n') + '\n', 'utf-8');
    console.log(`📄 Reporte guardado en ${resolve(outFile)} (${capturedLines.length} líneas)\n`);
  } catch (e) {
    console.error(`❌ No se pudo escribir reporte: ${e.message}`);
  }
}

// ─── Fix (prune duplicates) ───────────────────────────────────────────────────
async function runFix() {
  if (!doFix) return;
  if (!wlAvailable) {
    console.error('❌ watchlist.json no disponible — nada que limpiar.');
    process.exit(1);
  }

  // 1) Duplicados internos de watchlist.json (mismo id o misma URL).
  //    Se conserva la primera aparición; el resto se elimina.
  const intraEntries = [...wlIntraDrop].sort((a, b) => a - b)
    .map(index => ({ index, site: wlSites[index] }));

  const keptIndexFor = (index) => {
    const s = wlSites[index];
    for (let j = 0; j < index; j++) {
      const prev = wlSites[j];
      if (prev.id === s.id || normalizeUrl(prev.url) === normalizeUrl(s.url)) return j;
    }
    return -1;
  };

  // 2) Duplicados cruzados DB ↔ watchlist según --keep
  const crossIdsToRemove = new Set();
  let sourceLabel = '';
  let targetLabel = '';

  if (keep === 'db') {
    const dbIdSet = new Set(sites.map(s => s.id));
    const dbUrlSet = new Set(sites.map(s => normalizeUrl(s.url)));
    for (const s of wlSites) {
      if (dbIdSet.has(s.id) || dbUrlSet.has(normalizeUrl(s.url))) crossIdsToRemove.add(s.id);
    }
    sourceLabel = 'DB';
    targetLabel = 'watchlist.json';
  } else {
    const wlIdSet = new Set(wlSites.map(s => s.id));
    const wlUrlSet = new Set(wlSites.map(s => normalizeUrl(s.url)));
    for (const s of sites) {
      if (wlIdSet.has(s.id) || wlUrlSet.has(normalizeUrl(s.url))) crossIdsToRemove.add(s.id);
    }
    sourceLabel = 'WL';
    targetLabel = 'feeds-database.json';
  }

  if (intraEntries.length === 0 && crossIdsToRemove.size === 0 && wlFeedDrops === 0) {
    console.log('✅ No hay sitios para eliminar (ni duplicados internos de watchlist ni cruzados).\n');
    return;
  }

  const willWriteWl = intraEntries.length > 0 || wlFeedDrops > 0
    || (keep === 'db' && crossIdsToRemove.size > 0);
  const wlFiltered = wlSites
    .map((s, i) => {
      const dropFeeds = wlFeedDrop.get(i);
      if (!dropFeeds) return s;
      return { ...s, feeds: (s.feeds ?? []).filter((_, j) => !dropFeeds.has(j)) };
    })
    .filter((s, i) => !wlIntraDrop.has(i) && !(keep === 'db' && crossIdsToRemove.has(s.id)));

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  🧹 Fix: limpiar duplicados (keep=${keep})`);
  console.log('═══════════════════════════════════════════════════════\n');

  if (intraEntries.length > 0) {
    console.log(`  Duplicados internos de watchlist.json: ${intraEntries.length} entradas (se conserva la primera aparición):`);
    for (const { index, site } of intraEntries.slice(0, 50)) {
      const keepIdx = keptIndexFor(index);
      console.log(`   • #${index} [${site.id}] ${site.url} → dup de #${keepIdx}`);
    }
    if (intraEntries.length > 50) console.log(`   ... y ${intraEntries.length - 50} más`);
    console.log();
  }

  if (wlFeedDrops > 0) {
    console.log(`  Feeds repetidos dentro de una entrada: ${wlFeedDrops} (se conserva el primero):`);
    for (const [siteIndex, feedIndices] of [...wlFeedDrop.entries()].slice(0, 50)) {
      const site = wlSites[siteIndex];
      const urls = [...feedIndices].map(j => site.feeds[j].rss_url);
      console.log(`   • #${siteIndex} [${site.id}] ${urls.join(', ')}`);
    }
    if (wlFeedDrop.size > 50) console.log(`   ... y ${wlFeedDrop.size - 50} entradas más`);
    console.log();
  }

  if (crossIdsToRemove.size > 0) {
    console.log(`  Cruzados DB↔WL: ${crossIdsToRemove.size} sitios se eliminarán de ${targetLabel} (conservando ${sourceLabel}):`);
    for (const id of [...crossIdsToRemove].sort().slice(0, 50)) {
      console.log(`   • ${id}`);
    }
    if (crossIdsToRemove.size > 50) console.log(`   ... y ${crossIdsToRemove.size - 50} más`);
    console.log();
  }

  if (dryRun) {
    console.log('🔍 --dry-run: no se escribió ningún archivo. Quita --dry-run y añade --yes para aplicar.\n');
    process.exitCode = 1;
    return;
  }

  const sitesDelta = willWriteWl ? wlSites.length - wlFiltered.length : 0;
  const label = `${sitesDelta} sitio(s) de watchlist y ${wlFeedDrops} feed(s) repetido(s)`
    + (keep === 'watchlist' ? `, y ${crossIdsToRemove.size} sitio(s) de la DB` : '');
  const ok = await askConfirm(`¿Aplicar la limpieza (${label})? [y/N]: `);
  if (!ok) {
    console.log('❌ Cancelado.\n');
    return;
  }

  if (willWriteWl) {
    // Preserve original format: array JSON
    writeFileSync(WL_FILE, JSON.stringify(wlFiltered, null, 2) + '\n', 'utf-8');
    console.log(`✅ ${WL_FILE}: ${wlSites.length} → ${wlFiltered.length} sitios`);
  }

  if (keep === 'watchlist' && crossIdsToRemove.size > 0) {
    const filteredSites = sites.filter(s => !crossIdsToRemove.has(s.id));
    db.sites = filteredSites;
    // Recalculate total_feeds
    try {
      const { recalculateTotalFeeds } = await import('../../lib/feed-utils.js');
      recalculateTotalFeeds(db);
    } catch {
      db.total_feeds = db.sites.reduce((n, s) => n + s.feeds.filter(f => f.status === 'active' && f.verified).length, 0);
      db.last_updated = new Date().toISOString();
    }
    writeFileSync(DB_FILE, JSON.stringify(db, null, 2) + '\n', 'utf-8');
    console.log(`✅ ${DB_FILE}: ${sites.length} → ${filteredSites.length} sitios — total_feeds: ${db.total_feeds}\n`);
  } else if (willWriteWl) {
    console.log();
  }
  process.exitCode = 0;
}

await runFix();
