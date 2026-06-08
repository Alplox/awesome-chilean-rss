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
|                                          | `npm run validate -- --watchlist`               | Valida solo los sitios en la watchlist (retest rápido)             |
| `scripts/core/generate.js`               | `npm run generate`                              | Lee `feeds-database.json` y regenera `chilean-rss.opml` y `README.md`         |

### Scripts de validación (validation/)

| Script                                      | Comando                  | Propósito                                    |
|----------------------------------------------|--------------------------|----------------------------------------------|
| `scripts/validation/validate-json.mjs`       | `npm run validate:json`  | Valida la estructura del JSON (usado por CI) |
| `scripts/validation/validate-opml.mjs`       | `npm run validate:opml`  | Valida la sintaxis del OPML (usado por CI)   |

### Scripts utilitarios (utils/)

| Script                                      | Comando                                                 | Propósito                                                          |
|----------------------------------------------|---------------------------------------------------------|--------------------------------------------------------------------|
| `scripts/utils/verify-feeds.js`              | `node scripts/utils/verify-feeds.js <feeds.json>`        | Verifica feeds RSS/Atom desde un archivo JSON                       |
|                                              | `node scripts/utils/verify-feeds.js <URL>`              | Verifica una URL de feed específica directamente        |

### Flujo de trabajo

```
feeds-database.json  ──►  scripts/core/generate.js  ──►  chilean-rss.opml
       ▲                                            ──►  README.md
       │
  scripts/core/validate_feeds.js  ──►  revalida feeds activos
                                 ──►  redescubre URLs rotas
                                 ──►  reintenta sitios en watchlist
```

**Para agregar un feed:** edita `feeds-database.json` y ejecuta `npm run generate`.

**Para revalidar feeds existentes:** ejecuta `npm run validate`.

## Requisitos

- Node.js >= 18.0.0 (usa `fetch` nativo)

## Instalación

```bash
npm install
```

## Uso

```bash
# Regenerar OPML y README desde feeds-database.json
npm run generate

# Revalidar todos los feeds, redescubrir URLs rotas y reintentar watchlist
npm run validate

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

### Validar watchlist

```bash
# Retest rápido de sitios en espera
npm run validate -- --watchlist
```

Valida solo los 100+ sitios de la watchlist. Muestra cuáles ahora tienen feed.

### Verificar feed directamente

```bash
# Verifica una URL desde verify-feeds.js
node scripts/utils/verify-feeds.js https://ejemplo.com/feed.xml

# Verifica un archivo de feeds JSON
node scripts/utils/verify-feeds.js feed-test.json
```

## Estructura de feeds-database.json

```json
{
  "last_updated": "...",
  "total_feeds": 55,
  "categories": {
    "news": "📰 Noticias Nacionales",
    "government": "🏛️ Gobierno y Datos Públicos",
    "community": "👥 Comunidad"
  },
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
        }
      ]
    }
  ],
  "watchlist": [
    {
      "id": "sin-feed",
      "name": "Sitio Sin Feed",
      "url": "https://sinfeed.cl",
      "category": "news",
      "reason": "Sin feed RSS detectado"
    }
  ]
}
```

**Sitios con múltiples feeds** (como El Desconcierto o el SII) usan el mismo esquema con más entradas en `feeds[]`.

## Algoritmo de descubrimiento (scripts/core/validate_feeds.js)

Para cada feed en `sites[]`:

1. **Verifica la `rss_url` actual** — si sigue funcionando, actualiza `last_checked` y continúa.
2. **Si falla**, comprueba si el sitio raíz responde (HEAD/GET).
   - `🔴 sitio caído` → marca `status: offline`.
3. **Si el sitio está activo**, intenta redescubrir el feed en este orden:
   - Tags `<link rel="alternate" type="application/rss+xml">` en el HTML raíz
   - Patrones comunes: `/feed/` `/feed` `/rss/` `/rss` `/rss.xml` `/feed.xml` `/atom/` `/atom` `/atom.xml` `/index.xml` `/feeds`
   - Si encuentra una URL nueva → actualiza `rss_url` y marca `🔄 URL corregida`
   - Si no encuentra nada → marca `status: no_feed`

Al terminar, **reintenta automáticamente** todos los sitios de `watchlist[]` buscando si alguno publicó un feed nuevo.

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
| `podcasts` | 🎧 Podcasts |
| `opendata` | 📋 Datos Públicos y Oficiales |

## Limitaciones

- ⏱️ Timeout de 10 segundos por sitio (configurable con `TIMEOUT_MS`)
- 🚫 Algunos sitios bloquean User-Agent automático
- 🔄 Algunos feeds requieren autenticación o cookies
