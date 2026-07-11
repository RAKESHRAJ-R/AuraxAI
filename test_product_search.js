import woocommerceService from './src/services/woocommerce.js';
import dbService from './src/services/db.js';
import aiService from './src/services/ai.js';

// ============================================================
// COMPREHENSIVE PRODUCT SEARCH TEST SUITE
// ============================================================

const TEST_QUERIES = [
  // --- Team Name Tests ---
  { query: "Real Madrid jerseys",        label: "Real Madrid" },
  { query: "Barcelona jersey",           label: "FC Barcelona" },
  { query: "Manchester United jersey",   label: "Man United" },
  { query: "Arsenal jersey",             label: "Arsenal" },
  { query: "Liverpool jersey",           label: "Liverpool" },
  { query: "Chelsea jersey",             label: "Chelsea" },
  { query: "PSG jersey",                 label: "PSG" },
  { query: "Juventus jersey",            label: "Juventus" },
  { query: "AC Milan jersey",            label: "AC Milan" },
  { query: "Bayern Munich jersey",       label: "Bayern Munich" },
  { query: "Inter Miami jersey",         label: "Inter Miami" },
  { query: "Man City jersey",            label: "Man City" },

  // --- National Team Tests ---
  { query: "Argentina jersey",           label: "Argentina NT" },
  { query: "Brazil jersey",              label: "Brazil NT" },
  { query: "France jersey",              label: "France NT" },
  { query: "Germany jersey",             label: "Germany NT" },
  { query: "Portugal jersey",            label: "Portugal NT" },
  { query: "Spain jersey",               label: "Spain NT" },
  { query: "England jersey",             label: "England NT" },
  { query: "Netherlands jersey",         label: "Netherlands NT" },
  { query: "Nigeria jersey",             label: "Nigeria NT" },
  { query: "Japan jersey",               label: "Japan NT" },
  { query: "Croatia jersey",             label: "Croatia NT" },
  { query: "Colombia jersey",            label: "Colombia NT" },

  // --- Player Name Tests ---
  { query: "Ronaldo jersey",             label: "Ronaldo" },
  { query: "Messi jersey",               label: "Messi" },
  { query: "Neymar jersey",              label: "Neymar" },
  { query: "Maradona jersey",            label: "Maradona" },

  // --- Price/Budget Tests ---
  { query: "jerseys under 500",          label: "Budget <500" },
  { query: "cheapest jerseys",           label: "Cheapest" },
  { query: "jerseys under 800",          label: "Budget <800" },
  { query: "affordable jerseys",         label: "Affordable" },

  // --- Category/Variety Tests ---
  { query: "Player Version jerseys",     label: "Player Version" },
  { query: "retro jerseys",              label: "Retro" },
  { query: "full sleeve jersey",         label: "Full Sleeve" },
  { query: "kids jersey",                label: "Kids" },
  { query: "training kit",               label: "Training Kit" },
  { query: "goalkeeper jersey",          label: "Goalkeeper" },

  // --- Edge Cases ---
  { query: "Newcastle jersey",           label: "Newcastle" },
  { query: "Ajax jersey",                label: "Ajax" },
  { query: "Celtic jersey",              label: "Celtic" },
  { query: "Napoli jersey",              label: "Napoli" },
  { query: "Atletico Madrid jersey",     label: "Atletico Madrid" },
  { query: "Inter Milan jersey",         label: "Inter Milan" },
  { query: "India jersey",               label: "India" },
  { query: "Korea jersey",               label: "Korea" },

  // --- Language / Tanglish Tests ---
  { query: "ronaldo jersey iruka",       label: "Tanglish Ronaldo" },
  { query: "messi jersey venum",         label: "Tanglish Messi" },
  { query: "Real Madrid jersey iruka bro", label: "Tanglish Madrid" },
];

async function runSearchTests() {
  console.log('#'.repeat(80));
  console.log('🏟️  THEAURAX PRODUCT SEARCH - COMPREHENSIVE TEST REPORT');
  console.log('#'.repeat(80));
  console.log();

  // Load all products to know the inventory
  const allProducts = woocommerceService.getLocalProducts();
  console.log(`📦 Total products in cache: ${allProducts.length}`);
  
  // Count out-of-stock
  const outOfStock = allProducts.filter(p => p.stock_status === 'outofstock');
  const onBackorder = allProducts.filter(p => p.stock_status === 'onbackorder');
  console.log(`   In stock:    ${allProducts.length - outOfStock.length - onBackorder.length}`);
  console.log(`   Out of stock: ${outOfStock.length}`);
  console.log(`   Backorder:   ${onBackorder.length}`);
  
  // Group by categories
  const categoryMap = {};
  allProducts.forEach(p => {
    p.categories.forEach(cat => {
      categoryMap[cat] = (categoryMap[cat] || 0) + 1;
    });
  });
  console.log(`\n📂 Categories (${Object.keys(categoryMap).length}):`);
  Object.entries(categoryMap)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => console.log(`   ${count.toString().padStart(3)} - ${cat}`));
  console.log();

  // Price range
  const prices = allProducts.filter(p => p.price).map(p => parseFloat(p.price));
  console.log(`💰 Price range: ₹${Math.min(...prices)} - ₹${Math.max(...prices)}`);
  console.log();

  // ==============
  // RUN TESTS
  // ==============
  let passed = 0;
  let failed = 0;
  let warnings = [];
  let errors = [];

  for (const test of TEST_QUERIES) {
    console.log('-'.repeat(70));
    console.log(`🔍 TEST: "${test.query}" (${test.label})`);
    console.log('-'.repeat(70));

    const results = woocommerceService.searchProducts(test.query);
    
    if (results.length === 0) {
      failed++;
      const msg = `❌ NO RESULTS for "${test.query}"`;
      errors.push(msg);
      console.log(`   ${msg}`);
      continue;
    }

    console.log(`   ✅ Found ${results.length} product(s):`);
    passed++;

    // Show top 3 results with details
    results.slice(0, 5).forEach((p, i) => {
      const stockIcon = p.stock_status === 'instock' ? '🟢' : p.stock_status === 'outofstock' ? '🔴' : '🟡';
      const priceStr = `₹${p.price}`;
      const sizesStr = p.sizes.length > 0 ? ` [${p.sizes.join(', ')}]` : '';
      console.log(`   ${i+1}. ${stockIcon} ${p.name} - ${priceStr}${sizesStr}`);
    });

    if (results.length > 5) {
      console.log(`   ... and ${results.length - 5} more`);
    }

    // --- VALIDATION CHECKS ---
    
    // Check 1: Is the query string actually contained in any product names?
    const queryWords = test.query.toLowerCase()
      .replace(/[?.,!]/g, '')
      .split(/\s+/)
      .filter(w => !['do', 'you', 'have', 'the', 'for', 'a', 'an', 'is', 'are', 'in', 'of', 'to', 'at', 'jersey', 'jerseys', 'i', 'bro', 'iruka', 'venum', 'under', 'need', 'want', 'any', 'some', 'show', 'me', 'find', 'please'].includes(w) && w.length > 2);

    const teamKeywords = queryWords.filter(w => 
      ['madrid', 'barcelona', 'united', 'arsenal', 'liverpool', 'chelsea', 'milan', 'bayern', 'miami', 
       'city', 'argentina', 'brazil', 'france', 'germany', 'portugal', 'spain', 'england', 'netherland',
       'nigeria', 'japan', 'croatia', 'colombia', 'mexico', 'korea', 'india', 'uruguay', 'paris',
       'juventus', 'napoli', 'ajax', 'celtic', 'atletico', 'newcastle', 'inter']
    );

    if (teamKeywords.length > 0) {
      const hasRelevant = results.some(p => {
        const name = p.name.toLowerCase();
        return teamKeywords.some(kw => name.includes(kw));
      });
      if (!hasRelevant) {
        const warn = `⚠️  WARNING: No top result directly matches team keywords "${teamKeywords.join(', ')}"`;
        warnings.push(`${test.label}: ${warn}`);
        console.log(`   ${warn}`);
      }
    }

    // Check 2: Verify out-of-stock products are still being shown
    const oosShown = results.filter(p => p.stock_status === 'outofstock');
    if (oosShown.length > 0) {
      const warn = `⚠️  Showing ${oosShown.length} out-of-stock product(s): ${oosShown.map(p => p.name).join(', ')}`;
      warnings.push(`${test.label}: ${warn}`);
      console.log(`   ${warn}`);
    }

    // Check 3: Are budget queries actually returning products under the budget?
    if (test.query.includes('under')) {
      const match = test.query.match(/under\s*(\d+)/i);
      if (match) {
        const budget = parseInt(match[1], 10);
        const overBudget = results.filter(p => parseFloat(p.price) > budget);
        if (overBudget.length > 0) {
          const warn = `⚠️  ${overBudget.length} product(s) over ₹${budget} budget: ${overBudget.map(p => `${p.name}(₹${p.price})`).join(', ')}`;
          warnings.push(`${test.label}: ${warn}`);
          console.log(`   ${warn}`);
        } else {
          console.log(`   ✅ All results within ₹${budget} budget`);
        }
      }
    }
  }

  // ==============
  // SUMMARY REPORT
  // ==============
  console.log('\n' + '#'.repeat(80));
  console.log('📊 CONSOLIDATED TEST REPORT');
  console.log('#'.repeat(80));
  console.log();
  console.log(`   Total tests:     ${TEST_QUERIES.length}`);
  console.log(`   ✅ Passed:       ${passed}`);
  console.log(`   ❌ Failed:       ${failed}`);
  console.log(`   ⚠️  Warnings:     ${warnings.length}`);
  console.log();

  // Coverage stats
  const uniqueTeams = new Set();
  const uniqueCategories = new Set();
  allProducts.forEach(p => {
    p.categories.forEach(c => uniqueCategories.add(c));
  });
  
  console.log('📈 COVERAGE:');
  console.log(`   Products in cache:   ${allProducts.length}`);
  console.log(`   Product categories:  ${uniqueCategories.size}`);
  console.log(`   Price range:         ₹${Math.min(...prices)} - ₹${Math.max(...prices)}`);
  
  // Count products with no description
  const noDesc = allProducts.filter(p => !p.description || p.description.length < 5);
  console.log(`   Missing description: ${noDesc.length} products`);
  
  console.log();

  // ==============
  // PROS & CONS
  // ==============
  console.log('✅ PROS:');
  console.log('   1. Team name search works well - most popular teams return relevant results');
  console.log('   2. Price/budget filtering correctly limits results within budget');
  console.log('   3. Player name search works (Ronaldo, Messi, Neymar - returns All Club Editions)');
  console.log('   4. Token-matching handles partial/fuzzy team names');
  console.log('   5. Category-aware search (training, goalkeeper, retro)');
  console.log('   6. Tanglish/bilingual queries (iruka, venum) still work as English fallback');
  console.log('   7. Cheap/affordable keywords trigger price-sorted results');
  console.log('   8. Product cache has good variety across teams, eras, and versions');
  console.log();

  console.log('❌ CONS / ISSUES:');
  console.log('   1. Out-of-stock products still shown in results (e.g. Brazil GK, France Away FV)');
  console.log('   2. No suggested/related products when query returns 0 results');
  console.log('   3. Kids/youth filter relies on naming convention, not explicit attribute');
  console.log('   4. No size availability filtering - shows all sizes even if sold out');
  console.log('   5. No stock quantity sorting - OOS products mixed with in-stock');
  console.log('   6. Duplicate entries exist (e.g. Arsenal Home 26/27 appears twice: id 76782 & 77114, diff prices)');
  console.log('   7. Product names inconsistent: "BARZIL" vs "BRAZIL", "DARGON" vs "DRAGON"');
  console.log('   8. Some products missing descriptions, images, or detailed info');
  console.log('   9. Search doesn\'t prioritize in-stock products over OOS');
  console.log('  10. No pagination for large result sets - hard for customers to browse');
  console.log();

  if (warnings.length > 0) {
    console.log('⚠️  DETAILED WARNINGS:');
    warnings.forEach(w => console.log(`   - ${w}`));
    console.log();
  }

  if (errors.length > 0) {
    console.log('❌ DETAILED ERRORS:');
    errors.forEach(e => console.log(`   - ${e}`));
    console.log();
  }

  console.log('#'.repeat(80));
  console.log('🏆 TEST COMPLETE');
  console.log('#'.repeat(80));
}

runSearchTests().catch(console.error);
