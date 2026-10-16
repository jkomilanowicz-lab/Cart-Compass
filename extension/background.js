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
  cleanupCancelled: true,   // clean-up also removes cancelled/expired orders (once their refund has cleared)
  refundWaitDays: 14,       // days after an order closes before its refund is assumed to have cleared
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
  const stale = (iso, days) => !iso || Date.now() - Date.parse(iso) > days * 86400000;
  const wanted = (o) => {
    if (removedOnline[o.orderId]) return false; // deleted from the AliExpress list: details are final
    if (AEX.isCancelled(o)) {
      if (force) return !settings.ignoreCancelled || !o.detailFetchedAt;
      // Read each closed order once to learn why it closed (expired = never shipped), then every
      // few days until its refund shows up or the refund wait has passed.
      if (!o.detailFetchedAt) return true;
      return o.closeReason !== 'unpaid' && !o.refundedAt && !AEX.refundCleared(o, settings.refundWaitDays) && stale(o.detailFetchedAt, 3);
    }
    return force || !o.detailFetchedAt || ['processing', 'shipped', 'awaiting_payment', 'unknown'].includes(o.status) ||
      (o.items || []).some((it) => it.titleTruncated || !it.productId);
  };
  let targets = orderIds || Object.values(map)
    .filter(wanted)
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
  const { notListedOnline = {} } = await chrome.storage.local.get('notListedOnline');
  const cutoff = new Date(Date.now() - settings.cleanupMinAgeDays * 86400000).toISOString().slice(0, 10);
  const skipped = { notFinished: 0, noDetails: 0, tooRecent: 0, notInSheet: 0, sheetDiffers: 0, refundPending: 0 };
  const candidates = [], cancelled = [], refundPendingIds = [];
  for (const o of orders) {
    if (removed[o.orderId] || notListedOnline[o.orderId]) continue;
    // Cancelled/expired orders aren't in the sheet; they go once nothing is still owed on them.
    if (AEX.isCancelled(o)) {
      if (!settings.cleanupCancelled) continue;
      if (!AEX.refundCleared(o, settings.refundWaitDays)) { skipped.refundPending++; refundPendingIds.push(o.orderId); continue; }
      cancelled.push(o);
      continue;
    }
    if (!o.orderDate || o.orderDate > cutoff) { skipped.tooRecent++; continue; }
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
  const plan = {
    orderIds: eligible.map((o) => o.orderId),
    // Removed too if their card on the orders page shows the refund is complete.
    checkIds: refundPendingIds,
    // Also remove any cancelled order the page shows as refunded, saved or not.
    sweepCancelled: !!settings.cleanupCancelled,
    completed: eligible.length - cancelled.length,
    cancelled: cancelled.length,
    expired: cancelled.filter(AEX.isExpired).length,
    refundWaitDays: settings.refundWaitDays,
    skipped,
    minAgeDays: settings.cleanupMinAgeDays,
    alreadyRemoved: Object.keys(removed).length,
    notListed: Object.keys(notListedOnline).length,
  };
  // Kept so a reopened popup picks up where it left off.
  await chrome.storage.local.set({ cleanupCache: { at: new Date().toISOString(), plan } });
  return plan;
}

// The last plan, minus anything removed (or found missing) since; null once it's an hour old.
async function cleanupState() {
  const { cleanupCache, cleanupTested, notListedOnline = {} } = await chrome.storage.local.get(['cleanupCache', 'cleanupTested', 'notListedOnline']);
  const removed = await getRemovedOnline();
  const fresh = cleanupCache && Date.now() - Date.parse(cleanupCache.at) < 3600000;
  const plan = fresh ? { ...cleanupCache.plan, orderIds: cleanupCache.plan.orderIds.filter((id) => !removed[id] && !notListedOnline[id]), checkIds: (cleanupCache.plan.checkIds || []).filter((id) => !removed[id]) } : null;
  return { plan, tested: !!cleanupTested };
}

// ---------------- automatic local backup ----------------
// A copy of every saved order, refreshed before anything destructive (clean-up, Clear local data),
// so no backup file is needed. Restored from Troubleshooting.

async function snapshotOrders() {
  const orders = Object.values(await getOrdersMap());
  if (!orders.length) return null;
  const autoBackup = { at: new Date().toISOString(), orders };
  await chrome.storage.local.set({ autoBackup });
  return { at: autoBackup.at, count: orders.length };
}

// ---------------- expired orders (seller didn't ship in time) ----------------
// Flagged until the user marks them handled: nothing arrived, a refund is due, and the item may
// need ordering again.

async function getExpiredHandled() {
  const { expiredHandled } = await chrome.storage.local.get('expiredHandled');
  return expiredHandled || {};
}

function expiredSummary(o, settings) {
  return {
    orderId: o.orderId, orderDate: o.orderDate, storeName: o.storeName, total: o.total, currency: o.currency,
    closedAt: o.closedAt, refundedAt: o.refundedAt, refundAmount: o.refundAmount,
    refundDueAt: AEX.refundDueAt(o, settings.refundWaitDays),
    refundCleared: AEX.refundCleared(o, settings.refundWaitDays),
    items: (o.items || []).map((it) => ({ title: it.title, variant: it.variant, quantity: it.quantity, productId: it.productId, productUrl: it.productUrl, imageUrl: it.imageUrl })),
  };
}

async function expiredOrders() {
  const [settings, map, handled] = await Promise.all([getSettings(), getOrdersMap(), getExpiredHandled()]);
  return Object.values(map).filter((o) => AEX.isExpired(o) && !handled[o.orderId])
    .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))
    .map((o) => expiredSummary(o, settings));
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
      expired: (await expiredOrders()).length,
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
  async cleanupState() { return cleanupState(); },
  async markCleanupTested() { await chrome.storage.local.set({ cleanupTested: true }); return true; },
  async snapshotOrders() { return snapshotOrders(); },
  async autoBackupInfo() {
    const { autoBackup } = await chrome.storage.local.get('autoBackup');
    return autoBackup ? { at: autoBackup.at, count: autoBackup.orders.length } : null;
  },
  async restoreAutoBackup() {
    const { autoBackup } = await chrome.storage.local.get('autoBackup');
    if (!autoBackup) throw new Error('No automatic backup yet');
    return saveOrders(autoBackup.orders.map((o) => AEX.normalizeOrder(o, null)), null);
  },
  async expiredOrders() { return expiredOrders(); },
  async dismissExpired(msg) {
    const handled = await getExpiredHandled();
    for (const id of msg.orderIds || []) { if (msg.undo) delete handled[id]; else handled[id] = new Date().toISOString(); }
    await chrome.storage.local.set({ expiredHandled: handled });
    return expiredOrders();
  },
  async markRemovedOnline(msg) {
    const at = new Date().toISOString();
    if (msg.notListed) {
      // Not in the online list at all (e.g. imported from Gmail, or deleted on AliExpress): skip from now on.
      const { notListedOnline = {} } = await chrome.storage.local.get('notListedOnline');
      for (const id of msg.orderIds || []) notListedOnline[id] = at;
      await chrome.storage.local.set({ notListedOnline });
      return Object.keys(notListedOnline).length;
    }
    const removed = await getRemovedOnline();
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
    // Expired (never shipped) orders of these products: worth re-ordering, refund pending.
    const handled = await getExpiredHandled();
    for (const o of orders) {
      if (!AEX.isExpired(o) || handled[o.orderId]) continue;
      for (const it of o.items || []) {
        if (!perProduct[it.productId]) continue;
        (perProduct[it.productId].expired = perProduct[it.productId].expired || []).push({ ...expiredSummary(o, settings), quantity: it.quantity, variant: it.variant });
      }
    }
    return { perProduct, hasData: orders.length > 0 };
  },
  async importOrders(msg) {
    const payload = msg.payload;
    const orders = Array.isArray(payload) ? payload : payload.orders;
    if (!Array.isArray(orders)) throw new Error('Expected {orders:[...]} or an array');
    return saveOrders(orders.map((o) => AEX.normalizeOrder(o, null)), null);
  },
  async clearAll() {
    await snapshotOrders();
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
  // v1.1: closed orders get a close reason (expired = never shipped), a closing date and refund
  // tracking; clean-up now includes cancelled orders by default.
  const { migratedCloseV11 } = await chrome.storage.local.get('migratedCloseV11');
  if (!migratedCloseV11) {
    for (const [id, o] of Object.entries(map)) {
      if (o.status !== 'closed' || o.closeReason) continue;
      const n = AEX.normalizeOrder({ ...o, closedAt: null }, null);
      Object.assign(o, { closeReason: n.closeReason, closeReasonText: n.closeReasonText, closedAt: n.closedAt, closedAtEstimated: true, refundedAt: null });
      map[id] = o;
      fixed++;
    }
    const { settings } = await chrome.storage.local.get('settings');
    if (settings && settings.cleanupCancelled === false) await chrome.storage.local.set({ settings: { ...settings, cleanupCancelled: true } });
    await chrome.storage.local.set({ migratedCloseV11: true });
  }
  // v1.1.1: an earlier 1.1 build couldn't read "Ref. Number:" cards and may have marked listed
  // orders as "not in the online list". Forget those marks once.
  const { migratedNotListedV111 } = await chrome.storage.local.get('migratedNotListedV111');
  if (!migratedNotListedV111) await chrome.storage.local.set({ notListedOnline: {}, migratedNotListedV111: true });
  // Anyone who has already removed an order has done the one-order test.
  if (Object.keys(await getRemovedOnline()).length) await chrome.storage.local.set({ cleanupTested: true });
  for (const o of Object.values(map)) {
    const before = JSON.stringify([o.shipping, o.total]);
    AEX.sanitizeOrder(o);
    if (JSON.stringify([o.shipping, o.total]) !== before) { o.updatedAt = new Date().toISOString(); fixed++; }
  }
  if (fixed) await chrome.storage.local.set({ orders: map });
  updateBadge(map);
});

