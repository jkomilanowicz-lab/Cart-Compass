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
let cleanPlan = null;
let backedUp = false;
const SKIP_LABEL = { notFinished: 'not completed yet', noDetails: 'details not fetched', tooRecent: 'too recent', notInSheet: 'not in the sheet', sheetDiffers: 'sheet differs from local' };

function showCleanButtons() {
  const n = cleanPlan ? cleanPlan.orderIds.length : 0;
  $('btnCleanOne').classList.toggle('hidden', !n || cleanPlan.tested);
  $('btnCleanAll').classList.toggle('hidden', !n || !cleanPlan.tested);
  $('btnCleanAll').textContent = `Remove ${n === 1 ? 'the last one' : `remaining ${n}`}`;
}

$('btnCleanPlan').onclick = async () => {
  const el = $('cleanStatus');
  cleanPlan = null;
  showCleanButtons();
  try {
    el.textContent = 'Updating the Google Sheet first…';
    await bg('syncSheet');
    el.textContent = 'Checking which orders the sheet has…';
    const p = await bg('cleanupPlan');
    cleanPlan = { ...p, tested: false };
    const skipped = Object.entries(p.skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${SKIP_LABEL[k] || k}`).join(', ');
    el.textContent = p.orderIds.length
      ? `${p.orderIds.length} order${p.orderIds.length === 1 ? '' : 's'} older than ${p.minAgeDays} days can be removed (${p.completed} completed${p.cancelled ? `, ${p.cancelled} cancelled` : ''}).${skipped ? ` Kept: ${skipped}.` : ''} Try one first.`
      : `Nothing to remove right now.${skipped ? ` Kept: ${skipped}.` : ''}`;
  } catch (e) {
    el.textContent = 'Clean-up check failed: ' + e.message;
  }
  showCleanButtons();
};

async function runCleanup(orderIds) {
  const el = $('cleanStatus');
  if (!backedUp) {
    // A backup file first: AliExpress can't undo a delete.
    const orders = await bg('getOrders');
    download(`aliexpress-orders-backup-${stamp()}.json`, JSON.stringify(AEX.buildPayload(orders, 'aliexpress-order-sync-extension'), null, 2), 'application/json');
    backedUp = true;
  }
  el.textContent = 'Opening orders page…';
  const tab = await findOrCreateOrdersTab();
  el.textContent = 'Removing — keep the AliExpress tab open (you can close this popup).';
  const r = await sendToTab(tab.id, { type: 'cleanupOrders', orderIds });
  if (!r || r.error) throw new Error((r && r.error) || 'no reply from the orders page');
  const done = new Set(r.removedIds);
  cleanPlan.orderIds = cleanPlan.orderIds.filter((id) => !done.has(id) && !r.failed.some((f) => f.orderId === id) && !r.notFound.includes(id));
  const fail = r.failed.length ? ` · ${r.failed.length} failed (${r.failed[0].error})` : '';
  el.textContent = `Removed ${r.removed} from the AliExpress list${fail}${r.notFound.length ? ` · ${r.notFound.length} not found online` : ''}${r.stopped ? ` · ${r.stopped}` : ''}.`;
  return r;
}

$('btnCleanOne').onclick = async () => {
  if (!cleanPlan || !cleanPlan.orderIds.length) return;
  if (!confirm('Delete the oldest eligible order from your AliExpress order list as a test?\n\nAliExpress cannot undo this. The order stays saved in this extension and your Google Sheet, and a backup JSON is downloaded first.')) return;
  try {
    const r = await runCleanup(cleanPlan.orderIds.slice(0, 1));
    if (r.removed) {
      cleanPlan.tested = true;
      $('cleanStatus').textContent += ` Check the AliExpress tab, then remove the rest.`;
    } else {
      $('cleanStatus').textContent += ' Open the orders page, use Troubleshooting → Copy page sample, and report it.';
    }
  } catch (e) {
    $('cleanStatus').textContent = 'Clean-up failed: ' + e.message;
  }
  showCleanButtons();
  refresh();
};

$('btnCleanAll').onclick = async () => {
  if (!cleanPlan || !cleanPlan.orderIds.length) return;
  const n = cleanPlan.orderIds.length;
  if (!confirm(`Delete ${n} order${n === 1 ? '' : 's'} from your AliExpress order list?\n\nAliExpress cannot undo this. They stay saved in this extension and your Google Sheet.`)) return;
  try {
    await runCleanup(cleanPlan.orderIds.slice());
  } catch (e) {
    $('cleanStatus').textContent = 'Clean-up failed: ' + e.message;
  }
  showCleanButtons();
  refresh();
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'cleanupProgress') $('cleanStatus').textContent = `Removing… ${msg.removed} of ${msg.total}${msg.failed ? ` · ${msg.failed} failed` : ''}`;
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
  if (!confirm('Delete all locally saved orders? (Exported files and your Google Sheet are not affected.)\n\nOrders you removed from the AliExpress list can only come back by importing a JSON backup.')) return;
  await bg('clearAll');
  refresh();
};

refresh();
setInterval(refresh, 1500);
