/**
 * Verificación de feeds vía relays públicos de un solo endpoint.
 *
 * Objetivo: **diagnóstico**. Cuando un feed falla con un error de conexión
 * (timeout, DNS, reset, IP bloqueada) desde la red donde corre el script,
 * reintentar la lectura a través de un relay HTTP que hace el fetch desde otra
 * red. Si vía relay el feed sí responde, el problema está en la red local
 * (bloqueo por IP/rango, DNS, firewall corporativo), no en el sitio.
 *
 * A diferencia de una lista de proxies aleatorios, un relay de un solo endpoint
 * es un host estable y verificable. Aun así, un relay puede devolver una página
 * de error propia o alterar el contenido, así que los resultados obtenidos por
 * relay son **solo informativos** y nunca deben usarse para escribir el estado
 * de un feed en feeds-database.json (ver `scripts/utils/diagnose-network.js`).
 *
 * Se reutiliza toda la validación existente: el relay entrega el body tal cual
 * (raw), y sobre ese texto corre `inspectFeedText` — además de `fetchSafe` para
 * timeout, reintentos, rotación de User-Agent y rate limiting.
 */

import { fetchSafe, readResponseBody, inspectFeedText, MAX_RESPONSE_BYTES } from './feed-validator.js';

/** Timeout por petición al relay (los relays públicos son lentos). */
export const RELAY_TIMEOUT_MS = 15000;

/** Relays usados cuando no se especifica ninguno, en orden de preferencia. */
export const DEFAULT_RELAY = 'allorigins,codetabs';

/**
 * Relays públicos soportados. `build` recibe la URL objetivo y devuelve la URL
 * del relay. Cualquier plantilla propia con `{url}` (codificada) o `{urlRaw}`
 * (sin codificar) también sirve, por ejemplo un Cloudflare Worker propio:
 * `https://mi-relay.workers.dev/?url={url}`.
 */
export const RELAY_PRESETS = {
  allorigins: {
    name: 'allorigins',
    label: 'AllOrigins',
    build: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  codetabs: {
    name: 'codetabs',
    label: 'CodeTabs',
    build: url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
};

/**
 * Resuelve una especificación de relay: un preset por nombre o una plantilla
 * con `{url}` / `{urlRaw}`.
 * @param {string} spec - Nombre de preset (`allorigins`, `codetabs`) o plantilla
 * @returns {{ name: string, label: string, build: (url: string) => string }|null} Relay resuelto o null si no es válido
 */
export function resolveRelay(spec) {
  if (!spec) return null;
  const raw = String(spec).trim();
  if (!raw) return null;

  const preset = RELAY_PRESETS[raw.toLowerCase()];
  if (preset) return preset;

  if (raw.includes('{url}') || raw.includes('{urlRaw}')) {
    return {
      name: 'custom',
      label: 'Custom',
      build: url => raw
        .replaceAll('{url}', encodeURIComponent(url))
        .replaceAll('{urlRaw}', url),
    };
  }

  return null;
}

/**
 * Resuelve una lista de relays separados por coma.
 * @param {string} [spec] - Lista separada por coma (default: `allorigins,codetabs`)
 * @returns {{ relays: Array<object>, invalid: string[] }} Relays válidos y especificaciones no reconocidas
 */
export function resolveRelayList(spec = DEFAULT_RELAY) {
  const specs = String(spec ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const relays = [];
  const invalid = [];
  for (const item of (specs.length ? specs : [DEFAULT_RELAY])) {
    const relay = resolveRelay(item);
    if (relay) relays.push(relay);
    else invalid.push(item);
  }
  return { relays, invalid };
}

/**
 * Detecta si el cuerpo recibido es una página de error del propio relay
 * (cuota excedida, proxy caído) y no la respuesta del sitio objetivo.
 * @param {string} text - Body devuelto por el relay
 * @returns {boolean} true si parece un error del relay
 */
export function looksLikeRelayErrorPage(text) {
  if (!text) return false;
  const head = text.slice(0, 2000).toLowerCase();
  if (head.includes('allorigins') || head.includes('codetabs') || head.includes('proxy error')) return true;
  if (head.includes('too many requests') || head.includes('rate limit exceeded')) return true;
  // JSON de error de proxy (no un JSON Feed, que declara "version")
  return /"error"\s*:/.test(head) && !head.includes('"version"');
}

/**
 * Descarga el body de una URL a través de un relay.
 *
 * Un HTTP 5xx se marca como `relayError`: proviene de la infraestructura del
 * relay (edge caído, origen del relay inalcanzable), no del sitio objetivo, así
 * que no permite concluir nada sobre el feed.
 * @param {string} url - URL objetivo
 * @param {object} options - `relay` (resuelto), `timeout`
 * @returns {Promise<{ text?: string, relayUrl: string, error?: string, code?: number|null, relayError?: boolean }>}
 */
async function fetchViaRelay(url, options = {}) {
  const { relay, timeout = RELAY_TIMEOUT_MS } = options;
  const relayUrl = relay.build(url);

  const res = await fetchSafe(relayUrl, { timeout });
  if (!res) return { error: 'relay no responde', code: null, relayUrl, relayError: true };
  if (!res.ok) {
    return {
      error: 'HTTP error vía relay',
      code: res.status,
      relayUrl,
      relayError: res.status >= 500,
    };
  }

  try {
    const text = await readResponseBody(res, MAX_RESPONSE_BYTES);
    return { text, relayUrl };
  } catch (err) {
    return { error: `respuesta del relay inválida (${err?.message ?? err})`, code: null, relayUrl, relayError: true };
  }
}

/**
 * Verifica si el contenido de un feed responde correctamente visto desde un
 * relay. Mismo contrato que `checkFeedUrl` (type/itemCount/error), más
 * `viaRelay`, `relayUrl` y `relayError` (el relay falló, no el feed).
 * @param {string} url - URL del feed
 * @param {object} options - `relay` (string o resuelto), `timeout`, `includeItems`
 * @returns {Promise<object>} Resultado de la inspección del feed
 */
export async function checkFeedViaRelay(url, options = {}) {
  const { includeItems = false, timeout } = options;
  const relay = typeof options.relay === 'string' ? resolveRelay(options.relay) : options.relay;
  if (!relay) return { error: `relay desconocido: ${options.relay}`, relayError: true, relayUrl: null };

  const fetched = await fetchViaRelay(url, { relay, timeout });
  if (!fetched.text) {
    return {
      error: fetched.error,
      code: fetched.code ?? null,
      ...(fetched.relayError ? { relayError: true } : {}),
      viaRelay: relay.name,
      relayUrl: fetched.relayUrl,
    };
  }

  const relayError = looksLikeRelayErrorPage(fetched.text);
  const inspected = inspectFeedText(fetched.text, { includeItems });
  return {
    ...inspected,
    ...(relayError ? { error: inspected.error ?? 'relay devolvió su propia página de error', relayError: true } : {}),
    viaRelay: relay.name,
    relayUrl: fetched.relayUrl,
    relayTextLength: fetched.text.length,
  };
}

/**
 * Comprueba si una URL (típicamente el sitio raíz) es alcanzable desde un
 * relay, sin exigir que el contenido sea un feed válido.
 * @param {string} url - URL a comprobar
 * @param {object} options - `relay` (string o resuelto), `timeout`
 * @returns {Promise<{ reachable: boolean, status?: number, relayError?: boolean, error?: string, viaRelay?: string, relayUrl?: string }>}
 */
export async function checkReachabilityViaRelay(url, options = {}) {
  const { timeout } = options;
  const relay = typeof options.relay === 'string' ? resolveRelay(options.relay) : options.relay;
  if (!relay) return { reachable: false, error: `relay desconocido: ${options.relay}`, relayError: true };

  const relayUrl = relay.build(url);
  const res = await fetchSafe(relayUrl, { timeout });
  if (!res) return { reachable: false, error: 'relay no responde', relayError: true, viaRelay: relay.name, relayUrl };

  // 5xx del relay = su propia infraestructura falló, no el sitio objetivo
  if (res.status >= 500) {
    return { reachable: true, status: res.status, relayError: true, viaRelay: relay.name, relayUrl };
  }

  let relayError = false;
  try {
    const text = await readResponseBody(res, MAX_RESPONSE_BYTES);
    relayError = looksLikeRelayErrorPage(text);
  } catch { /* body ilegible: la respuesta HTTP ya cuenta como alcanzable */ }

  return {
    reachable: true,
    status: res.status,
    ...(relayError ? { relayError: true } : {}),
    viaRelay: relay.name,
    relayUrl,
  };
}
