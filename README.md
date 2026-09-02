# ClaimStation

TypeScript CLI for discovering free PlayStation Store items and redeeming them through the live Store with strict zero-dollar safeguards.

The default source is PSDeals' all-free listing. The PlayStation Store page for each item is still treated as the final source of truth before any add-to-cart, add-to-library, or checkout action.

## Default Usage

Install dependencies:

```sh
npm install
```

Run the full bot:

```sh
npm run cli -- redeem --source psdeals --all
```

Equivalent package shortcut:

```sh
npm run redeem:psdeals
```

This discovers the PSDeals free list, resolves each item to a PlayStation Store product URL, skips products already handled in the local cache, redeems only products that the live PlayStation Store confirms are free, checks out every full 10-item cart batch, and checks out a final under-10 cart at the end.

## Setup

Create a local `.env` file for secrets and browser state. The file is ignored by git.

```env
PLAYSTATION_EMAIL=
PLAYSTATION_PASSWORD=
PSDEALS_COOKIE=
PSDEALS_USER_AGENT=
PSDEALS_HUMAN_CHECK_TIMEOUT_MS=300000
PS_REDEEM_CHROME_PATH=
PS_REDEEM_USER_DATA_DIR=.ps-free-redeem/chrome-profile
PS_REDEEM_CACHE=.ps-free-redeem/cache.json
PS_REDEEM_AUDIT_LOG=.ps-free-redeem/audit.jsonl
PS_REDEEM_BLOCK_HEAVY_RESOURCES=true
PSDEALS_DISCOVERY_CACHE=.ps-free-redeem/psdeals-discovery-cache.json
PLATPRICES_API_KEY=
```

Sign in to PlayStation once before redeeming:

```sh
npm run auth:native
npm run cli -- login-check
```

If PSDeals blocks automation, refresh the local PSDeals browser/cookie state:

```sh
npm run psdeals:unlock
```

Headed Chrome is recommended for PSDeals discovery because Cloudflare may block headless sessions. If PSDeals presents a human check in a headed run, ClaimStation waits for it to be solved in the opened Chrome window before continuing. If PSDeals says verification is temporarily unavailable, run `npm run psdeals:unlock`, solve PSDeals in that plain Chrome window, close it, then retry the redeem command. Adjust `PSDEALS_HUMAN_CHECK_TIMEOUT_MS` if you need more or less than the default five minutes.

## What It Does

- Discovers free games, bundles, and DLC from PSDeals by default.
- Optionally expands discovery to PlayStation Plus Extra and Premium catalog pages.
- Optionally scans PlayStation official discovery pages and legacy PlatPrices sources.
- Resolves PSDeals detail pages once and stores those results in a local discovery cache.
- Opens the PlayStation Store product page for every candidate before acting.
- Clicks `Add to Library` only when the primary product CTA is safe and free.
- Clicks `Add to Cart` only when the primary product CTA is safe and free.
- Confirms the cart only when every visible cart line and the cart total are free.
- Uses a hard 10-item cart batch size because the PlayStation cart caps at 10 items.
- Skips successful products on later runs.
- Skips known paid products forever.
- Skips known trials unless explicitly told to revisit them.
- Writes an audit trail for discovery, verification, action, checkout, and failures.
- Avoids download actions entirely.
- Blocks nonessential browser resources such as images, media, fonts, and common trackers by default to reduce page rendering overhead.

## State And Logs

Runtime state lives under `.ps-free-redeem/` by default.

| Path | Purpose |
| --- | --- |
| `.ps-free-redeem/cache.json` | Product redemption cache. Stores successful, owned, failed, trial, not-free, and other product outcomes. |
| `.ps-free-redeem/audit.jsonl` | Append-only audit log. Each line records a product, action, status, CTA state, and timestamp. |
| `.ps-free-redeem/psdeals-discovery-cache.json` | PSDeals detail-resolution cache. Prevents reopening PSDeals detail pages that were already resolved or excluded. |
| `.ps-free-redeem/chrome-profile/` | Standalone Chrome profile used by the automation. |
| `.ps-free-redeem/chrome-login-netlog.json` | Optional Chrome netlog from `native-auth`. |

Print the audit log:

```sh
npm run cli -- report
```

Print the product cache:

```sh
npm run cli -- cache
```

## Commands

| Command | Description |
| --- | --- |
| `npm run cli -- redeem --source psdeals --all` | Default full run. Discover from PSDeals and redeem every safe, uncached, free item. |
| `npm run redeem:psdeals` | Shortcut for the default full run. |
| `npm run cli -- discover --source psdeals --all` | Discover and resolve candidates without redeeming them. |
| `npm run cli -- inspect "<store-url>"` | Inspect one PlayStation Store product URL and print its parsed CTA state. |
| `npm run auth:native` | Open regular Chrome for PlayStation login. Best first-time sign-in path. |
| `npm run cli -- auth` | Open the automation Chrome profile and optionally use `.env` credentials. Diagnostic fallback. |
| `npm run cli -- login-check` | Check whether the automation profile is signed in to PlayStation. |
| `npm run psdeals:unlock` | Open PSDeals in Chrome to refresh local cookies/session state. |
| `npm run cli -- cart-clean` | Inspect the cart and remove paid or unsafe items. |
| `npm run cli -- cart-checkout` | Confirm an existing zero-dollar cart. Stops if anything is not free. |
| `npm run cli -- scan` | Legacy PlatPrices/manual URL scanning command. |
| `npm run cli -- cache` | Print cached product outcomes. |
| `npm run cli -- report` | Print the JSONL audit log. |
| `npm run check` | Build and run tests. |

## Redeem Flags

`redeem` is the main command:

```sh
npm run cli -- redeem [flags]
```

| Flag | Values | Description |
| --- | --- | --- |
| `--source <source>` | `psdeals`, `all`, `playstation`, `platprices-api`, `platprices-page`, `api`, `page`, `auto` | Candidate source. Default is `psdeals`. `api`, `page`, and `auto` are legacy PlatPrices aliases. |
| `--all` | Boolean | Process every discovered candidate. Use this for the normal full run. |
| `--limit <number>` | Number | Maximum candidates to process when `--all` is not set. Default is `10`. |
| `--pages <number>` | Number | Maximum source pages to scan. Omit with `--all` for full pagination where supported. |
| `--kind <kind>` | `all`, `free`, `ps-plus`, `ps-plus-catalog`, `ps-plus-whats-new`, `ps-plus-exclusive-packs` | PlayStation-direct discovery category. Default is `all`. Mostly relevant with `--source playstation` or `--source all`. |
| `--url <url>` | URL | Legacy PlatPrices page URL. |
| `--psdeals-url <url>` | URL | PSDeals listing URL. Defaults to the all-free games/bundles/DLC URL. |
| `--psdeals-collections` | Boolean | Also scan the curated PSDeals collection pages for PS Plus and Free To Play lists. The default run uses the broad all-free listing only. |
| `--extra` | Boolean | Also scan the PSDeals PlayStation Plus Game Catalog collection. Store verification still decides whether each item is redeemable. |
| `--premium` | Boolean | Also scan the Extra catalog and the PSDeals PlayStation Plus Classics Catalog collection. Store verification still decides whether each item is redeemable. |
| `--refresh-psdeals-cache` | Boolean | Reopen PSDeals detail pages even if their resolved Store URLs are already cached. |
| `--discover-url <url...>` | One or more URLs | Extra PlayStation official discovery pages to scan. |
| `--file <path>` | File path | Read Store URLs from a text file instead of discovery. |
| `--debug` | Boolean | Save extra diagnostics and emit more verbose details. |
| `--confirm-cart` | Boolean | Confirm zero-dollar carts. Enabled by default. |
| `--no-confirm-cart` | Boolean | Add safe free items to cart but do not check out. |
| `--force` | Boolean | Revisit cached products except known paid/not-free items and trials. |
| `--retry-errors` | Boolean | Revisit products cached as errors. |
| `--retry-trials` | Boolean | Revisit products cached as trials. |
| `--headless` | Boolean | Run without a visible browser. Not recommended for PSDeals discovery. |

## Discover Flags

`discover` resolves candidates but does not redeem:

```sh
npm run cli -- discover [flags]
```

| Flag | Values | Description |
| --- | --- | --- |
| `--source <source>` | `psdeals`, `all`, `playstation` | Discovery source. Default is `psdeals`. |
| `--kind <kind>` | `all`, `free`, `ps-plus`, `ps-plus-catalog`, `ps-plus-whats-new`, `ps-plus-exclusive-packs` | PlayStation-direct discovery category. |
| `--all` | Boolean | Resolve every discovered candidate. |
| `--limit <number>` | Number | Maximum candidates to resolve when `--all` is not set. Default is `50`. |
| `--pages <number>` | Number | Maximum source pages to scan. Omit with `--all` for full pagination where supported. |
| `--url <url...>` | One or more URLs | Custom PlayStation official discovery pages. |
| `--psdeals-url <url>` | URL | PSDeals listing URL. Defaults to the all-free games/bundles/DLC URL. |
| `--psdeals-collections` | Boolean | Also scan curated PSDeals PS Plus and Free To Play collection pages. |
| `--extra` | Boolean | Also scan the PSDeals PlayStation Plus Game Catalog collection. |
| `--premium` | Boolean | Also scan Extra plus the PSDeals PlayStation Plus Classics Catalog collection. |
| `--refresh-psdeals-cache` | Boolean | Refresh PSDeals detail-resolution cache entries. |
| `--debug` | Boolean | Emit/save additional diagnostics. |
| `--headless` | Boolean | Run without a visible browser. Not recommended for PSDeals discovery. |

## Other Command Flags

### `auth`

```sh
npm run cli -- auth [flags]
```

| Flag | Values | Description |
| --- | --- | --- |
| `--timeout-minutes <number>` | Number | Minutes to wait for sign-in before timing out. Default is `10`. |
| `--use-env-password` | Boolean | Use `.env` credentials when available. Enabled by default. |
| `--no-use-env-password` | Boolean | Do not fill credentials from `.env`. |

### `native-auth`

```sh
npm run cli -- native-auth [flags]
```

| Flag | Values | Description |
| --- | --- | --- |
| `--url <url>` | URL | Initial Chrome URL. Defaults to the PlayStation latest page. |
| `--netlog <path>` | File path | Path for Chrome netlog output. Default is `.ps-free-redeem/chrome-login-netlog.json`. |
| `--no-netlog` | Boolean | Launch without Chrome netlog capture. |

### `psdeals-unlock`

```sh
npm run cli -- psdeals-unlock [flags]
```

| Flag | Values | Description |
| --- | --- | --- |
| `--url <url>` | URL | PSDeals URL to open. Defaults to the all-free listing. |

### `login-check`

```sh
npm run cli -- login-check [flags]
```

| Flag | Values | Description |
| --- | --- | --- |
| `--headless` | Boolean | Check sign-in without a visible browser. |

### `inspect`

```sh
npm run cli -- inspect "<store-url>" [flags]
```

| Flag | Values | Description |
| --- | --- | --- |
| `--headless` | Boolean | Inspect without a visible browser. |

### `scan`

```sh
npm run cli -- scan [flags]
```

| Flag | Values | Description |
| --- | --- | --- |
| `--limit <number>` | Number | Maximum items to scan. Default is `25`. |
| `--page <number>` | Number | Starting PlatPrices page. Default is `1`. |
| `--pages <number>` | Number | Number of PlatPrices pages to scan. Default is `1`. |
| `--source <source>` | `api`, `page`, `auto` | Legacy PlatPrices source. Default is `auto`. |
| `--url <url>` | URL | PlatPrices search URL. |
| `--file <path>` | File path | Read Store URLs from a text file. |
| `--debug` | Boolean | Emit/save additional diagnostics. |
| `--headless` | Boolean | Scan without a visible browser. |

### `cart-clean`

```sh
npm run cli -- cart-clean [flags]
```

| Flag | Values | Description |
| --- | --- | --- |
| `--headless` | Boolean | Clean the cart without a visible browser. |

### `cart-checkout`

```sh
npm run cli -- cart-checkout [flags]
```

| Flag | Values | Description |
| --- | --- | --- |
| `--headless` | Boolean | Confirm a zero-dollar cart without a visible browser. |

## Supported Flag Combinations

These are the intended combinations to reach for first.

### Full PSDeals Run

```sh
npm run cli -- redeem --source psdeals --all
```

Use this as the default. It scans the broad PSDeals free listing and redeems every uncached item that the PlayStation Store confirms is free.

### PSDeals With Collection Pages

```sh
npm run cli -- redeem --source psdeals --all --psdeals-collections
```

Adds PSDeals collection pages for PS Plus and Free To Play lists. The broad all-free listing remains the primary source.

### PSDeals Plus Extra Catalog

```sh
npm run cli -- redeem --source psdeals --all --extra
```

Adds the PSDeals PlayStation Plus Game Catalog collection to the normal all-free listing. PSDeals catalog prices may not look free, so each product is checked on the live PlayStation Store before redemption.

### PSDeals Plus Premium Catalog

```sh
npm run cli -- redeem --source psdeals --all --premium
```

Adds the normal all-free listing, the Extra Game Catalog, and the Premium Classics Catalog. Premium implies Extra.

### Refresh PSDeals Detail Resolution

```sh
npm run cli -- redeem --source psdeals --all --refresh-psdeals-cache
```

Use this when PSDeals links changed, stale detail pages were cached, or a prior discovery pass was interrupted.

### Limited Smoke Test

```sh
npm run cli -- redeem --source psdeals --limit 10 --pages 1
```

Processes a small batch from the first PSDeals page.

### Discovery Only

```sh
npm run cli -- discover --source psdeals --all
```

Resolves candidates and warms the PSDeals cache without touching the PlayStation cart or library.

### Discovery Only With Cache Refresh

```sh
npm run cli -- discover --source psdeals --all --refresh-psdeals-cache
```

Rebuilds PSDeals detail-resolution data without redeeming.

### Retry Prior Errors

```sh
npm run cli -- redeem --source psdeals --all --retry-errors
```

Retries items cached as errors while still skipping successful, owned, paid, and trial outcomes.

### Retry Trials

```sh
npm run cli -- redeem --source psdeals --all --retry-trials
```

Rechecks items previously classified as trials. Use only when the Store presentation may have changed.

### Force Revisit

```sh
npm run cli -- redeem --source psdeals --all --force
```

Revisits cached items except known paid/not-free products and trials. Add `--retry-trials` if trial records should also be revisited.

### Add Without Checkout

```sh
npm run cli -- redeem --source psdeals --all --no-confirm-cart
```

Adds verified-free cart items but leaves checkout for a later manual or `cart-checkout` pass.

### Confirm Existing Free Cart

```sh
npm run cli -- cart-checkout
```

Use when the cart already contains free items and the main run exited before checkout. It refuses to confirm non-free carts.

### Clean Cart

```sh
npm run cli -- cart-clean
```

Removes paid or unsafe cart contents before continuing.

### PlayStation-Direct Discovery

```sh
npm run cli -- redeem --source playstation --kind all --all
npm run cli -- redeem --source playstation --kind free --all
npm run cli -- redeem --source playstation --kind ps-plus --all
npm run cli -- redeem --source playstation --kind ps-plus-catalog --all
npm run cli -- redeem --source playstation --kind ps-plus-whats-new --all
npm run cli -- redeem --source playstation --kind ps-plus-exclusive-packs --all
```

Use this when you want to probe PlayStation's official pages directly. PSDeals is usually better for broad discovery.

### PSDeals Plus PlayStation Discovery

```sh
npm run cli -- redeem --source all --kind all --all
```

Combines PSDeals and PlayStation-direct discovery, then applies the same Store verification and redemption guards.

### Custom PSDeals URL

```sh
npm run cli -- redeem --source psdeals --all --psdeals-url "https://psdeals.net/us-store/all-games?sort=recently-added&contentType%5B%5D=games&contentType%5B%5D=bundles&contentType%5B%5D=dlc&maxPrice=0"
```

Use this to pin a different PSDeals search URL while keeping the same Store-side safety checks.

### Custom PlayStation Discovery URLs

```sh
npm run cli -- redeem --source playstation --all --discover-url "https://store.playstation.com/en-us/category/free-to-play"
```

Accepts one or more PlayStation discovery URLs.

### Manual URL File

```sh
npm run cli -- redeem --file fixtures/manual-smoke.txt --all
```

Uses Store URLs from a text file. This bypasses discovery but still verifies every product page before acting.

### Legacy PlatPrices

```sh
npm run cli -- scan --source auto --limit 25
npm run cli -- redeem --source platprices-api --limit 25
npm run cli -- redeem --source platprices-page --limit 25
```

Kept for future use, but no longer the default path.

## Safety Rules

- Never redeem unless the live PlayStation Store product page confirms the primary CTA is free.
- Never keep paid content in the cart.
- Never confirm checkout unless the cart total is zero and every inspected line is free.
- Never click download actions.
- Never click secondary edition, add-on, or related-item buttons from a product page.
- Never retry known paid/not-free products.
- Never retry known trials unless `--retry-trials` is set.
- Treat `Subscribe`, `Subscribe and Buy`, `Upgrade`, and similar CTAs as not redeemable.
- Treat `Owned`, `Purchased`, and `Download from Library` as already handled.
- Batch cart checkout at 10 items, and run a final checkout for fewer than 10 pending free items after discovery ends.

## Notes

- The default PSDeals URL is:

```text
https://psdeals.net/us-store/all-games?sort=recently-added&contentType%5B%5D=games&contentType%5B%5D=bundles&contentType%5B%5D=dlc&maxPrice=0
```

- PSDeals is used only for discovery. PlayStation Store verification decides whether an item is actually redeemable.
- PS Plus items are redeemable only when the signed-in account sees an actionable zero-dollar `Add to Cart` or `Add to Library` state.
- `--extra` and `--premium` intentionally include PSDeals catalog pages whose listing prices may not be zero. The Store product page remains the safety gate.
- PlatPrices code remains in the project as an unused-by-default fallback.
- Set `PS_REDEEM_BLOCK_HEAVY_RESOURCES=false` if a PlayStation or PSDeals page behaves incorrectly with lean browser loading enabled.

## Disclaimer

This script is intended for educational purposes and lawful testing only. Misuse of this script in violation of any applicable laws or terms of service is strictly prohibited. Use at your own risk.

## License

This source code is licensed under the BSD-style license found in the [LICENSE](./LICENSE) file in the root directory of this source tree.

## Author

Nic D. [@awxk](https://github.com/awxk)
