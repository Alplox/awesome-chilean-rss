import { checkFeedUrl } from './feed-validator.js';
import { rediscoverFeed } from './feed-rediscovery.js';
import { STALE_THRESHOLD_DAYS, daysSince } from './feed-utils.js';

async function validateExistingFeeds(feeds) {
  return await Promise.all(feeds.map(async feed => {
    const result = await checkFeedUrl(feed.rss_url);
    if (!result?.type) {
      return { ...feed, status: 'broken', verified: false, last_checked: new Date().toISOString() };
    }
    const now = new Date().toISOString();
    if (result.itemCount === 0) {
      return { ...feed, status: 'feed_empty', verified: false, last_checked: now };
    }
    let status = 'active';
    let lastItemDate = feed.last_known_item_date;
    if (result.lastItemDate) {
      lastItemDate = result.lastItemDate;
      if (daysSince(result.lastItemDate) > STALE_THRESHOLD_DAYS) {
        status = 'stale';
      }
    }
    return {
      ...feed,
      status,
      verified: status === 'active',
      last_checked: now,
      last_known_item_date: lastItemDate,
    };
  }));
}

/**
 * Valida completamente un entry de watchlist (estructura site-like).
 * @param {object} entry — Watchlist entry {id, name, url, category, reason, feeds: []}
 * @returns {Promise<{ ok: true, siteEntry: object } | { ok: false, reason: string, entry?: object }>}
 */
export async function validateWatchlistEntry(entry) {
  let lastProgress = '';
  const pad = ' '.repeat(50);
  const onProgress = (msg) => {
    if (msg !== lastProgress) {
      lastProgress = msg;
      process.stdout.write(`\r🔍 ${entry.name}... ${msg}${pad}\r`);
    }
  };
  const found = await rediscoverFeed(entry.url, [], onProgress);

  const existingFeedsValidated = entry.feeds?.length > 0
    ? await validateExistingFeeds(entry.feeds)
    : [];

  if (!found.feedUrl) {
    const errorMsg = found.code ? `${found.error} (${found.code})` : found.error;
    const result = { ok: false, reason: errorMsg };
    if (existingFeedsValidated.length > 0) {
      result.entry = { ...entry, feeds: existingFeedsValidated };
    }
    return result;
  }

  const feedResult = await checkFeedUrl(found.feedUrl);
  if (!feedResult?.type) {
    const err = feedResult?.error ? `feed inválido: ${feedResult.error}` : 'feed no disponible';
    const result = { ok: false, reason: err };
    if (existingFeedsValidated.length > 0) {
      result.entry = { ...entry, feeds: existingFeedsValidated };
    }
    return result;
  }

  if (feedResult.itemCount === 0) {
    const entryWithFeed = promoteToSite(entry, found.feedUrl, feedResult, existingFeedsValidated);
    return { ok: false, reason: 'feed vacío o sin items', entry: entryWithFeed };
  }

  if (feedResult.lastItemDate) {
    const dSince = daysSince(feedResult.lastItemDate);
    if (dSince > STALE_THRESHOLD_DAYS) {
      const entryWithFeed = promoteToSite(entry, found.feedUrl, feedResult, existingFeedsValidated);
      return {
        ok: false,
        reason: `feed stale (último item: ${feedResult.lastItemDate.slice(0, 10)}, ${Math.round(dSince)} días)`,
        entry: entryWithFeed,
      };
    }
  }

  const siteEntry = promoteToSite(entry, found.feedUrl, feedResult, existingFeedsValidated);
  return { ok: true, siteEntry };
}

/**
 * Convierte un watchlist entry en site entry, preservando feeds existentes
 * (proxy subfeeds como Google News + Bing News) y agregando el nuevo feed nativo.
 * @param {object} entry — Watchlist entry
 * @param {string} feedUrl — URL del feed nativo descubierto
 * @param {{ type: string, lastItemDate?: string }} feedResult
 * @param {object[]} existingFeeds — Feeds existentes ya validados
 * @returns {object} Site entry listo para sites[]
 */
export function promoteToSite(entry, feedUrl, feedResult, existingFeeds = []) {
  const now = new Date().toISOString();
  const newFeed = {
    id: `${entry.id}-main`,
    name: entry.name,
    rss_url: feedUrl,
    feed_type: feedResult.type,
    last_checked: now,
    status: 'active',
    verified: true,
  };
  if (feedResult.lastItemDate) {
    newFeed.last_known_item_date = feedResult.lastItemDate;
  }

  const allFeeds = [newFeed, ...existingFeeds];
  const seen = new Set();
  const deduped = [];
  for (const f of allFeeds) {
    if (!seen.has(f.rss_url)) {
      seen.add(f.rss_url);
      deduped.push(f);
    }
  }

  return {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    category: entry.category,
    description: entry.description || '',
    feeds: deduped,
  };
}
