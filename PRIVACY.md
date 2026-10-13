# Privacy

**Short version:** Cart Compass has no server, collects nothing, and sends your data only where you tell it to.

## What the extension reads
- AliExpress pages you open while signed in (*My Orders*, order detail pages, product, cart and checkout pages), and order detail pages it opens in a background tab when you click **Fetch details**.
- From those pages it reads order numbers, dates, statuses, store names, item titles, variants, quantities, prices, shipping, tax, discounts, tracking numbers, product links and thumbnail links.
- It does **not** read or store your address, phone number, payment details or password.

## What the extension changes on AliExpress
Nothing, unless you use **Clean up AliExpress order list**. Then, after you confirm, it clicks *Delete* on the orders it listed, in your own signed-in tab. It never places, cancels or pays for orders.

## Where data is stored
- In your browser's extension storage (`chrome.storage.local`) on your computer.
- **Clear local data** in the popup deletes it. So does removing the extension.

## Where data is sent
Only where you send it:
- **Export JSON / CSV:** a file saved to your Downloads folder.
- **Sync to Google Sheet:** the Apps Script web app *you* deploy in *your* Google account, with *your* key.

There is no analytics, telemetry, advertising or third-party service. The extension makes network requests only to AliExpress (to read pages you're signed in to) and to the Google Sheet URL you configure.

## Permissions and why
| Permission | Why |
|---|---|
| `storage`, `unlimitedStorage` | Save your order history locally. A long history can exceed the default quota. |
| `tabs`, `scripting` | Find or open your orders tab, open detail pages in the background, and attach to a tab that was open before you installed the extension. |
| Access to `aliexpress.com` / `aliexpress.us` | Read your order pages and show re-order warnings. |
| Optional access to `script.google.com` | Asked for only when you set up Google Sheet sync, to reach the Apps Script web app you deployed. |

## The Apps Scripts
The Google Sheet and Gmail scripts run in your own Google account under your authorization. Their source is in this repository; read it before you run it.
