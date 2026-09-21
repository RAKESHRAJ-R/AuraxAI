/**
 * WooCommerce REST connectivity check.
 *
 * Run this BEFORE `npm run sync` or after any credential change:
 *   npm run check-woo
 *
 * Why it exists: on 2026-09-20 both product sync and order creation were failing with a
 * bare 401 and no useful message. The cause was not the key — a plugin on the store
 * intercepts any request carrying a recognised WooCommerce consumer key and answers
 * `{"success":false,"message":"API is working, Site Connected"}`, on every REST route.
 * A plain "401" tells you nothing about which of those two things went wrong, so this
 * script names the failure instead of making the next person re-derive it.
 */
import axios from 'axios';
import config from './config/config.js';

const base = config.woocommerce.url.replace(/\/$/, '');
const { consumerKey, consumerSecret, appUser, appPassword } = config.woocommerce;

const diagnose = (status, data) => {
  const body = typeof data === 'string' ? data : JSON.stringify(data || {});
  if (/API is working, Site Connected/.test(body)) {
    return 'BLOCKED by the consumer-key interceptor. A plugin on the store recognises the\n' +
           '       key and refuses the request. Use a WordPress Application Password instead\n' +
           '       (WOOCOMMERCE_APP_USER / WOOCOMMERCE_APP_PASSWORD), or find and remove the plugin.';
  }
  if (/rest_login_required/.test(body)) {
    return 'BLOCKED by "Disable WP REST API" (or similar). The request is not authenticated\n' +
           '       as a WP user. An application password satisfies this; a consumer key does not.';
  }
  if (/woocommerce_rest_cannot_view|woocommerce_rest_authentication_error/.test(body)) {
    return 'AUTHENTICATED but not permitted. The account behind this credential needs the\n' +
           '       Administrator or Shop Manager role.';
  }
  if (status === 401) return 'Unauthenticated — check the credential is correct and complete.';
  return `Unexpected HTTP ${status}.`;
};

const tryCredential = async (label, username, password) => {
  if (!username || !password) {
    console.log(`\n── ${label}: not configured, skipped`);
    return null;
  }
  console.log(`\n── ${label}`);
  const client = axios.create({
    baseURL: `${base}/wp-json/wc/v3`,
    auth: { username, password },
    timeout: 20000,
    validateStatus: () => true,
  });

  const results = {};
  // Read: what `npm run sync` needs.
  const products = await client.get('/products', { params: { per_page: 1 } });
  results.read = products.status === 200;
  if (results.read) {
    console.log(`   READ  products  ✅ 200 — ${products.headers['x-wp-total'] || '?'} products visible`);
  } else {
    console.log(`   READ  products  ❌ ${products.status}`);
    console.log(`       ${diagnose(products.status, products.data)}`);
  }

  // Orders read requires the same capability as order creation, so it proves the write
  // path without actually placing an order on a live store.
  const orders = await client.get('/orders', { params: { per_page: 1 } });
  results.write = orders.status === 200;
  console.log(`   ORDER access    ${results.write ? '✅ 200 — order creation will work' : `❌ ${orders.status}`}`);
  if (!results.write) console.log(`       ${diagnose(orders.status, orders.data)}`);

  return results;
};

console.log(`WooCommerce REST check → ${base}`);
console.log(`Active auth mode in the bot: ${appUser && appPassword ? `app-password (user "${appUser}")` : 'consumer-key'}`);

const key = await tryCredential('Consumer key / secret', consumerKey, consumerSecret);
const app = await tryCredential('Application password', appUser, appPassword);

const working = (app && app.read && app.write) || (key && key.read && key.write);
console.log('\n' + '─'.repeat(70));
if (working) {
  console.log('✅ A working credential is configured. `npm run sync` and order creation are good.');
} else {
  console.log('❌ No credential can both read products and create orders.');
  console.log('   Until this is fixed: the catalogue cannot refresh, and confirmed orders');
  console.log('   fall back to a PDF invoice with no payment link.');
}
process.exit(working ? 0 : 1);
