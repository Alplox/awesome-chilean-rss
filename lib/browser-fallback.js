import { DEFAULT_OPTIONS } from './feed-validator.js';

let browserPromise = null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8';

async function getBrowser() {
  if (!browserPromise) {
    const { chromium } = await import('playwright');
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser) await browser.close().catch(() => {});
    browserPromise = null;
  }
}

const FEED_START = /^\s*(?:<\?xml|<rss|<feed|<rdf)/;

/**
 * Verifica un feed con un navegador headless (Playwright), resolviendo
 * challenges anti-bot (ej. Cloudflare "Just a moment...") que bloquean a
 * fetch/curl. Devuelve el texto crudo del feed, o null si no se pudo leer.
 *
 * Estrategia: navega a la URL (para que el challenge se resuelva y quede la
 * cookie de clearance) y luego hace un fetch same-origin desde la página con
 * Accept XML (algunos servidores sirven HTML a navegadores y XML a clientes
 * no-navegador según Sec-Fetch/Content-Negotiation).
 */
export async function fetchWithBrowser(url, { timeout = DEFAULT_OPTIONS.timeout * 3 } = {}) {
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    console.warn(`[browser-fallback] Playwright no disponible: ${err?.message ?? err}`);
    return null;
  }

  const context = await browser.newContext({
    userAgent: UA,
    locale: 'es-CL',
  }).catch(() => null);
  if (!context) return null;
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const text = await page.evaluate(({ targetUrl, accept }) =>
        fetch(targetUrl, { headers: { Accept: accept } })
          .then(r => r.text())
          .catch(() => ''),
        { targetUrl: url, accept: FEED_ACCEPT }
      ).catch(() => '');
      if (text && FEED_START.test(text)) return text;
      await page.waitForTimeout(1500);
    }
    return null;
  } catch {
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}