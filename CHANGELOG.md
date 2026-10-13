# Changelog

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
