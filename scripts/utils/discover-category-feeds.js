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
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { checkFeedUrl, fetchSafe } from '../../lib/feed-validator.js'
import { pathsMatch, daysSince, STALE_THRESHOLD_DAYS, recalculateTotalFeeds } from '../../lib/feed-utils.js'
import { parseArgs, applyFiltersSites } from '../../lib/cli-args.js'
import { isAutomatic } from '../../lib/prompter.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const DB_PATH = path.join(ROOT, 'feeds-database.json')
const CATEGORIES_PATH = path.join(ROOT, 'categories.json')

const args = parseArgs(process.argv)
const minPosts = process.argv.slice(2).includes('--min-posts')
  ? parseInt(process.argv.slice(2)[process.argv.slice(2).indexOf('--min-posts') + 1], 10) : 1

const isDryRun = args.dryRun
const isUpdate = args.update

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

sites = applyFiltersSites(sites, args)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
}

function toTitleCase(text) {
  return decodeHtmlEntities(text).toLowerCase()
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
  return SLUG_CATEGORY[slug.replace(/_/g, '-')] || null
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
  const res = await fetchSafe(url)
  if (!res) return null
  if (!res.ok) {
    const noWww = url.replace('://www.', '://')
    if (noWww !== url) return await fetchJson(noWww)
    return null
  }
  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('json')) return null
  try {
    return await res.json()
  } catch {
    return null
  }
}

async function testFeedUrl(url) {
  const result = await checkFeedUrl(url);
  if (!result) return { ok: false, status: 0, reason: 'no responde' };

  const redirectInfo = result.redirectUrl ? { redirectUrl: result.redirectUrl } : {};

  if (result.type && result.itemCount > 0) {
    return {
      ok: true,
      status: 200,
      type: result.type,
      items: result.itemCount,
      lastItemDate: result.lastItemDate || null,
      selfLink: result.selfLink || null,
      ...redirectInfo,
    };
  }

  if (result.type && result.itemCount === 0) {
    return { ok: false, status: 200, reason: 'feed vacío' };
  }

  const reason = result.error || 'error desconocido';
  if (reason === 'HTML (no es feed)') {
    return { ok: false, status: result.code ?? 0, reason: 'no es feed XML válido', ...redirectInfo };
  }
  return { ok: false, status: result.code ?? 0, reason, ...redirectInfo };
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
  const res = await fetchSafe(url)
  if (!res) return null
  if (!res.ok) {
    const noWww = url.replace('://www.', '://')
    if (noWww !== url) return await fetchText(noWww)
    return null
  }
  return await res.text()
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
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return null

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
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./, '')
  let html = await fetchText(baseUrl)
  let wwwWarned = false

  // Retry with alternative www/bare domain if no response
  if (!html) {
    const altUrl = baseUrl.includes('://www.')
      ? baseUrl.replace('://www.', '://')
      : baseUrl.replace('://', '://www.')
    if (altUrl !== baseUrl) {
      html = await fetchText(altUrl)
      if (html) {
        const dir = baseUrl.includes('://www.') ? 'quitando' : 'agregando'
        console.warn(`  ⚠️  ${baseUrl} no responde, pero ${altUrl} sí. Considera actualizar site.url ${dir} www`)
        wwwWarned = true
      }
    }
  }
  if (!html) return null

  const navLinks = new Set()

  // Try to find nav elements first, extract all internal links
  for (const sel of NAV_SELECTORS) {
    let navHtml = null

    if (sel.startsWith('[')) {
      // Attribute selector like [role="navigation"]
      const attrPart = sel.slice(1, -1)
      const re = new RegExp(`<[^>]+${attrPart}[^>]*>[\\s\\S]*?<\\/[^>]+>`, 'i')
      const m = html.match(re)
      if (m) navHtml = m[0]
    } else {
      // Tag or class/ID selector
      const navPattern = sel.startsWith('.') || sel.startsWith('#')
        ? null
        : new RegExp(`<${sel}[^>]*>[\\s\\S]*?<\\/${sel}>`, 'i')
      const attrPattern = sel.startsWith('.')
        ? new RegExp(`<[^>]+class="[^"]*${sel.slice(1)}[^"]*"[^>]*>[\\s\\S]*?<\\/[^>]+>`, 'i')
        : sel.startsWith('#')
          ? new RegExp(`<[^>]+id="${sel.slice(1)}"[^>]*>[\\s\\S]*?<\\/[^>]+>`, 'i')
          : null

      if (navPattern) {
        const m = html.match(navPattern)
        if (m) navHtml = m[0]
      }
      if (!navHtml && attrPattern) {
        const m = html.match(attrPattern)
        if (m) navHtml = m[0]
      }
    }

    if (navHtml) {
      const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>/gi
      let lm
      while ((lm = linkRegex.exec(navHtml)) !== null) {
        const href = lm[1]
        try {
          const url = new URL(href, baseUrl)
          if (url.hostname.replace(/^www\./, '') !== baseHost) continue
          const path = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
          if (path.length === 0) continue
          const seg = path[0].toLowerCase()
          if (EXCLUDED_SITEMAP_SEGMENTS.has(seg)) continue
          if (seg.match(/\.\w+$/)) continue
          if (seg.length > 25) continue
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
        if (url.hostname.replace(/^www\./, '') !== baseHost) continue
        const path = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
        if (path.length === 0) continue
        const seg = path[0].toLowerCase()
        if (EXCLUDED_SITEMAP_SEGMENTS.has(seg)) continue
        if (seg.match(/^\d+$/)) continue
        if (seg.match(/\.\w+$/)) continue
        if (seg.length > 25) continue
        navLinks.add(seg)
      } catch {}
    }
  }

  return navLinks.size > 0 ? [...navLinks] : null
}

/**
 * Interactive section selection. Shows a numbered list and lets the user
 * exclude sections by index before testing (e.g. to skip article URLs).
 * @param {string[]} sections
 * @returns {Promise<string[]>} sections to test
 */
async function promptForSections(sections) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    console.log('')
    for (let i = 0; i < sections.length; i++) {
      console.log(`     ${(i + 1).toString().padStart(2)}. ${sections[i]}`)
    }
    console.log('')

    rl.question('   ¿Excluir alguna? (números separados por coma, ej: 1,3-5,10) o Enter para probar todas: ', (answer) => {
      rl.close()
      answer = answer.trim()
      if (!answer) {
        resolve(sections)
        return
      }

      const excludeIndices = new Set()
      for (let part of answer.split(',')) {
        part = part.trim()
        if (part.includes('-')) {
          const [a, b] = part.split('-').map(n => parseInt(n.trim(), 10))
          if (!isNaN(a) && !isNaN(b)) {
            for (let i = a; i <= b; i++) excludeIndices.add(i - 1)
          }
        } else {
          const n = parseInt(part, 10)
          if (!isNaN(n)) excludeIndices.add(n - 1)
        }
      }

      const filtered = sections.filter((_, i) => !excludeIndices.has(i))
      if (filtered.length < sections.length) {
        console.log(`   → probando ${filtered.length} secciones (${sections.length - filtered.length} excluidas)`)
      }
      resolve(filtered)
    })
  })
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
      // Self-link check: verify the feed serves content for the requested section
      if (result.selfLink) {
        if (!pathsMatch(feedUrl, result.selfLink)) {
          console.log(`    ⚠ ${feedUrl} → self-link: ${result.selfLink}\n       (no coincide con la sección solicitada, se rechazó)`)
          continue
        }
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
        link: c.link || null,
      }))
    }
  }
  return null
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let redirectCount = 0  // module-level, accessed from testFeedUrl

;(async () => {
  let totalNew = 0
  let wpSections = 0
  let wpFeeds = 0
  let sitemapSections = 0
  let sitemapFeeds = 0
  let navbarSections = 0
  let navbarFeeds = 0

  console.log(`🔍 Descubriendo feeds por categoría en ${sites.length} sitios...\n`)

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]
    process.stdout.write(`[${i + 1}/${sites.length}] ${site.id}...`)

    // Skip Google News / Bing News proxy sites — they have no actual categories
    if (!site.url || site.url.includes('news.google.com') || site.url.includes('bing.com')) {
      process.stdout.write(' ⏭ sin url\n')
      continue
    }

    const baseUrl = site.url.replace(/\/+$/, '')
    const discovered = []
    // Phase 0: WordPress REST API
    process.stdout.write('\n  ⏳ consultando API WP...')
    const categories = await discoverWpCategories(site.url)
    if (categories && categories.length > 0) {
      const relevant = categories.filter(c => c.count >= minPosts && c.slug !== 'uncategorized' && c.slug !== 'sin-categoria')

      if (relevant.length > 0) {
        process.stdout.write(` 📡 ${relevant.length} categorías con ≥${minPosts} posts\n`)
        for (const cat of relevant) {
          wpSections++
          let catLink
          if (cat.link) {
            try {
              const catDomain = new URL(cat.link).hostname.replace(/^www\./, '')
              const siteDomain = new URL(baseUrl).hostname.replace(/^www\./, '')
              catLink = catDomain === siteDomain ? cat.link : null
            } catch {
              catLink = null
            }
          }
          if (!catLink) {
            catLink = `${baseUrl}/category/${cat.slug}/`
          }
          const feedUrl = `${catLink.replace(/\/+$/, '')}/feed/`

          process.stdout.write(`  · ${cat.slug.padEnd(25)}`)
          if (isExcludedFeed(site, feedUrl)) {
            process.stdout.write(`ya existe\n`)
            continue
          }

          const result = await testFeedUrl(feedUrl)
          if (result.ok) {
            // Verify self-link matches the requested category feed
            if (result.selfLink) {
              if (!pathsMatch(feedUrl, result.selfLink)) {
                process.stdout.write(`✗ feed principal (self-link: ${result.selfLink})\n`)
                continue
              }
            }
            const catName = toTitleCase(cat.name)
            const feedId = `${site.id}-${cat.slug}`
            if (allKnownFeedIds.has(feedId)) {
              process.stdout.write(`id duplicado, se omite\n`)
              continue
            }
            allKnownFeedIds.add(feedId)
            const catPageUrl = catLink.replace(/\/+$/, '') + '/'
            discovered.push({
              id: feedId,
              name: `${site.name} - ${catName}`,
              rss_url: feedUrl,
              pageUrl: catPageUrl,
              feed_type: result.type,
              description: `Feed de la categor\u00EDa '${catName}' en ${site.name}`,
              feed_category: resolveCategory(cat.slug),
              items: result.items,
              lastItemDate: result.lastItemDate,
            })
            wpFeeds++
            process.stdout.write(`✓ ${result.type} (${result.items} items)\n`)
          } else {
            process.stdout.write(`✗ ${result.reason || `HTTP ${result.status}`}\n`)
          }
        }
      } else {
        process.stdout.write(` 📡 ${categories.length} categorías, ninguna con ≥${minPosts} posts\n`)
      }
    } else {
      process.stdout.write(` ${categories ? 'sin categorías relevantes' : '✗ no disponible'}\n`)
    }

    // Phase 1: Sitemap (if WP API found nothing or had no relevant categories)
    if (discovered.length === 0) {
      process.stdout.write('  ⏳ buscando sitemap...')
      const sections = await discoverSitemapSections(site.url)
      if (sections && sections.length > 0) {
        process.stdout.write(` 📄 ${sections.length} secciones\n`)
        for (const section of sections) {
          sitemapSections++
          process.stdout.write(`  · ${section.padEnd(25)}`)
          if (isExcludedFeed(site, `${baseUrl}/${section}/feed/`) && isExcludedFeed(site, `${baseUrl}/${section}/rss/`)) {
            process.stdout.write(`ya existe\n`)
            continue
          }

          const feed = await discoverSectionFeed(baseUrl, section)
          if (feed) {
            const sectionName = toTitleCase(section.replace(/-/g, ' '))
            const feedId = `${site.id}-${section}`
            if (allKnownFeedIds.has(feedId)) {
              process.stdout.write(`id duplicado, se omite\n`)
              continue
            }
            allKnownFeedIds.add(feedId)
            const sectionPageUrl = `${baseUrl}/${section}/`
            discovered.push({
              id: feedId,
              name: `${site.name} - ${sectionName}`,
              rss_url: feed.url,
              pageUrl: sectionPageUrl,
              feed_type: feed.type,
              description: `Feed de la secci\u00F3n '${sectionName}' en ${site.name}`,
              feed_category: resolveCategory(section),
              items: feed.items,
              lastItemDate: feed.lastItemDate,
            })
            sitemapFeeds++
            process.stdout.write(`✓ ${feed.type} (${feed.items} items)\n`)
          } else {
            process.stdout.write(`✗ sin feed\n`)
          }
        }
      } else {
        process.stdout.write(' ✗ no encontrado\n')
      }
    }

    // Phase 2: Navbar scraping (if sitemap found nothing)
    if (discovered.length === 0) {
      process.stdout.write('  ⏳ escaneando navegación...')
      const sections = await discoverNavbarSections(site.url)
      if (sections && sections.length > 0) {
        process.stdout.write(` 🧭 ${sections.length} secciones\n`)
        let sectionsToTest = sections
        if (!isAutomatic() && process.stdin.isTTY && sections.length > 5) {
          sectionsToTest = await promptForSections(sections)
        }
        if (sectionsToTest.length === 0) {
          process.stdout.write('   fase navbar saltada por el usuario\n')
          continue
        }
        for (const section of sectionsToTest) {
          navbarSections++
          process.stdout.write(`  · ${section.padEnd(25)}`)
          if (isExcludedFeed(site, `${baseUrl}/${section}/feed/`) && isExcludedFeed(site, `${baseUrl}/${section}/rss/`)) {
            process.stdout.write(`ya existe\n`)
            continue
          }

          const feed = await discoverSectionFeed(baseUrl, section)
          if (feed) {
            const sectionName = toTitleCase(section.replace(/-/g, ' '))
            const feedId = `${site.id}-${section}`
            if (allKnownFeedIds.has(feedId)) {
              process.stdout.write(`id duplicado, se omite\n`)
              continue
            }
            allKnownFeedIds.add(feedId)
            const sectionPageUrl = `${baseUrl}/${section}/`
            discovered.push({
              id: feedId,
              name: `${site.name} - ${sectionName}`,
              rss_url: feed.url,
              pageUrl: sectionPageUrl,
              feed_type: feed.type,
              description: `Feed de la secci\u00F3n '${sectionName}' en ${site.name}`,
              feed_category: resolveCategory(section),
              items: feed.items,
              lastItemDate: feed.lastItemDate,
            })
            navbarFeeds++
            process.stdout.write(`✓ ${feed.type} (${feed.items} items)\n`)
          } else {
            process.stdout.write(`✗ sin feed\n`)
          }
        }
      } else {
        process.stdout.write(' ✗ no encontrada\n')
      }
    }

    totalNew += discovered.length

    for (const d of discovered) {
      const lastChecked = new Date().toISOString()
      let isStale = false
      if (d.lastItemDate) {
        if (daysSince(d.lastItemDate) > STALE_THRESHOLD_DAYS) isStale = true
      }

      const feedObj = {
        id: d.id,
        name: d.name,
        rss_url: d.rss_url,
      }
      if (d.pageUrl) feedObj.url = d.pageUrl
      feedObj.description = d.description
      feedObj.feed_type = d.feed_type
      if (d.feed_category) feedObj.category = d.feed_category
      feedObj.last_checked = lastChecked
      feedObj.last_known_item_date = d.lastItemDate || lastChecked
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

  const redirectNote = redirectCount > 0 ? `, ${redirectCount} por redirección` : ''
  console.log(`\n📊 Resumen:`)
  console.log(`  API WP:   ${wpSections.toString().padStart(3)} secciones → ${wpFeeds} feeds`)
  console.log(`  Sitemap:  ${sitemapSections.toString().padStart(3)} secciones → ${sitemapFeeds} feeds`)
  console.log(`  Navbar:   ${navbarSections.toString().padStart(3)} secciones → ${navbarFeeds} feeds`)
  console.log(`  Total:    ${totalNew} feeds nuevos${redirectNote}`)

  if (isDryRun) {
    console.log('🔍 Dry-run — no se modificó ningún archivo')
    process.exit(0)
  }

  if (totalNew === 0) {
    console.log('✅ Todo al día — ningún feed nuevo por agregar')
    process.exit(0)
  }

  // ─── Update total_feeds ──────────────────────────────────────────────────────

  const activeCount = recalculateTotalFeeds(db)

  if (isUpdate) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n', 'utf8')
    console.log(`✅ feeds-database.json actualizado — ${db.sites.length} sitios, ${activeCount} feeds activos`)
  } else {
    console.log('ℹ️  Usa --update para escribir los cambios en feeds-database.json')
  }
})()
