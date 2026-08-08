# Awesome Chilean RSS — Agent Guide

> **This file is self-evolving.** Keep it updated as the project grows. Every agent working on this project should refresh this file when introducing structural changes, new scripts, or schema modifications.

## Project Overview

A curated directory of Chilean RSS feeds. Five source files drive the project (four tracked + one generated):

- `feeds-database.json` — main database: metadata + `sites[]`
- `categories.json` — shared category map (reused by generate, validate, watchlist)
- `regions.json` — shared region map (official names of Chilean regions)
- `watchlist.json` — candidate sites awaiting feed discovery, site-like structure

These generate:

- `dist/opml/chilean-rss.opml` (full database OPML, flat — todas las categorías en un solo nivel; compatible con todos los lectores RSS)
- `dist/opml/chilean-rss-nested.opml` (full database OPML, versión con regiones agrupadas en subcarpetas; para lectores que soporten anidación)
- `dist/opml/chilean-rss-main.opml` (un OPML por sitio con solo su feed principal — sin subfeeds ni feeds por sección)
- `dist/opml/chilean-rss-regions.opml` (consolidated regional feeds OPML, grouped by region)
- `dist/opml/regions/*.opml` (individual OPML files for each region, with region grouping, e.g., `dist/opml/regions/biobio.opml`)
- `dist/opml/regions/*-without-category.opml` (individual region OPMLs, flat — sin agrupación, e.g., `dist/opml/regions/biobio-without-category.opml`)
- `dist/opml/categories/*.opml` (individual OPML files for each category, with category grouping, e.g., `dist/opml/categories/news.opml`)
- `dist/opml/categories/*-without-category.opml` (individual category OPMLs, flat — sin agrupación, e.g., `dist/opml/categories/news-without-category.opml`)
- `README.md` (GitHub listing, with regional feeds grouped under regional subheaders)
- `dist/bookmarks/awesome-chilean-rss.html` (Netscape Bookmark HTML — compatible con navegadores, para importar feeds como favoritos)

- Node.js >= 18.13, ES modules (`"type": "module"`)
- No frontend — pure CLI tooling
- CI via GitHub Actions: validates JSON structure, OPML syntax, and checks generated files are in sync

## Schema: `feeds-database.json`

```json
{
  "last_updated": "2026-06-08T20:44:45.224Z",
  "total_feeds": 287,
  "sites": [
    {
      "id": "site-slug",
      "name": "Display Name",
      "url": "https://example.cl",
      "category": "regional",
      "region": "biobio", // OPTIONAL: region key (required if category is regional)
      "description": "Objective description of the site's coverage",
      "feeds": [
        {
          "id": "site-slug-main",
          "name": "Feed Name",
          "rss_url": "https://example.cl/feed/",
          "url": "https://example.cl/section/", // OPTIONAL: overrides site.url for htmlUrl
          "feed_type": "RSS",
          "description": "Optional feed-specific description", // OPTIONAL: overrides site.description for this feed
          "category": "sports", // OPTIONAL: overrides site.category
          "region": "araucania", // OPTIONAL: overrides site.region
          "last_checked": "2026-06-08T19:16:33.449Z",
          "last_known_item_date": "2026-06-07T12:00:00.000Z", // OPTIONAL: last known item date (at check time)
          "status": "active", // "active" | "stale" | "broken" | "offline" | "no_feed" | "feed_empty"
          "verified": true
        }
      ]
    }
  ]
}
```

### Schema: `categories.json`

```json
{
  "news": {
    "label": "📰 Noticias Nacionales",
    "slugs": [
      "noticias",
      "nacional",
      "actualidad",
      "chile",
      "pais",
      "noticia",
      "politica"
    ],
    "order": 1
  },
  "technology": {
    "label": "💻 Tecnología y Startups",
    "slugs": ["tecnologia", "tech", "ciencia", "innovacion", "digital", "ciencia-y-tecnologia", "ciencia-tecnologia", "tecnologia-y-ciencia"],
    "order": 4
  }
}
```

`order` define la posición de la categoría en los outputs generados (OPML, README). El array `slugs` se usa en `discover-category-feeds.js` para auto-asignar la categoría a feeds descubiertos según el slug de WordPress.

### Schema: `regions.json`

```json
{
  "arica-y-parinacota": "Arica y Parinacota",
  "tarapaca": "Tarapacá"
}
```

### Schema: `watchlist.json`

Entries mirror the site structure but include `reason` and `description` fields; `feeds` is pre-initialized as an empty array. When a feed is discovered and validated, `feeds[0]` is populated and `reason` is removed — the entry becomes promotion-ready.

Watchlist entries also receive `site:` proxy subfeeds (Google News + Bing News) in the `feeds` array, mirroring the convention for database sites.

```json
[
  {
    "id": "candidate-site",
    "name": "Candidate Name",
    "url": "https://candidate.cl",
    "category": "news",
    "description": "Objective short description of the site",
    "reason": "No RSS feed detected yet",
    "feeds": [
      {
        "id": "candidate-site-proxy-google-news",
        "name": "Candidate Name [Proxy Google News]",
        "rss_url": "https://news.google.com/rss/search?q=site:candidate.cl&hl=es-419&gl=CL&ceid=CL:es-419",
        "url": "https://news.google.com/search?q=site:candidate.cl&hl=es-419&gl=CL&ceid=CL:es-419",
        "feed_type": "RSS",
        "description": "Resultados de site:candidate.cl en Proxy Google News de noticias Chilenas",
        "last_checked": "2026-07-17T12:00:00.000Z",
        "last_known_item_date": null,
        "status": "active",
        "verified": true
      },
      {
        "id": "candidate-site-proxy-bing-news",
        "name": "Candidate Name [Proxy Bing News]",
        "rss_url": "https://www.bing.com/news/search?q=site:candidate.cl&format=RSS",
        "url": "https://www.bing.com/news/search?q=site:candidate.cl",
        "feed_type": "RSS",
        "description": "Resultados de site:candidate.cl en Proxy Bing News",
        "last_checked": "2026-07-17T12:00:00.000Z",
        "last_known_item_date": null,
        "status": "active",
        "verified": true
      }
    ]
  }
]
```

When a kept entry (user chose not to promote) is saved back to `watchlist.json`, the original `reason` is preserved to maintain CI validity.

### Category resolution

Each feed's effective category is resolved as: **`feed.category ?? site.category`**

- If a feed has its own `category` field, it appears under that category in OPML/README
- If not, it inherits the site's category
- A site may appear in multiple categories with only its relevant feeds in each

### Region resolution

Each feed's effective region is resolved as: **`feed.region ?? site.region`**

- If a feed has its own `region` field, it belongs to that region in OPML/README
- If not, it inherits the site's region

## Scripts

| Command                                                                       | File                                       | Purpose                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run generate`                                                            | `scripts/core/generate.js`                 | Reads JSON, writes OPML files (dist/opml/chilean-rss.opml, dist/opml/chilean-rss-nested.opml, dist/opml/chilean-rss-regions.opml, dist/opml/regions/_.opml, dist/opml/categories/_.opml) + README + dist/bookmarks/awesome-chilean-rss.html |
| `npm run validate`                                                            | `scripts/core/validate_feeds.js`           | Validates RSS URLs, rediscover broken feeds                                                                                                                                                                                                 |
| `npm run validate -- --update`                                                | same                                       | Applies fixes to `feeds-database.json`                                                                                                                                                                                                      |
| `npm run validate -- --id <site-id>`                                          | same                                       | Validate a single site                                                                                                                                                                                                                      |
| `npm run validate -- --url <URL>`                                             | same                                       | Validate a specific URL (feed or site)                                                                                                                                                                                                      |
| `npm run validate -- --start-id <id> [--limit <N>]`                           | same                                       | Validate from a site ID onward, optionally limit count                                                                                                                                                                                      |
| `npm run validate -- --from <N> --to <N>`                                     | same                                       | Validate a numeric range of sites (--to inclusive)                                                                                                                                                                                          |
| `npm run validate -- --limit <N>`                                             | same                                       | Validate only the first N sites                                                                                                                                                                                                             |
| `npm run validate -- --automatic`                                             | same                                       | Read-only, no prompts (CI/pre-commit)                                                                                                                                                                                                       |
| `npm run validate -- --missing-date`                                          | same                                       | Validate only feeds without `last_known_item_date` (never verified). Con `--update`, todos los feeds procesados quedan con `last_known_item_date` definido (fecha ISO o `null`)                                                             |
| `npm run validate -- --status <status>`                                       | same                                       | Validate only feeds with a specific status (active, stale, broken, offline, no_feed, feed_empty)                                                                                                                                            |
| `npm run validate -- --watchlist`                                             | same                                       | Shows instructions to use `npm run validate:watchlist`                                                                                                                                                                                      |
| `npm run validate:json`                                                       | `scripts/validation/validate-json.js`      | CI: validate JSON structure                                                                                                                                                                                                                 |
| `npm run validate:opml`                                                       | `scripts/validation/validate-opml.js`      | CI: validate OPML syntax for all generated OPMLs                                                                                                                                                                                            |
| `npm run validate:watchlist`                                                  | `scripts/core/validate-watchlist.js`       | Validate watchlist entries + auto-promote with `--update`                                                                                                                                                                                   |
| `npm run validate:watchlist -- --id <site-id>`                                | same                                       | Validate + promote a single watchlist entry                                                                                                                                                                                                 |
| `npm run ci`                                                                  | —                                          | CI pipeline (validate:json + validate:opml + generate + diff)                                                                                                                                                                               |
| `npm run fix:stale`                                                           | `scripts/utils/fix-stale-feeds.js`         | Bulk fix active feeds with stale item dates → marks them `stale`                                                                                                                                                                           |
| `npm run lint`                                                                | —                                          | ESLint check                                                                                                                                                                                                                                |
| `node scripts/utils/find-duplicates.js`                                       | `scripts/utils/find-duplicates.js`         | Detect duplicate site URLs, rss_urls, root domains, and IDs                                                                                                                                                                                 |
| `node scripts/utils/find-duplicates.js --verbose`                             | same                                       | Same with clickable file:line links for each result                                                                                                                                                                                         |
| `node scripts/utils/add-site-subfeeds.js`                                     | `scripts/utils/add-site-subfeeds.js`       | Add missing Google News + Bing News `site:` subfeeds to all eligible sites/watchlist entries                                                                                                                                                |
| `node scripts/utils/add-site-subfeeds.js --dry-run`                           | same                                       | Preview only, no file writes                                                                                                                                                                                                                |
| `node scripts/utils/add-site-subfeeds.js --file database\|watchlist\|all`     | same                                       | Limit to which files to process (default: all)                                                                                                                                                                                              |
| `node scripts/utils/add-site-subfeeds.js --id <id>`                           | same                                       | Process a single entry by ID                                                                                                                                                                                                                |
| `node scripts/utils/add-site-subfeeds.js --from <N> --to <N>`                 | same                                       | Process a numeric range of entries                                                                                                                                                                                                          |
| `node scripts/utils/add-site-subfeeds.js --limit <N>`                         | same                                       | Process the first N entries                                                                                                                                                                                                                 |
| `node scripts/utils/add-site-subfeeds.js --start-id <id> [--limit <N>]`       | same                                       | Start from an entry ID onward, optionally limit                                                                                                                                                                                             |
| `node scripts/utils/add-site-subfeeds.js --total-mode delta\|recalculate`     | same                                       | `delta`: fast increment (default); `recalculate`: recount all active feeds                                                                                                                                                                  |
| `node scripts/utils/discover-category-feeds.js`                               | `scripts/utils/discover-category-feeds.js` | Discover WP category feeds for all sites via REST API; discovered feeds include `url` pointing to the category/section page (not site root)                                                                                                 |
| `node scripts/utils/discover-category-feeds.js --id <site-id>`                | same                                       | Discover category feeds for a single site                                                                                                                                                                                                   |
| `node scripts/utils/discover-category-feeds.js --min-posts <N>`               | same                                       | Only include categories with ≥ N posts (default: 1)                                                                                                                                                                                         |
| `node scripts/utils/discover-category-feeds.js --update`                      | same                                       | Write discovered feeds to `feeds-database.json`                                                                                                                                                                                             |
| `node scripts/utils/discover-category-feeds.js --dry-run`                     | same                                       | Preview only, no file writes                                                                                                                                                                                                                |
| `node scripts/utils/discover-category-feeds.js --from <N> --to <N>`           | same                                       | Process a numeric range of sites                                                                                                                                                                                                            |
| `node scripts/utils/discover-category-feeds.js --limit <N>`                   | same                                       | Process the first N sites                                                                                                                                                                                                                   |
| `node scripts/utils/discover-category-feeds.js --start-id <id> [--limit <N>]` | same                                       | Start from a site ID onward, optionally limit                                                                                                                                                                                               |

## Module structure

```markdown
scripts/
  core/
    validate_feeds.js     — CLI entry: arg parsing, main loop, feed state mutations
    generate.js           — reads JSON, writes OPML files (dist/opml/chilean-rss.opml, dist/opml/chilean-rss-nested.opml, dist/opml/chilean-rss-regions.opml, dist/opml/regions/*.opml, dist/opml/categories/*.opml) + README + bookmarks
    validate-watchlist.js — CLI entry: watchlist → full validation → promotion
  validation/
    validate-json.js     — CI: validate JSON structure (categories, regions, statuses)
    validate-opml.js     — CI: validate OPML syntax for all generated OPML files
  utils/
    verify-feeds.js      — verify RSS/Atom feeds from a JSON list or direct URL
    find-duplicates.js   — detect duplicate site URLs, rss_urls, root domains, and IDs; --verbose emits clickable file:line links
    add-site-subfeeds.js — add Google News + Bing News site: subfeeds; flags: --dry-run, --file, --id, --from/--to, --limit, --start-id, --total-mode
    discover-category-feeds.js — discover WP category feeds via REST API; flags: --id, --min-posts, --update, --dry-run, --from/--to, --limit, --start-id
    fix-stale-feeds.js   — bulk fix active feeds with stale item dates → marks them stale
    standardize-feed-keys.js — reorder feed object keys to canonical order
lib/
  feed-validator.js       — core RSS/Atom/JSON/RDF parsing: fetchSafe (with retry), checkFeedUrl, detectFeedType, getMostRecentDate, readResponseBody, xmlParser, MAX_RESPONSE_BYTES, DEFAULT_OPTIONS
  network-utils.js        — low-level network: checkSiteStatus, checkSiteReachable, tryFetchFeedInsecure, isValidUrl
  feed-rediscovery.js     — feed rediscovery: extractFeedLinksFromHtml, rediscoverFeed (5-stage, dedup via Set), FEED_PATTERNS, parseSitemapXml, extractSectionFromSitemap, clearHomepageCache
  watchlist-validator.js  — watchlist validation pipeline: validateWatchlistEntry, promoteToSite
  prompter.js             — interactive prompts: promptUser, promptUrl, promptStatus, isAutomatic
  rate-limiter.js         — rate limiter: acquireSlot/releaseSlot con semáforo global (max 5 concurrentes) + delay mínimo por dominio (2s)
  feed-utils.js           — shared utilities: extractSelfLink, pathsMatch, daysSince, isStale, formatError, recalculateTotalFeeds, getDomain, STALE_THRESHOLD_DAYS, ALLOWED_STATUSES, BROKEN_ERRORS
  cli-args.js             — shared CLI arg parsing: parseArgs(extraFlags), applyFilters, applyFiltersSites
```

## Data flow

```markdown
feeds-database.json
  → validate_feeds.js (check URLs via lib/*, rediscover, update status)
     lib/feed-utils.js      (daysSince, pathsMatch, formatError, STALE_THRESHOLD_DAYS)
     lib/cli-args.js        (parseArgs, applyFiltersSites)
     lib/feed-validator.js  (checkFeedUrl)
     lib/network-utils.js   (TLS/HTTP checks, insecure fallback)
     lib/feed-rediscovery.js (HTML scan, pattern matching)
     lib/prompter.js        (user prompts for ambiguous cases)
  → validate-watchlist.js (validate watchlist entries, promote to sites)
     lib/cli-args.js        (parseArgs, applyFilters)
     lib/feed-utils.js      (recalculateTotalFeeds)
     lib/watchlist-validator.js (orquestra rediscovery + staleness check + promotion)
       lib/feed-validator.js  (checkFeedUrl)
       lib/feed-rediscovery.js (rediscoverFeed)
       lib/feed-utils.js      (STALE_THRESHOLD_DAYS, daysSince)
  → generate.js (resolve feed.category ?? site.category, read categories from categories.json, read regions from regions.json)
     → dist/opml/chilean-rss.opml (flat: grouped by resolved category, regional feeds direct)
     → dist/opml/chilean-rss-nested.opml (nested: regional category sub-grouped by region)
     → dist/opml/chilean-rss-regions.opml (grouped by resolved region)
     → dist/opml/regions/*.opml (individual region OPMLs)
     → dist/opml/categories/*.opml (individual category OPMLs)
     → README.md (grouped by resolved category, regional category sub-grouped by region)
     → dist/bookmarks/awesome-chilean-rss.html (Netscape Bookmark HTML)
discover-category-feeds.js (discover WP category feeds)
  lib/cli-args.js        (parseArgs, applyFiltersSites)
  lib/feed-utils.js      (pathsMatch, daysSince, recalculateTotalFeeds, STALE_THRESHOLD_DAYS)
  lib/feed-validator.js  (checkFeedUrl, fetchSafe)
  lib/prompter.js        (isAutomatic)
add-site-subfeeds.js (add Google News + Bing News proxy subfeeds)
  lib/cli-args.js        (parseArgs, applyFilters)
  lib/feed-utils.js      (recalculateTotalFeeds)
```

## Shared utilities

| Function                    | lib/feed-utils.js                                                                                                | Used by                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `extractSelfLink(text)`     | Extracts `<atom:link rel="self">` href from feed XML (supports both `<atom:link>` RSS and `<link>` Atom formats) | `feed-validator.js`                                                           |
| `pathsMatch(urlA, urlB)`    | Compares pathnames ignoring trailing slashes                                                                     | `validate_feeds.js`, `discover-category-feeds.js` (×2)                        |
| `daysSince(date)`           | Days between now and a date                                                                                      | `validate_feeds.js`, `watchlist-validator.js`, `discover-category-feeds.js`   |
| `isStale(date)`             | Returns true if `daysSince(date) > STALE_THRESHOLD_DAYS`                                                         | `validate_feeds.js`                                                           |
| `formatError(error, code)`  | Formats error string as `error (code)` or just `error`                                                           | `validate_feeds.js`                                                           |
| `recalculateTotalFeeds(db)` | Counts `active && verified` feeds, updates `db.total_feeds` and `db.last_updated`                                | `discover-category-feeds.js`, `validate-watchlist.js`, `add-site-subfeeds.js` |
| `getDomain(url)`            | Extracts hostname without `www.` prefix                                                                          | `add-site-subfeeds.js`                                                        |
| `STALE_THRESHOLD_DAYS`      | `30` days constant                                                                                               | `validate_feeds.js`, `watchlist-validator.js`, `discover-category-feeds.js`   |
| `ALLOWED_STATUSES`          | `['active', 'stale', 'broken', 'offline', 'no_feed', 'feed_empty']`                                              | `validate-json.js`                                                            |
| `BROKEN_ERRORS`             | `['HTML (no es feed)', 'no es RSS/Atom', 'sin canal', 'XML inválido', 'items sin contenido válido']`              | `validate_feeds.js`                                                           |

| Function                         | lib/cli-args.js                                                                                                                              | Used by                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `parseArgs(argv, extraFlags?)`   | Parses `--id`, `--from`, `--to`, `--limit`, `--start-id`, `--update`, `--dry-run`, `--automatic`, `--verbose` + custom flags with validation | `validate_feeds.js`, `validate-watchlist.js`, `discover-category-feeds.js`, `add-site-subfeeds.js` |
| `applyFilters(entries, args)`    | Filters array by `id`, `startId`, `from`, `to`, `limit`                                                                                      | `validate-watchlist.js`, `add-site-subfeeds.js`                                                    |
| `applyFiltersSites(sites, args)` | Same as applyFilters but with `--from`/`--to` combined-range logic + site-specific error messages                                            | `validate_feeds.js`, `discover-category-feeds.js`                                                  |

## Watchlist promotion flow

```markdown
watchlist entry {id, name, url, category, reason, description, feeds: []}
   → rediscoverFeed (5-stage, dedup via Set)
    → checkFeedUrl (with fetchSafe retry ×3)
      → itemCount > 0 & < 30 days → promoteToSite()
        → feeds[0] populated, reason removed → sites[]
      → itemCount === 0 → { ok: false, 'feed vacío' }
      → stale (>30d) → { ok: false, 'stale' }
      → no feed found → { ok: false, 'sin feed RSS' }
  → interactive: prompt per entry (with --update), end prompt (without --update)
  → kept entries preserve original reason for CI validity
```

## Feed status reference

| Status       | Meaning                                                                                 | Included in OPML? |
| ------------ | --------------------------------------------------------------------------------------- | ----------------- |
| `active`     | Feed responds with valid RSS/Atom with recent items                                     | ✅ Yes            |
| `feed_empty` | Feed responds with valid RSS/Atom but contains no items                                 | ❌ No             |
| `stale`      | Feed responds, has items, but all are older than 30 days                                | ❌ No             |
| `broken`     | Feed URL responds with invalid content (HTML, broken XML, empty) and rediscovery failed | ❌ No             |
| `offline`    | The site itself is unreachable (DNS, timeout, connection error)                         | ❌ No             |
| `no_feed`    | Site responds but feed URL gives HTTP error and no replacement was found                | ❌ No             |

Only feeds with `status: "active"` and `verified: true` appear in generated outputs.

## CI workflows

### `check-format.yml` (PR + manual)

Triggered on PRs touching data files (`feeds-database.json`, `categories.json`, `regions.json`, `watchlist.json`), or manually via `workflow_dispatch`.

Runs `npm run ci` — validates JSON structure + OPML syntax + generates outputs + checks `git diff --exit-code`.

### `validate-links.yml` (manual only)

Triggered manually via `workflow_dispatch`.

Runs `npm run validate -- --automatic` — **read-only**: validates all feed URLs without modifying files. Kept separate from format checks because it's slow.

## Validation rules (CI)

1. `validate-json.js` — ensures all required fields exist in `feeds-database.json`, `categories.json`, `regions.json`, and `watchlist.json`; cross-validates that `feed.category`, watchlist `category`, `feed.region`, `site.region`, and watchlist `region` are valid keys in `categories` or `regions`; feed `status` must be one of the allowed values
2. `validate-opml.js` — ensures every `<outline type="rss">` has `xmlUrl` and `text` in all generated OPML files
3. `git diff --exit-code` — fails if OPML/README/bookmarks are out of sync with JSON

## Staleness detection (validate_feeds.js)

When a feed URL responds successfully, the validator extracts the most recent publication date from its items:

1. RSS items: checks `<pubDate>`, `<dc:date>`
2. Atom entries: checks `<published>`, `<updated>`
3. If the most recent item is older than **30 days** → marks `status: "stale"`
4. If no date info is found in items (interactive mode) → prompts user whether to mark as active or stale
5. In non-interactive mode (CI) → defaults to active (conservative)

This prevents defunct feeds that haven't published in years from appearing in the OPML listing.

## Rediscovery algorithm (rediscoverFeed, 5 stages)

When a feed URL fails, `rediscoverFeed` runs 5 stages (URLs already verified in earlier stages are skipped via a `Set` tracker):

1. **HTTP Link header** (`Link: <...>; rel="alternate"`)
2. **HTML `<link>` tags** (`<link rel="alternate" type="application/rss+xml">`)
3. **JSON-LD** (`<script type="application/ld+json">` with `WebFeed`)
4. **URL patterns** (`/feed/`, `/rss/`, CMS patterns, well-known URIs) — early aborts after 3 consecutive HTML responses
5. **Sitemap discovery** — fetches `/sitemap.xml` (follows sitemap indexes, prefers category sitemaps), extracts path segments, tests feed patterns on each. Each candidate is verified via **self-link matching** (feed's `<atom:link rel="self">` must match the requested section) and **redirect rejection** (redirects to a different path indicate a global feed, not section-specific).

Then in `validate_feeds.js`:

- If found → update `rss_url` and mark `status: "active"`
- If not found → mark `status: "no_feed"`

## Network resilience

All HTTP requests are handled by `fetchSafe` which:

- Sets a configurable timeout (default 10s) and rotates User-Agent (6 modern browsers variants)
- Retries up to **3 times** on transient network errors with exponential backoff (500ms, 1500ms, 3000ms)
- Retries on HTTP 429 (Too Many Requests), 500, 502, 503, and 504 with same backoff
- Responses exceeding **5 MB** are rejected
- Only `http:` / `https:` URLs allowed; private IPs blocked by `isValidUrl()`
- SSL certificate errors detected separately from "site down" via raw `https.request` with `rejectUnauthorized: false`

All requests go through `lib/rate-limiter.js` which:

- Limits **max 5 concurrent** HTTP requests globally (`MAX_CONCURRENT`)
- Enforces **minimum 2 second delay** between requests to the **same domain** (`DOMAIN_DELAY_MS`)
- Auto-cleans domain timestamps older than 60s to prevent memory leaks

## Key conventions

- **Feed IDs**: `{site-id}-{section-name}` (kebab-case)
- **Site IDs**: kebab-case of the site name
  - **No editorializing in descriptions**: objective, factual, no superlatives
- **Categories**: defined in `categories` map at the top of the JSON
- **Adding a feed**: edit JSON, run `npm run generate`, commit all changed files
- **`site:` subfeeds**: every eligible site (excl. social media/bots) gets two proxy feeds: Google News `site:` search and Bing News `site:` search. Feed ID pattern: `{site-id}-proxy-google-news` and `{site-id}-proxy-bing-news`. Descriptions follow `Resultados de site:{domain} en Proxy Google News de noticias Chilenas` / `Resultados de site:{domain} en Proxy Bing News`. Watchlist entries also get these subfeeds.

## Self-evolution instructions

When you modify this project, update this file if:

- **Schema changes**: new fields in sites, feeds, categories, or watchlist
- **New scripts**: add to the scripts table and module structure diagram
- **New modules**: add to `lib/` directory listing in module structure
- **New categories**: add to the categories list. Current categories (16): news, news-international, government, education, regional, business, jobs, technology, culture, community, sports, gaming, environment, entertainment, radio, health
- **Workflow changes**: update CI pipeline description
- **New conventions**: add to key conventions
- **Documentation changes**: keep `VALIDATION_MODES.md`, `SCRIPT_README.md`, `CONTRIBUTING.md`, and other Markdown docs in sync with code changes

This ensures every agent interacting with the project has accurate, current context.

> **Note on documentation languages**: `AGENTS.md` is in English (intended for AI agents). User-facing docs like `VALIDATION_MODES.md`, `SCRIPT_README.md`, and `CONTRIBUTING.md` are in Spanish (intended for human contributors). Keep both in sync — when you update a feature, update both the English agent docs and the Spanish user docs.
