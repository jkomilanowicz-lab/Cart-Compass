/**
 * Cart Compass → Google Sheet (a live, reviewable copy of your AliExpress orders).
 *
 * Setup (once):
 *   1. Create a Google Sheet → Extensions → Apps Script → replace Code.gs with this file → Save.
 *      Optional: pick `setupSheets` in the function dropdown → Run, to create the tabs and
 *      headers right away (otherwise the first sync creates them).
 *   2. Change SYNC_KEY below to a long random string (or set Script Property SYNC_KEY).
 *   3. Deploy → New deployment → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy.
 *      Copy the Web app URL (ends with /exec).
 *   4. Extension popup → Settings: paste the URL into "Google Sheet web app URL" and the key into
 *      "Google Sheet key" → Save (approve the permission prompt) → "Sync to Google Sheet".
 *
 * The script keeps three tabs: Orders, Items, Sync log. Every sync rewrites the rows it
 * receives; cancelled orders arrive as tombstones and are removed from both tabs.
 * "Anyone" access is required for the extension to reach the URL; the SYNC_KEY check
 * is what keeps strangers from writing to the sheet.
 */
var SYNC_KEY = 'change-me-to-a-long-random-string';

var ORDER_COLUMNS = ['orderId', 'orderDate', 'status', 'statusText', 'storeName', 'itemCount', 'units', 'currency',
  'itemsSubtotal', 'subtotal', 'shipping', 'tax', 'discount', 'total', 'totalsCheck',
  'tracking', 'sources', 'hasDetails', 'firstSeenAt', 'updatedAt', 'orderUrl'];
var ITEM_COLUMNS = ['Image', 'orderId', 'orderDate', 'status', 'title', 'variant', 'quantity', 'unitPrice', 'lineTotal', 'landedUnitCost', 'productId',
  'timesOrdered', 'titleTruncated', 'lineId', 'imageUrl', 'productUrl'];
var LOG_COLUMNS = ['syncedAt', 'source', 'received', 'upserted', 'removed', 'ordersInSheet', 'itemsInSheet'];

function getKey_() {
  return PropertiesService.getScriptProperties().getProperty('SYNC_KEY') || SYNC_KEY;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return json_({ ok: true, service: 'aliexpress-sheet-sync' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (getKey_() === 'change-me-to-a-long-random-string') return json_({ ok: false, error: 'Set SYNC_KEY in the Apps Script first' });
    if (!body || body.key !== getKey_()) return json_({ ok: false, error: 'Wrong sheet key' });
    if (body.ping) return json_({ ok: true, pong: true });
    if (Array.isArray(body.verify)) return json_(verifyOrders_(SpreadsheetApp.getActiveSpreadsheet(), body.verify));
    var payload = body.payload;
    if (!payload || !Array.isArray(payload.orders)) return json_({ ok: false, error: 'Expected payload.orders' });
    return json_(applyPayload_(SpreadsheetApp.getActiveSpreadsheet(), payload));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// Which of these orders are recorded in the Orders tab, with what status and item count.
// The extension asks before it deletes finished orders from the AliExpress order list.
function verifyOrders_(ss, ids) {
  var sh = ss.getSheetByName('Orders');
  var found = {};
  if (sh) {
    var wanted = {};
    ids.forEach(function (id) { wanted[String(id)] = true; });
    readRows_(sh, ORDER_COLUMNS).forEach(function (r) {
      var id = String(r.orderId);
      if (wanted[id]) found[id] = { status: String(r.status), itemCount: Number(r.itemCount) || 0, units: Number(r.units) || 0, hasDetails: String(r.hasDetails) };
    });
  }
  return { ok: true, found: found };
}

function sheet_(ss, name, columns) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, columns.length).setValues([columns]);
  return sh;
}

// Read a tab into objects keyed by header name.
function readRows_(sh, columns) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, columns.length).getValues();
  return values.map(function (r) {
    var o = {};
    columns.forEach(function (c, i) { o[c] = r[i]; });
    return o;
  });
}

// Columns written as plain text: 16-digit IDs exceed Sheets' 15-digit number precision,
// and ISO dates would otherwise be auto-converted to Date objects.
var TEXT_COLUMNS = ['orderId', 'orderDate', 'status', 'statusText', 'storeName', 'currency', 'tracking', 'sources', 'hasDetails',
  'firstSeenAt', 'updatedAt', 'orderUrl', 'totalsCheck', 'title', 'variant', 'productId', 'titleTruncated', 'lineId', 'imageUrl', 'productUrl', 'syncedAt', 'source'];

function writeRows_(sh, columns, rows) {
  sh.clearContents();
  var data = [columns].concat(rows.map(function (o) { return columns.map(function (c) { return o[c] == null ? '' : o[c]; }); }));
  columns.forEach(function (c, i) {
    if (TEXT_COLUMNS.indexOf(c) >= 0) sh.getRange(1, i + 1, Math.max(data.length, 2), 1).setNumberFormat('@');
  });
  sh.getRange(1, 1, data.length, columns.length).setValues(data);
  sh.setFrozenRows(1);
}

function orderRow_(o) {
  var items = o.items || [];
  return {
    orderId: String(o.orderId), orderDate: o.orderDate || '', status: o.status || '', statusText: o.statusText || '',
    storeName: o.storeName || '', itemCount: items.length,
    units: items.reduce(function (n, it) { return n + (it.quantity || 0); }, 0),
    currency: o.currency || '',
    itemsSubtotal: o.itemsSubtotal == null ? '' : o.itemsSubtotal, subtotal: o.subtotal == null ? '' : o.subtotal,
    shipping: o.shipping == null ? '' : o.shipping, tax: o.tax == null ? '' : o.tax, discount: o.discount == null ? '' : o.discount,
    total: o.total == null ? '' : o.total, totalsCheck: o.totalsCheck || '',
    tracking: (o.tracking || []).map(function (t) { return t.number; }).join(' '),
    sources: (o.sources || []).join(', '), hasDetails: o.detailFetchedAt ? 'yes' : 'no',
    firstSeenAt: o.firstSeenAt || '', updatedAt: o.updatedAt || '',
    orderUrl: o.orderUrl || ('https://www.aliexpress.com/p/order/detail.html?orderId=' + o.orderId),
  };
}

function itemRow_(o, it) {
  return {
    orderId: String(o.orderId), orderDate: o.orderDate || '', status: o.status || '', title: it.title || '', variant: it.variant || '',
    quantity: it.quantity == null ? '' : it.quantity, unitPrice: it.unitPrice == null ? '' : it.unitPrice,
    lineTotal: it.lineTotal == null ? '' : it.lineTotal, landedUnitCost: it.landedUnitCost == null ? '' : it.landedUnitCost, productId: it.productId ? String(it.productId) : '',
    titleTruncated: it.titleTruncated ? 'yes' : '', lineId: it.lineId || '', imageUrl: it.imageUrl || '', productUrl: it.productUrl || '',
  };
}

function applyPayload_(ss, payload) {
  var ordersSh = sheet_(ss, 'Orders', ORDER_COLUMNS);
  var itemsSh = sheet_(ss, 'Items', ITEM_COLUMNS);
  var logSh = sheet_(ss, 'Sync log', LOG_COLUMNS);

  var orders = {};
  readRows_(ordersSh, ORDER_COLUMNS).forEach(function (r) { if (r.orderId) orders[String(r.orderId)] = r; });
  var items = readRows_(itemsSh, ITEM_COLUMNS).filter(function (r) { return r.lineId; });

  var removed = 0, upserted = 0;
  payload.orders.forEach(function (o) {
    var id = String(o.orderId);
    var cancelled = o.cancelled || o.status === 'closed';
    if (cancelled) {
      if (orders[id]) removed++;
      delete orders[id];
      items = items.filter(function (r) { return String(r.orderId) !== id; });
      return;
    }
    orders[id] = orderRow_(o);
    upserted++;
    // Replace this order's lines only when the payload carries lines (stubs keep what we have).
    if ((o.items || []).length) {
      items = items.filter(function (r) { return String(r.orderId) !== id; });
      o.items.forEach(function (it) { items.push(itemRow_(o, it)); });
    }
  });

  // Keep item status/date in step with the order row.
  items.forEach(function (r) {
    var ord = orders[String(r.orderId)];
    if (ord) { r.status = ord.status; r.orderDate = ord.orderDate; }
  });

  // timesOrdered: how many orders contain the same product (by productId, else title).
  var counts = {};
  var keyOf = function (r) { return r.productId ? 'p:' + r.productId : 't:' + String(r.title).toLowerCase(); };
  items.forEach(function (r) { var k = keyOf(r); counts[k] = counts[k] || {}; counts[k][r.orderId] = true; });
  items.forEach(function (r) {
    r.timesOrdered = Object.keys(counts[keyOf(r)]).length;
    r.Image = r.imageUrl ? '=IMAGE("' + String(r.imageUrl).replace(/"/g, '') + '")' : '';
  });

  var orderRows = Object.keys(orders).map(function (k) { return orders[k]; });
  var byDateDesc = function (a, b) {
    var d = String(b.orderDate).localeCompare(String(a.orderDate));
    return d || String(b.orderId).localeCompare(String(a.orderId));
  };
  orderRows.sort(byDateDesc);
  items.sort(byDateDesc);

  writeRows_(ordersSh, ORDER_COLUMNS, orderRows);
  writeRows_(itemsSh, ITEM_COLUMNS, items);
  if (items.length && itemsSh.setRowHeights) itemsSh.setRowHeights(2, items.length, 48);

  logSh.appendRow([new Date().toISOString(), payload.source || '', payload.orders.length, upserted, removed, orderRows.length, items.length]);
  return { ok: true, received: payload.orders.length, upserted: upserted, removed: removed, orders: orderRows.length, items: items.length };
}

/**
 * Run once from the Apps Script editor (function dropdown → setupSheets → Run).
 * Creates the Orders / Items / Sync log tabs with headers, formats and widths.
 * Existing tabs keep their data; other tabs (e.g. Sheet1) are not touched.
 */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [['Orders', ORDER_COLUMNS], ['Items', ITEM_COLUMNS], ['Sync log', LOG_COLUMNS]].forEach(function (t) {
    var name = t[0], columns = t[1];
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() <= 1) sh.getRange(1, 1, 1, columns.length).setValues([columns]);
    sh.getRange(1, 1, 1, columns.length).setFontWeight('bold').setBackground('#f3f4f6');
    sh.setFrozenRows(1);
    columns.forEach(function (c, i) {
      if (TEXT_COLUMNS.indexOf(c) >= 0) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
      if (c === 'title') sh.setColumnWidth(i + 1, 360);
      if (c === 'Image') sh.setColumnWidth(i + 1, 60);
    });
  });
  Logger.log('Tabs ready: Orders, Items, Sync log');
}
