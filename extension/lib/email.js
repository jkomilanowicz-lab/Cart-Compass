/*
 * Parser for AliExpress transactional emails (transaction@notice.aliexpress.com).
 * Depends on core.js. Used by the Gmail Apps Script backfill and Node tools.
 *
 * Emails only carry truncated titles ("Mobile Phone Repair Tweezers ..."),
 * variant, quantity and order total, so orders created from email are marked
 * source "gmail" and get upgraded when the extension syncs the website.
 */
(function (root) {
  'use strict';
  const AEX = root.AEX || (typeof require === 'function' ? require('./core.js') : null);

  /** Map an email subject to {orderIds, status, kind}. */
  function parseSubject(subject) {
    const s = AEX.cleanText(subject);
    let m;
    if ((m = s.match(/^(\d+) orders confirmed:\s*(\d{10,})/i))) return { kind: 'confirmed_multi', orderIds: [m[2]], count: +m[1], status: 'processing' };
    if ((m = s.match(/^Order (\d{10,}): order confirmed/i))) return { kind: 'confirmed', orderIds: [m[1]], status: 'processing' };
    if ((m = s.match(/^Order (\d{10,}): (?:order shipped|collected by the carrier|in transit|out for delivery)/i))) return { kind: 'shipped', orderIds: [m[1]], status: 'shipped' };
    if ((m = s.match(/^Order (\d{10,}): (?:how did it go|delivered|order completed|awaiting confirmation)/i))) return { kind: 'completed', orderIds: [m[1]], status: 'completed' };
    if ((m = s.match(/order (\d{10,}) (?:is|has been) (?:closed|cancell?ed)/i))) return { kind: 'closed', orderIds: [m[1]], status: 'closed' };
    // The order number for these two is only in the body.
    if (/order cancell?ed due to late shipment/i.test(s)) return { kind: 'late_shipment', orderIds: [], status: 'closed', needsBody: true };
    if (/cancell?ation refund (?:processed|confirmed|completed)/i.test(s)) return { kind: 'refund', orderIds: [], status: 'closed', needsBody: true };
    if ((m = s.match(/Package (\S+) has been delivered/i))) return { kind: 'package_delivered', orderIds: [], trackingNumber: m[1], status: 'completed' };
    if ((m = s.match(/(?:Order|order) (\d{10,})/))) return { kind: 'other', orderIds: [m[1]], status: null };
    return null;
  }

  /**
   * Flatten an email body into table "cells". Accepts either HTML or the
   * markdown-ish plain text Gmail produces ("| cell | cell |", "[x](url)").
   */
  function toCells(body) {
    let s = String(body || '');
    if (/<\/(td|div|table|a|span|p)>/i.test(s)) {
      s = s.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>/gi, ' |§LINK $1| ')
        .replace(/<[^>]+>/g, ' | ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    } else {
      s = s.replace(/\]\(([^)\s]*)\)/g, ' |§LINK $1| ').replace(/\[/g, ' | ');
    }
    return s.split(/\||\n/).map((c) => AEX.cleanText(c)).filter((c) => c && c !== '.');
  }

  const NOISE = /^(see order details|track order|view all orders|fast delivery|free returns|total|order total|ship to)$/i;

  function addItemCell(order, cell, singleLayout) {
    const items = order.items;
    const cur = items[items.length - 1];
    const qtyOnly = cell.match(/^[x×]\s*(\d+)$/i);
    const variantQty = cell.match(/^(.*\S)\s+[x×](\d+)$/i);
    if (qtyOnly) {
      if (cur && cur.quantity == null) cur.quantity = +qtyOnly[1];
      return;
    }
    // Single-order layout: title cell, then variant cell, then "xN" cell.
    if (singleLayout && cur && cur.quantity == null && cur.variant == null) {
      if (variantQty) { cur.variant = variantQty[1]; cur.quantity = +variantQty[2]; } else cur.variant = cell;
      return;
    }
    // Multi-order cards: "Truncated title... Variant xN" in one cell (one cell per line item).
    if (variantQty) {
      const parts = variantQty[1].split(/\.\.\.(?!\.)\s*/);
      if (parts.length > 1) {
        items.push({ title: parts[0].trim() + '...', titleTruncated: true, variant: parts.slice(1).join('...').trim() || null, quantity: +variantQty[2] });
      } else {
        items.push({ title: variantQty[1], titleTruncated: false, variant: null, quantity: +variantQty[2] });
      }
      return;
    }
    items.push({ title: cell, titleTruncated: /\.\.\.\s*$/.test(cell), variant: null, quantity: null });
  }

  /**
   * Parse an order-confirmation email into raw orders.
   * @param {{subject: string, body: string, date: string|Date}} msg
   * @returns {Array} normalized orders (source "gmail")
   */
  function parseConfirmationEmail(msg) {
    const subj = parseSubject(msg.subject);
    if (!subj || !/^confirmed/.test(subj.kind)) return [];
    const orderDate = AEX.parseDate(new Date(msg.date).toISOString().slice(0, 10));
    const cells = toCells(msg.body);
    const orders = [];
    let cur = null;
    let pendingTotal = false;

    const start = (orderId) => {
      cur = { orderId, orderDate, statusText: 'confirmed', items: [], total: null, currency: null };
      orders.push(cur);
    };

    if (subj.kind === 'confirmed') {
      // Single order: items sit between "Track order" and "Order total".
      const i = cells.findIndex((c) => /^track order$/i.test(c));
      start(subj.orderIds[0]);
      for (let k = i + 1; k < cells.length; k++) {
        const c = cells[k];
        if (/^§LINK/.test(c)) continue;
        if (/^order total$/i.test(c)) { const m = AEX.parseMoney(cells[k + 1]); if (m) { cur.total = m.amount; cur.currency = m.currency; } break; }
        if (NOISE.test(c) || AEX.parseMoney(c) && /^[^a-z]*$/i.test(c)) continue;
        addItemCell(cur, c, true);
      }
    } else {
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        const om = c.match(/^Order\s+(\d{16,19})$/);
        if (om) {
          // Cards render "Order <index><orderId>"; AliExpress order IDs are 16 digits.
          start(om[1].slice(-16));
          continue;
        }
        if (!cur || /^§LINK/.test(c)) continue;
        if (/^total$/i.test(c)) { pendingTotal = true; continue; }
        if (pendingTotal) {
          const m = AEX.parseMoney(c);
          if (m) { cur.total = m.amount; cur.currency = m.currency; }
          pendingTotal = false;
          cur = null; // card finished
          continue;
        }
        if (NOISE.test(c)) continue;
        addItemCell(cur, c, false);
      }
    }

    return orders.map((o) => AEX.normalizeOrder({
      ...o,
      items: o.items.map((it) => ({ ...it, quantity: it.quantity || 1 })),
    }, 'gmail'));
  }

  /** Status-only update derived from a non-confirmation email (subject, plus body where needed). */
  function parseStatusEmail(msg) {
    const subj = parseSubject(msg.subject);
    if (!subj || !subj.status || /^confirmed/.test(subj.kind)) return [];
    const extra = {};
    let orderIds = subj.orderIds;
    if (subj.needsBody) {
      const body = toCells(msg.body).join(' ');
      if (subj.kind === 'late_shipment') {
        orderIds = [(body.match(/order (\d{10,})/i) || [])[1]].filter(Boolean);
        extra.closeReason = 'expired';
        extra.closeReasonText = 'has not shipped in the required time';
      } else {
        // "View details" links carry tradeOrderId=…; "credited … on 2026-10-11".
        orderIds = [(body.match(/tradeOrderId=(\d{10,})/) || body.match(/order (\d{10,})/i) || [])[1]].filter(Boolean);
        const d = body.match(/credited[^.]*? on (\d{4}-\d{2}-\d{2})/i);
        extra.refundedAt = d ? new Date(`${d[1]}T12:00:00Z`).toISOString() : (msg.date || new Date().toISOString());
      }
      if (msg.date) extra.closedAt = msg.date;
    }
    return orderIds.map((orderId) => AEX.normalizeOrder({
      orderId,
      statusText: subj.kind.replace(/_/g, ' '),
      status: subj.status,
      items: [],
      ...extra,
    }, 'gmail'));
  }

  const api = { parseSubject, toCells, parseConfirmationEmail, parseStatusEmail };
  root.AEX = Object.assign(root.AEX || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
