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
| `site` | Which URLs count as rightmove.co.uk (toolbar icon, popup message), and which brochure links are safe to fetch (public https only; no local network, IPs, odd ports or credentials) |
| `offscreen` | Safety checks in the real `src/offscreen.js`: it ignores work from tabs and other extensions, enforces download size caps (with and without a stated size), and refuses brochures that redirect to the local network |
| `queue` | The real `background.js` lookup queue, with Chrome's APIs, Rightmove and OCR simulated: fast lane vs OCR lane, priority order, promoting on scroll, cancelling, time limits on stuck jobs, slot limits |
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

If Rightmove removes those floorplan images, the `ocr` suite will fail to download them. The other suites don't need the network.
