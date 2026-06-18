#!/usr/bin/env node
/**
 * Valida sitios en watchlist.json y promueve los que pasen todos los checks.
 *
 * Uso: node scripts/core/validate-watchlist.js [--update] [--automatic] [--id <site-id>]
 *                                         [--from <N> --to <M>] [--start-id <id>] [--limit <N>]
 *   --update       Mueve los feeds válidos a sites[] en feeds-database.json
 *   --automatic    Modo no interactivo (sin prompts, promueve todo)
 *   --id <id>      Valida solo un sitio específico de la watchlist
 *   --from <N>     Índice numérico inicial (0-based)
 *   --to <M>       Índice numérico final (inclusive)
 *   --start-id <id>  Comienza desde este ID (inclusive) en la lista filtrada
 *   --limit <N>    Máximo de entradas a validar
 *
 * Sin --update solo reporta (pregunta al final si guardar cambios).
 * Con --update, pregunta por cada entrada individualmente.
 */

import { readFileSync, writeFileSync } from 'fs';
import { validateWatchlistEntry } from '../../lib/watchlist-validator.js';
import { isAutomatic, promptUser } from '../../lib/prompter.js';
import { parseArgs, applyFilters } from '../../lib/cli-args.js';
import { recalculateTotalFeeds } from '../../lib/feed-utils.js';

const args = parseArgs(process.argv);
const shouldUpdate = args.update;

const watchlist = JSON.parse(readFileSync('watchlist.json', 'utf-8'));
const db = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));

if (!watchlist.length) {
  console.log('⚠️  No hay sitios en watchlist.json\n');
  process.exit(0);
}

let entries = applyFilters(watchlist, args);

if (entries.length === 0) {
  console.log('🏁 No hay entradas para validar en el rango especificado.\n');
  process.exit(0);
}

console.log(`🔭 Validando ${entries.length} sitio(s) de watchlist\n`);
console.log('='.repeat(55));

const promoted = [];
const kept = [];
const failed = [];
const errors = { noResponse: [], httpError: [], emptyFeed: [], noFeed: [], stale: [], proxyBroken: [], proxyStale: [] };

for (const entry of entries) {
  const result = await validateWatchlistEntry(entry);

  const clearLine = '\r' + ' '.repeat(80) + '\r';
  if (result.ok) {
    const nativeFeed = result.siteEntry.feeds.find(f => f.id === `${entry.id}-main`);
    process.stdout.write(`${clearLine}🎉 feed válido!\n`);
    console.log(`   Feed nativo: ${nativeFeed?.rss_url} [${nativeFeed?.feed_type}]`);
    console.log(`   Último item: ${nativeFeed?.last_known_item_date?.slice(0, 10) ?? 'desconocido'}`);

    const proxyFeeds = result.siteEntry.feeds.filter(f => f.id !== `${entry.id}-main`);
    if (proxyFeeds.length > 0) {
      const proxyStatuses = proxyFeeds.map(f => `     ${f.name}: ${f.status}`).join('\n');
      console.log(`   Subfeeds proxy:\n${proxyStatuses}`);
    }

    if (shouldUpdate) {
      const move = await promptUser(`   ¿Promover "${entry.name}" a sites ahora? [Y/n]: `);
      if (move) {
        promoted.push(result.siteEntry);
      } else {
        const keptEntry = { ...result.siteEntry, reason: entry.reason };
        kept.push(keptEntry);
      }
    } else {
      promoted.push(result.siteEntry);
    }
    console.log();
  } else {
    process.stdout.write(`${clearLine}❌ ${result.reason}\n`);

    if (result.entry?.feeds) {
      const proxyIssues = result.entry.feeds.filter(f => f.status !== 'active' && f.id !== `${entry.id}-main`);
      for (const pf of proxyIssues) {
        if (pf.status === 'stale') errors.proxyStale.push(`${entry.name} › ${pf.name}`);
        else errors.proxyBroken.push(`${entry.name} › ${pf.name}`);
      }
    }

    if (result.reason.startsWith('sitio no responde')) {
      errors.noResponse.push(entry.name);
    } else if (result.reason.startsWith('HTTP error')) {
      errors.httpError.push(entry.name);
    } else if (result.reason.includes('vacío')) {
      errors.emptyFeed.push(entry.name);
    } else if (result.reason.includes('stale')) {
      errors.stale.push(entry.name);
    } else {
      errors.noFeed.push(entry.name);
    }

    failed.push({ id: entry.id, reason: result.reason });
  }
}

console.log('='.repeat(55));

if (promoted.length) {
  console.log(`\n✅ ${promoted.length} sitio(s) promovidos a sites:\n`);
  for (const site of promoted) {
    const nativeFeed = site.feeds.find(f => f.id === `${site.id}-main`);
    console.log(`  ${site.name} (${site.category})`);
    console.log(`  URL   : ${site.url}`);
    console.log(`  Feed  : ${nativeFeed?.rss_url} [${nativeFeed?.feed_type}]`);
    const proxyCount = site.feeds.length - 1;
    if (proxyCount > 0) {
      console.log(`  Proxy : ${proxyCount} subfeed(s) preservado(s)`);
    }
    console.log();
  }
}

if (kept.length) {
  console.log(`📌 ${kept.length} sitio(s) con feed encontrado (pendientes de promoción manual):\n`);
  for (const site of kept) {
    console.log(`  ${site.name} (${site.category})`);
    console.log(`  Feed  : ${site.feeds[0].rss_url} [${site.feeds[0].feed_type}]\n`);
  }
}

if (errors.stale.length) {
  console.log(`⏳ Stale: ${errors.stale.length}`);
  errors.stale.forEach(n => console.log(`   • ${n}`));
}
if (errors.noResponse.length) {
  console.log(`🔴 No responden: ${errors.noResponse.length}`);
  errors.noResponse.forEach(n => console.log(`   • ${n}`));
}
if (errors.httpError.length) {
  console.log(`🟡 HTTP errors: ${errors.httpError.length}`);
  errors.httpError.forEach(n => console.log(`   • ${n}`));
}
if (errors.emptyFeed.length) {
  console.log(`⚠️  Feed vacío: ${errors.emptyFeed.length}`);
  errors.emptyFeed.forEach(n => console.log(`   • ${n}`));
}
if (errors.noFeed.length) {
  console.log(`🔵 Sin feed RSS: ${errors.noFeed.length}`);
  errors.noFeed.forEach(n => console.log(`   • ${n}`));
}
if (errors.proxyStale.length) {
  console.log(`⏳ Proxy feeds stale: ${errors.proxyStale.length}`);
  errors.proxyStale.forEach(n => console.log(`   • ${n}`));
}
if (errors.proxyBroken.length) {
  console.log(`💔 Proxy feeds caídos: ${errors.proxyBroken.length}`);
  errors.proxyBroken.forEach(n => console.log(`   • ${n}`));
}

let saveFiles;
if (!shouldUpdate && promoted.length && !isAutomatic() && process.stdin.isTTY) {
  saveFiles = await promptUser(`\n💾 ¿Guardar los cambios (promover ${promoted.length} sitio(s) a sites)? [y/N]: `, { defaultYes: false });
}

if (shouldUpdate || saveFiles) {
  if (promoted.length || kept.length || failed.length) {
    if (promoted.length) {
      for (const siteEntry of promoted) {
        if (db.sites.some(s => s.id === siteEntry.id)) {
          console.warn(`  ⚠️  "${siteEntry.id}" ya existe en sites — se omite duplicado`);
          continue;
        }
        db.sites.push(siteEntry);
      }
      db.total_feeds = recalculateTotalFeeds(db);
      writeFileSync('feeds-database.json', JSON.stringify(db, null, 2), 'utf-8');
    }

    const remaining = watchlist.filter(w => !promoted.some(p => p.id === w.id));
    const withKept = remaining.map(w => {
      const k = kept.find(k => k.id === w.id);
      if (k) return k;
      const f = failed.find(f => f.id === w.id);
      if (f) return { ...w, reason: f.reason };
      return w;
    });
    writeFileSync('watchlist.json', JSON.stringify(withKept, null, 2), 'utf-8');

    if (promoted.length) {
      console.log(`\n💾 ${promoted.length} sitio(s) añadidos a sites en feeds-database.json`);
    }
    if (kept.length) {
      console.log(`💾 ${kept.length} sitio(s) con feed poblado guardados en watchlist.json`);
    }
    if (failed.length) {
      console.log(`💾 ${failed.length} sitio(s) con razón actualizada en watchlist.json`);
    }
    console.log(`📊 Total feeds activos: ${db.total_feeds}`);
  }
} else if (promoted.length && !saveFiles) {
  console.log(`\nℹ️  Puedes usar --update la próxima vez para promover automáticamente`);
}
