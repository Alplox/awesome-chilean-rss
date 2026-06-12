# 🤝 Guía de Contribución - Awesome Chilean RSS

¡Gracias por querer contribuir a este proyecto! Cualquier aporte que ayude a mejorar esta curación de feeds RSS chilenos es bienvenido.

## 📋 ¿Cómo contribuir?

### 1. Agregar un nuevo feed

Si deseas agregar un nuevo feed RSS, por favor asegúrate de cumplir con estos requisitos:

#### Información requerida:

- **Nombre del medio/sitio**: El nombre oficial del sitio (ej: "BioBioChile", "Ciper Chile")
- **URL del sitio web**: La página principal del sitio (ej: `https://www.biobiochile.cl`)
- **URL del feed RSS**: El enlace directo al feed RSS (ej: `https://www.biobiochile.cl/rss`)
- **Categoría**: Elige una categoría existente o propón una nueva:
  - 📰 Noticias Nacionales
  - 💻 Tecnología y Startups
  - 🏛️ Gobierno y Datos Públicos
  - 🏫 Universidades e Investigación
  - 🌎 Medios Regionales
  - 💼 Negocios y Finanzas
  - 🎨 Cultura y Divulgación
  - ⚽ Deportes
  - 🎧 Podcasts
  - 📋 Datos Públicos y Oficiales
  - (Otras categorías bienvenidas)
- **Descripción breve**: 1-2 líneas explicando qué tipo de contenido ofrece el feed

> **💡 Categoría por feed**: Si un sitio tiene feeds de distintas temáticas (ej: noticias generales + deportes + tecnología), puedes asignar **categorías diferentes a cada feed** agregando el campo `"category"` dentro del feed. Si no se especifica, hereda la categoría del sitio.

#### Criterios para una buena descripción

La descripción debe ser **objetiva y factual**. Describe qué cubre el medio, no su relevancia, popularidad o posición editorial.

✅ Correcto:

- "Portal de noticias nacionales e internacionales con cobertura política y económica"
- "Diario regional de la Región de Magallanes"
- "Publicación oficial del Estado chileno con leyes, decretos y resoluciones"

❌ Evitar:

- Superlativos: "el más leído", "el más grande", "el más completo"
- Valoraciones: "muy confiable", "de alta calidad", "imprescindible"
- Etiquetas ideológicas: "de izquierda", "progresista", "conservador", "alternativo"
- Juicios de valor: "excelente cobertura", "muy popular"

#### Ejemplo de entrada en feeds-database.json

Sitio con un solo feed:

```json
{
  "id": "nombre-del-medio",
  "name": "Nombre del Medio",
  "url": "https://ejemplo.cl",
  "category": "news",
  "description": "Descripción objetiva del medio en una línea",
  "feeds": [
    {
      "id": "nombre-del-medio-main",
      "name": "Nombre del Medio",
      "rss_url": "https://ejemplo.cl/feed/",
      "url": "https://ejemplo.cl/seccion/",   // OPTIONAL: override site.url for htmlUrl
      "feed_type": "RSS",
      "last_checked": "2026-01-01T00:00:00.000Z",
      "status": "active",
      "verified": true
    }
  ]
}
```

Sitio con múltiples feeds por sección:

```json
{
  "id": "nombre-del-medio",
  "name": "Nombre del Medio",
  "url": "https://ejemplo.cl",
  "category": "news",
  "description": "Descripción objetiva del medio en una línea",
  "feeds": [
    {
      "id": "nombre-del-medio-noticias",
      "name": "Noticias",
      "rss_url": "https://ejemplo.cl/rss/noticias.xml",
      "url": "https://ejemplo.cl/noticias/",   // OPTIONAL: override site.url for htmlUrl
      "feed_type": "RSS",
      "last_checked": "2026-01-01T00:00:00.000Z",
      "status": "active",
      "verified": true
    },
    {
      "id": "nombre-del-medio-opinion",
      "name": "Opinión",
      "rss_url": "https://ejemplo.cl/rss/opinion.xml",
      "url": "https://ejemplo.cl/opinion/",    // OPTIONAL: override site.url for htmlUrl
      "feed_type": "RSS",
      "last_checked": "2026-01-01T00:00:00.000Z",
      "status": "active",
      "verified": true
    }
  ]
}
```

Sitio con **categorías diferentes por feed**:

```json
{
  "id": "sitio-con-secciones",
  "name": "Sitio con Secciones",
  "url": "https://ejemplo.cl",
  "category": "news",
  "description": "Portal con secciones de noticias, tecnología y deportes",
  "feeds": [
    {
      "id": "sitio-con-secciones-ultimas-noticias",
      "name": "Últimas Noticias",
      "rss_url": "https://ejemplo.cl/rss/noticias.xml",
      "url": "https://ejemplo.cl",              // OPTIONAL: override site.url for htmlUrl
      "feed_type": "RSS",
      "last_checked": "2026-01-01T00:00:00.000Z",
      "status": "active",
      "verified": true
    },
    {
      "id": "sitio-con-secciones-tecnologia",
      "name": "Tecnología",
      "rss_url": "https://ejemplo.cl/rss/tecnologia.xml",
      "url": "https://ejemplo.cl/tecnologia/",  // OPTIONAL: override site.url for htmlUrl
      "feed_type": "RSS",
      "category": "technology",
      "last_checked": "2026-01-01T00:00:00.000Z",
      "status": "active",
      "verified": true
    },
    {
      "id": "sitio-con-secciones-deportes",
      "name": "Deportes",
      "rss_url": "https://ejemplo.cl/rss/deportes.xml",
      "url": "https://ejemplo.cl/deportes/",   // OPTIONAL: override site.url for htmlUrl
      "feed_type": "RSS",
      "category": "sports",
      "last_checked": "2026-01-01T00:00:00.000Z",
      "status": "active",
      "verified": true
    }
  ]
}
```

> ⚠️ El campo `category` en un feed es **opcional**. Si no se especifica, el feed hereda la categoría del sitio. Si se especifica, debe coincidir con una clave existente en `categories` (validado automáticamente).

### 2. Validación de feeds

Antes de contribuir, verifica que:

- ✅ El feed RSS esté **activo y accesible** (no devuelva error 404/500)
- ✅ El feed se actualice con **regularidad** (idealmente al menos una vez al mes)
- ✅ El contenido sea **relevante para Chile** (medios chilenos, cobertura de temas chilenos)
- ✅ El feed no esté **duplicado** en la lista

### 3. Cómo hacer un Pull Request

1. **Fork** este repositorio
2. **Clone** tu fork localmente:
   ```bash
   git clone https://github.com/alplox/awesome-chilean-rss.git
   cd awesome-chilean-rss
   ```
3. **Crea una rama** para tu contribución:
   ```bash
   git checkout -b agregar/nombre-del-medio
   ```
4. **Edita** el archivo [`feeds-database.json`](feeds-database.json):
   - Agrega tu sitio en el array `sites` con los campos requeridos
   - Si el sitio ofrece múltiples feeds (por sección o temática), agrégalos todos bajo el campo `feeds[]` del mismo sitio
   - Ejecuta `npm run generate` para regenerar `README.md`, `dist/opml/chilean-rss.opml` y demás OPMLs automáticamente:
   ```bash
   npm install
   npm run generate
   ```
5. **Commit** con un mensaje claro:
   ```bash
   git commit -m "Agregar: Nombre del Medio en categoría X"
   ```
6. **Push** a tu rama:
   ```bash
   git push origin agregar/nombre-del-medio
   ```
7. **Abre un Pull Request** describiendo:
   - Qué feed estás agregando
   - Por qué crees que es valioso para la comunidad
   - Cualquier contexto adicional

## 🔍 Validación automática

Todos los Pull Requests se someten a:

- **Validación de links**: Verificamos que todos los URLs de RSS sean accesibles y no devuelvan errores 404/500
- **Formato del README**: Chequeamos que el documento cumpla con el formato Markdown esperado

Si el workflow falla, puedes ver los detalles haciendo clic en "Details" en el PR y revisando los logs.

## 📝 Otras formas de contribuir

- **Reportar links rotos**: Si encuentras un feed que ya no funciona, abre un [Issue](https://github.com/alplox/awesome-chilean-rss/issues)
- **Sugerir mejoras**: ¿Tienes ideas para mejorar la estructura o el contenido? ¡Abre una Discussion!
- **Traducir o mejorar documentación**: Las mejoras al README, CONTRIBUTING.md, etc. son bienvenidas

## ⚠️ Criterios de rechazo

Un PR puede ser rechazado si:

- El feed **no es accesible** o devuelve errores
- El contenido **no es relevante para Chile**
- El feed está **duplicado** (ya existe en la lista)
- No se proporciona suficiente **contexto o descripción**
- La descripción contiene **superlativos, valoraciones o etiquetas ideológicas**
- El **formato no cumple** con los estándares de este proyecto

## 💬 Preguntas o dudas

Si tienes preguntas sobre cómo contribuir:

1. Revisa los [Issues abiertos](https://github.com/alplox/awesome-chilean-rss/issues) - tu pregunta podría estar respondida
2. Abre un nuevo Issue con la etiqueta `question`
3. Mira los PRs pasados para ver cómo otros han contribuido

## 📜 Código de conducta

Este proyecto adhiere a un código de conducta inclusivo. Se espera que todos los contribuidores sean respetuosos y constructivos.

---

**¡Gracias por ayudar a que esto sea un recurso mejor para la comunidad chilena! 🇨🇱**
