// Which URLs count as Rightmove (toolbar icon colour, popup message).
import { test, equal } from '../lib/t.js';
import { isRightmoveUrl, safeExternalUrl } from '/src/site.js';

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
  test(`${want ? 'is' : 'not'} Rightmove: ${url}`, () => equal(isRightmoveUrl(url), want));
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
