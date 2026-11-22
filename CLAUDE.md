# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension that adds each property's total floor area (and £/sq ft) to Rightmove search results and property pages. It is plain JavaScript with no build step, no bundler and no Node. To run it, go to `chrome://extensions`, choose "Load unpacked" and pick the repo root. After changing code, reload the extension there.

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

- **`src/content.js`** (content script, classic script, *can't import modules*): finds cards via `data-testid="propertyCard-*"`, renders badges and fills the SIZE slot on `/properties/<id>` pages. It sends `getSize` / `setPriority` / `cancelSize` to the background. A debounced `MutationObserver` re-runs `renderAll()` because React replaces cards. Two `IntersectionObserver`s pick which cards to look up: within 1200px of the viewport gets `nearby` priority, on screen gets `visible`. It duplicates a few constants from `extract.js` (e.g. `MIN_SQFT`, `SQFT_PER_SQM`) because it can't import them. Keep them in sync.
- **`src/background.js`** (module service worker): the cache, the queue and the source pipeline.
  - **Two lanes:**
    - The *fast* lane (2 slots) fetches the property page, decodes it with `pageModel.js`, then tries `sizings` → description/key features (`extract.js`).
    - Only listings that are still unresolved *and* have a floorplan or brochure move on to the *OCR* lane (1 slot, because there's one Tesseract worker). It tries floorplan OCR (a normal pass, then a contrast-enhanced pass), then brochures (PDF text, then OCR of the last pages), and as a last resort the room-size estimate (`estimate.js`).
  - **Lookup records:** one entry per listing in `lookups`, created synchronously by `getSize` and deleted when it settles. Change `state` only via `moveTo()`, so unexpected transitions are logged.
  - **Priorities and limits:** within each lane the order is `page` < `visible` < `nearby`. Time limits are in `TIMEOUTS`; tests override them through `globalThis.RMSE_TIMEOUTS`.
  - **Confidence:** each result's confidence is `BASE_CONFIDENCE[source]` adjusted by `findSize`'s context `score`.
- **`src/offscreen.js`** (offscreen document): Tesseract.js OCR (PSM 11 sparse text, upscaled canvas) and pdf.js. It only accepts messages from the extension itself (not tabs), caps download sizes, and refuses brochure redirects to non-public URLs (`site.js` `safeExternalUrl`).

The pure logic is in modules that the tests import directly:
- **`extract.js`**: regex-based total-area detection (`findSize`) with context scoring. "Total/gross internal/approx" wording scores up; garden/garage/single-room/single-floor wording scores down. It also handles common OCR misreads of units (`m?`, `m*`, `ft?`, `sq'`, `sq"`, `1.373` meaning 1,373) and merges ft/m² pairs.
- **`estimate.js`**: sums room dimensions from floorplan OCR text (with fixes for OCR quirks), adds a hallway/wall allowance, and caps confidence at 75%.
- **`pageModel.js`**: decodes Rightmove's flattened `window.__PAGE_MODEL` encoding.

## Things to know when changing behaviour

- **State machines:** [docs/state-machines.md](docs/state-machines.md) has every lifecycle (lookup record, lanes, OCR stage, offscreen document, badges, hidden properties, cache, permission) as state × event → side effects tables. Read it before changing any of them, and update the row and its test when a transition changes.
- **Cache:** results live in `chrome.storage.local` under `size:<id>`, with a TTL of 14 days when found and 1 day otherwise. Errors and cancellations aren't cached. **Bump `CACHE_VERSION` in `background.js` whenever extraction or estimation rules change**, so old results are looked up again.
- **Settings:** stored in `chrome.storage.sync`. Defaults are in `settings.js`, *and* `content.js` has its own `DEFAULTS` subset for the keys it uses. The popup binds any element whose `id` matches a settings key automatically.
- **Hidden properties:** Rightmove replaces a hidden card with a panel that has no listing link. `content.js` finds these panels by `[data-testid="show-hidden-property"]`, tags them `data-rmse-hidden` (CSS collapses them when `collapseHidden` is on), and cancels any queued lookup for them. The listing id is recovered from the `hide-questionnaire-<id>` elements.
- **Debugging the queue:** in the service worker console (`chrome://extensions` → "service worker"), `rmse.queue()` prints what each lane is running and waiting on, `rmse.lookups()` shows each listing's state (`checkingCache → fastQueued → fast → ocrQueued → ocr`), and `rmse.logging = false` turns logging off.
- **Fixing an extraction miss:** get the real OCR text before changing the regex. Add the floorplan to `tests/fixtures/floorplans.json`, run the `ocr` suite, then add the exact OCR text as a case in `tests/suites/extract.test.js`.
- **Markup dependencies:** the code depends on Rightmove's `data-testid` attributes (`propertyCard-*`, `property-information`, `property-price`, `info-reel-SIZE-text`, `primaryPrice`). If badges stop appearing, check these first.
- **Brochure permissions:** external (non-Rightmove) brochures need the optional `https://*/*` host permission, which the popup requests.
