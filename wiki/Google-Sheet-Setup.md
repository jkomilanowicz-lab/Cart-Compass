# Google Sheet Setup

Keep a live copy of your AliExpress orders in a Google Sheet you own. The sheet runs a small Apps Script that receives your orders from the extension. Nothing passes through anyone else's server.

Each sync rewrites three tabs:

| Tab | One row per | Columns worth checking |
|---|---|---|
| **Orders** | order | status, item count, units, total, tracking, `hasDetails`, and an **open** link to the AliExpress order |
| **Items** | product line | thumbnail, title, variant, quantity, unit price, product ID, and **timesOrdered** (how many orders contain the same product; anything above 1 is a re-order) |
| **Sync log** | sync | received / upserted / removed counts |

Cancelled and closed orders are left out. If an order is cancelled after it reached the sheet, the next sync removes it. Other tabs in the spreadsheet, such as `Sheet1` or your own notes, are never touched.

The sheet also serves as your backup. Order-list clean-up only removes a completed order from AliExpress once this sheet confirms it has it.

## Setup (about 5 minutes)

### 1. Create the sheet and add the script

1. Create a new Google Sheet, for example "AliExpress Orders".
2. Open **Extensions → Apps Script**. Delete the starter code, paste in all of [`Code.gs`](https://github.com/jkomilanowicz-lab/Cart-Compass/blob/main/tools/google-sheet-sync/Code.gs), and click **Save** (💾).

### 2. Set your sync key

The sync key is a password that only the extension and your script know. Without it, nobody else can write to your sheet, even if they find its web address.

1. Make up a long random string, at least 20 characters, with letters and numbers. A password manager's generator works well. Don't reuse a real password.
2. Put it in the script, either way:
   - **Simplest:** at the top of the script, replace `change-me-to-a-long-random-string` in `var SYNC_KEY = '…';` with your key, then save.
   - **Keeps the key out of the code:** open **Project Settings** (⚙ in the left bar). Under **Script properties**, add a property named `SYNC_KEY` with your key as the value. A script property takes priority over the value in the code.
3. Keep the key handy for step 4.

### 3. Deploy the script as a web app

1. Optional: pick **setupSheets** in the function dropdown at the top and click **Run**. This creates the tabs, headers and formatting right away. Otherwise the first sync creates them.
2. Click **Deploy → New deployment**. Click the ⚙ next to *Select type* and choose **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**.
4. Google asks you to authorize the script, which only reads and writes this spreadsheet:
   1. Click **Authorize access** and choose your account.
   2. If you see *"Google hasn't verified this app"*, that's expected for a script you wrote yourself. Click **Advanced → Go to (your project name) (unsafe)**, then **Allow**.
5. Copy the **Web app URL**. It ends in `/exec`.

*Why "Anyone"?* The extension has to reach the URL without signing in to Google. The sync key is what protects it: requests without the right key are refused.

### 4. Connect the extension

1. In the popup, click **⚙ Settings**. Changes save as you type.
2. Fill in the **Google Sheet** section:

   | Field | What to enter |
   |---|---|
   | **Web app URL (ends in /exec)** | The URL from step 3. |
   | **Sheet key** | The same key as `SYNC_KEY`. It's stored only in this browser, shown masked, and never included in exports. |
   | **Sheet link** *(optional)* | The normal address of your spreadsheet, so the popup's **Open sheet** button works. |
   | **Auto-sync to the sheet after each save** *(optional)* | Updates the sheet a few seconds after new orders are saved. |

3. Click **Allow access & test sheet**. Chrome asks to let the extension reach `script.google.com`; click **Allow**. You should see *"✓ Sheet reachable and key accepted."*
4. In the popup, click **Sync to Google Sheet**.

## Updating the script

When a new version of Cart Compass changes `Code.gs` (the changelog says so), paste the new file over the old one, save, and then:

**Deploy → Manage deployments → ✏ Edit → Version: New version → Deploy.**

The web app URL stays the same. If you skip this step, the URL keeps running the old code.

## Changing the key

Change `SYNC_KEY` in the script or in Script properties, deploy a new version as described above, then enter the new key in the extension's settings.

## Troubleshooting

| Message | Fix |
|---|---|
| **Sheet did not return JSON** | The deployment's access isn't set to *Anyone*, or the URL isn't the one ending in `/exec`. |
| **Wrong sheet key** | The key in the extension doesn't match `SYNC_KEY`. Check for spaces at either end. If you use a script property, that's the value that counts. |
| **Set SYNC_KEY in the Apps Script first** | The placeholder key was never changed, or the change wasn't deployed as a new version. |
| **The Google Sheet script is out of date** (from *Find orders to remove*) | Clean-up needs `Code.gs` from version 0.7.0 or later. Paste the latest file and deploy a new version. |
| Chrome didn't ask for permission, or the test can't reach the sheet | Click **Allow access & test sheet** again and accept the prompt. You can also check `chrome://extensions` → Cart Compass → Details → Site access. |
| Changes to the script have no effect | Deploy a **new version** (see *Updating the script*). Saving alone isn't enough. |
