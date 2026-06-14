#!/usr/bin/env node

/**
 * discover-category-feeds.js
 *
 * Descubre feeds por categoría en sitios WordPress (y otros CMS).
 * Para cada sitio, intenta obtener las categorías vía WP REST API,
 * construye URLs `/category/{slug}/feed/`, las valida, y opcionalmente
 * las agrega a feeds-database.json.
 *
 * Uso:
 *   node scripts/utils/discover-category-feeds.js                  # todos los sitios
 *   node scripts/utils/discover-category-feeds.js --id el-ciudadano # un sitio
 *   node scripts/utils/discover-category-feeds.js --start-id x --limit 10
 *   node scripts/utils/discover-category-feeds.js --from 5 --to 15
 *   node scripts/utils/discover-category-feeds.js --min-posts 5    # solo categorías con ≥ N posts
 *   node scripts/utils/discover-category-feeds.js --update          # escribe en feeds-database.json
 *   node scripts/utils/discover-category-feeds.js --dry-run         # solo vista previa
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { xmlParser, parseFeedXml } from '../../lib/feed-validator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const DB_PATH = path.join(ROOT, 'feeds-database.json')
const CATEGORIES_PATH = path.join(ROOT, 'categories.json')

const FETCH_TIMEOUT = 10000
const STALE_THRESHOLD_DAYS = 30

// ─── Arg parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const isUpdate = args.includes('--update')
const targetId = args.includes('--id') ? args[args.indexOf('--id') + 1] : null
const targetFrom = args.includes('--from') ? parseInt(args[args.indexOf('--from') + 1], 10) : null
const targetTo = args.includes('--to') ? parseInt(args[args.indexOf('--to') + 1], 10) : null
const targetLimit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : null
const targetStartId = args.includes('--start-id') ? args[args.indexOf('--start-id') + 1] : null
const minPosts = args.includes('--min-posts') ? parseInt(args[args.indexOf('--min-posts') + 1], 10) : 1

if (args.includes('--id') && (!targetId || targetId.startsWith('--'))) {
  console.error('❌ Error: --id requiere un valor (ID del sitio)')
  process.exit(1)
}

if (targetFrom !== null && targetTo !== null && targetFrom > targetTo) {
  console.error('❌ Error: --from no puede ser mayor que --to')
  process.exit(1)
}

// ─── Load data ────────────────────────────────────────────────────────────────

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
let sites = db.sites

// Build sets of all known feed URLs and IDs across the entire database (for dedup)
const allKnownFeedUrls = new Set(
  db.sites.flatMap(s => s.feeds.map(f => f.rss_url))
)
const allKnownFeedIds = new Set(
  db.sites.flatMap(s => s.feeds.map(f => f.id))
)

// ─── Apply filters ────────────────────────────────────────────────────────────

if (targetId) {
  sites = sites.filter(s => s.id === targetId)
  if (sites.length === 0) {
    console.error(`❌ No se encontró ningún sitio con ID "${targetId}"`)
    process.exit(1)
  }
}

if (targetStartId) {
  const startIdx = sites.findIndex(s => s.id === targetStartId)
  if (startIdx === -1) {
    console.error(`❌ No se encontró ningún sitio con ID "${targetStartId}"`)
    process.exit(1)
  }
  sites = sites.slice(startIdx)
}

if (targetFrom !== null) sites = sites.slice(targetFrom)
if (targetTo !== null) sites = sites.slice(0, targetTo + 1)
if (targetLimit !== null) sites = sites.slice(0, targetLimit)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toTitleCase(text) {
  return text.toLowerCase()
    .split(/[\s-]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[áäàãâ]/g, 'a').replace(/[éëèê]/g, 'e')
    .replace(/[íïìî]/g, 'i').replace(/[óöòõô]/g, 'o')
    .replace(/[úüùû]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

const categories = JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf8'))

const SLUG_CATEGORY = {}
for (const [catKey, catVal] of Object.entries(categories)) {
  for (const slug of catVal.slugs) {
    SLUG_CATEGORY[slug] = catKey
  }
}

function resolveCategory(slug) {
  return SLUG_CATEGORY[slug.replace(/-/g, '_')] || null
}

function findExistingSlugs(site) {
  const slugs = new Set()
  for (const f of site.feeds) {
    const m = f.rss_url.match(/\/category\/(.+?)\/feed\/?$/)
    if (m) slugs.add(m[1])
    const m2 = f.rss_url.match(/\/category\/(.+?)$/)
    if (m2 && !f.rss_url.endsWith('/feed/')) slugs.add(m2[1])
  }
  return slugs
}

function isExcludedFeed(site, rssUrl) {
  // Skip if any feed already has this exact URL (across all sites)
  return site.feeds.some(f => f.rss_url === rssUrl) || allKnownFeedUrls.has(rssUrl)
}

async function fetchJson(url) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FeedDiscoverer/1.0)' },
    })
    clearTimeout(t)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function testFeedUrl(url) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FeedDiscoverer/1.0)' },
    })
    clearTimeout(t)
    if (!res.ok) return { ok: false, status: res.status }

    // Track if the URL redirected to a different path
    const redirected = res.url !== url
      ? { redirectUrl: res.url, pathChanged: new URL(url).pathname.replace(/\/+$/, '') !== new URL(res.url).pathname.replace(/\/+$/, '') }
      : null

    const text = await res.text()
    const isRss = text.includes('<rss') || text.includes('<rdf:RDF')
    const isAtom = text.includes('<feed') && text.includes('xmlns=')
    const itemCount = (text.match(/<(item|entry)[^>]*>/gi) || []).length

    if ((isRss || isAtom) && itemCount > 0) {
      let lastItemDate = null
      try {
        const parsed = xmlParser.parse(text)
        const feedData = parseFeedXml(parsed, isRss ? 'RSS' : 'Atom')
        if (feedData) lastItemDate = feedData.lastItemDate
      } catch {}
      return { ok: true, status: res.status, type: isRss ? 'RSS' : 'Atom', items: itemCount, lastItemDate, ...(redirected?.pathChanged ? { redirectUrl: redirected.redirectUrl } : {}) }
    }
    if ((isRss || isAtom) && itemCount === 0) {
      return { ok: false, status: res.status, reason: 'feed vacío' }
    }
    return { ok: false, status: res.status, reason: 'no es feed XML válido' }
  } catch (e) {
    return { ok: false, status: 0, reason: e.message }
  }
}

const EXCLUDED_SITEMAP_SEGMENTS = new Set([
  'about', 'about-us', 'acerca', 'acerca-de', 'contact', 'contacto',
  'privacy', 'privacy-policy', 'politica-de-privacidad', 'terms', 'terms-of-service',
  'faq', 'faqs', 'help', 'ayuda', 'login', 'register', 'registro',
  'sitemap', 'sitemap.xml', 'feed', 'rss', 'wp-json', 'wp-admin', 'wp-content',
  'author', 'authors', 'tag', 'tags', 'page', 'pages', 'post', 'posts',
  'category', 'categories', 'search', 'buscar', 'comments', 'comment',
  '2024', '2025', '2026',
])

const NAV_SELECTORS = [
  'nav', 'header', '.menu', '#menu', '.navbar', '#navbar',
  '.nav-menu', '.navigation', '.nav', '.main-menu',
  '[role="navigation"]', '.site-nav', '.header-nav',
]

async function fetchText(url) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FeedDiscoverer/1.0)' },
    })
    clearTimeout(t)
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

function parseSitemapXml(text) {
  const urls = []
  const locRegex = /<loc[^>]*>([^<]+)<\/loc>/gi
  let m
  while ((m = locRegex.exec(text)) !== null) {
    urls.push(m[1].trim())
  }
  return urls
}

function extractSectionFromUrl(url, baseUrl) {
  try {
    const u = new URL(url)
    const base = new URL(baseUrl)
    if (u.hostname !== base.hostname) return null

    const path = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
    if (path.length === 0) return null

    const segment = path[0].toLowerCase()
    if (EXCLUDED_SITEMAP_SEGMENTS.has(segment)) return null
    // Skip if it looks like a single post (has file extension or numeric ID)
    if (segment.match(/^\d+$/) || segment.match(/\.\w+$/)) return null
    // Skip if too long (likely a post slug, not a section)
    if (segment.length > 30) return null

    return segment
  } catch {
    return null
  }
}

/**
 * Phase 1: Try to discover section feeds via sitemap.
 */
async function discoverSitemapSections(siteUrl) {
  const baseUrl = siteUrl.replace(/\/+$/, '')
  const sitemapUrls = [
    `${baseUrl}/sitemap.xml`,
    `${baseUrl}/sitemap_index.xml`,
    `${baseUrl}/sitemap/`,
  ]

  for (const url of sitemapUrls) {
    const text = await fetchText(url)
    if (!text) continue

    const urls = parseSitemapXml(text)
    if (urls.length === 0) continue

    const sections = new Set()
    for (const u of urls) {
      const seg = extractSectionFromUrl(u, baseUrl)
      if (seg) sections.add(seg)
    }

    if (sections.size > 0) return [...sections]
  }
  return null
}

/**
 * Phase 2: Try to discover section feeds by scraping nav elements from homepage.
 */
async function discoverNavbarSections(siteUrl) {
  const baseUrl = siteUrl.replace(/\/+$/, '')
  const html = await fetchText(baseUrl)
  if (!html) return null

  const navLinks = new Set()

  // Try to find nav elements first, extract all internal links
  for (const sel of NAV_SELECTORS) {
    // Find nav container by selector pattern
    const navPattern = new RegExp(`<${sel.replace(/^[.#]/, '')}[^>]*>[\\s\\S]*?<\\/${sel.replace(/^[.#]/, '')}>`, 'i')
    // For class/ID selectors, use attribute selectors
    const attrPattern = sel.startsWith('.')
      ? new RegExp(`<[^>]+class="[^"]*${sel.slice(1)}[^"]*"[^>]*>[\\s\\S]*?<\\/[^>]+>`, 'i')
      : sel.startsWith('#')
        ? new RegExp(`<[^>]+id="${sel.slice(1)}"[^>]*>[\\s\\S]*?<\\/[^>]+>`, 'i')
        : null

    let navHtml = null
    if (navPattern) {
      const m = html.match(navPattern)
      if (m) navHtml = m[0]
    }
    if (!navHtml && attrPattern) {
      const m = html.match(attrPattern)
      if (m) navHtml = m[0]
    }

    if (navHtml) {
      const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>/gi
      let lm
      while ((lm = linkRegex.exec(navHtml)) !== null) {
        const href = lm[1]
        try {
          const url = new URL(href, baseUrl)
          if (url.hostname !== new URL(baseUrl).hostname) continue
          const path = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
          if (path.length === 0) continue
          const seg = path[0].toLowerCase()
          if (EXCLUDED_SITEMAP_SEGMENTS.has(seg)) continue
          if (seg.match(/\.\w+$/)) continue
          navLinks.add(seg)
        } catch {}
      }
    }
  }

  // Fallback: scan all internal links in HTML if nav-specific didn't find enough
  if (navLinks.size < 3) {
    const allLinks = html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>/gi)
    for (const m of allLinks) {
      try {
        const url = new URL(m[1], baseUrl)
        if (url.hostname !== new URL(baseUrl).hostname) continue
        const path = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
        if (path.length <= 1) continue
        const seg = path[0].toLowerCase()
        if (EXCLUDED_SITEMAP_SEGMENTS.has(seg)) continue
        if (seg.match(/^\d+$/)) continue
        if (seg.match(/\.\w+$/)) continue
        navLinks.add(seg)
      } catch {}
    }
  }

  return navLinks.size > 0 ? [...navLinks] : null
}

const FEED_PATTERNS = [
  (section) => `${section}/feed/`,
  (section) => `${section}/rss/`,
  (section) => `${section}?format=feed`,
  (section) => `${section}/rss.xml`,
  (section) => `${section}/atom.xml`,
  (section) => `feed/?category=${section}`,
]

/**
 * Try multiple feed URL patterns for a given section path.
 * For the last pattern (/feed/?category=X), rejects URLs that redirect to a
 * different path — those silently serve the site's main feed instead of a
 * category-specific one.
 */
async function discoverSectionFeed(baseUrl, section) {
  for (const [i, pattern] of FEED_PATTERNS.entries()) {
    const feedUrl = `${baseUrl}/${pattern(section)}`
    // Skip if this exact URL already exists anywhere in the database
    if (allKnownFeedUrls.has(feedUrl)) continue
    const result = await testFeedUrl(feedUrl)
    if (result.ok) {
      // For /feed/?category=X, reject if it redirected to the main feed URL
      if (i === FEED_PATTERNS.length - 1 && result.redirectUrl) {
        redirectCount++
        console.log(`    ⚠ ${feedUrl} → ${result.redirectUrl}\n       (redirige al feed principal, se rechazó)`)
        return null
      }
      return { url: feedUrl, ...result }
    }
  }
  return null
}

/**
 * Try multiple WP REST API base paths to discover categories.
 */
async function discoverWpCategories(siteUrl) {
  const baseUrl = siteUrl.replace(/\/+$/, '')
  const wpPaths = [
    `${baseUrl}/wp-json/wp/v2/categories?per_page=50&orderby=count&order=desc&hide_empty=true`,
    `${baseUrl}/index.php/wp-json/wp/v2/categories?per_page=50&orderby=count&order=desc&hide_empty=true`,
  ]

  for (const apiUrl of wpPaths) {
    const data = await fetchJson(apiUrl)
    if (Array.isArray(data) && data.length > 0) {
      return data.map(c => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        count: c.count || 0,
        parent: c.parent || 0,
      }))
    }
  }
  return null
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let redirectCount = 0  // module-level, accessed from testFeedUrl

;(async () => {
  let totalNew = 0
  let wpApiFound = 0
  let fallbackFound = 0

  console.log(`🔍 Descubriendo feeds por categoría en ${sites.length} sitios...\n`)

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]
    process.stdout.write(`[${i + 1}/${sites.length}] ${site.id}... `)

    // Skip Google News / Bing News proxy sites — they have no actual categories
    if (!site.url || site.url.includes('news.google.com') || site.url.includes('bing.com')) {
      process.stdout.write('⏭ sin url\n')
      continue
    }

    const baseUrl = site.url.replace(/\/+$/, '')
    const discovered = []
    let wpDiscovered = false

    // Phase 0: WordPress REST API
    const categories = await discoverWpCategories(site.url)
    if (categories && categories.length > 0) {
      wpApiFound++
      const relevant = categories.filter(c => c.count >= minPosts && c.slug !== 'uncategorized' && c.slug !== 'sin-categoria')

      if (relevant.length > 0) {
        for (const cat of relevant) {
          const feedUrl = `${baseUrl}/category/${cat.slug}/feed/`
          if (isExcludedFeed(site, feedUrl)) continue

          const result = await testFeedUrl(feedUrl)
          if (result.ok) {
            const catName = toTitleCase(cat.name)
            const feedId = `${site.id}-${cat.slug}`
            if (allKnownFeedIds.has(feedId)) continue
            allKnownFeedIds.add(feedId)
            discovered.push({
              id: feedId,
              name: `${site.name} - ${catName}`,
              rss_url: feedUrl,
              feed_type: result.type,
              description: `Feed de la categor\u00EDa '${catName}' en ${site.name}`,
              feed_category: resolveCategory(cat.slug),
              items: result.items,
              lastItemDate: result.lastItemDate,
            })
            wpDiscovered = true
          }
        }
      }
    }

    // Phase 1: Sitemap (if WP API found nothing or had no relevant categories)
    if (discovered.length === 0) {
      const sections = await discoverSitemapSections(site.url)
      if (sections && sections.length > 0) {
        for (const section of sections) {
          if (isExcludedFeed(site, `${baseUrl}/${section}/feed/`) && isExcludedFeed(site, `${baseUrl}/${section}/rss/`)) continue

          const feed = await discoverSectionFeed(baseUrl, section)
          if (feed) {
            const sectionName = toTitleCase(section.replace(/-/g, ' '))
            const feedId = `${site.id}-${section}`
            if (allKnownFeedIds.has(feedId)) continue
            allKnownFeedIds.add(feedId)
            discovered.push({
              id: feedId,
              name: `${site.name} - ${sectionName}`,
              rss_url: feed.url,
              feed_type: feed.type,
              description: `Feed de la secci\u00F3n '${sectionName}' en ${site.name}`,
              feed_category: resolveCategory(section),
              items: feed.items,
              lastItemDate: feed.lastItemDate,
            })
          }
        }
        if (discovered.length > 0) fallbackFound++
      }
    }

    // Phase 2: Navbar scraping (if sitemap found nothing)
    if (discovered.length === 0) {
      const sections = await discoverNavbarSections(site.url)
      if (sections && sections.length > 0) {
        for (const section of sections) {
          if (isExcludedFeed(site, `${baseUrl}/${section}/feed/`) && isExcludedFeed(site, `${baseUrl}/${section}/rss/`)) continue

          const feed = await discoverSectionFeed(baseUrl, section)
          if (feed) {
            const sectionName = toTitleCase(section.replace(/-/g, ' '))
            const feedId = `${site.id}-${section}`
            if (allKnownFeedIds.has(feedId)) continue
            allKnownFeedIds.add(feedId)
            discovered.push({
              id: feedId,
              name: `${site.name} - ${sectionName}`,
              rss_url: feed.url,
              feed_type: feed.type,
              description: `Feed de la secci\u00F3n '${sectionName}' en ${site.name}`,
              feed_category: resolveCategory(section),
              items: feed.items,
              lastItemDate: feed.lastItemDate,
            })
          }
        }
        if (discovered.length > 0) fallbackFound++
      }
    }

    if (discovered.length === 0) {
      if (categories && categories.length > 0) {
        process.stdout.write('⏭ sin feeds nuevos\n')
      } else if (!categories) {
        process.stdout.write('⏭ sin feeds detectados\n')
      } else {
        process.stdout.write('⏭ sin secciones relevantes\n')
      }
      continue
    }

    totalNew += discovered.length
    const sourceLabel = wpDiscovered ? 'WP' : 'fallback'
    process.stdout.write(`✅ ${discovered.length} feeds (${sourceLabel})\n`)

    for (const d of discovered) {
      const lastChecked = new Date().toISOString()
      const feedObj = {
        id: d.id,
        name: d.name,
        rss_url: d.rss_url,
        description: d.description,
        feed_type: d.feed_type,
      }
      if (d.feed_category) feedObj.category = d.feed_category
      feedObj.last_checked = lastChecked
      feedObj.last_known_item_date = d.lastItemDate || lastChecked

      // Staleness check: if the most recent item is older than 30 days, mark as stale
      let isStale = false
      if (d.lastItemDate) {
        const daysSince = (Date.now() - new Date(d.lastItemDate).getTime()) / (1000 * 60 * 60 * 24)
        if (daysSince > STALE_THRESHOLD_DAYS) isStale = true
      }
      feedObj.status = isStale ? 'stale' : 'active'
      feedObj.verified = true

      const catLabel = d.feed_category ? ` [${d.feed_category}]` : ''
      const staleLabel = isStale ? ` ⚠️  STALE (${d.lastItemDate?.slice(0, 10)})` : ''
      console.log(`     📦 ${d.id} → ${d.rss_url}${catLabel} (${d.items} items)${staleLabel}`)

      if (isUpdate && !isDryRun) {
        site.feeds.push(feedObj)
      }
    }
  }

  // ─── Report ──────────────────────────────────────────────────────────────────

  const redirectNote = redirectCount > 0 ? `, ${redirectCount} rechazado(s) por redirección` : ''
  const summary = `\n📊 Resumen: ${totalNew} feeds descubiertos (${wpApiFound} WP API, ${fallbackFound} fallback${redirectNote})`

  if (isDryRun) {
    console.log(summary)
    console.log('🔍 Dry-run — no se modificó ningún archivo')
    process.exit(0)
  }

  if (totalNew === 0) {
    console.log(summary)
    console.log('✅ Todo al día — ningún feed nuevo por agregar')
    process.exit(0)
  }

  // ─── Update total_feeds ──────────────────────────────────────────────────────

  const activeCount = db.sites.reduce((sum, s) =>
    sum + s.feeds.filter(f => f.status === 'active' && f.verified === true).length, 0
  )
  db.total_feeds = activeCount
  db.last_updated = new Date().toISOString()

  if (isUpdate) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n', 'utf8')
    console.log(summary)
    console.log(`✅ feeds-database.json actualizado — ${db.sites.length} sitios, ${activeCount} feeds activos`)
  } else {
    console.log(summary)
    console.log('ℹ️  Usa --update para escribir los cambios en feeds-database.json')
  }
})()
