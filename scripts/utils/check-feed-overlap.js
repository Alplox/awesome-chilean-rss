/**
 * Detecta subfeeds que duplican contenido de otros feeds del mismo sitio.
 * Uso:
 *   node scripts/utils/check-feed-overlap.js [--id site] [--from N --to N] [--limit N]
 *       [--threshold 0.85] [--update] [--automatic]
 * Con --update marca los feeds duplicados como status: "duplicate",
 * verified: false y guarda duplicate_of (a qué feed duplican).
 */
import { readFileSync, writeFileSync } from 'fs';
import { checkFeedUrl } from '../../lib/feed-validator.js';
import { parseArgs, applyFiltersSites } from '../../lib/cli-args.js';
import { isAutomatic, promptUser } from '../../lib/prompter.js';
import { recalculateTotalFeeds, DUPLICATE_OVERLAP_THRESHOLD } from '../../lib/feed-utils.js';
import { findDuplicate } from '../../lib/feed-overlap.js';

const DB_PATH = 'feeds-database.json';
const MIN_ITEMS = 5;

const args = parseArgs(process.argv, [
  { name: 'threshold', flag: '--threshold', type: 'num' },
]);
const threshold = args.threshold !== null && args.threshold > 0 && args.threshold <= 1
  ? args.threshold
  : DUPLICATE_OVERLAP_THRESHOLD;
const shouldUpdate = args.update && !args.dryRun;

const db = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
const sites = applyFiltersSites(db.sites, args)
  .filter(s => s.feeds.filter(f => !f.id.includes('-proxy-')).length >= 2);

if (sites.length === 0) {
  console.log('🏁 No hay sitios con ≥2 feeds no-proxy en el rango especificado.');
  process.exit(0);
}

console.log(`🔁 Revisando solapamiento en ${sites.length} sitio(s), umbral ${Math.round(threshold * 100)}%...\n`);

let totalChecked = 0;
const flagged = [];
const failed = [];
const startTime = Date.now();
let siteIndex = 0;

for (const site of sites) {
  siteIndex++;
  console.log(`[${siteIndex}/${sites.length}] ${site.name} ...`);
  const feeds = site.feeds.filter(f => !f.id.includes('-proxy-'));
  const results = await Promise.all(
    feeds.map(feed => checkFeedUrl(feed.rss_url, { includeItems: true }))
  );

  const withItems = feeds
    .map((feed, i) => ({ feed, result: results[i] }))
    .filter(({ result }) => result.type && Array.isArray(result.items) && result.items.length >= MIN_ITEMS);

  // El feed principal (site-main) nunca se marca duplicado: borrarlo quitaría
  // la entrada principal del sitio del OPML. Sigue sirviendo como referencia.
  const candidates = withItems.filter(({ feed }) => !feed.id.endsWith('-main'));
  const before = flagged.length;

  for (const { feed, result } of candidates) {
    const others = new Map(
      withItems.filter(({ feed: other }) => other.id !== feed.id)
        .map(({ feed: other, result: otherResult }) => [other.id, otherResult.items])
    );
    const dup = findDuplicate(result.items, others, threshold);
    totalChecked++;
    if (dup) {
      flagged.push({ site, feed, result, dup });
    }
  }

  if (!results.some(r => r.type)) {
    failed.push(site.name);
    console.warn(`   ⚠️  todos los feeds fallaron, sitio no revisado`);
  }
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`   ✓ ${results.length} feeds, ${flagged.length - before} duplicado(s), ${elapsed}s`);
}

console.log(`📊 ${totalChecked} feed(s) comparados, ${flagged.length} duplicado(s), ${failed.length} sitio(s) sin revisar.\n`);

for (const { site, feed, result, dup } of flagged) {
  const ratioPct = Math.round(dup.ratio * 100);
  console.log(`🔁 ${site.name} › ${feed.name}`);
  console.log(`     duplica a: ${dup.duplicateOf} (${ratioPct}%, ${result.itemCount} items)`);
  console.log(`     ${feed.rss_url}`);
}

if (flagged.length === 0) {
  console.log('✅ No se encontraron feeds duplicados.');
  process.exit(0);
}

if (!shouldUpdate) {
  console.log(`\nℹ️  Usa --update para marcar los duplicados como status "duplicate".`);
  process.exit(0);
}

const confirmed = [];
for (const { site, feed, dup } of flagged) {
  const ok = isAutomatic() || await promptUser(
    `   Marcar "${site.name} › ${feed.name}" como duplicate (de ${dup.duplicateOf})? [Y/n]: `
  );
  if (ok) confirmed.push({ site, feed, dup });
}

if (confirmed.length === 0) {
  console.log('\n✅ Ningún feed marcado.');
  process.exit(0);
}

for (const { site, feed, dup } of confirmed) {
  feed.status = 'duplicate';
  feed.verified = false;
  feed.duplicate_of = dup.duplicateOf;
  feed.last_checked = new Date().toISOString();
  console.log(`💾 ${site.name} › ${feed.name} → duplicate (de ${dup.duplicateOf})`);
}

recalculateTotalFeeds(db);
writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
console.log(`\n📊 Total feeds activos: ${db.total_feeds}`);
