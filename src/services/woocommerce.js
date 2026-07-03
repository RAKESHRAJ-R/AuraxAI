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
   * Search local products cache based on queries using token-matching for natural language compatibility
   */
  searchProducts(query) {
    if (!query) return [];
    const products = this.getLocalProducts();
    const cleanQuery = query.toLowerCase().trim();

    // Parse price budget limit
    const priceLimit = this.parsePriceLimit(cleanQuery);

    // Detect if looking for cheapest/budget items
    const cheapKeywords = ['cheap', 'cheapest', 'lowest price', 'lowest cost', 'least price', 'less price', 'low price', 'minimum price', 'affordable', 'best deals', 'budget', 'lowest'];
    const isCheapSearch = cheapKeywords.some(kw => cleanQuery.includes(kw));

    // Detect if they specifically want adult/grown items, or want to exclude kids items
    const adultKeywords = ['adult', 'adults', 'grown ones', 'grown', 'men', 'mens', 'man', 'women', 'womens', 'fv', 'pv', 'player version', 'fan version', 'retro'];
    const isAdultSearch = adultKeywords.some(kw => cleanQuery.includes(kw));

    // Stop words to filter out from query tokens
    const stopWords = new Set([
      'do', 'you', 'have', 'in', 'size', 'jersey', 'jerseys', 'home', 'away', 'for', 
      'the', 'is', 'are', 'a', 'an', 'of', 'with', 'to', 'on', 'at', 'any', 'there', 
      'available', 'show', 'me', 'find', 'some', 'any', 'under', 'below', 'less', 
      'than', 'rs', 'rupees', '₹', 'give', 'suggest', 'underneath', 'within', 'budget', 
      'max', 'maximum', 'please', 'need', 'want', 'buy', 'order', 'purchase', 'i'
    ]);
    const queryTokens = cleanQuery.split(/[\s/,\-_?!.]+/).filter(t => t.length > 2 && !stopWords.has(t) && isNaN(t));

    // Handle pure budget queries (e.g. "jerseys under 700") with no specific keywords
    if (priceLimit !== null && queryTokens.length === 0) {
      let matches = products.filter(p => p.price && !isNaN(parseFloat(p.price)) && parseFloat(p.price) <= priceLimit);
      if (isAdultSearch) {
        matches = matches.filter(p => {
          const productName = p.name.toLowerCase();
          const hasKidsTerm = productName.includes('kids') || productName.includes('kid') || productName.includes('youth') || productName.includes('child');
          const hasKidsCategory = p.categories.some(cat => cat.toLowerCase().includes('kid') || cat.toLowerCase().includes('youth'));
          return !(hasKidsTerm || hasKidsCategory);
        });
      }
      return matches
        .sort((a, b) => parseFloat(a.price) - parseFloat(b.price))
        .slice(0, 10);
    }

    let scoredMatches = [];

    for (const p of products) {
      // If looking for adult/grown, filter out kids/youth products
      if (isAdultSearch) {
        const productName = p.name.toLowerCase();
        const hasKidsTerm = productName.includes('kids') || productName.includes('kid') || productName.includes('youth') || productName.includes('child');
        const hasKidsCategory = p.categories.some(cat => {
          const catName = cat.toLowerCase();
          return catName.includes('kids') || catName.includes('kid') || catName.includes('youth') || catName.includes('child');
        });
        if (hasKidsTerm || hasKidsCategory) {
          continue;
        }
      }

      let score = 0;
      const productNameLower = p.name.toLowerCase();

      // 1. Direct name substring match (highest priority)
      if (cleanQuery.length >= 3 && productNameLower.includes(cleanQuery)) {
        score += 15;
      }

      // 2. Query token matching with relevance weighting
      if (queryTokens.length > 0) {
        let matchedTokensCount = 0;
        for (const token of queryTokens) {
          if (productNameLower.includes(token)) {
            score += 5;
            matchedTokensCount++;
          } else if (p.categories.some(cat => cat.toLowerCase().includes(token))) {
            score += 2;
            matchedTokensCount++;
          }
        }
        // Bonus points if ALL significant query keywords matched
        if (matchedTokensCount === queryTokens.length) {
          score += 5;
        }
      }

      // 3. Category matching for clean query
      if (cleanQuery.length >= 3) {
        const categoryMatch = p.categories.some(cat => cleanQuery.includes(cat.toLowerCase()));
        if (categoryMatch) {
          score += 3;
        }
      }

      if (score > 0) {
        scoredMatches.push({ product: p, score });
      }
    }

    // Filter by price limit if present
    if (priceLimit !== null) {
      scoredMatches = scoredMatches.filter(m => m.product.price && !isNaN(parseFloat(m.product.price)) && parseFloat(m.product.price) <= priceLimit);
    }

    // Sort by relevance score in descending order
    scoredMatches.sort((a, b) => b.score - a.score);
    let finalMatches = scoredMatches.map(m => m.product);

    // If cheap search is requested:
    if (isCheapSearch) {
      let sourceList = finalMatches.length > 0 ? finalMatches : products;
      if (isAdultSearch) {
        sourceList = sourceList.filter(p => {
          const productName = p.name.toLowerCase();
          const hasKidsTerm = productName.includes('kids') || productName.includes('kid') || productName.includes('youth') || productName.includes('child');
          const hasKidsCategory = p.categories.some(cat => {
            const catName = cat.toLowerCase();
            return catName.includes('kids') || catName.includes('kid') || catName.includes('youth') || catName.includes('child');
          });
          return !(hasKidsTerm || hasKidsCategory);
        });
      }
      return sourceList
        .filter(p => p.price && !isNaN(parseFloat(p.price)))
        .sort((a, b) => parseFloat(a.price) - parseFloat(b.price))
        .slice(0, 10);
    }

    return finalMatches.slice(0, 10);
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
