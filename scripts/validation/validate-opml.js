/**
 * Valida la estructura del archivo chilean-rss.opml.
 * Usado por el workflow de CI.
 */
import { readFileSync } from 'fs';
import { xmlParser } from '../../lib/feed-validator.js';

try {
  const xml = readFileSync('chilean-rss.opml', 'utf-8');
  const parsed = xmlParser.parse(xml);
  const root = parsed?.opml;

  if (!root) {
    console.error('❌ El elemento raíz debe ser <opml>');
    process.exit(1);
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
      console.error(`❌ ${err}`);
    }
    process.exit(1);
  }

  console.log(`✅ OPML válido — ${rssOutlines.length} feeds, todos con xmlUrl y text`);
} catch (err) {
  console.error('❌ Error al parsear OPML:', err.message);
  process.exit(1);
}
