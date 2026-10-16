# Export, Import and Backups

Your orders are saved in your browser (Chrome's extension storage). There are three ways to keep a copy elsewhere.

## Google Sheet (recommended)

A live copy you can read, sort and filter, updated whenever you sync. Turn on *Auto-sync to the sheet after each save* in [[Settings]] and it stays current on its own. See [[Google Sheet Setup]].

## Export files

| Button | File | Good for |
|---|---|---|
| **Export JSON** | `aliexpress-orders-<date>.json` | A complete backup. Can be imported again. |
| **Export CSV** | `aliexpress-orders-<date>.csv` | Excel, Numbers or Google Sheets. One row per item, with the order's totals on every row. |

Cancelled and closed orders are left out unless you untick *Ignore cancelled/closed orders* in [[Settings]]. Every field is described in [DATA-FORMAT.md](https://github.com/jkomilanowicz-lab/Cart-Compass/blob/main/docs/DATA-FORMAT.md).

## Import

**Import JSON** merges a file from *Export JSON* or the [[Gmail Backfill]] into what you already have:
- new orders are added;
- existing orders are only updated where the file has better information;
- nothing is deleted.

Use it to move to a new computer or browser profile: export there, then import here.

## Automatic backup

Cart Compass keeps a copy of all your saved orders inside the extension. It's refreshed:
- before every clean-up run;
- before **Clear local data**.

To get it back, open the popup → **Troubleshooting → Restore automatic backup**. Like an import, it merges and doesn't overwrite anything.

The automatic backup lives in the same browser profile as your data. If you uninstall the extension or remove the profile, it goes too, so keep the Google Sheet or an occasional JSON export as well.
