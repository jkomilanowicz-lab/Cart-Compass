/* Order detail page: parse once rendered and hand to the background worker. */
(function () {
  'use strict';
  if (window.__aexDetailLoaded) return;
  window.__aexDetailLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function run() {
    // The page is client-rendered: wait for product links to appear.
    for (let i = 0; i < 40 && !document.querySelector('a[href*="/item/"]'); i++) await sleep(500);
    await sleep(1000);
    await revealPriceDetails();
    let order = null;
    try {
      order = AEX.parseOrderDetail(document, location.href);
    } catch (e) {
      console.warn('[AEX] detail parse failed', e);
    }
    // The extension may have been reloaded since this page opened; then there's no one to tell.
    try { chrome.runtime.sendMessage({ type: 'detailParsed', order }).catch(() => {}); } catch (_) { /* context invalidated */ }
  }

  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();

  // The price breakdown (subtotal, coins, "Additional charges" = tax) is collapsed behind an
  // arrow, and a "Receipt" button opens an in-page invoice overlay. Open both before parsing.
  async function revealPriceDetails() {
    try {
      // 1. Expand collapsed sections near the order total.
      const totalLabel = Array.from(document.querySelectorAll('body *')).find((el) => /^(order\s*)?total\b/i.test(ownText(el)));
      let region = totalLabel;
      for (let i = 0; region && i < 5; i++) region = region.parentElement;
      if (region) {
        const toggles = region.querySelectorAll('[aria-expanded="false"], [class*="arrow" i], [class*="expand" i], [class*="fold" i], [class*="collapse" i]');
        for (const t of Array.from(toggles).slice(0, 6)) {
          if (t.closest('a[href]')) continue;
          t.click();
          await sleep(300);
        }
      }
      // 2. Open the receipt / invoice overlay if there is one.
      const receiptBtn = Array.from(document.querySelectorAll('button, [role="button"], a, span, div'))
        .find((el) => /^(view\s*)?(receipt|invoice)$/i.test((el.textContent || '').trim()) && el.children.length <= 2);
      if (receiptBtn && !(receiptBtn.tagName === 'A' && /^https?:/i.test(receiptBtn.getAttribute('href') || '') && !receiptBtn.getAttribute('href').includes('#'))) {
        receiptBtn.click();
        for (let i = 0; i < 10; i++) {
          await sleep(300);
          if (document.querySelector('[class*="receipt" i], [class*="invoice" i], [role="dialog"]')) break;
        }
        await sleep(500);
      }
    } catch (e) {
      console.warn('[AEX] could not expand price details', e);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'debugSample') { revealPriceDetails().then(() => sendResponse({ sample: AEX.debugSample(document) })); return true; }
    return false;
  });

  run();
})();
