import axios from 'axios';
import * as cheerio from 'cheerio';
import textExtractService from './textextract.js';

/**
 * Website crawler for the Knowledge Hub's "Website" source.
 *
 * Breadth-first, same-origin only, hard-capped on pages and depth. The store owner
 * points it at their own site (or one page of it) and we index the readable text.
 *
 * No robots.txt handling: this is an owner-initiated, rate-limited, single pass over
 * the owner's OWN domain, not a general-purpose spider. If this is ever pointed at a
 * third-party site, add robots.txt support first.
 *
 * IMPORTANT — theaurax.in has a history of blocking programmatic access (a security
 * plugin / Cloudflare layer returning 401/503 with the non-standard body
 * {"success":false,"message":"API is working, Site Connected"} — the same thing that
 * breaks the WooCommerce product sync). detectBlock() recognises that signature and
 * returns an actionable error instead of a bare "request failed", because the fix is
 * on the store side, not in this code.
 */

const DEFAULT_MAX_PAGES = 25;
const DEFAULT_MAX_DEPTH = 2;
const REQUEST_TIMEOUT_MS = 20000;
const POLITE_DELAY_MS = 400;
const MAX_HTML_BYTES = 3 * 1024 * 1024;

// A real browser UA. Some WAFs reject the default axios agent outright, and the owner
// crawling their own site shouldn't have to fight their own firewall.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 TheauraxKnowledgeBot/1.0';

const SKIP_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|mjs|zip|rar|mp4|mp3|avi|mov|woff2?|ttf|eot|xml|rss|pdf)$/i;

class CrawlerService {
  /**
   * Recognise "the site is actively refusing us" as distinct from a normal 404 or a
   * transient network error, so the owner gets told what to actually fix.
   */
  detectBlock(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body || '');
    if (/API is working, Site Connected/i.test(text)) {
      return 'The site is blocking programmatic access. A security plugin or firewall on theaurax.in is intercepting requests before they reach WordPress (it returns "API is working, Site Connected"). This is the same block that breaks product sync — it has to be fixed on the store side by whitelisting this server in the security plugin / Cloudflare.';
    }
    if (status === 403 || status === 401) {
      return `The site refused the request (HTTP ${status}). A firewall, Cloudflare rule, or security plugin is blocking this server — whitelist it and try again.`;
    }
    if (status === 503) {
      return 'The site returned HTTP 503 (unavailable). This is usually a Cloudflare challenge page or WordPress maintenance mode blocking automated requests.';
    }
    if (status === 429) {
      return 'The site rate-limited the crawler (HTTP 429). Try again later or crawl fewer pages.';
    }
    return null;
  }

  normalizeUrl(href, base) {
    try {
      const url = new URL(href, base);
      url.hash = '';
      // Trailing-slash and index.html variants are the same page; collapsing them
      // stops the crawler re-fetching one page under three URLs.
      if (url.pathname.endsWith('/index.html')) url.pathname = url.pathname.slice(0, -10);
      if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
      return url.toString();
    } catch {
      return null;
    }
  }

  async fetchPage(url) {
    const res = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxContentLength: MAX_HTML_BYTES,
      maxRedirects: 5,
      responseType: 'text',
      // Handle status codes ourselves so a 403 becomes a useful message, not a throw.
      validateStatus: () => true,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-IN,en;q=0.9'
      }
    });

    const blocked = this.detectBlock(res.status, res.data);
    if (blocked) {
      const err = new Error(blocked);
      err.blocked = true;
      err.status = res.status;
      throw err;
    }
    if (res.status >= 400) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (!/text\/html|application\/xhtml/i.test(res.headers['content-type'] || '')) {
      const err = new Error('Not an HTML page');
      err.skipped = true;
      throw err;
    }
    return String(res.data || '');
  }

  /**
   * Crawl from startUrl. Returns { pages: [{url,title,text}], visited, errors, origin }.
   * Throws only if the FIRST page fails — a mid-crawl failure on one link is recorded
   * in `errors` and the rest of the crawl continues.
   */
  async crawl(startUrl, { maxPages = DEFAULT_MAX_PAGES, maxDepth = DEFAULT_MAX_DEPTH, onProgress } = {}) {
    let start;
    try {
      start = new URL(startUrl);
    } catch {
      throw new Error('That does not look like a valid URL. Include https:// at the start.');
    }
    if (!/^https?:$/.test(start.protocol)) {
      throw new Error('Only http:// and https:// URLs can be crawled.');
    }

    const origin = start.origin;
    const queue = [{ url: this.normalizeUrl(start.toString(), origin), depth: 0 }];
    const seen = new Set(queue.map((q) => q.url));
    const pages = [];
    const errors = [];

    while (queue.length && pages.length < maxPages) {
      const { url, depth } = queue.shift();

      let html;
      try {
        html = await this.fetchPage(url);
      } catch (err) {
        // A block on the very first page means the whole crawl is impossible —
        // fail loudly rather than returning an empty "success".
        if (!pages.length && queue.length === 0) throw err;
        if (!err.skipped) errors.push({ url, error: err.message });
        continue;
      }

      const { title, text } = textExtractService.fromHtml(html);
      if (text && text.length >= 40) {
        pages.push({ url, title: title || url, text });
        if (onProgress) onProgress({ url, count: pages.length });
      }

      if (depth < maxDepth) {
        const $ = cheerio.load(html);
        $('a[href]').each((_, el) => {
          const next = this.normalizeUrl($(el).attr('href'), url);
          if (!next || seen.has(next)) return;
          // Same-origin only — never wander off the owner's site.
          if (!next.startsWith(origin)) return;
          if (SKIP_EXTENSIONS.test(new URL(next).pathname)) return;
          seen.add(next);
          queue.push({ url: next, depth: depth + 1 });
        });
      }

      // Don't hammer the owner's shared hosting.
      if (queue.length && pages.length < maxPages) {
        await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
      }
    }

    if (!pages.length) {
      throw new Error(
        errors.length
          ? `Crawled ${errors.length} URL(s) but found no readable text. First error: ${errors[0].error}`
          : 'No readable text found on that page.'
      );
    }

    return { pages, visited: seen.size, errors, origin };
  }
}

const crawlerService = new CrawlerService();
export default crawlerService;
