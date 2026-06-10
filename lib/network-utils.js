import http from 'http';
import https from 'https';
import tls from 'tls';
import { fetchSafe, detectFeedType, getMostRecentDate, DEFAULT_OPTIONS, xmlParser, MAX_RESPONSE_BYTES } from './feed-validator.js';

const TIMEOUT_MS = DEFAULT_OPTIONS.timeout;
const UA = DEFAULT_OPTIONS.userAgent;

const PRIVATE_HOST_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|::1|localhost)/i;

export function isValidUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (PRIVATE_HOST_RE.test(host)) return false;
    return true;
  } catch (err) {
    console.warn(`[isValidUrl] Invalid URL: ${urlStr.slice(0, 120)} — ${err.message}`);
    return false;
  }
}

export async function checkSiteStatus(baseUrl) {
  const res = await fetchSafe(baseUrl, { method: 'HEAD' });
  if (res && res.ok) return 'up';
  if (res && res.status < 500) return 'up';
  const res2 = await fetchSafe(baseUrl, { method: 'GET' });
  if (res2 && res2.ok) return 'up';
  if (res2 && res2.status < 500) return 'up';
  return 'down';
}

function checkCertError(baseUrl) {
  return new Promise(resolve => {
    try {
      const url = new URL(baseUrl);
      const socket = tls.connect({
        host: url.hostname,
        port: 443,
        servername: url.hostname,
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS
      }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
    } catch (err) {
      console.warn(`[checkCertError] TLS error for ${baseUrl.slice(0, 120)}: ${err.message}`);
      resolve(false);
    }
  });
}

export async function checkSiteReachable(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch (err) {
    console.warn(`[checkSiteReachable] Invalid URL: ${baseUrl.slice(0, 120)} — ${err.message}`);
    return { reachable: false, type: 'down' };
  }

  const tlsOk = await checkCertError(baseUrl);
  if (tlsOk) return { reachable: true, type: 'cert' };

  const httpsInsecureOk = await new Promise(resolve => {
    try {
      const req = https.get(`https://${url.hostname}/`, {
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': UA }
      }, res => {
        res.resume();
        resolve(res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch (err) {
      console.warn(`[checkSiteReachable] HTTPS error for ${url.hostname}: ${err.message}`);
      resolve(false);
    }
  });
  if (httpsInsecureOk) return { reachable: true, type: 'cert' };

  const httpOk = await new Promise(resolve => {
    try {
      const req = http.get(`http://${url.hostname}/`, {
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': UA }
      }, res => {
        res.resume();
        resolve(res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch (err) {
      console.warn(`[checkSiteReachable] HTTP error for ${url.hostname}: ${err.message}`);
      resolve(false);
    }
  });

  if (httpOk) return { reachable: true, type: 'blocked' };

  return { reachable: false, type: 'down' };
}

export function tryFetchFeedInsecure(feedUrl) {
  return new Promise(resolve => {
    try {
      const url = new URL(feedUrl);
      const opts = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': UA }
      };

      const req = https.request(opts, res => {
        const chunks = [];
        let total = 0;
        res.on('data', c => {
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) {
            req.destroy();
            resolve(null);
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (res.statusCode >= 400) { resolve(null); return; }
          const text = Buffer.concat(chunks).toString('utf8');

          if (text.trimStart().startsWith('<html') || text.trimStart().startsWith('<!DOCTYPE')) {
            resolve(null); return;
          }

          const type = detectFeedType(text);
          if (!type) { resolve(null); return; }

          try {
            const parsed = xmlParser.parse(text);
            const channel = parsed?.rss?.channel || parsed?.feed;
            if (!channel) { resolve(null); return; }

            const items = channel.item || channel.entry || [];
            const itemCount = Array.isArray(items) ? items.length : (items ? 1 : 0);
            const channelDate = channel.lastBuildDate || channel.pubDate || null;
            const lastItemDate = getMostRecentDate(items, channelDate);

            resolve({ type, itemCount, lastItemDate });
          } catch (err) {
            console.warn(`[tryFetchFeedInsecure] Parse error for ${feedUrl.slice(0, 120)}: ${err.message}`);
            resolve(null);
          }
        });
      });
      req.on('error', (err) => {
        console.warn(`[tryFetchFeedInsecure] Request error for ${feedUrl.slice(0, 120)}: ${err.message}`);
        resolve(null);
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch (err) {
      console.warn(`[tryFetchFeedInsecure] Setup error for ${feedUrl.slice(0, 120)}: ${err.message}`);
      resolve(null);
    }
  });
}
