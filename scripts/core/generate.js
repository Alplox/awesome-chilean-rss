#!/usr/bin/env node

import { readFileSync, writeFileSync, accessSync, constants } from 'fs';

// ─── Verificar escritura ──────────────────────────────────────────────────────

try {
  accessSync('.', constants.W_OK);
} catch {
  console.error('❌ El directorio actual no tiene permisos de escritura');
  process.exit(1);
}

// ─── Cargar configuración ─────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const ownerName = pkg.author?.name ?? 'Alplox';

const db = JSON.parse(readFileSync('feeds-database.json', 'utf-8'));
const categories = JSON.parse(readFileSync('categories.json', 'utf-8'));
const { sites } = db;

// Resolver categoría de cada feed: feed.category ?? site.category
// Estructura resultado: { categoryKey: [feedData] }
const feedsByCategory = {};

// Para README: sitios agrupados por categoría resuelta, cada uno con solo sus feeds de esa categoría
const sitesByResolvedCategory = {};

for (const site of sites) {
  const catGroups = {};

  for (const feed of site.feeds) {
    if (feed.status !== 'active' || feed.verified !== true) continue;
    const resolvedCat = feed.category ?? site.category;
    const feedEntry = { ...feed, siteId: site.id, siteName: site.name, siteUrl: site.url, siteDescription: site.description };

    (feedsByCategory[resolvedCat] ??= []).push(feedEntry);
    (catGroups[resolvedCat] ??= []).push(feed);
  }

  for (const [cat, feeds] of Object.entries(catGroups)) {
    (sitesByResolvedCategory[cat] ??= []).push({
      id: site.id,
      name: site.name,
      url: site.url,
      category: cat,
      description: site.description,
      feeds,
    });
  }
}

// Ordenar sitios alfabéticamente dentro de cada categoría
for (const cat of Object.keys(sitesByResolvedCategory)) {
  sitesByResolvedCategory[cat].sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// Aplanar todos los feeds para conteos y OPML
const allFeeds = Object.values(feedsByCategory).flat();

// Orden de categorías en el documento
const CATEGORY_ORDER = [
  'news',
  'technology',
  'government',
  'universities',
  'regional',
  'business',
  'culture',
  'sports',
  'community',
];

const orderedCategories = [
  ...CATEGORY_ORDER.filter(c => feedsByCategory[c]),
  ...Object.keys(feedsByCategory).filter(c => !CATEGORY_ORDER.includes(c)).sort(),
];

// ─── Generar OPML ─────────────────────────────────────────────────────────────

function generateOPML() {
  const now = db.last_updated;
  const totalFeeds = allFeeds.length;

  const categoryBlocks = orderedCategories.map(cat => {
    const label = categories[cat] ?? cat;
    const feeds = feedsByCategory[cat] || [];
    const outlines = feeds
      .map(feed =>
        `      <outline type="rss" text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" xmlUrl="${escapeXml(feed.rss_url)}" htmlUrl="${escapeXml(feed.siteUrl)}"/>`
      )
      .join('\n');
    return `    <outline text="${escapeXml(label)}" title="${escapeXml(label)}">\n${outlines}\n    </outline>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Awesome Chilean RSS - ${totalFeeds} feeds</title>
    <description>El directorio más completo de feeds RSS chilenos. ${totalFeeds} feeds RSS, organizadas por categoría y mantenidas activamente.</description>
    <dateCreated>${now}</dateCreated>
    <ownerName>${escapeXml(ownerName)}</ownerName>
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
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Generar README ───────────────────────────────────────────────────────────

function feedCount(n) {
  return n === 1 ? '1 feed' : `${n} feeds`;
}

function generateReadme() {
  const total = allFeeds.length;

  // Construir índice
  const indexLines = orderedCategories.map(cat => {
    const label = categories[cat] ?? cat;
    const feeds = feedsByCategory[cat] || [];
    if (feeds.length === 0) return null;
    return `- [${label}](#cat-${cat}) — ${feeds.length} feeds`;
  }).filter(Boolean);

  const index = `<a id="indice"></a>\n### 📑 Índice de categorías\n\n${indexLines.join('\n')}`;

  // Sección de feeds por categoría
  const feedSections = orderedCategories.map(cat => {
    const label = categories[cat] ?? cat;
    const catSites = sitesByResolvedCategory[cat] || [];
    const totalFeedsInCat = feedsByCategory[cat]?.length || 0;

    const items = catSites.map(site => {
      const activeFeeds = site.feeds.filter(f => f.status === 'active' && f.verified === true);
      if (activeFeeds.length === 0) return null;

      if (activeFeeds.length === 1) {
        const feed = activeFeeds[0];
        return `- **${site.name}**: ${site.description}\n  - RSS: \`${feed.rss_url}\``;
      } else {
        const feedLines = activeFeeds
          .map(feed => `  - ${feed.name}: \`${feed.rss_url}\``)
          .join('\n');
        return `- **${site.name}** — ${site.description}\n${feedLines}`;
      }
    }).filter(Boolean).join('\n');

    if (!items) return null;

    return `<a id="cat-${cat}"></a>\n### ${label} (${feedCount(totalFeedsInCat)})\n\n${items}\n\n[↑ Volver al índice](#indice)`;
  }).filter(Boolean).join('\n\n');

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

try {
  const opml = generateOPML();
  writeFileSync('chilean-rss.opml', opml, 'utf-8');
  console.log(`✅ chilean-rss.opml generado (${allFeeds.length} feeds, ${orderedCategories.length} categorías)`);

  const readme = generateReadme();
  writeFileSync('README.md', readme, 'utf-8');
  console.log(`✅ README.md generado (${allFeeds.length} feeds, ${orderedCategories.length} categorías)`);
} catch (err) {
  console.error('❌ Error al generar archivos:', err.message);
  process.exit(1);
}
