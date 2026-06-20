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
   * Search local products cache based on queries using token-matching for natural language compatibility
   */
  searchProducts(query) {
    if (!query) return [];
    const products = this.getLocalProducts();
    const cleanQuery = query.toLowerCase().trim();

    return products.filter((p) => {
      // 1. Check if the product name contains the query (e.g., query is "real madrid")
      if (p.name.toLowerCase().includes(cleanQuery)) {
        return true;
      }

      // 2. Check if the query contains any of the product's categories (e.g., query is "Do you have Arsenal jerseys?", category is "Arsenal")
      const categoryMatch = p.categories.some((cat) => cleanQuery.includes(cat.toLowerCase()));
      if (categoryMatch) {
        return true;
      }

      // 3. Token-based overlap: check if query contains significant tokens from the product name
      const stopWords = new Set(['do', 'you', 'have', 'in', 'size', 'jersey', 'jerseys', 'home', 'away', 'for', 'the', 'is', 'are', 'a', 'an', 'of', 'with', 'to', 'on', 'at']);
      const nameTokens = p.name.toLowerCase().split(/[\s/,\-_]+/);
      
      // Filter out short and generic stop-words
      const significantTokens = nameTokens.filter(token => token.length > 2 && !stopWords.has(token));
      
      if (significantTokens.length > 0) {
        // Match if the query contains any of the unique/significant tokens (e.g. "madrid", "united", "arsenal")
        const tokenMatch = significantTokens.some(token => cleanQuery.includes(token));
        if (tokenMatch) {
          return true;
        }
      }

      return false;
    });
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
