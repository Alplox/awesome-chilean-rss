#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';

const KEY_ORDER = [
  'id',
  'name',
  'rss_url',
  'url',
  'description',
  'feed_type',
  'category',
  'region',
  'last_checked',
  'last_known_item_date',
  'verified',
  'status',
  'duplicate_of',
];

function standardizeFeed(feed) {
  const ordered = {};
  for (const key of KEY_ORDER) {
    if (key in feed) {
      ordered[key] = feed[key];
    }
  }
  return ordered;
}

function main() {
  const filePath = 'feeds-database.json';
  const db = JSON.parse(readFileSync(filePath, 'utf-8'));

  let totalFeeds = 0;
  for (const site of db.sites) {
    site.feeds = site.feeds.map(feed => {
      totalFeeds++;
      return standardizeFeed(feed);
    });
  }

  writeFileSync(filePath, JSON.stringify(db, null, 2) + '\n', 'utf-8');
  console.log(`✅ ${totalFeeds} feeds estandarizados en ${db.sites.length} sitios`);
}

main();
