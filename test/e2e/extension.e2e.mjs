// End-to-end: loads the unpacked extension in Chromium, serves fixture pages
// in place of aliexpress.com, and syncs to a stand-in Google Sheet.
//   NODE_PATH=$(npm root -g) node test/e2e/extension.e2e.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (f) => fs.readFileSync(path.join(root, 'test/fixtures', f), 'utf8');

// "View orders" appends a completed and a cancelled order once, then disappears.
const listHtml = fixture('order-list.html').replace('</body>', `<script>
  document.querySelector('.order-more button').addEventListener('click', () => setTimeout(() => {
    const card = document.querySelector('.order-item').cloneNode(true);
    card.innerHTML = card.innerHTML.replaceAll('9215467591695823', '9215467591000001').replace('Sep 30, 2026', 'Jul 14, 2026')
      .replace('Awaiting delivery', 'Completed');
    document.querySelector('.order-main').appendChild(card);
    const closed = document.querySelector('.order-item').cloneNode(true);
    closed.innerHTML = closed.innerHTML.replaceAll('9215467591695823', '9215467591000002').replace('Awaiting delivery', 'Closed');
    document.querySelector('.order-main').appendChild(closed);
    document.querySelector('.order-more').remove();
  }, 300));
  // Completed orders get a trash icon that opens a confirm dialog, like the real list.
  for (const card of document.querySelectorAll('.order-item')) {
    if (!/Completed/.test(card.textContent)) continue;
    const del = document.createElement('span');
    del.className = 'order-item-header-right-delete';
    del.title = 'Delete';
    del.innerHTML = '<i class="comet-icon comet-icon-delete"></i>';
    card.querySelector('.order-item-header-right').appendChild(del);
    del.addEventListener('click', () => {
      const modal = document.createElement('div');
      modal.className = 'comet-modal-wrap';
      modal.innerHTML = '<div class="comet-modal" role="dialog"><p>Delete this order?</p><button class="c">Cancel</button><button class="d">Delete</button></div>';
      document.body.appendChild(modal);
      modal.querySelector('.c').onclick = () => modal.remove();
      modal.querySelector('.d').onclick = () => { modal.remove(); setTimeout(() => card.remove(), 400); };
    });
  }
</script></body>`);
const productHtml = '<!doctype html><html><head><title>ESP32-S3 Dev Board - AliExpress</title></head><body><h1>ESP32-S3 Development Board N16R8</h1></body></html>';

// The same board listed by a different store (different product ID).
const otherStoreHtml = '<!doctype html><html><head><title>N16R8 board - AliExpress</title></head><body><h1>ESP32-S3-WROOM-1 N16R8 Development Board Type-C</h1></body></html>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('Timed out waiting for ' + label);
    await sleep(250);
  }
}

// Google Sheet stand-in: runs tools/google-sheet-sync/Code.gs against an in-memory spreadsheet.
const SHEET_PORT = 8795;
const sheetRows = {};
function fakeSheet(name) {
  let rows = [];
  sheetRows[name] = () => rows;
  return {
    getLastRow: () => rows.length, clearContents: () => { rows = []; }, setFrozenRows() {}, setRowHeights() {},
    appendRow: (r) => rows.push(r),
    getRange: (r, c, nr, nc) => ({
      setNumberFormat() { return this; },
      getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
      setValues: (vals) => vals.forEach((v, i) => { rows[r - 1 + i] = v.slice(); }),
    }),
  };
}
const sheets = {};
const gas = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = fakeSheet(n)) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'sheet-secret' }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
};
vm.createContext(gas);
vm.runInContext(fs.readFileSync(path.join(root, 'tools/google-sheet-sync/Code.gs'), 'utf8'), gas);
const sheetServer = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(gas.doPost({ postData: { contents: body } }));
}).listen(SHEET_PORT, '127.0.0.1');


const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aex-e2e-'));
const ext = path.join(root, 'extension');
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: 'chromium', // full Chromium (new headless) — headless-shell can't load extensions
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

try {
  await context.route(/aliexpress\.com/, (route) => {
    const url = route.request().url();
    if (url.includes('/p/order/index.html')) return route.fulfill({ contentType: 'text/html', body: listHtml });
    if (url.includes('/p/order/detail.html')) return route.fulfill({ contentType: 'text/html', body: fixture('order-detail.html') });
    if (url.includes('/item/1005005999999999.html')) return route.fulfill({ contentType: 'text/html', body: productHtml });
    if (url.includes('/item/1005007777777777.html')) return route.fulfill({ contentType: 'text/html', body: otherStoreHtml });
    return route.fulfill({ status: 404, body: '' });
  });

  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const storage = (key) => sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);
  await sw.evaluate(() => chrome.storage.local.set({ settings: { detailDelayMs: 200 } }));

  // 1. Passive capture on the orders page.
  const orders = await context.newPage();
  await orders.goto('https://www.aliexpress.com/p/order/index.html');
  await waitFor(async () => Object.keys((await storage('orders')) || {}).length === 2, 'passive capture');
  console.log('✓ passive capture saved 2 orders');

  // 2. Full sync from the popup clicks "View orders".
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.click('#btnFull');
  await waitFor(async () => Object.keys((await storage('orders')) || {}).length === 4, 'full sync');
  assert.equal((await storage('orders'))['9215467591000002'].status, 'closed');
  await waitFor(async () => /Done/.test(await popup.textContent('#syncStatus')), 'sync status');
  console.log('✓ full sync loaded more orders:', await popup.textContent('#syncStatus'));

  // 3. Deep sync opens detail pages and upgrades titles.
  // (The fixture detail page only describes this one order, so target it explicitly.)
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'deepSync', orderIds: ['9213971536525823'] }));
  await waitFor(async () => {
    const o = ((await storage('orders')) || {})['9213971536525823'];
    return o && o.detailFetchedAt && o.items[0].title.includes('PSRAM');
  }, 'detail sync', 60000).catch(async (e) => {
    console.log('deep state', await sw.evaluate(() => deepSyncState));
    console.log(JSON.stringify((await storage('orders'))['9213971536525823'], null, 1));
    throw e;
  });
  const detailed = (await storage('orders'))['9213971536525823'];
  assert.deepEqual(detailed.tracking.map((t) => t.number), ['LP00123456789012']);
  assert.equal(detailed.items.length, 2, 'detail merge must not duplicate lines');
  console.log('✓ detail sync upgraded order 9213971536525823');
  await popup.click('#btnStopDeep').catch(() => {});


  // 4a. Settings page: typed values autosave and survive a reload; test button works.
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${extId}/options/options.html`);
  await opts.fill('#sheetUrl', `http://127.0.0.1:${SHEET_PORT}/exec`);
  await opts.fill('#sheetKey', 'sheet-secret');
  await opts.click('#detailBatchLimit'); // move focus away, like a user would
  await sleep(800);
  await opts.reload();
  await waitFor(async () => (await opts.inputValue('#sheetUrl')) === `http://127.0.0.1:${SHEET_PORT}/exec`, 'sheet URL persisted');
  assert.equal(await opts.inputValue('#sheetKey'), 'sheet-secret');
  await opts.click('#btnSheetAccess');
  await waitFor(async () => /✓/.test(await opts.textContent('#sheetMsg')), 'sheet test');
  console.log('✓ settings page:', (await opts.textContent('#sheetMsg')).trim());
  await opts.fill('#sheetKey', 'wrong');
  await sleep(800);
  await opts.click('#btnSheetAccess');
  await waitFor(async () => /Wrong sheet key/.test(await opts.textContent('#sheetMsg')), 'wrong key detected');
  await opts.fill('#sheetKey', 'sheet-secret');
  await sleep(800);
  await opts.close();
  await popup.reload();

  // 4b. Google Sheet sync: cancelled order excluded.
  await popup.click('#btnSheet');
  await waitFor(async () => /Sheet updated/.test(await popup.textContent('#sheetStatus')), 'sheet sync');
  const orderIds = sheetRows.Orders().slice(1).map((r) => r[0]);
  assert.deepEqual(orderIds.sort(), ['9213971536525823', '9215467591000001', '9215467591695823']);
  assert.ok(sheetRows.Items().length - 1 >= 3);
  console.log('✓ sheet:', await popup.textContent('#sheetStatus'));

  // 4c. Clean-up: delete the completed, fully recorded order from the online list; keep it locally.
  await sw.evaluate(() => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, cleanupMinAgeDays: 0 } })));
  popup.on('dialog', (d) => d.accept());
  await popup.click('#btnCleanPlan');
  await waitFor(async () => /can be removed|Nothing to remove|failed/.test(await popup.textContent('#cleanStatus')), 'clean-up plan');
  const planText = await popup.textContent('#cleanStatus');
  assert.match(planText, /^1 order older than 0 days can be removed/, planText);
  assert.match(planText, /1 details not fetched/);
  await popup.click('#btnCleanOne');
  await waitFor(async () => /Removed \d/.test(await popup.textContent('#cleanStatus')), 'clean-up run');
  assert.match(await popup.textContent('#cleanStatus'), /Removed 1 from the AliExpress list/);
  assert.ok((await storage('removedOnline'))['9213971536525823']);
  assert.ok((await storage('orders'))['9213971536525823'], 'order kept locally');
  assert.equal(await orders.locator('text=9213971536525823').count(), 0, 'card gone from the online list');
  console.log('✓ clean-up:', (await popup.textContent('#cleanStatus')).trim());

  // 5. Product page shows what you've already ordered.
  const product = await context.newPage();
  await product.goto('https://www.aliexpress.com/item/1005005999999999.html');
  const panel = await product.waitForSelector('.aex-panel', { timeout: 15000 });
  const text = await panel.textContent();
  assert.match(text, /ordered this before: 3 units in 1 order/);
  console.log('✓ product page panel:', text.replace(/\s+/g, ' ').trim());
  await product.screenshot({ path: path.join(root, 'docs/screenshot-product-panel.png') });

  // 5b. Same part from another store is recognised.
  const other = await context.newPage();
  await other.goto('https://www.aliexpress.com/item/1005007777777777.html');
  const otherText = await (await other.waitForSelector('.aex-panel', { timeout: 15000 })).textContent();
  assert.match(otherText, /likely ordered this from another store: 3 units in 1 order/);
  assert.match(otherText, /Same item from other stores/);
  console.log('✓ other-store panel:', otherText.replace(/\s+/g, ' ').trim());
  await other.close();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.reload();
  await sleep(800);
  await popup.screenshot({ path: path.join(root, 'docs/screenshot-popup.png') });

  console.log('\nE2E PASSED');
} finally {
  await context.close();
  sheetServer.close();
}
