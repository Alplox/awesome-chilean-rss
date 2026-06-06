#!/usr/bin/env node
/**
 * Genera chilean-rss.opml y README.md a partir de feeds-database.json.
 *
 * Uso: node generate.js
 *      npm run generate
 */

import { readFileSync, writeFileSync } from 'fs';

// ─── Cargar base de datos ─────────────────────────────────────────────────────

const db = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));
const { sites, categories } = db;

// Aplanar todos los feeds individuales para OPML y conteos
// Cada entry incluye el feed + datos del sitio padre
const allFeeds = sites.flatMap(site =>
  site.feeds.map(feed => ({ ...feed, siteId: site.id, siteName: site.name, siteUrl: site.url, category: site.category }))
);

// Agrupa sitios por categoría (para README y OPML)
const sitesByCategory = sites.reduce((acc, site) => {
  (acc[site.category] ??= []).push(site);
  return acc;
}, {});

for (const cat of Object.keys(sitesByCategory)) {
  sitesByCategory[cat].sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// Orden de categorías en el documento
const CATEGORY_ORDER = [
  'news',
  'technology',
  'government',
  'universities',
  'regional',
  'business',
  'culture',
  'podcasts',
  'opendata',
];

const orderedCategories = [
  ...CATEGORY_ORDER.filter(c => sitesByCategory[c]),
  ...Object.keys(sitesByCategory).filter(c => !CATEGORY_ORDER.includes(c)).sort(),
];

// ─── Generar OPML ─────────────────────────────────────────────────────────────

function generateOPML() {
  const now = new Date().toISOString();
  const totalFeeds = allFeeds.length;

  const categoryBlocks = orderedCategories.map(cat => {
    const label = categories[cat] ?? cat;
    // Aplanar feeds de todos los sitios de esta categoría, ordenados por sitio
    const outlines = sitesByCategory[cat].flatMap(site =>
      site.feeds.map(feed =>
        `      <outline type="rss" text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" xmlUrl="${escapeXml(feed.rss_url)}" htmlUrl="${escapeXml(site.url)}"/>`
      )
    ).join('\n');

    return `    <outline text="${escapeXml(label)}" title="${escapeXml(label)}">\n${outlines}\n    </outline>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Awesome Chilean RSS - ${totalFeeds} feeds</title>
    <description>El directorio más completo de feeds RSS chilenos. ${totalFeeds} feeds RSS, organizadas por categoría y mantenidas activamente.</description>
    <dateCreated>${now}</dateCreated>
    <ownerName>Alplox</ownerName>
  </head>
  <body>
${categoryBlocks}
  </body>
</opml>
`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Generar README ───────────────────────────────────────────────────────────

function feedCount(n) {
  return n === 1 ? '1 feed' : `${n} feeds`;
}

function generateReadme() {
  const total = allFeeds.length;

  // Genera el slug de ancla que usa GitHub para un header markdown
  // GitHub preserva letras con acento, solo elimina caracteres no alfanuméricos
  // Ej: "📰 Noticias Nacionales (12 feeds)" → "noticias-nacionales-12-feeds"
  function toAnchor(label, count) {
    const heading = `${label} (${feedCount(count)})`;
    return heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '') // elimina solo lo que no sea letra, número o espacio
      .trim()
      .replace(/\s+/g, '-');
  }

  // Construir índice
  const indexLines = orderedCategories.map(cat => {
    const label = categories[cat] ?? cat;
    const count = sitesByCategory[cat].reduce((sum, s) => sum + s.feeds.length, 0);
    const anchor = toAnchor(label, count);
    return `- [${label}](#${anchor}) — ${count} feeds`;
  });

  const index = `### 📑 Índice de categorías\n\n${indexLines.join('\n')}`;

  // Sección de feeds por categoría
  const feedSections = orderedCategories.map(cat => {
    const label = categories[cat] ?? cat;
    const catSites = sitesByCategory[cat];
    const count = catSites.reduce((sum, s) => sum + s.feeds.length, 0);

    const items = catSites.map(site => {
      if (site.feeds.length === 1) {
        const feed = site.feeds[0];
        return `- **${site.name}**: ${site.description}\n  - RSS: \`${feed.rss_url}\``;
      } else {
        const feedLines = site.feeds
          .map(feed => `  - ${feed.name}: \`${feed.rss_url}\``)
          .join('\n');
        return `- **${site.name}** — ${site.description}\n${feedLines}`;
      }
    }).join('\n');

    return `### ${label} (${feedCount(count)})\n\n${items}\n\n[↑ Volver al índice](#-índice-de-categorías)`;
  }).join('\n\n');

  return `
# Awesome Chilean RSS

[![Awesome](https://awesome.re/badge.svg)](https://awesome.re)
![Feeds](https://img.shields.io/badge/feeds-${total}-blue)

> El directorio más completo de feeds RSS chilenos. ${total} fuentes verificadas, organizadas por categoría y mantenidas activamente para evitar enlaces rotos y feeds abandonados.

## 🚀 Inicio rápido

1. **Importar en tu lector RSS favorito**: Descarga [\`chilean-rss.opml\`](chilean-rss.opml) e impórtalo directamente en tu lector preferido
2. **O copia el enlace**: \`https://raw.githubusercontent.com/alplox/awesome-chilean-rss/main/chilean-rss.opml\`

## 📝 Feeds disponibles (${total})

${index}

${feedSections}

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
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const opml = generateOPML();
writeFileSync('chilean-rss.opml', opml, 'utf-8');
console.log(`✅ chilean-rss.opml generado (${allFeeds.length} feeds, ${sites.length} sitios)`);

const readme = generateReadme();
writeFileSync('README.md', readme, 'utf-8');
console.log(`✅ README.md generado (${allFeeds.length} feeds, ${orderedCategories.length} categorías)`);
