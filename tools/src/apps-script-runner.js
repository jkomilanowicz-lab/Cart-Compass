/**
 * AliExpress → JSON backfill from Gmail (Google Apps Script).
 *
 * Setup: script.google.com → New project → paste this whole file (Code.gs) → Run `exportAliExpressOrders`
 * → authorize. It writes "aliexpress-orders-gmail-YYYY-MM-DD.json" to your Google Drive root.
 * Import that file in the extension popup ("Import JSON"), or use it directly.
 * Optional: run `installDailyTrigger` once to refresh the file every day.
 */
// Order emails, plus refund confirmations (sent from the promotions address).
var QUERY = '(from:(transaction@notice.aliexpress.com) OR (from:(aliexpress.com) subject:refund)) newer_than:5y';

function exportAliExpressOrders() {
  var map = {};
  var start = 0, page = 100, threads;
  var confirmations = [], statuses = [];
  do {
    threads = GmailApp.search(QUERY, start, page);
    threads.forEach(function (t) {
      t.getMessages().forEach(function (m) {
        var msg = { subject: m.getSubject(), date: m.getDate().toISOString(), body: null, _m: m };
        var s = AEX.parseSubject(msg.subject);
        if (!s) return;
        if (/^confirmed/.test(s.kind)) confirmations.push(msg); else statuses.push(msg);
      });
    });
    start += page;
  } while (threads.length === page);

  // Oldest first so later status emails win.
  confirmations.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  statuses.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  confirmations.forEach(function (msg) {
    msg.body = msg._m.getBody();
    AEX.mergeInto(map, AEX.parseConfirmationEmail(msg));
  });
  statuses.forEach(function (msg) {
    // Late-shipment and refund emails name the order only in the body.
    if (AEX.parseSubject(msg.subject).needsBody) msg.body = msg._m.getBody();
    // Status emails for orders we never saw confirmed still create a stub order.
    AEX.mergeInto(map, AEX.parseStatusEmail(msg));
  });

  var orders = Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) { return String(b.orderDate).localeCompare(String(a.orderDate)); });
  var json = JSON.stringify(AEX.buildPayload(orders, 'gmail-apps-script'), null, 2);
  var name = 'aliexpress-orders-gmail-' + new Date().toISOString().slice(0, 10) + '.json';
  var file = DriveApp.createFile(name, json, MimeType.PLAIN_TEXT);
  Logger.log('Wrote ' + orders.length + ' orders to Drive: ' + file.getUrl());
}

function installDailyTrigger() {
  ScriptApp.newTrigger('exportAliExpressOrders').timeBased().everyDays(1).atHour(6).create();
}
