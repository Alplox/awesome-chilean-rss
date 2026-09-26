# 🔍 Scripts del proyecto

## Descripción

Este proyecto usa scripts Node.js organizados por funcionalidad:

### Scripts principales (core/)

| Script                               | Comando                                             | Propósito                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/core/validate_feeds.js`     | `pnpm validate`                                  | Valida feeds sin modificar feeds-database.json                                                                                                                                                                                                                                                 |
|                                      | `pnpm validate -- --update`                      | Revalida feeds, redescubre URLs rotas y actualiza feeds-database.json                                                                                                                                                                                                                          |
|                                      | `pnpm validate -- --id <site-id>`                | Valida solo un sitio específico por su ID                                                                                                                                                                                                                                                      |
|                                      | `pnpm validate -- --update --id <site-id>`       | Valida y actualiza solo un sitio específico                                                                                                                                                                                                                                                    |
|                                      | `pnpm validate -- --url <URL>`                   | Valida una URL específica (feed o sitio) sin modificar BD                                                                                                                                                                                                                                      |
|                                      | `pnpm validate -- --start-id <id> [--limit <N>]` | Valida desde un site-id en adelante (opcionalmente limitado)                                                                                                                                                                                                                                   |
|                                      | `pnpm validate -- --from <N> --to <N>`           | Valida un rango numérico de sitios (--to inclusive)                                                                                                                                                                                                                                            |
|                                      | `pnpm validate -- --limit <N>`                   | Valida solo los primeros N sitios                                                                                                                                                                                                                                                              |
|                                      | `pnpm validate -- --missing-date`                | Valida solo feeds sin `last_known_item_date` (nunca verificados). Con `--update` todos quedan con fecha ISO o `null`                                                                                                                                                                           |
|                                      | `pnpm validate -- --status <estado>`             | Valida solo feeds con un estado específico (`active`, `stale`, `broken`, `offline`, `no_feed`, `feed_empty`)                                                                                                                                                                                   |
|                                      | `pnpm validate -- --watchlist`                   | Muestra instrucciones para usar `pnpm validate:watchlist`                                                                                                                                                                                                                                   |
|                                      | `pnpm validate -- --update --automatic`          | Modo no interactivo para CI/desatendido                                                                                                                                                                                                                                                        |
| `scripts/core/generate.js`           | `pnpm generate`                                  | Lee `feeds-database.json`, `categories.json` y `regions.json`, regenera `dist/opml/chilean-rss.opml`, `dist/opml/chilean-rss-nested.opml`, `dist/opml/chilean-rss-regions.opml`, `dist/opml/regions/*.opml`, `dist/opml/categories/*.opml`, `dist/bookmarks/awesome-chilean-rss.html` y README |
| `scripts/core/validate-watchlist.js` | `pnpm validate:watchlist`                        | Valida watchlist, promueve feeds válidos a sites con `--update`                                                                                                                                                                                                                                |
|                                      | `pnpm validate:watchlist -- --update`            | Promueve automáticamente los feeds válidos a sites[]                                                                                                                                                                                                                                           |
|                                      | `pnpm validate:watchlist -- --automatic`         | Modo no interactivo (promueve todo sin preguntar)                                                                                                                                                                                                                                              |
|                                      | `pnpm validate:watchlist -- --id <id>`           | Valida y promueve solo un sitio específico de la watchlist                                                                                                                                                                                                                                     |

### Scripts de validación (validation/)

| Script                                | Comando                 | Propósito                                                            |
| ------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `scripts/validation/validate-json.js` | `pnpm validate:json` | Valida la estructura del JSON (categorías, regiones, estados) — (CI) |
| `scripts/validation/validate-opml.js` | `pnpm validate:opml` | Valida la sintaxis de todos los archivos OPML generados — (CI)       |
| `scripts/validation/check-docs-sync.js` | `pnpm check:docs` | Verifica que SCRIPT_README.md y AGENTS.md documenten todos los scripts, módulos y estados — (CI) |
| —                                         | `pnpm run check:sync` | Pipeline de CI: `validate:json` + `check:duplicates` + `check:docs` + `validate:opml` + `generate` + `git diff --exit-code dist README.md` |

### Scripts utilitarios (utils/)

| Script                                     | Comando                                                                       | Propósito                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `scripts/utils/verify-feeds.js`            | `pnpm verify:feeds -- <feeds.json>`                             | Verifica feeds RSS/Atom desde un archivo JSON                                                         |
|                                            | `pnpm verify:feeds -- <URL>`                                    | Verifica una URL de feed específica directamente                                                      |
| `scripts/utils/find-duplicates.js`         | `pnpm check:duplicates`                                       | Detecta duplicados intra-DB + cruce DB↔watchlist (site IDs/URLs, feed IDs/rss_urls) — detecta promociones incompletas |
|                                            | `pnpm check:duplicates -- --verbose`                             | Igual que el anterior, con links clicables `archivo:línea` (DB + WL)                                  |
|                                            | `pnpm check:duplicates -- --fix --dry-run`                       | Preview: muestra qué 41 sitios se borrarían de watchlist (keep DB)                                    |
|                                            | `pnpm check:duplicates -- --fix --yes`                           | Limpia watchlist (borra duplicados cruzados, deja solo DB); `--keep watchlist` invierte               |
|                                            | `pnpm check:duplicates -- --all --out reporte.txt`               | Reporte completo sin recorte a archivo; `--json dupes.json` para JSON machine-readable                 |
| `scripts/utils/check-feed-overlap.js`      | `pnpm check:overlap`                                         | Detecta feeds que repiten contenido de otros feeds **del mismo sitio** (solapamiento de items)        |
|                                            | `pnpm check:overlap -- --id <site-id>`                       | Revisa el solapamiento de un solo sitio                                                                |
|                                            | `pnpm check:overlap -- --from <N> --to <N>`                  | Rango numérico de sitios                                                                                |
|                                            | `pnpm check:overlap -- --limit <N>`                          | Solo los primeros N sitios                                                                              |
|                                            | `pnpm check:overlap -- --start-id <id> [--limit <N>]`        | Desde un ID en adelante, opcionalmente limitado                                                         |
|                                            | `pnpm check:overlap -- --threshold <0-1>`                    | Umbral de coincidencia de items (default `0.85` = 85%)                                                  |
|                                            | `pnpm check:overlap -- --update`                             | Marca los duplicados: `status: "duplicate"`, `verified: false` y `duplicate_of`                         |
|                                            | `pnpm check:overlap -- --update --validate`                  | Además actualiza el estado (active/stale/feed_empty/broken) reutilizando los mismos fetch              |
|                                            | `pnpm check:overlap -- --automatic`                          | Modo no interactivo (CI / pre-commit)                                                                    |
| `scripts/utils/fix-stale-feeds.js`         | `pnpm fix:stale`                                                           | Marca como stale los feeds activos con último item > 30 días                                          |
| `scripts/utils/standardize-feed-keys.js`   | `pnpm standardize:keys`                                 | Reordena claves de feeds/sites a orden canónico (FEED/SITE_KEY_ORDER) — soporta `database` y `watchlist` (con `reason`) |
|                                            | `pnpm standardize:keys -- --file watchlist --dry-run`     | Preview solo watchlist (incluye `reason`); `--check` para CI (exit 1 si hay desorden)                  |
|                                            | `pnpm standardize:keys -- --check`                         | Verifica ambos archivos; falla si requieren reorden                                                     |
| `scripts/utils/add-site-subfeeds.js`       | `pnpm sync:subfeeds`                                     | Agrega subfeeds Google News + Bing News `site:` a sitios/watchlist elegibles (excluye redes sociales) |
|                                            | `pnpm sync:subfeeds -- --dry-run`                           | Vista previa sin modificar archivos                                                                   |
|                                            | `pnpm sync:subfeeds -- --file database\|watchlist\|all`     | Limita a qué archivo procesar (default: all)                                                          |
|                                            | `pnpm sync:subfeeds -- --id <id>`                           | Procesa una sola entrada por ID                                                                       |
|                                            | `pnpm sync:subfeeds -- --from <N> --to <N>`                 | Procesa un rango numérico de entradas                                                                 |
|                                            | `pnpm sync:subfeeds -- --limit <N>`                         | Procesa solo las primeras N entradas                                                                  |
|                                            | `pnpm sync:subfeeds -- --start-id <id> [--limit <N>]`       | Desde un ID en adelante, opcionalmente limitado                                                       |
|                                            | `pnpm sync:subfeeds -- --total-mode delta\|recalculate`     | `delta`: incremento rápido (default); `recalculate`: reconteo completo                                |
| `scripts/utils/discover-category-feeds.js` | `pnpm discover:categories`                               | Descubre feeds por categoría en sitios WordPress vía REST API                                         |
|                                            | `pnpm discover:categories -- --id <id>`                     | Procesa un solo sitio                                                                                 |
|                                            | `pnpm discover:categories -- --min-posts <N>`               | Solo incluye categorías con ≥ N artículos (default: 1)                                                |
|                                            | `pnpm discover:categories -- --update`                      | Escribe los feeds descubiertos en `feeds-database.json`                                               |
|                                            | `pnpm discover:categories -- --dry-run`                     | Vista previa sin modificar archivos                                                                   |
|                                            | `pnpm discover:categories -- --from <N> --to <N>`           | Rango numérico de sitios                                                                              |
|                                            | `pnpm discover:categories -- --limit <N>`                   | Solo los primeros N sitios                                                                            |
|                                            | `pnpm discover:categories -- --start-id <id> [--limit <N>]` | Desde un ID en adelante, opcionalmente limitado                                                       |

### Módulos de validación (lib/)

La lógica de red y redescubrimiento está organizada en módulos independientes:

| Módulo                       | Propósito                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/feed-validator.js`      | Parseo RSS/Atom/JSON/RDF: `fetchSafe`, `checkFeedUrl`, `detectFeedType`, `getMostRecentDate`, `readResponseBody`                                                                                  |
| `lib/network-utils.js`       | Red: `checkSiteReachable`, `checkCertError`, `tryFetchFeedInsecure`, `isValidUrl`                                                                                                                 |
| `lib/feed-rediscovery.js`    | Redescubrimiento: `extractFeedLinksFromHtml`, `rediscoverFeed`, `FEED_PATTERNS`, `parseLinkHeader`, `extractJsonLdFeeds`                                                                          |
| `lib/feed-overlap.js`        | Solapamiento de items: `normalizeItemKey`, `keySet`, `containmentRatio`, `findDuplicate` (usado por `check:overlap`)                                                                                |
| `lib/browser-fallback.js`    | Verificación con navegador headless (Playwright, dependencia opcional): `fetchWithBrowser`, `closeBrowser` — resuelve challenges anti-bot tipo Cloudflare                                                    |
| `lib/feed-utils.js`          | Utilidades compartidas: `extractSelfLink`, `pathsMatch`, `daysSince`, `isStale`, `formatError`, `recalculateTotalFeeds`, `ALLOWED_STATUSES`, `BROKEN_ERRORS`, `getDomain`, `STALE_THRESHOLD_DAYS`, `DUPLICATE_OVERLAP_THRESHOLD` |
| `lib/cli-args.js`            | Parseo centralizado de args CLI: `parseArgs`, `applyFilters`, `applyFiltersSites`                                                                                                                 |
| `lib/prompter.js`            | Prompts: `promptUser`, `promptUrl`, `promptStatus`, `isAutomatic`                                                                                                                                 |
| `lib/watchlist-validator.js` | Watchlist: `validateWatchlistEntry`, `promoteToSite`                                                                                                                                              |
| `lib/rate-limiter.js`        | Control de concurrencia: máximo 5 requests globales, mínimo 2s entre requests al mismo dominio                                                                                                    |

### Flujo de trabajo

```markdown
feeds-database.json    categories.json   regions.json      watchlist.json
  └── sites[]           └── categories{}  └── regions{}      └── sites sin feed
       │                       │                │                   │
       ▼                       ▼                ▼                   ▼
  validate_feeds.js ──────►  generate.js ──────────────►  validate-watchlist.js
  (lib/*, rediscover)        (by category + region)        (lib/watchlist-validator.js)
       │                       │                                   │
       ▼                       ▼                                   ▼
     feeds-database.json        dist/opml/chilean-rss.opml           feeds-database.json†
                                dist/opml/chilean-rss-nested.opml    watchlist.json†
                                dist/opml/chilean-rss-regions.opml   († con --update)
                                dist/opml/regions/*.opml
                                dist/opml/categories/*.opml
                                dist/bookmarks/awesome-chilean-rss.html
                               README.md

  find-duplicates.js  ──►  reporte en consola (solo lectura)
                           │  (IDs, URLs y dominios duplicados)

  check-feed-overlap.js ──►  reporte de feeds con contenido duplicado
                           │  dentro del mismo sitio
                           │  (--update los marca como "duplicate")

  add-site-subfeeds.js ──►  agrega subfeeds Google News + Bing News
                           │  a sitios/watchlist (--dry-run para previsualizar)

  discover-category-feeds.js ──►  descubre feeds por categoría
                                  │  vía REST API de WordPress
                                  │  (--update para escribir en database)
```

**Para agregar un feed:** edita `feeds-database.json` y ejecuta `pnpm generate`. Si es una categoría nueva, agrégala también en `categories.json`. Si es un medio regional, añade el campo `region` con la clave correspondiente de `regions.json`.

**Para agregar un candidato sin feed conocido:** agrega la entrada en `watchlist.json` con estructura site-like y `feeds: []`.

**Para detectar duplicados:** ejecuta `pnpm check:duplicates` (compara site IDs, URLs, dominios y `rss_url`). Para detectar feeds que repiten el **mismo contenido** dentro de un sitio, usa `pnpm check:overlap`.

**Para sincronizar subfeeds Google News / Bing News:** ejecuta `pnpm sync:subfeeds`. Con `--dry-run` previsualiza sin modificar. Con `--total-mode recalculate` recontea todos los feeds activos desde cero.

**Para revalidar feeds existentes:** ejecuta `pnpm validate`.

**Para promover candidatos de la watchlist:** ejecuta `pnpm validate:watchlist -- --update`.

## Requisitos

- Node.js >= 18.13.0 (usa `fetch` nativo)
- pnpm >= 10 (`corepack enable` o https://pnpm.io/installation)

## Instalación

```bash
pnpm install
```

## Uso

```bash
# Regenerar OPML, README y bookmarks desde feeds-database.json + categories.json
pnpm generate

# Revalidar todos los feeds, redescubrir URLs rotas
pnpm validate

# Solo validación, sin prompts (CI / pre-commit)
pnpm validate -- --automatic

# Verificar formato, documentación y sincronización (CI)
pnpm run check:sync

# Validar y promover watchlist
pnpm validate:watchlist
```

## Mantenimiento de subfeeds `site:`

Cada sitio elegible (excluyendo redes sociales y motores de búsqueda) tiene dos subfeeds de respaldo: Google News `site:` y Bing News `site:`. Cuando se agrega un nuevo sitio a `feeds-database.json` o `watchlist.json`, este script detecta los faltantes y los añade automáticamente.

```bash
# Previsualizar qué subfeeds faltan
pnpm sync:subfeeds -- --dry-run

# Agregar los faltantes (modo normal)
pnpm sync:subfeeds

# Solo database o solo watchlist
pnpm sync:subfeeds -- --file database
pnpm sync:subfeeds -- --file watchlist

# Procesar una entrada específica
pnpm sync:subfeeds -- --id colegio-medicos

# Rango numérico (entradas 10-20 de la lista combinada)
pnpm sync:subfeeds -- --from 10 --to 20

# Desde un ID en adelante, máximo 5
pnpm sync:subfeeds -- --start-id bbc-mundo --limit 5

# Reconteo completo de total_feeds (seguro pero más lento)
pnpm sync:subfeeds -- --total-mode recalculate
```

Los filtros se aplican en este orden: `--id` → `--start-id` → `--from` → `--to` → `--limit`.

### Descubrir feeds por categoría (WordPress)

```bash
# Todos los sitios (solo vista previa)
pnpm discover:categories

# Un sitio específico, categorías con ≥ 5 artículos
pnpm discover:categories -- --id radio-festival --min-posts 5

# Escribir los feeds descubiertos en la base de datos
pnpm discover:categories -- --update

# Solo los primeros 10 sitios
pnpm discover:categories -- --limit 10 --update
```

El script consulta la REST API de WordPress, construye URLs `/category/{slug}/feed/`,
las valida, y auto-asigna la categoría según los `slugs` definidos en `categories.json`.

### Detectar feeds que duplican contenido (`check:overlap`)

`check:duplicates` compara **IDs y URLs**; `check:overlap` compara **contenido**: descarga los feeds
de cada sitio y detecta cuándo un subfeed repite los mismos items que otro feed del mismo sitio.

```bash
# Revisar todos los sitios (solo lectura, no escribe)
pnpm check:overlap

# Un sitio puntual con umbral más permisivo (70%)
pnpm check:overlap -- --id radio-festival --threshold 0.7

# Marcar los duplicados en feeds-database.json
pnpm check:overlap -- --update

# Marcar duplicados y además refrescar el estado del resto con los mismos fetch
pnpm check:overlap -- --update --validate

# Sin prompts (CI / pre-commit)
pnpm check:overlap -- --automatic
```

Reglas del análisis:

| Regla                                                                                       | Motivo                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Solo compara feeds no proxy (excluye los subfeeds Google/Bing `-proxy-`)                     | Los proxies repiten contenido por diseño                           |
| Requiere ≥ 5 items por feed para comparar                                                     | Evita falsos positivos con feeds muy cortos                        |
| El feed principal (`{site}-main`) nunca se marca como duplicado                               | Marcarlo sacaría el sitio del OPML                                |
| Los items se comparan por `guid` o `link` normalizado (minúsculas, sin `#ancla` ni `/` final) | Mismo artículo con distinto ancla o slash final                    |
| Ciclos mutuos (A→B y B→A) no marcan ninguno de los dos                                       | Se reporta cuál tiene más items, pero no se descarta ninguno      |
| Un ciclo mutuo ya marcado antes se deshace automáticamente                                    | Recuperación de datos marcados por versiones anteriores del script |

Con `--update` cada feed afectado queda con `status: "duplicate"`, `verified: false` y
`duplicate_of: <feed-id>`. Ese estado **no aparece** en los OPML/README generados (solo entran
feeds `active` + `verified`), así que después de un `--update` ejecuta `pnpm generate` y commitea
`feeds-database.json` junto con los archivos generados.

## 🆕 Modos de Validación

### Validar una URL específica

```bash
# Valida un feed o sitio sin modificar la BD
pnpm validate -- --url https://ejemplo.com/feed.xml
pnpm validate -- --url https://ejemplo.com
```

Útil para testear feeds individuales antes de agregarlos.

### Validar y promover watchlist

```bash
# Validar sin modificar
pnpm validate:watchlist

# Validar y promover feeds descubiertos a sites[]
pnpm validate:watchlist -- --update

# Modo automático (promueve todo sin preguntar)
pnpm validate:watchlist -- --update --automatic

# Validar un solo sitio de la watchlist
pnpm validate:watchlist -- --id adnradio --update
```

Valida cada entrada de `watchlist.json`: redescubre feed, valida contenido, verifica frescura (< 30 días). Con `--update`, promueve los exitosos a `sites[]` en `feeds-database.json`. Al finalizar sin `--update`, pregunta si desea guardar los cambios (no obliga a re-ejecutar).

### Modo automático y CI

```bash
# CI: solo validación, no modifica archivos (read-only)
pnpm validate -- --automatic

# Batch: valida y actualiza sin preguntar
pnpm validate -- --update --automatic
```

**`--automatic` sin `--update`** no modifica ningún archivo — ideal para CI, PR checks y pre-commit hooks.
**`--update --automatic`** aplica cambios a `feeds-database.json` sin intervención (mantenimiento batch).

### Validar sitio específico

```bash
pnpm validate -- --id nombre-del-sitio --update
```

### Validación parcial por filtros

Útil para ejecuciones masivas por lotes o retomar validaciones interrumpidas.

Los filtros se aplican en este orden:

1. **Feed-level**: `--missing-date`, `--status <estado>` — filtran primero por condición del feed
2. **Site-level**: `--start-id`, `--from --to`, `--limit` — limitan cuántos sitios procesar

Esto permite, por ejemplo, validar solo 3 sitios con feeds nunca verificados (`--missing-date --limit 3`).

```bash
# Validar desde un site-id en adelante (los primeros 25)
pnpm validate -- --start-id bbc-mundo --limit 25

# Validar un rango numérico (inclusive)
pnpm validate -- --from 50 --to 100 --update

# Validar solo los primeros 10 sitios
pnpm validate -- --limit 10 --automatic
```

## Estructura de archivos

### `feeds-database.json`

```json
{
  "last_updated": "...",
  "total_feeds": 405,
  "sites": [
    {
      "id": "ejemplo",
      "name": "Ejemplo",
      "url": "https://ejemplo.cl",
      "category": "regional",
      "region": "valparaiso",
      "description": "Descripción objetiva del medio",
      "feeds": [
        {
          "id": "ejemplo-main",
          "name": "Ejemplo",
          "rss_url": "https://ejemplo.cl/feed/",
          "url": "https://ejemplo.cl", // OPTIONAL: override site.url for htmlUrl
          "feed_type": "RSS",
          "last_checked": "2026-06-06T00:00:00.000Z",
          "status": "active",
          "verified": true
        },
        {
          "id": "ejemplo-deportes",
          "name": "Ejemplo Deportes",
          "rss_url": "https://ejemplo.cl/rss/deportes/",
          "url": "https://ejemplo.cl/deportes/", // OPTIONAL: override site.url for htmlUrl
          "feed_type": "RSS",
          "category": "sports",
          "region": "biobio",
          "last_checked": "2026-06-06T00:00:00.000Z",
          "status": "active",
          "verified": true
        }
      ]
    }
  ]
}
```

**Categoría por feed**: Cada feed puede tener su propio `category` (opcional). Si se especifica, ese feed se lista en la categoría indicada. Si no, hereda la del sitio padre (`feed.category ?? site.category`).

**Región por feed**: Cada feed puede tener su propio `region` (opcional). Si se especifica, ese feed se incluye en el OPML de esa región. Si no, hereda la del sitio padre (`feed.region ?? site.region`).

**URL por feed**: Cada feed puede tener su propio `url` (opcional). Si se especifica, el `htmlUrl` del `<outline>` OPML apunta a esa URL en vez de la del sitio padre (`feed.url ?? site.url`). Útil cuando un subfeed corresponde a una sección o página específica del sitio.

### `categories.json`

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
      "politica"
    ],
    "order": 1
  },
  "technology": {
    "label": "💻 Tecnología y Startups",
    "slugs": ["tecnologia", "tech", "ciencia", "innovacion", "digital"],
    "order": 3
  }
}
```

`order` define la posición de la categoría en los outputs generados (OPML, README).
Usado por generate.js, validate-json.js, discover-category-feeds.js y validate-watchlist.js.
El array `slugs` permite que `discover-category-feeds.js` asigne automáticamente la categoría correcta a feeds descubiertos según el slug de WordPress.

### `regions.json`

```json
{
  "arica-y-parinacota": "Arica y Parinacota",
  "valparaiso": "Valparaíso"
}
```

Mapa de las 16 regiones oficiales de Chile. Compartido entre generate.js y validate-json.js. Las claves se usan en `site.region` y `feed.region`.

### `watchlist.json`

```json
[
  {
    "id": "sin-feed",
    "name": "Sitio Sin Feed",
    "url": "https://sinfeed.cl",
    "category": "news",
    "description": "Descripción objetiva y corta del sitio",
    "reason": "Sin feed RSS detectado",
    "feeds": []
  }
]
```

Estructura site-like con `feeds: []` y campos extra `reason` + `description`. Cuando se descubre un feed válido, `feeds[0]` se popula y `reason` se elimina — la entrada queda lista para promoverse a `sites[]`. Si el usuario opta por no promover, el `reason` original se preserva para mantener validez en CI.

## Algoritmo de descubrimiento

Los feeds se verifican **en paralelo por sitio** (`Promise.allSettled`) para que la caída de un feed no interrumpa la validación de los demás.

### Redescubrimiento contextual

Cuando un feed falla, el script infiere patrones de URL preferidos desde 3 señales:

- **Segmentos de la URL original** del feed roto (ej. `/deportes/feed/rss/`)
- **Palabras clave en el nombre** del feed (ej. "Deportes" → patrones de deportes)
- **Categoría** del feed o sitio padre (`feed.category ?? site.category`)

Estos patrones se anteponen a los patrones genéricos (`FEED_PATTERNS`) en la etapa 4 del redescubrimiento, aumentando la probabilidad de encontrar la URL correcta del subfeed.

### Protección contra reemplazo genérico

Si el feed original parece específico (tenía path segments como `/deportes/`) y el redescubrimiento solo encuentra un feed genérico (`/feed/`), el script:

- **Modo interactivo**: pregunta al usuario si reemplazar de todas formas
- **Modo automático** (`--automatic`): omite el reemplazo y marca el feed como `broken`

Esto evita degradar silenciosamente la base de datos reemplazando subfeeds temáticos por el feed principal del sitio.

### Cache de estado del sitio

`checkSiteStatus` se cachea por dominio para evitar consultas de red redundantes cuando un sitio tiene múltiples feeds fallidos.

### Flujo por feed

Para cada feed en `sites[]`:

1. **URL funciona con contenido RSS/Atom/JSON/RDF válido**
   - Soporta: RSS 2.0, Atom, JSON Feed (`application/feed+json`), RSS 1.0/RDF (<rdf:RDF)
   - Extrae la fecha del item más reciente (RSS `<pubDate>`, `<dc:date>`; Atom `<published>`, `<updated>`; JSON Feed `date_published`, `date_modified`)
   - Si el último item tiene > 30 días → marca `status: stale`
   - Si el feed está vacío (0 items) → marca `status: feed_empty`
   - Si no hay fechas en los items, usa `<lastBuildDate>` del canal como fallback

2. **URL responde con HTML, XML inválido o vacío** → `status: broken`
   - Intenta redescubrir el feed en el HTML raíz del sitio (con contexto del feed original)
   - Si encuentra nueva URL → valida con la protección contra reemplazo genérico
   - Si es segura → actualiza `rss_url` y marca `active`

3. **URL da HTTP error o timeout**
   - Verifica si el sitio raíz responde mediante (usando cache por dominio):
     - **TLS socket** (puerto 443) — detecta si el sitio acepta conexiones SSL
     - **HTTPS sin verificación** (`rejectUnauthorized: false`) — para certificados vencidos
     - **HTTP** (puerto 80) — para sitios bloqueados por CDN (Cloudflare, etc.)
   - Si el sitio está caído → pide confirmación (modo interactivo) o marca `offline` (automático)
   - Si el sitio responde → redescubrimiento en 4 etapas:
     1. **HTTP Link header** (`Link: <...>; rel="alternate"`)
     2. **HTML `<link>` tags** (`<link rel="alternate" type="application/rss+xml">`)
     3. **JSON-LD** (`<script type="application/ld+json">` con `WebFeed`)
     4. **Patrones URL** (primero los preferidos por contexto, luego los comunes)
   - Si encuentra nueva URL → valida con la protección contra reemplazo genérico
   - Si no encuentra → solicita URL manual o estado (interactivo) o marca `no_feed` (automático)

4. **Decisiones cacheadas por sitio**: cuando el usuario confirma un estado para el primer feed,
   se aplica automáticamente a los feeds restantes del mismo sitio.

### Estados de un feed

Los valores permitidos de `status` (`ALLOWED_STATUSES` en `lib/feed-utils.js`) son:

| Estado        | Significado                                                                        | ¿En OPML? |
| ------------- | ---------------------------------------------------------------------------------- | --------- |
| `active`      | Feed válido con items recientes (< 30 días)                                          | ✅ Sí     |
| `feed_empty`  | Feed válido pero sin items                                                          | ❌ No     |
| `stale`       | Feed válido con items, pero el más reciente es > 30 días                            | ❌ No     |
| `broken`      | La URL responde con contenido inválido y el redescubrimiento falló                 | ❌ No     |
| `offline`     | El sitio no responde (DNS, timeout, error de conexión)                              | ❌ No     |
| `no_feed`     | El sitio responde pero la URL del feed da error HTTP y no hay reemplazo             | ❌ No     |
| `duplicate`   | Repite ≥ 85% de sus items con otro feed del mismo sitio (lo marca `check:overlap`)  | ❌ No     |

Solo los feeds con `status: "active"` **y** `verified: true` se incluyen en los OPML, el README y los bookmarks.

### Detección de stale

| Condición                                       | Resultado                                        |
| ----------------------------------------------- | ------------------------------------------------ |
| Feed responde, último item > 30 días            | `stale`                                          |
| Feed responde, sin fecha en items (interactivo) | Pregunta al usuario (default: activo)            |
| Feed responde, sin fecha en items (automático)  | Se mantiene activo (conservador)                 |
| Fecha con año ≤ 1970                            | Filtrada como placeholder                        |
| Meses abreviados en español                     | Normalizados automáticamente (`ene.`→ Jan, etc.) |
| Sin fecha en items pero con `<lastBuildDate>`   | Usa la del canal como fallback                   |

### Resiliencia de red

- **Reintentos automáticos**: hasta 3 intentos con backoff exponencial (500ms, 1500ms, 3000ms) ante errores de red transitorios
- **Reintentos por rate limit**: HTTP 429 (Too Many Requests) y 503 (Service Unavailable) también se reintentan automáticamente
- **Rotación de User-Agent**: 6 variantes de navegadores modernos, rotadas en cada request
- **Control de concurrencia**: máximo 5 requests activos simultáneamente a nivel global
- **Delay por dominio**: mínimo 2 segundos entre requests al mismo dominio para evitar rate limits
- **Limpieza automática**: timestamps de dominios se purgan cada 60s para evitar fugas de memoria
- **Sin duplicados en redescubrimiento**: las URLs ya verificadas en etapas previas (Link header → HTML → JSON-LD → patrones) se omiten automáticamente

### Límites de seguridad

- Respuestas HTTP > 5 MB se rechazan
- Timeout de 10 segundos por petición
- Solo URLs `http:` / `https:` permitidas, sin IPs privadas
- Máximo 5 requests concurrentes activos a nivel global
- Mínimo 2 segundos de separación entre requests al mismo dominio

## Categorías disponibles

| Clave                | Etiqueta                                    |
| -------------------- | ------------------------------------------- |
| `news`               | 📰 Noticias Nacionales                      |
| `news-international` | 🌐 Noticias Internacionales                 |
| `government`         | 🏛️ Gobierno y Datos Públicos                |
| `education`          | 🏫 Educación, Universidades e Investigación |
| `regional`           | 🌎 Medios Regionales                        |
| `business`           | 💼 Negocios y Finanzas                      |
| `technology`         | 💻 Tecnología y Startups                    |
| `culture`            | 🎨 Cultura y Divulgación                    |
| `sports`             | ⚽ Deportes                                 |
| `community`          | 👥 Comunidad                                |

## Regiones disponibles

| Clave                | Nombre oficial                       |
| -------------------- | ------------------------------------ |
| `arica-y-parinacota` | Arica y Parinacota                   |
| `tarapaca`           | Tarapacá                             |
| `antofagasta`        | Antofagasta                          |
| `atacama`            | Atacama                              |
| `coquimbo`           | Coquimbo                             |
| `valparaiso`         | Valparaíso                           |
| `metropolitana`      | Metropolitana de Santiago            |
| `ohiggins`           | O'Higgins                            |
| `maule`              | Maule                                |
| `nuble`              | Ñuble                                |
| `biobio`             | Biobío                               |
| `araucania`          | Araucanía                            |
| `los-rios`           | Los Ríos                             |
| `los-lagos`          | Los Lagos                            |
| `aysen`              | Aysén                                |
| `magallanes`         | Magallanes y de la Antártica Chilena |

## Limitaciones

- 🚫 Algunos sitios bloquean User-Agent automático
- 🔄 Algunos feeds requieren autenticación o cookies
- 🔒 La detección de SSL vencido depende de la implementación de Node
