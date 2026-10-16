/* Settings page: opens in a tab, so it doesn't close when focus moves (unlike the popup). */
const $ = (id) => document.getElementById(id);
const TEXT = ['sheetUrl', 'sheetKey', 'sheetViewUrl', 'detailBatchLimit', 'cleanupMinAgeDays', 'refundWaitDays'];
const CHECKS = ['autoSheetSync', 'ignoreCancelled', 'cleanupCancelled'];

function bg(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!r || !r.ok) return reject(new Error((r && r.error) || 'No response'));
      resolve(r.result);
    });
  });
}

function readForm() {
  const s = {};
  for (const k of TEXT) s[k] = $(k).value.trim();
  for (const k of CHECKS) s[k] = $(k).checked;
  s.detailBatchLimit = Math.max(1, parseInt(s.detailBatchLimit, 10) || 150);
  const age = parseInt(s.cleanupMinAgeDays, 10);
  s.cleanupMinAgeDays = Number.isFinite(age) && age >= 0 ? age : 30;
  const wait = parseInt(s.refundWaitDays, 10);
  s.refundWaitDays = Number.isFinite(wait) && wait >= 0 ? wait : 14;
  return s;
}

let timer;
function autosave() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await bg('saveSettings', { settings: readForm() });
    $('saved').textContent = 'Saved ✓';
    $('saved').className = 'pill ok';
    setTimeout(() => { $('saved').textContent = 'Changes save automatically'; $('saved').className = 'pill'; }, 1500);
  }, 300);
}

async function load() {
  const settings = await bg('getSettings');
  for (const k of TEXT) $(k).value = settings[k] == null ? '' : settings[k];
  for (const k of CHECKS) $(k).checked = !!settings[k];
  for (const k of TEXT) $(k).addEventListener('input', autosave);
  for (const k of CHECKS) $(k).addEventListener('change', autosave);
}

// Ask Chrome for access to a URL's site (needed for anything other than localhost).
async function allow(url) {
  const u = new URL(url);
  if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return true;
  if (u.protocol !== 'https:') throw new Error('Use an https:// URL');
  if (u.hostname !== 'script.google.com') throw new Error('Paste the Apps Script web app URL (https://script.google.com/macros/s/…/exec)');
  const origins = [u.origin + '/*'];
  // Apps Script answers through a redirect to googleusercontent.com.
  if (u.hostname === 'script.google.com') origins.push('https://script.googleusercontent.com/*');
  return chrome.permissions.request({ origins });
}

$('btnSheetAccess').onclick = async () => {
  const msg = $('sheetMsg');
  const url = $('sheetUrl').value.trim();
  try {
    if (!url) throw new Error('Paste the web app URL first');
    if (!(await allow(url))) throw new Error('Chrome access was not granted');
    await bg('saveSettings', { settings: readForm() });
    msg.textContent = 'Testing…';
    const r = await bg('testSheet');
    msg.textContent = r.ok ? '✓ Sheet reachable and key accepted. Use "Sync to Google Sheet" in the popup.' : '✗ ' + r.error;
  } catch (e) {
    msg.textContent = '✗ ' + e.message;
  }
};


load();
