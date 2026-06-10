#!/usr/bin/env node
/**
 * Valida sitios en watchlist.json y promueve los que pasen todos los checks.
 *
 * Uso: node scripts/core/validate-watchlist.js [--update] [--automatic] [--id <site-id>]
 *   --update     Mueve los feeds válidos a sites[] en feeds-database.json
 *   --automatic  Modo no interactivo (sin prompts, promueve todo)
 *   --id <id>    Valida solo un sitio específico de la watchlist
 *
 * Sin --update solo reporta (pregunta al final si guardar cambios).
 * Con --update, pregunta por cada entrada individualmente.
 */

import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { validateWatchlistEntry } from '../../lib/watchlist-validator.js';
import { isAutomatic } from '../../lib/prompter.js';

const args = process.argv.slice(2);
const shouldUpdate = args.includes('--update');
const idIndex = args.indexOf('--id');
const targetId = idIndex !== -1 && args[idIndex + 1] ? args[idIndex + 1] : null;

function promptMove(name) {
  if (!process.stdin.isTTY || isAutomatic()) return Promise.resolve(true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`   ¿Promover "${name}" a sites ahora? [Y/n]: `, answer => {
      rl.close();
      const input = answer.trim().toLowerCase();
      resolve(input === '' || input === 'y' || input === 'yes' || input === 's' || input === 'si');
    });
  });
}

const watchlist = JSON.parse(readFileSync('watchlist.json', 'utf-8'));
const db = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));

if (!watchlist.length) {
  console.log('⚠️  No hay sitios en watchlist.json\n');
  process.exit(0);
}

let entries = watchlist;
if (targetId) {
  const found = watchlist.find(e => e.id === targetId);
  if (!found) {
    console.log(`❌ No se encontró "${targetId}" en watchlist.json\n`);
    process.exit(1);
  }
  entries = [found];
}

console.log(`🔭 Validando ${entries.length} sitio(s) de watchlist\n`);
console.log('='.repeat(55));

const promoted = [];
const kept = [];
const errors = { noResponse: [], httpError: [], emptyFeed: [], noFeed: [], stale: [] };

for (const entry of entries) {
  process.stdout.write(`🔍 ${entry.name}... `);
  const result = await validateWatchlistEntry(entry);

  if (result.ok) {
    console.log('🎉 feed válido!');
    console.log(`   URL: ${result.siteEntry.feeds[0].rss_url} [${result.siteEntry.feeds[0].feed_type}]`);
    console.log(`   Último item: ${result.siteEntry.feeds[0].last_known_item_date?.slice(0, 10) ?? 'desconocido'}`);
    if (shouldUpdate) {
      const move = await promptMove(entry.name);
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
    console.log(`❌ ${result.reason}\n`);
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
  }
}

console.log('='.repeat(55));

if (promoted.length) {
  console.log(`\n✅ ${promoted.length} sitio(s) promovidos a sites:\n`);
  for (const site of promoted) {
    console.log(`  ${site.name} (${site.category})`);
    console.log(`  URL   : ${site.url}`);
    console.log(`  Feed  : ${site.feeds[0].rss_url} [${site.feeds[0].feed_type}]\n`);
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

let saveFiles;
if (!shouldUpdate && promoted.length && !isAutomatic() && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  saveFiles = await new Promise(resolve => {
    rl.question(`\n💾 ¿Guardar los cambios (promover ${promoted.length} sitio(s) a sites)? [y/N]: `, answer => {
      rl.close();
      const input = answer.trim().toLowerCase();
      resolve(input === 'y' || input === 'yes' || input === 's' || input === 'si');
    });
  });
}

if (shouldUpdate || saveFiles) {
  if (promoted.length || kept.length) {
    for (const siteEntry of promoted) {
      db.sites.push(siteEntry);
    }
    db.total_feeds = db.sites.reduce(
      (sum, site) => sum + site.feeds.filter(f => f.status === 'active' && f.verified).length,
      0,
    );
    db.last_updated = new Date().toISOString();
    writeFileSync('feeds-database.json', JSON.stringify(db, null, 2), 'utf-8');

    const remaining = watchlist.filter(w => !promoted.some(p => p.id === w.id));
    const withKept = remaining.map(w => {
      const k = kept.find(k => k.id === w.id);
      return k ?? w;
    });
    writeFileSync('watchlist.json', JSON.stringify(withKept, null, 2), 'utf-8');

    if (promoted.length) {
      console.log(`\n💾 ${promoted.length} sitio(s) añadidos a sites en feeds-database.json`);
    }
    if (kept.length) {
      console.log(`💾 ${kept.length} sitio(s) con feed poblado guardados en watchlist.json`);
    }
    console.log(`📊 Total feeds activos: ${db.total_feeds}`);
  }
} else if (promoted.length && !saveFiles) {
  console.log(`\nℹ️  Puedes usar --update la próxima vez para promover automáticamente`);
}
