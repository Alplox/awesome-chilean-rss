/**
 * Valida la estructura del archivo chilean-rss.opml.
 * Usado por el workflow de CI.
 */
import { readFileSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

try {
  const xml = readFileSync('chilean-rss.opml', 'utf-8');
  const parsed = parser.parse(xml);
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

  for (const o of rssOutlines) {
    if (!o['@_xmlUrl']) {
      console.error(`❌ Feed "${o['@_text']}" sin xmlUrl`);
      process.exit(1);
    }
    if (!o['@_text']) {
      console.error('❌ Feed sin atributo text');
      process.exit(1);
    }
  }

  console.log(`✅ OPML válido — ${rssOutlines.length} feeds, todos con xmlUrl y text`);
} catch (err) {
  console.error('❌ Error al parsear OPML:', err.message);
  process.exit(1);
}
