import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, applyFilters } from '../../lib/cli-args.js'
import { recalculateTotalFeeds } from '../../lib/feed-utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

const EXCLUDED_DOMAINS = new Set([
  'mastodon.cl',
  'reddit.com',
  'news.google.com',
  'youtube.com',
  'youtu.be',
  'discord.com',
  'discord.gg',
  't.me',
  'telegram.org',
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'tiktok.com',
  'twitch.tv',
  'whatsapp.com',
  'bsky.app',
  'bsky.social',
])

function getDomain(url) {
  try {
    let u = new URL(url)
    let host = u.hostname
    if (host.startsWith('www.')) host = host.slice(4)
    return host
  } catch {
    return null
  }
}

function isExcluded(url) {
  const domain = getDomain(url)
  if (!domain) return true
  return EXCLUDED_DOMAINS.has(domain)
}

function buildSubfeeds(entry, domain) {
  const siteId = entry.id
  const siteName = entry.name
  const lastChecked = new Date().toISOString()
  const feeds = []

  const googleFeed = {
    id: siteId + '-proxy-google-news',
    name: siteName + ' [Proxy Google News]',
    rss_url: `https://news.google.com/rss/search?q=site:${domain}&hl=es-419&gl=CL&ceid=CL:es-419`,
    url: `https://news.google.com/search?q=site:${domain}&hl=es-419&gl=CL&ceid=CL:es-419`,
    feed_type: 'RSS',
    description: `Resultados de site:${domain} en Proxy Google News de noticias Chilenas`,
    last_checked: lastChecked,
    last_known_item_date: null,
    status: 'active',
    verified: true,
  }

  const bingFeed = {
    id: siteId + '-proxy-bing-news',
    name: siteName + ' [Proxy Bing News]',
    rss_url: `https://www.bing.com/news/search?q=site:${domain}&format=RSS`,
    url: `https://www.bing.com/news/search?q=site:${domain}`,
    feed_type: 'RSS',
    description: `Resultados de site:${domain} en Proxy Bing News`,
    last_checked: lastChecked,
    last_known_item_date: null,
    status: 'active',
    verified: true,
  }

  feeds.push({ feed: googleFeed, type: 'google' })
  feeds.push({ feed: bingFeed, type: 'bing' })
  return feeds
}

// ─── Arg parsing ───────────────────────────────────────────────────────────

const args = parseArgs(process.argv, [
  { flag: '--file', name: 'fileMode', type: 'value' },
  { flag: '--total-mode', name: 'totalMode', type: 'value' },
])

const isDryRun = args.dryRun
const fileMode = args.fileMode || 'all'
const totalMode = args.totalMode || 'delta'

// ─── Arg validation ────────────────────────────────────────────────────────

if (!['database', 'watchlist', 'all'].includes(fileMode)) {
  console.error('❌ Error: --file debe ser database, watchlist o all')
  process.exit(1)
}

if (!['delta', 'recalculate'].includes(totalMode)) {
  console.error('❌ Error: --total-mode debe ser delta o recalculate')
  process.exit(1)
}

// ─── Load data ─────────────────────────────────────────────────────────────

const DB_PATH = path.join(ROOT, 'feeds-database.json')
const WATCHLIST_PATH = path.join(ROOT, 'watchlist.json')

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
const watchlist = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'))

// ─── Build entry list ──────────────────────────────────────────────────────

let entries = []

if (fileMode === 'all' || fileMode === 'database') {
  for (const site of db.sites) {
    entries.push({ entry: site, feeds: site.feeds, source: 'database' })
  }
}

if (fileMode === 'all' || fileMode === 'watchlist') {
  for (const entry of watchlist) {
    entries.push({ entry, feeds: entry.feeds, source: 'watchlist' })
  }
}

// ─── Apply filters ─────────────────────────────────────────────────────────

const entriesWithIndex = entries.map((e, i) => ({ ...e, id: e.entry.id, _index: i }));
let filtered = applyFilters(entriesWithIndex, args);

if (filtered.length === 0 && (args.id || args.startId || args.from !== null || args.to !== null || args.limit !== null)) {
  console.log('🏁 No hay entradas en el rango especificado.');
  process.exit(0);
}

// Rebuild entries from filtered, preserving original order/identity
const filteredSet = new Set(filtered.map(e => e._index));
entries = entries.filter((_, i) => filteredSet.has(i));

// ─── Process entries ───────────────────────────────────────────────────────

const counts = {
  database: { eligible: 0, excluded: 0, alreadyBoth: 0, addedGoogle: 0, addedBing: 0, processed: 0 },
  watchlist: { eligible: 0, excluded: 0, alreadyBoth: 0, addedGoogle: 0, addedBing: 0, processed: 0 },
}

const eligibleSet = new Set()

for (const { entry, feeds, source } of entries) {
  counts[source].eligible++

  if (isExcluded(entry.url)) {
    counts[source].excluded++
    continue
  }

  const hasGoogle = feeds.some(f => f.id === entry.id + '-google-news')
  const hasBing = feeds.some(f => f.id === entry.id + '-bing-news')

  if (hasGoogle && hasBing) {
    counts[source].alreadyBoth++
    continue
  }

  // Build and add missing subfeeds
  const domain = getDomain(entry.url)
  const newFeeds = buildSubfeeds(entry, domain)

  for (const { feed, type } of newFeeds) {
    const already = type === 'google' ? hasGoogle : hasBing
    if (!already) {
      feeds.push(feed)
      counts[source][type === 'google' ? 'addedGoogle' : 'addedBing']++
    }
  }

  counts[source].processed++
  if (source === 'database') eligibleSet.add(entry.id)
}

const totalAdded = counts.database.addedGoogle + counts.database.addedBing +
                   counts.watchlist.addedGoogle + counts.watchlist.addedBing

// ─── Update total_feeds ────────────────────────────────────────────────────

let dbDelta = counts.database.addedGoogle + counts.database.addedBing

if (totalMode === 'recalculate') {
  const oldTotal = db.total_feeds
  const newTotal = recalculateTotalFeeds(db)
  dbDelta = newTotal - oldTotal
} else {
  db.total_feeds += dbDelta
}

// ─── Report ────────────────────────────────────────────────────────────────

if (isDryRun) {
  console.log('🔍 Dry-run mode — no se modificarán archivos\n')
}

function fmt(s) {
  return s === 'database' ? 'feeds-database.json' : 'watchlist.json'
}

for (const src of ['database', 'watchlist']) {
  const c = counts[src]
  console.log(`${fmt(src)}:`)
  console.log(`  → ${c.eligible} entradas elegibles`)
  console.log(`  → ${c.excluded} excluidas (dominio en lista de exclusión)`)
  console.log(`  → ${c.alreadyBoth} ya tienen ambos subfeeds`)
  if (c.addedGoogle || c.addedBing) {
    console.log(`  → ${c.processed} procesadas (Google News: +${c.addedGoogle}, Bing News: +${c.addedBing})`)
  } else {
    console.log(`  → 0 subfeeds nuevos por agregar`)
  }
  console.log()
}

if (dbDelta !== 0) {
  if (totalMode === 'recalculate') {
    console.log(`total_feeds recalculado a ${db.total_feeds} (${dbDelta >= 0 ? '+' : ''}${dbDelta})`)
  } else {
    console.log(`total_feeds: ${db.total_feeds - dbDelta} → ${db.total_feeds} (${dbDelta >= 0 ? '+' : ''}${dbDelta})`)
  }
  console.log()
}

if (totalAdded === 0) {
  console.log('✅ Todo al día — ningún subfeed faltante')
} else {
  console.log(`📦 ${totalAdded} subfeeds agregados (${counts.database.addedGoogle + counts.database.addedBing} en database, ${counts.watchlist.addedGoogle + counts.watchlist.addedBing} en watchlist)`)
}

// ─── Write files ──────────────────────────────────────────────────────────

const needsDbWrite = totalAdded > 0 || (totalMode === 'recalculate')
const needsWlWrite = counts.watchlist.addedGoogle + counts.watchlist.addedBing > 0

if (isDryRun || (!needsDbWrite && !needsWlWrite)) {
  process.exit(0)
}

if (needsDbWrite) fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n')
if (needsWlWrite) fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(watchlist, null, 2) + '\n')

const written = []
if (needsDbWrite) written.push(fmt('database'))
if (needsWlWrite) written.push(fmt('watchlist'))
console.log(`\n✅ Archivos actualizados: ${written.join(', ')}`)
