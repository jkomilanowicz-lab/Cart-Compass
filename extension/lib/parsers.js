/*
 * DOM parsers for AliExpress order pages. Depends on core.js (AEX.*).
 *
 * AliExpress changes class names regularly, so every field uses a list of
 * known selectors first and falls back to text/URL heuristics. If parsing
 * breaks, use "Copy page sample" in the popup (or AEX.debugSample()) and
 * update the SELECTORS below.
 */
(function (root) {
  'use strict';
  const AEX = root.AEX || (typeof require === 'function' ? require('./core.js') : null);

  const SELECTORS = {
    orderCard: ['.order-item', '[class*="order-item--"]', '[data-pl="order_item"]'],
    orderHeader: ['.order-item-header', '[class*="order-item-header"]'],
    orderStatus: ['.order-item-header-status-text', '.order-item-header-status', '[class*="status-text"]'],
    storeName: ['.order-item-store-name', '[class*="store-name"]', 'a[href*="/store/"]'],
    itemRow: ['.order-item-content-body', '[class*="order-item-content-body"]', '.order-item-content-info'],
    itemTitle: ['.order-item-content-info-name', '[class*="info-name"]', '[class*="item-title"]'],
    itemSku: ['.order-item-content-info-sku', '[class*="info-sku"]', '[class*="sku"]'],
    itemNumber: ['.order-item-content-info-number', '[class*="info-number"]'],
    orderTotal: ['.order-item-content-opt-price-total', '[class*="price-total"]', '[class*="opt-price"]'],
    loadMore: ['.order-more button', '.order-more', '[class*="order-more"] button'],
    // "Delete order" control on a finished order card (usually a trash icon in the header).
    deleteOrder: ['.order-item-header-right-delete', '[class*="header-delete"]', '[class*="order-delete"]', '[class*="delete-order"]', '[class*="trash"]', '[class*="delete"]'],
    // Confirmation dialog that follows it.
    dialog: ['[role="dialog"]', '[role="alertdialog"]', '.comet-modal', '[class*="modal"]', '[class*="dialog"]', '[class*="popconfirm"]', '[class*="popover"]'],
    // Detail page
    detailItem: ['.order-detail-item-content', '[class*="order-detail-item-content"]', '[class*="item-content"]'],
    detailTitle: ['.item-title', '[class*="item-title"]'],
    detailSku: ['.item-sku-attr', '[class*="sku-attr"]', '[class*="item-sku"]'],
    detailPrice: ['.item-price', '[class*="item-price"]'],
    detailQty: ['.item-quantity', '[class*="quantity"]', '[class*="item-num"]'],
    detailStatus: ['.order-block-title', '.order-status', '[class*="status-title"]', '[class*="order-status"]'],
    detailStore: ['.store-name', '[class*="store-name"]', 'a[href*="/store/"]'],
    detailTracking: ['[class*="tracking"]', '[class*="logistic"]', '[class*="track"]'],
  };

  // A money amount must carry a currency marker, so stray numbers near words like
  // "Shipping" or "Total" (dates, counts, tracking digits) are never taken as prices.
  const MONEY = '(?:(?:US\\s*\\$|C\\$|CA\\$|A\\$|AU\\$|R\\$|\\$|€|£|¥|₩|₽)\\s*\\d[\\d.,]*|\\d[\\d.,]*\\s*(?:USD|EUR|GBP|CAD|AUD|PLN|zł|€))';
  // The grand total is the last "Total" on the page; "Total tax"/"Total items" are not it.
  const TOTAL_RE = new RegExp('(?:\\bOrder\\s*total|\\bGrand\\s*total|\\bTotal(?!\\s*(?:tax|discount|savings|items?\\b)))\\s*[:：]?\\s*(' + MONEY + ')', 'gi');
  const lastMatch = (text, re) => { let m, last = null; re.lastIndex = 0; while ((m = re.exec(text))) last = m; return last; };
  const sumMatches = (text, re) => {
    let m, sum = 0, found = false;
    re.lastIndex = 0;
    while ((m = re.exec(text))) { const v = AEX.parseMoney(m[1].replace(/^-\s*/, '')); if (v) { sum += v.amount; found = true; } }
    return found ? Math.round(sum * 100) / 100 : null;
  };
  const SUBTOTAL_RE = new RegExp('\\b(?:Subtotal|Sub-total|Items?\\s*(?:sub)?total|Merchandise\\s*(?:sub)?total)\\s*[:：]?\\s*(' + MONEY + ')', 'i');
  const TAX_RE = new RegExp('\\b(?:Additional\\s*charges?|(?:Estimated\\s*)?(?:Sales\\s*|Import\\s*)?(?:Tax(?:es)?|VAT|GST))(?:\\s*\\([^)]{0,30}\\))?\\s*[:：]?\\s*(' + MONEY + ')', 'gi');
  const DISCOUNT_RE = new RegExp('\\b(?:(?:Store|Seller|AliExpress|Shipping)\\s*)?(?:Discounts?|Coupons?|Promo(?:tion)?s?|Savings?|Coins?)(?:\\s*(?:code|applied))?\\s*[:：]?\\s*(-?\\s*' + MONEY + ')', 'gi');
  const SHIPPING_RE = new RegExp('\\bShipping(?:\\s*(?:fee|cost|charge)s?)?\\s*[:：]?\\s*(Free|' + MONEY + ')', 'i');

  function q(el, list) {
    for (const s of list) {
      try {
        const r = el.querySelector(s);
        if (r) return r;
      } catch (_) { /* invalid selector in this engine */ }
    }
    return null;
  }
  function qa(el, list) {
    for (const s of list) {
      try {
        const r = el.querySelectorAll(s);
        if (r.length) return Array.from(r);
      } catch (_) { /* ignore */ }
    }
    return [];
  }
  const txt = (el) => (el ? AEX.cleanText(el.textContent) : '');
  // Like txt(), but separates text from different elements with spaces
  // ("Free</div><div>Total" → "Free Total") so word-boundary regexes work.
  // Text of an element with spaces only between block-level pieces. Inline pieces
  // (spans etc.) are joined directly, because AliExpress renders prices one digit per
  // span: <span>1</span><span>1</span><span>3</span><span>.</span><span>19</span>.
  const INLINE = /^(SPAN|B|I|EM|STRONG|SMALL|SUP|SUB|FONT|LABEL|A|BDI|BDO|S|U|MARK|ABBR|CODE|TIME|DATA)$/;
  function spacedText(el) {
    if (!el) return '';
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|SVG|TEMPLATE)$/i.test(node.tagName)) return;
      const block = !INLINE.test(node.tagName);
      if (block) parts.push(' ');
      for (const c of node.childNodes) walk(c);
      if (block) parts.push(' ');
    };
    walk(el);
    return normalizeMoneyText(AEX.cleanText(parts.join('')));
  }

  // Repair amounts that still came out split ("US $ 1 13 . 19", "$5 .18") when
  // digits sit in block-level boxes. Only touches digit runs right after a currency sign.
  function normalizeMoneyText(t) {
    return t.replace(/((?:US\s*)?(?:C|CA|A|AU|R)?[$€£¥₩₽])\s*(\d[\d.,]*(?:\s+[\d.,]+){0,8})/g, (m, cur, num) => {
      const tokens = num.split(/\s+/);
      let out = tokens[0];
      let used = 1;
      // Append following fragments only while they continue the same amount, and stop
      // once a 2-digit decimal part is complete ("5.18 2 items" stays "5.18").
      while (used < tokens.length && !/[.,]\d{2}$/.test(out)) {
        const next = tokens[used];
        const cand = out + next;
        if (!/^\d[\d.,]*$/.test(cand) || /[.,]{2}/.test(cand) || !/^(\d|[.,]|[.,]?\d{1,2}|\d{3})$/.test(next)) break;
        out = cand;
        used++;
      }
      return `${cur}${out}` + (used < tokens.length ? ' ' + tokens.slice(used).join(' ') : '') + ' ';
    }).replace(/\s+/g, ' ').trim();
  }



  function imageFrom(el) {
    if (!el) return null;
    const img = el.querySelector('img');
    if (img) return img.getAttribute('src') || img.getAttribute('data-src') || null;
    const bgEl = [el, ...el.querySelectorAll('[style*="background"]')].find((e) => /url\(/.test(e.getAttribute && e.getAttribute('style') || ''));
    if (bgEl) {
      const m = bgEl.getAttribute('style').match(/url\(["']?([^"')]+)["']?\)/);
      if (m) return m[1];
    }
    return null;
  }

  // ---------------- Order list page ----------------

  /** Find order card elements; falls back to grouping by detail links. */
  function findOrderCards(doc) {
    let cards = qa(doc, SELECTORS.orderCard).filter((c) => !c.parentElement || !c.parentElement.closest(SELECTORS.orderCard[0]));
    if (cards.length) return cards;
    // Fallback: smallest ancestor of each orderId link that contains only that orderId.
    const byId = new Map();
    for (const a of doc.querySelectorAll('a[href*="orderId="]')) {
      const id = AEX.orderIdFromUrl(a.getAttribute('href'));
      if (!id || byId.has(id)) continue;
      let node = a;
      while (node.parentElement) {
        const parent = node.parentElement;
        const ids = new Set(Array.from(parent.querySelectorAll('a[href*="orderId="]')).map((x) => AEX.orderIdFromUrl(x.getAttribute('href'))));
        if (ids.size > 1) break;
        node = parent;
      }
      byId.set(id, node);
    }
    return Array.from(byId.values());
  }

  function parseListItem(row) {
    const link = row.querySelector('a[href*="/item/"]');
    const titleEl = q(row, SELECTORS.itemTitle);
    let title = txt(titleEl) || (link && (link.getAttribute('title') || txt(link))) || '';
    const variant = txt(q(row, SELECTORS.itemSku));
    const numberText = txt(q(row, SELECTORS.itemNumber)) || txt(row);
    const quantity = AEX.parseQuantity((numberText.match(/[x×]\s*\d+/i) || [numberText])[0]) || 1;
    const price = AEX.parseMoney(numberText.replace(/[x×]\s*\d+\s*$/i, ''));
    return {
      title,
      variant,
      quantity,
      unitPrice: price ? price.amount : null,
      currency: price ? price.currency : null,
      productUrl: link ? link.href || link.getAttribute('href') : null,
      productId: link ? AEX.productIdFromUrl(link.getAttribute('href')) : null,
      imageUrl: imageFrom(row),
    };
  }

  function parseOrderCard(card) {
    const all = spacedText(card);
    const header = q(card, SELECTORS.orderHeader) || card;
    const headerText = txt(header);
    let orderId = (headerText.match(/Order\s*(?:ID|No\.?|number)\s*[:：]?\s*(\d{10,})/i) || all.match(/Order\s*(?:ID|No\.?|number)\s*[:：]?\s*(\d{10,})/i) || [])[1];
    if (!orderId) {
      const a = card.querySelector('a[href*="orderId="]');
      orderId = a && AEX.orderIdFromUrl(a.getAttribute('href'));
    }
    if (!orderId) return null;
    const dateMatch = headerText.match(/(?:Order\s*date|Placed\s*on|Date)\s*[:：]?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/i);
    const statusEl = q(card, SELECTORS.orderStatus);
    let statusText = txt(statusEl);
    if (!statusText) {
      const m = headerText.match(/(Awaiting [a-z]+|Completed|Closed|Shipped|Delivered|Cancelled|Canceled|Processing|To ship|To pay|To receive|In transit)/i);
      statusText = m ? m[1] : '';
    }
    const storeEl = q(card, SELECTORS.storeName);
    const totalEl = q(card, SELECTORS.orderTotal);
    const totalMoney = AEX.parseMoney(txt(totalEl) || ((lastMatch(all, TOTAL_RE) || [])[1]));

    let rows = qa(card, SELECTORS.itemRow);
    if (!rows.length) {
      // One row per distinct product link.
      const seen = new Set();
      rows = Array.from(card.querySelectorAll('a[href*="/item/"]'))
        .filter((a) => { const id = AEX.productIdFromUrl(a.getAttribute('href')); if (!id || seen.has(id)) return false; seen.add(id); return true; })
        .map((a) => a.closest('[class*="content"]') || a.parentElement);
    }
    const items = rows.map(parseListItem).filter((it) => it.title || it.productId);

    return {
      orderId,
      orderDate: dateMatch ? AEX.parseDate(dateMatch[1]) : null,
      statusText,
      storeName: storeEl ? (txt(storeEl).replace(/\s*>\s*$/, '')) : null,
      storeUrl: storeEl && storeEl.closest('a[href*="/store/"]') ? storeEl.closest('a[href*="/store/"]').href : null,
      total: totalMoney ? totalMoney.amount : null,
      currency: (totalMoney && totalMoney.currency) || (items[0] && items[0].currency) || null,
      items,
    };
  }

  /** Parse every order currently rendered on the order list page. */
  function parseOrderList(doc) {
    const out = [];
    const errors = [];
    for (const card of findOrderCards(doc || document)) {
      try {
        const raw = parseOrderCard(card);
        if (raw) out.push(AEX.normalizeOrder(raw, 'web-list'));
      } catch (e) {
        errors.push(String(e && e.message || e));
      }
    }
    // De-dupe (fallback grouping can yield the same order twice).
    const map = {};
    AEX.mergeInto(map, out);
    return { orders: Object.values(map), errors };
  }

  function findLoadMoreButton(doc) {
    const direct = q(doc, SELECTORS.loadMore);
    if (direct) return direct.tagName === 'BUTTON' ? direct : direct.querySelector('button') || direct;
    return Array.from(doc.querySelectorAll('button, [role="button"]'))
      .find((b) => /^(view|load|show)\s+(more\s+)?orders?$|^view more$|^load more$/i.test(txt(b))) || null;
  }

  // ---------------- Order detail page ----------------

  function parseOrderDetail(doc, url) {
    doc = doc || document;
    const all = spacedText(doc.body);
    const orderId = AEX.orderIdFromUrl(url || (doc.location && doc.location.href)) ||
      (all.match(/Order\s*(?:ID|No\.?|number)\s*[:：]?\s*(\d{10,})/i) || [])[1];
    if (!orderId) return null;

    let rows = qa(doc, SELECTORS.detailItem).filter((r) => r.querySelector('a[href*="/item/"]') || q(r, SELECTORS.detailTitle));
    if (!rows.length) {
      const seen = new Set();
      rows = Array.from(doc.querySelectorAll('a[href*="/item/"]'))
        .filter((a) => { const id = AEX.productIdFromUrl(a.getAttribute('href')); if (!id || seen.has(id)) return false; seen.add(id); return true; })
        .map((a) => a.closest('[class*="item"]') || a.parentElement);
    }
    const items = rows.map((row) => {
      const link = row.querySelector('a[href*="/item/"]');
      const priceText = txt(q(row, SELECTORS.detailPrice));
      const qtyText = txt(q(row, SELECTORS.detailQty)) || priceText || txt(row);
      const price = AEX.parseMoney(priceText.replace(/[x×]\s*\d+\s*$/i, ''));
      return {
        title: txt(q(row, SELECTORS.detailTitle)) || (link && (link.getAttribute('title') || txt(link))),
        variant: txt(q(row, SELECTORS.detailSku)),
        quantity: AEX.parseQuantity(qtyText) || 1,
        unitPrice: price ? price.amount : null,
        productUrl: link ? link.href || link.getAttribute('href') : null,
        productId: link ? AEX.productIdFromUrl(link.getAttribute('href')) : null,
        imageUrl: imageFrom(row),
        _currency: price && price.currency,
      };
    }).filter((it) => it.title || it.productId);

    const dateM = all.match(/(?:Order\s*(?:time|date)|Placed\s*on|Paid\s*on)\s*[:：]?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/i);
    const totalM = lastMatch(all, TOTAL_RE);
    const shipM = all.match(SHIPPING_RE);
    const subM = all.match(SUBTOTAL_RE);
    const subtotal = subM ? AEX.parseMoney(subM[1]) : null;
    const tax = sumMatches(all, TAX_RE);
    const discount = sumMatches(all, DISCOUNT_RE);
    let total = totalM ? AEX.parseMoney(totalM[1]) : null;
    // A total far below the item prices was mis-read (e.g. split digits); drop it so the
    // order-list total is kept instead.
    const itemSum = items.reduce((n, it) => n + (it.unitPrice || 0) * (it.quantity || 1), 0);
    if (total && itemSum && total.amount < itemSum * 0.5) total = null;
    const shipping = shipM ? (/free/i.test(shipM[1]) ? { amount: 0 } : AEX.parseMoney(shipM[1])) : null;

    const tracking = [];
    const trackRe = /(?:Tracking\s*(?:number|no\.?|ID)|Logistics\s*number)\s*[:：]?\s*([A-Z0-9]{8,30})/gi;
    let tm;
    while ((tm = trackRe.exec(all))) if (!tracking.some((t) => t.number === tm[1])) tracking.push({ number: tm[1], carrier: null });

    const storeEl = q(doc, SELECTORS.detailStore);
    const statusText = txt(q(doc, SELECTORS.detailStatus));
    return AEX.normalizeOrder({
      orderId,
      orderDate: dateM ? AEX.parseDate(dateM[1]) : null,
      statusText,
      storeName: storeEl ? txt(storeEl) : null,
      storeUrl: storeEl && storeEl.closest('a[href*="/store/"]') ? storeEl.closest('a[href*="/store/"]').href : null,
      total: total ? total.amount : null,
      currency: (total && total.currency) || (items[0] && items[0]._currency) || null,
      shipping: shipping ? shipping.amount : null,
      subtotal: subtotal ? subtotal.amount : null,
      tax,
      discount,
      items: items.map(({ _currency, ...it }) => it),
      tracking,
      detailFetchedAt: new Date().toISOString(),
    }, 'web-detail');
  }

  /**
   * Compact structural sample of the page (class names + short text, no
   * attributes besides href/class) to help fix selectors. Strips personal
   * address blocks by dropping text that looks like an address/phone.
   */
  function debugSample(doc, maxChars = 60000) {
    doc = doc || document;
    const lines = [];
    const walk = (el, depth) => {
      if (lines.join('\n').length > maxChars || depth > 40) return;
      if (/^(SCRIPT|STYLE|SVG|NOSCRIPT|PATH|LINK|META)$/i.test(el.tagName)) return;
      const cls = (el.getAttribute('class') || '').trim().split(/\s+/).slice(0, 3).join('.');
      const href = el.tagName === 'A' ? ` href="${(el.getAttribute('href') || '').split('&')[0].slice(0, 100)}"` : '';
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 80)
        .replace(/\+?\d[\d\s()-]{8,}\d/g, '[phone]');
      lines.push(`${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${cls ? ' .' + cls : ''}${href}>${own ? ' ' + own : ''}`);
      for (const c of el.children) walk(c, depth + 1);
    };
    // Price/receipt sections first, so they are never cut off by the size limit.
    const priceLabels = Array.from(doc.querySelectorAll('body *')).filter((el) =>
      /^(sub-?total|total|order total|shipping|tax|additional charges?|coins?|discount|coupon|receipt|invoice)\b/i.test(
        Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim()));
    const seen = new Set();
    for (const lbl of priceLabels.slice(0, 12)) {
      let box = lbl;
      for (let i = 0; i < 3 && box.parentElement; i++) box = box.parentElement;
      if (seen.has(box) || [...seen].some((s) => s.contains(box))) continue;
      seen.add(box);
      lines.push('=== price section ===');
      walk(box, 0);
    }
    lines.push('=== page ===');
    const start = q(doc, SELECTORS.orderCard) ? q(doc, SELECTORS.orderCard).parentElement : doc.body;
    walk(start, 0);
    return lines.join('\n').slice(0, maxChars);
  }

  // ---------- order list clean-up (delete finished orders from the online list) ----------

  const DELETE_WORDS = /^(delete|delete order|remove|remove order|trash)$/i;
  function isVisible(el) {
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
      const cs = view && view.getComputedStyle ? view.getComputedStyle(n) : n.style;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    }
    return true;
  }
  const qaAll = (el, list) => {
    const out = new Set();
    for (const s of list) { try { el.querySelectorAll(s).forEach((x) => out.add(x)); } catch (_) { /* ignore */ } }
    return Array.from(out);
  };

  /**
   * The delete control inside an order card, or null.
   * allowHidden also accepts a control that is only shown on hover (clicking it still works).
   */
  function findDeleteControl(card, { allowHidden = false } = {}) {
    const labelled = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt')].some((v) => v && /\b(delete|remove|trash)\b/i.test(v));
    const candidates = qaAll(card, SELECTORS.deleteOrder);
    for (const el of card.querySelectorAll('button, a, span, i, div, img, svg, [role="button"]')) {
      if (labelled(el) || (el.children.length === 0 && DELETE_WORDS.test(txt(el)))) candidates.push(el);
    }
    for (const el of candidates) {
      if (!allowHidden && !isVisible(el)) continue;
      // Never pick a control that also holds item/price content (an over-broad class match).
      // Prices ("price-deleted" strike-through) carry digits; a delete control doesn't.
      if (el.querySelector('a[href*="/item/"], img[src*="alicdn"]') || txt(el).length > 30 || /\d/.test(txt(el))) continue;
      const clickable = el.closest('button, a, [role="button"]');
      return clickable && card.contains(clickable) ? clickable : el;
    }
    return null;
  }

  /** The confirm button of an open "Delete this order?" dialog, or null. */
  function findConfirmButton(doc) {
    const dialogs = qaAll(doc, SELECTORS.dialog).filter(isVisible);
    for (const d of dialogs.reverse()) { // the newest dialog is usually last in the DOM
      const btn = Array.from(d.querySelectorAll('button, [role="button"], a')).filter(isVisible)
        .find((b) => /^(delete|confirm|ok|yes|remove|yes,? delete)$/i.test(txt(b)));
      if (btn) return btn;
    }
    return null;
  }

  const api = { SELECTORS, parseOrderList, parseOrderCard, findOrderCards, findLoadMoreButton, findDeleteControl, findConfirmButton, parseOrderDetail, debugSample };
  root.AEX = Object.assign(root.AEX || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
