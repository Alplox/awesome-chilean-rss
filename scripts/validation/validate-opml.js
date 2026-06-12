/**
 * Valida la estructura de todos los archivos OPML generados.
 * Usado por el workflow de CI.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { xmlParser } from '../../lib/feed-validator.js';

let exitCode = 0;

function validateFile(filePath) {
  try {
    const xml = readFileSync(filePath, 'utf-8');
    const parsed = xmlParser.parse(xml);
    const root = parsed?.opml;

    if (!root) {
      console.error(`❌ ${filePath}: El elemento raíz debe ser <opml>`);
      exitCode = 1;
      return;
    }

    function collectRssOutlines(node) {
      const results = [];
      const outlines = Array.isArray(node.outline)
        ? node.outline
        : node.outline ? [node.outline] : [];
      for (const o of outlines) {
        if (o['@_type'] === 'rss') results.push(o);
        results.push(...collectRssOutlines(o));
      }
      return results;
    }

    const rssOutlines = collectRssOutlines(root.body ?? {});

    const errors = [];
    for (const o of rssOutlines) {
      if (!o['@_xmlUrl']) {
        errors.push(`Feed "${o['@_text'] ?? '?'}" sin xmlUrl`);
      }
      if (!o['@_text']) {
        errors.push('Feed sin atributo text');
      }
    }

    if (errors.length) {
      for (const err of errors) {
        console.error(`❌ ${filePath}: ${err}`);
      }
      exitCode = 1;
    } else {
      console.log(`✅ ${filePath} válido — ${rssOutlines.length} feeds`);
    }
  } catch (err) {
    console.error(`❌ ${filePath}: Error al parsear OPML:`, err.message);
    exitCode = 1;
  }
}

// 1. Validar archivos principales en la raíz
validateFile('chilean-rss.opml');

if (existsSync('chilean-rss-regions.opml')) {
  validateFile('chilean-rss-regions.opml');
}

// 2. Validar archivos individuales en regions/
if (existsSync('regions')) {
  const files = readdirSync('regions').filter(f => f.endsWith('.opml'));
  for (const file of files) {
    validateFile(`regions/${file}`);
  }
}

// 3. Validar archivos individuales por categoría en categories/
if (existsSync('categories')) {
  const files = readdirSync('categories').filter(f => f.endsWith('.opml'));
  for (const file of files) {
    validateFile(`categories/${file}`);
  }
}

if (exitCode) {
  process.exit(1);
}

