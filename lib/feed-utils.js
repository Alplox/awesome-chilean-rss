export const STALE_THRESHOLD_DAYS = 30;

export const ALLOWED_STATUSES = ['active', 'stale', 'broken', 'offline', 'no_feed', 'feed_empty'];

export const BROKEN_ERRORS = [
  'HTML (no es feed)',
  'no es RSS/Atom',
  'sin canal',
  'XML inválido',
  'items sin contenido válido',
];

export function extractSelfLink(text) {
  const el = text.match(/<(?:atom:)?link[^>]*\brel="self"[^>]*\/?>/i);
  return el ? el[0].match(/href="([^"]+)"/i)?.[1] ?? null : null;
}

export function pathsMatch(urlA, urlB) {
  try {
    return new URL(urlA).pathname.replace(/\/+$/, '')
        === new URL(urlB).pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

export function daysSince(date) {
  return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24);
}

export function isStale(date) {
  return date && daysSince(date) > STALE_THRESHOLD_DAYS;
}

export function formatError(error, code) {
  return code ? `${error} (${code})` : error;
}

export function recalculateTotalFeeds(db) {
  const activeCount = db.sites.reduce((sum, site) =>
    sum + site.feeds.filter(f => f.status === 'active' && f.verified === true).length, 0
  );
  db.total_feeds = activeCount;
  db.last_updated = new Date().toISOString();
  return activeCount;
}

export function getDomain(url) {
  try {
    const u = new URL(url);
    let host = u.hostname;
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return null;
  }
}
