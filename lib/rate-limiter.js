const MAX_CONCURRENT = 5;
const DOMAIN_DELAY_MS = 2000;
const CLEANUP_INTERVAL_MS = 60000;

const domainTimestamps = new Map();
let activeRequests = 0;
const resolveQueue = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForDomainSlot(url) {
  const domain = new URL(url).hostname;
  const timestamps = domainTimestamps.get(domain);
  if (timestamps && timestamps.length > 0) {
    const elapsed = Date.now() - timestamps[timestamps.length - 1];
    if (elapsed < DOMAIN_DELAY_MS) {
      await sleep(DOMAIN_DELAY_MS - elapsed);
    }
  }
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

function recordDomainRequest(url) {
  const domain = new URL(url).hostname;
  if (!domainTimestamps.has(domain)) {
    domainTimestamps.set(domain, []);
  }
  domainTimestamps.get(domain).push(Date.now());
}

setInterval(() => {
  const cutoff = Date.now() - CLEANUP_INTERVAL_MS;
  for (const [domain, timestamps] of domainTimestamps) {
    const fresh = timestamps.filter(t => t > cutoff);
    if (fresh.length === 0) {
      domainTimestamps.delete(domain);
    } else {
      domainTimestamps.set(domain, fresh);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

export async function acquireSlot(url) {
  await waitForDomainSlot(url);
  await acquireGlobalSlot();
  recordDomainRequest(url);
}

export function releaseSlot() {
  releaseGlobalSlot();
}
