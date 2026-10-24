// Renders manual.html -> Aurax_Bot_User_Manual.pdf using the Puppeteer already
// installed for whatsapp-web.js. Run from apps/bot so the module resolves:
//   node ../../reports/manual/build.mjs
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Puppeteer lives in apps/bot's node_modules (a whatsapp-web.js dependency), and ESM
// resolves from THIS file's location, not the CWD — so resolve it explicitly.
const require = createRequire(path.join(here, '..', '..', 'apps', 'bot', 'package.json'));
const puppeteer = require('puppeteer');

const src = path.join(here, 'manual.html');
const out = path.join(here, '..', 'Aurax_Bot_User_Manual.pdf');

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.goto(pathToFileURL(src).href, { waitUntil: 'networkidle0' });

const foot = `
  <div style="width:100%;font-family:'Segoe UI',Arial,sans-serif;font-size:7.5pt;
              color:#98a1ad;padding:0 16mm;display:flex;justify-content:space-between;">
    <span>Aurax AI Assistant — Operating Manual</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;

await page.pdf({
  path: out,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: foot,
  margin: { top: '18mm', bottom: '16mm', left: '15mm', right: '15mm' },
});

await browser.close();
console.log('PDF written to', out);
