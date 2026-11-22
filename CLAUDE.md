# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension that adds each property's total floor area (and £/sq ft) to Rightmove search results (list and map view) and property pages. The code is organised so other property sites can be added as separate tracks (see "Sites and surfaces"). It is plain JavaScript with no build step, no bundler and no Node. To run it, go to `chrome://extensions`, choose "Load unpacked" and pick the repo root. After changing code, reload the extension there.

## Commands

The tests run in headless Chrome and only need Python 3 and Google Chrome (set `CHROME=/path` to use another browser).

```sh
python3 tests/run.py                   # all fast suites (a few seconds)
python3 tests/run.py --suite extract   # one suite; repeatable
python3 tests/run.py --ocr             # also real Tesseract OCR on sample floorplans (~1 min)
```

There is no linter or formatter config. A new suite goes in `tests/suites/<name>.test.js` and must be added to `FAST_SUITES` in `tests/run.py`. The `ocr` suite downloads the floorplans listed in `tests/fixtures/floorplans.json` into `tests/.cache/` (gitignored). An appended entry is downloaded by its index.

## Architecture

There are three execution contexts, which communicate with `chrome.runtime` messages:

- **Content scripts** (classic scripts, *can't import modules*; the manifest loads them in order): `src/shared/listing.js`, then the engine `src/content/core.js`, then a site's track, `src/content/rightmove.js`. The track calls `RMSE.start(track)` with its surfaces (see below). The engine draws badges and pin labels and decides when to send `getSize` / `setPriority` / `cancelSize` / `searchSizes`. A debounced `MutationObserver` re-runs `renderAll()` because React replaces elements. It duplicates `SQFT_PER_SQM` and the settings `DEFAULTS` it uses, because it can't import them. Keep them in sync.
- **`src/background.js`** (module service worker): the cache, the queue, the source pipeline, and `searchSizes`.
  - **Listings** arrive in messages as objects (`{ site: 'rightmove', id }`). `parseListing` (src/sites/index.js) checks each one at the message boundary; inside, everything is keyed by `listingKey(listing)` (`rightmove:<id>`).
  - **Two lanes:**
    - The *fast* lane (2 slots) fetches the listing page and reads it with the site adapter's `readListing` (Rightmove: `pageModel.js`), then tries `sizings` → description/key features (`extract.js`).
    - Only listings that are still unresolved *and* have a floorplan or brochure move on to the *OCR* lane (1 slot, because there's one Tesseract worker). It tries floorplan OCR (a normal pass, then a contrast-enhanced pass), then brochures (PDF text, then OCR of the last pages), and as a last resort the room-size estimate (`estimate.js`).
  - **Lookup records:** one entry per listing in `lookups`, created synchronously by `getSize` and deleted when it settles. Change `state` only via `moveTo()`, so unexpected transitions are logged.
  - **Priorities and limits:** within each lane the order is `page` < `visible` < `nearby`. Time limits are in `TIMEOUTS`; tests override them through `globalThis.RMSE_TIMEOUTS`.
  - **Confidence:** each result's confidence is `BASE_CONFIDENCE[source]` adjusted by `findSize`'s context `score`.
  - **`searchSizes`** answers, for every listing a search page shows, the size it already states (`displaySize`) or a fresh cached one. It reads the results the page embeds, or fetches the site's search API (Rightmove's map view: one request per map move covers all ~96 pins). It's read-only: it never writes the cache or starts a lookup.
- **`src/offscreen.js`** (offscreen document): Tesseract.js OCR (PSM 11 sparse text, upscaled canvas) and pdf.js. It only accepts messages from the extension itself (not tabs), caps download sizes, and refuses brochure redirects to non-public URLs (`safeUrl.js` `safeExternalUrl`).

The pure logic is in modules that the tests import directly:
- **`extract.js`**: regex-based total-area detection (`findSize`) with context scoring. "Total/gross internal/approx" wording scores up; garden/garage/single-room/single-floor wording scores down. It also handles common OCR misreads of units (`m?`, `m*`, `ft?`, `sq'`, `sq"`, `1.373` meaning 1,373) and merges ft/m² pairs. A figure labelled with one floor (only area wording between the label and the number) comes back with `floor` set; the OCR stage treats it as part of the total, not the total.
- **`estimate.js`**: sums room dimensions from floorplan OCR text (with fixes for OCR quirks), adds a hallway/wall allowance, and caps confidence at 75%.
- **`pageModel.js`**: decodes Rightmove's flattened `window.__PAGE_MODEL` encoding.

## Sites and surfaces

Each supported site is a **track** with two halves:
- **Background adapter** (`src/sites/<site>.js`, registered in `src/sites/index.js`): `matches(url)`, `isListing(obj)`, `listingUrl(listing)`, `readListing(html)`, `searchApiUrl(pageUrl)` and `readSearch(json)`. `readListing` and `readSearch` are the boundary: they drop malformed data.
- **Content track** (`src/content/<site>.js`): its **surfaces**, the places a size can appear. Each has `find()` → targets, a lookup mode (`observed` with a lookahead in px, `page`, or `displayOnly`) and an optional `show()`. It also has `hiddenListings()` and `searchData()`. Rightmove's surfaces are listCard, propertyPage, mapCard and mapPin.

A map pin has a position but no id. Its surface returns `at: { lat, lng }`, and the engine places it using the coordinates in the search results.

**Adding a site:**
1. Add the adapter and register it in `SITES`.
2. Add the content track.
3. Add a `content_scripts` entry (shared/listing.js, content/core.js, the track) and a host permission in `manifest.json`.
4. Save trimmed real pages or responses under `tests/fixtures/`, and test the adapter against them (see `site.test.js` and `search.test.js`).

## Things to know when changing behaviour

- **State machines:** [docs/state-machines.md](docs/state-machines.md) has every lifecycle (lookup record, lanes, OCR stage, offscreen document, lookups from a page, hidden properties, cache, permission, map pins, search requests) as state × event → side effects tables. Read it before changing any of them, and update the row and its test when a transition changes.
- **Cache:** results live in `chrome.storage.local` under `size:<listing key>` (e.g. `size:rightmove:95556576`), with a TTL of 14 days when found and 1 day otherwise. Errors and cancellations aren't cached. **Bump `CACHE_VERSION` in `background.js` whenever extraction or estimation rules change**, so old results are looked up again.
- **Settings:** stored in `chrome.storage.sync`. Defaults are in `settings.js`, *and* `content/core.js` has its own `DEFAULTS` subset for the keys it uses. The popup binds any element whose `id` matches a settings key automatically.
- **Hidden properties:** Rightmove replaces a hidden card with a panel that has no listing link. Rightmove's track (`hiddenListings()`) finds these panels by `[data-testid="show-hidden-property"]`; the engine tags them `data-rmse-hidden` (CSS collapses them when `collapseHidden` is on), and cancels any queued lookup for them. The listing id is recovered from the `hide-questionnaire-<id>` elements.
- **Debugging the queue:** in the service worker console (`chrome://extensions` → "service worker"), `rmse.queue()` prints what each lane is running and waiting on, `rmse.lookups()` shows each listing's state by listing key (`checkingCache → fastQueued → fast → ocrQueued → ocr`), and `rmse.logging = false` turns logging off. Map searches are logged as `[queue] search`.
- **Fixing an extraction miss:** get the real OCR text before changing the regex. Add the floorplan to `tests/fixtures/floorplans.json`, run the `ocr` suite, then add the exact OCR text as a case in `tests/suites/extract.test.js`.
- **Markup dependencies:** Rightmove's track depends on:
  - `data-testid` attributes (`propertyCard-*`, `property-information`, `property-price`, `info-reel-SIZE-text`, `primaryPrice`)
  - on the map: `gmp-advanced-marker[position]` wrapping `[aria-label^="Price:"]`, the pin card's `[role="tooltip"]`, and a cluster's `ul[aria-label="Properties in this area"]`
  - the map search API `/api/property-search/map/search`

  If badges or pin labels stop appearing, check these first.
- **Brochure permissions:** external (non-Rightmove) brochures need the optional `https://*/*` host permission, which the popup requests.
