# Gmail Backfill

*Optional.* If you have AliExpress order emails going back further than you want to sync, or orders that no longer appear on the website, an Apps Script can build a starter order list from your Gmail.

Emails carry less detail than the website: titles are cut short, and a "23 orders confirmed" email only lists the first few orders. Treat the result as a starting point. The next website sync fills in the rest.

## Steps

1. Go to <https://script.google.com> and create a **New project**.
2. Replace the starter code with [`tools/gmail-apps-script/Code.gs`](https://github.com/jkomilanowicz-lab/Cart-Compass/blob/main/tools/gmail-apps-script/Code.gs) and save.
3. Pick `exportAliExpressOrders` in the function dropdown and click **Run**. Authorize it when Google asks. On *"Google hasn't verified this app"*, click **Advanced → Go to … (unsafe)**: it's your own script, running in your own account.
4. A JSON file appears in your Google Drive. Download it.
5. In the Cart Compass popup, click **Import JSON** and choose the file.

The script also reads "late shipment" cancellations and "Cancellation refund processed" emails, so expired orders and refunds are picked up too. See [[Expired Orders and Refunds]].

The script runs entirely in your Google account. It only reads emails from AliExpress and writes one file to your Drive.
