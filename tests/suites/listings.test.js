// Real listings: the Size field and description of each, and what we expect from them.
import { test, equal, fixture } from '../lib/t.js';
import { sizeFromListingText, sizeFromSizings } from '/src/extract.js';

const listings = await fixture('listings.json');

for (const l of listings) {
  const label = `${l.id}${l.note ? ` (${l.note})` : ''}`;
  test(`listing ${label}: Size field`, () => equal(sizeFromSizings(l.sizings)?.sqft ?? null, l.expected.listingSqft, 'sqft'));
  test(`listing ${label}: description + key features`, () =>
    equal(sizeFromListingText(l.description, l.keyFeatures)?.size.sqft ?? null, l.expected.descriptionSqft, 'sqft'));
}
