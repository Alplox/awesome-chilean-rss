#!/usr/bin/env node
/**
 * find-duplicates.js
 *
 * Detecta entradas duplicadas en feeds-database.json:
 *
 *  1. Sitios con la misma URL de sitio (site.url)
 *  2. Feeds con el mismo rss_url (global, incluso entre sitios distintos)
 *  3. Posibles sitios duplicados (mismo dominio raíz)
 *  4. IDs de sitio duplicados
 *  5. IDs de feed duplicados
 *
 * Uso:
 *   node scripts/utils/find-duplicates.js
 *   node scripts/utils/find-duplicates.js --verbose   (links clicables a cada entrada)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');

const DB_FILE = 'feeds-database.json';
const DB_ABS  = resolve(DB_FILE);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a map of { id → lineNumber } by scanning the raw file.
 * Looks for lines matching:  "id": "some-value"
 * The first occurrence of each id is recorded.
 */
function buildLineIndex(rawText) {
  const index = new Map();
  const lines = rawText.split('\n');
  const idRe = /^\s*"id"\s*:\s*"([^"]+)"/;
  for (let i = 0; i < lines.length; i++) {
    const m = idRe.exec(lines[i]);
    if (m) {
      const id = m[1];
      if (!index.has(id)) {
        index.set(id, i + 1); // 1-based line number
      }
    }
  }
  return index;
}

/** Return a VS Code-clickable terminal path string for a given id, or '' if not verbose. */
function fileLink(id, lineIndex) {
  if (!verbose) return '';
  const line = lineIndex.get(id) ?? 1;
  // VS Code terminal recognises  AbsPath:line  and makes it clickable
  return `     📎 ${DB_ABS}:${line}`;
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

// ─── Load data ────────────────────────────────────────────────────────────────

const rawText = readFileSync(DB_FILE, 'utf-8');
const db = JSON.parse(rawText);
const { sites } = db;

// Build the ID → line-number index once from the raw text
const lineIndex = buildLineIndex(rawText);

let foundAny = false;

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
        console.log(fileLink(s.id, lineIndex));
        for (const f of s.feeds) {
          console.log(`     ↳ feed [${f.id}]: ${f.rss_url} | ${f.status}`);
          console.log(fileLink(f.id, lineIndex));
        }
      }
    }
    console.log();
  }
}
if (dupSiteUrlCount === 0) console.log('✅ No se encontraron URLs de sitio duplicadas.\n');

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
          console.log(fileLink(s.id, lineIndex));
          for (const f of s.feeds) {
            console.log(`     ↳ feed [${f.id}]: ${f.rss_url} | ${f.status}`);
            console.log(fileLink(f.id, lineIndex));
          }
        }
      }
      console.log();
    }
  }
}
if (dupRootCount === 0) console.log('✅ No se encontraron sitios con el mismo dominio raíz.\n');

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
      if (verbose) console.log(fileLink(s.id, lineIndex));
    }
    console.log();
  }
}
if (dupIdCount === 0) console.log('✅ No se encontraron IDs de sitio duplicados.\n');

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

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════');
console.log('  📊 Resumen');
console.log('═══════════════════════════════════════════════════════\n');
console.log(`  Sitios analizados      : ${sites.length}`);
console.log(`  Total feeds            : ${sites.reduce((n, s) => n + s.feeds.length, 0)}`);
console.log(`  URLs de sitio dupl.   : ${dupSiteUrlCount}`);
console.log(`  rss_url duplicadas     : ${dupFeedUrlCount}`);
console.log(`  Dominios raíz dupl.   : ${dupRootCount}`);
console.log(`  IDs de sitio dupl.    : ${dupIdCount}`);
console.log(`  IDs de feed dupl.     : ${dupFeedIdCount}`);
console.log();

if (!foundAny) {
  console.log('✅ No se encontraron duplicados.\n');
} else {
  console.log('⚠️  Se encontraron posibles duplicados. Revísalos manualmente.\n');
  if (!verbose) {
    console.log('💡 Tip: usa --verbose (-v) para ver links clicables a cada entrada en el archivo.\n');
  }
  process.exitCode = 1;
}
