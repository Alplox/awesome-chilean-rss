# 🔍 Scripts del proyecto

## Descripción

Este proyecto usa tres scripts Node.js con responsabilidades separadas:

| Script | Comando | Propósito |
|---|---|---|
| `validate_feeds.js` | `npm run validate` | Revalida los feeds del JSON, redescubre URLs rotas y reintenta la watchlist |
| `generate.js` | `npm run generate` | Lee `feeds-database.json` y regenera `chilean-rss.opml` y `README.md` |
| `scripts/validate-json.mjs` | `npm run validate:json` | Valida la estructura del JSON (usado por CI) |
| `scripts/validate-opml.mjs` | `npm run validate:opml` | Valida la sintaxis del OPML (usado por CI) |

### Flujo de trabajo

```
feeds-database.json  ──►  generate.js        ──►  chilean-rss.opml
       ▲                                      ──►  README.md
       │
  validate_feeds.js  ──►  revalida feeds activos
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

## Estructura de feeds-database.json

```json
{
  "last_updated": "...",
  "total_feeds": 55,
  "categories": {
    "news": "📰 Noticias Nacionales",
    "government": "🏛️ Gobierno y Datos Públicos"
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

## Algoritmo de descubrimiento (validate_feeds.js)

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
