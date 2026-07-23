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
    const { url, consumerKey, consumerSecret } = config.woocommerce;
    
    // Remove trailing slash if present
    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    
    // Setup Axios instance with WooCommerce credentials and basic auth
    this.client = axios.create({
      baseURL: `${baseUrl}/wp-json/wc/v3`,
      auth: {
        username: consumerKey,
        password: consumerSecret,
      },
      timeout: 15000,
    });
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
  searchProducts(query) {
    if (!query) return [];
    let products = this.getLocalProducts();

    // Deduplicate products by normalized name (fixes: duplicate Arsenal 26/27 Home)
    products = this.deduplicateProducts(products);

    const cleanQuery = query.toLowerCase().trim();
    const normalizedQuery = this.normalizeName(cleanQuery);

    // Parse price budget limit
    const priceLimit = this.parsePriceLimit(cleanQuery);

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
    // every downstream path — scored match, cheap, bestseller, budget, and fallback — inherits it.
    const kidsKeywords = ['kid', 'kids', 'child', 'children', 'boy', 'boys', 'girl', 'girls', 'baby', 'infant', 'junior'];
    const isKidsSearch = kidsKeywords.some(kw => new RegExp(`\\b${kw}\\b`).test(cleanQuery));
    products = products.filter(p => this.hasValidPrice(p));
    products = isKidsSearch
      ? products.filter(p => this.isKidsProduct(p))
      : products.filter(p => !this.isKidsProduct(p));

    // Stop words to filter out from query tokens
    const stopWords = new Set([
      'do', 'you', 'have', 'in', 'size', 'jersey', 'jerseys', 'home', 'away', 'for', 
      'the', 'is', 'are', 'a', 'an', 'of', 'with', 'to', 'on', 'at', 'any', 'there', 
      'available', 'show', 'me', 'find', 'some', 'any', 'under', 'below', 'less', 
      'than', 'rs', 'rupees', '₹', 'give', 'suggest', 'underneath', 'within', 'budget', 
      'max', 'maximum', 'please', 'need', 'want', 'buy', 'order', 'purchase', 'i'
    ]);
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

    // Handle pure budget queries (e.g. "jerseys under 700") with no specific keywords
    if (priceLimit !== null && queryTokens.length === 0) {
      let matches = products.filter(p => p.price && !isNaN(parseFloat(p.price)) && parseFloat(p.price) <= priceLimit);
      if (isAdultSearch) matches = matches.filter(p => !this.isKidsProduct(p));
      return matches
        .sort((a, b) => {
          const aS = a.stock_status === 'instock' ? 0 : 1;
          const bS = b.stock_status === 'instock' ? 0 : 1;
          if (aS !== bS) return aS - bS;
          return parseFloat(a.price) - parseFloat(b.price);
        })
        .slice(0, 10);
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
          } else if (p.categories.some(cat => cat.toLowerCase().includes(token) || this.normalizeName(cat).includes(token))) {
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
      // returning arbitrary products instead of properly falling back to getFallbackProducts.
      if (score > 0) {
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
    let finalMatches = scoredMatches.map(m => m.product);

    // If cheap search is requested, sort by price (in-stock first)
    if (isCheapSearch) {
      let sourceList = finalMatches.length > 0 ? finalMatches : products;
      if (isAdultSearch) sourceList = sourceList.filter(p => !this.isKidsProduct(p));
      return sourceList
        .filter(p => p.price && !isNaN(parseFloat(p.price)))
        .sort((a, b) => {
          const aS = a.stock_status === 'instock' ? 0 : 1;
          const bS = b.stock_status === 'instock' ? 0 : 1;
          if (aS !== bS) return aS - bS;
          return parseFloat(a.price) - parseFloat(b.price);
        })
        .slice(0, 10);
    }

    // If asking for best-sellers/popular items, sort by total_sales (synced from WooCommerce)
    if (isBestsellerSearch) {
      let sourceList = finalMatches.length > 0 ? finalMatches : products;
      if (isAdultSearch) sourceList = sourceList.filter(p => !this.isKidsProduct(p));
      return sourceList
        .filter(p => p.stock_status === 'instock')
        .sort((a, b) => (b.total_sales || 0) - (a.total_sales || 0))
        .slice(0, 10);
    }

    // Zero-result fallback: show cheapest in-stock products as suggestions
    if (finalMatches.length === 0) {
      return this.getFallbackProducts(products, isAdultSearch);
    }

    return finalMatches.slice(0, 10);
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
      return { success: true, orderId: order.id, paymentUrl };
    } catch (err) {
      console.error('[WooCommerce] createOrder failed:', err.response?.data || err.message);
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
