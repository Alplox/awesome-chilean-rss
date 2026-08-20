# Modos de Validación - Guía Rápida

## `validate_feeds.js`

### 🎯 Modo URL única: `--url <URL>`

Valida un feed o sitio específico sin modificar la BD.

```bash
# Validar un feed RSS directamente
node scripts/core/validate_feeds.js --url https://ejemplo.com/feed.xml

# Validar un sitio (intenta redescubrir feeds)
node scripts/core/validate_feeds.js --url https://ejemplo.com
```

**Salida:**

- Si es feed válido: muestra tipo, cantidad de items y fecha del último item
- Si no es feed directo: intenta redescubrir desde el sitio base

---

### 🔭 Modo Watchlist: `--watchlist`

Muestra instrucciones para usar `npm run validate:watchlist`.

---

### ✅ Modo sitio específico: `--id <site-id>`

Valida solo un sitio de la BD.

```bash
node scripts/core/validate_feeds.js --id ejemplo-cl --update
```

---

### 📐 Modo rango numérico: `--from <N> --to <N>`

Valida un rango de sitios por índice numérico (inclusive).

```bash
# Validar sitios del índice 50 al 100
node scripts/core/validate_feeds.js --from 50 --to 100 --update

# Solo validación, sin cambios
node scripts/core/validate_feeds.js --from 0 --to 10 --automatic
```

Útil para ejecuciones por lotes o para retomar desde un punto específico.

---

### 🏁 Modo desde ID: `--start-id <site-id>`

Comienza la validación desde un site-id específico (inclusive). Ideal para reanudar validaciones largas después de una interrupción.

```bash
# Desde un ID, solo los primeros 25
node scripts/core/validate_feeds.js --start-id bbc-mundo --limit 25 --automatic

# Desde un ID, hasta el final
node scripts/core/validate_feeds.js --start-id bbc-mundo --update
```

Se puede combinar con `--limit` para controlar cuántos sitios procesar.

---

### 🔢 Modo límite: `--limit <N>`

Procesa solo los primeros N sitios. Se aplica al final, después de cualquier otro filtro.

```bash
node scripts/core/validate_feeds.js --limit 5 --automatic
node scripts/core/validate_feeds.js --start-id adnradio --limit 10
```

---

### 🔄 Modo completo: Sin opciones

Valida todos los feeds de `sites` en feeds-database.json.

```bash
# Solo validación (sin cambios)
node scripts/core/validate_feeds.js

# Con actualización (aplica cambios a la BD)
node scripts/core/validate_feeds.js --update
```

---

### 📋 Modo Watchlist: `validate:watchlist`

Valida cada entrada de `watchlist.json` e intenta promover las exitosas a `sites[]`.

```bash
# Solo validar (sin cambios)
npm run validate:watchlist

# Validar y promover feeds descubiertos
npm run validate:watchlist -- --update

# Modo automático (promueve todo sin preguntar)
npm run validate:watchlist -- --update --automatic

# Validar un solo sitio de la watchlist
npm run validate:watchlist -- --id adnradio [--update]
```

**Flujo por entrada:**
1. Redescubre feed vía `rediscoverFeed()` (HTML + patrones, sin duplicados entre etapas)
2. Valida contenido vía `checkFeedUrl()` (RSS/Atom/JSON/RDF)
3. Verifica frescura (< 30 días, salvo automático)
4. Si todo ok → `promoteToSite()` llena `feeds[0]` y elimina `reason`
5. Interactivo: pregunta si promover ahora o mantener en watchlist
6. Automático: promueve directamente

**Al finalizar sin `--update`:** pregunta si guardar los cambios (no obliga a re-ejecutar).

**Al mantener en watchlist:** el `reason` original se preserva para mantener validez en CI.

**Salida:** lista de promovidos, errores categorizados, resumen.

---

### 🤖 Modo automático: `--automatic`

Desactiva todos los prompts interactivos para CI o ejecución desatendida.

```bash
# CI: solo validación, no modifica archivos (read-only)
npm run validate -- --automatic

# Batch: valida y actualiza sin preguntar
npm run validate -- --update --automatic
```

**Con `--automatic` solo** (sin `--update`):
- No modifica ningún archivo
- Ideal para CI, workflows automáticos, pre-commit hooks
- Reporta feeds rotos sin alterar la base de datos
- Se ejecuta en GitHub Actions en PRs y manualmente

**Con `--update --automatic`**:
- Aplica cambios a `feeds-database.json` sin intervención
- Útil para mantenimiento batch programado

En ambos modos:
- Feeds sin fecha de último item se mantienen activos por defecto (conservador)
- URLs fallidas se marcan automáticamente según el tipo de error
- Rediscovery fallido se marca como `no_feed`
- Sin mensajes interactivos de confirmación

---

## Comparativa de modos

| Comando                  | Valida       | Modifica BD | Velocidad | Caso de Uso         |
| ------------------------ | ------------ | ----------- | --------- | ------------------- |
| `--url <URL>`            | 1 feed/sitio | ❌ No       | ⚡ Rápido | Test individual     |
| `--id <id>` + `--update`| 1 sitio BD   | ✅ Sí       | ⚡ Rápido | Fix individual      |
| `--from <N> --to <N>`    | Rango BD     | según flag  | 🐢 Lento  | Lote por índice     |
| `--start-id <id>`        | Desde ID     | según flag  | 🐢 Lento  | Reanudar validación |
| `--limit <N>`            | Primeros N   | según flag  | 🐢 Lento  | Muestra rápida      |
| Sin opciones             | Todos (BD)   | ❌ No       | 🐢 Lento  | Solo validación     |
| `--automatic`            | Todos (BD)   | ❌ No       | 🐢 Lento  | CI / pre-commit    |
| `--update --automatic`   | Todos (BD)   | ✅ Sí       | 🐢 Lento  | Batch silencioso    |
| `validate:watchlist`     | Watchlist    | ❌ No       | 🐢 Lento  | Retest watchlist    |
| `validate:watchlist -- --update` | Watchlist | ✅ Sí     | 🐢 Lento  | Promover watchlist  |
| `validate:watchlist -- --id <id>` | 1 watchlist | según flag | ⚡ Rápido | Promover uno solo |

---

## Detección de feeds obsoletos (stale)

Cuando un feed responde correctamente, se extrae la fecha del item más reciente
de sus entradas RSS/Atom/JSON. Si el último item tiene más de **30 días**, el feed
se marca como `stale` y se excluye de los archivos generados.

El orden de resolución de fecha es:
1. `<pubDate>` del item RSS
2. `<dc:date>` del item RSS
3. `<published>` del entry Atom
4. `<updated>` del entry Atom
5. `date_published` del item JSON Feed
6. `date_modified` del item JSON Feed
7. `<lastBuildDate>` del canal RSS (fallback si ningún item tiene fecha)

Las fechas con año `<= 1970` se filtran como placeholders.
Los meses abreviados en español (`ene.`, `feb.`, etc.) se normalizan automáticamente.

---

## Estructura del módulo (`lib/`)

La lógica de validación está organizada en módulos separados:

| Módulo | Responsabilidad |
|--------|----------------|
| `lib/feed-validator.js` | Core RSS/Atom/JSON/RDF parsing: `fetchSafe`, `checkFeedUrl`, `detectFeedType`, `getMostRecentDate`, `readResponseBody` |
| `lib/network-utils.js` | Red: `checkSiteStatus`, `checkCertError`, `checkSiteReachable`, `tryFetchFeedInsecure`, `isValidUrl` |
| `lib/feed-rediscovery.js` | Redescubrimiento: `extractFeedLinksFromHtml`, `rediscoverFeed`, `FEED_PATTERNS`, `parseLinkHeader`, `extractJsonLdFeeds` |
| `lib/prompter.js` | Prompts interactivos: `promptUser`, `promptUrl`, `promptStatus`, `isAutomatic` |
| `lib/watchlist-validator.js` | Watchlist pipeline: `validateWatchlistEntry`, `promoteToSite` |

---

## Algoritmo de redescubrimiento

### Redescubrimiento contextual

Cuando un feed falla, el script genera patrones de URL preferidos basados en:
- **Segmentos de la URL original** del feed roto
- **Palabras clave en el nombre** del feed
- **Categoría** del feed o sitio padre

Estos patrones se anteponen a los genéricos en la etapa 4, aumentando la probabilidad de hallar la URL correcta del subfeed.

### Protección contra reemplazo genérico

Si el feed original tiene un path específico (ej. `/deportes/`) y el redescubrimiento solo encuentra uno genérico (`/feed/`):
- **Interactivo**: pregunta al usuario antes de reemplazar
- **Automático** (`--automatic`): omite el reemplazo, marca `broken`

Esto evita degradar la base reemplazando subfeeds temáticos por el feed principal.

### Cache de estado del sitio

`checkSiteStatus` se cachea por dominio para evitar consultas redundantes cuando un sitio tiene múltiples feeds fallidos.

### Flujo

Cuando una URL de feed falla:

1. **Contenido inválido (HTML, XML roto, feed vacío)**
   - El sitio está vivo → intenta redescubrir el feed en el HTML raíz
   - Usa patrones preferidos según el contexto del feed original
   - Si encuentra una URL nueva → aplica la protección contra reemplazo genérico
   - Si es segura o el usuario confirma → actualiza `rss_url`, marca `active`
   - Si falla → marca `broken`

2. **HTTP error o timeout**
   - **403 / 429 (bloqueo anti-bot)** → no redescubre ni pregunta: el feed puede
     estar sano pero el servidor bloquea al script. Con `--update` intenta leer
     el feed con un navegador headless (Playwright, `npm run install:browser`),
     resolviendo challenges de Cloudflare pasivos; si lo logra lo marca `active`
     (o `stale` si está vencido). Si el challenge no se resuelve (ej. Turnstile
     interactivo) conserva el estado y lo lista como "🚫 Bloqueado bot".
   - Verifica si el sitio raíz responde (HEAD/GET con detección de TLS, cacheado por dominio)
   - **SSL vencido** → intenta leer el feed ignorando el certificado
   - **Bloqueado por CDN** (Cloudflare) → cae a HTTP (puerto 80)
   - **Sitio realmente caído** → marca `offline` (con confirmación interactiva)
   - Si el sitio está activo → redescubrimiento en 4 etapas:
     1. **HTTP Link header** (`Link: <...>; rel="alternate"`)
     2. **HTML `<link>` tags** + `application/feed+json`
     3. **JSON-LD** (`WebFeed` type con `url`)
     4. **Patrones URL** (primero los preferidos por contexto, luego los comunes)
   - Si encuentra nueva URL → aplica la protección contra reemplazo genérico
   - Si no encuentra → marca `no_feed`

3. **Decisiones cacheadas** por sitio: una vez que el usuario confirma el estado
   de un feed, se aplica automáticamente a los feeds restantes del mismo sitio.

---

## Tipos de feed soportados

| Tipo | Detección |
|------|-----------|
| RSS 2.0 | `<rss version="2.0">` |
| Atom | `<feed xmlns="http://www.w3.org/2005/Atom">` |
| JSON Feed | `application/feed+json` + validación de campos |
| RSS 1.0 / RDF | `<rdf:RDF` + `parsed['rdf:RDF']?.channel` |

---

## Respaldo de red

- **Reintentos automáticos**: hasta 3 intentos con backoff exponencial (500ms, 1500ms, 3000ms) en `fetchSafe` ante errores de red transitorios
- **Sin duplicados**: `rediscoverFeed` usa un `Set` de URLs ya verificadas para evitar chequeos redundantes entre sus 4 etapas

## Límites de seguridad

- **Tamaño máximo de respuesta**: 5 MB (cualquier body mayor se rechaza)
- **Timeout por petición**: 10 segundos
- **Validación de URL**: solo `http:` / `https:`, sin IPs privadas
- **Detección de charset**: auto-detected via Content-Type header → XML declaration → utf-8 fallback

---

## Workflows de GitHub Actions

### `check-format.yml`
- **Disparo**: PR + manual (`workflow_dispatch`)
- **Ejecuta**: `npm run ci` (validate:json + validate:opml + generate + diff)
- **Propósito**: verificar formato y sincronía de archivos

### `validate-links.yml`
- **Disparo**: solo manual (`workflow_dispatch`)
- **Ejecuta**: `npm run validate -- --automatic` (read-only)
- **Propósito**: verificar que las URLs de feed respondan correctamente
