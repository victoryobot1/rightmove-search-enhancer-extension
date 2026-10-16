// Estimating total area from floorplan room dimensions (when no total is stated), checked
// against floorplans whose real total is known. The OCR text is a fixture, so this suite
// tests the estimator, not Tesseract.
import { test, equal, assert, fixture } from '../lib/t.js';
import { estimateFromRooms, readRooms } from '/src/estimate.js';

const { plans } = await fixture('floorplan-ocr.json');

// Calibration thresholds: loose enough for small tweaks, tight enough to catch regressions.
const MAX_MEDIAN_ERROR = 0.15;
const MAX_MEAN_BIAS = 0.08;
const MAX_ESTIMATE_CONFIDENCE = 75;

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('calibration: median error and bias across sample floorplans', () => {
  const errors = [];
  for (const p of plans) {
    const e = estimateFromRooms(p.ocrTexts, { bedrooms: p.bedrooms });
    if (e && p.truthSqft) errors.push(e.sqft / p.truthSqft - 1);
  }
  assert(errors.length >= 15, `only ${errors.length} plans produced an estimate`);
  const medianAbs = median(errors.map(Math.abs));
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  assert(medianAbs <= MAX_MEDIAN_ERROR, `median error ${(medianAbs * 100).toFixed(1)}% > ${MAX_MEDIAN_ERROR * 100}%`);
  assert(Math.abs(mean) <= MAX_MEAN_BIAS, `mean bias ${(mean * 100).toFixed(1)}% beyond ±${MAX_MEAN_BIAS * 100}%`);
  return `${errors.length} plans, median error ${(medianAbs * 100).toFixed(0)}%, mean bias ${(mean * 100).toFixed(1)}%`;
});

test('estimates never claim more than 75% confidence', () => {
  for (const p of plans) {
    const e = estimateFromRooms(p.ocrTexts, { bedrooms: p.bedrooms });
    if (e) assert(e.confidence <= MAX_ESTIMATE_CONFIDENCE, `${p.id}: ${e.confidence}%`);
  }
});

test('94142151: estimate, labels and working', () => {
  const p = plans.find((x) => x.id === '94142151');
  const e = estimateFromRooms(p.ocrTexts, { bedrooms: p.bedrooms });
  equal([e.sqft, e.confidence], [715, 75], '[sqft, confidence]');
  const working = e.working.join('\n');
  for (const line of ['Bedroom 2: 3.87 × 2.60 m = 10.1 m²', 'Lounge Diner: 3.68 × 5.71 m', '× 1.12 for hallways', 'both bedrooms measured']) {
    assert(working.includes(line), `working is missing "${line}"`);
  }
  return `real total 720 sq ft`;
});

test('dropped decimal points: "534x413" reads as 5.34 × 4.13 m', () => {
  const { rooms } = readRooms('Kitchen\n534x413\nBedroom\n381x335');
  equal(rooms.map((r) => r.dims.map((d) => d.toFixed(2))), [['5.34', '4.13'], ['3.81', '3.35']]);
});

test('imperial twins without quote marks are not counted twice', () => {
  const { rooms, twins } = readRooms('Kitchen / Dining Room\n534x413\n176x137');
  equal([rooms.length, twins], [1, 1], '[rooms, twins]');
});

test('labels split across lines are merged, not imputed as extra rooms', () => {
  const e = estimateFromRooms(['Kitchen /\nDining Room\n5.34 x 4.13 m\nBedroom\n3.81 x 3.35 m'], { bedrooms: 1 });
  assert(!e.working.some((w) => w.includes('assumed')), e.working.join(' | '));
});

test('outdoor spaces are excluded', () => {
  const e = estimateFromRooms(['Garden\n14.50 x 2.81 m\nBedroom\n3.81 x 3.35 m\nLiving Room\n4.34 x 3.81 m'], { bedrooms: 1 });
  assert(e.working.some((w) => w.includes('excluded (outdoor)')), 'garden not excluded');
  equal(e.sqft, Math.round((3.81 * 3.35 + 4.34 * 3.81) * 1.12 * 10.7639));
});

test('needs at least two measured rooms', () => equal(estimateFromRooms(['Bedroom\n3.81 x 3.35 m'], {}), null));
