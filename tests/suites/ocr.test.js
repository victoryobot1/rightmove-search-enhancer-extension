// Real Tesseract OCR on sample floorplans, through the extension's own offscreen.js.
// Opt-in (python3 tests/run.py --ocr): slow, and needs the floorplans downloaded into
// tests/.cache by run.py.
import { test, equal, assert, fixture } from '../lib/t.js';
import { findSize } from '/src/extract.js';

const MIN_FOUND = 24; // of 27 sample floorplans at the time of writing

// offscreen.js expects the extension APIs and a global Tesseract.
let listener;
globalThis.chrome = {
  runtime: { getURL: (p) => `${location.origin}/${p}`, onMessage: { addListener(fn) { listener = fn; } } },
};
await new Promise((resolve, reject) => {
  const s = Object.assign(document.createElement('script'), { src: '/vendor/tesseract/tesseract.min.js', onload: resolve, onerror: reject });
  document.head.appendChild(s);
});
await import('/src/offscreen.js');

const call = (op, args) => new Promise((resolve) => listener({ target: 'offscreen', op, ...args }, {}, resolve));
const floorplans = await fixture('floorplans.json');

// Same two passes as background.js: normal, then contrast-boosted if nothing was found.
async function sizeFromFloorplan(url) {
  for (const enhanced of [false, true]) {
    const reply = await call('ocrImage', { url, enhanced });
    if (reply.error) throw new Error(reply.error);
    const size = findSize(reply.result);
    if (size) return size.sqft;
  }
  return null;
}

let found = 0;
for (const [i, fp] of floorplans.entries()) {
  test(`floorplan ${fp.id} → ${fp.expectedSqft ?? 'no total'}`, async () => {
    const started = performance.now();
    const sqft = await sizeFromFloorplan(`/tests/.cache/floorplans/${i}.img`);
    if (sqft) found++;
    if (fp.expectedSqft) equal(sqft, fp.expectedSqft, 'sqft');
    return `${Math.round(performance.now() - started)}ms`;
  });
}

test(`at least ${MIN_FOUND} of ${floorplans.length} floorplans give a total`, () => {
  assert(found >= MIN_FOUND, `only ${found}`);
  return `${found}/${floorplans.length}`;
});
