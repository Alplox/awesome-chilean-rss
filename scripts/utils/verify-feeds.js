#!/usr/bin/env node
/**
 * verify-feeds.js
 * 
 * Script genérico para verificar feeds RSS/Atom.
 * 
 * Uso:
 *   node scripts/utils/verify-feeds.js <feeds.json>
 *   node scripts/utils/verify-feeds.js https://ejemplo.com/feed.xml
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

// Detectar si es una URL directa o un archivo JSON
let isDirectUrl = false;
let feedsFile = null;
let feeds = null;

if (args.length === 0) {
  console.error('❌ Error: Debes especificar un archivo JSON o una URL');
  console.error('Uso:');
  console.error('  node scripts/utils/verify-feeds.js <feeds.json>');
  console.error('  node scripts/utils/verify-feeds.js https://ejemplo.com/feed.xml');
  console.error('\nEjemplo de feeds.json:');
  console.error(JSON.stringify([
    { name: 'Feed 1', url: 'https://ejemplo.com/feed.xml' },
    { name: 'Feed 2', url: 'https://ejemplo.com/rss' }
  ], null, 2));
  process.exit(1);
}

const input = args[0];

// Verificar si es una URL
if (input.startsWith('http://') || input.startsWith('https://')) {
  isDirectUrl = true;
  const urlObj = new URL(input);
  feeds = [{ name: urlObj.hostname, url: input }];
  console.log(`🔍 Verificando feed directo: ${input}\n`);
} else {
  feedsFile = input;
  console.log(`🔍 Verificando feeds desde: ${feedsFile}\n`);
}

try {
  // Cargar feeds si es un archivo JSON (no URL directa)
  if (!isDirectUrl) {
    feeds = JSON.parse(readFileSync(feedsFile, 'utf-8'));
  }
  
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
