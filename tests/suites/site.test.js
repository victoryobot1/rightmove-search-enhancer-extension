// Which URLs count as Rightmove (toolbar icon colour, popup message).
import { test, equal } from '../lib/t.js';
import { isRightmoveUrl } from '/src/site.js';

const CASES = [
  ['https://www.rightmove.co.uk/property-for-sale/find.html', true],
  ['https://rightmove.co.uk/', true],
  ['https://media.rightmove.co.uk/x.jpg', true],
  ['https://hub.rightmove.co.uk/', true],
  ['https://a.b.rightmove.co.uk/path?q=1', true],
  ['https://WWW.RIGHTMOVE.CO.UK/', true],
  ['https://www.rightmove.co.uk:443/', true],
  ['http://www.rightmove.co.uk/', true],
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
  test(`${want ? 'is' : 'not'} Rightmove: ${url}`, () => equal(isRightmoveUrl(url), want));
}
