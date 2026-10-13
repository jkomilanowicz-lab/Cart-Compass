/*
 * Cart Compass — shared core.
 *
 * Plain script (no modules) so the same file loads in content scripts,
 * the MV3 service worker (importScripts), the DevTools console snippet,
 * and Node tests (module.exports).
 *
 * Canonical order shape (schemaVersion 1) — see docs/API.md:
 * {
 *   orderId, orderDate (YYYY-MM-DD|null), status (normalized), statusText,
 *   storeName, storeUrl, currency, total, shipping,
 *   items: [{ lineId, productId, skuId, title, variant, quantity, unitPrice,
 *             lineTotal, imageUrl, productUrl }],
 *   tracking: [{ number, carrier }],
 *   sources: ['web-list' | 'web-detail' | 'gmail' ...],
 *   detailFetchedAt, firstSeenAt, updatedAt
 * }
 */
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;

  // Ordered: first match wins.
  const STATUS_RULES = [
    [/await(ing)?\s+payment|pending payment|unpaid/i, 'awaiting_payment'],
    [/cancel|closed|refund(ed)?\b/i, 'closed'],
    [/dispute|return/i, 'dispute'],
    [/to ship|awaiting shipment|processing|confirmed|not shipped|ready/i, 'processing'],
    [/shipped|in transit|awaiting delivery|collected by (the )?carrier|out for delivery|awaiting receipt|to receive|on the way/i, 'shipped'],
    [/delivered|completed|finished|received|how did it go|to review/i, 'completed'],
  ];

  function normalizeStatus(text) {
    if (!text) return 'unknown';
    for (const [re, status] of STATUS_RULES) if (re.test(text)) return status;
    return 'unknown';
  }

  // Status precedence for merges: never move "backwards" because an older
  // source (e.g. an old confirmation email) is merged after a newer one.
  const STATUS_RANK = {
    unknown: 0, awaiting_payment: 1, processing: 2, shipped: 3, dispute: 4, completed: 5, closed: 6,
  };

  function cleanText(s) {
    return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  }

  const CURRENCY_SYMBOLS = [
    ['US $', 'USD'], ['US$', 'USD'], ['C$', 'CAD'], ['CA$', 'CAD'], ['A$', 'AUD'], ['AU$', 'AUD'],
    ['€', 'EUR'], ['£', 'GBP'], ['R$', 'BRL'], ['₽', 'RUB'], ['zł', 'PLN'], ['¥', 'JPY'], ['₩', 'KRW'],
    ['$', 'USD'],
  ];

  /** "US $1,234.56" -> { amount: 1234.56, currency: 'USD' } ; null when no number. */
  function parseMoney(text) {
    const s = cleanText(text);
    if (!s) return null;
    const m = s.match(/-?\d[\d.,\s]*/);
    if (!m) return null;
    let num = m[0].replace(/\s/g, '');
    // Decide decimal separator: last of [.,] followed by exactly 1-2 digits.
    const lastSep = Math.max(num.lastIndexOf('.'), num.lastIndexOf(','));
    if (lastSep >= 0 && /^\d{1,2}$/.test(num.slice(lastSep + 1))) {
      num = num.slice(0, lastSep).replace(/[.,]/g, '') + '.' + num.slice(lastSep + 1);
    } else {
      num = num.replace(/[.,]/g, '');
    }
    const amount = Number(num);
    if (!isFinite(amount)) return null;
    let currency = null;
    const code = s.match(/\b(USD|EUR|GBP|CAD|AUD|PLN|BRL|RUB|JPY|KRW)\b/);
    if (code) currency = code[1];
    else for (const [sym, cur] of CURRENCY_SYMBOLS) if (s.includes(sym)) { currency = cur; break; }
    return { amount: Math.round(amount * 100) / 100, currency };
  }

  /** "x2", "X 2", "Qty: 2", "2 pieces" -> 2 */
  function parseQuantity(text) {
    const s = cleanText(text);
    let m = s.match(/(?:^|\s)[x×]\s*(\d+)\b/i) || s.match(/qty[:\s]*(\d+)/i) || s.match(/(\d+)\s*(?:pcs|pieces?|lots?|units?)\b/i);
    if (!m) m = s.match(/^(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  /** Accepts "Sep 30, 2026", "30 Sep 2026", "2026-09-30", "2026/09/30", "09/30/2026". -> 'YYYY-MM-DD' | null */
  function parseDate(text) {
    const s = cleanText(text);
    if (!s) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const out = (y, mo, d) => (y > 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(mo)}-${pad(d)}` : null);
    let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return out(+m[1], +m[2], +m[3]);
    m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return out(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
    m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return out(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
    m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return out(+m[3], +m[1], +m[2]);
    return null;
  }

  function productIdFromUrl(url) {
    const m = String(url || '').match(/\/item\/(?:[^/?#]*\/)?(\d{6,})\.html/) || String(url || '').match(/[?&](?:productId|itemId)=(\d{6,})/);
    return m ? m[1] : null;
  }

  function orderIdFromUrl(url) {
    const m = String(url || '').match(/[?&]orderId=(\d{10,})/);
    return m ? m[1] : null;
  }

  // Small stable hash (FNV-1a 32-bit) for variant strings.
  function hash(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  function normalizeVariant(v) {
    return cleanText(v).replace(/^(color|colour|size|style|specification)s?\s*:\s*/i, '').toLowerCase();
  }

  /** Stable per-line id: same product+variant inside an order => same line. */
  function makeLineId(orderId, item) {
    const key = item.skuId || item.productId || cleanText(item.title).toLowerCase().slice(0, 40);
    return `${orderId}:${key}:${hash(normalizeVariant(item.variant))}`;
  }

  function normalizeItem(orderId, raw) {
    const item = {
      lineId: null,
      productId: raw.productId || productIdFromUrl(raw.productUrl) || null,
      skuId: raw.skuId || null,
      title: cleanText(raw.title) || null,
      variant: cleanText(raw.variant) || null,
      quantity: Number.isFinite(raw.quantity) ? raw.quantity : 1,
      unitPrice: Number.isFinite(raw.unitPrice) ? raw.unitPrice : null,
      lineTotal: Number.isFinite(raw.lineTotal) ? raw.lineTotal : null,
      imageUrl: raw.imageUrl || null,
      productUrl: raw.productUrl || (raw.productId ? `https://www.aliexpress.com/item/${raw.productId}.html` : null),
      titleTruncated: !!raw.titleTruncated,
    };
    if (item.imageUrl && item.imageUrl.startsWith('//')) item.imageUrl = 'https:' + item.imageUrl;
    if (item.productUrl && item.productUrl.startsWith('//')) item.productUrl = 'https:' + item.productUrl;
    if (item.lineTotal == null && item.unitPrice != null) item.lineTotal = Math.round(item.unitPrice * item.quantity * 100) / 100;
    item.lineId = raw.lineId || makeLineId(orderId, item);
    return item;
  }

  /** Drop values that can't be right (e.g. shipping larger than the whole order). */
  function sanitizeOrder(o) {
    if (o.shipping != null && (o.shipping < 0 || (o.total != null && o.shipping > o.total) || (o.total == null && o.shipping > 500))) o.shipping = null;
    if (o.total != null && o.total < 0) o.total = null;
    if (o.tax != null && (o.tax < 0 || (o.total != null && o.tax > o.total))) o.tax = null;
    if (o.discount != null && o.discount < 0) o.discount = null;
    return o;
  }

  function normalizeOrder(raw, source) {
    const orderId = String(raw.orderId || '').trim();
    if (!/^\d{10,}$/.test(orderId)) throw new Error(`Invalid orderId: ${raw.orderId}`);
    const now = new Date().toISOString();
    const statusText = cleanText(raw.statusText) || null;
    return sanitizeOrder({
      orderId,
      orderDate: raw.orderDate || null,
      status: raw.status || normalizeStatus(statusText),
      statusText,
      storeName: cleanText(raw.storeName) || null,
      storeUrl: raw.storeUrl || null,
      currency: raw.currency || null,
      total: Number.isFinite(raw.total) ? raw.total : null,
      shipping: Number.isFinite(raw.shipping) ? raw.shipping : null,
      subtotal: Number.isFinite(raw.subtotal) ? raw.subtotal : null,
      tax: Number.isFinite(raw.tax) ? raw.tax : null,
      discount: Number.isFinite(raw.discount) ? raw.discount : null,
      // De-duplicate lines (e.g. items listed again in a receipt overlay).
      items: (raw.items || []).map((it) => normalizeItem(orderId, it))
        .filter((it, i, all) => all.findIndex((x) => x.lineId === it.lineId) === i),
      tracking: (raw.tracking || []).filter((t) => t && t.number),
      sources: Array.from(new Set([...(raw.sources || []), ...(source ? [source] : [])])),
      orderUrl: `https://www.aliexpress.com/p/order/detail.html?orderId=${orderId}`,
      detailFetchedAt: raw.detailFetchedAt || null,
      firstSeenAt: raw.firstSeenAt || now,
      updatedAt: raw.updatedAt || now,
    });
  }

  // Source quality for item data: detail page > list page > email (truncated titles).
  const SOURCE_QUALITY = { 'web-detail': 3, 'web-list': 2, 'manual': 2, gmail: 1 };
  function quality(order) {
    return Math.max(0, ...(order.sources || []).map((s) => SOURCE_QUALITY[s] || 0));
  }

  function mergeItems(oldItems, newItems, newIsBetter) {
    if (!oldItems.length) return newItems;
    if (!newItems.length) return oldItems;
    const primary = newIsBetter ? newItems : oldItems;
    const secondary = newIsBetter ? oldItems : newItems;
    // Fill gaps (image, productId, price) in primary from a matching secondary line.
    return primary.map((p) => {
      const match = secondary.find((s) => s.lineId === p.lineId) ||
        secondary.find((s) => p.productId && s.productId === p.productId && normalizeVariant(s.variant) === normalizeVariant(p.variant)) ||
        (primary.length === 1 && secondary.length === 1 ? secondary[0] : null);
      if (!match) return p;
      const merged = { ...p };
      for (const k of Object.keys(match)) if (merged[k] == null && match[k] != null) merged[k] = match[k];
      if (merged.titleTruncated && match.title && !match.titleTruncated) {
        merged.title = match.title;
        merged.titleTruncated = false;
      }
      return merged;
    });
  }

  /** Merge an incoming normalized order into an existing one (either may be undefined). */
  function mergeOrder(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const newIsBetter = quality(incoming) >= quality(existing);
    const out = { ...existing };
    for (const k of ['orderDate', 'storeName', 'storeUrl', 'currency', 'total', 'shipping', 'subtotal', 'tax', 'discount', 'detailFetchedAt']) {
      if (incoming[k] != null && (newIsBetter || existing[k] == null)) out[k] = incoming[k];
    }
    // A fresh detail-page read is authoritative for the price breakdown, blanks included,
    // so a value mis-read by an earlier version can't linger.
    if ((incoming.sources || []).includes('web-detail') && incoming.detailFetchedAt) {
      for (const k of ['shipping', 'subtotal', 'tax', 'discount']) out[k] = incoming[k] == null ? null : incoming[k];
    }
    // Status: take the more advanced one; ties go to the newer observation.
    if ((STATUS_RANK[incoming.status] || 0) >= (STATUS_RANK[existing.status] || 0)) {
      out.status = incoming.status;
      out.statusText = incoming.statusText || existing.statusText;
    }
    out.items = mergeItems(existing.items || [], incoming.items || [], newIsBetter);
    const tracking = [...(existing.tracking || [])];
    for (const t of incoming.tracking || []) if (!tracking.some((x) => x.number === t.number)) tracking.push(t);
    out.tracking = tracking;
    out.sources = Array.from(new Set([...(existing.sources || []), ...(incoming.sources || [])]));
    sanitizeOrder(out);
    out.firstSeenAt = existing.firstSeenAt || incoming.firstSeenAt;
    out.updatedAt = stripVolatile(out) === stripVolatile(existing)
      ? existing.updatedAt
      : new Date().toISOString();
    return out;
  }

  // Key-order independent JSON (storage round-trips may reorder keys).
  function stableStringify(v) {
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  function stripVolatile(o) {
    const { updatedAt, firstSeenAt, ...rest } = o;
    return stableStringify(rest);
  }

  /** Merge a list of incoming orders into a map {orderId: order}. Returns counts. */
  function mergeInto(map, incomingOrders) {
    const counts = { created: 0, updated: 0, unchanged: 0 };
    for (const inc of incomingOrders) {
      const prev = map[inc.orderId];
      const next = mergeOrder(prev, inc);
      if (!prev) counts.created++;
      else if (stripVolatile(next) !== stripVolatile(prev)) counts.updated++;
      else counts.unchanged++;
      map[inc.orderId] = next;
    }
    return counts;
  }

  const isCancelled = (o) => o.status === 'closed';

  /**
   * Orders to send to an external system (Google Sheet, an API, an export file).
   * With ignoreCancelled, cancelled orders are reduced to a tombstone
   * ({orderId, status:'closed', items:[]}) so a receiver that already has
   * the order can drop it, and a receiver that doesn't can skip it.
   */
  const r2 = (n) => Math.round(n * 100) / 100;

  /**
   * Adds derived money fields (never stored, recomputed on every export):
   *  - itemsSubtotal: sum of line totals
   *  - totalsCheck: 'ok' when subtotal + shipping + tax - discount ≈ total, else 'mismatch' (or '' if unknown)
   *  - items[].landedUnitCost: unit price + share of shipping/tax - share of discount, per unit
   */
  function withCostBreakdown(o) {
    const items = o.items || [];
    const lines = items.map((it) => (it.lineTotal != null ? it.lineTotal : it.unitPrice != null ? it.unitPrice * (it.quantity || 1) : null));
    const known = lines.every((v) => v != null) && items.length > 0;
    const itemsSubtotal = known ? r2(lines.reduce((a, b) => a + b, 0)) : null;
    const base = o.subtotal != null ? o.subtotal : itemsSubtotal;
    let totalsCheck = '';
    if (base != null && o.total != null) {
      const expected = base + (o.shipping || 0) + (o.tax || 0) - (o.discount || 0);
      totalsCheck = Math.abs(expected - o.total) <= 0.02 ? 'ok' : 'mismatch';
    }
    // Spread whatever separates the item prices from the amount paid across lines by value.
    const extra = known && itemsSubtotal > 0 && o.total != null ? o.total - itemsSubtotal : null;
    const outItems = items.map((it, i) => {
      if (extra == null || lines[i] == null || !it.quantity) return { ...it, landedUnitCost: null };
      const share = extra * (lines[i] / itemsSubtotal);
      return { ...it, landedUnitCost: r2((lines[i] + share) / it.quantity) };
    });
    return { ...o, itemsSubtotal, totalsCheck, items: outItems };
  }

  function outgoingOrders(orders, { ignoreCancelled = true } = {}) {
    if (!ignoreCancelled) return orders.map((o) => (isCancelled(o) ? o : withCostBreakdown(o)));
    return orders.map((o) => (isCancelled(o)
      ? { orderId: o.orderId, orderDate: o.orderDate, status: 'closed', statusText: o.statusText, items: [], tracking: [], sources: o.sources, cancelled: true, updatedAt: o.updatedAt, firstSeenAt: o.firstSeenAt }
      : withCostBreakdown(o)));
  }

  function buildPayload(orders, source) {
    return {
      schemaVersion: SCHEMA_VERSION,
      source: source || 'aliexpress-order-sync',
      exportedAt: new Date().toISOString(),
      orderCount: orders.length,
      orders,
    };
  }

  const CSV_COLUMNS = [
    'orderId', 'orderDate', 'status', 'statusText', 'storeName', 'currency',
    'orderSubtotal', 'orderShipping', 'orderTax', 'orderDiscount', 'orderTotal', 'totalsCheck',
    'lineId', 'productId', 'title', 'variant', 'quantity', 'unitPrice', 'lineTotal', 'landedUnitCost',
    'productUrl', 'imageUrl', 'tracking', 'orderUrl',
  ];

  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** One row per order line (orders with no items get one row). */
  function toCSV(orders) {
    const rows = [CSV_COLUMNS.join(',')];
    for (const raw of orders) {
      const o = isCancelled(raw) ? raw : withCostBreakdown(raw);
      const base = {
        orderId: o.orderId, orderDate: o.orderDate, status: o.status, statusText: o.statusText,
        storeName: o.storeName, currency: o.currency,
        orderSubtotal: o.subtotal != null ? o.subtotal : o.itemsSubtotal, orderShipping: o.shipping, orderTax: o.tax,
        orderDiscount: o.discount, orderTotal: o.total, totalsCheck: o.totalsCheck,
        tracking: (o.tracking || []).map((t) => t.number).join(' '), orderUrl: o.orderUrl,
      };
      const items = o.items && o.items.length ? o.items : [{}];
      for (const it of items) {
        const row = { ...base, ...it };
        rows.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
      }
    }
    return rows.join('\n');
  }

  // ---------- Reorder / over-ordering checks ----------

  const STOPWORDS = new Set(('for with and the a an of to in on by at new 1pc 1pcs pcs pc set sets lot lots piece pieces high quality hot sale ' +
    'free shipping delivery original genuine diy kit module best top professional portable mini store official 2023 2024 2025 2026 ' +
    'compatible suitable universal type style color colour size model specification ships from china quantity').split(' '));
  // Model/part numbers mix letters and digits ("esp32-s3", "n16r8", "is-40", "tw32", "ch340").
  // They identify a product across stores far better than descriptive words.
  // Common interface/spec terms that look like codes but don't identify a product.
  const GENERIC_CODES = new Set('i2c iic usb2 usb3 usb2.0 usb3.0 2.4g 2.4ghz 5ghz 4g 5g 3g 1080p 720p 4k 8k mp3 mp4 h264 h265 m2 m3 m4 m5 m6 m8 rgb2 3d 2d'.split(' '));
  const isModelCode = (t) => /[a-z]/.test(t) && /\d/.test(t) && t.length >= 3 && !GENERIC_CODES.has(t) &&
    !/^\d+(\.\d+)?x\d+(\.\d+)?(mm|cm|m)?$/.test(t) && !/^\d+(\.\d+)?(pcs|pc|m|mm|cm|v|w|a|ma|mah|g|kg|ml|ft|in|inch|ohm|k|uf|nf|pf|mhz|ghz|hz|db|awg|p|x)$/.test(t);
  // Same part, different letter suffix: "w25q128fv" ~ "w25q128jvsiq". The shared prefix must
  // end in a digit and the remainders must be letters only, so "esp32-c3" ≠ "esp32-s3".
  const codesMatch = (x, y) => {
    if (x === y) return true;
    let n = 0;
    while (n < x.length && n < y.length && x[n] === y[n]) n++;
    const prefix = x.slice(0, n);
    return n >= 5 && /\d$/.test(prefix) && /[a-z]/.test(prefix) && !/\d/.test(x.slice(n)) && !/\d/.test(y.slice(n));
  };
  // Tokens of a title. Pieces of hyphenated codes ("esp32-s3" → "esp32", "s3") are kept as
  // "part:" tokens: they help overlap a little but are not treated as model numbers.
  function titleTokens(title) {
    const raw = cleanText(title).toLowerCase().replace(/[^a-z0-9.+-]+/g, ' ').split(' ')
      .map((t) => t.replace(/^[.+-]+|[.+-]+$/g, ''))
      .filter((t) => t.length > 1 && !STOPWORDS.has(t));
    const set = new Set(raw);
    for (const t of raw) {
      if (!t.includes('-')) continue;
      for (const x of t.split('-')) if (x.length > 1 && !set.has(x)) set.add('part:' + x);
    }
    return set;
  }
  const bare = (t) => (t.startsWith('part:') ? t.slice(5) : t);
  const tokenWeight = (t) => (!t.startsWith('part:') && isModelCode(t) ? 3 : 1);
  /** Weighted overlap coefficient (tolerant of truncated titles); model codes weigh 3×. */
  function similarity(a, b) {
    const A = titleTokens(a), B = titleTokens(b);
    if (!A.size || !B.size) return 0;
    const bBare = new Set([...B].map(bare));
    const bCodes = [...B].filter((t) => !t.startsWith('part:') && isModelCode(t));
    let inter = 0, wA = 0, wB = 0;
    for (const t of A) {
      wA += tokenWeight(t);
      const full = !t.startsWith('part:') && isModelCode(t);
      if (bBare.has(bare(t)) || (full && bCodes.some((c) => codesMatch(t, c)))) inter += tokenWeight(t);
    }
    for (const t of B) wB += tokenWeight(t);
    return Math.min(1, inter / Math.min(wA, wB));
  }
  /** Model codes two titles have in common. */
  function sharedModelCodes(a, b) {
    const codes = (x) => [...titleTokens(x)].filter((t) => !t.startsWith('part:') && isModelCode(t));
    const bCodes = codes(b);
    return codes(a).filter((t) => bCodes.some((c) => codesMatch(t, c)));
  }


  const OPEN_STATUSES = new Set(['awaiting_payment', 'processing', 'shipped']);

  /**
   * Summarize prior purchases of a product.
   * @returns {{exact: object, similar: Array}} exact = same productId, similar = fuzzy title matches.
   */
  function purchaseHistory(orders, { productId, title, minSimilarity = 0.6, maxSimilar = 5 }) {
    const exact = { orders: 0, units: 0, inTransitUnits: 0, lastOrderDate: null, lines: [] };
    const likely = { orders: 0, units: 0, inTransitUnits: 0, lastOrderDate: null, orderIds: new Set() };
    const similar = [];
    for (const o of orders) {
      if (o.status === 'closed') continue;
      for (const it of o.items || []) {
        if (productId && it.productId === productId) {
          exact.lines.push({ orderId: o.orderId, orderDate: o.orderDate, status: o.status, variant: it.variant, quantity: it.quantity, unitPrice: it.unitPrice });
          exact.units += it.quantity || 0;
          if (OPEN_STATUSES.has(o.status)) exact.inTransitUnits += it.quantity || 0;
          if (!exact.lastOrderDate || (o.orderDate && o.orderDate > exact.lastOrderDate)) exact.lastOrderDate = o.orderDate;
        } else if (title && it.title) {
          // The chosen variant often names the model ("Color: N16R8"), so match on it too.
          const theirs = it.variant ? `${it.title} ${it.variant}` : it.title;
          const score = similarity(title, theirs);
          const codes = sharedModelCodes(title, theirs);
          // "Likely the same item from another store": a shared model code plus decent overlap,
          // or a near-identical title on its own.
          const likelySame = (codes.length > 0 && score >= 0.3) || score >= 0.9;
          if (likelySame || score >= minSimilarity) {
            similar.push({ score, likelySame, codes, orderId: o.orderId, orderDate: o.orderDate, status: o.status, title: it.title, variant: it.variant, quantity: it.quantity, productId: it.productId });
          }
          if (likelySame) {
            likely.units += it.quantity || 0;
            if (OPEN_STATUSES.has(o.status)) likely.inTransitUnits += it.quantity || 0;
            likely.orderIds.add(o.orderId);
            if (!likely.lastOrderDate || (o.orderDate && o.orderDate > likely.lastOrderDate)) likely.lastOrderDate = o.orderDate;
          }
        }
      }
    }
    exact.orders = new Set(exact.lines.map((l) => l.orderId)).size;
    likely.orders = likely.orderIds.size;
    delete likely.orderIds;
    similar.sort((a, b) => (b.likelySame - a.likelySame) || (b.score - a.score));
    return { exact, likely, similar: similar.slice(0, maxSimilar) };
  }

  const api = {
    SCHEMA_VERSION, cleanText, parseMoney, parseQuantity, parseDate, normalizeStatus,
    productIdFromUrl, orderIdFromUrl, hash, makeLineId, normalizeItem, normalizeOrder,
    mergeOrder, mergeInto, buildPayload, isCancelled, outgoingOrders, sanitizeOrder, withCostBreakdown, toCSV, similarity, sharedModelCodes, purchaseHistory, STATUS_RANK,
  };
  root.AEX = Object.assign(root.AEX || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
