/**
 * feed-validator.js
 * 
 * Módulo reutilizable para verificar feeds RSS/Atom.
 * Proporciona funciones para validar feeds, detectar tipos y extraer información.
 */

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false });

/**
 * Opciones de configuración para la validación de feeds
 */
export const DEFAULT_OPTIONS = {
  timeout: 10000,
  userAgent: 'Mozilla/5.0 (compatible; FeedValidator/2.0)',
  minTitleLength: 3,
  requireValidLink: true
};

/**
 * Realiza una petición fetch con timeout y User-Agent personalizado
 * @param {string} url - URL a verificar
 * @param {object} options - Opciones de configuración
 * @returns {Promise<Response|null>} - Response o null si falla
 */
export async function fetchSafe(url, options = {}) {
  const { timeout = DEFAULT_OPTIONS.timeout, userAgent = DEFAULT_OPTIONS.userAgent } = options;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': userAgent },
      redirect: 'follow'
    });
    
    clearTimeout(timeoutId);
    return res;
  } catch {
    return null;
  }
}

/**
 * Detecta el tipo de feed (RSS o Atom)
 * @param {string} text - Contenido del feed
 * @returns {'RSS' | 'Atom' | null}
 */
export function detectFeedType(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<rss') || trimmed.startsWith('<?xml')) {
    return 'RSS';
  }
  if (trimmed.startsWith('<feed')) {
    return 'Atom';
  }
  return null;
}

/**
 * Verifica si una URL es un feed RSS/Atom válido con items
 * @param {string} url - URL del feed
 * @param {object} options - Opciones de configuración
 * @returns {Promise<{ type: 'RSS' | 'Atom', itemCount: number, title?: string } | { error: string, code?: number } | null>}
 */
export async function checkFeedUrl(url, options = {}) {
  const { 
    minTitleLength = DEFAULT_OPTIONS.minTitleLength,
    requireValidLink = DEFAULT_OPTIONS.requireValidLink 
  } = options;
  
  const res = await fetchSafe(url, options);
  if (!res) return { error: 'no responde', code: null };
  if (!res.ok) return { error: 'HTTP error', code: res.status };

  const text = await res.text();
  
  // Verificar que no sea HTML
  if (text.trimStart().startsWith('<html') || text.trimStart().startsWith('<!DOCTYPE')) {
    return { error: 'HTML (no es feed)', code: null };
  }

  const type = detectFeedType(text);
  if (!type) return { error: 'no es RSS/Atom', code: null };

  try {
    const parsed = parser.parse(text);
    const channel = parsed?.rss?.channel || parsed?.feed;
    if (!channel) return { error: 'sin canal', code: null };
    
    const items = channel.item || channel.entry || [];
    const itemCount = Array.isArray(items) ? items.length : (items ? 1 : 0);

    // Si no hay items, considerarlo inválido
    if (itemCount === 0) return { error: 'feed vacío', code: null };

    // Verificar que al menos un item tenga título y link válidos
    const hasValidItem = Array.isArray(items)
      ? items.some(item => {
          // Extraer título, usar description como fallback para feeds como Mastodon
          let title = item?.title ? String(item.title).trim() : '';
          if (!title && item?.description) {
            // Usar description como título, eliminar etiquetas HTML
            const desc = String(item.description).replace(/<[^>]*>/g, '').trim();
            title = desc.substring(0, 100); // Limitar a 100 caracteres
          }
          
          // Extraer link (manejar formato de objeto para feeds Atom como Reddit)
          let link = '';
          if (item?.link) {
            if (typeof item.link === 'string') {
              link = item.link.trim();
            } else if (item.link['@_href']) {
              link = item.link['@_href'].trim();
            }
          }
          
          // Validar título (usar longitud mínima reducida para feeds sin título explícito)
          if (title.length < 5) return false;
          
          // Validar link si está requerido
          if (requireValidLink && !link.startsWith('http') && !link.startsWith('/')) {
            return false;
          }
          
          return true;
        })
      : (() => {
          // Extraer título, usar description como fallback para feeds como Mastodon
          let title = items?.title ? String(items.title).trim() : '';
          if (!title && items?.description) {
            const desc = String(items.description).replace(/<[^>]*>/g, '').trim();
            title = desc.substring(0, 100);
          }
          
          // Extraer link (manejar formato de objeto para feeds Atom como Reddit)
          let link = '';
          if (items?.link) {
            if (typeof items.link === 'string') {
              link = items.link.trim();
            } else if (items.link['@_href']) {
              link = items.link['@_href'].trim();
            }
          }
          
          if (title.length < 5) return false;
          if (requireValidLink && !link.startsWith('http') && !link.startsWith('/')) {
            return false;
          }
          
          return true;
        })();

    if (!hasValidItem) return { error: 'items sin contenido válido', code: null };

    const title = channel.title || '(sin título)';
    return { type, itemCount, title };

  } catch {
    return { error: 'XML inválido', code: null };
  }
}

/**
 * Verifica múltiples feeds en paralelo
 * @param {Array<{name: string, url: string}>} feeds - Array de feeds a verificar
 * @param {object} options - Opciones de configuración
 * @returns {Promise<Array<{name: string, url: string, result: object}>>}
 */
export async function checkMultipleFeeds(feeds, options = {}) {
  const results = await Promise.all(
    feeds.map(async (feed) => ({
      name: feed.name,
      url: feed.url,
      result: await checkFeedUrl(feed.url, options)
    }))
  );
  return results;
}

/**
 * Imprime resultados de verificación de feeds en formato legible
 * @param {Array<{name: string, url: string, result: object}>} results - Resultados de checkMultipleFeeds
 */
export function printFeedResults(results) {
  for (const { name, url, result } of results) {
    if (result.type) {
      console.log(`✅ ${name}: ${result.type} (${result.itemCount} items)`);
      if (result.title) {
        console.log(`   Título: "${result.title}"`);
      }
    } else {
      const errorMsg = result.code 
        ? `${result.error} (${result.code})` 
        : result.error;
      console.log(`❌ ${name}: ${errorMsg}`);
    }
  }
}

/**
 * Filtra feeds válidos de un array de resultados
 * @param {Array<{name: string, url: string, result: object}>} results - Resultados de checkMultipleFeeds
 * @returns {Array<{name: string, url: string, type: string, itemCount: number, title?: string}>}
 */
export function filterValidFeeds(results) {
  return results
    .filter(({ result }) => result.type)
    .map(({ name, url, result }) => ({
      name,
      url,
      type: result.type,
      itemCount: result.itemCount,
      title: result.title
    }));
}
