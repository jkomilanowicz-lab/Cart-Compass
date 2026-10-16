/* global AEX */
const $ = (id) => document.getElementById(id);
const ORDERS_URL = 'https://www.aliexpress.com/p/order/index.html';
const ORDERS_RE = /aliexpress\.(com|us)\/p\/order\/index\.html/;

function bg(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!r || !r.ok) return reject(new Error((r && r.error) || 'No response'));
      resolve(r.result);
    });
  });
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

async function refresh() {
  const s = await bg('getState');
  const open = (s.byStatus.processing || 0) + (s.byStatus.shipped || 0) + (s.byStatus.awaiting_payment || 0);
  $('stats').innerHTML = `
    <div class="stat"><b>${s.orderCount}</b><span>orders</span></div>
    <div class="stat"><b>${s.lineCount}</b><span>line items</span></div>
    <div class="stat"><b>${open}</b><span>open / in transit</span></div>`;
  renderExpired().catch(() => {});
  $('syncInfo').textContent = `Last saved ${fmtTime(s.lastSavedAt)} · last full sync ${fmtTime(s.lastFullSync)} · ${s.needsDetail} still need details · ${s.cancelled || 0} cancelled${s.settings.ignoreCancelled ? ' (ignored)' : ''}${s.removedOnline ? ` · ${s.removedOnline} removed from the AliExpress list (kept here)` : ''}`;
  if (!$('sheetStatus').dataset.busy) {
    const r = s.lastSheetResult;
    $('sheetStatus').textContent = r && r.error ? 'Last sheet sync failed: ' + r.error
      : s.lastSheetSyncAt ? `Last sheet sync ${fmtTime(s.lastSheetSyncAt)} · ${r.orders} orders / ${r.items} items in sheet${r.removed ? ` · ${r.removed} cancelled removed` : ''}`
      : (s.settings.sheetUrl ? 'Not synced yet.' : 'Not set up yet: click ⚙ Settings below.');
  }
  $('btnOpenSheet').classList.toggle('hidden', !s.settings.sheetViewUrl);
  const d = s.deepSync;
  $('btnStopDeep').classList.toggle('hidden', !d.running);
  $('btnDeep').disabled = d.running;
  $('btnRefetch').disabled = d.running;
  if (d.running || d.total) $('deepStatus').textContent = `Details: ${d.done}/${d.total}${d.errors ? ` (${d.errors} timed out)` : ''}${d.running ? '…' : ' done'}`;
  return s;
}

async function findOrCreateOrdersTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && ORDERS_RE.test(active.url || '')) return active;
  const tabs = await chrome.tabs.query({ url: ['*://*.aliexpress.com/p/order/index.html*', '*://*.aliexpress.us/p/order/index.html*'] });
  if (tabs.length) return tabs[0];
  const tab = await chrome.tabs.create({ url: ORDERS_URL, active: true });
  await new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab;
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    // Tab was open before the extension was installed/reloaded: inject now.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/core.js', 'lib/parsers.js', 'content/orders.js'] });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

async function runSync(quick) {
  const el = $('syncStatus');
  el.textContent = 'Opening orders page…';
  try {
    const tab = await findOrCreateOrdersTab();
    el.textContent = 'Syncing — keep the AliExpress tab open (you can close this popup).';
    const r = await sendToTab(tab.id, { type: 'fullSync', quick });
    el.textContent = r && r.error ? r.error : `Done: ${r.loaded} orders loaded · ${r.created} new · ${r.updated} updated`;
  } catch (e) {
    el.textContent = 'Sync failed: ' + e.message;
  } finally {
    refresh();
  }
}

// ---- expired orders (never shipped) ----
let expiredJson = '';
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '?');
function refundLine(e) {
  if (e.refundedAt) return `refunded${e.refundAmount != null ? ` ${e.currency === 'USD' || !e.currency ? '$' : ''}${e.refundAmount.toFixed(2)}${e.currency && e.currency !== 'USD' ? ' ' + e.currency : ''}` : ''} ${shortDate(e.refundedAt)}`;
  if (e.refundCleared) return `refund should have arrived by ${shortDate(e.refundDueAt)}: check if it hasn't`;
  return `refund expected by ${shortDate(e.refundDueAt)}`;
}
async function renderExpired() {
  const list = await bg('expiredOrders');
  const json = JSON.stringify(list);
  if (json === expiredJson) return;
  expiredJson = json;
  $('expiredBox').classList.toggle('hidden', !list.length);
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('expiredList').innerHTML = list.slice(0, 8).map((e) => {
    const it = e.items[0] || {};
    const more = e.items.length > 1 ? ` +${e.items.length - 1} more` : '';
    return `<li>
      <div class="exp-title">${esc(it.title || 'Order ' + e.orderId)}${it.quantity ? ` <b>×${esc(it.quantity)}</b>` : ''}${esc(more)}</div>
      <div class="muted">Ordered ${esc(e.orderDate || '?')}${e.storeName ? ` · ${esc(e.storeName)}` : ''} · ${esc(refundLine(e))}</div>
      <div class="row">
        ${it.productUrl ? `<button class="ghost" data-reorder="${esc(it.productUrl)}">Re-order</button>` : ''}
        <button class="ghost" data-order="${esc(e.orderId)}">View order</button>
        <button class="ghost" data-done="${esc(e.orderId)}" title="Hide this one (re-ordered or not needed)">Done</button>
      </div></li>`;
  }).join('') + (list.length > 8 ? `<li class="muted">…and ${list.length - 8} more</li>` : '');
}
$('expiredList').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.reorder) chrome.tabs.create({ url: b.dataset.reorder });
  if (b.dataset.order) chrome.tabs.create({ url: `https://www.aliexpress.com/p/order/detail.html?orderId=${b.dataset.order}` });
  if (b.dataset.done) { await bg('dismissExpired', { orderIds: [b.dataset.done] }); expiredJson = ''; renderExpired(); }
});

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

$('btnQuick').onclick = () => runSync(true);
$('btnFull').onclick = () => runSync(false);
$('btnDeep').onclick = async () => { await bg('deepSync', {}); refresh(); };
$('btnRefetch').onclick = async () => { await bg('deepSync', { force: true }); refresh(); };
$('btnStopDeep').onclick = async () => { await bg('stopDeepSync'); refresh(); };


$('btnJson').onclick = async () => {
  const orders = await bg('exportOrders');
  download(`aliexpress-orders-${stamp()}.json`, JSON.stringify(AEX.buildPayload(orders, 'aliexpress-order-sync-extension'), null, 2), 'application/json');
};
$('btnCsv').onclick = async () => {
  const orders = await bg('exportOrders');
  download(`aliexpress-orders-${stamp()}.csv`, AEX.toCSV(orders), 'text/csv');
};
$('fileImport').onchange = async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const counts = await bg('importOrders', { payload: JSON.parse(await file.text()) });
    $('importStatus').textContent = `Imported: ${counts.created} new, ${counts.updated} updated, ${counts.unchanged} unchanged`;
  } catch (e) {
    $('importStatus').textContent = 'Import failed: ' + e.message;
  }
  ev.target.value = '';
  refresh();
};

$('btnSheet').onclick = async () => {
  const el = $('sheetStatus');
  el.dataset.busy = '1';
  el.textContent = 'Syncing to Google Sheet…';
  try {
    const r = await bg('syncSheet');
    el.textContent = `Sheet updated: ${r.orders} orders / ${r.items} items${r.removed ? ` · ${r.removed} cancelled removed` : ''}`;
  } catch (e) {
    el.textContent = 'Sheet sync failed: ' + e.message;
  } finally {
    setTimeout(() => delete el.dataset.busy, 4000);
  }
};
$('btnOpenSheet').onclick = async () => {
  const s = await bg('getState');
  if (s.settings.sheetViewUrl) chrome.tabs.create({ url: s.settings.sheetViewUrl });
};

// ---- clean up the online AliExpress order list ----
// The plan and status live in the worker, so closing the popup (or a dialog stealing focus)
// doesn't reset anything. The one-order test is asked for once, ever.
let cleanPlan = null;
let cleanTested = false;
const SKIP_LABEL = { notFinished: 'not completed yet', noDetails: 'details not fetched', tooRecent: 'too recent', notInSheet: 'not in the sheet', sheetDiffers: 'sheet differs from local', refundPending: 'cancelled, waiting for the refund' };

function setCleanStatus(text) {
  $('cleanStatus').textContent = text;
  chrome.storage.local.set({ cleanupStatus: { at: Date.now(), text } });
}

const checkCount = () => (cleanPlan && cleanPlan.checkIds ? cleanPlan.checkIds.length : 0);

function showCleanButtons() {
  const n = cleanPlan ? cleanPlan.orderIds.length : 0;
  const any = n + checkCount() || (cleanPlan && cleanPlan.sweepCancelled);
  $('btnCleanOne').classList.toggle('hidden', !any || cleanTested);
  $('btnCleanAll').classList.toggle('hidden', !any || !cleanTested);
  $('btnCleanAll').textContent = n ? `Remove ${n === 1 ? '1 order' : `${n} orders`}` : 'Remove refunded cancelled orders';
}

function planText(p) {
  const skipped = Object.entries(p.skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${SKIP_LABEL[k] || k}`).join(', ');
  return p.orderIds.length
    ? `${p.orderIds.length} order${p.orderIds.length === 1 ? '' : 's'} can be removed (${p.completed} completed, older than ${p.minAgeDays} days${p.cancelled ? `; ${p.cancelled} cancelled${p.expired ? `, ${p.expired} of them expired` : ''}, refund cleared` : ''}).${skipped ? ` Kept: ${skipped}.` : ''}${cleanTested ? '' : ' Try one first.'}`
    : p.checkIds && p.checkIds.length
      ? `${p.checkIds.length} cancelled order${p.checkIds.length === 1 ? '' : 's'} may still be waiting for a refund. Clean-up checks the whole orders page and removes every cancelled order that says "Refund complete".${skipped ? ` Kept: ${skipped}.` : ''}`
      : `Nothing saved is due for removal.${skipped ? ` Kept: ${skipped}.` : ''}${p.sweepCancelled ? ' Clean-up can still check the orders page for cancelled orders whose refund is complete.' : ''}`;
}

(async () => {
  try {
    const st = await bg('cleanupState');
    cleanTested = st.tested;
    cleanPlan = st.plan;
    const { cleanupStatus } = await chrome.storage.local.get('cleanupStatus');
    if (cleanPlan && cleanupStatus && Date.now() - cleanupStatus.at < 3600000) $('cleanStatus').textContent = cleanupStatus.text;
  } catch (e) { /* worker restarting; the buttons just start fresh */ }
  showCleanButtons();
})();

$('btnCleanPlan').onclick = async () => {
  cleanPlan = null;
  showCleanButtons();
  try {
    setCleanStatus('Updating the Google Sheet first…');
    await bg('syncSheet');
    setCleanStatus('Checking which orders the sheet has…');
    cleanPlan = await bg('cleanupPlan');
    setCleanStatus(planText(cleanPlan));
  } catch (e) {
    setCleanStatus('Clean-up check failed: ' + e.message);
  }
  showCleanButtons();
};

async function runCleanup(orderIds, { limit } = {}) {
  const checkIds = (cleanPlan.checkIds || []).slice();
  // Every order is already in the Google Sheet (or cancelled with nothing owed), and the
  // worker keeps a local copy of everything; no backup file needed.
  await bg('snapshotOrders');
  setCleanStatus('Opening orders page…');
  const tab = await findOrCreateOrdersTab();
  setCleanStatus('Removing — keep the AliExpress tab open (you can close this popup).');
  const r = await sendToTab(tab.id, { type: 'cleanupOrders', orderIds, checkIds, sweepCancelled: !!cleanPlan.sweepCancelled, limit });
  if (!r || r.error) throw new Error((r && r.error) || 'no reply from the orders page');
  const notListed = r.notListed || r.notFound || [];
  const done = new Set([...r.removedIds, ...notListed, ...r.failed.map((f) => f.orderId)]);
  cleanPlan.orderIds = cleanPlan.orderIds.filter((id) => !done.has(id));
  // Checked once per run: what wasn't removed is still waiting for its refund.
  if (limit == null) cleanPlan.checkIds = [];
  else cleanPlan.checkIds = cleanPlan.checkIds.filter((id) => !done.has(id));
  const fail = r.failed.length ? ` · ${r.failed.length} failed (${r.failed[0].error})` : '';
  const gone = notListed.length ? ` · ${notListed.length} weren't in your online list any more (skipped from now on)` : '';
  const unread = r.unreadable && r.missing ? ` · couldn't read the order number on ${r.unreadable} order card${r.unreadable === 1 ? '' : 's'}: use Troubleshooting → Copy page sample and report it` : '';
  const wait = r.waiting && r.waiting.length ? ` · ${r.waiting.length} cancelled order${r.waiting.length === 1 ? '' : 's'} on the page ${r.waiting.length === 1 ? "doesn't" : "don't"} show "Refund complete" yet (${r.waiting.slice(0, 3).join(', ')}${r.waiting.length > 3 ? ', …' : ''})` : '';
  const scanned = r.scanned != null && limit == null ? ` Checked ${r.scanned} order card${r.scanned === 1 ? '' : 's'}.` : '';
  setCleanStatus(`Removed ${r.removed} from the AliExpress list${fail}${gone}${wait}${unread}${r.stopped ? ` · ${r.stopped}` : ''}.${scanned}`);
  return r;
}

$('btnCleanOne').onclick = async () => {
  if (!cleanPlan) return;
  try {
    const r = await runCleanup(cleanPlan.orderIds.slice(), { limit: 1 });
    const el = $('cleanStatus');
    if (r.removed) {
      cleanTested = true;
      await bg('markCleanupTested');
      setCleanStatus(el.textContent + (cleanPlan.orderIds.length + checkCount() ? ' Check the AliExpress tab, then remove the rest.' : ''));
    } else if (r.failed.length) {
      setCleanStatus(el.textContent + ' Open the orders page, use Troubleshooting → Copy page sample, and report it.');
    } else if (!cleanPlan.orderIds.length && !checkCount()) {
      setCleanStatus(el.textContent + ' Nothing left to remove.');
    }
  } catch (e) {
    setCleanStatus('Clean-up failed: ' + e.message);
  }
  showCleanButtons();
  refresh();
};

$('btnCleanAll').onclick = async () => {
  if (!cleanPlan) return;
  try {
    await runCleanup(cleanPlan.orderIds.slice());
  } catch (e) {
    setCleanStatus('Clean-up failed: ' + e.message);
  }
  showCleanButtons();
  refresh();
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'cleanupProgress') setCleanStatus(`Removing… ${msg.removed} of ${msg.total}${msg.failed ? ` · ${msg.failed} failed` : ''}`);
});

$('btnSettings').onclick = () => chrome.runtime.openOptionsPage();

$('btnSample').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'debugSample' });
    await navigator.clipboard.writeText(r.sample);
    $('btnSample').textContent = `Copied (${r.sample.length} chars)`;
  } catch (e) {
    $('btnSample').textContent = 'Open an AliExpress order page first';
  }
};

$('btnClear').onclick = async () => {
  if (!confirm('Delete all locally saved orders? (Exported files and your Google Sheet are not affected.)\n\nAn automatic backup is kept: "Restore automatic backup" brings them back.')) return;
  await bg('clearAll');
  showBackup();
  refresh();
};

async function showBackup() {
  const b = await bg('autoBackupInfo').catch(() => null);
  $('btnRestore').classList.toggle('hidden', !b);
  if (b) $('btnRestore').textContent = `Restore automatic backup (${b.count} orders, ${shortDate(b.at)})`;
}
$('btnRestore').onclick = async () => {
  if (!confirm('Merge the automatic backup back into your saved orders? Nothing already saved is lost.')) return;
  const r = await bg('restoreAutoBackup');
  $('btnRestore').textContent = `Restored (${r.created} new, ${r.updated} updated)`;
  refresh();
};
showBackup();

refresh();
setInterval(refresh, 1500);
