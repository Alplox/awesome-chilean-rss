
# 🇨🇱 Awesome Chilean RSS

[![Awesome](https://awesome.re/badge.svg)](https://github.com/alplox/awesome-chilean-rss)
![Sitios](https://img.shields.io/badge/sitios-663-brightgreen) ![Feeds](https://img.shields.io/badge/feeds-6402-blue)

> El directorio más completo de feeds RSS chilenos. 663 sitios, 6402 feeds verificados, organizadas por categoría y mantenidas activamente para evitar enlaces rotos y feeds abandonados.

### 🌐 Aplicación Web

Genera archivos OPML y/o marcadores de navegador segun tus preferencias desde la web complementaria:

- <https://alplox.github.io/awesome-chilean-rss-app/>

## 🚀 Inicio rápido

1. **Importar en tu lector RSS favorito**: Descarga [`chilean-rss.opml`](dist/opml/chilean-rss.opml) e impórtalo directamente en tu lector preferido
2. **O copia el enlace**: `https://raw.githubusercontent.com/alplox/awesome-chilean-rss/main/dist/opml/chilean-rss.opml`
3. **¿Solo medios regionales?** Descarga [`chilean-rss-regions.opml`](dist/opml/chilean-rss-regions.opml) con 3187 feeds agrupados por región
4. **¿Tu lector soporta subcarpetas?** Prueba [`chilean-rss-nested.opml`](dist/opml/chilean-rss-nested.opml), versión con regiones agrupadas en subcarpetas
5. **¿Una región específica?** Explora los OPML individuales en [`regions/`](dist/opml/regions/) o descarga por categoría en [`categories/`](dist/opml/categories/)
6. **¿Prefieres marcadores de navegador?** Importa [`awesome-chilean-rss.html`](dist/bookmarks/awesome-chilean-rss.html) como favoritos (compatible con Chrome, Firefox, Edge)

### 📊 Comparación de OPMLs globales

Cada carpeta de OPML ofrece una vista distinta. Esta tabla muestra cuántos sitios y feeds incluye cada uno para que contrastes rápido antes de importar:

| Archivo | Sitios | Feeds | Qué incluye |
|---|---|---|---|
| [`chilean-rss.opml`](dist/opml/chilean-rss.opml) | 663 | 6402 | Todos los feeds activos de todos los sitios |
| [`chilean-rss-main.opml`](dist/opml/chilean-rss-main.opml) | 660 | 660 | Solo el feed principal de cada sitio, sin subfeeds |
| [`chilean-rss-regions.opml`](dist/opml/chilean-rss-regions.opml) | 286 | 3187 | Feeds regionales agrupados por región |
| [`chilean-rss-nested.opml`](dist/opml/chilean-rss-nested.opml) | 663 | 6402 | Todos los feeds, con regionales anidados por subcarpeta |

*Sitios* = número de medios distintos con al menos un feed activo. *Feeds* = entradas RSS/Atom en el archivo (un sitio puede aportar varios feeds).

## 📝 Fuentes disponibles (663 sitios, 6402 feeds)

### Índice de categorías

- [📰 Noticias Nacionales](dist/readme/categories/news.md) — 311 sitios, 1106 feeds
- [🌐 Noticias Internacionales](dist/readme/categories/news-international.md) — 111 sitios, 281 feeds
- [🌎 Medios Regionales](dist/readme/categories/regional.md) — 253 sitios, 1931 feeds
- [💻 Tecnología y Startups](dist/readme/categories/technology.md) — 103 sitios, 367 feeds
- [🏛️ Gobierno y Datos Públicos](dist/readme/categories/government.md) — 50 sitios, 219 feeds
- [🏫 Educación, Universidades e Investigación](dist/readme/categories/education.md) — 124 sitios, 368 feeds
- [💼 Economia, Negocios y Finanzas](dist/readme/categories/business.md) — 135 sitios, 408 feeds
- [💼 Ofertas laborales y empleabilidad](dist/readme/categories/jobs.md) — 17 sitios, 22 feeds
- [🎨 Cultura y Divulgación](dist/readme/categories/culture.md) — 142 sitios, 234 feeds
- [👥 Comunidad](dist/readme/categories/community.md) — 113 sitios, 298 feeds
- [⚽ Deportes](dist/readme/categories/sports.md) — 176 sitios, 276 feeds
- [🎮 Videojuegos y Gaming](dist/readme/categories/gaming.md) — 13 sitios, 82 feeds
- [🌿 Medio Ambiente y Naturaleza](dist/readme/categories/environment.md) — 93 sitios, 218 feeds
- [🎭 Espectáculos y Entretención](dist/readme/categories/entertainment.md) — 58 sitios, 155 feeds
- [📻 Radio y Música](dist/readme/categories/radio.md) — 50 sitios, 189 feeds
- [🏥 Salud y Bienestar](dist/readme/categories/health.md) — 104 sitios, 179 feeds
- [🗳️ Partidos Políticos](dist/readme/categories/political-parties.md) — 13 sitios, 45 feeds
- [✍️ Blogs](dist/readme/categories/blogs.md) — 12 sitios, 24 feeds

## 📋 Watchlist (482 sitios candidatos)

Sitios en observación sin feed RSS propio válido. Ver listado completo: [`dist/watchlist.md`](dist/watchlist.md).

> Los feeds listados en la watchlist son proxies/fallbacks (Google News/Bing News `site:`) y **no** son el feed propio del sitio.

## 🤝 Cómo contribuir

¿Tienes un feed RSS chileno que debería estar aquí?

👉 Lee la [Guía de Contribución](CONTRIBUTING.md) para aprender cómo agregar nuevos feeds.

**Requisitos mínimos:**
- URL del feed RSS activa y verificada
- Contenido relevante para Chile
- No duplicado en la lista
- Descripción clara del contenido

## 📋 Validación automática

Todos los feeds de esta lista son validados automáticamente por nuestro [workflow de GitHub Actions](https://github.com/alplox/awesome-chilean-rss/actions) para asegurar que sean accesibles y funcionales.

## ⭐ Si te resulta útil

¿Te resultó útil esta lista? Dale una ⭐ en [GitHub](https://github.com/alplox/awesome-chilean-rss) para ayudar a otros a encontrarla.

## 📄 Licencia

Este proyecto está bajo licencia [CC0 1.0 Universal](LICENSE). Siéntete libre de usarlo, compartirlo y mejorarlo.
