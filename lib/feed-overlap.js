import { DUPLICATE_OVERLAP_THRESHOLD } from './feed-utils.js';

const MIN_ITEMS_FOR_OVERLAP = 5;

export function normalizeItemKey(item) {
  const raw = item?.guid || item?.link || '';
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/#.*$/, '')
    .replace(/\/+$/, '');
}

export function keySet(items) {
  const set = new Set();
  for (const item of items) {
    const key = normalizeItemKey(item);
    if (key.length >= 5) set.add(key);
  }
  return set;
}

export function containmentRatio(itemsA, itemsB) {
  const setB = keySet(itemsB);
  const itemsAKeys = itemsA.map(normalizeItemKey).filter(k => k.length >= 5);
  if (itemsAKeys.length === 0) return 0;
  const contained = itemsAKeys.filter(k => setB.has(k)).length;
  return contained / itemsAKeys.length;
}

export function findDuplicate(feedItems, otherFeedsItems, threshold = DUPLICATE_OVERLAP_THRESHOLD) {
  if (!Array.isArray(feedItems) || feedItems.length < MIN_ITEMS_FOR_OVERLAP) return null;
  let best = null;
  for (const [otherId, otherItems] of otherFeedsItems) {
    if (!Array.isArray(otherItems) || otherItems.length < MIN_ITEMS_FOR_OVERLAP) continue;
    const ratio = containmentRatio(feedItems, otherItems);
    if (ratio >= threshold && (!best || ratio > best.ratio)) {
      best = { duplicateOf: otherId, ratio };
    }
  }
  return best;
}
