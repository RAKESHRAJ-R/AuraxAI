import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config, { validateConfig } from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, '../data');
const CACHE_FILE = path.join(CACHE_DIR, 'products_cache.json');

class WooCommerceService {
  constructor() {
    const { url, consumerKey, consumerSecret, appUser, appPassword } = config.woocommerce;

    // Remove trailing slash if present
    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    // An application password wins over the consumer key when both are configured.
    // See the comment on config.woocommerce.appUser: a plugin on the store intercepts
    // every request that carries a recognised consumer key and 401s it, which took out
    // product sync AND order creation. Same endpoints, different credential.
    const useAppPassword = Boolean(appUser && appPassword);
    this.authMode = useAppPassword ? 'app-password' : 'consumer-key';
    this.credentials = useAppPassword
      ? { username: appUser, password: appPassword }
      : { username: consumerKey, password: consumerSecret };

    console.log(`[WooCommerce] Auth mode: ${this.authMode}` +
      (useAppPassword ? ` (user "${appUser}")` : ''));

    // Setup Axios instance with WooCommerce credentials and basic auth
    this.client = axios.create({
      baseURL: `${baseUrl}/wp-json/wc/v3`,
      auth: this.credentials,
      timeout: 15000,
    });

    // null = not probed yet, true/false = last known answer. ai.js refuses to walk a customer
    // to checkout while this is false, escalating to a human instead. See checkOrderingHealth.
    this.orderingAvailable = null;
    this.orderingError = null;
    this.orderingCheckedAt = null;
  }

  /**
   * Can we actually create orders right now?
   *
   * Between 2026-08-07 and 2026-09-20 the answer was no, and nobody knew: a plugin on the
   * store 401'd every request carrying a consumer key, so `createOrder()` failed on every
   * single checkout for six weeks while the bot cheerfully told customers their order was
   * confirmed. This probe is what turns that into something visible on day one.
   *
   * It reads `/orders` rather than `/products`: order READ needs the same capability as order
   * WRITE, so a 200 here proves the credential can do the thing that matters, without placing
   * a live order to find out. Never throws.
   */
  async checkOrderingHealth({ quiet = false } = {}) {
    try {
      const res = await this.client.get('/orders', {
        params: { per_page: 1 },
        validateStatus: () => true,
      });
      const ok = res.status === 200;
      this.orderingAvailable = ok;
      this.orderingCheckedAt = Date.now();

      if (ok) {
        this.orderingError = null;
        if (!quiet) console.log(`[WooCommerce] Ordering health: OK (${this.authMode}).`);
      } else {
        const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});
        this.orderingError = `HTTP ${res.status} from wc/v3/orders: ${body.slice(0, 200)}`;
        console.error(`[WooCommerce] \u26A0\uFE0F ORDERING IS DOWN \u2014 ${this.orderingError}`);
        console.error('[WooCommerce]    Customers will be handed to a human at checkout. Run `npm run check-woo` to diagnose.');
      }
      return ok;
    } catch (err) {
      // A network blip is not proof the credential is dead. Leave the last known answer
      // alone rather than disabling checkout over one timeout.
      console.warn('[WooCommerce] Ordering health check could not complete:', err.message);
      return this.orderingAvailable;
    }
  }

  /**
   * Fetch all products from WooCommerce API (handles pagination)
   */
  async fetchAllProducts() {
    console.log('[WooCommerce] Starting to fetch products from WooCommerce API...');
    let allProducts = [];
    let page = 1;
    const perPage = 100; // WooCommerce API max per_page is 100
    let hasMore = true;

    while (hasMore) {
      try {
        console.log(`[WooCommerce] Fetching page ${page}...`);
        const response = await this.client.get('/products', {
          params: {
            page,
            per_page: perPage,
            status: 'publish', // Only fetch active/published products
          },
        });

        const products = response.data;
        console.log(`[WooCommerce] Retrieved ${products.length} products on page ${page}.`);

        if (products.length === 0) {
          hasMore = false;
        } else {
          allProducts = allProducts.concat(products);
          if (products.length < perPage) {
            hasMore = false; // Last page reached
          } else {
            page++;
          }
        }
      } catch (error) {
        console.error(`[WooCommerce] Error fetching products on page ${page}:`, error.message);
        if (error.response) {
          console.error(`[WooCommerce] Response details: ${JSON.stringify(error.response.data)}`);
        }
        throw error;
      }
    }

    console.log(`[WooCommerce] Total products fetched: ${allProducts.length}`);
    return allProducts;
  }

  /**
   * Map WooCommerce raw product details to a cleaner format
   */
  mapProducts(rawProducts) {
    return rawProducts.map((p) => {
      // Find sizes and colors if available in attributes
      const sizes = p.attributes?.find((attr) => attr.name.toLowerCase() === 'size' || attr.name.toLowerCase() === 'sizes')?.options || [];
      const colors = p.attributes?.find((attr) => attr.name.toLowerCase() === 'color' || attr.name.toLowerCase() === 'colors')?.options || [];

      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        price: p.price,
        regular_price: p.regular_price,
        sale_price: p.sale_price,
        permalink: p.permalink,
        status: p.status,
        stock_status: p.stock_status,
        stock_quantity: p.stock_quantity,
        description: p.description ? p.description.replace(/<[^>]*>/g, '').trim() : '', // strip HTML tags
        short_description: p.short_description ? p.short_description.replace(/<[^>]*>/g, '').trim() : '',
        images: p.images?.map((img) => img.src) || [],
        categories: p.categories?.map((cat) => cat.name) || [],
        sizes,
        colors,
        total_sales: parseInt(p.total_sales, 10) || 0,
      };
    });
  }

  /**
   * Sync and cache products locally in products_cache.json
   */
  async syncAndCacheProducts() {
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }

      const rawProducts = await this.fetchAllProducts();
      const cleanProducts = this.mapProducts(rawProducts);

      fs.writeFileSync(CACHE_FILE, JSON.stringify(cleanProducts, null, 2), 'utf-8');
      console.log(`[WooCommerce] Successfully cached ${cleanProducts.length} products to ${CACHE_FILE}`);
      return cleanProducts;
    } catch (error) {
      console.error('[WooCommerce] Sync failed:', error.message);
      throw error;
    }
  }

  /**
   * Read products from the local cache
   */
  getLocalProducts() {
    if (!fs.existsSync(CACHE_FILE)) {
      console.warn(`[WooCommerce] Cache file not found at ${CACHE_FILE}. Return empty array.`);
      return [];
    }
    try {
      const data = fs.readFileSync(CACHE_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.error('[WooCommerce] Error reading cache file:', error.message);
      return [];
    }
  }

  /**
   * Parse budget/price limit from query string
   */
  parsePriceLimit(query) {
    const cleanQuery = query.toLowerCase().trim();
    let priceLimit = null;
    const priceRegexes = [
      /(?:under|less than|below|within|max|maximum|budget of|budget)\s*(?:rs\.?|rupees|₹)?\s*(\d+)/i,
      /(?:rs\.?|rupees|₹)?\s*(\d+)\s*(?:or less|or below|max|maximum|budget)/i,
      /<\s*(\d+)/
    ];
    for (const regex of priceRegexes) {
      const match = cleanQuery.match(regex);
      if (match) {
        priceLimit = parseInt(match[1], 10);
        break;
      }
    }
    return priceLimit;
  }

  /**
   * Normalize product/category names using alias map for common misspellings and variations.
   * Fixes: BARZIL→BRAZIL, NETHERLAND→NETHERLANDS, DARGON→DRAGON, etc.
   */
  normalizeName(name) {
    const aliasMap = {
      '\\bnetherland\\b': 'netherlands',
      '\\bbarzil\\b': 'brazil',
      '\\bbaryen\\b': 'bayern munich',
      '\\bdargon\\b': 'dragon',
      '\\btraning\\b': 'training',
      '\\bmardona\\b': 'maradona',
      '\\bmardon\\b': 'maradona',
      '\\bfrans\\b': 'france',
      // Player nicknames → the name the catalog actually uses, so "cr7 away" finds
      // Ronaldo jerseys instead of falling back to random cheap items.
      '\\bcr7\\b': 'ronaldo',
      '\\bcristiano\\b': 'ronaldo',
    };
    let normalized = name.toLowerCase().trim();
    for (const [pattern, replacement] of Object.entries(aliasMap)) {
      normalized = normalized.replace(new RegExp(pattern, 'gi'), replacement);
    }
    return normalized;
  }

  /**
   * Deduplicate products by normalized name, keeping the first occurrence.
   * Fixes: Duplicate Arsenal Home 26/27 entries.
   */
  deduplicateProducts(products) {
    const seen = new Set();
    return products.filter(p => {
      const key = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Check if a product is kids/youth category
   */
  isKidsProduct(p) {
    const name = p.name.toLowerCase();
    if (name.includes('kids') || name.includes('kid') || name.includes('youth') || name.includes('child')) return true;
    return p.categories.some(cat => {
      const c = cat.toLowerCase();
      return c.includes('kids') || c.includes('kid') || c.includes('youth') || c.includes('child');
    });
  }

  // A product is only sellable/showable if it has a real positive price. Some Woo
  // products sync with price "0" or "" (variable products with no default price,
  // drafts, etc.) — showing "₹0" to a customer looks broken and can't be ordered,
  // so these are filtered out of every search path.
  hasValidPrice(p) {
    const price = parseFloat(p.price);
    return !isNaN(price) && price > 0;
  }

  /**
   * Get fallback products when search returns zero results.
   * Returns cheapest in-stock items as suggestions.
   */
  getFallbackProducts(products, isAdultSearch) {
    let candidates = [...products];
    if (isAdultSearch) candidates = candidates.filter(p => !this.isKidsProduct(p));
    return candidates
      .filter(p => p.stock_status === 'instock' && p.price && !isNaN(parseFloat(p.price)))
      .sort((a, b) => parseFloat(a.price) - parseFloat(b.price))
      .slice(0, 5);
  }

  /**
   * Search local products cache based on queries using token-matching for natural language compatibility.
   * Fixes implemented:
   *   - Name aliases (BARZIL→BRAZIL, NETHERLAND→NETHERLANDS, DARGON→DRAGON)
   *   - In-stock products ranked first, OOS penalized
   *   - Plural/singular normalization (trailing 's' stripped for matching)
   *   - Zero-result fallback showing cheapest in-stock items
   *   - Deduplication of identical products
   */
  /**
   * Pull season markers out of a string.
   *
   * Returns canonical two-digit forms, so "26/27", "2026/27" and "2026-2027" all compare
   * equal, plus the START years, which is what lets a product named "...2026..." satisfy a
   * "26/27" query without also dragging in "25-26".
   */
  parseSeasons(text) {
    const canonical = new Set();
    const startYears = new Set();
    const twoDigit = (y) => String(y).slice(-2).padStart(2, '0');
    const src = String(text || '');

    // Ranges first: 1996-97, 1998/99, 2026-2027, 26/27, 14-15.
    const ranges = [];
    const rangeRe = /\b((?:19|20)?\d{2})\s*[/\-]\s*((?:19|20)?\d{2})\b/g;
    let m;
    while ((m = rangeRe.exec(src)) !== null) {
      const a = twoDigit(m[1]);
      canonical.add(`${a}/${twoDigit(m[2])}`);
      startYears.add(a);
      ranges.push([m.index, m.index + m[0].length]);
    }

    // Then standalone four-digit years that were not already swallowed by a range.
    const yearRe = /\b((?:19|20)\d{2})\b/g;
    while ((m = yearRe.exec(src)) !== null) {
      if (ranges.some(([from, to]) => m.index >= from && m.index < to)) continue;
      const y = twoDigit(m[1]);
      canonical.add(y);
      startYears.add(y);
    }

    return { canonical, startYears, present: canonical.size > 0, label: [...canonical].join(', ') };
  }

  // Season parsing per product name is pure and repeated across every search, so memoise it.
  productSeasons(p) {
    if (!this._seasonCache) this._seasonCache = new Map();
    let hit = this._seasonCache.get(p.name);
    if (!hit) {
      hit = this.parseSeasons(p.name);
      this._seasonCache.set(p.name, hit);
    }
    return hit;
  }

  // Newest season on a product name, as a sortable four-digit year. Two-digit years are read
  // as 19xx from 90 up and 20xx below it, which covers a catalogue running 1995 to 2026.
  seasonRecency(p) {
    const { startYears } = this.productSeasons(p);
    let newest = 0;
    for (const y of startYears) {
      const n = parseInt(y, 10);
      const full = n >= 90 ? 1900 + n : 2000 + n;
      if (full > newest) newest = full;
    }
    return newest;
  }

  seasonMatches(queried, product) {
    for (const c of queried.canonical) if (product.canonical.has(c)) return true;
    for (const y of queried.startYears) if (product.startYears.has(y)) return true;
    return false;
  }

  // Player Version / Fan Version. Nothing PUBLISHED carries either marker today (all 139 PV
  // and 111 FV products are drafts), so in practice this constraint currently goes unmatched
  // and the reply says so -- which is the honest answer, and the point of the exercise.
  parseVersion(text) {
    const t = String(text || '').toLowerCase();
    if (/(player\s*version|player\s*edition|\bpv\b)/.test(t)) return 'player';
    if (/(fan\s*version|fan\s*edition|\bfv\b)/.test(t)) return 'fan';
    return null;
  }

  productVersion(p) {
    const n = p.name.toLowerCase();
    if (/\(pv\)|player\s*version|\bpv\b/.test(n)) return 'player';
    if (/\(fv\)|fan\s*version|\bfv\b/.test(n)) return 'fan';
    return null;
  }

  versionLabel(v) {
    return v === 'player' ? 'Player Version' : 'Fan Version';
  }

  // The WORDS of a product's categories, memoised. Matching a token against the raw category
  // string with includes() meant any short token could hit the middle of a longer word --
  // "bro" inside "Signature Embroidery" being the one that got caught in testing.
  categoryWords(p) {
    if (!this._categoryWordCache) this._categoryWordCache = new Map();
    const key = (p.categories || []).join('|');
    let hit = this._categoryWordCache.get(key);
    if (!hit) {
      hit = new Set();
      for (const cat of p.categories || []) {
        const lower = cat.toLowerCase();
        for (const w of lower.split(/[^a-z0-9]+/)) if (w) hit.add(w);
        for (const w of this.normalizeName(lower).split(/[^a-z0-9]+/)) if (w) hit.add(w);
      }
      this._categoryWordCache.set(key, hit);
    }
    return hit;
  }

  // Every word appearing in a product name or category, so we can tell a real team/player
  // token from chatter. Built once per cache load.
  catalogueVocabulary() {
    if (this._vocabulary) return this._vocabulary;
    const set = new Set();
    for (const p of this.getLocalProducts()) {
      const text = `${p.name} ${(p.categories || []).join(' ')}`.toLowerCase();
      for (const w of text.split(/[^a-z0-9]+/)) {
        if (w.length > 2) set.add(w);
      }
    }
    this._vocabulary = set;
    return set;
  }

  /**
   * The SUBJECT of a query -- the team/player part, with seasons, versions, sizes and filler
   * stripped out. Returns null when the query is nothing but constraints.
   *
   * The agent uses this to carry context across turns: a follow-up of "player version 26/27"
   * on its own is meaningless, and searching it verbatim is how the 2026-09-20 tester ended up
   * being shown a CSK shirt after asking about Real Madrid.
   */
  extractSubject(query) {
    const t = String(query || '').toLowerCase();
    if (!t) return null;
    const drop = new Set([
      'player', 'players', 'fan', 'fans', 'version', 'edition', 'kit', 'kits', 'jersey',
      'jerseys', 'shirt', 'shirts', 'size', 'sizes', 'all', 'the', 'and', 'any', 'have',
      'you', 'do', 'bro', 'sir', 'anna', 'iruka', 'irukka', 'irukku', 'venum', 'show',
      'give', 'send', 'want', 'need', 'price', 'cost', 'stock', 'available', 'new', 'latest',
      'more', 'other', 'others', 'options', 'option', 'full', 'sleeve', 'half', 'home', 'away',
    ]);
    const tokens = t.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !drop.has(w) && isNaN(w));
    if (tokens.length === 0) return null;
    // Keep only words the catalogue actually knows, so stray chatter never becomes a subject.
    const vocabulary = this.catalogueVocabulary();
    const kept = tokens.filter(w => vocabulary.has(w) || vocabulary.has(this.normalizeName(w)));
    return kept.length > 0 ? kept.join(' ') : null;
  }

  /**
   * Does this text look like it is asking about a product at all?
   *
   * Used by the agent to refuse to answer "could you be more specific?" without having
   * searched first -- one of the 2026-09-20 tester reviews was "Ac Milan jerseys iruka bro?"
   * being met with a clarification request when AC Milan is very much in the catalogue.
   */
  looksLikeProductQuery(text) {
    const t = String(text || '').toLowerCase();
    if (t.length < 3) return false;
    if (/\b(jersey|jerseys|kit|kits|tshirt|t-shirt|shirt)\b/.test(t)) return true;
    const tokens = t.split(/[\s/,\-_?!.]+/).filter(x => x.length > 2);
    if (tokens.length === 0) return false;
    const vocabulary = this.catalogueVocabulary();
    return tokens.some(tok => vocabulary.has(tok) || vocabulary.has(this.normalizeName(tok)));
  }

  /**
   * Search local products cache based on queries using token-matching for natural language compatibility.
   * Fixes implemented:
   *   - Name aliases (BARZIL→BRAZIL, NETHERLAND→NETHERLANDS, DARGON→DRAGON)
   *   - In-stock products ranked first, OOS penalized
   *   - Plural/singular normalization (trailing 's' stripped for matching)
   *   - Deduplication of identical products
   *   - Season and Player/Fan-Version constraints applied as FILTERS (2026-09-21)
   *
   * Returns { products, suggestions, matchQuality, constraints, unmatched }:
   *   matchQuality 'exact'   -- real matches, every stated constraint satisfied
   *                'partial' -- real matches, but a constraint could not be met
   *                'none'    -- nothing matched; `suggestions` holds browse-anyway items
   *
   * `suggestions` is deliberately a SEPARATE field from `products`. Until 2026-09-21 the
   * cheapest five in-stock items were returned in the products slot on a zero-result search
   * and the caller announced them as "Found products" -- which is how "Player version 26/27"
   * came back as a CSK 2025 shirt at ₹350.
   */
  searchProductsDetailed(query) {
    const empty = {
      products: [], suggestions: [], matchQuality: 'none',
      constraints: { seasons: null, version: null }, unmatched: [],
    };
    if (!query) return empty;

    let products = this.getLocalProducts();

    // Deduplicate products by normalized name (fixes: duplicate Arsenal 26/27 Home)
    products = this.deduplicateProducts(products);

    const cleanQuery = query.toLowerCase().trim();
    const normalizedQuery = this.normalizeName(cleanQuery);

    // Parse price budget limit
    const priceLimit = this.parsePriceLimit(cleanQuery);

    // Constraints the customer stated explicitly. These are filters, not scoring hints --
    // a 26/27 request is not satisfied by a 14-15 shirt no matter how well the name matches.
    const querySeasons = this.parseSeasons(cleanQuery);
    const queryVersion = this.parseVersion(cleanQuery);

    // Detect if looking for cheapest/budget items
    const cheapKeywords = ['cheap', 'cheapest', 'lowest price', 'lowest cost', 'least price', 'less price', 'low price', 'minimum price', 'affordable', 'best deals', 'budget', 'lowest'];
    const isCheapSearch = cheapKeywords.some(kw => cleanQuery.includes(kw));

    // Detect if looking for popular/best-selling items (uses total_sales synced from WooCommerce)
    const bestsellerKeywords = ['best selling', 'bestseller', 'best seller', 'top selling', 'top seller', 'most sold', 'popular', 'trending', 'hot selling', 'best products'];
    const isBestsellerSearch = bestsellerKeywords.some(kw => cleanQuery.includes(kw));

    // Detect if they specifically want adult/grown items, or want to exclude kids items
    const adultKeywords = ['adult', 'adults', 'grown ones', 'grown', 'men', 'mens', 'man', 'women', 'womens', 'fv', 'pv', 'player version', 'fan version', 'retro'];
    const isAdultSearch = adultKeywords.some(kw => cleanQuery.includes(kw));

    // Kids products are shown ONLY when the customer explicitly asks for kids/child sizes.
    // Otherwise they're hidden — previously they were only hidden when the query literally
    // said "adult", so a normal "ronaldo"/"cr7 away" search surfaced (KIDS) kits and confused
    // adult buyers. This filter (plus the ₹0 filter) is applied ONCE to the source list so
    // every downstream path — scored match, cheap, bestseller and budget — inherits it.
    const kidsKeywords = ['kid', 'kids', 'child', 'children', 'boy', 'boys', 'girl', 'girls', 'baby', 'infant', 'junior'];
    const isKidsSearch = kidsKeywords.some(kw => new RegExp(`\\b${kw}\\b`).test(cleanQuery));
    products = products.filter(p => this.hasValidPrice(p));
    products = isKidsSearch
      ? products.filter(p => this.isKidsProduct(p))
      : products.filter(p => !this.isKidsProduct(p));

    const suggestionsFor = () => this.getFallbackProducts(products, isAdultSearch);
    const constraints = {
      seasons: querySeasons.present ? querySeasons.label : null,
      version: queryVersion,
    };

    // Stop words to filter out from query tokens. 'version'/'edition'/'kit' are here because
    // they are carried by the version constraint above, not by name matching.
    const stopWords = new Set([
      'do', 'you', 'have', 'in', 'size', 'jersey', 'jerseys', 'home', 'away', 'for',
      'the', 'is', 'are', 'a', 'an', 'of', 'with', 'to', 'on', 'at', 'any', 'there',
      'available', 'show', 'me', 'find', 'some', 'any', 'under', 'below', 'less',
      'than', 'rs', 'rupees', '₹', 'give', 'suggest', 'underneath', 'within', 'budget',
      'max', 'maximum', 'please', 'need', 'want', 'buy', 'order', 'purchase', 'i',
      'version', 'edition', 'kit', 'kits', 'all', 'and',
      // Tanglish filler. Without these, "Ac Milan jerseys iruka bro" searched on 'bro' as
      // well as 'milan' -- and 'bro' is a substring of the category "Signature Embroidery",
      // so a chunk of the catalogue scored on a word that carries no meaning at all.
      'bro', 'anna', 'akka', 'boss', 'machi', 'sir', 'madam', 'thanks', 'hello',
      'iruka', 'irukka', 'irukku', 'irukkinga', 'venum', 'venuma', 'sollunga',
      'pannunga', 'panna', 'enna', 'ethu', 'idhu', 'adhu', 'vera', 'konjam'
    ]);
    if (queryVersion) {
      stopWords.add('player');
      stopWords.add('fan');
      stopWords.add('pv');
      stopWords.add('fv');
    }
    const queryTokens = cleanQuery.split(/[\s/,\-_?!.]+/)
      .filter(t => t.length > 2 && !stopWords.has(t) && isNaN(t));

    // Generate normalized + singular variants of each token for fuzzy matching
    const normalizedTokens = queryTokens.map(t => this.normalizeName(t));
    // Strip trailing 's' for plural → singular matching (e.g. netherlands → netherland)
    const singularTokens = queryTokens.map(t => t.endsWith('s') ? t.slice(0, -1) : t);
    const allTokenVariants = [...new Set([...queryTokens, ...normalizedTokens, ...singularTokens])];

    // Stock weight: +8 for in-stock, -5 for OOS, +2 for backorder
    function stockWeight(status) {
      if (status === 'instock') return 8;
      if (status === 'outofstock') return -5;
      if (status === 'onbackorder') return 2;
      return 0;
    }

    // Sort helper: high score first, then in-stock first
    function sortByScoreAndStock(a, b) {
      if (b.score !== a.score) return b.score - a.score;
      const aStock = a.product.stock_status === 'instock' ? 0 : 1;
      const bStock = b.product.stock_status === 'instock' ? 0 : 1;
      return aStock - bStock;
    }

    /**
     * Apply the stated constraints to an already-relevance-ranked list.
     *
     * A constraint that NOTHING satisfies is recorded in `unmatched` rather than emptying the
     * result: the customer asked for a Real Madrid 26/27 and we have Real Madrid, just not
     * that season. Showing those while saying plainly that the season is unavailable beats
     * both silently substituting a 14-15 shirt and a bare "no results".
     */
    const applyConstraints = (list) => {
      const unmatched = [];
      let out = list;
      if (querySeasons.present) {
        const hit = out.filter(p => this.seasonMatches(querySeasons, this.productSeasons(p)));
        if (hit.length > 0) {
          out = hit;
        } else {
          unmatched.push(querySeasons.label);
          // They asked for a season we do not stock. Lead with the NEWEST shirts we do have
          // rather than whatever relevance happened to rank first -- the 2026-09-20 review was
          // a customer asking for 26/27 and being shown a 14-15 at the top of the list.
          out = out.slice().sort((a, b) => this.seasonRecency(b) - this.seasonRecency(a));
        }
      }
      if (queryVersion) {
        const hit = out.filter(p => this.productVersion(p) === queryVersion);
        if (hit.length > 0) out = hit;
        else unmatched.push(this.versionLabel(queryVersion));
      }
      return { list: out, unmatched };
    };

    const finish = (list, { bareConstraint = false } = {}) => {
      if (list.length === 0) {
        return { products: [], suggestions: suggestionsFor(), matchQuality: 'none', constraints, unmatched: [] };
      }
      const { list: filtered, unmatched } = applyConstraints(list);
      // On a constraints-only query the candidate list is the whole catalogue, so if no
      // constraint actually narrowed it we have matched nothing at all — returning 136
      // unrelated shirts as a "partial match" would be the old fallback bug in a new coat.
      if (bareConstraint && filtered.length === list.length) {
        return { products: [], suggestions: suggestionsFor(), matchQuality: 'none', constraints, unmatched };
      }
      return {
        products: filtered.slice(0, 10),
        suggestions: [],
        matchQuality: unmatched.length > 0 ? 'partial' : 'exact',
        constraints,
        unmatched,
      };
    };

    // Constraints with nothing else to go on: "any 26/27 kits?", "player version available?"
    if (queryTokens.length === 0 && (querySeasons.present || queryVersion) && priceLimit === null) {
      return finish(
        products.slice().sort((a, b) => {
          const aS = a.stock_status === 'instock' ? 0 : 1;
          const bS = b.stock_status === 'instock' ? 0 : 1;
          if (aS !== bS) return aS - bS;
          return (b.total_sales || 0) - (a.total_sales || 0);
        }),
        { bareConstraint: true }
      );
    }

    // Handle pure budget queries (e.g. "jerseys under 700") with no specific keywords
    if (priceLimit !== null && queryTokens.length === 0 && !querySeasons.present && !queryVersion) {
      let matches = products.filter(p => p.price && !isNaN(parseFloat(p.price)) && parseFloat(p.price) <= priceLimit);
      if (isAdultSearch) matches = matches.filter(p => !this.isKidsProduct(p));
      return finish(matches.sort((a, b) => {
        const aS = a.stock_status === 'instock' ? 0 : 1;
        const bS = b.stock_status === 'instock' ? 0 : 1;
        if (aS !== bS) return aS - bS;
        return parseFloat(a.price) - parseFloat(b.price);
      }));
    }

    let scoredMatches = [];

    for (const p of products) {
      // If looking for adult/grown, filter out kids/youth products
      if (isAdultSearch && this.isKidsProduct(p)) continue;

      let score = 0;
      const productNameLower = p.name.toLowerCase();
      const normalizedProductName = this.normalizeName(productNameLower);

      // 1. Direct name substring match (highest priority) — check both raw and normalized
      if (cleanQuery.length >= 3) {
        if (productNameLower.includes(cleanQuery) || normalizedProductName.includes(normalizedQuery)) {
          score += 15;
        }
      }

      // 2. Query token matching with all variants (raw, normalized, singular)
      if (allTokenVariants.length > 0) {
        let matchedTokensCount = 0;
        for (const token of allTokenVariants) {
          if (productNameLower.includes(token) || normalizedProductName.includes(token)) {
            score += 5;
            matchedTokensCount++;
          } else if (this.categoryWords(p).has(token)) {
            score += 2;
            matchedTokensCount++;
          }
        }
        // Bonus points if ALL original query tokens matched
        if (matchedTokensCount >= queryTokens.length) {
          score += 5;
        }
      }

      // 3. Category matching for clean query (check both raw and normalized)
      if (cleanQuery.length >= 3) {
        const categoryMatch = p.categories.some(cat =>
          cleanQuery.includes(cat.toLowerCase()) || normalizedQuery.includes(this.normalizeName(cat))
        );
        if (categoryMatch) score += 3;
      }

      // Only a product with genuine keyword/category relevance counts as a match — stock
      // status is a tiebreaker among relevant products, not a qualifier on its own. Without
      // this guard, stockWeight's unconditional +8 for in-stock items made EVERY in-stock
      // product (almost the whole catalog) "match" any query with zero real keyword overlap,
      // returning arbitrary products instead of falling back cleanly.
      if (score > 0) {
        // A season the customer named is worth real points, so that among equally-relevant
        // shirts the right year ranks first. Strictly a TIEBREAKER among products that already
        // matched on name or category — adding it before the gate above would let any shirt
        // from that year qualify for a team it has nothing to do with.
        if (querySeasons.present && this.seasonMatches(querySeasons, this.productSeasons(p))) {
          score += 6;
        }
        score += stockWeight(p.stock_status);
        scoredMatches.push({ product: p, score });
      }
    }

    // Filter by price limit if present
    if (priceLimit !== null) {
      scoredMatches = scoredMatches.filter(m => m.product.price && !isNaN(parseFloat(m.product.price)) && parseFloat(m.product.price) <= priceLimit);
    }

    // Sort by score descending, then in-stock first
    scoredMatches.sort(sortByScoreAndStock);
    const finalMatches = scoredMatches.map(m => m.product);

    // If cheap search is requested, sort by price (in-stock first)
    if (isCheapSearch) {
      let sourceList = finalMatches.length > 0 ? finalMatches : products;
      if (isAdultSearch) sourceList = sourceList.filter(p => !this.isKidsProduct(p));
      return finish(sourceList
        .filter(p => p.price && !isNaN(parseFloat(p.price)))
        .sort((a, b) => {
          const aS = a.stock_status === 'instock' ? 0 : 1;
          const bS = b.stock_status === 'instock' ? 0 : 1;
          if (aS !== bS) return aS - bS;
          return parseFloat(a.price) - parseFloat(b.price);
        }));
    }

    // If asking for best-sellers/popular items, sort by total_sales (synced from WooCommerce)
    if (isBestsellerSearch) {
      let sourceList = finalMatches.length > 0 ? finalMatches : products;
      if (isAdultSearch) sourceList = sourceList.filter(p => !this.isKidsProduct(p));
      return finish(sourceList
        .filter(p => p.stock_status === 'instock')
        .sort((a, b) => (b.total_sales || 0) - (a.total_sales || 0)));
    }

    return finish(finalMatches);
  }

  /**
   * Back-compatible array API. Returns ONLY genuine matches -- an empty array when there are
   * none, never the cheapest-in-stock filler, which callers used to present as real results.
   * Use searchProductsDetailed when you need to tell the customer what could not be matched.
   */
  searchProducts(query) {
    return this.searchProductsDetailed(query).products;
  }

  parseAddressDetails(addressDetails) {
    const nameParts = (addressDetails.name || 'Customer').trim().split(/\s+/);
    return {
      first_name: nameParts[0] || 'Customer',
      last_name: nameParts.slice(1).join(' ') || '',
      phone: (addressDetails.phone || '').replace(/\D/g, '').slice(-10),
      address_1: addressDetails.address || '',
      postcode: (addressDetails.pincode || '').replace(/\D/g, ''),
      country: 'IN',
    };
  }

  async createOrder(cart, addressDetails, customerName) {
    const billing = this.parseAddressDetails(addressDetails);

    // Fill last name from customerName if not in addressDetails
    if (customerName && !billing.last_name) {
      const parts = customerName.trim().split(/\s+/);
      if (parts.length > 1) billing.last_name = parts.slice(1).join(' ');
    }

    const lineItems = cart.map(item => ({
      product_id: item.productId,
      quantity: item.qty,
      meta_data: item.size ? [{ key: 'Size', value: item.size }] : []
    }));

    const sizeNote = cart.map(i => `${i.name} – Size: ${i.size || 'N/A'}`).join('; ');

    try {
      const response = await this.client.post('/orders', {
        status: 'pending',
        billing,
        shipping: billing,
        line_items: lineItems,
        customer_note: `WhatsApp Bot Order | ${sizeNote}`
      });

      const order = response.data;
      const baseUrl = config.woocommerce.url.replace(/\/$/, '');
      const paymentUrl = `${baseUrl}/checkout/order-pay/${order.id}/?pay_for_order=true&key=${order.order_key}`;

      console.log(`[WooCommerce] Order #${order.id} created. Payment URL: ${paymentUrl}`);
      this.orderingAvailable = true;
      this.orderingError = null;
      this.orderingCheckedAt = Date.now();
      return { success: true, orderId: order.id, paymentUrl };
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.message || err.message;
      console.error('[WooCommerce] createOrder failed:', err.response?.data || err.message);
      // Only an auth/permission rejection means ordering is genuinely unavailable. A timeout
      // or a 500 is transient, and flipping the flag on one of those would send every
      // subsequent customer to a human for no reason.
      if (status === 401 || status === 403) {
        this.orderingAvailable = false;
        this.orderingError = `HTTP ${status} creating an order: ${detail}`;
        this.orderingCheckedAt = Date.now();
      }
      return { success: false, error: detail, status };
    }
  }

  // Human-friendly label for a raw WooCommerce order status. Kept deliberately vague on
  // fulfilment ("being prepared" / "on its way") because WooCommerce core has no real
  // carrier tracking — we never claim a delivery date we can't back up.
  orderStatusLabel(status) {
    const map = {
      pending: 'Order placed — awaiting payment',
      'on-hold': 'On hold — awaiting payment confirmation',
      processing: 'Confirmed — being packed & prepared for dispatch',
      completed: 'Shipped / fulfilled',
      cancelled: 'Cancelled',
      refunded: 'Refunded',
      failed: 'Payment failed',
      trash: 'Cancelled',
    };
    return map[status] || status;
  }

  // Scan order meta for a tracking number/URL left by common WooCommerce shipment-tracking
  // plugins. Returns nulls if none present — we NEVER fabricate a tracking number.
  extractTracking(order) {
    const meta = order.meta_data || [];
    const get = (keys) => {
      const hit = meta.find(m => keys.includes((m.key || '').toLowerCase()));
      return hit && hit.value ? String(hit.value) : null;
    };
    return {
      trackingNumber: get(['_tracking_number', 'tracking_number', '_wc_shipment_tracking_items']),
      trackingUrl: get(['_tracking_url', 'tracking_url']),
    };
  }

  /**
   * Fetch a single order by its numeric ID for the support/tracking agent.
   * Returns a SANITISED, minimal view — plus billingPhone so the caller can verify the
   * requester actually owns the order before revealing name/address details. Never throws.
   */
  async getOrder(orderId) {
    const id = String(orderId || '').replace(/\D/g, '');
    if (!id) return { success: false, notFound: true };
    try {
      const { data: order } = await this.client.get(`/orders/${id}`);
      const items = (order.line_items || []).map(li => {
        const sizeMeta = (li.meta_data || []).find(m => /size/i.test(m.key || ''));
        return { name: li.name, qty: li.quantity, size: sizeMeta ? String(sizeMeta.value) : null };
      });
      const { trackingNumber, trackingUrl } = this.extractTracking(order);
      return {
        success: true,
        order: {
          id: order.id,
          status: order.status,
          statusLabel: this.orderStatusLabel(order.status),
          dateCreated: order.date_created,
          total: order.total,
          currency: order.currency || 'INR',
          items,
          customerName: `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim(),
          billingPhone: (order.billing?.phone || '').replace(/\D/g, '').slice(-10),
          city: order.billing?.city || order.shipping?.city || '',
          trackingNumber,
          trackingUrl,
        }
      };
    } catch (err) {
      const code = err.response?.status;
      if (code === 404) return { success: false, notFound: true };
      console.error(`[WooCommerce] getOrder(${id}) failed:`, err.response?.data?.message || err.message);
      return { success: false, error: err.message };
    }
  }
}

const woocommerceService = new WooCommerceService();
export default woocommerceService;

// Execute sync directly if run from CLI
if (process.argv[1] === fileURLToPath(import.meta.url) || process.argv.includes('--sync')) {
  if (validateConfig()) {
    woocommerceService.syncAndCacheProducts()
      .then(() => console.log('[WooCommerce Sync] Complete!'))
      .catch((err) => {
        console.error('[WooCommerce Sync] Failed:', err);
        process.exit(1);
      });
  } else {
    console.error('[WooCommerce Sync] Incomplete configuration in env. Cannot sync.');
    process.exit(1);
  }
}
