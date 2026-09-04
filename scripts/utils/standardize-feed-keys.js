#!/usr/bin/env node
/**
 * standardize-feed-keys.js
 *
 * Reordena las claves de objetos feed y site a un orden canónico
 * para mantener diffs limpios en `feeds-database.json` y `watchlist.json`.
 *
 * - Feeds: orden definido en {@link FEED_KEY_ORDER}
 * - Sites: orden definido en {@link SITE_KEY_ORDER} (incluye `reason` para watchlist)
 *
 * Soporta ambos archivos:
 * - `feeds-database.json` → `{ sites: [...] }` (sin `reason`)
 * - `watchlist.json`       → `[...]` o `{ sites: [...] }` (con `reason` opcional)
 *
 * Uso:
 *   node scripts/utils/standardize-feed-keys.js
 *   node scripts/utils/standardize-feed-keys.js --file database
 *   node scripts/utils/standardize-feed-keys.js --file watchlist
 *   node scripts/utils/standardize-feed-keys.js --file all --dry-run
 *   node scripts/utils/standardize-feed-keys.js --check
 *
 * Flags:
 *   --file <database|watchlist|all>  Qué archivo(s) procesar (default: all)
 *   --dry-run                        Preview sin escribir archivos
 *   --check                          Solo verifica si hay cambios (exit 1 si haría falta)
 *   --help, -h                       Muestra ayuda
 *
 * @module scripts/utils/standardize-feed-keys
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// ─── Órdenes canónicos ────────────────────────────────────────────────────────

/**
 * Orden canónico de claves para objetos feed.
 * Cubre tanto feeds de `feeds-database.json` como proxies de `watchlist.json`.
 * Las claves ausentes se omiten; las extras no listadas se anexan al final
 * para no perder datos.
 * @type {string[]}
 */
const FEED_KEY_ORDER = [
  'id',
  'name',
  'rss_url',
  'url',
  'description',
  'feed_type',
  'category',
  'region',
  'last_checked',
  'last_known_item_date',
  'verified',
  'status',
  'duplicate_of',
];

/**
 * Orden canónico de claves para objetos site.
 * `reason` solo existe en `watchlist.json` (candidatos sin feed o stale).
 * `region` es opcional y solo requerido si `category === 'regional'`.
 * `feeds` siempre va al final por ser el campo más voluminoso.
 * @type {string[]}
 */
const SITE_KEY_ORDER = [
  'id',
  'name',
  'url',
  'category',
  'region',
  'description',
  'reason',
  'feeds',
];

// ─── Helpers de ordenamiento ────────────────────────────────────────────────

/**
 * Reordena un objeto feed según {@link FEED_KEY_ORDER}.
 * Mantiene claves desconocidas al final en su orden original para no perder datos.
 *
 * @param {Record<string, unknown>} feed - Objeto feed original
 * @returns {Record<string, unknown>} Nuevo objeto con claves reordenadas
 */
function standardizeFeed(feed) {
  const ordered = {};
  for (const key of FEED_KEY_ORDER) {
    if (key in feed) {
      ordered[key] = feed[key];
    }
  }
  // Anexar claves no contempladas (ej. campos futuros) al final
  for (const key of Object.keys(feed)) {
    if (!(key in ordered)) {
      ordered[key] = feed[key];
    }
  }
  return ordered;
}

/**
 * Reordena un objeto site según {@link SITE_KEY_ORDER}.
 * Los feeds anidados se reordenan vía {@link standardizeFeed}.
 * `reason` se preserva solo si existe (watchlist); en database se omite.
 *
 * @param {Record<string, unknown>} site - Objeto site original
 * @returns {Record<string, unknown>} Nuevo objeto site con claves reordenadas
 */
function standardizeSite(site) {
  const ordered = {};
  for (const key of SITE_KEY_ORDER) {
    if (key in site) {
      if (key === 'feeds' && Array.isArray(site.feeds)) {
        ordered[key] = site.feeds.map(standardizeFeed);
      } else {
        ordered[key] = site[key];
      }
    }
  }
  // Si site.feeds no fue incluido por no estar en SITE_KEY_ORDER (imposible),
  // igualmente estandarizarlo; también anexar claves extra
  if (!('feeds' in ordered) && Array.isArray(site.feeds)) {
    ordered.feeds = site.feeds.map(standardizeFeed);
  } else if (Array.isArray(ordered.feeds)) {
    // Ya reordenado arriba, pero asegurar que cada feed esté estandarizado
    ordered.feeds = ordered.feeds.map(standardizeFeed);
  }
  for (const key of Object.keys(site)) {
    if (!(key in ordered)) {
      ordered[key] = site[key];
    }
  }
  return ordered;
}

/**
 * Estandariza un archivo JSON (database o watchlist) y reporta cambios.
 *
 * @param {string} filePath - Ruta relativa al archivo JSON
 * @param {object} options
 * @param {boolean} options.dryRun - Si true, no escribe el archivo
 * @param {boolean} options.check - Si true, solo verifica (no escribe)
 * @returns {{ sites: number, feeds: number, changed: boolean }} Estadísticas
 */
function standardizeFile(filePath, { dryRun, check }) {
  const absPath = resolve(filePath);
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  const isArray = Array.isArray(parsed);
  const sites = isArray ? parsed : parsed.sites;

  if (!Array.isArray(sites)) {
    throw new Error(`${filePath}: formato inesperado — se esperaba array o { sites: [] }`);
  }

  let totalFeeds = 0;
  const standardizedSites = sites.map(site => {
    totalFeeds += Array.isArray(site.feeds) ? site.feeds.length : 0;
    return standardizeSite(site);
  });

  // Reconstruir estructura preservando forma original (array vs objeto)
  let output;
  let outputStr;
  if (isArray) {
    output = standardizedSites;
    outputStr = JSON.stringify(output, null, 2) + '\n';
  } else {
    output = { ...parsed, sites: standardizedSites };
    outputStr = JSON.stringify(output, null, 2) + '\n';
  }

  // Comparación precisa: si el string ya está idéntico, no hay cambio
  const actuallyChanged = raw !== outputStr;

  if (actuallyChanged && !dryRun && !check) {
    writeFileSync(filePath, outputStr, 'utf-8');
  }

  return { sites: sites.length, feeds: totalFeeds, changed: actuallyChanged, absPath };
}

/**
 * Parsea argumentos CLI para este script.
 *
 * @param {string[]} argv - `process.argv`
 * @returns {{ file: string, dryRun: boolean, check: boolean, help: boolean }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const getVal = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
  };
  const file = (getVal('--file') || 'all').toLowerCase();
  if (!['database', 'db', 'watchlist', 'wl', 'all'].includes(file)) {
    console.error('❌ --file debe ser "database", "watchlist" o "all"');
    process.exit(1);
  }
  return {
    file: file === 'db' ? 'database' : file === 'wl' ? 'watchlist' : file,
    dryRun: args.includes('--dry-run'),
    check: args.includes('--check'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

/**
 * Punto de entrada CLI.
 * Procesa uno o ambos archivos según `--file`, con soporte para `--dry-run` y `--check`.
 */
function main() {
  const { file, dryRun, check, help } = parseArgs(process.argv);

  if (help) {
    console.log(`
Uso: node scripts/utils/standardize-feed-keys.js [opciones]

Reordena claves de feeds y sites a orden canónico.

Feeds  → ${FEED_KEY_ORDER.join(', ')}
Sites  → ${SITE_KEY_ORDER.join(', ')}  (reason solo en watchlist)

Opciones:
  --file <database|watchlist|all>  Qué archivo(s) procesar (default: all)
  --dry-run                        Preview sin escribir
  --check                          Solo verifica (exit 1 si hay cambios pendientes)
  --help, -h                       Esta ayuda

Ejemplos:
  node scripts/utils/standardize-feed-keys.js
  node scripts/utils/standardize-feed-keys.js --file database --dry-run
  node scripts/utils/standardize-feed-keys.js --file watchlist --check
  node scripts/utils/standardize-feed-keys.js --file all
`);
    process.exit(0);
  }

  const targets = [];
  if (file === 'database' || file === 'all') targets.push('feeds-database.json');
  if (file === 'watchlist' || file === 'all') targets.push('watchlist.json');

  let anyChanged = false;
  for (const target of targets) {
    try {
      const { sites, feeds, changed } = standardizeFile(target, { dryRun, check });
      anyChanged = anyChanged || changed;
      const verb = check ? 'verificado' : dryRun ? 'preview' : 'estandarizado';
      const flag = changed ? (check || dryRun ? '⚠️  requiere cambios' : '✅ reordenado') : '✅ sin cambios';
      console.log(`${flag} — ${feeds} feeds en ${sites} sitios — ${target} (${verb})`);
      if (changed && (dryRun || check)) {
        console.log(`   → Ejecuta sin --dry-run/--check para aplicar: node scripts/utils/standardize-feed-keys.js --file ${target === 'feeds-database.json' ? 'database' : 'watchlist'}`);
      }
    } catch (err) {
      console.error(`❌ Error procesando ${target}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  if (check && anyChanged) {
    console.log('\n❌ Hay archivos que requieren estandarización. Ejecuta sin --check para corregir.\n');
    process.exitCode = 1;
  } else if (!check && !dryRun && anyChanged) {
    console.log('\n✅ Claves estandarizadas.\n');
  } else if (!anyChanged) {
    console.log('\n✅ Todo ya está estandarizado.\n');
  }
}

main();
