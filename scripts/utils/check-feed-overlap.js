/**
 * Detecta subfeeds que duplican contenido de otros feeds del mismo sitio.
 * Uso:
 *   node scripts/utils/check-feed-overlap.js [--id site] [--from N --to N] [--limit N]
 *       [--threshold 0.85] [--update] [--automatic] [--validate]
 * Con --update marca los feeds duplicados como status: "duplicate",
 * verified: false y guarda duplicate_of (a qué feed duplican).
 * Con --validate (requiere --update) también actualiza el estado de cada feed
 * (active/stale/feed_empty/broken) reutilizando los resultados ya obtenidos.
 *
 * Fase de recuperación: si A→B y B→A ambos están marcados "duplicate"
 * (ciclo mutuo del bug anterior), ambos se desmarcan automáticamente.
 */
import { readFileSync, writeFileSync } from 'fs';
import { checkFeedUrl } from '../../lib/feed-validator.js';
import { parseArgs, applyFiltersSites } from '../../lib/cli-args.js';
import { isAutomatic, promptUser } from '../../lib/prompter.js';
import { recalculateTotalFeeds, DUPLICATE_OVERLAP_THRESHOLD, STALE_THRESHOLD_DAYS, daysSince } from '../../lib/feed-utils.js';
import { findDuplicate } from '../../lib/feed-overlap.js';

const DB_PATH = 'feeds-database.json';
const MIN_ITEMS = 5;

const args = parseArgs(process.argv, [
  { name: 'threshold', flag: '--threshold', type: 'num' },
  { name: 'validate', flag: '--validate', type: 'bool' },
]);
const threshold = args.threshold !== null && args.threshold > 0 && args.threshold <= 1
  ? args.threshold
  : DUPLICATE_OVERLAP_THRESHOLD;
const shouldUpdate = args.update && !args.dryRun;
const shouldValidate = args.validate && shouldUpdate;

const db = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
const sites = applyFiltersSites(db.sites, args)
  .filter(s => s.feeds.filter(f => !f.id.includes('-proxy-')).length >= 2);

if (sites.length === 0) {
  console.log('🏁 No hay sitios con ≥2 feeds no-proxy en el rango especificado.');
  process.exit(0);
}

// ── Fase 1: recuperar ciclos mutuos ya marcados como "duplicate" ──
// Si A→B y B→A ambos están "duplicate" (bug anterior), desmarcar ambos.
let recovered = 0;
for (const site of db.sites) {
  const dups = site.feeds.filter(f => f.status === 'duplicate' && f.duplicate_of);
  for (const feed of dups) {
    if (feed.status !== 'duplicate') continue; // ya desmarcado en esta pasada
    const target = site.feeds.find(f => f.id === feed.duplicate_of);
    if (!target || target.status !== 'duplicate' || target.duplicate_of !== feed.id) continue;
    // Ciclo mutuo: desmarcar ambos
    for (const f of [feed, target]) {
      f.status = 'active';
      f.verified = true;
      delete f.duplicate_of;
      f.last_checked = new Date().toISOString();
    }
    recovered += 2;
    console.log(`🔧 Recuperado ciclo mutuo: ${site.name} › ${feed.name} <-> ${target.name}`);
  }
}
if (recovered > 0) {
  console.log(`   → ${recovered} feeds desmarcados como duplicate\n`);
}

console.log(`🔁 Revisando solapamiento en ${sites.length} sitio(s), umbral ${Math.round(threshold * 100)}%...\n`);

let totalChecked = 0;
const flagged = [];
const failed = [];
const validated = { active: 0, stale: 0, feed_empty: 0, broken: 0 };
const startTime = Date.now();
let siteIndex = 0;

for (const site of sites) {
  siteIndex++;
  console.log(`[${siteIndex}/${sites.length}] ${site.name} ...`);
  const feeds = site.feeds.filter(f => !f.id.includes('-proxy-'));
  const results = await Promise.all(
    feeds.map(feed => checkFeedUrl(feed.rss_url, { includeItems: true }))
  );

  // --validate: actualizar estado de cada feed con los resultados ya obtenidos
  if (shouldValidate) {
    for (let i = 0; i < feeds.length; i++) {
      const feed = feeds[i];
      const r = results[i];
      if (feed.status === 'duplicate') continue; // no tocar duplicados
      if (r.type) {
        if (r.lastItemDate && daysSince(r.lastItemDate) > STALE_THRESHOLD_DAYS) {
          feed.status = 'stale';
          validated.stale++;
        } else if (r.itemCount === 0) {
          feed.status = 'feed_empty';
          validated.feed_empty++;
        } else {
          feed.status = 'active';
          feed.verified = true;
          validated.active++;
        }
        feed.feed_type = r.type;
        feed.last_checked = new Date().toISOString();
        if (r.lastItemDate !== undefined) feed.last_known_item_date = r.lastItemDate;
      } else if (r.code === 403 || r.code === 429) {
        // bot block — conservar estado actual
      } else {
        feed.status = 'broken';
        feed.verified = false;
        feed.last_checked = new Date().toISOString();
        validated.broken++;
      }
    }
  }

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

if (shouldValidate) {
  console.log(`\n📋 Validación: ${validated.active} activos, ${validated.stale} stale, ${validated.feed_empty} vacíos, ${validated.broken} rotos`);
}

// Resolver ciclos mutuos: si A→B y B→A, conservar el que tiene más items
// y excluir ambos del resultado (el ganador no se marca como duplicate)
const toRemove = new Set();
for (const entry of flagged) {
  if (toRemove.has(entry.feed.id)) continue;
  const counterpart = flagged.find(
    f => f.feed.id !== entry.feed.id
      && f.dup.duplicateOf === entry.feed.id
      && entry.dup.duplicateOf === f.feed.id
  );
  if (!counterpart) continue;
  const loser = entry.result.itemCount >= counterpart.result.itemCount
    ? counterpart : entry;
  const winner = loser === entry ? counterpart : entry;
  toRemove.add(loser.feed.id);
  toRemove.add(winner.feed.id);
  console.log(`⚡ Ciclo mutuo: conservando ${winner.feed.name} (${winner.result.itemCount} items), descartando ${loser.feed.name} (${loser.result.itemCount} items)`);
}
const resolved = flagged.filter(f => !toRemove.has(f.feed.id));

console.log(`📊 ${totalChecked} feed(s) comparados, ${resolved.length} duplicado(s), ${failed.length} sitio(s) sin revisar.\n`);

for (const { site, feed, result, dup } of resolved) {
  const ratioPct = Math.round(dup.ratio * 100);
  console.log(`🔁 ${site.name} › ${feed.name}`);
  console.log(`     duplica a: ${dup.duplicateOf} (${ratioPct}%, ${result.itemCount} items)`);
  console.log(`     ${feed.rss_url}`);
}

if (resolved.length === 0) {
  if (recovered > 0 || (shouldValidate && (validated.active + validated.stale + validated.feed_empty + validated.broken) > 0)) {
    recalculateTotalFeeds(db);
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
    const parts = [];
    if (recovered > 0) parts.push(`${recovered} recuperados de ciclos mutuos`);
    console.log(`💾 ${parts.join(', ')}${parts.length ? '. ' : ''}Total activos: ${db.total_feeds}`);
  } else {
    console.log('✅ No se encontraron feeds duplicados.');
    if (args.validate && !shouldUpdate) console.log(`   (--validate requiere --update para escribir cambios)`);
  }
  process.exit(0);
}

if (!shouldUpdate) {
  console.log(`\nℹ️  Usa --update para marcar los duplicados como status "duplicate".`);
  if (args.validate) console.log(`   (--validate requiere --update para escribir cambios)`);
  process.exit(0);
}

const confirmed = [];
for (const { site, feed, dup } of resolved) {
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
