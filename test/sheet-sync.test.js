const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../extension/lib/core.js');

// Minimal in-memory SpreadsheetApp stand-in.
function fakeSpreadsheet() {
  const sheets = {};
  const makeSheet = () => {
    let rows = [];
    return {
      rows: () => rows,
      getLastRow: () => rows.length,
      clearContents: () => { rows = []; },
      setFrozenRows() {},
      setRowHeights() {},
      appendRow: (r) => rows.push(r),
      getRange: (r, c, nr, nc) => ({
        setNumberFormat() { return this; },
        getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
        setValues: (vals) => { vals.forEach((v, i) => { rows[r - 1 + i] = v.slice(); }); },
      }),
    };
  };
  return {
    sheets,
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet()),
  };
}

function load() {
  const ss = fakeSpreadsheet();
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'k123' }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => JSON.parse(t) }), MimeType: { JSON: 'json' } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../tools/google-sheet-sync/Code.gs'), 'utf8'), ctx);
  const post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return { ss, post };
}

const order = (id, status, items) => core.normalizeOrder({ orderId: id, orderDate: '2026-09-30', statusText: status, items }, 'web-list');

test('sheet sync: upserts orders/items, removes cancelled, counts repeats', () => {
  const { ss, post } = load();
  assert.equal(post({ key: 'wrong', payload: { orders: [] } }).ok, false);

  const a = order('9215467591695823', 'Awaiting delivery', [{ title: 'Tweezers', productId: '1005006123456789', quantity: 2, imageUrl: 'https://x/i.jpg' }]);
  const b = order('9215467591695824', 'Completed', [{ title: 'Tweezers', productId: '1005006123456789', quantity: 1 }]);
  const c = order('9215467591695825', 'Completed', [{ title: 'Cable', productId: '1005000000000001', quantity: 1 }]);
  let r = post({ key: 'k123', payload: core.buildPayload([a, b, c]) });
  assert.deepEqual([r.ok, r.orders, r.items], [true, 3, 3]);

  const items = ss.sheets.Items.rows();
  const header = items[0];
  const col = (n) => header.indexOf(n);
  const tweezer = items.find((row) => row[col('orderId')] === '9215467591695823');
  assert.equal(tweezer[col('timesOrdered')], 2);
  assert.equal(tweezer[col('Image')], '=IMAGE("https://x/i.jpg")');
  assert.equal(typeof tweezer[col('orderId')], 'string');

  // Order b gets cancelled → tombstone removes it; re-sending a is idempotent.
  const closed = core.outgoingOrders([{ ...b, status: 'closed' }, a]);
  assert.equal(closed[0].items.length, 0);
  r = post({ key: 'k123', payload: core.buildPayload(closed) });
  assert.deepEqual([r.orders, r.items, r.removed], [2, 2, 1]);
  const after = ss.sheets.Items.rows().find((row) => row[col('orderId')] === '9215467591695823');
  assert.equal(after[col('timesOrdered')], 1);
  assert.equal(ss.sheets['Sync log'].rows().length, 3);
});

test('outgoingOrders keeps everything when ignoreCancelled is off', () => {
  const o = { ...order('9215467591695823', 'Closed', [{ title: 'X', quantity: 1 }]) };
  assert.equal(core.outgoingOrders([o], { ignoreCancelled: false })[0].items.length, 1);
  assert.equal(core.outgoingOrders([o])[0].cancelled, true);
});

test('setupSheets creates the three tabs with headers', () => {
  const calls = [];
  const range = () => {
    const r = { setValues: (v) => { calls.push(v[0]); return r; }, setFontWeight: () => r, setBackground: () => r, setNumberFormat: () => r };
    return r;
  };
  const tabs = {};
  const ss = {
    getSheetByName: (n) => tabs[n] || null,
    insertSheet: (n) => (tabs[n] = { getLastRow: () => 0, getMaxRows: () => 1000, getRange: range, setFrozenRows() {}, setColumnWidth() {} }),
  };
  const ctx = { SpreadsheetApp: { getActiveSpreadsheet: () => ss }, Logger: { log() {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../tools/google-sheet-sync/Code.gs'), 'utf8'), ctx);
  ctx.setupSheets();
  assert.deepEqual(Object.keys(tabs).sort(), ['Items', 'Orders', 'Sync log']);
  assert.equal(calls[0][0], 'orderId');
  assert.ok(calls[0].includes('firstSeenAt'));
});

test('sheet verify reports which orders are recorded', () => {
  const { post } = load();
  const a = order('9215467591695823', 'Completed', [{ title: 'Tweezers', productId: '1005006123456789', quantity: 2 }, { title: 'Cable', productId: '1005000000000001', quantity: 1 }]);
  post({ key: 'k123', payload: core.buildPayload([a]) });
  assert.equal(post({ key: 'wrong', verify: ['9215467591695823'] }).ok, false);
  const r = post({ key: 'k123', verify: ['9215467591695823', '9215467591695899'] });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.found), ['9215467591695823']);
  assert.equal(r.found['9215467591695823'].status, 'completed');
  assert.equal(r.found['9215467591695823'].itemCount, 2);
});
