# Troubleshooting and FAQ

## Common problems

**Nothing happens when I click Full sync / Quick sync.**
Open **My Orders** (<https://www.aliexpress.com/p/order/index.html>) and make sure you're signed in. If you just installed or updated Cart Compass, reload that tab once.

**Some orders have short titles or no prices.**
They haven't had their details fetched yet. Click **Fetch details** until the popup shows *0 still need details*.

**A re-order warning didn't appear.**
- Check the order is saved: run **Quick sync**.
- Cancelled orders don't trigger warnings.
- Products from another store only match when they share a model or part number.

**Sheet errors** ("did not return JSON", "Wrong sheet key"…)
See the troubleshooting table in [[Google Sheet Setup]].

**Clean-up says nothing can be removed.**
The status line lists why orders are kept: *not completed yet*, *too recent*, *details not fetched*, *not in the sheet*, or *cancelled, waiting for the refund*. See [[Cleaning Up Your Order List]].

**"The extension was updated: reload this page."**
Chrome disconnects open tabs from an extension when it updates. Reload the AliExpress tab.

**I cleared my data by mistake.**
Popup → **Troubleshooting → Restore automatic backup**. See [Export, Import and Backups](Export-Import-and-Backups).

## When AliExpress changes its pages

AliExpress redesigns its pages from time to time, so a field can stop being read. To report it:

1. Open the page that's wrong: the orders list, or an order's detail page with the price breakdown expanded.
2. In the popup, open **Troubleshooting** and click **Copy page sample**. This copies an outline of the page, with addresses and phone numbers removed. Skim it before sharing.
3. [Open an issue](https://github.com/jkomilanowicz-lab/Cart-Compass/issues/new/choose) with the **A field is missing or wrong** template and paste the sample.

For anything else, use the **Bug report** or **Feature request** template.

## FAQ

**Does Cart Compass send my data anywhere?**
No, only where you send it: an export file, or your own Google Sheet. See [[Privacy and Permissions]].

**Does it work with multiple AliExpress accounts?**
It saves whatever orders you sync in that browser profile. Use a separate Chrome profile per account to keep them apart.

**Does it place or change orders?**
No. The only change it ever makes on AliExpress is removing orders from your online list, and only when you run clean-up.

**Is it free?**
Yes. It's free and open source.
