# Data format

**Export JSON**, **Import JSON**, the Gmail backfill and the Google Sheet all share one order format (`schemaVersion: 1`).

```json
{
  "schemaVersion": 1,
  "source": "aliexpress-order-sync-extension",
  "exportedAt": "2026-10-01T06:34:05.000Z",
  "orderCount": 1,
  "orders": [ { "…order…": "…" } ]
}
```

## Order

| Field | Type | Notes |
|---|---|---|
| `orderId` | string | AliExpress order number (16 digits). Unique key. |
| `orderDate` | `YYYY-MM-DD` | |
| `status` | string | One of `awaiting_payment`, `processing`, `shipped`, `completed`, `closed` (cancelled/refunded), `dispute` or `unknown`. A status never moves backwards. |
| `statusText` | string | AliExpress's own wording, e.g. "Awaiting delivery". |
| `storeName`, `storeUrl` | string | |
| `currency` | string | ISO code, e.g. `USD`. |
| `subtotal` | number | Item subtotal shown on the order page. |
| `shipping` | number | `0` means free shipping. `null` means unknown. |
| `tax` | number | Tax charged ("Additional charges", VAT, GST). |
| `discount` | number | Store and AliExpress discounts, coupons and coins, as a **positive** number. |
| `total` | number | What you paid for the order. |
| `itemsSubtotal` | number | *Derived:* the sum of `lineTotal`s. |
| `totalsCheck` | `ok` / `mismatch` / `""` | *Derived:* whether subtotal + shipping + tax − discount equals the total (within 0.02). `mismatch` usually means a value was read wrongly. |
| `items` | array | See below. |
| `tracking` | `[{number, carrier}]` | |
| `sources` | array | Where the data came from: `web-list`, `web-detail`, `gmail`. |
| `cancelled` | boolean | Present on cancelled-order markers: `{orderId, status: "closed", cancelled: true, items: []}`. |
| `detailFetchedAt`, `firstSeenAt`, `updatedAt` | ISO timestamp | |

`null` always means *unknown*. It never means zero.

## Item (`items[]`)

| Field | Type | Notes |
|---|---|---|
| `lineId` | string | Stable key: `orderId:productId:variantHash`. |
| `productId` | string | AliExpress item ID (`/item/<id>.html`). |
| `title`, `variant` | string | `titleTruncated: true` when the title came from an email. |
| `quantity` | number | Number of listings bought. A "10 pcs" listing bought ×2 is `2`. |
| `unitPrice` | number | Price of one listing, before shipping and tax. |
| `lineTotal` | number | `unitPrice × quantity`. |
| `landedUnitCost` | number | *Derived:* what one listing really cost. The order's `total − itemsSubtotal` (shipping + tax − discounts) is spread across lines by value, then divided by quantity. |
| `imageUrl`, `productUrl` | string | |

## CSV

One row per item, with the order's fields repeated on each row:

`orderId, orderDate, status, statusText, storeName, currency, orderSubtotal, orderShipping, orderTax, orderDiscount, orderTotal, totalsCheck, lineId, productId, title, variant, quantity, unitPrice, lineTotal, landedUnitCost, productUrl, imageUrl, tracking, orderUrl`

## Merging rules
- Orders are matched on `orderId` and items on `lineId`.
- Data quality ranks detail page > orders list > email. Better data replaces worse, and missing fields are filled from either.
- A fresh detail-page read replaces `shipping`, `subtotal`, `tax` and `discount`, including blank values.
