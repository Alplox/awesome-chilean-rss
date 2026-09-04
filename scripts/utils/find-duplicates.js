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
 *  Cross-file (feeds-database.json ↔ watchlist.json):
 *   6. Sitios que viven en ambos archivos
 *      6a. Mismo site.id en ambos
 *      6b. Misma site.url normalizada en ambos
 *      6c. Mismo dominio raíz con URL distinta (sospechoso)
 *   7. Feeds que viven en ambos archivos
 *      7a. Mismo feed.id en ambos
 *      7b. Mismo rss_url en ambos
 *
 * Esto detecta promociones incompletas: sitios movidos de watchlist a
 * database sin eliminar la entrada original de watchlist.
 *
 * Uso:
 *   node scripts/utils/find-duplicates.js
 *   node scripts/utils/find-duplicates.js --verbose        (links clicables)
 *   node scripts/utils/find-duplicates.js --all            (sin recorte)
 *   node scripts/utils/find-duplicates.js --limit 20       (límite por sección)
 *   node scripts/utils/find-duplicates.js --out reporte.txt (guarda reporte)
 *   node scripts/utils/find-duplicates.js --json reporte.json
 *   node scripts/utils/find-duplicates.js --fix --dry-run  (preview limpieza)
 *   node scripts/utils/find-duplicates.js --fix --yes      (elimina de watchlist, keep DB)
 *   node scripts/utils/find-duplicates.js --fix --keep watchlist --yes
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline';

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
Uso: node scripts/utils/find-duplicates.js [opciones]

Opciones:
  --verbose, -v        Links clicables archivo:línea
  --all                Muestra todo sin recortar (sin límite)
  --limit <N>          Límite de items por sección (default 15 sitios / 10 feeds)
  --out <archivo>      Guarda el reporte completo en un archivo (texto)
  --json <archivo>     Guarda reporte machine-readable en JSON
  --fix                Elimina duplicados cruzados (default: keep DB, borra de watchlist)
  --keep <db|watchlist> Qué archivo conservar al hacer --fix (default: db)
  --dry-run            Preview de --fix sin escribir archivos
  --yes, -y            No pide confirmación para --fix
  --help, -h           Esta ayuda

Ejemplos:
  node scripts/utils/find-duplicates.js --fix --dry-run
  node scripts/utils/find-duplicates.js --fix --yes
  node scripts/utils/find-duplicates.js --all --out reporte.txt
  node scripts/utils/find-duplicates.js --json dupes.json
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

function fileLink(id, lineIndex, fileAbs) {
  if (!verbose) return '';
  const line = lineIndex.get(id) ?? 1;
  return `     📎 ${fileAbs}:${line}`;
}

function normalizeUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.hostname.replace(/^www\./, '').toLowerCase()
      + url.pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(urlStr ?? '').toLowerCase().trim();
  }
}

function getRootDomain(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(urlStr ?? '').toLowerCase().trim();
  }
}

function normalizeFeedUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.hostname.replace(/^www\./, '').toLowerCase()
      + url.pathname.replace(/\/$/, '').toLowerCase()
      + (url.search || '');
  } catch {
    return String(urlStr ?? '').toLowerCase().trim();
  }
}

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

// ─── 1. Duplicate site URLs ───────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════');
console.log('  🔍 Buscando duplicados en feeds-database.json');
console.log('═══════════════════════════════════════════════════════\n');
console.log('── 1. Sitios con la misma URL (site.url) ──────────────\n');
const siteUrlMap = new Map();
for (const site of sites) {
  const key = normalizeUrl(site.url);
  if (!siteUrlMap.has(key)) siteUrlMap.set(key, []);
  siteUrlMap.get(key).push(site);
}
let dupSiteUrlCount = 0;
for (const [key, group] of siteUrlMap.entries()) {
  if (group.length > 1) {
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
}
if (dupSiteUrlCount === 0) console.log('✅ No se encontraron URLs de sitio duplicadas.\n');
report.intra.dupSiteUrlCount = dupSiteUrlCount;

// ─── 2. Duplicate feed RSS URLs ───────────────────────────────────────────────
console.log('── 2. Feeds con el mismo rss_url (global) ─────────────\n');
const feedUrlMap = new Map();
for (const site of sites) {
  for (const feed of site.feeds) {
    const key = normalizeFeedUrl(feed.rss_url);
    if (!feedUrlMap.has(key)) feedUrlMap.set(key, []);
    feedUrlMap.get(key).push({ site, feed });
  }
}
let dupFeedUrlCount = 0;
for (const [key, group] of feedUrlMap.entries()) {
  if (group.length > 1) {
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
}
if (dupFeedUrlCount === 0) console.log('✅ No se encontraron rss_url de feed duplicadas.\n');
report.intra.dupFeedUrlCount = dupFeedUrlCount;

// ─── 3. Possible duplicate sites (same root domain) ──────────────────────────
console.log('── 3. Posibles sitios duplicados (mismo dominio raíz) ──\n');
const rootDomainMap = new Map();
for (const site of sites) {
  const key = getRootDomain(site.url);
  if (!rootDomainMap.has(key)) rootDomainMap.set(key, []);
  rootDomainMap.get(key).push(site);
}
let dupRootCount = 0;
for (const [domain, group] of rootDomainMap.entries()) {
  if (group.length > 1) {
    const uniqueNormalized = new Set(group.map(s => normalizeUrl(s.url)));
    if (uniqueNormalized.size > 1) {
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
  }
}
if (dupRootCount === 0) console.log('✅ No se encontraron sitios con el mismo dominio raíz.\n');
report.intra.dupRootCount = dupRootCount;

// ─── 4. Duplicate site IDs ────────────────────────────────────────────────────
console.log('── 4. IDs de sitio duplicados ──────────────────────────\n');
const siteIdMap = new Map();
for (const site of sites) {
  if (!siteIdMap.has(site.id)) siteIdMap.set(site.id, []);
  siteIdMap.get(site.id).push(site);
}
let dupIdCount = 0;
for (const [id, group] of siteIdMap.entries()) {
  if (group.length > 1) {
    dupIdCount++;
    foundAny = true;
    console.log(`⚠️  ID de sitio duplicado: "${id}"`);
    for (const s of group) {
      console.log(`   • ${s.name} — ${s.url}`);
      if (verbose) console.log(fileLink(s.id, lineIndex, DB_ABS));
    }
    console.log();
  }
}
if (dupIdCount === 0) console.log('✅ No se encontraron IDs de sitio duplicados.\n');
report.intra.dupIdCount = dupIdCount;

// ─── 5. Duplicate feed IDs ────────────────────────────────────────────────────
console.log('── 5. IDs de feed duplicados (global) ──────────────────\n');
const feedIdMap = new Map();
for (const site of sites) {
  for (const feed of site.feeds) {
    if (!feedIdMap.has(feed.id)) feedIdMap.set(feed.id, []);
    feedIdMap.get(feed.id).push({ site, feed });
  }
}
let dupFeedIdCount = 0;
for (const [id, group] of feedIdMap.entries()) {
  if (group.length > 1) {
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
}
if (dupFeedIdCount === 0) console.log('✅ No se encontraron IDs de feed duplicados.\n');
report.intra.dupFeedIdCount = dupFeedIdCount;

// ─── 6 & 7. Cross-file duplicates ────────────────────────────────────────────
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

  // 6a
  console.log('── 6a. Sitios con el mismo ID en ambos archivos ──────\n');
  dbSiteById = new Map(sites.map(s => [s.id, s]));
  wlSiteById = new Map(wlSites.map(s => [s.id, s]));
  crossIds = [...dbSiteById.keys()].filter(id => wlSiteById.has(id));
  crossSiteIdCount = crossIds.length;
  report.cross.siteIds = crossIds;
  if (crossIds.length === 0) {
    console.log('✅ No hay site IDs que vivan en ambos archivos.\n');
  } else {
    foundAny = true;
    crossIds.sort();
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

  // 6b
  console.log('── 6b. Sitios con la misma URL en ambos archivos ─────\n');
  dbUrlMap = new Map();
  for (const s of sites) {
    const k = normalizeUrl(s.url);
    if (!dbUrlMap.has(k)) dbUrlMap.set(k, []);
    dbUrlMap.get(k).push(s);
  }
  wlUrlMap = new Map();
  for (const s of wlSites) {
    const k = normalizeUrl(s.url);
    if (!wlUrlMap.has(k)) wlUrlMap.set(k, []);
    wlUrlMap.get(k).push(s);
  }
  crossUrlKeys = [...dbUrlMap.keys()].filter(k => wlUrlMap.has(k)).sort();
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

  // 6c
  console.log('── 6c. Mismo dominio raíz, URL distinta (sospechoso) ─\n');
  const dbRootMap = new Map();
  for (const s of sites) {
    const k = getRootDomain(s.url);
    if (!dbRootMap.has(k)) dbRootMap.set(k, []);
    dbRootMap.get(k).push(s);
  }
  const wlRootMap = new Map();
  for (const s of wlSites) {
    const k = getRootDomain(s.url);
    if (!wlRootMap.has(k)) wlRootMap.set(k, []);
    wlRootMap.get(k).push(s);
  }
  let crossRootPrinted = 0;
  const crossRootDomains = [];
  for (const domain of [...dbRootMap.keys()].filter(k => wlRootMap.has(k)).sort()) {
    const dbGroup = dbRootMap.get(domain);
    const wlGroup = wlRootMap.get(domain);
    const dbNormSet = new Set(dbGroup.map(s => normalizeUrl(s.url)));
    const wlNormSet = new Set(wlGroup.map(s => normalizeUrl(s.url)));
    const hasExactOverlap = [...dbNormSet].some(u => wlNormSet.has(u));
    if (hasExactOverlap) continue;
    crossRootDomains.push(domain);
    crossRootPrinted++;
    foundAny = true;
    if (crossRootPrinted <= SITE_LIMIT) {
      console.log(`⚠️  Dominio cruzado con URL distinta: "${domain}"`);
      for (const s of dbGroup) {
        console.log(`   • DB  [${s.id}] ${s.name} — ${s.url}`);
        if (verbose) console.log(fileLink(s.id, lineIndex, DB_ABS));
      }
      for (const s of wlGroup) {
        console.log(`   • WL  [${s.id}] ${s.name} — ${s.url}`);
        if (verbose) console.log(fileLink(s.id, wlLineIndex, WL_ABS));
      }
      console.log();
    }
  }
  crossRootDomainCount = crossRootPrinted;
  report.cross.rootDomains = crossRootDomains;
  if (crossRootPrinted === 0) console.log('✅ No hay dominios con URL distinta entre archivos.\n');
  else if (crossRootPrinted > SITE_LIMIT) {
    console.log(`   ... y ${crossRootPrinted - SITE_LIMIT} más ocultos. Usa --all.\n`);
  }

  // 7a
  console.log('── 7a. Feeds con el mismo ID en ambos archivos ───────\n');
  const dbFeedById = new Map();
  for (const s of sites) for (const f of (s.feeds ?? [])) dbFeedById.set(f.id, { site: s, feed: f });
  const wlFeedById = new Map();
  for (const s of wlSites) for (const f of (s.feeds ?? [])) wlFeedById.set(f.id, { site: s, feed: f });
  crossFeedIds = [...dbFeedById.keys()].filter(k => wlFeedById.has(k)).sort();
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

  // 7b
  console.log('── 7b. Feeds con el mismo rss_url en ambos archivos ──\n');
  function buildRssMap(siteList) {
    const m = new Map();
    for (const s of siteList) for (const f of (s.feeds ?? [])) if (f.rss_url) {
      const k = normalizeFeedUrl(f.rss_url);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ site: s, feed: f });
    }
    return m;
  }
  dbRssMap = buildRssMap(sites);
  wlRssMap = buildRssMap(wlSites);
  crossRssKeys = [...dbRssMap.keys()].filter(k => wlRssMap.has(k)).sort();
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
  if (crossSiteIdCount > 0 || crossSiteUrlCount > 0) {
    console.log('💡 Cruzados DB↔WL: elimina de watchlist.json los sitios ya presentes en feeds-database.json.');
    console.log('   → Preview: node scripts/utils/find-duplicates.js --fix --dry-run');
    console.log('   → Fix:     node scripts/utils/find-duplicates.js --fix --yes\n');
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

  // Compute WL ids to remove (keep DB by default)
  let idsToRemove = new Set();
  let sourceLabel = '';
  let targetLabel = '';

  if (keep === 'db') {
    const dbIdSet = new Set(sites.map(s => s.id));
    const dbUrlSet = new Set(sites.map(s => normalizeUrl(s.url)));
    for (const s of wlSites) {
      if (dbIdSet.has(s.id) || dbUrlSet.has(normalizeUrl(s.url))) idsToRemove.add(s.id);
    }
    sourceLabel = 'DB';
    targetLabel = 'watchlist.json';
  } else {
    const wlIdSet = new Set(wlSites.map(s => s.id));
    const wlUrlSet = new Set(wlSites.map(s => normalizeUrl(s.url)));
    for (const s of sites) {
      if (wlIdSet.has(s.id) || wlUrlSet.has(normalizeUrl(s.url))) idsToRemove.add(s.id);
    }
    sourceLabel = 'WL';
    targetLabel = 'feeds-database.json';
  }

  if (idsToRemove.size === 0) {
    console.log(`✅ No hay sitios para eliminar de ${targetLabel} (keep=${keep}).\n`);
    return;
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  🧹 Fix: eliminar duplicados de ${targetLabel} (keep=${keep})`);
  console.log('═══════════════════════════════════════════════════════\n');
  console.log(`  Se eliminarán ${idsToRemove.size} sitios de ${targetLabel} (conservando ${sourceLabel}):`);
  for (const id of [...idsToRemove].sort().slice(0, 50)) {
    console.log(`   • ${id}`);
  }
  if (idsToRemove.size > 50) console.log(`   ... y ${idsToRemove.size - 50} más`);
  console.log();

  if (dryRun) {
    console.log('🔍 --dry-run: no se escribió ningún archivo. Quita --dry-run y añade --yes para aplicar.\n');
    process.exitCode = 1;
    return;
  }

  const ok = await askConfirm(`¿Eliminar ${idsToRemove.size} sitios de ${targetLabel}? [y/N]: `);
  if (!ok) {
    console.log('❌ Cancelado.\n');
    return;
  }

  if (keep === 'db') {
    const filtered = wlSites.filter(s => !idsToRemove.has(s.id));
    // Preserve original format: array JSON
    writeFileSync(WL_FILE, JSON.stringify(filtered, null, 2) + '\n', 'utf-8');
    console.log(`✅ Eliminados ${idsToRemove.size} sitios de ${WL_FILE}.`);
    console.log(`   WL: ${wlSites.length} → ${filtered.length} sitios\n`);
  } else {
    const filteredSites = sites.filter(s => !idsToRemove.has(s.id));
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
    console.log(`✅ Eliminados ${idsToRemove.size} sitios de ${DB_FILE}.`);
    console.log(`   DB: ${sites.length} → ${filteredSites.length} sitios — total_feeds: ${db.total_feeds}\n`);
  }
  process.exitCode = 0;
}

await runFix();
