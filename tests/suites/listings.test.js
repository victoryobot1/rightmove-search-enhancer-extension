// Real listings: the Size field and description of each, and what we expect from them.
import { test, equal, fixture } from '../lib/t.js';
import { findSize, htmlToText, sizeFromSizings } from '/src/extract.js';

const listings = await fixture('listings.json');

for (const l of listings) {
  const label = `${l.id}${l.note ? ` (${l.note})` : ''}`;
  test(`listing ${label}: Size field`, () => equal(sizeFromSizings(l.sizings)?.sqft ?? null, l.expected.listingSqft, 'sqft'));
  test(`listing ${label}: description`, () => {
    const text = [htmlToText(l.description), ...(l.keyFeatures || [])].join('\n');
    equal(findSize(text)?.sqft ?? null, l.expected.descriptionSqft, 'sqft');
  });
}
