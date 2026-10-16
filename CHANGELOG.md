# Changelog

What changed in each version of Cart Compass. Each version is also published on the [Releases](../../releases) page with its store zip.

## 1.1.0 (2026-10-16)

### New
- **Expired orders are flagged.** When a seller doesn't ship in time, AliExpress cancels the order ("has not shipped in the required time"). Those orders now show in the popup under **⚠ Expired: never shipped**, with their refund status, so you know the item isn't coming and may need re-ordering. **Re-order** opens the product, **View order** opens the order, and **Done** hides it. The product page panel mentions it too.
- **Refund tracking** for cancelled and expired orders, read from the order page ("Refund complete", "Refund successful", refund amount) and from "Cancellation refund processed" emails in the Gmail backfill.
- **Clean-up includes cancelled and expired orders** once their refund has cleared: either the refund shows on the order, or a wait has passed (Settings → refund wait, default 14 days). Unpaid orders go right away.
- **Automatic local backup.** Cart Compass keeps a copy of your saved orders, refreshed before every clean-up and before *Clear local data*. Restore it from **Troubleshooting → Restore automatic backup**.

### Improved
- **Clean-up is quicker to use.** No more backup file download, the one-order test is only asked for the first time, there are no extra confirmation boxes, and closing the popup no longer resets the clean-up. Reopen it and it picks up where it left off.
- **Clean-up reads the orders page directly** for cancelled orders: anything marked *Refund complete* is removed, even if it was never synced (it's saved first). The status line reports how many cards were checked and which cancelled orders are still waiting on a refund.

### Fixed
- **"Ref. Number" order cards are recognised.** Newer order cards that show *Ref. Number* instead of *Order ID* weren't recognised, so clean-up skipped them and could wrongly report them as missing from the online list. Those marks are cleared automatically on update.
- **"Refund complete" counts as a finished refund.** It wasn't recognised before.

## 1.0.0: Cart Compass
- New name and icon: **Cart Compass**, order history & re-order alerts for AliExpress.
- First Chrome Web Store release. Permissions are kept to a minimum: AliExpress pages, plus optional access to Google Apps Script for sheet sync.

## 0.8.0
- The popup no longer receives the Google Sheet key; only the settings page reads it.
- Fixed: tabs left open during an extension update no longer log "Extension context invalidated" errors.

## 0.7.0
- **Clean up the AliExpress order list:** delete old, completed orders from your online *My Orders* list once they're fetched in full and confirmed in your Google Sheet. Syncs stay fast and the list stays short. Removed orders stay saved in the extension and the sheet, so re-order warnings still count them. It removes one order as a test first and downloads a JSON backup before the first delete. Options: minimum age (default 30 days), and whether to include cancelled orders.
- **Re-order warnings across stores:** a product from a different store now counts as "likely the same item" when it shares a model or part number (e.g. *N16R8*, *W25Q128*, *NE555*), including numbers that only appear in the variant you picked. The product panel has a *Same item from other stores* section, and cart/checkout badges say *Likely ordered (other store)*.
- The Google Sheet script gained a `verify` request used by clean-up. **Re-deploy `Code.gs` as a new version.**

## 0.6.0 — first public release
- Full order history sync from *My Orders*; order detail fetching in background tabs.
- Price breakdown per order (subtotal, shipping, tax / "Additional charges", discounts, total), with a `totalsCheck` sanity check.
- Landed unit cost per item.
- Cancelled orders ignored by default.
- Re-order warnings on product, cart and checkout pages.
- Google Sheet sync (Apps Script web app) with Orders / Items / Sync log tabs.
- JSON / CSV export and import; Gmail backfill script; DevTools console exporter.
