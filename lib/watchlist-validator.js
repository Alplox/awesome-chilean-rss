import { checkFeedUrl } from './feed-validator.js';
import { rediscoverFeed } from './feed-rediscovery.js';

const STALE_THRESHOLD_DAYS = 365;

/**
 * Valida completamente un entry de watchlist (estructura site-like).
 * @param {object} entry — Watchlist entry {id, name, url, category, reason, feeds: []}
 * @returns {Promise<{ ok: true, siteEntry: object } | { ok: false, reason: string, entry?: object }>}
 */
export async function validateWatchlistEntry(entry) {
  const found = await rediscoverFeed(entry.url);
  if (!found.feedUrl) {
    const errorMsg = found.code ? `${found.error} (${found.code})` : found.error;
    return { ok: false, reason: errorMsg };
  }

  const feedResult = await checkFeedUrl(found.feedUrl);
  if (!feedResult?.type) {
    const err = feedResult?.error ? `feed inválido: ${feedResult.error}` : 'feed no disponible';
    return { ok: false, reason: err };
  }

  if (feedResult.itemCount === 0) {
    const entryWithFeed = promoteToSite(entry, found.feedUrl, feedResult);
    return { ok: false, reason: 'feed vacío o sin items', entry: entryWithFeed };
  }

  if (feedResult.lastItemDate) {
    const daysSince = (Date.now() - new Date(feedResult.lastItemDate).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > STALE_THRESHOLD_DAYS) {
      const entryWithFeed = promoteToSite(entry, found.feedUrl, feedResult);
      return {
        ok: false,
        reason: `feed stale (último item: ${feedResult.lastItemDate.slice(0, 10)}, ${Math.round(daysSince)} días)`,
        entry: entryWithFeed,
      };
    }
  }

  const siteEntry = promoteToSite(entry, found.feedUrl, feedResult);
  return { ok: true, siteEntry };
}

/**
 * Llena feeds[0] en un watchlist entry y elimina reason,
 * convirtiéndolo en un site entry válido.
 * @param {object} entry — Watchlist entry {id, name, url, category, reason, feeds: []}
 * @param {string} feedUrl — URL del feed validado
 * @param {{ type: string, lastItemDate?: string }} feedResult
 * @returns {object} Site entry listo para sites[]
 */
export function promoteToSite(entry, feedUrl, feedResult) {
  const now = new Date().toISOString();
  const feed = {
    id: `${entry.id}-main`,
    name: entry.name,
    rss_url: feedUrl,
    feed_type: feedResult.type,
    last_checked: now,
    status: 'active',
    verified: true,
  };
  if (feedResult.lastItemDate) {
    feed.last_known_item_date = feedResult.lastItemDate;
  }
  return {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    category: entry.category,
    description: entry.description || '',
    feeds: [feed],
  };
}
