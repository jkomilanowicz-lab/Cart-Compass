/*
 * Re-order guard: on product, cart and checkout pages, show what you've
 * already ordered.
 */
(function () {
  'use strict';
  if (window.__aexReorderLoaded) return;
  window.__aexReorderLoaded = true;

  // After the extension is updated or reloaded, scripts already running in open tabs can no longer
  // reach it ("Extension context invalidated"). Detect that and go quiet instead of throwing.
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  const send = (msg) => new Promise((resolve) => {
    if (!alive()) return resolve(null);
    try {
      chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r && r.ok ? r.result : null); });
    } catch (_) {
      resolve(null);
    }
  });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STATUS_LABEL = { processing: 'processing', shipped: 'in transit', completed: 'received', awaiting_payment: 'unpaid', dispute: 'dispute', unknown: '?' };

  const isProductPage = /\/item\//.test(location.pathname);

  // ---------- product page panel ----------

  function productTitle() {
    const h1 = document.querySelector('h1, [data-pl="product-title"]');
    return AEX.cleanText(h1 ? h1.textContent : document.title.replace(/\s*-\s*AliExpress.*$/i, ''));
  }



  async function renderProductPanel() {
    const productId = AEX.productIdFromUrl(location.href);
    if (!productId) return;
    const title = productTitle();
    const res = await send({ type: 'history', productIds: [productId], titles: { [productId]: title }, title, withStock: true });
    if (!res || !res.hasData) return;
    const { exact, similar } = res.perProduct[productId];
    const likely = res.perProduct[productId].likely || { units: 0, orders: 0, inTransitUnits: 0 };
    const expired = res.perProduct[productId].expired || [];
    if (!exact.units && !similar.length && !expired.length) return;

    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const inTransit = exact.inTransitUnits + likely.inTransitUnits;
    const level = inTransit || expired.length ? 'warn' : (exact.units || likely.units) ? 'info' : 'soft';
    const day = (iso) => (iso ? String(iso).slice(0, 10) : '?');
    // Orders of this product that the seller never shipped: nothing is coming, a refund is due.
    const expiredHtml = expired.map((e) => `<div class="aex-alert">Never shipped: your order of ×${esc(e.quantity || 1)}${e.variant ? ` (${esc(e.variant)})` : ''} on ${esc(e.orderDate || '?')} expired, the seller didn't ship in time. ${
      e.refundedAt ? `Refunded ${esc(day(e.refundedAt))}.` : `Refund expected by ${esc(day(e.refundDueAt))}.`}</div>`).join('');
    const lines = exact.lines.slice(0, 6).map((l) =>
      `<li><b>×${esc(l.quantity)}</b> ${esc(l.variant || '')} <span class="aex-muted">${esc(l.orderDate || '')} · ${esc(STATUS_LABEL[l.status] || l.status)}</span></li>`).join('');
    const simLi = (s) =>
      `<li><a href="https://www.aliexpress.com/p/order/detail.html?orderId=${esc(s.orderId)}" target="_blank">${esc(s.title)}</a> <b>×${esc(s.quantity)}</b> <span class="aex-muted">${esc(s.orderDate || '')} · ${esc(STATUS_LABEL[s.status] || s.status)}${s.codes && s.codes.length ? ` · matches ${esc(s.codes.join(', ').toUpperCase())}` : ''}</span></li>`;
    const same = similar.filter((s) => s.likelySame).map(simLi).join('');
    const sim = similar.filter((s) => !s.likelySame).map(simLi).join('');

    const heading = exact.units
      ? `You've ordered this before: <b>${exact.units}</b> unit${exact.units === 1 ? '' : 's'} in ${plural(exact.orders, 'order')}`
      : likely.units
        ? `You've likely ordered this from another store: <b>${likely.units}</b> unit${likely.units === 1 ? '' : 's'} in ${plural(likely.orders, 'order')}`
        : expired.length ? 'You tried to order this before' : 'Possibly similar to things you ordered';

    const panel = document.createElement('div');
    panel.className = `aex-panel aex-${level}`;
    panel.innerHTML = `
      <button class="aex-close" title="Hide">×</button>
      <div class="aex-title">${heading}</div>
      ${expiredHtml}
      ${inTransit ? `<div class="aex-alert">${inTransit} still on the way</div>` : ''}
      ${lines ? `<ul>${lines}</ul>` : ''}
      ${same ? `<div class="aex-section"><div class="aex-h">Same item from other stores${exact.units && likely.units ? ` (${likely.units} more)` : ''}</div><ul>${same}</ul></div>` : ''}
      ${sim ? `<div class="aex-section"><div class="aex-h">Similar items you ordered</div><ul>${sim}</ul></div>` : ''}`;
    panel.querySelector('.aex-close').onclick = () => panel.remove();
    document.documentElement.appendChild(panel);
  }

  // ---------- cart / checkout badges ----------

  async function badgeLinks() {
    const links = Array.from(document.querySelectorAll('a[href*="/item/"]:not([data-aex])'));
    if (!links.length) return;
    const byId = new Map();
    for (const a of links) {
      a.setAttribute('data-aex', '1');
      const id = AEX.productIdFromUrl(a.getAttribute('href'));
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(a);
    }
    if (!byId.size) return;
    const titles = {};
    for (const [id, as] of byId) titles[id] = AEX.cleanText(as.map((a) => a.getAttribute('title') || a.textContent).join(' ')).slice(0, 200);
    const res = await send({ type: 'history', productIds: [...byId.keys()], titles });
    if (!res) return;
    for (const [id, as] of byId) {
      const { exact, likely, similar } = res.perProduct[id] || {};
      const useLikely = !(exact && exact.units) && likely && likely.units;
      if (!(exact && exact.units) && !useLikely) continue;
      // Badge only the link that carries text (not the image link) to avoid duplicates.
      const target = as.find((a) => AEX.cleanText(a.textContent)) || as[0];
      const h = useLikely ? likely : exact;
      const b = document.createElement('span');
      b.className = 'aex-badge' + (h.inTransitUnits ? ' aex-badge-warn' : '') + (useLikely ? ' aex-badge-likely' : '');
      b.textContent = `${useLikely ? 'Likely ordered (other store)' : 'Ordered'} ${h.units}× before${h.inTransitUnits ? ` · ${h.inTransitUnits} in transit` : ''}`;
      b.title = useLikely
        ? similar.filter((s) => s.likelySame).map((s) => `${s.orderDate || ''} ×${s.quantity} ${s.title} (${s.status})`).join('\n')
        : exact.lines.map((l) => `${l.orderDate || ''} ×${l.quantity} ${l.variant || ''} (${l.status})`).join('\n');
      target.insertAdjacentElement('afterend', b);
    }
  }

  if (isProductPage) {
    setTimeout(renderProductPanel, 1500);
  } else {
    let t;
    const observer = new MutationObserver(() => {
      if (!alive()) { observer.disconnect(); return; }
      clearTimeout(t);
      t = setTimeout(badgeLinks, 800);
    });
    observer
      .observe(document.body, { childList: true, subtree: true });
    setTimeout(badgeLinks, 1500);
  }
})();
