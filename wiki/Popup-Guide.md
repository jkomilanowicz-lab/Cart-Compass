# Popup Guide

Click the Cart Compass icon to open the popup. The number on the icon is how many orders are still open (processing, shipped or awaiting payment).

## Numbers at the top

| Box | Meaning |
|---|---|
| **orders** | Orders saved in this browser. |
| **line items** | Products across those orders. |
| **open / in transit** | Orders not delivered or closed yet. |

## ⚠ Expired: never shipped

Only shown when an order expired because the seller didn't ship it in time. Each entry shows the items and the refund status.

| Button | What it does |
|---|---|
| **Re-order** | Opens the product page so you can order it again. |
| **View order** | Opens the order on AliExpress. |
| **Done** | Hides the entry once you've dealt with it. |

More in [[Expired Orders and Refunds]].

## Sync from AliExpress

| Button | What it does |
|---|---|
| **Quick sync** | Loads your order list until a batch has nothing new. Use it day to day. |
| **Full sync** | Loads every order. Use it the first time, or if something seems missing. |
| **Fetch details** | Reads the detail page of each order that needs it: new orders, orders still in transit, and closed orders waiting for a refund. |
| **Re-fetch all details** | Reads every order's detail page again, least recently read first. Rarely needed. |
| **Stop** | Stops a running *Fetch details*. |

The lines below the buttons show when you last synced and how many orders still need details.

## Export

| Button | What it does |
|---|---|
| **Export JSON** | Downloads everything, for backup or other tools. |
| **Export CSV** | Downloads a spreadsheet, one row per item. |
| **Import JSON** | Merges a file from *Export JSON* or the [[Gmail Backfill]]. Nothing already saved is lost. |

Cancelled orders are left out of exports unless you change that in [[Settings]]. More in [Export, Import and Backups](Export-Import-and-Backups).

## Google Sheet

| Button | What it does |
|---|---|
| **Sync to Google Sheet** | Sends your orders to your sheet. |
| **Open sheet** | Opens it, once you've added its link in [[Settings]]. |

See [[Google Sheet Setup]].

## Clean up AliExpress order list

| Button | What it does |
|---|---|
| **Find orders to remove** | Updates your sheet, then works out which orders can be removed from your online AliExpress list. |
| **Remove 1 (test)** | Shown only the first time: removes one order so you can check it worked. |
| **Remove N orders** | Removes the rest. You can close the popup; reopening it picks up where it left off. |
| **Remove refunded cancelled orders** | Shown when nothing saved is due but cancelled orders on the page may show *Refund complete*. |

See [[Cleaning Up Your Order List]].

## ⚙ Settings

Opens the settings page. See [[Settings]].

## Troubleshooting (at the bottom)

| Button | What it does |
|---|---|
| **Copy page sample** | Copies an outline of the AliExpress page you're on, with personal details removed, for reporting a problem. |
| **Restore automatic backup** | Brings back your saved orders from the automatic backup. |
| **Clear local data** | Deletes the orders saved in this browser. A backup is taken first. |
