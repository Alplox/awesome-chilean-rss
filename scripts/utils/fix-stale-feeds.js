import { readFileSync, writeFileSync } from 'fs';

const DB_PATH = 'feeds-database.json';
const STALE_DAYS = 30;

const db = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
const now = Date.now();
let fixed = [];

for (const site of db.sites) {
  for (const feed of site.feeds) {
    if (feed.status !== 'active' || feed.verified !== true) continue;
    if (!feed.last_known_item_date) continue;

    const daysSince = (now - new Date(feed.last_known_item_date).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > STALE_DAYS) {
      const label = `${site.name}${site.feeds.length > 1 ? ` › ${feed.name}` : ''}`;
      console.log(`⏳ ${label}: ${feed.last_known_item_date.slice(0, 10)} (${Math.round(daysSince)} días) → stale`);
      feed.status = 'stale';
      feed.verified = false;
      fixed.push(label);
    }
  }
}

if (fixed.length === 0) {
  console.log('✅ No hay feeds stale por corregir.');
  process.exit(0);
}

const activeCount = db.sites.reduce(
  (sum, site) => sum + site.feeds.filter(f => f.status === 'active').length, 0
);
db.total_feeds = activeCount;
db.last_updated = new Date().toISOString();

writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
console.log(`\n💾 ${fixed.length} feed(s) marcados como stale.`);
console.log(`📊 Total feeds activos: ${activeCount}`);
