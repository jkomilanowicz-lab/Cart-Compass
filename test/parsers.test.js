const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const core = require('../extension/lib/core.js');
const parsers = require('../extension/lib/parsers.js');
const email = require('../extension/lib/email.js');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('parseMoney handles common formats', () => {
  assert.deepEqual(core.parseMoney('US $1,234.56'), { amount: 1234.56, currency: 'USD' });
  assert.deepEqual(core.parseMoney('€ 1.234,50'), { amount: 1234.5, currency: 'EUR' });
  assert.deepEqual(core.parseMoney('Total:US $10.24'), { amount: 10.24, currency: 'USD' });
  assert.equal(core.parseMoney('Free'), null);
});

test('parseDate handles AliExpress date formats', () => {
  assert.equal(core.parseDate('Sep 30, 2026'), '2026-09-30');
  assert.equal(core.parseDate('3 Aug 2026'), '2026-08-03');
  assert.equal(core.parseDate('2026/08/03'), '2026-08-03');
});

test('normalizeStatus maps AliExpress wording', () => {
  assert.equal(core.normalizeStatus('Awaiting delivery'), 'shipped');
  assert.equal(core.normalizeStatus('Awaiting shipment'), 'processing');
  assert.equal(core.normalizeStatus('Completed'), 'completed');
  assert.equal(core.normalizeStatus('Closed'), 'closed');
  assert.equal(core.normalizeStatus('Awaiting payment'), 'awaiting_payment');
});

test('parseOrderList extracts orders, items, quantities and prices', () => {
  const dom = new JSDOM(fixture('order-list.html'), { url: 'https://www.aliexpress.com/p/order/index.html' });
  const { orders, errors } = parsers.parseOrderList(dom.window.document);
  assert.deepEqual(errors, []);
  assert.equal(orders.length, 2);
  const [a, b] = orders;
  assert.equal(a.orderId, '9215467591695823');
  assert.equal(a.orderDate, '2026-09-30');
  assert.equal(a.status, 'shipped');
  assert.equal(a.storeName, 'LUOWEI Official Store');
  assert.equal(a.total, 10.24);
  assert.equal(a.currency, 'USD');
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].productId, '1005006123456789');
  assert.equal(a.items[0].quantity, 2);
  assert.equal(a.items[0].unitPrice, 5.12);
  assert.equal(a.items[0].variant, 'IS-40');
  assert.match(a.items[0].imageUrl, /alicdn\.com\/kf\/S1/);

  assert.equal(b.status, 'completed');
  assert.equal(b.items.length, 2);
  assert.equal(b.items[0].quantity, 3);
  assert.equal(b.items[0].imageUrl, 'https://ae01.alicdn.com/kf/S2.jpg');
  assert.equal(b.items[1].variant, null);
  assert.equal(b.items[1].quantity, 1);

  assert.ok(parsers.findLoadMoreButton(dom.window.document));
});

test('parseOrderList fallback works without known class names', () => {
  const html = fixture('order-list.html').replace(/class="order-item[^"]*"/g, 'class="x"');
  const dom = new JSDOM(html, { url: 'https://www.aliexpress.com/p/order/index.html' });
  const { orders } = parsers.parseOrderList(dom.window.document);
  const ids = orders.map((o) => o.orderId).sort();
  assert.ok(ids.includes('9215467591695823'));
  const a = orders.find((o) => o.orderId === '9215467591695823');
  assert.equal(a.items[0].productId, '1005006123456789');
  assert.equal(a.items[0].quantity, 2);
});

test('email: multi-order confirmation', () => {
  const orders = email.parseConfirmationEmail({
    subject: '5 orders confirmed: 9215467591755823 & more',
    body: fixture('email-multi.txt'),
    date: '2026-09-30T12:56:41Z',
  });
  assert.equal(orders.length, 5);
  assert.deepEqual(orders.map((o) => o.orderId), [
    '9215467591755823', '9215467591735823', '9215467591775823', '9215467591695823', '9215467591715823',
  ]);
  const [o1, o2, , o4, o5] = orders;
  assert.equal(o1.total, 5.57);
  assert.equal(o1.orderDate, '2026-09-30');
  assert.equal(o1.items[0].title, 'Mobile Phone Repair Tweezers...');
  assert.equal(o1.items[0].variant, 'Blue, A, 14cm');
  assert.equal(o1.items[0].quantity, 1);
  assert.equal(o2.items[0].variant, 'Type-C USB');
  assert.equal(o4.items[0].quantity, 2);
  assert.equal(o5.items[0].title, 'Carbon Steel Precision Sharp ...');
  assert.equal(o5.items[0].quantity, 1);
  assert.ok(orders.every((o) => o.status === 'processing' && o.sources.includes('gmail')));
});

test('email: single order confirmation', () => {
  const [o] = email.parseConfirmationEmail({
    subject: 'Order 9215089669235823: order confirmed',
    body: fixture('email-single.txt'),
    date: '2026-09-28T04:25:45Z',
  });
  assert.equal(o.orderId, '9215089669235823');
  assert.equal(o.total, 26.12);
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].title, 'ESP32-P4-Module Development B...');
  assert.equal(o.items[0].variant, 'ESP32-P4-Module');
  assert.equal(o.items[0].quantity, 1);
});

test('email: status subjects', () => {
  assert.equal(email.parseSubject('Order 9215295418725823: order shipped').status, 'shipped');
  assert.equal(email.parseSubject('Order 9215139909565823: collected by the carrier').status, 'shipped');
  assert.equal(email.parseSubject('Order 9213971536525823: how did it go?').status, 'completed');
  assert.equal(email.parseSubject('Your order 9214300974375823 is closed').status, 'closed');
  assert.equal(email.parseSubject('Package 1ST06014437396 has been delivered').trackingNumber, '1ST06014437396');
});

test('merge: web data upgrades gmail data and status never regresses', () => {
  const map = {};
  const [fromMail] = email.parseConfirmationEmail({ subject: 'Order 9215089669235823: order confirmed', body: fixture('email-single.txt'), date: '2026-09-28T04:25:45Z' });
  core.mergeInto(map, [fromMail]);
  core.mergeInto(map, email.parseStatusEmail({ subject: 'Order 9215089669235823: order shipped' }));
  assert.equal(map['9215089669235823'].status, 'shipped');

  const web = core.normalizeOrder({
    orderId: '9215089669235823', orderDate: '2026-09-27', statusText: 'Awaiting delivery', total: 26.12,
    items: [{ title: 'ESP32-P4-Module Development Board WiFi6', variant: 'ESP32-P4-Module', quantity: 1, productId: '1005007000000001', unitPrice: 26.12 }],
  }, 'web-list');
  const counts = core.mergeInto(map, [web]);
  assert.equal(counts.updated, 1);
  const m = map['9215089669235823'];
  assert.equal(m.items[0].title, 'ESP32-P4-Module Development Board WiFi6');
  assert.equal(m.items[0].productId, '1005007000000001');
  assert.deepEqual(m.sources.sort(), ['gmail', 'web-list']);

  // Older "confirmed" info must not move status back.
  core.mergeInto(map, [fromMail]);
  assert.equal(map['9215089669235823'].status, 'shipped');
  // Re-merging identical data reports unchanged.
  assert.equal(core.mergeInto(map, [web]).unchanged, 1);
});

test('purchaseHistory finds exact and similar prior purchases', () => {
  const dom = new JSDOM(fixture('order-list.html'));
  const { orders } = parsers.parseOrderList(dom.window.document);
  const h = core.purchaseHistory(orders, { productId: '1005005999999999', title: 'ESP32-S3 Dev Board N16R8' });
  assert.equal(h.exact.units, 3);
  assert.equal(h.exact.orders, 1);
  const h2 = core.purchaseHistory(orders, { productId: '1', title: 'LUOWEI IS-40 Tweezers High Precision' });
  assert.equal(h2.exact.units, 0);
  assert.equal(h2.similar[0].productId, '1005006123456789');
});

test('purchaseHistory matches the same part from a different store', () => {
  const order = (orderId, status, productId, title, quantity) => ({ orderId, status, orderDate: '2026-01-01', items: [{ productId, title, quantity }] });
  const orders = [
    order('1', 'completed', '111', 'ESP32-S3 Dev Board N16R8 WiFi Bluetooth', 2),
    order('2', 'shipped', '222', 'W25Q128JVSIQ 128Mbit SPI Flash', 5),
    order('3', 'completed', '333', 'ESP32-C3 SuperMini Development Board', 4),
    order('4', 'closed', '444', 'ESP32-S3-WROOM-1 N16R8 module', 9),
  ];
  const h = core.purchaseHistory(orders, { productId: '999', title: 'ESP32-S3-WROOM-1 N16R8 Development Board' });
  assert.equal(h.exact.units, 0);
  assert.equal(h.likely.units, 2, 'other-store N16R8 board counts; cancelled order and ESP32-C3 do not');
  assert.equal(h.likely.orders, 1);
  assert.ok(h.similar[0].likelySame);
  assert.deepEqual(h.similar[0].codes, ['n16r8']);
  assert.ok(!h.similar.some((s) => s.likelySame && s.productId === '333'));

  const f = core.purchaseHistory(orders, { productId: '998', title: '10pcs W25Q128FV SOP8 Flash' });
  assert.equal(f.likely.units, 5);
  assert.equal(f.likely.inTransitUnits, 5);

  // Different sizes of a generic part are not "the same item".
  const o = core.purchaseHistory([order('5', 'completed', '555', '1.3 inch OLED display I2C 128x64 SH1106', 1)],
    { productId: '997', title: '0.96 inch OLED display I2C 128x64' });
  assert.equal(o.likely.units, 0);
});

test('toCSV emits one row per line with escaping', () => {
  const o = core.normalizeOrder({ orderId: '9215467591695823', items: [{ title: 'A, "quoted"', quantity: 2 }] }, 'manual');
  const csv = core.toCSV([o]).split('\n');
  assert.equal(csv.length, 2);
  assert.match(csv[1], /"A, ""quoted"""/);
});

test('parseOrderDetail extracts full titles, prices, tracking', () => {
  const dom = new JSDOM(fixture('order-detail.html'), { url: 'https://www.aliexpress.com/p/order/detail.html?orderId=9213971536525823' });
  const o = parsers.parseOrderDetail(dom.window.document, dom.window.location.href);
  assert.equal(o.orderId, '9213971536525823');
  assert.equal(o.status, 'completed');
  assert.equal(o.orderDate, '2026-08-03');
  assert.equal(o.total, 23.7);
  assert.equal(o.shipping, 0);
  assert.equal(o.storeName, 'Waveshare Store');
  assert.deepEqual(o.tracking, [{ number: 'LP00123456789012', carrier: null }]);
  assert.equal(o.items.length, 2);
  assert.equal(o.items[0].title, 'ESP32-S3 Development Board 16MB Flash 8MB PSRAM WiFi BLE');
  assert.equal(o.items[0].variant, 'Color: N16R8');
  assert.equal(o.items[0].quantity, 3);
  assert.equal(o.items[0].unitPrice, 7.5);
  assert.ok(o.detailFetchedAt);
});

test('email: multi-item order card yields one line per item', () => {
  const body = `[| | | Order 39213971536525823 | | | | | 5/20M Single Core Copper Wire... Black, 22AWG, 10M x1 | | | | | | 5/20M Single Core Copper Wire... Red, 22AWG, 10M x1 | | | | | | | Total | $5.45 | ](https://www.aliexpress.com/p/order/detail.html?orderId=9213971536525823)`;
  const [o] = email.parseConfirmationEmail({ subject: '3 orders confirmed: 9213971536485823 & more', body, date: '2026-09-14T13:21:39Z' });
  assert.equal(o.orderId, '9213971536525823');
  assert.equal(o.items.length, 2);
  assert.deepEqual(o.items.map((i) => i.variant), ['Black, 22AWG, 10M', 'Red, 22AWG, 10M']);
  assert.notEqual(o.items[0].lineId, o.items[1].lineId);
  assert.equal(o.total, 5.45);
});

test('email: single order whose variant cell is truncated too', () => {
  const [o] = email.parseConfirmationEmail({
    subject: 'Order 9213136705865823: order confirmed', date: '2026-07-14T08:10:52Z',
    body: '| Track order | 1.69 Inch LCD IPS Screen 240×... | 1.69 IPS LCD, China ... | x1 | Order total | $6.08 |',
  });
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].variant, '1.69 IPS LCD, China ...');
  assert.equal(o.total, 6.08);
});

test('detail: stray numbers after "Shipping"/"Total" are not taken as money', () => {
  const html = fixture('order-detail.html')
    .replace('<div class="order-price">', '<div>Shipping method: AliExpress Standard Shipping 3,115 km away. Total items 2</div><div class="order-price">')
    .replace('Shipping fee Free', 'Shipping fee US $0.96');
  const dom = new JSDOM(html, { url: 'https://www.aliexpress.com/p/order/detail.html?orderId=9213971536525823' });
  const o = parsers.parseOrderDetail(dom.window.document, dom.window.location.href);
  assert.equal(o.shipping, 0.96);
  assert.equal(o.total, 23.7); // "Subtotal" and "Total items 2" are not the total
});

test('sanitize: shipping larger than total is dropped, including on merge', () => {
  const bad = core.normalizeOrder({ orderId: '9215467591695823', total: 5.18, shipping: 3115, items: [] }, 'web-detail');
  assert.equal(bad.shipping, null);
  const stored = { ...bad, shipping: 3115 }; // as saved by an older version
  const merged = core.mergeOrder(stored, core.normalizeOrder({ orderId: '9215467591695823', total: 5.18, items: [] }, 'web-detail'));
  assert.equal(merged.shipping, null);
});

test('detail: subtotal, shipping, tax and discount are captured separately', () => {
  const html = fixture('order-detail.html').replace(
    '<div>Subtotal US $23.70</div><div>Shipping fee Free</div><div>Total US $23.70</div>',
    '<div>Subtotal</div><div>US $23.70</div><div>Shipping fee</div><div>US $1.20</div><div>Store discount</div><div>-US $2.00</div>' +
    '<div>Coupon</div><div>-US $0.50</div><div>Estimated tax</div><div>US $1.83</div><div>Total</div><div>US $24.23</div>');
  const dom = new JSDOM(html, { url: 'https://www.aliexpress.com/p/order/detail.html?orderId=9213971536525823' });
  const o = parsers.parseOrderDetail(dom.window.document, dom.window.location.href);
  assert.deepEqual([o.subtotal, o.shipping, o.tax, o.discount, o.total], [23.7, 1.2, 1.83, 2.5, 24.23]);

  const b = core.withCostBreakdown(o);
  assert.equal(b.itemsSubtotal, 23.7);
  assert.equal(b.totalsCheck, 'ok');
  // 3 boards @7.50 + 1 cable @1.20; the extra 0.53 is spread by value.
  const [board, cable] = b.items;
  assert.equal(board.landedUnitCost, 7.67);
  assert.equal(cable.landedUnitCost, 1.23);
  const paid = board.landedUnitCost * 3 + cable.landedUnitCost;
  assert.ok(Math.abs(paid - 24.23) < 0.03);
});

test('breakdown flags orders whose numbers do not add up', () => {
  const o = core.normalizeOrder({ orderId: '9215139909815823', total: 12.83, shipping: 0.96, items: [{ title: 'Bulb', quantity: 1, unitPrice: 12.83 }] }, 'web-detail');
  assert.equal(core.withCostBreakdown(o).totalsCheck, 'mismatch');
  const csv = core.toCSV([o]).split('\n');
  assert.match(csv[0], /orderTax/);
  assert.match(csv[1], /mismatch/);
});

test('detail: prices rendered one digit per span are read whole', () => {
  const digits = (s) => s.split('').map((c) => `<span>${c}</span>`).join('');
  const html = fixture('order-detail.html').replace(
    '<div>Subtotal US $23.70</div><div>Shipping fee Free</div><div>Total US $23.70</div>',
    `<div><div>Subtotal</div><div><span>US $</span>${digits('23.70')}</div></div>` +
    `<div><div>Shipping fee</div><div><span>US $</span>${digits('1.20')}</div></div>` +
    `<div><div>Additional charges</div><div><span>US $</span>${digits('1.88')}</div></div>` +
    `<div><div>Total</div><div><span>US $</span>${digits('26.78')}</div></div>`);
  const dom = new JSDOM(html, { url: 'https://www.aliexpress.com/p/order/detail.html?orderId=9213971536525823' });
  const o = parsers.parseOrderDetail(dom.window.document, dom.window.location.href);
  assert.deepEqual([o.subtotal, o.shipping, o.total], [23.7, 1.2, 26.78]);
  assert.equal(o.tax, 1.88, '"Additional charges" is AliExpress\'s label for tax');
  assert.equal(core.withCostBreakdown(o).totalsCheck, 'ok');
});

test('detail: impossible total (below half the item prices) is dropped', () => {
  const html = fixture('order-detail.html').replace('Total US $23.70', 'Total US $2.00');
  const dom = new JSDOM(html, { url: 'https://www.aliexpress.com/p/order/detail.html?orderId=9213971536525823' });
  assert.equal(parsers.parseOrderDetail(dom.window.document, dom.window.location.href).total, null);
});

test('findDeleteControl / findConfirmButton locate the clean-up controls', () => {
  const dom = new JSDOM(fixture('order-list.html'));
  const doc = dom.window.document;
  const cards = parsers.findOrderCards(doc);
  assert.equal(parsers.findDeleteControl(cards[0]), null, 'no delete control, and "Copy"/prices are not mistaken for one');

  const icon = doc.createElement('span');
  icon.className = 'order-item-header-right-delete';
  icon.innerHTML = '<i class="comet-icon-delete"></i>';
  cards[1].querySelector('.order-item-header-right').appendChild(icon);
  assert.equal(parsers.findDeleteControl(cards[1]), icon);

  const struck = new JSDOM('<div class="order-item"><span class="price-deleted">US $9.99</span><button>Delete</button></div>').window.document;
  assert.equal(parsers.findDeleteControl(struck.querySelector('.order-item')).tagName, 'BUTTON');
  const hidden = new JSDOM('<div class="order-item"><span class="x-delete" style="display:none" title="Delete"></span></div>').window.document;
  assert.equal(parsers.findDeleteControl(hidden.querySelector('.order-item')), null);
  assert.ok(parsers.findDeleteControl(hidden.querySelector('.order-item'), { allowHidden: true }));

  const dlg = new JSDOM(`<div role="dialog" style="display:none"><button>OK</button></div>
    <div class="comet-modal"><p>Delete this order?</p><button>Cancel</button><button id="yes">Delete</button></div>`).window.document;
  assert.equal(parsers.findConfirmButton(dlg).id, 'yes');
  assert.equal(parsers.findConfirmButton(new JSDOM('<p>nothing</p>').window.document), null);
});

test('closed orders: close reason, closing date and refund tracking', () => {
  const day = 86400000;
  // Expired = the seller didn't ship in time (AliExpress wording), from status or page text.
  assert.equal(core.closeReasonOf('has not shipped in the required time'), 'expired');
  assert.equal(core.closeReasonOf('Order canceled due to late shipment'), 'expired');
  assert.equal(core.closeReasonOf('Expired'), 'expired');
  assert.equal(core.closeReasonOf('Payment not received'), 'unpaid');
  assert.equal(core.closeReasonOf('Closed'), null);
  assert.equal(core.normalizeStatus('Expired'), 'closed');

  // A bare "expired" elsewhere on a page (a coupon) doesn't count; the specific wording does.
  assert.equal(parsers.closeNotes('Closed. Your coupon expired.').closeReasonText, null);
  const notes = parsers.closeNotes("Order closed. We're sorry, your order 9214676116065823 has not shipped in the required time. Refund confirmed: 4.86USD has been credited to your original payment method.");
  assert.match(notes.closeReasonText, /has not shipped in the required time$/);
  assert.ok(notes.refundedAt);

  // First seen already closed: closing date estimated (old order → orderDate + 30 days).
  const old = core.normalizeOrder({ orderId: '9215467591000101', orderDate: '2026-01-10', statusText: 'Closed' }, 'web-list');
  assert.deepEqual([old.closeReason, old.closedAt.slice(0, 10), old.closedAtEstimated], ['cancelled', '2026-02-09', true]);
  assert.equal(core.refundCleared(old, 14), true);

  // An open order that turns closed is dated now; refund pending until the wait passes or it's seen.
  const open = core.normalizeOrder({ orderId: '9215467591000102', orderDate: '2026-10-01', statusText: 'Awaiting shipment' }, 'web-list');
  assert.equal(open.closedAt, undefined);
  const closed = core.mergeOrder(open, core.normalizeOrder({ orderId: '9215467591000102', statusText: 'Closed', closeReasonText: 'has not shipped in the required time' }, 'web-detail'));
  assert.equal(closed.closeReason, 'expired');
  assert.equal(closed.closedAtEstimated, false);
  assert.ok(Date.now() - Date.parse(closed.closedAt) < 5000);
  assert.ok(core.isExpired(closed));
  assert.equal(core.refundCleared(closed, 14), false);
  assert.equal(core.refundCleared(closed, 14, Date.now() + 15 * day), true);
  // Later reads keep the closing date and the stronger reason; a refund clears it at once.
  const later = core.mergeOrder(closed, core.normalizeOrder({ orderId: '9215467591000102', statusText: 'Closed', refundedAt: '2026-10-11T00:00:00.000Z' }, 'web-detail'));
  assert.deepEqual([later.closedAt, later.closeReason, later.refundedAt], [closed.closedAt, 'expired', '2026-10-11T00:00:00.000Z']);
  assert.equal(core.refundCleared(later, 14), true);
  // Unpaid orders owe nothing.
  assert.equal(core.refundCleared(core.normalizeOrder({ orderId: '9215467591000103', statusText: 'Closed: payment not received' }, 'web-list'), 14), true);
});

test('Gmail: late-shipment cancellations and cancellation refunds', () => {
  const late = email.parseStatusEmail({ subject: 'Order canceled due to late shipment', date: '2026-10-14T21:56:17Z',
    body: "| Order canceled Hi, We're sorry, your order 9215467591000104[](https://www.aliexpress.com/p/order/detail.html?orderId=9215467591000104) has not shipped in the required time. |" })[0];
  assert.deepEqual([late.orderId, late.status, late.closeReason, late.closedAt], ['9215467591000104', 'closed', 'expired', '2026-10-14T21:56:17Z']);
  const refund = email.parseStatusEmail({ subject: 'Cancellation refund processed', date: '2026-10-11T06:43:01Z',
    body: 'Refund confirmed Hi, 4.86USD has been credited to your original payment method on 2026-10-11. View details[](https://aliexpress.com/p/reverse-pages/detail.html?tradeOrderId=9215467591000104&refundOnly=1)' })[0];
  assert.deepEqual([refund.orderId, refund.refundedAt.slice(0, 10)], ['9215467591000104', '2026-10-11']);
  // Ordinary (partial) refunds on delivered orders are not cancellations.
  assert.equal(email.parseSubject('Refund processed'), null);
});

test('refunds shown on a closed order page', () => {
  const r = (t) => { const n = parsers.closeNotes(t); return [!!n.refundedAt, n.refundAmount]; };
  assert.deepEqual(r('Order closed. Refund amount: US $4.86'), [true, 4.86]);
  assert.deepEqual(r('Order closed. Refunded US $12.30 to your card'), [true, 12.3]);
  assert.deepEqual(r('Closed. Refund successful'), [true, null]);
  assert.deepEqual(r('Closed. Refund in progress. Refund amount: US $4.86'), [false, null], 'pending refunds don\'t count');
  assert.deepEqual(r('Closed. Total US $4.86'), [false, null]);
  const o = core.normalizeOrder({ orderId: '9215467591000105', statusText: 'Closed', ...parsers.closeNotes('Order closed. Your order has not shipped in the required time. Refund amount: US $4.86') }, 'web-detail');
  assert.deepEqual([o.closeReason, o.refundAmount, core.refundCleared(o, 14)], ['expired', 4.86, true]);
});

test('newer order cards: "Ref. Number", "Canceled", "Refund complete", Remove button', () => {
  const html = `<div class="order-item">
    <div class="order-item-header"><div class="order-item-header-status"><span class="order-item-header-status-text">Canceled</span></div>
      <div class="order-item-header-right"><div>Date: Sep 6, 2026</div><div>Ref. Number: 9214882712945823 <span>Copy</span></div><a href="#">Details</a></div></div>
    <div class="order-item-store"><span class="order-item-store-name">CY1122 Store</span></div>
    <div class="order-item-content"><div class="order-item-content-body">
      <a href="https://www.aliexpress.com/item/1005001111111111.html"><img src="https://ae01.alicdn.com/kf/x.jpg"></a>
      <div class="order-item-content-info"><div class="order-item-content-info-name"><span>1600/127pcs Heat-shrink Tubing</span></div>
        <div class="order-item-content-info-sku">164PCS no Box</div><div class="order-item-content-info-number"><span>$1.59</span><span>x1</span></div>
        <div>$1 coupon if delayed</div></div></div>
      <div class="order-item-content-opt"><span class="order-item-content-opt-price-total">Total:$1.52</span><button>Add to cart</button><button>Remove</button></div></div>
    <div class="refund-bar"><b>Refund complete</b> AliExpress processing complete. Refund by financial institution will be processed in 2-3 business days.</div>
  </div>`;
  const card = new JSDOM(html).window.document.querySelector('.order-item');
  const raw = parsers.parseOrderCard(card);
  assert.equal(raw.orderId, '9214882712945823');
  const o = core.normalizeOrder(raw, 'web-list');
  assert.deepEqual([o.status, o.orderDate, o.closeReason], ['closed', '2026-09-06', 'cancelled']);
  assert.ok(o.refundedAt, '"Refund complete" counts as refunded');
  assert.equal(core.refundCleared(o, 14), true, 'eligible for clean-up right away');
  const del = parsers.findDeleteControl(card);
  assert.equal(del.textContent.trim(), 'Remove');
});
