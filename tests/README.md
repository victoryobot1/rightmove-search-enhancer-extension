# Tests

The tests run in headless Chrome and need only Python 3 and Google Chrome. There's no Node and no build step. The suites are ES modules that import the real files in `src/`.

```sh
python3 tests/run.py                 # fast suites, a few seconds
python3 tests/run.py --ocr           # also run real OCR on 27 sample floorplans (~45 s)
python3 tests/run.py --suite queue   # a single suite (repeatable)
```

The exit code is non-zero if anything fails. Set `CHROME=/path/to/chrome` to use a different browser.

| Suite | What it checks |
| --- | --- |
| `extract` | Finding the total floor area in text: description wording, floorplan totals, OCR misreads, single-room figures that must be rejected, and the Size field (including the "1 sq ft" placeholder) |
| `listings` | 28 real listings: what the Size field and description each give |
| `pageModel` | Decoding Rightmove's `window.__PAGE_MODEL`, both the flattened encoding (on real pages) and plain JSON |
| `estimate` | The room-size estimator against 19 floorplans with known totals. It must keep the median error ≤15% and the bias within ±8%. Also covers the tooltip working and OCR quirks (dropped decimals, imperial duplicates, split labels, outdoor space) |
| `site` | Which site a URL belongs to (toolbar icon, popup message); listing keys; Rightmove's adapter reading real saved property pages and checking listings; which brochure links are safe to fetch (public https only; no local network, IPs, odd ports or credentials) |
| `offscreen` | Safety checks in the real `src/offscreen.js`: it ignores work from tabs and other extensions, enforces download size caps (with and without a stated size), and refuses brochures that redirect to the local network |
| `content` | The real content scripts (engine + Rightmove track) on a fake page: badges, sizes the page already states (no lookup), the on/off switch (no lookups or badges while off, lookups restart when turned back on), re-asking after another tab cancelled a lookup, hidden properties, retry clicks, and the map view (pin labels, one search per URL, cards looked up when opened and demoted when closed, big clusters, shared positions) |
| `queue` | The real `background.js` lookup queue, with Chrome's APIs, Rightmove and OCR simulated: fast lane vs OCR lane, priority order, promoting on scroll, cancelling, time limits on stuck jobs, slot limits, malformed listings ignored, old cache keys removed |
| `search` | The real `background.js` answering `searchSizes`: sizes a search page states (list and map shapes, from saved real responses), cached sizes winning while fresh, the map search API fetched once per page, nothing cached and no property page fetched |
| `ocr` (opt-in) | Real Tesseract OCR through `src/offscreen.js` on sample floorplans. These are downloaded on first run into `tests/.cache/`, not committed |

## How it works

`run.py` serves the repo on a local port and opens `runner.html` in headless Chrome. The runner loads each suite in its own iframe (`suite.html`), so suites that stub `fetch` or `chrome` can't affect each other, and posts the results back to `run.py`, which prints them.

To add a test, put a `*.test.js` file in `suites/` using `test()` / `equal()` / `assert()` from `lib/t.js`. A test passes unless it throws, and returning a string adds a note to the output. Add the suite's name to `FAST_SUITES` in `run.py`.

## Fixtures

`fixtures/` holds only what the tests need, taken from real listings in October 2026:

- `listings.json`: each listing's Size field, description, key features and expected results
- `page-models/`: two raw page models, for testing the decoder on Rightmove's real encoding
- `floorplan-ocr.json`: Tesseract's text output for sample floorplans, with their real totals
- `floorplans.json`: floorplan image URLs and expected sizes for the `ocr` suite
- `map-search.json`, `list-search.json` (November 2026): trimmed real search results, from the map search API and a list page's embedded `__NEXT_DATA__`, 3 listings with a stated size and 3 without in each

If Rightmove removes those floorplan images, the `ocr` suite will fail to download them. The other suites don't need the network.
