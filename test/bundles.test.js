const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('Apps Script bundle parses Gmail messages into a Drive JSON file', () => {
  const msg = (subject, date, body) => ({ getSubject: () => subject, getDate: () => new Date(date), getBody: () => body });
  const messages = [
    msg('Order 9215089669235823: order shipped', '2026-09-29T00:00:00Z', ''),
    msg('Order 9215089669235823: order confirmed', '2026-09-28T04:25:45Z', read('test/fixtures/email-single.txt')),
    msg('5 orders confirmed: 9215467591755823 & more', '2026-09-30T12:56:41Z', read('test/fixtures/email-multi.txt')),
    msg('Great finds await your return', '2026-09-30T12:56:41Z', ''),
  ];
  let written = null;
  const ctx = {
    GmailApp: { search: (_q, start) => (start === 0 ? messages.map((m) => ({ getMessages: () => [m] })) : []) },
    DriveApp: { createFile: (name, content) => { written = { name, content }; return { getUrl: () => 'drive://x' }; } },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    Logger: { log: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(read('tools/gmail-apps-script/Code.gs'), ctx);
  vm.runInContext('exportAliExpressOrders()', ctx);
  const payload = JSON.parse(written.content);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.orders.length, 6);
  const single = payload.orders.find((o) => o.orderId === '9215089669235823');
  assert.equal(single.status, 'shipped');
  assert.equal(single.items[0].variant, 'ESP32-P4-Module');
});

test('console snippet bundle is valid and self-contained', () => {
  const src = read('tools/console-export.js');
  assert.doesNotThrow(() => new vm.Script(src));
  assert.match(src, /parseOrderList/);
});
