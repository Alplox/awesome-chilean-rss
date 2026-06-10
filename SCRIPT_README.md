# 🔍 Scripts del proyecto

## Descripción

Este proyecto usa scripts Node.js organizados por funcionalidad:

### Scripts principales (core/)

| Script                                  | Comando                                          | Propósito                                                                      |
|------------------------------------------|--------------------------------------------------|--------------------------------------------------------------------------------|
| `scripts/core/validate_feeds.js`         | `npm run validate`                             | Valida feeds sin modificar feeds-database.json                                 |
|                                          | `npm run validate -- --update`                 | Revalida feeds, redescubre URLs rotas y actualiza feeds-database.json          |
|                                          | `npm run validate -- --id <site-id>`            | Valida solo un sitio específico por su ID                                      |
|                                          | `npm run validate -- --id <site-id> --update`  | Valida y actualiza solo un sitio específico                                    |
|                                          | `npm run validate -- --url <URL>`               | Valida una URL específica (feed o sitio) sin modificar BD          |
|                                          | `npm run validate -- --watchlist`               | Redirige a `npm run validate:watchlist`                            |
|                                          | `npm run validate -- --update --automatic`      | Modo no interactivo para CI/desatendido                            |
| `scripts/core/generate.js`               | `npm run generate`                              | Lee `feeds-database.json` y `categories.json`, regenera OPML y README         |
| `scripts/core/validate-watchlist.js`     | `npm run validate:watchlist`                   | Valida watchlist, promueve feeds válidos a sites con `--update`    |
|                                          | `npm run validate:watchlist -- --update`        | Promueve automáticamente los feeds válidos a sites[]               |
|                                          | `npm run validate:watchlist -- --automatic`     | Modo no interactivo (promueve todo sin preguntar)                  |
|                                          | `npm run validate:watchlist -- --id <id>`       | Valida y promueve solo un sitio específico de la watchlist         |

### Scripts de validación (validation/)

| Script                                      | Comando                  | Propósito                                    |
|----------------------------------------------|--------------------------|----------------------------------------------|
| `scripts/validation/validate-json.js`        | `npm run validate:json`  | Valida la estructura del JSON (usado por CI) |
| `scripts/validation/validate-opml.js`        | `npm run validate:opml`  | Valida la sintaxis del OPML (usado por CI)   |

### Scripts utilitarios (utils/)

| Script                                      | Comando                                                 | Propósito                                                          |
|----------------------------------------------|---------------------------------------------------------|--------------------------------------------------------------------|
| `scripts/utils/verify-feeds.js`              | `node scripts/utils/verify-feeds.js <feeds.json>`        | Verifica feeds RSS/Atom desde un archivo JSON                       |
|                                              | `node scripts/utils/verify-feeds.js <URL>`              | Verifica una URL de feed específica directamente        |

### Módulos de validación (lib/)

La lógica de red y redescubrimiento está organizada en módulos independientes:

| Módulo | Propósito |
|--------|-----------|
| `lib/feed-validator.js`  | Parseo RSS/Atom/JSON/RDF: `fetchSafe`, `checkFeedUrl`, `detectFeedType`, `getMostRecentDate`, `readResponseBody` |
| `lib/network-utils.js`   | Red: `checkSiteReachable`, `checkCertError`, `tryFetchFeedInsecure`, `isValidUrl` |
| `lib/feed-rediscovery.js`| Redescubrimiento: `extractFeedLinksFromHtml`, `rediscoverFeed`, `FEED_PATTERNS`, `parseLinkHeader`, `extractJsonLdFeeds` |
| `lib/prompter.js`        | Prompts: `promptUser`, `promptUrl`, `promptStatus`, `isAutomatic` |
| `lib/watchlist-validator.js` | Watchlist: `validateWatchlistEntry`, `promoteToSite` |

### Flujo de trabajo

```
feeds-database.json          categories.json          watchlist.json
  └── sites[]                  └── categories{}         └── sites sin feed
       │                              │                       │
       ▼                              ▼                       ▼
  validate_feeds.js ──────────►  generate.js ────────►  validate-watchlist.js
  (lib/*, rediscover)           (group by category)     (lib/watchlist-validator.js)
       │                              │                       │
       ▼                              ▼                       ▼
  feeds-database.json          chilean-rss.opml         feeds-database.json†
                               README.md                watchlist.json†
                                                        († con --update)
```

**Para agregar un feed:** edita `feeds-database.json` y ejecuta `npm run generate`. Si es una categoría nueva, agrégala también en `categories.json`.

**Para agregar un candidato sin feed conocido:** agrega la entrada en `watchlist.json` con estructura site-like y `feeds: []`.

**Para revalidar feeds existentes:** ejecuta `npm run validate`.

**Para promover candidatos de la watchlist:** ejecuta `npm run validate:watchlist -- --update`.

## Requisitos

- Node.js >= 18.13.0 (usa `fetch` nativo)

## Instalación

```bash
npm install
```

## Uso

```bash
# Regenerar OPML y README desde feeds-database.json + categories.json
npm run generate

# Revalidar todos los feeds, redescubrir URLs rotas
npm run validate

# Validar y promover watchlist
npm run validate:watchlist

# Validaciones individuales (usadas por CI)
npm run validate:json
npm run validate:opml
```

## 🆕 Modos de Validación

### Validar una URL específica

```bash
# Valida un feed o sitio sin modificar la BD
npm run validate -- --url https://ejemplo.com/feed.xml
npm run validate -- --url https://ejemplo.com
```

Útil para testear feeds individuales antes de agregarlos.

### Validar y promover watchlist

```bash
# Validar sin modificar
npm run validate:watchlist

# Validar y promover feeds descubiertos a sites[]
npm run validate:watchlist -- --update

# Modo automático (promueve todo sin preguntar)
npm run validate:watchlist -- --update --automatic

# Validar un solo sitio de la watchlist
npm run validate:watchlist -- --id adnradio --update
```

Valida cada entrada de `watchlist.json`: redescubre feed, valida contenido, verifica frescura (< 365 días). Con `--update`, promueve los exitosos a `sites[]` en `feeds-database.json`. Al finalizar sin `--update`, pregunta si desea guardar los cambios (no obliga a re-ejecutar).

### Modo automático (CI)

```bash
# Sin prompts interactivos, decisiones conservadoras por defecto
npm run validate -- --update --automatic
```

Para integración continua o ejecución desatendida.

### Validar sitio específico

```bash
npm run validate -- --id nombre-del-sitio --update
```

## Estructura de archivos

### `feeds-database.json`

```json
{
  "last_updated": "...",
  "total_feeds": 270,
  "sites": [
    {
      "id": "ejemplo",
      "name": "Ejemplo",
      "url": "https://ejemplo.cl",
      "category": "news",
      "description": "Descripción objetiva del medio",
      "feeds": [
        {
          "id": "ejemplo-main",
          "name": "Ejemplo",
          "rss_url": "https://ejemplo.cl/feed/",
          "feed_type": "RSS",
          "last_checked": "2026-06-06T00:00:00.000Z",
          "status": "active",
          "verified": true
        },
        {
          "id": "ejemplo-deportes",
          "name": "Ejemplo Deportes",
          "rss_url": "https://ejemplo.cl/rss/deportes/",
          "feed_type": "RSS",
          "category": "sports",
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

### `categories.json`

```json
{
  "news": "📰 Noticias Nacionales",
  "technology": "💻 Tecnología y Startups"
}
```

Compartido entre generate.js, validate-json.js y validate-watchlist.js.

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

Los feeds se verifican **en paralelo por sitio** (`Promise.all`) para maximizar velocidad.

Para cada feed en `sites[]`:

1. **URL funciona con contenido RSS/Atom/JSON/RDF válido**
   - Soporta: RSS 2.0, Atom, JSON Feed (`application/feed+json`), RSS 1.0/RDF (<rdf:RDF)
   - Extrae la fecha del item más reciente (RSS `<pubDate>`, `<dc:date>`; Atom `<published>`, `<updated>`; JSON Feed `date_published`, `date_modified`)
   - Si el último item tiene > 365 días → marca `status: stale`
   - Si el feed está vacío (0 items) → marca `status: no_feed`
   - Si no hay fechas en los items, usa `<lastBuildDate>` del canal como fallback

2. **URL responde con HTML, XML inválido o vacío** → `status: broken`
   - Intenta redescubrir el feed en el HTML raíz del sitio
   - Si encuentra nueva URL → actualiza `rss_url` y marca `active`

3. **URL da HTTP error o timeout**
   - Verifica si el sitio raíz responde mediante:
     - **TLS socket** (puerto 443) — detecta si el sitio acepta conexiones SSL
     - **HTTPS sin verificación** (`rejectUnauthorized: false`) — para certificados vencidos
     - **HTTP** (puerto 80) — para sitios bloqueados por CDN (Cloudflare, etc.)
   - Si el sitio está caído → pide confirmación (modo interactivo) o marca `offline` (automático)
   - Si el sitio responde → redescubrimiento en 4 etapas:
     1. **HTTP Link header** (`Link: <...>; rel="alternate"`)
     2. **HTML `<link>` tags** (`<link rel="alternate" type="application/rss+xml">`)
     3. **JSON-LD** (`<script type="application/ld+json">` con `WebFeed`)
     4. **Patrones URL comunes** (`/feed/`, `/rss/`, CMS patterns, well-known URIs)
   - Si encuentra nueva URL → actualiza `rss_url` y marca `active`
   - Si no encuentra → solicita URL manual o estado (interactivo) o marca `no_feed` (automático)

4. **Decisiones cacheadas por sitio**: cuando el usuario confirma un estado para el primer feed,
   se aplica automáticamente a los feeds restantes del mismo sitio.

### Detección de stale

| Condición | Resultado |
|-----------|-----------|
| Feed responde, último item > 365 días | `stale` |
| Feed responde, sin fecha en items (interactivo) | Pregunta al usuario (default: activo) |
| Feed responde, sin fecha en items (automático) | Se mantiene activo (conservador) |
| Fecha con año ≤ 1970 | Filtrada como placeholder |
| Meses abreviados en español | Normalizados automáticamente (`ene.`→ Jan, etc.) |
| Sin fecha en items pero con `<lastBuildDate>` | Usa la del canal como fallback |

### Resiliencia de red

- **Reintentos automáticos**: hasta 3 intentos con backoff exponencial (500ms, 1500ms, 3000ms) ante errores de red transitorios
- **Sin duplicados en redescubrimiento**: las URLs ya verificadas en etapas previas (Link header → HTML → JSON-LD → patrones) se omiten automáticamente

### Límites de seguridad

- Respuestas HTTP > 5 MB se rechazan
- Timeout de 10 segundos por petición
- Solo URLs `http:` / `https:` permitidas, sin IPs privadas

## Categorías disponibles

| Clave | Etiqueta |
|---|---|
| `news` | 📰 Noticias Nacionales |
| `government` | 🏛️ Gobierno y Datos Públicos |
| `universities` | 🏫 Universidades e Investigación |
| `regional` | 🌎 Medios Regionales |
| `business` | 💼 Negocios y Finanzas |
| `technology` | 💻 Tecnología y Startups |
| `culture` | 🎨 Cultura y Divulgación |
| `sports` | ⚽ Deportes |
| `community` | 👥 Comunidad |

## Limitaciones

- 🚫 Algunos sitios bloquean User-Agent automático
- 🔄 Algunos feeds requieren autenticación o cookies
- 🔒 La detección de SSL vencido depende de la implementación de Node
