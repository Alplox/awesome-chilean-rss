const MAX_CONCURRENT = 5;
const MAX_CONCURRENT_PER_DOMAIN = 2;
const DOMAIN_DELAY_MS = 2000;
const CLEANUP_INTERVAL_MS = 60000;

// hostname -> { active, lastStart, waiters }
const domainStates = new Map();
let activeRequests = 0;
const resolveQueue = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function getDomainState(hostname) {
  let state = domainStates.get(hostname);
  if (!state) {
    state = { active: 0, lastStart: 0, waiters: [] };
    domainStates.set(hostname, state);
  }
  return state;
}

/**
 * Toma un turno para el dominio de `url`: como máximo MAX_CONCURRENT_PER_DOMAIN
 * requests en vuelo y al menos DOMAIN_DELAY_MS entre inicios. Sin el tope por
 * dominio, los scripts que lanzan los feeds de un sitio en paralelo disparan
 * una ráfaga al mismo host; los hostings compartidos encolan esas conexiones y
 * cada request termina superando el timeout de fetchSafe (10s), así que todo
 * el sitio falla aunque esté online.
 * @param {string} url - URL de la petición
 */
async function acquireDomainSlot(url) {
  const hostname = hostnameOf(url);
  if (!hostname) throw new Error('URL inválida');

  const state = getDomainState(hostname);
  while (state.active >= MAX_CONCURRENT_PER_DOMAIN) {
    await new Promise(resolve => {
      state.waiters.push(resolve);
    });
  }
  state.active++;

  if (state.lastStart > 0) {
    const elapsed = Date.now() - state.lastStart;
    if (elapsed < DOMAIN_DELAY_MS) {
      await sleep(DOMAIN_DELAY_MS - elapsed);
    }
  }
  state.lastStart = Date.now();
}

/**
 * Libera el turno del dominio de `url` y despierta al siguiente en cola.
 * @param {string} url - URL de la petición que termina
 */
function releaseDomainSlot(url) {
  const hostname = hostnameOf(url);
  if (!hostname) return;

  const state = domainStates.get(hostname);
  if (!state) return;

  state.active = Math.max(0, state.active - 1);
  const next = state.waiters.shift();
  if (next) next();
}

async function acquireGlobalSlot() {
  if (activeRequests >= MAX_CONCURRENT) {
    await new Promise(resolve => {
      resolveQueue.push(resolve);
    });
  }
  activeRequests++;
}

function releaseGlobalSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  if (resolveQueue.length > 0) {
    const next = resolveQueue.shift();
    next();
  }
}

setInterval(() => {
  const cutoff = Date.now() - CLEANUP_INTERVAL_MS;
  for (const [hostname, state] of domainStates) {
    if (state.active === 0 && state.waiters.length === 0 && state.lastStart < cutoff) {
      domainStates.delete(hostname);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

/**
 * Reserva un turno (dominio + global) antes de hacer una petición HTTP.
 * @param {string} url - URL a solicitar
 */
export async function acquireSlot(url) {
  await acquireDomainSlot(url);
  await acquireGlobalSlot();
}

/**
 * Libera el turno reservado por acquireSlot.
 * @param {string} [url] - URL de la petición; sin ella solo se libera el cupo global
 */
export function releaseSlot(url) {
  releaseGlobalSlot();
  if (url) releaseDomainSlot(url);
}
