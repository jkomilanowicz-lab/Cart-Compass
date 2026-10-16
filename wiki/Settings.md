# Settings

Open the popup and click **⚙ Settings**. Changes save as you type.

## Google Sheet

| Setting | Default | What it does |
|---|---|---|
| **Web app URL (ends in /exec)** | empty | Your sheet's Apps Script address. See [[Google Sheet Setup]]. |
| **Sheet key** | empty | The `SYNC_KEY` from your script. Stored only in this browser, shown masked, never exported. |
| **Sheet link** | empty | Your spreadsheet's normal address, for the popup's **Open sheet** button. |
| **Auto-sync to the sheet after each save** | off | Updates the sheet a few seconds after new orders are saved. |
| **Allow access & test sheet** | — | Asks Chrome for access to `script.google.com`, then checks the URL and key. |

## Sync

| Setting | Default | What it does |
|---|---|---|
| **Ignore cancelled/closed orders** | on | Keeps cancelled orders out of exports, the sheet and re-order warnings. They're still saved, so expired orders can be flagged. |
| **Detail pages per "Fetch details" run** | 150 | How many order pages one *Fetch details* click reads. |

## Clean up AliExpress order list

| Setting | Default | What it does |
|---|---|---|
| **Only remove orders older than (days)** | 30 | Completed orders younger than this stay in your online list. |
| **Also remove cancelled and expired orders** | on | Clean-up also removes these once their refund is complete. |
| **Days to allow for a refund after an order is cancelled** | 14 | If no refund is seen on the order, it's treated as cleared after this many days. |

See [[Cleaning Up Your Order List]] and [[Expired Orders and Refunds]].
