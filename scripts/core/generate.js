#!/usr/bin/env node

import { readFileSync, writeFileSync, accessSync, constants, existsSync, mkdirSync } from 'fs';

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
const regions = JSON.parse(readFileSync('regions.json', 'utf-8'));
const { sites } = db;

// Resolver categoría de cada feed: feed.category ?? site.category
// Estructura resultado: { categoryKey: [feedData] }
const feedsByCategory = {};

// Para README: sitios agrupados por categoría resuelta, cada uno con solo sus feeds de esa categoría
const sitesByResolvedCategory = {};

// Resolver región de cada feed: feed.region ?? site.region
// Estructura resultado para regiones: { regionKey: [feedData] }
const feedsByRegion = {};

// Para README de medios regionales: sitios agrupados por región resuelta
const sitesByRegion = {};

for (const site of sites) {
  const catGroups = {};
  const regGroups = {};

  for (const feed of site.feeds) {
    if (feed.status !== 'active' || feed.verified !== true) continue;
    
    const resolvedCat = feed.category ?? site.category;
    const resolvedReg = feed.region ?? site.region;
    
    const feedEntry = { 
      ...feed, 
      siteId: site.id, 
      siteName: site.name, 
      siteUrl: site.url, 
      feedUrl: feed.url ?? site.url, 
      siteDescription: site.description,
      feedDescription: feed.description ?? site.description ?? '',
      region: resolvedReg 
    };

    (feedsByCategory[resolvedCat] ??= []).push(feedEntry);
    (catGroups[resolvedCat] ??= []).push(feed);

    if (resolvedReg) {
      if (!regions[resolvedReg]) {
        console.warn(`  ⚠️  "${site.id}" › feed "${feed.id}" tiene region desconocida "${resolvedReg}" — se omite de OPML regional`)
      } else {
        (feedsByRegion[resolvedReg] ??= []).push(feedEntry);
        (regGroups[resolvedReg] ??= []).push(feed);
      }
    }
  }

  for (const [cat, feeds] of Object.entries(catGroups)) {
    (sitesByResolvedCategory[cat] ??= []).push({
      id: site.id,
      name: site.name,
      url: site.url,
      category: cat,
      description: site.description,
      region: site.region,
      feeds,
    });
  }

  for (const [reg, feeds] of Object.entries(regGroups)) {
    (sitesByRegion[reg] ??= []).push({
      id: site.id,
      name: site.name,
      url: site.url,
      category: site.category,
      description: site.description,
      region: reg,
      feeds,
    });
  }
}

// Ordenar sitios alfabéticamente dentro de cada categoría
for (const cat of Object.keys(sitesByResolvedCategory)) {
  sitesByResolvedCategory[cat].sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// Ordenar sitios alfabéticamente dentro de cada región
for (const reg of Object.keys(sitesByRegion)) {
  sitesByRegion[reg].sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// Aplanar todos los feeds para conteos y OPML
const allFeeds = Object.values(feedsByCategory).flat();
const realFeedCount = new Set(allFeeds.map(f => f.siteId)).size;

// Feed principal por sitio (1 feed por sitio, sin subfeeds) — para chilean-rss-main.opml
function pickMainFeed(site) {
  const eligible = site.feeds.filter(
    f => f.status === 'active' && f.verified === true && !f.id.includes('-proxy-')
  );
  const main = eligible.find(f => f.id === `${site.id}-main`);
  return (main ?? eligible[0]) || null;
}

const mainFeeds = sites
  .map(site => {
    const feed = pickMainFeed(site);
    if (!feed) return null;
    return {
      ...feed,
      siteId: site.id,
      siteName: site.name,
      siteUrl: site.url,
      siteCategory: site.category,
      feedUrl: feed.url ?? site.url,
      feedDescription: feed.description ?? site.description ?? '',
      region: feed.region ?? site.region,
    };
  })
  .filter(Boolean);
const mainSitesCount = new Set(mainFeeds.map(f => f.siteId)).size;

// Orden de categorías en el documento (desde categories[].order)
const REGIONAL_CAT = 'regional';

const orderedCategories = Object.keys(feedsByCategory)
  .sort((a, b) => (categories[a]?.order ?? 99) - (categories[b]?.order ?? 99));

// ─── Generar OPML ─────────────────────────────────────────────────────────────

function renderFeedOutlines(feeds, indent = '      ') {
  const sorted = [...feeds].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return sorted
    .map(feed =>
      `${indent}<outline type="rss" text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" description="${escapeXml(feed.feedDescription)}" xmlUrl="${escapeXml(feed.rss_url)}" htmlUrl="${escapeXml(feed.feedUrl)}"/>`
    )
    .join('\n');
}

function generateOPML() {
  const now = db.last_updated;
  const totalFeeds = allFeeds.length;

  const categoryBlocks = orderedCategories.map(cat => {
    const label = categories[cat]?.label ?? cat;
    const feeds = feedsByCategory[cat] || [];
    return `    <outline text="${escapeXml(label)}" title="${escapeXml(label)}">\n${renderFeedOutlines(feeds)}\n    </outline>`;
  }).join('\n');

  return opmlEnvelope(categoryBlocks, totalFeeds, now);
}

function generateNestedOPML() {
  const now = db.last_updated;
  const totalFeeds = allFeeds.length;

  const categoryBlocks = orderedCategories.map(cat => {
    const label = categories[cat]?.label ?? cat;
    const feeds = feedsByCategory[cat] || [];

    if (cat === REGIONAL_CAT) {
      const regionFeeds = {};
      for (const feed of feeds) {
        if (feed.region && regions[feed.region]) {
          (regionFeeds[feed.region] ??= []).push(feed);
        }
      }

      const regionBlocks = Object.keys(regions)
        .filter(regKey => regionFeeds[regKey]?.length > 0)
        .map(regKey => `      <outline text="${escapeXml(regions[regKey])}" title="${escapeXml(regions[regKey])}">\n${renderFeedOutlines(regionFeeds[regKey])}\n      </outline>`);

      const unassigned = feeds.filter(f => !f.region || !regions[f.region]);
      if (unassigned.length > 0) {
        regionBlocks.push(`      <outline text="Otras Regiones o No Especificada" title="Otras Regiones o No Especificada">\n${renderFeedOutlines(unassigned)}\n      </outline>`);
      }

      return `    <outline text="${escapeXml(label)}" title="${escapeXml(label)}">\n${regionBlocks.join('\n')}\n    </outline>`;
    }

    return `    <outline text="${escapeXml(label)}" title="${escapeXml(label)}">\n${renderFeedOutlines(feeds)}\n    </outline>`;
  }).join('\n');

  return opmlEnvelope(categoryBlocks, totalFeeds, now);
}

// OPML global con solo el feed principal de cada sitio (sin subfeeds ni feeds de sección)
function generateMainFeedOPML() {
  const now = db.last_updated;
  const totalFeeds = mainFeeds.length;

  const feedsByResolvedCat = {};
  for (const feed of mainFeeds) {
    const cat = feed.category ?? feed.siteCategory;
    (feedsByResolvedCat[cat] ??= []).push(feed);
  }

  const orderedMainCategories = Object.keys(feedsByResolvedCat)
    .sort((a, b) => (categories[a]?.order ?? 99) - (categories[b]?.order ?? 99));

  const categoryBlocks = orderedMainCategories.map(cat => {
    const label = categories[cat]?.label ?? cat;
    const feeds = feedsByResolvedCat[cat] || [];
    return `    <outline text="${escapeXml(label)}" title="${escapeXml(label)}">\n${renderFeedOutlines(feeds)}\n    </outline>`;
  }).join('\n');

  return opmlEnvelope(categoryBlocks, totalFeeds, now);
}

function opmlEnvelope(body, totalFeeds, dateCreated) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Awesome Chilean RSS - ${totalFeeds} feeds</title>
    <description>El directorio más completo de feeds RSS chilenos. ${totalFeeds} feeds RSS, organizadas por categoría y mantenidas activamente.</description>
    <dateCreated>${dateCreated}</dateCreated>
    <ownerName>${escapeXml(ownerName)}</ownerName>
  </head>
  <body>
${body}
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

// ─── Generar OPML Regional ───────────────────────────────────────────────────

function generateRegionalOPML(feedsByRegion) {
  const now = db.last_updated;
  const regionalFeeds = Object.values(feedsByRegion).flat();
  const totalFeeds = regionalFeeds.length;

  const regionBlocks = Object.keys(regions)
    .filter(regKey => feedsByRegion[regKey]?.length > 0)
    .map(regKey => {
      const label = regions[regKey];
      const feeds = feedsByRegion[regKey] || [];
      // Sort feeds alphabetically by name
      const sortedFeeds = [...feeds].sort((a, b) => a.name.localeCompare(b.name, 'es'));
      const outlines = sortedFeeds
        .map(feed =>
          `      <outline type="rss" text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" description="${escapeXml(feed.feedDescription)}" xmlUrl="${escapeXml(feed.rss_url)}" htmlUrl="${escapeXml(feed.feedUrl)}"/>`
        )
        .join('\n');
      return `    <outline text="${escapeXml(label)}" title="${escapeXml(label)}">\n${outlines}\n    </outline>`;
    }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Awesome Chilean RSS - Regionales (${totalFeeds} feeds)</title>
    <description>Feeds RSS de medios regionales chilenos agrupados por región.</description>
    <dateCreated>${now}</dateCreated>
    <ownerName>${escapeXml(ownerName)}</ownerName>
  </head>
  <body>
${regionBlocks}
  </body>
</opml>
`;
}

// ─── Generar OPML Regional Individual ────────────────────────────────────────

function generateIndividualRegionalOPML(regKey, feeds) {
  const now = db.last_updated;
  const label = regions[regKey];
  const totalFeeds = feeds.length;
  const sortedFeeds = [...feeds].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const outlines = sortedFeeds
    .map(feed =>
      `      <outline type="rss" text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" description="${escapeXml(feed.feedDescription)}" xmlUrl="${escapeXml(feed.rss_url)}" htmlUrl="${escapeXml(feed.feedUrl)}"/>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Awesome Chilean RSS - Región de ${label} (${totalFeeds} feeds)</title>
    <description>Feeds RSS de la Región de ${label}, parte del directorio Awesome Chilean RSS.</description>
    <dateCreated>${now}</dateCreated>
    <ownerName>${escapeXml(ownerName)}</ownerName>
  </head>
  <body>
    <outline text="${escapeXml(label)}" title="${escapeXml(label)}">
${outlines}
    </outline>
  </body>
</opml>
`;
}

function generateIndividualRegionalFlatOPML(regKey, feeds) {
  const now = db.last_updated;
  const label = regions[regKey];
  const totalFeeds = feeds.length;
  const sortedFeeds = [...feeds].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const outlines = sortedFeeds
    .map(feed =>
      `    <outline type="rss" text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" description="${escapeXml(feed.feedDescription)}" xmlUrl="${escapeXml(feed.rss_url)}" htmlUrl="${escapeXml(feed.feedUrl)}"/>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Awesome Chilean RSS - Región de ${label} (${totalFeeds} feeds)</title>
    <description>Feeds RSS de la Región de ${label}, parte del directorio Awesome Chilean RSS.</description>
    <dateCreated>${now}</dateCreated>
    <ownerName>${escapeXml(ownerName)}</ownerName>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}

// ─── Generar OPML por Categoría Individual ───────────────────────────────────

function generateIndividualCategoryOPML(catKey, feeds) {
  const now = db.last_updated;
  const label = categories[catKey]?.label ?? catKey;
  const totalFeeds = feeds.length;
  const sortedFeeds = [...feeds].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const outlines = sortedFeeds
    .map(feed =>
      `      <outline type="rss" text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" description="${escapeXml(feed.feedDescription)}" xmlUrl="${escapeXml(feed.rss_url)}" htmlUrl="${escapeXml(feed.feedUrl)}"/>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Awesome Chilean RSS - ${escapeXml(label)} (${totalFeeds} feeds)</title>
    <description>Feeds RSS de ${escapeXml(label)}, parte del directorio Awesome Chilean RSS.</description>
    <dateCreated>${now}</dateCreated>
    <ownerName>${escapeXml(ownerName)}</ownerName>
  </head>
  <body>
    <outline text="${escapeXml(label)}" title="${escapeXml(label)}">
${outlines}
    </outline>
  </body>
</opml>
`;
}

function generateIndividualCategoryFlatOPML(catKey, feeds) {
  const now = db.last_updated;
  const label = categories[catKey]?.label ?? catKey;
  const totalFeeds = feeds.length;
  const sortedFeeds = [...feeds].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const outlines = sortedFeeds
    .map(feed =>
      `    <outline type="rss" text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" description="${escapeXml(feed.feedDescription)}" xmlUrl="${escapeXml(feed.rss_url)}" htmlUrl="${escapeXml(feed.feedUrl)}"/>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Awesome Chilean RSS - ${escapeXml(label)} (${totalFeeds} feeds)</title>
    <description>Feeds RSS de ${escapeXml(label)}, parte del directorio Awesome Chilean RSS.</description>
    <dateCreated>${now}</dateCreated>
    <ownerName>${escapeXml(ownerName)}</ownerName>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}

// ─── Generar README ───────────────────────────────────────────────────────────

function feedCount(n) {
  return n === 1 ? '1 feed' : `${n} feeds`;
}

function categoryHeadingLabel(label) {
  return label.replace(/^\S+\s/u, '');
}

function renderReadmeSite(site) {
  const activeFeeds = site.feeds.filter(
    feed => feed.status === 'active' && feed.verified === true
  );
  if (activeFeeds.length === 0) return null;

  if (activeFeeds.length === 1) {
    const feed = activeFeeds[0];
    const feedDesc = feed.description ?? site.description ?? '';
    return `- **${site.name}**: ${feedDesc}\n  - RSS: \`${feed.rss_url}\``;
  }

  const feedLines = activeFeeds
    .map(feed => `  - ${feed.name}: \`${feed.rss_url}\``)
    .join('\n');
  return `- **${site.name}** — ${site.description}\n${feedLines}`;
}

let readmeCategoryDocuments = [];

function generateReadme() {
  readmeCategoryDocuments = [];
  const total = allFeeds.length;

  // Conteos por OPML global (tabla comparativa)
  const regionsFeeds = Object.values(feedsByRegion).flat();
  const regionsSites = new Set(regionsFeeds.map(f => f.siteId)).size;

  const opmlComparison = `### 📊 Comparación de OPMLs globales

Cada carpeta de OPML ofrece una vista distinta. Esta tabla muestra cuántos sitios y feeds incluye cada uno para que contrastes rápido antes de importar:

| Archivo | Sitios | Feeds | Qué incluye |
|---|---|---|---|
| [\`chilean-rss.opml\`](dist/opml/chilean-rss.opml) | ${realFeedCount} | ${total} | Todos los feeds activos de todos los sitios |
| [\`chilean-rss-main.opml\`](dist/opml/chilean-rss-main.opml) | ${mainSitesCount} | ${mainFeeds.length} | Solo el feed principal de cada sitio, sin subfeeds |
| [\`chilean-rss-regions.opml\`](dist/opml/chilean-rss-regions.opml) | ${regionsSites} | ${regionsFeeds.length} | Feeds regionales agrupados por región |
| [\`chilean-rss-nested.opml\`](dist/opml/chilean-rss-nested.opml) | ${realFeedCount} | ${total} | Todos los feeds, con regionales anidados por subcarpeta |

*Sitios* = número de medios distintos con al menos un feed activo. *Feeds* = entradas RSS/Atom en el archivo (un sitio puede aportar varios feeds).`;

  // Construir índice
  const indexLines = orderedCategories.map(cat => {
    const label = categories[cat]?.label ?? cat;
    const feeds = feedsByCategory[cat] || [];
    if (feeds.length === 0) return null;
    const sitesCount = (sitesByResolvedCategory[cat] || []).length;
    const heading = categoryHeadingLabel(label);
    return `- [${label}](dist/readme/categories/${cat}.md) — ${sitesCount} sitios, ${feeds.length} feeds`;
  }).filter(Boolean);

  const index = `### Índice de categorías\n\n${indexLines.join('\n')}`;

  // Sección de feeds por categoría
  const feedSections = orderedCategories.map(cat => {
    const label = categories[cat]?.label ?? cat;
    const catSites = sitesByResolvedCategory[cat] || [];
    const totalFeedsInCat = feedsByCategory[cat]?.length || 0;

    if (cat === REGIONAL_CAT) {
      // Group by region
      const regionSubsections = Object.keys(regions)
        .map(regKey => {
          const regionSites = sitesByRegion[regKey] || [];
          if (regionSites.length === 0) return null;

          const regionLabel = regions[regKey];
          const siteLines = regionSites
            .map(site => {
              return renderReadmeSite(site);
            })
            .filter(Boolean)
            .join('\n');

          if (!siteLines) return null;

          return `#### 📍 ${regionLabel} (${regionSites.length} medios)\n\n*Descargar OPML regional: [\`${regKey}.opml\`](dist/opml/regions/${regKey}.opml)*\n\n${siteLines}`;
        })
        .filter(Boolean);

      // Fallback: sites tagged as regional but with no region
      const unassignedSites = catSites.filter(s => !s.region || !regions[s.region]);
      if (unassignedSites.length > 0) {
        const unassignedLines = unassignedSites
          .map(site => {
            return renderReadmeSite(site);
          })
          .filter(Boolean)
          .join('\n');

        if (unassignedLines) {
          regionSubsections.push(`#### 📍 Otras Regiones o No Especificada (${unassignedSites.length} medios)\n\n${unassignedLines}`);
        }
      }

      if (regionSubsections.length === 0) return null;

      const heading = categoryHeadingLabel(label);
      const regionalContent = regionSubsections.join('\n\n').replaceAll('](dist/opml/', '](../../opml/');
      const content = `### ${heading}\n\n[↑ Volver al índice](../../../README.md#índice-de-categorías)\n\nConsolidado regional: [\`chilean-rss-regions.opml\`](../../opml/chilean-rss-regions.opml) — OPML por categoría: [\`regional.opml\`](../../opml/categories/regional.opml) - ${catSites.length} sitios, ${feedCount(totalFeedsInCat)}\n\n${regionalContent}`;
      readmeCategoryDocuments.push({ cat, content });
      return '';
    }

    const items = catSites.map(renderReadmeSite).filter(Boolean).join('\n');

    if (!items) return null;

    const heading = categoryHeadingLabel(label);
    const content = `### ${heading}\n\n[↑ Volver al índice](../../../README.md#índice-de-categorías)\n\n*Descargar OPML: [\`${cat}.opml\`](../../opml/categories/${cat}.opml) - ${catSites.length} sitios, ${feedCount(totalFeedsInCat)}*\n\n${items}`;
    readmeCategoryDocuments.push({ cat, content });
    return '';
  }).filter(Boolean).join('\n\n');

  const regTotal = Object.values(feedsByRegion).flat().length;

  return `
# 🇨🇱 Awesome Chilean RSS

[![Awesome](https://awesome.re/badge.svg)](https://github.com/alplox/awesome-chilean-rss)
![Sitios](https://img.shields.io/badge/sitios-${realFeedCount}-brightgreen) ![Feeds](https://img.shields.io/badge/feeds-${total}-blue)

> El directorio más completo de feeds RSS chilenos. ${realFeedCount} sitios, ${total} feeds verificados, organizadas por categoría y mantenidas activamente para evitar enlaces rotos y feeds abandonados.

## 🚀 Inicio rápido

1. **Importar en tu lector RSS favorito**: Descarga [\`chilean-rss.opml\`](dist/opml/chilean-rss.opml) e impórtalo directamente en tu lector preferido
2. **O copia el enlace**: \`https://raw.githubusercontent.com/alplox/awesome-chilean-rss/main/dist/opml/chilean-rss.opml\`
3. **¿Solo medios regionales?** Descarga [\`chilean-rss-regions.opml\`](dist/opml/chilean-rss-regions.opml) con ${regTotal} feeds agrupados por región
4. **¿Tu lector soporta subcarpetas?** Prueba [\`chilean-rss-nested.opml\`](dist/opml/chilean-rss-nested.opml), versión con regiones agrupadas en subcarpetas
5. **¿Una región específica?** Explora los OPML individuales en [\`regions/\`](dist/opml/regions/) o descarga por categoría en [\`categories/\`](dist/opml/categories/)
6. **¿Prefieres marcadores de navegador?** Importa [\`awesome-chilean-rss.html\`](dist/bookmarks/awesome-chilean-rss.html) como favoritos (compatible con Chrome, Firefox, Edge)

${opmlComparison}

### 🌐 Aplicación Web

Genera archivos OPML y/o marcadores de navegador segun tus preferencias desde la web complementaria:

<https://alplox.github.io/awesome-chilean-rss-app/>

## 📝 Fuentes disponibles (${realFeedCount} sitios, ${total} feeds)

${index}

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

// ─── Generar Bookmark HTML ────────────────────────────────────────────────────

function renderBookmarkEntries(feeds) {
  const sorted = [...feeds].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return sorted
    .map(feed =>
      `        <DT><A HREF="${escapeXml(feed.feedUrl)}">${escapeXml(feed.name)}</A>`
    )
    .join('\n');
}

function renderBookmarkFile(title, bodyContent) {
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file from awesome-chilean-rss. Do not edit manually. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>${escapeXml(title)}</TITLE>
<H1>${escapeXml(title)}</H1>
<DL><p>
        <DT><A HREF="https://github.com/alplox/awesome-chilean-rss">awesome-chilean-rss</A>
${bodyContent}
</DL><p>`;
}

function generateBookmarks() {
  const categoryBlocks = orderedCategories.map(cat => {
    const label = categories[cat]?.label ?? cat;
    const feeds = feedsByCategory[cat] || [];

    if (cat === REGIONAL_CAT) {
      const regionFeeds = {};
      for (const feed of feeds) {
        if (feed.region && regions[feed.region]) {
          (regionFeeds[feed.region] ??= []).push(feed);
        }
      }

      const regionBlocks = Object.keys(regions)
        .filter(regKey => regionFeeds[regKey]?.length > 0)
        .map(regKey =>
          `    <DT><H3>${escapeXml(regions[regKey])}</H3>\n    <DL><p>\n${renderBookmarkEntries(regionFeeds[regKey])}\n    </DL><p>`
        );

      const unassigned = feeds.filter(f => !f.region || !regions[f.region]);
      if (unassigned.length > 0) {
        regionBlocks.push(
          `    <DT><H3>Otras Regiones o No Especificada</H3>\n    <DL><p>\n${renderBookmarkEntries(unassigned)}\n    </DL><p>`
        );
      }

      return `  <DT><H3>${escapeXml(label)}</H3>\n  <DL><p>\n${regionBlocks.join('\n')}\n  </DL><p>`;
    }

    return `  <DT><H3>${escapeXml(label)}</H3>\n  <DL><p>\n${renderBookmarkEntries(feeds)}\n  </DL><p>`;
  }).join('\n');

  return renderBookmarkFile('awesome-chilean-rss', categoryBlocks);
}

function generateIndividualCategoryBookmark(catKey, feeds) {
  const label = categories[catKey]?.label ?? catKey;
  return renderBookmarkFile(label, renderBookmarkEntries(feeds));
}

function generateIndividualRegionalBookmark(regKey, feeds) {
  const label = regions[regKey] ?? regKey;
  return renderBookmarkFile(label, renderBookmarkEntries(feeds));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

try {
  const OPML_DIR = 'dist/opml';

  if (!existsSync('dist')) {
    mkdirSync('dist');
  }
  if (!existsSync(OPML_DIR)) {
    mkdirSync(OPML_DIR);
  }

  // Main OPML file (flat — todas las categorías en un solo nivel)
  const opml = generateOPML();
  writeFileSync(`${OPML_DIR}/chilean-rss.opml`, opml, 'utf-8');
  console.log(`✅ ${OPML_DIR}/chilean-rss.opml generado (${allFeeds.length} feeds, ${orderedCategories.length} categorías)`);

  // Nested OPML file (regionales con subcarpetas por región)
  const nestedOpml = generateNestedOPML();
  writeFileSync(`${OPML_DIR}/chilean-rss-nested.opml`, nestedOpml, 'utf-8');
  console.log(`✅ ${OPML_DIR}/chilean-rss-nested.opml generado (${allFeeds.length} feeds, ${orderedCategories.length} categorías)`);

  // Main-feed-only OPML file (1 feed por sitio, sin subfeeds)
  const mainFeedOpml = generateMainFeedOPML();
  writeFileSync(`${OPML_DIR}/chilean-rss-main.opml`, mainFeedOpml, 'utf-8');
  console.log(`✅ ${OPML_DIR}/chilean-rss-main.opml generado (${mainFeeds.length} feeds, ${mainSitesCount} sitios)`);

  // Consolidated regional OPML file
  const regionalOpml = generateRegionalOPML(feedsByRegion);
  writeFileSync(`${OPML_DIR}/chilean-rss-regions.opml`, regionalOpml, 'utf-8');
  const totalRegFeeds = Object.values(feedsByRegion).flat().length;
  console.log(`✅ ${OPML_DIR}/chilean-rss-regions.opml generado (${totalRegFeeds} feeds regionales de ${Object.keys(feedsByRegion).length} regiones)`);

  // Individual regional OPML files (with region grouping + flat variants)
  const regionsDir = `${OPML_DIR}/regions`;
  if (!existsSync(regionsDir)) {
    mkdirSync(regionsDir);
  }
  for (const regKey of Object.keys(regions)) {
    const feeds = feedsByRegion[regKey] || [];
    if (feeds.length > 0) {
      const regOpml = generateIndividualRegionalOPML(regKey, feeds);
      writeFileSync(`${regionsDir}/${regKey}.opml`, regOpml, 'utf-8');
      const regFlatOpml = generateIndividualRegionalFlatOPML(regKey, feeds);
      writeFileSync(`${regionsDir}/${regKey}-without-category.opml`, regFlatOpml, 'utf-8');
    }
  }
  console.log(`✅ OPMLs individuales por región generados en el directorio ${regionsDir}/ (con y sin agrupación)`);

  // Individual category OPML files (with category grouping + flat variants)
  const categoriesDir = `${OPML_DIR}/categories`;
  if (!existsSync(categoriesDir)) {
    mkdirSync(categoriesDir);
  }
  for (const catKey of orderedCategories) {
    const feeds = feedsByCategory[catKey] || [];
    if (feeds.length > 0) {
      const catOpml = generateIndividualCategoryOPML(catKey, feeds);
      writeFileSync(`${categoriesDir}/${catKey}.opml`, catOpml, 'utf-8');
      const catFlatOpml = generateIndividualCategoryFlatOPML(catKey, feeds);
      writeFileSync(`${categoriesDir}/${catKey}-without-category.opml`, catFlatOpml, 'utf-8');
    }
  }
  console.log(`✅ OPMLs individuales por categoría generados en el directorio ${categoriesDir}/ (con y sin agrupación)`);

  // Full README category listings kept outside README.md to avoid GitHub's render limit
  const readmeCategoriesDir = 'dist/readme/categories';
  if (!existsSync(readmeCategoriesDir)) {
    mkdirSync(readmeCategoriesDir, { recursive: true });
  }
  const readme = generateReadme();
  for (const { cat, content } of readmeCategoryDocuments) {
    writeFileSync(`${readmeCategoriesDir}/${cat}.md`, `${content}\n`, 'utf-8');
  }
  console.log(`✅ Listados completos del README generados en ${readmeCategoriesDir}/`);

  // README.md
  writeFileSync('README.md', readme, 'utf-8');
  console.log(`✅ README.md generado (${allFeeds.length} feeds, ${orderedCategories.length} categorías)`);

  // Bookmarks HTML (Netscape Bookmark Format — compatible con navegadores)
  const BOOKMARKS_DIR = 'dist/bookmarks';
  if (!existsSync(BOOKMARKS_DIR)) {
    mkdirSync(BOOKMARKS_DIR);
  }

  // Combined
  const bookmarks = generateBookmarks();
  writeFileSync(`${BOOKMARKS_DIR}/awesome-chilean-rss.html`, bookmarks, 'utf-8');
  console.log(`✅ ${BOOKMARKS_DIR}/awesome-chilean-rss.html generado (${allFeeds.length} bookmarks)`);

  // Individual category bookmark files
  const bookmarksCategoriesDir = `${BOOKMARKS_DIR}/categories`;
  if (!existsSync(bookmarksCategoriesDir)) {
    mkdirSync(bookmarksCategoriesDir);
  }
  for (const catKey of orderedCategories) {
    const feeds = feedsByCategory[catKey] || [];
    if (feeds.length > 0) {
      const catBookmark = generateIndividualCategoryBookmark(catKey, feeds);
      writeFileSync(`${bookmarksCategoriesDir}/${catKey}.html`, catBookmark, 'utf-8');
    }
  }
  console.log(`✅ Marcadores individuales por categoría generados en ${bookmarksCategoriesDir}/`);

  // Individual regional bookmark files
  const bookmarksRegionsDir = `${BOOKMARKS_DIR}/regions`;
  if (!existsSync(bookmarksRegionsDir)) {
    mkdirSync(bookmarksRegionsDir);
  }
  for (const regKey of Object.keys(regions)) {
    const feeds = feedsByRegion[regKey] || [];
    if (feeds.length > 0) {
      const regBookmark = generateIndividualRegionalBookmark(regKey, feeds);
      writeFileSync(`${bookmarksRegionsDir}/${regKey}.html`, regBookmark, 'utf-8');
    }
  }
  console.log(`✅ Marcadores individuales por región generados en ${bookmarksRegionsDir}/`);
} catch (err) {
  console.error('❌ Error al generar archivos:', err.message);
  process.exit(1);
}
