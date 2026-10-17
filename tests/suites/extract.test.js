// Finding the total floor area in free text (descriptions, OCR output, brochures).
import { test, equal } from '../lib/t.js';
import { findSize, sizeFromListingText, sizeFromSizings } from '/src/extract.js';

const CASES = [
  // Floorplan totals, including common OCR misreads
  ['Approx Gross Internal Area\n67 sq m / 720 sq ft\nBedroom 1 4.40m x 3.85m', 720],
  ['Ground Floor 360 sq ft\nFirst Floor 360 sq ft\nTotal area: approx. 720 sq ft (66.9 m²)', 720],
  ['TOTAL FLOOR AREA : 1.373 sq.ft. (127.5 sq.m.) approx.', 1373],
  ['GROUND FLOOR 520 sq.ft. (48.3 sq.m.) approx. 1ST FLOOR 480 sq.ft. (44.6 sq.m.) approx. TOTAL FLOOR AREA : 1000 sq.ft. (92.9 sq.m.) approx.', 1000],
  ['Approx. Gross Internal Floor Area 1102 sq. ft / 102.4 sq. m (Including Garage)', 1102],
  ['Approx. Gross Internal Area = 20m square = ( 217ft square )', 217],
  ['Total floor area 75.0 m? (807 sq.ft.) approx', 807],
  ['Approx. Gross Internal Area 537.54ft? /49.94m?', 538],
  ['Approximate total area 70.7 m? 761 ft?', 761],
  ['Total area 85.3m² approx', 918],
  // Description wording
  ['the house extends to 1,100 square feet with a 500 square feet garden', 1100],
  ['a 2,000 sq ft garden and 900 sq ft of living space', 900],
  ['1,200 sq ft (excluding garage)', 1200],
  ['Enviable living space 1,373 sq ft (127.5 sq m) Balcony', 1373],
  ['One bedroom apartment (434sq ft) comprising of a large double bedroom', 434],
  ['Ground floor\n1 bedroom - 434sq ft - 1 bathroom', 434],
  ['A stunning 2 bedroom flat of 750 sq ft', 750],
  ['Three-bedroom house extending to 1,250 sq ft', 1250],
  ['Bedroom 1: 150 sq ft. The flat extends to approx. 650 sq ft', 650],
  ["Spacious 579 Sq' One Bedroom Flat", 579],
  ['Spacious 579 Sq’ One Bedroom Flat', 579],
  // Not a total floor area
  ['Bedroom 3.87m x 2.60m 12\'8" x 8\'6"', null],
  ['Sq Ft: 950', null],
  ['The master bedroom 180 sq ft', null],
  ['kitchen 120 sq ft', null],
];

for (const [text, want] of CASES) {
  test(`findSize: ${JSON.stringify(text).slice(0, 70)}`, () => equal(findSize(text)?.sqft ?? null, want, 'sqft'));
}

test('sizeFromSizings: agent placeholder of 1 sq ft is ignored', () =>
  equal(sizeFromSizings([{ unit: 'sqm', minimumSize: 0 }, { unit: 'sqft', minimumSize: 1, maximumSize: 1 }]), null));

test('sizeFromSizings: normal sq ft entry', () =>
  equal(sizeFromSizings([{ unit: 'sqm', minimumSize: 137, maximumSize: 137 }, { unit: 'sqft', minimumSize: 1475, maximumSize: 1475 }])?.sqft, 1475));

test('sizeFromSizings: falls back to m² when sq ft is implausible', () => {
  const size = sizeFromSizings([{ unit: 'sqft', minimumSize: 1 }, { unit: 'sqm', minimumSize: 67, maximumSize: 67 }]);
  equal([size?.sqft, size?.fromMetric], [721, true]);
});

test('sizeFromSizings: range', () =>
  equal(sizeFromSizings([{ unit: 'sqft', minimumSize: 900, maximumSize: 1200 }])?.sqftMax, 1200));

// Key features: each bullet is searched on its own, and decoded like the description.
const listingText = (description, features) => {
  const match = sizeFromListingText(description, features);
  return match && [match.size.sqft, match.source];
};

test('key features: a size bullet after "Private garden" is not taken as the garden', () =>
  equal(listingText('A lovely flat.', ['Private garden', '650 sq ft', 'Two bedrooms']), [650, 'keyFeatures']));

test('key features: found when the description has no size', () =>
  equal(listingText('<p>Bright and airy.</p>', ['Approx 1102 sq ft']), [1102, 'keyFeatures']));

test('key features: HTML entities are decoded', () =>
  equal(listingText('', ['Top floor &amp; 720 sq&nbsp;ft']), [720, 'keyFeatures']));

test("key features: \"Sq'\" shorthand", () =>
  equal(listingText('', ["Spacious 579 Sq' One Bedroom Flat"]), [579, 'keyFeatures']));

test('key features: a garden size bullet is rejected', () => equal(listingText('', ['Garden 500 sq ft']), null));

test('description wins when its wording is stronger', () =>
  equal(listingText('Total internal area of approx 950 sq ft', ['900 sq ft']), [950, 'description']));

test('description context no longer leaks into the first key feature', () =>
  equal(listingText('Includes a large garden', ['800 sq ft']), [800, 'keyFeatures']));
