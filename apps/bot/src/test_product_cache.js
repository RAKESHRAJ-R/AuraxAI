/**
 * Product-cache safety — `npm run test-product-cache`.
 *
 * 2026-10-08: the live server's products_cache.json held [] — an auto-sync had saved an empty
 * answer from WooCommerce — and the bot had nothing to search, list or offer. These checks pin
 * the two guards: a sync never overwrites a good cache with an empty or gutted one, and an empty
 * cache file falls back to the committed seed. Stubbed: no network, nothing is written.
 */
import fs from 'fs';

const woo = (await import('./services/woocommerce.js')).default;

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); } else { failed++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
};

const realRead = woo._readCacheFile.bind(woo);
const realFetch = woo.fetchAllProducts.bind(woo);
const realWrite = fs.writeFileSync;
let writes = 0;
fs.writeFileSync = (...a) => { if (String(a[0]).includes('products_cache')) { writes++; return; } return realWrite(...a); };

const fake = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `JERSEY ${i + 1}`, price: '499', stock_status: 'instock', attributes: [], categories: [] }));

console.log('\n=== Product cache safety ===\n');

woo._readCacheFile = () => [];
check('an EMPTY cache file falls back to the seed', woo.getLocalProducts().length > 0, String(woo.getLocalProducts().length));

woo._readCacheFile = () => fake(136);
woo.fetchAllProducts = async () => [];
let err = null;
try { await woo.syncAndCacheProducts(); } catch (e) { err = e; }
check('a sync that returns 0 products throws and writes nothing', err && /0 products/.test(err.message) && writes === 0, err?.message);

woo.fetchAllProducts = async () => fake(10);
err = null;
try { await woo.syncAndCacheProducts(); } catch (e) { err = e; }
check('a sync that returns under half the catalogue is refused', err && /under half/.test(err.message) && writes === 0, err?.message);

process.env.WOO_SYNC_ALLOW_SHRINK = 'true';
err = null;
try { await woo.syncAndCacheProducts(); } catch (e) { err = e; }
check('…unless WOO_SYNC_ALLOW_SHRINK=true', !err && writes === 1, err?.message);
delete process.env.WOO_SYNC_ALLOW_SHRINK;

woo.fetchAllProducts = async () => fake(140);
err = null;
try { await woo.syncAndCacheProducts(); } catch (e) { err = e; }
check('a normal sync still saves', !err && writes === 2, err?.message);

woo._readCacheFile = realRead;
woo.fetchAllProducts = realFetch;
fs.writeFileSync = realWrite;
console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
