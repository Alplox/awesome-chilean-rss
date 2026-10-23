#!/usr/bin/env node
/**
 * Diagnostica feeds que fallan por error de conexión, reintentando su lectura a
 * través de relays públicos de un solo endpoint.
 *
 * Para cada feed en estado problemático:
 *   1. Se valida en local (`checkFeedUrl`).
 *   2. Si el error es de conexión, se reintenta vía relay (otra red de salida).
 *   3. Se emite un veredicto: problema de red local, fallo del sitio, o feed
 *      vivo pero desactualizado.
 *
 * **Solo lectura**: nunca modifica feeds-database.json ni watchlist.json. Los
 * resultados vía relay son informativos (un relay puede alterar el contenido),
 * por eso no se usan para cambiar estados.
 *
 * Uso:
 *   pnpm diagnose:network
 *   pnpm diagnose:network -- --id <site-id>
 *   pnpm diagnose:network -- --url <URL>
 *   pnpm diagnose:network -- --status offline,no_feed --limit 20
 *   pnpm diagnose:network -- --file watchlist
 *   pnpm diagnose:network -- --relay codetabs
 *   pnpm diagnose:network -- --relay "https://mi-relay.workers.dev/?url={url}"
 *
 * Opciones:
 *   --url <URL>          Diagnostica una URL directamente (ignora la BD)
 *   --file <f>           database | watchlist | all (default: all)
 *   --status <a,b>       Estados a revisar (default: offline,no_feed,broken)
 *   --force-relay        Reintenta por relay aunque el error no sea de conexión
 *   --relay <lista>      Relay(s) separados por coma (default: allorigins)
 *                        Presets: allorigins, codetabs — o plantilla con
 *                        {url} (codificada) / {urlRaw} (sin codificar)
 *   --id <site-id>       Filtra por site-id
 *   --start-id <feed-id> Comienza desde un feed-id (inclusive)
 *   --from <N> --to <N>  Rango numérico sobre la lista de feeds candidatos
 *   --limit <N>          Máximo de feeds a diagnosticar
 *   --verbose            Muestra la URL del relay usada en cada intento
 */

import { readFileSync } from 'fs';
import { checkFeedUrl } from '../../lib/feed-validator.js';
import { formatError, daysSince, STALE_THRESHOLD_DAYS, ALLOWED_STATUSES } from '../../lib/feed-utils.js';
import {
  checkFeedViaRelay,
  checkReachabilityViaRelay,
  resolveRelayList,
  RELAY_PRESETS,
  RELAY_TIMEOUT_MS,
  DEFAULT_RELAY,
} from '../../lib/relay-fetch.js';
import { parseArgs, applyFilters } from '../../lib/cli-args.js';

/** Error de conexión devuelto por `checkFeedUrl` cuando `fetchSafe` no obtiene respuesta. */
const CONNECTION_ERROR = 'no responde';
const DEFAULT_STATUSES = ['offline', 'no_feed', 'broken'];
const SOURCE_FILES = {
  database: 'feeds-database.json',
  watchlist: 'watchlist.json',
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`❌ No se pudo leer ${path}: ${err.message}`);
    process.exit(1);
  }
}

function feedLabel(site, feed) {
  return `${site.name} › ${feed.name}`;
}

function shortDate(isoDate) {
  const days = Math.round(daysSince(isoDate));
  return `${isoDate.slice(0, 10)} (hace ${days} día${days === 1 ? '' : 's'})`;
}

function describeRelayResult(result) {
  if (result.type) {
    const date = result.lastItemDate ? `, último ${shortDate(result.lastItemDate)}` : '';
    return `✅ ${result.type}, ${result.itemCount} item${result.itemCount === 1 ? '' : 's'}${date}`;
  }
  if (result.relayError) return `❔ relay no disponible (${result.error})`;
  return `❌ ${formatError(result.error, result.code)}`;
}

/**
 * Reintenta la lectura de un feed por cada relay hasta obtener un feed válido.
 * @returns {Promise<Array<{ relay: object, result: object }>>}
 */
async function tryRelays(feedUrl, relays, verbose) {
  const attempts = [];
  for (const relay of relays) {
    const result = await checkFeedViaRelay(feedUrl, { relay, timeout: RELAY_TIMEOUT_MS });
    attempts.push({ relay, result });
    if (verbose && result.relayUrl) console.log(`     ↳ ${result.relayUrl}`);
    console.log(`     🌐 ${relay.label.padEnd(10)} ${describeRelayResult(result)}`);
    if (result.type) break;
  }
  return attempts;
}

function verdictFor(attempts, counters, label) {
  const success = attempts.find(a => a.result.type);
  const usable = attempts.filter(a => !a.result.relayError);

  if (success) {
    const { lastItemDate } = success.result;
    if (lastItemDate && daysSince(lastItemDate) > STALE_THRESHOLD_DAYS) {
      console.log(`     → ⏳ responde desde otra red pero está desactualizado (último item ${shortDate(lastItemDate)}): no es un problema de red`);
      counters.stale.push(label);
      return;
    }
    console.log('     → 🌐 el feed responde desde otra red: probable bloqueo o límite de red de esta máquina, no del sitio');
    counters.network.push(label);
    return;
  }

  if (!usable.length) {
    console.log('     → ❔ ningún relay disponible: no se puede concluir (reintenta o usa --relay con una plantilla propia)');
    counters.relayUnavailable.push(label);
    return;
  }

  console.log('     → 🔴 el feed no responde ni en local ni vía relay: es un fallo del sitio o del feed');
  counters.confirmed.push(label);
}

async function diagnoseFeed(site, feed, relays, { forceRelay, verbose }, counters) {
  const label = feedLabel(site, feed);
  console.log(`\n   🔍 ${feed.name} [${feed.status}]`);
  console.log(`     📎 ${feed.rss_url}`);

  const local = await checkFeedUrl(feed.rss_url);

  if (local.type) {
    const date = local.lastItemDate ? `, último ${shortDate(local.lastItemDate)}` : '';
    console.log(`     ✅ local: ${local.type}, ${local.itemCount} item${local.itemCount === 1 ? '' : 's'}${date}`);
    console.log('     → el feed responde ahora en local: el error anterior fue transitorio');
    counters.transient.push(label);
    return;
  }

  const connectionError = local.error === CONNECTION_ERROR && !local.code;
  console.log(`     ❌ local: ${formatError(local.error, local.code)}`);

  if (!connectionError && !forceRelay) {
    console.log('     → ⏭️  el error no es de conexión: la red local no es la causa (no se reintenta por relay)');
    counters.skipped.push(label);
    return;
  }

  const attempts = await tryRelays(feed.rss_url, relays, verbose);
  verdictFor(attempts, counters, label);
}

async function diagnoseUrl(url, relays, { verbose }) {
  console.log(`🔍 Diagnóstico de URL: ${url}\n`);
  const local = await checkFeedUrl(url);

  if (local.type) {
    console.log(`✅ local: feed válido (${local.type}, ${local.itemCount} item${local.itemCount === 1 ? '' : 's'})`);
    if (local.lastItemDate) console.log(`   último item: ${shortDate(local.lastItemDate)}`);
    console.log('\nℹ️  No requiere diagnóstico de red.');
    return;
  }

  console.log(`❌ local: ${formatError(local.error, local.code)}\n`);
  const attempts = await tryRelays(url, relays, verbose);
  const success = attempts.find(a => a.result.type);

  if (success) {
    console.log('\n🌐 El feed responde desde otra red: probable bloqueo o límite de red local.');
    return;
  }

  const probeRelay = attempts.find(a => !a.result.relayError)?.relay ?? relays[0];
  const reach = await checkReachabilityViaRelay(url, { relay: probeRelay, timeout: RELAY_TIMEOUT_MS });
  if (verbose && reach.relayUrl) console.log(`   ↳ ${reach.relayUrl}`);

  if (!reach.reachable) {
    console.log('\n🔴 El destino no responde ni en local ni vía relay.');
  } else if (reach.relayError) {
    console.log(`\n❔ El relay (${probeRelay.label}) no está disponible: no se puede concluir.`);
  } else {
    console.log(`\n⚠️  El destino responde vía relay (HTTP ${reach.status}) pero no entrega un feed válido.`);
  }
}

async function main() {
  const args = parseArgs(process.argv, [
    { flag: '--url', name: 'url', type: 'value' },
    { flag: '--status', name: 'status', type: 'value' },
    { flag: '--file', name: 'file', type: 'value' },
    { flag: '--relay', name: 'relay', type: 'value' },
    { flag: '--force-relay', name: 'forceRelay', type: 'bool' },
  ]);

  const { relays, invalid } = resolveRelayList(args.relay ?? DEFAULT_RELAY);
  if (invalid.length) {
    console.error(`❌ Error: relay no reconocido: ${invalid.join(', ')}`);
    console.error(`   Usa un preset (${Object.keys(RELAY_PRESETS).join(', ')}) o una plantilla con {url}/{urlRaw}`);
    process.exit(1);
  }

  if (args.url) {
    await diagnoseUrl(args.url, relays, args);
    return;
  }

  const statuses = (args.status ?? DEFAULT_STATUSES.join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const status of statuses) {
    if (!ALLOWED_STATUSES.includes(status)) {
      console.error(`❌ Error: --status requiere estados válidos (${ALLOWED_STATUSES.join(', ')})`);
      process.exit(1);
    }
  }

  const file = (args.file ?? 'all').toLowerCase();
  if (!['database', 'watchlist', 'all'].includes(file)) {
    console.error('❌ Error: --file requiere database, watchlist o all');
    process.exit(1);
  }

  const sources = [];
  if (file === 'database' || file === 'all') {
    sources.push({ label: 'database', sites: readJson(SOURCE_FILES.database).sites ?? [] });
  }
  if (file === 'watchlist' || file === 'all') {
    const watchlist = readJson(SOURCE_FILES.watchlist);
    sources.push({ label: 'watchlist', sites: Array.isArray(watchlist) ? watchlist : [] });
  }

  if (args.id && !sources.some(({ sites }) => sites.some(s => s.id === args.id))) {
    console.error(`❌ No se encontró ningún sitio con ID "${args.id}"`);
    process.exit(1);
  }

  const candidates = sources.flatMap(({ label, sites }) =>
    sites
      .filter(site => !args.id || site.id === args.id)
      .flatMap(site => (site.feeds ?? [])
        .filter(feed => feed.rss_url && statuses.includes(feed.status))
        .map(feed => ({ id: feed.id, site, feed, source: label })))
  );

  // Los filtros de rango (--start-id, --from, --to, --limit) operan sobre la
  // lista de feeds candidatos, no sobre los sitios. --id filtra por site-id.
  const selected = applyFilters(candidates, { ...args, id: null });

  const grouped = [];
  const bySite = new Map();
  for (const entry of selected) {
    const key = `${entry.source}:${entry.site.id}`;
    let group = bySite.get(key);
    if (!group) {
      group = { site: entry.site, source: entry.source, feeds: [] };
      bySite.set(key, group);
      grouped.push(group);
    }
    group.feeds.push(entry.feed);
  }

  const counters = { transient: [], network: [], confirmed: [], relayUnavailable: [], stale: [], skipped: [] };
  let evaluated = 0;

  console.log(`🔍 Diagnóstico de red sobre ${selected.length} feed${selected.length === 1 ? '' : 's'} en ${grouped.length} sitio${grouped.length === 1 ? '' : 's'}`);
  console.log(`   Estados: ${statuses.join(', ')}`);
  console.log(`   Relay(s): ${relays.map(r => r.label).join(' → ')}${args.forceRelay ? ' (forzado a todos los errores)' : ''}`);
  console.log(`   Modo solo lectura: no se modifica ningún archivo.`);
  console.log('='.repeat(55));

  for (const { site, source, feeds } of grouped) {
    console.log(`\n📌 ${site.name} (${source}) — ${feeds.length} feed${feeds.length > 1 ? 's' : ''} en revisión`);
    for (const feed of feeds) {
      evaluated++;
      await diagnoseFeed(site, feed, relays, args, counters);
    }
  }

  console.log('\n' + '='.repeat(55));
  if (evaluated === 0) {
    console.log(`🏁 No hay feeds en los estados consultados (${statuses.join(', ')}) para el rango indicado.`);
    return;
  }

  const summary = [
    ['🌐 Probable red local ', counters.network],
    ['⏳ Vivo pero antiguo ', counters.stale],
    ['✅ Responde ahora    ', counters.transient],
    ['🔴 Fallo confirmado  ', counters.confirmed],
    ['❔ Relay no disponible', counters.relayUnavailable],
    ['⏭️  No aplica         ', counters.skipped],
  ];
  console.log(`\nFeeds evaluados: ${evaluated}`);
  for (const [name, list] of summary) {
    if (!list.length) continue;
    console.log(`${name}: ${list.length}`);
    for (const item of list) console.log(`   • ${item}`);
  }

  if (counters.network.length) {
    console.log('\nℹ️  Los feeds marcados "probable red local" responden desde otra red:');
    console.log('   revísalos antes de marcarlos offline con `pnpm validate -- --update`.');
  }
  console.log('\nℹ️  Los resultados vía relay son informativos (un relay puede alterar el contenido):');
  console.log('   este script no escribe estados en feeds-database.json ni watchlist.json.');
}

main().catch(err => {
  console.error('❌ Error inesperado:', err);
  process.exit(1);
});
