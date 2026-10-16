# Contributing

Thanks for helping. The most valuable contributions are **fixes for AliExpress page changes**, because the site's markup changes often.

## Issues

[Issues](../../issues) are where bugs, page changes and ideas are tracked. Pick the template that fits:
- **A field is missing or wrong:** AliExpress changed a page, or a value is read incorrectly. Include a page sample.
- **Bug report:** something in the extension doesn't work as expected.
- **Feature request:** an idea or improvement.

Each change that ships is listed in [CHANGELOG.md](CHANGELOG.md) and on the [Releases](../../releases) page, with the issue it fixes where there is one.

## Project layout

| Path | What |
|---|---|
| `extension/lib/core.js` | Data model: normalizing, merging, status rules, money parsing, CSV, re-order checks, cost breakdown. |
| `extension/lib/parsers.js` | Reads AliExpress pages. **All CSS selectors live in `SELECTORS` at the top.** |
| `extension/lib/email.js` | Parses AliExpress transactional emails (Gmail backfill). |
| `extension/content/` | Content scripts: orders list, order detail, re-order warnings. |
| `extension/background.js` | Service worker: local store, detail-page crawling, Google Sheet sync. |
| `extension/popup/`, `extension/options/` | UI. |
| `tools/google-sheet-sync/Code.gs` | Apps Script for the Google Sheet. |
| `tools/gmail-apps-script/Code.gs`, `tools/console-export.js` | **Generated** by `npm run build` from `extension/lib/*` and `tools/src/*`. Don't edit them by hand. |
| `test/` | Unit tests (`node --test`), fixtures, and a Playwright end-to-end test. |

## Fixing a broken field
1. Get a page sample: popup → **Troubleshooting → Copy page sample** on the affected page.
2. Add or adjust a fixture in `test/fixtures/` that reproduces the problem. Use fake order numbers and **no personal data**.
3. Write a failing test in `test/parsers.test.js`, then fix `SELECTORS` or the text fallbacks in `parsers.js`.
4. Run `npm test`. If you have Playwright, also run `npm run e2e`.

### Things to know about AliExpress pages
- Pages are client-rendered. Content scripts wait for product links before parsing.
- Prices are often rendered **one digit per `<span>`**. Read text with `spacedText()`, which only adds spaces at block boundaries, never with plain `textContent` joined by spaces.
- Money is only accepted with a currency marker (`US $`, `€`, …) or "Free", so stray numbers aren't read as prices.
- The order detail page hides its price breakdown behind an arrow and a **Receipt** overlay. `content/detail.js` opens both before parsing.

## Pull requests
- Keep changes focused. Include a test for parser changes.
- Reference the issue it fixes (`Fixes #12`), and add a line to the top section of `CHANGELOG.md`. Start the line with a short **bold summary**; it's shown under *What's new* in the README.
- Run `npm run build` if you changed `extension/lib/*` or `tools/src/*`, and commit the regenerated bundles.
- Never commit real order exports, page samples with personal data, or API keys.
