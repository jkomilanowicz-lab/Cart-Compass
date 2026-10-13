/* Service worker: owns the order store, Google Sheet sync and detail-page crawling. */
importScripts('lib/core.js');

const DEFAULT_SETTINGS = {
  detailDelayMs: 2500,      // pause between detail pages during deep sync
  detailBatchLimit: 150,    // max detail pages per deep-sync run
  ignoreCancelled: true,    // cancelled/closed orders: never exported, detail-fetched or pushed with items
  sheetUrl: '',             // Google Apps Script web app URL (tools/google-sheet-sync)
  sheetKey: '',             // shared secret checked by the Apps Script
  sheetViewUrl: '',         // optional link for the popup's Open sheet button
  autoSheetSync: false,     // push to the sheet after every save
  similarityThreshold: 0.6, // fuzzy title match for "similar items you ordered"
  cleanupMinAgeDays: 30,    // clean-up only removes orders at least this old from the AliExpress list
  cleanupCancelled: false,  // clean-up also removes cancelled/closed orders
};

// ---------------- storage ----------------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

const withoutSecrets = ({ sheetKey, ...rest }) => ({ ...rest, hasSheetKey: !!sheetKey });

async function getOrdersMap() {
  const { orders } = await chrome.storage.local.get('orders');
  return orders || {};
}

// Serialize writes so concurrent saves (list + detail tabs) don't clobber each other.
let writeChain = Promise.resolve();
function saveOrders(incoming, origin) {
  const run = async () => {
    const map = await getOrdersMap();
    const normalized = incoming.map((o) => (o.firstSeenAt ? o : AEX.normalizeOrder(o, origin)));
    const counts = AEX.mergeInto(map, normalized);
    await chrome.storage.local.set({ orders: map, lastSavedAt: new Date().toISOString() });
    updateBadge(map);
    const settings = await getSettings();
    if (settings.autoSheetSync && settings.sheetUrl && (counts.created || counts.updated)) scheduleSheetSync();
    return counts;
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

function updateBadge(map) {
  const open = Object.values(map).filter((o) => ['processing', 'shipped', 'awaiting_payment'].includes(o.status)).length;
  chrome.action.setBadgeText({ text: open ? String(open) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#e62e04' });
}


// ---------------- deep sync (order detail pages) ----------------

const pendingDetail = new Map(); // tabId -> resolve
let deepSyncState = { running: false, done: 0, total: 0, errors: 0 };

function openDetailAndWait(orderId, timeoutMs = 30000) {
  return new Promise(async (resolve) => {
    let timer = null;
    // Create blank, then navigate: lets the tab register before the request starts.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    pendingDetail.set(tab.id, (o) => finish(o));
    await chrome.tabs.update(tab.id, { url: `https://www.aliexpress.com/p/order/detail.html?orderId=${orderId}` });
    timer = setTimeout(() => finish(null), timeoutMs);
    function finish(order) {
      clearTimeout(timer);
      pendingDetail.delete(tab.id);
      chrome.tabs.remove(tab.id).catch(() => {});
      resolve(order);
    }
  });
}

async function deepSync({ orderIds, force = false } = {}) {
  if (deepSyncState.running) return deepSyncState;
  const settings = await getSettings();
  const map = await getOrdersMap();
  const removedOnline = await getRemovedOnline();
  let targets = orderIds || Object.values(map)
    .filter((o) => !(settings.ignoreCancelled && AEX.isCancelled(o)))
    .filter((o) => !removedOnline[o.orderId]) // deleted from the AliExpress list: details are final
    .filter((o) => force || !o.detailFetchedAt || ['processing', 'shipped', 'awaiting_payment', 'unknown'].includes(o.status) ||
      (o.items || []).some((it) => it.titleTruncated || !it.productId))
    // Re-fetch: least recently fetched first, so repeated clicks walk through every order.
    .sort(force
      ? (a, b) => String(a.detailFetchedAt || '').localeCompare(String(b.detailFetchedAt || ''))
      : (a, b) => String(b.orderDate).localeCompare(String(a.orderDate)))
    .map((o) => o.orderId);
  targets = targets.slice(0, settings.detailBatchLimit);
  deepSyncState = { running: true, done: 0, total: targets.length, errors: 0 };
  (async () => {
    for (const id of targets) {
      if (!deepSyncState.running) break;
      const order = await openDetailAndWait(id);
      if (order) await saveOrders([order], 'web-detail');
      else deepSyncState.errors++;
      deepSyncState.done++;
      await new Promise((r) => setTimeout(r, settings.detailDelayMs));
    }
    deepSyncState.running = false;
  })();
  return deepSyncState;
}

// ---------------- Google Sheet (review copy) ----------------

async function sheetPost(settings, body) {
  // text/plain keeps Apps Script happy; it reads e.postData.contents.
  const res = await fetch(settings.sheetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: settings.sheetKey, ...body }),
    redirect: 'follow',
  });
  const text = await res.text();
  let reply;
  try { reply = JSON.parse(text); } catch (_) { throw new Error(`Sheet did not return JSON (HTTP ${res.status}). Is the web app deployed with access "Anyone"?`); }
  if (!reply.ok) throw new Error(`Sheet error: ${reply.error || 'unknown'}`);
  return reply;
}

async function syncToSheet() {
  const settings = await getSettings();
  if (!settings.sheetUrl) throw new Error('Set the Google Sheet web app URL in Settings first.');
  const orders = AEX.outgoingOrders(Object.values(await getOrdersMap()), settings);
  const results = { sent: 0, orders: 0, items: 0, removed: 0 };
  for (let i = 0; i < orders.length; i += 200) {
    const chunk = orders.slice(i, i + 200);
    const body = await sheetPost(settings, { payload: AEX.buildPayload(chunk, 'aliexpress-order-sync-extension') });
    results.sent += chunk.length;
    results.orders = body.orders;
    results.items = body.items;
    results.removed += body.removed || 0;
  }
  const at = new Date().toISOString();
  await chrome.storage.local.set({ lastSheetSyncAt: at, lastSheetResult: results });
  return results;
}

// ---------------- clean-up of the online order list ----------------
// Deleting an order on AliExpress only hides it from the online list; the local copy here
// (and the Google Sheet) keep it, so re-order warnings still know about it.

async function getRemovedOnline() {
  const { removedOnline } = await chrome.storage.local.get('removedOnline');
  return removedOnline || {};
}

async function cleanupPlan() {
  const settings = await getSettings();
  const orders = Object.values(await getOrdersMap());
  const removed = await getRemovedOnline();
  const cutoff = new Date(Date.now() - settings.cleanupMinAgeDays * 86400000).toISOString().slice(0, 10);
  const skipped = { notFinished: 0, noDetails: 0, tooRecent: 0, notInSheet: 0, sheetDiffers: 0 };
  const candidates = [], cancelled = [];
  for (const o of orders) {
    if (removed[o.orderId]) continue;
    if (!o.orderDate || o.orderDate > cutoff) { skipped.tooRecent++; continue; }
    if (AEX.isCancelled(o)) { if (settings.cleanupCancelled) cancelled.push(o); continue; }
    if (o.status !== 'completed') { skipped.notFinished++; continue; }
    if (!o.detailFetchedAt || !(o.items || []).length) { skipped.noDetails++; continue; }
    candidates.push(o);
  }
  if (candidates.length && !settings.sheetUrl) throw new Error('Set up the Google Sheet first: clean-up only removes orders it can confirm are recorded there.');
  const found = {};
  for (let i = 0; i < candidates.length; i += 500) {
    const r = await sheetPost(settings, { verify: candidates.slice(i, i + 500).map((o) => o.orderId) });
    if (!r.found) throw new Error('The Google Sheet script is out of date. Paste the latest tools/google-sheet-sync/Code.gs and deploy a new version.');
    Object.assign(found, r.found);
  }
  const eligible = [];
  for (const o of candidates) {
    const f = found[o.orderId];
    if (!f) { skipped.notInSheet++; continue; }
    if (f.status !== o.status || f.itemCount !== o.items.length) { skipped.sheetDiffers++; continue; }
    eligible.push(o);
  }
  eligible.push(...cancelled);
  eligible.sort((a, b) => String(a.orderDate).localeCompare(String(b.orderDate))); // oldest first
  return {
    orderIds: eligible.map((o) => o.orderId),
    completed: eligible.length - cancelled.length,
    cancelled: cancelled.length,
    skipped,
    minAgeDays: settings.cleanupMinAgeDays,
    alreadyRemoved: Object.keys(removed).length,
  };
}

let sheetTimer = null;
function scheduleSheetSync() {
  // Debounce: a full sync saves many batches in a row.
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(() => syncToSheet().catch((e) => chrome.storage.local.set({ lastSheetResult: { error: String(e.message || e) } })), 5000);
}

// ---------------- messaging ----------------

const handlers = {
  async saveOrders(msg) { return saveOrders(msg.orders || [], msg.origin || 'web-list'); },
  async getOrders() { return Object.values(await getOrdersMap()); },
  async getState() {
    const map = await getOrdersMap();
    const orders = Object.values(map);
    const s = await chrome.storage.local.get(['lastSavedAt', 'lastPushAt', 'lastPushResult', 'lastFullSync', 'lastSheetSyncAt', 'lastSheetResult']);
    const byStatus = {};
    for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    return {
      orderCount: orders.filter((o) => !AEX.isCancelled(o)).length,
      lineCount: orders.filter((o) => !AEX.isCancelled(o)).reduce((n, o) => n + (o.items || []).length, 0),
      byStatus,
      needsDetail: orders.filter((o) => !o.detailFetchedAt && !AEX.isCancelled(o)).length,
      cancelled: orders.filter(AEX.isCancelled).length,
      removedOnline: Object.keys(await getRemovedOnline()).length,
      deepSync: deepSyncState,
      settings: withoutSecrets(await getSettings()),
      ...s,
    };
  },
  async getSettings() { return getSettings(); }, // settings page only: includes the sheet key
  async saveSettings(msg) {
    const settings = { ...(await getSettings()), ...msg.settings };
    await chrome.storage.local.set({ settings });
    return settings;
  },
  async syncSheet() { return syncToSheet(); },
  async cleanupPlan() { return cleanupPlan(); },
  async markRemovedOnline(msg) {
    const removed = await getRemovedOnline();
    const at = new Date().toISOString();
    for (const id of msg.orderIds || []) removed[id] = at;
    await chrome.storage.local.set({ removedOnline: removed });
    return Object.keys(removed).length;
  },
  async testSheet() {
    const s = await getSettings();
    if (!s.sheetUrl) return { ok: false, error: 'No web app URL saved' };
    try {
      const res = await fetch(s.sheetUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: s.sheetKey, ping: true }), redirect: 'follow' });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch (_) { return { ok: false, error: `Not a JSON reply (HTTP ${res.status}). Check the deployment: Web app, access "Anyone", URL ending in /exec.` }; }
      if (body.ok) return { ok: true };
      // An older Code.gs without ping support still proves the key was accepted.
      if (/payload\.orders/.test(body.error || '')) return { ok: true };
      return { ok: false, error: body.error || 'unknown error' };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  },
  async exportOrders() {
    const s = await getSettings();
    const orders = Object.values(await getOrdersMap());
    return AEX.outgoingOrders(s.ignoreCancelled ? orders.filter((o) => !AEX.isCancelled(o)) : orders, s);
  },
  async deepSync(msg) { return deepSync(msg); },
  async stopDeepSync() { deepSyncState.running = false; return deepSyncState; },
  async detailParsed(msg, sender) {
    const finish = sender.tab && pendingDetail.get(sender.tab.id);
    if (finish) { finish(msg.order); return { handled: 'deep-sync' }; }
    // User opened a detail page themselves — save passively.
    if (msg.order) return saveOrders([msg.order], 'web-detail');
    return null;
  },
  async history(msg) {
    const settings = await getSettings();
    const orders = Object.values(await getOrdersMap());
    const ids = msg.productIds || (msg.productId ? [msg.productId] : []);
    const perProduct = {};
    for (const id of ids) perProduct[id] = AEX.purchaseHistory(orders, { productId: id, title: msg.titles && msg.titles[id], minSimilarity: settings.similarityThreshold });
    return { perProduct, hasData: orders.length > 0 };
  },
  async importOrders(msg) {
    const payload = msg.payload;
    const orders = Array.isArray(payload) ? payload : payload.orders;
    if (!Array.isArray(orders)) throw new Error('Expected {orders:[...]} or an array');
    return saveOrders(orders.map((o) => AEX.normalizeOrder(o, null)), null);
  },
  async clearAll() {
    await chrome.storage.local.remove(['orders', 'lastPushAt', 'lastPushResult', 'lastSavedAt', 'lastFullSync']);
    updateBadge({});
    return true;
  },
  async markFullSync() { await chrome.storage.local.set({ lastFullSync: new Date().toISOString() }); return true; },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg && msg.type];
  if (!h) return false;
  Promise.resolve(h(msg, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // async response
});


// On install/update: clean values earlier versions may have mis-parsed (e.g. shipping 3115).
chrome.runtime.onInstalled.addListener(async () => {
  const map = await getOrdersMap();
  let fixed = 0;
  // v0.6: prices split one digit per span were mis-read by 0.5.x. Clear the price
  // breakdown (and implausible totals) and mark orders for a fresh detail read.
  const { migratedMoneyV6 } = await chrome.storage.local.get('migratedMoneyV6');
  if (!migratedMoneyV6) {
    for (const o of Object.values(map)) {
      if (!o.detailFetchedAt) continue;
      const itemSum = (o.items || []).reduce((n, it) => n + (it.lineTotal || 0), 0);
      for (const k of ['shipping', 'subtotal', 'tax', 'discount']) o[k] = null;
      if (o.total != null && itemSum && o.total < itemSum * 0.5) o.total = null;
      o.detailFetchedAt = null;
      o.updatedAt = new Date().toISOString();
      fixed++;
    }
    await chrome.storage.local.set({ migratedMoneyV6: true });
  }
  for (const o of Object.values(map)) {
    const before = JSON.stringify([o.shipping, o.total]);
    AEX.sanitizeOrder(o);
    if (JSON.stringify([o.shipping, o.total]) !== before) { o.updatedAt = new Date().toISOString(); fixed++; }
  }
  if (fixed) await chrome.storage.local.set({ orders: map });
  updateBadge(map);
});

