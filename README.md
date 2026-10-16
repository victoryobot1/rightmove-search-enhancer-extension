# Rightmove Square Footage

A Chrome extension (Manifest V3, plain JavaScript, no build step) that shows each property's total floor area — and £ per sq ft — directly on Rightmove search results.

![badge](icons/icon48.png)

## Install (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open any Rightmove search, e.g. `https://www.rightmove.co.uk/property-for-sale/find.html?...`

The toolbar icon is only coloured on rightmove.co.uk. On any other site it's greyed out, and clicking it explains that the extension only works on Rightmove.

Each card gets a badge next to the beds/baths icons:

| Badge | Meaning |
| --- | --- |
| `1,102 sq ft · £499/sq ft` (green) | Agent filled in Rightmove's Size field |
| `≈ 720 sq ft` (amber) | Found in the description, floorplan or brochure — hover to see the source and the exact text it was read from |
| `Size n/a` / `Size ?` (grey) | Nothing found / lookup failed — click to retry |

## How it finds the size

For every card that scrolls near the viewport, the background worker fetches the property page and reads Rightmove's embedded `window.__PAGE_MODEL`, then tries each source in order, stopping at the first hit:

1. **Size section** — `propertyData.sizings` (also pre-filled from the search page's own JSON when available, so no fetch is needed).
2. **Description + key features** — regex for `sq ft`, `square feet`, `m²`, `sqm`, … with context scoring that prefers "total / gross internal / approx" and ignores garden, plot, garage and single-room figures.
3. **Floorplan images** — on-device OCR with Tesseract.js (sparse-text mode, upscaled; a contrast-boosted second pass for faint text).
4. **Brochures** — PDFs are text-extracted with pdf.js; if that fails, the last few pages are rendered and OCR'd. Agent web-page brochures are read as text.

Brochures hosted on `rightmove.co.uk` are read by default. Brochures on agents' own sites (Reapit, Vebra, Foxtons, …) need the **"Also read brochures on agents' websites"** option in the popup, which asks Chrome for the extra permission.

Results are cached in `chrome.storage.local` for 14 days (1 day for "not found", since agents often add floorplans later). At most two property pages are fetched at a time.

## Files

```
manifest.json
src/
  content.js / content.css   card detection, badges, lazy loading (IntersectionObserver)
  background.js              fetch queue, cache, source pipeline
  pageModel.js               decodes Rightmove's (flattened) __PAGE_MODEL
  extract.js                 finds the total floor area in free text
  offscreen.html / .js       Tesseract OCR + pdf.js (needs a DOM and Web Workers)
  popup.html / .js           settings
  settings.js                defaults
vendor/                      tesseract.js 5.1.1 (+ core, eng data), pdfjs-dist 4.10.38
```

## Notes and limitations

- OCR is approximate. On a sample of 26 London floorplans it found an area on 25. The badge is marked `≈` and the tooltip shows the text it read, so you can sanity-check it.
- A floorplan's "gross internal area" can differ from the agent's figure: it may include a garage or loft, or leave out low-ceiling areas.
- Rightmove changes its markup from time to time. Card detection relies on `data-testid="propertyCard-*"` and `data-testid="property-information"`. If badges stop appearing, check those first.
