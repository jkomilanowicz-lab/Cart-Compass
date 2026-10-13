/* Runner for the DevTools console snippet (appended after core.js + parsers.js). */
(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!/\/p\/order\/index\.html/.test(location.pathname)) {
    console.warn('[AEX] Open https://www.aliexpress.com/p/order/index.html first, then paste this again.');
    return;
  }
  const loadAll = confirm('AliExpress export: click OK to load ALL orders (clicks "View orders" repeatedly), or Cancel to export only what is on screen.');
  if (loadAll) {
    for (let round = 1; ; round++) {
      const btn = AEX.findLoadMoreButton(document);
      if (!btn) break;
      const before = AEX.findOrderCards(document).length;
      console.log(`[AEX] round ${round}: ${before} orders loaded, loading more…`);
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      let grew = false;
      for (let i = 0; i < 40 && !grew; i++) { await sleep(500); grew = AEX.findOrderCards(document).length > before; }
      if (!grew) break;
      await sleep(800);
    }
  }
  const { orders, errors } = AEX.parseOrderList(document);
  if (errors.length) console.warn('[AEX] parse errors:', errors);
  const save = (name, text, type) => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.appendChild(a); a.click(); a.remove();
  };
  const day = new Date().toISOString().slice(0, 10);
  save(`aliexpress-orders-${day}.json`, JSON.stringify(AEX.buildPayload(orders, 'console-snippet'), null, 2), 'application/json');
  save(`aliexpress-orders-${day}.csv`, AEX.toCSV(orders), 'text/csv');
  console.log(`[AEX] Exported ${orders.length} orders, ${orders.reduce((n, o) => n + o.items.length, 0)} lines.`);
  console.table(orders.slice(0, 20).map((o) => ({ orderId: o.orderId, date: o.orderDate, status: o.status, items: o.items.length, total: o.total })));
  window.AEX_LAST_EXPORT = orders;
  if (!orders.length || orders.some((o) => !o.items.length)) {
    console.warn('[AEX] Some orders had no items detected. Run  copy(AEX.debugSample())  and paste the clipboard to Claude to fix the selectors.');
  }
})();
