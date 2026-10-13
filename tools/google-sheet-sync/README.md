# Google Sheet review copy

Use this to keep a live, reviewable copy of your AliExpress orders in Google Sheets. Each sync rewrites three tabs:

| Tab | One row per | Columns worth checking |
|---|---|---|
| **Orders** | order | status, item count, units, total, tracking, `hasDetails`, and an **open** link to the AliExpress order |
| **Items** | product line | thumbnail, title, variant, quantity, unit price, product ID, and **timesOrdered** (how many orders contain the same product; anything above 1 is a re-order) |
| **Sync log** | sync | received / upserted / removed counts |

Cancelled/closed orders are left out. If an order is cancelled after it already reached the sheet, the next sync removes it.

## Setup (about 5 minutes)

1. Create a new Google Sheet, for example "AliExpress Orders (review)".
2. **Extensions → Apps Script**. Delete the starter code, paste in all of [`Code.gs`](Code.gs), and save.
3. Optional: in the Apps Script editor, pick **setupSheets** in the function dropdown and click **Run**. This creates the Orders / Items / Sync log tabs, headers and formats right away. Otherwise the first sync creates them. Other tabs, such as `Sheet1`, are left alone.
4. In the script, change `SYNC_KEY` to a long random string and save. (Alternatively, set it under Project Settings → Script properties → `SYNC_KEY`.)
5. **Deploy → New deployment**. Click the gear and pick **Web app**. Set *Execute as*: **Me** and *Who has access*: **Anyone**, then click **Deploy**. Authorize when asked. Copy the **Web app URL** (it ends in `/exec`).
   *"Anyone" lets the extension reach the URL. The `SYNC_KEY` check stops anyone else from writing to the sheet.*
6. In the extension popup, open **Settings** and fill in:
   - (Settings now open as their own page: popup → **⚙ Settings**. Fields save as you type.)
   - **Google Sheet web app URL**: the `/exec` URL.
   - **Google Sheet key**: the same `SYNC_KEY`.
   - **Google Sheet link** (optional): the normal sheet URL, so the **Open sheet** button works.
   - Optionally tick **Auto-sync to the sheet after each save**.

   Click **Save** and approve the permission prompt for `script.google.com`.
7. Click **Sync to Google Sheet**.

If you edit `Code.gs` later, go to **Deploy → Manage deployments → Edit → Version: New version**. Otherwise the URL keeps running the old code.

## Troubleshooting

- **"Sheet did not return JSON"**: the deployment access isn't set to *Anyone*, or the URL isn't the `/exec` one.
- **"Wrong sheet key"**: the key in the extension doesn't match `SYNC_KEY`.
- **"Set SYNC_KEY in the Apps Script first"**: the placeholder key was never changed.
- **"The Google Sheet script is out of date"** (from *Find orders to remove*): the clean-up check needs version 0.7.0 or later of `Code.gs`. Paste the latest file and deploy a **new version** as described above.
