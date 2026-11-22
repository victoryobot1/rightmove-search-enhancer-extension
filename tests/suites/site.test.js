// Which site a URL belongs to (toolbar icon colour, popup message), and which brochure
// links are safe to fetch.
import { test, equal, fixture } from '../lib/t.js';
import { siteForUrl } from '/src/sites/index.js';
import rightmove from '/src/sites/rightmove.js';
import { safeExternalUrl } from '/src/safeUrl.js';
import '/src/shared/listing.js';

const CASES = [
  ['https://www.rightmove.co.uk/property-for-sale/find.html', true],
  ['https://rightmove.co.uk/', true],
  ['https://media.rightmove.co.uk/x.jpg', true],
  ['https://hub.rightmove.co.uk/', true],
  ['https://a.b.rightmove.co.uk/path?q=1', true],
  ['https://WWW.RIGHTMOVE.CO.UK/', true],
  ['https://www.rightmove.co.uk:443/', true],
  ['http://www.rightmove.co.uk/', false], // https only; Rightmove redirects http anyway
  ['https://www.zoopla.co.uk/', false],
  ['https://rightmove.co.uk.evil.com/', false],
  ['https://notrightmove.co.uk/', false],
  ['https://rightmove.com/', false],
  ['https://evil.com/?rightmove.co.uk', false],
  ['ftp://rightmove.co.uk/', false],
  [undefined, false],
  ['chrome://extensions', false],
];

for (const [url, want] of CASES) {
  test(`${want ? 'is' : 'not'} Rightmove: ${url}`, () => equal(siteForUrl(url)?.id === 'rightmove', want));
}

// Brochure links (agent-written) must be public https URLs; http is upgraded.
const BROCHURE_CASES = [
  ['https://assets.reapit.net/hyw/live/pdf.php?p=KCG250110&t=S', 'https://assets.reapit.net/hyw/live/pdf.php?p=KCG250110&t=S'],
  ['https://media.rightmove.co.uk/property-brochure/x/1/a.pdf', 'https://media.rightmove.co.uk/property-brochure/x/1/a.pdf'],
  ['http://www.hamptons.co.uk/Pages/RedirectHamletProperty.aspx?propertyid=P299940', 'https://www.hamptons.co.uk/Pages/RedirectHamletProperty.aspx?propertyid=P299940'],
  ['https://192.168.1.1/admin', null],
  ['http://10.0.0.5/', null],
  ['https://127.0.0.1/', null],
  ['http://0x7f000001/', null], // hex form of 127.0.0.1
  ['http://127.1/', null], // short form of 127.0.0.1
  ['https://8.8.8.8/x.pdf', null], // any bare IP
  ['https://[::1]/', null],
  ['http://localhost:8080/', null],
  ['https://router.local/', null],
  ['https://nas.lan/', null],
  ['https://printer.home.arpa/', null],
  ['https://intranet/', null], // single-label name
  ['https://example.com:8443/brochure.pdf', null], // non-default port
  ['https://user:pass@example.com/brochure.pdf', null],
  ['ftp://example.com/brochure.pdf', null],
  ['javascript:alert(1)', null],
  ['file:///etc/passwd', null],
  ['not a url', null],
];

for (const [raw, want] of BROCHURE_CASES) {
  test(`brochure link ${want ? 'allowed' : 'refused'}: ${raw}`, () => equal(safeExternalUrl(raw)?.href ?? null, want));
}

// Listings: one object per listing, one string key per object.
test('listing keys: Rightmove', () => equal(globalThis.listingKey({ site: 'rightmove', id: '95556576' }), 'rightmove:95556576'));

test('listing keys: composite identities are ordered by field name and encoded', () =>
  equal(globalThis.listingKey({ site: 'x', ref: 'a/b:c', branch: '12' }), 'x:12:a%2Fb%3Ac'));

test('Rightmove listings: exactly a site and a numeric id', () =>
  equal(
    [
      { site: 'rightmove', id: '95556576' },
      { site: 'rightmove', id: 95556576 },
      { site: 'rightmove', id: '9555a' },
      { site: 'rightmove', id: '1', extra: 'x' },
      { site: 'rightmove' },
    ].map((listing) => rightmove.isListing(listing)),
    [true, false, false, false, false],
  ));

// Reading real property pages (saved in fixtures/page-models).
test('Rightmove: reads a real property page with a Size field', async () => {
  const page = rightmove.readListing(await fixture('page-models/173701142.html'));
  const sqft = page.sizings.find((s) => s.unit === 'sqft')?.minimumSize;
  equal([sqft, page.floorplans.length, page.keyFeatures.length, page.description.startsWith('Century 21 Heritage')], [1475, 1, 7, true]);
});

test('Rightmove: reads a real property page without one', async () => {
  const page = rightmove.readListing(await fixture('page-models/94142151.html'));
  const onRightmove = (url) => url.startsWith('https://media.rightmove.co.uk/');
  equal([page.sizings, page.floorplans.length > 0 && page.floorplans.every(onRightmove), page.brochures.length], [[], true, 1]);
});

test('Rightmove: a page without a model reads as null', () => equal(rightmove.readListing('<html></html>'), null));
