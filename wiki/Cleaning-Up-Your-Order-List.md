# Cleaning Up Your Order List

After a few hundred orders, **My Orders** on AliExpress takes many *View orders* clicks to load, and every sync gets slower. Clean-up deletes old orders from that **online list** once Cart Compass has safely recorded them.

Nothing is deleted from Cart Compass or your Google Sheet, so [[Re-order Warnings]] keep counting those orders.

> **AliExpress can't undo a delete.** Clean-up only removes orders it can account for:
> - completed orders must be confirmed in your Google Sheet;
> - cancelled orders must have had their refund complete.
>
> Cart Compass also takes an automatic backup before every clean-up.

## What gets removed

**Completed orders**, only when all of these are true:
- older than the minimum age (default **30 days**);
- the order's details have been fetched;
- your Google Sheet has the order, with the same status and number of items.

**Cancelled and expired orders**, once their refund is complete:
- the refund shows on the order (*Refund complete*), or
- the refund wait has passed since it closed (default **14 days**).

Unpaid orders go right away. Turn this off with *Also remove cancelled and expired orders* in [[Settings]].

**Never removed:** orders still in progress or in transit, recent orders, and anything not yet in your sheet.

## Step by step

1. Open the popup and click **Find orders to remove**. Cart Compass updates your Google Sheet, then asks it which orders it really has. The status line says how many orders can go, and why the rest are being kept.
2. **The first time only:** click **Remove 1 (test)**. Cart Compass opens My Orders and removes the first eligible order it finds. Check the AliExpress tab to see it's gone.
3. Click **Remove N orders**. Keep the AliExpress tab open while it works through the list. You can close the popup: reopen it later and it carries on where it left off.

Clean-up also reads the orders page itself. Any cancelled order whose card says **Refund complete** is removed, even one Cart Compass hadn't synced yet (it's saved first).

When it finishes, the status line says how many order cards it checked. It also lists any cancelled orders whose refund isn't complete yet.

## If something goes wrong

- **"Set up the Google Sheet first"**: completed orders need the sheet. See [[Google Sheet Setup]].
- **"The Google Sheet script is out of date"**: paste the latest `Code.gs` and deploy a new version (see [Updating the script](Google-Sheet-Setup#updating-the-script)).
- **"no delete button found"**, or it stops after 3 failures: AliExpress probably changed its page, and nothing was removed. See [[Troubleshooting and FAQ]] for how to report it.
- **"couldn't read the order number on N order cards"**: same as above, please report it.
