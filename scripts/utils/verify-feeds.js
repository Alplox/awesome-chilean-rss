#!/usr/bin/env node
/**
 * verify-feeds.js
 * 
 * Script genérico para verificar feeds RSS/Atom.
 * Uso: node scripts/utils/verify-feeds.js <feeds.json>
 * 
 * Formato de feeds.json:
 * [
 *   { "name": "Nombre del feed", "url": "https://ejemplo.com/feed.xml" },
 *   ...
 * ]
 */

import { checkMultipleFeeds, printFeedResults, filterValidFeeds } from '../../lib/feed-validator.js';
import { readFileSync, writeFileSync } from 'fs';

// Obtener argumentos de línea de comandos
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('❌ Error: Debes especificar un archivo JSON con los feeds a verificar');
  console.error('Uso: node scripts/utils/verify-feeds.js <feeds.json>');
  console.error('\nEjemplo de feeds.json:');
  console.error(JSON.stringify([
    { name: 'Feed 1', url: 'https://ejemplo.com/feed.xml' },
    { name: 'Feed 2', url: 'https://ejemplo.com/rss' }
  ], null, 2));
  process.exit(1);
}

const feedsFile = args[0];

try {
  const feeds = JSON.parse(readFileSync(feedsFile, 'utf-8'));
  
  console.log(`🔍 Verificando ${feeds.length} feeds...\n`);
  
  const results = await checkMultipleFeeds(feeds);
  printFeedResults(results);
  
  const validFeeds = filterValidFeeds(results);
  console.log(`\n📊 Resumen: ${validFeeds.length}/${feeds.length} feeds válidos`);
  
  // Opcional: guardar resultados en un archivo
  if (args.includes('--output') || args.includes('-o')) {
    const outputIndex = args.indexOf('--output') !== -1 ? args.indexOf('--output') : args.indexOf('-o');
    const outputFile = args[outputIndex + 1] || 'feed-results.json';
    
    const outputData = {
      timestamp: new Date().toISOString(),
      total: feeds.length,
      valid: validFeeds.length,
      invalid: feeds.length - validFeeds.length,
      results: results.map(({ name, url, result }) => ({
        name,
        url,
        valid: !!result.type,
        ...result
      }))
    };
    
    writeFileSync(outputFile, JSON.stringify(outputData, null, 2));
    console.log(`💾 Resultados guardados en ${outputFile}`);
  }
  
} catch (error) {
  console.error(`❌ Error al leer el archivo: ${error.message}`);
  process.exit(1);
}
