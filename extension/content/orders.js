/* Order list page (/p/order/index.html): passive capture + full sync on request. */
(function () {
  'use strict';
  if (window.__aexOrdersLoaded) return;
  window.__aexOrdersLoaded = true;

  // After the extension is updated or reloaded, scripts already running in open tabs can no longer
  // reach it ("Extension context invalidated"). Detect that and go quiet instead of throwing.
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  const send = (msg) => new Promise((resolve) => {
    if (!alive()) return resolve({ ok: false, error: 'The extension was updated: reload this page.' });
    try {
      chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError && chrome.runtime.lastError.message }));
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
  // Fire-and-forget progress messages (nobody may be listening).
  const notify = (msg) => { if (!alive()) return; try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { /* reloaded */ } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let syncing = false;
  let lastSavedCount = 0;

  async function captureVisible() {
    const { orders, errors } = AEX.parseOrderList(document);
    if (errors.length) console.warn('[AEX] parse errors', errors);
    if (!orders.length) return { orders: 0 };
    const r = await send({ type: 'saveOrders', orders, origin: 'web-list' });
    lastSavedCount = orders.length;
    return { orders: orders.length, counts: r.ok ? r.result : null, error: r.error };
  }

  async function waitForMore(prevCount, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(500);
      if (AEX.findOrderCards(document).length > prevCount) {
        await sleep(800); // let the batch finish rendering
        return true;
      }
    }
    return false;
  }

  /**
   * Click "View orders" until everything is loaded.
   * quick=true stops once a whole loaded batch was already known and finished
   * (completed/closed) — good for routine "what's new" syncs.
   */
  async function fullSync({ quick = false } = {}) {
    if (syncing) return { error: 'Sync already running' };
    syncing = true;
    showToast('Syncing orders…');
    let totalCreated = 0, totalUpdated = 0, rounds = 0;
    try {
      // Wait for the first batch to render.
      for (let i = 0; i < 40 && !AEX.findOrderCards(document).length; i++) await sleep(500);
      while (true) {
        rounds++;
        const r = await captureVisible();
        if (r.counts) { totalCreated += r.counts.created; totalUpdated += r.counts.updated; }
        showToast(`Syncing… ${r.orders} orders loaded (${totalCreated} new, ${totalUpdated} updated)`);
        notify({ type: 'syncProgress', loaded: r.orders, created: totalCreated, updated: totalUpdated });
        if (quick && rounds > 1 && r.counts && r.counts.created === 0 && r.counts.updated === 0) break;
        const btn = AEX.findLoadMoreButton(document);
        if (!btn || btn.disabled) break;
        const before = AEX.findOrderCards(document).length;
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        if (!(await waitForMore(before))) break;
        await sleep(600 + Math.random() * 600); // be gentle
      }
      if (!quick) await send({ type: 'markFullSync' });
      showToast(`Done: ${lastSavedCount} orders on page, ${totalCreated} new, ${totalUpdated} updated.`, 6000);
      return { loaded: lastSavedCount, created: totalCreated, updated: totalUpdated };
    } finally {
      syncing = false;
    }
  }

  // ---------- clean-up: delete finished, already-recorded orders from the online list ----------

  const cardOrderId = (card) => { try { const o = AEX.parseOrderCard(card); return o && o.orderId; } catch (_) { return null; } };
  const hover = (el) => ['mouseover', 'mouseenter', 'mousemove'].forEach((t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true })));

  async function findDeleteFor(card) {
    let ctrl = AEX.findDeleteControl(card);
    if (ctrl) return ctrl;
    hover(card);
    await sleep(300);
    if ((ctrl = AEX.findDeleteControl(card))) return ctrl;
    // Some layouts tuck "Delete" into a "More" menu that opens outside the card.
    const more = Array.from(card.querySelectorAll('button, a, span, [role="button"]'))
      .find((el) => /^(more|more actions|\.\.\.|…)$/i.test(AEX.cleanText(el.textContent)) || /\bmore\b/i.test(el.getAttribute('aria-label') || ''));
    if (more) {
      more.click();
      await sleep(600);
      const cards = new Set(AEX.findOrderCards(document));
      const item = Array.from(document.querySelectorAll('li, button, a, span, div, [role="menuitem"]'))
        .find((el) => el.children.length === 0 && /^(delete|delete order|remove)$/i.test(AEX.cleanText(el.textContent)) &&
          ![...cards].some((c) => c !== card && c.contains(el)));
      if (item) return item;
    }
    return AEX.findDeleteControl(card, { allowHidden: true });
  }

  async function deleteCard(card, orderId) {
    const ctrl = await findDeleteFor(card);
    if (!ctrl) return { ok: false, error: 'no delete button found on this order' };
    ctrl.scrollIntoView({ block: 'center' });
    await sleep(300);
    ctrl.click();
    const stillListed = () => card.isConnected && cardOrderId(card) === orderId && getComputedStyle(card).display !== 'none';
    let confirmed = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if (!stillListed()) return { ok: true };
      const btn = !confirmed && AEX.findConfirmButton(document);
      if (btn) { btn.click(); confirmed = true; }
    }
    return { ok: false, error: confirmed ? 'order still listed after confirming' : 'no confirmation dialog appeared' };
  }

  /**
   * Delete the given orders from the AliExpress list, loading more orders as needed to find them.
   * limit: stop after this many deletions (the "test" run uses 1: the first eligible order on the page).
   * Orders still missing once the whole list has loaded are reported in notListed.
   */
  async function cleanupOrders({ orderIds = [], checkIds = [], sweepCancelled = false, maxConsecutiveFailures = 3, limit = Infinity } = {}) {
    if (syncing) return { error: 'A sync is already running on this tab' };
    syncing = true;
    const pending = new Set(orderIds.map(String));
    // Cancelled orders still waiting for their refund as far as we know: removed only if their
    // card says the refund is complete (the saved copy may predate that).
    const check = new Set(checkIds.map(String).filter((id) => !pending.has(id)));
    const total = pending.size + check.size;
    const removed = [], failed = [];
    let streak = 0, stopped = null, exhausted = false, unreadable = 0;
    const progress = () => {
      showToast(`Cleaning up… removed ${removed.length}${failed.length ? ` · ${failed.length} failed` : ''}`);
      notify({ type: 'cleanupProgress', removed: removed.length, failed: failed.length, total });
    };
    // The page decides for cancelled orders: whatever the saved copy says (not saved yet, refund
    // not seen yet, marked removed earlier), a card that reads cancelled + refund complete goes.
    const seen = new Set();
    const waiting = []; // cancelled cards whose refund isn't complete yet
    const cancelledCard = (card) => {
      try {
        const raw = AEX.parseOrderCard(card);
        if (!raw) return null;
        // Some layouts put the refund banner just after the card.
        const next = card.nextElementSibling;
        if (next && !AEX.findOrderCards(next).length && !next.matches(AEX.SELECTORS.orderCard.join(','))) {
          const extra = AEX.closeNotes(next.textContent);
          if (extra.refundedAt && !raw.refundedAt) Object.assign(raw, { refundedAt: extra.refundedAt, refundAmount: raw.refundAmount || extra.refundAmount });
        }
        const o = AEX.normalizeOrder(raw, 'web-list');
        if (!AEX.isCancelled(o)) return null;
        return { raw, done: !!(o.refundedAt || o.closeReason === 'unpaid') };
      } catch (_) { return null; }
    };
    try {
      for (let i = 0; i < 40 && !AEX.findOrderCards(document).length; i++) await sleep(500);
      progress();
      outer: while ((pending.size || check.size || sweepCancelled) && removed.length < limit) {
        const cards = AEX.findOrderCards(document).map((c) => [c, cardOrderId(c)]);
        unreadable = cards.filter(([, id]) => !id).length;
        const targets = [];
        for (const [card, id] of cards) {
          if (!id) continue;
          if (pending.has(id)) { targets.push([card, id]); continue; }
          if (seen.has(id) || !(check.has(id) || sweepCancelled)) continue;
          seen.add(id);
          check.delete(id);
          const c = cancelledCard(card);
          if (!c) continue;
          await send({ type: 'saveOrders', orders: [c.raw], origin: 'web-list' }); // keep the record first
          if (c.done) targets.push([card, id]);
          else waiting.push(id);
        }
        if (!targets.length) {
          const btn = AEX.findLoadMoreButton(document);
          if (!btn || btn.disabled) { exhausted = true; break; } // whole list loaded
          const before = AEX.findOrderCards(document).length;
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          if (!(await waitForMore(before))) break;
          continue;
        }
        for (const [card, id] of targets) {
          if (removed.length >= limit) break outer;
          pending.delete(id);
          if (!card.isConnected) continue;
          const r = await deleteCard(card, id);
          if (r.ok) {
            removed.push(id);
            streak = 0;
            await send({ type: 'markRemovedOnline', orderIds: [id] });
          } else {
            failed.push({ orderId: id, error: r.error });
            if (++streak >= maxConsecutiveFailures) { stopped = `stopped after ${streak} failures in a row (${r.error})`; break outer; }
          }
          progress();
          await sleep(1000 + Math.random() * 800); // be gentle
        }
      }
      // Only "not in the list" when the whole list was loaded, every card's order number could be
      // read, and they still weren't there.
      const notListed = exhausted && !stopped && !unreadable ? [...pending] : [];
      if (notListed.length) await send({ type: 'markRemovedOnline', orderIds: notListed, notListed: true });
      showToast(`Clean-up done: removed ${removed.length}${failed.length ? `, ${failed.length} failed` : ''}${notListed.length ? `, ${notListed.length} not in the online list` : ''}.`, 8000);
      return { removed: removed.length, removedIds: removed, failed, notListed, notFound: notListed, stopped, unreadable, missing: exhausted && unreadable ? pending.size : 0, scanned: AEX.findOrderCards(document).length, waiting };
    } finally {
      syncing = false;
    }
  }

  let toastEl;
  function showToast(text, hideAfter) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;padding:10px 14px;border-radius:8px;background:#1f2937;color:#fff;font:13px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = '🧾 ' + text;
    toastEl.style.display = 'block';
    clearTimeout(toastEl._t);
    if (hideAfter) toastEl._t = setTimeout(() => { toastEl.style.display = 'none'; }, hideAfter);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'fullSync') { fullSync(msg).then(sendResponse); return true; }
    if (msg.type === 'cleanupOrders') { cleanupOrders(msg).then(sendResponse); return true; }
    if (msg.type === 'captureVisible') { captureVisible().then(sendResponse); return true; }
    if (msg.type === 'debugSample') { sendResponse({ sample: AEX.debugSample(document) }); return false; }
    return false;
  });

  // Passive capture: whatever the user scrolls/loads gets saved.
  let debounce;
  const observer = new MutationObserver(() => {
    if (!alive()) { observer.disconnect(); return; }
    if (syncing) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (AEX.findOrderCards(document).length !== lastSavedCount) captureVisible();
    }, 1500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { if (alive()) captureVisible(); }, 2500);
})();
