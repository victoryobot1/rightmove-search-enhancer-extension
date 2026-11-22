// The real content scripts (engine + Rightmove track) on a fake search page: lookups,
// badges, sizes the page already states, the enabled switch, cancelled lookups, hidden
// properties, and the map view's pins and cards. See "M5", "M7" and "M13" in
// docs/state-machines.md. The map markup copies what Rightmove's map renders.
import { test, equal, assert, sleep } from '../lib/t.js';

const DEBOUNCE_MS = 300; // content.js re-renders 250ms after a DOM change

// ---- Fake IntersectionObserver ----------------------------------------------------
// Like the real one: observing a new target sends one initial notification, observing a
// target that's already observed does nothing. Whether a card counts as "in view" is set
// per card with `inView`.

const inView = new WeakMap();
const observers = [];
globalThis.IntersectionObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    observers.push(this);
  }
  observe(el) {
    if (this.targets.has(el)) return;
    this.targets.add(el);
    setTimeout(() => this.targets.has(el) && this.callback([{ target: el, isIntersecting: inView.get(el) ?? true }]));
  }
  unobserve(el) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
};

// Simulates a card scrolling into or out of view.
async function scroll(card, visible) {
  inView.set(card, visible);
  for (const o of observers) if (o.targets.has(card)) o.callback([{ target: card, isIntersecting: visible }]);
  await sleep(10);
}

// ---- Fake extension APIs -------------------------------------------------------------

const sent = [];
const pending = new Map(); // listing id -> resolve(reply) for the latest getSize
let onSettingsChanged;
const SEARCH_REPLY_MS = 100; // the background's answer to searchSizes arrives after the page is set up
globalThis.chrome = {
  runtime: {
    sendMessage: async (msg) => {
      sent.push(msg);
      if (msg.type === 'searchSizes') return sleep(SEARCH_REPLY_MS).then(() => searchReply(msg));
      if (msg.type !== 'getSize') return undefined;
      return new Promise((resolve) => pending.set(msg.listing.id, resolve));
    },
  },
  storage: {
    sync: { get: async (defaults) => defaults },
    onChanged: { addListener: (fn) => (onSettingsChanged = fn) },
  },
};

async function setSetting(key, value) {
  onSettingsChanged({ [key]: { newValue: value } }, 'sync');
  await sleep(10);
}

async function reply(id, result) {
  pending.get(id)(result);
  await sleep(10);
}

const getSizes = (id) => sent.filter((m) => m.type === 'getSize' && m.listing?.id === id);
const found = (sqft) => ({ status: 'found', sqft, sqm: Math.round(sqft / 10.7639), source: 'listing', sourceLabel: 'Size section', confidence: 97 });
const badgeOf = (card) => card.querySelector('.rmse-size');

// The map view's search results: where each listing is, and the size it states if any.
const MAP_LISTINGS = [
  { id: '3001', lat: 51.531315, lng: -0.095274, result: found(664) },
  { id: '3002', lat: 51.529876, lng: -0.13323, result: null },
  { id: '3003', lat: 51.5485, lng: -0.13965, result: null }, // shares its position…
  { id: '3004', lat: 51.5485, lng: -0.13965, result: found(900) }, // …with this one
  { id: '3007', lat: 51.55196, lng: -0.074557, result: null },
];

// What the background answers to searchSizes (stands in for background.js, which has its
// own tests for this): for the page's embedded results, the Size field of listing 2001; for
// the map view, MAP_LISTINGS.
function searchReply(msg) {
  if (msg.data?.properties) return [{ listing: { site: 'rightmove', id: '2001' }, lat: null, lng: null, result: found(750) }];
  if (new URL(msg.pageUrl).searchParams.get('view') !== 'map') return [];
  return MAP_LISTINGS.map(({ id, lat, lng, result }) => ({ listing: { site: 'rightmove', id }, lat, lng, result }));
}

// ---- Fake search page ----------------------------------------------------------------

let cardCount = 0;
function makeCard(id, { visible = true } = {}) {
  const card = document.createElement('div');
  card.dataset.testid = `propertyCard-${cardCount++}`;
  card.innerHTML = `<a href="/properties/${id}">Flat</a><div data-testid="property-information"></div>`;
  inView.set(card, visible);
  return card;
}

async function addCard(id, options) {
  const card = makeCard(id, options);
  document.body.appendChild(card);
  await sleep(DEBOUNCE_MS);
  return card;
}

// The map view's price pin: a position, no listing id. Returns the wrapper the label goes on.
function addPin(lat, lng, price = '£3.1k') {
  const marker = document.createElement('gmp-advanced-marker');
  marker.setAttribute('position', `${lat},${lng}`);
  marker.innerHTML = `<div style="pointer-events: all;"><div><div class="PricePin_pricePin__cUGhr" aria-label="Price: ${price}">${price}</div></div></div>`;
  document.body.appendChild(marker);
  return marker.querySelector('[aria-label^="Price:"]').parentElement;
}

// The card a clicked pin opens.
async function openPinCard(id) {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = `<div role="tooltip"><button data-testid="map-card-close-button">×</button>
    <div><a href="/properties/${id}#/?channel=RES_LET"><img alt=""></a></div>
    <a href="/properties/${id}#/?channel=RES_LET" aria-label="View property details: Flat property, Price: £3,150 pcm"><p>£3,150 pcm</p><p>Flat</p></a></div>`;
  document.body.appendChild(dialog);
  await sleep(DEBOUNCE_MS);
  return dialog.querySelector('[role="tooltip"]');
}

// The list a clicked cluster opens; only the first `inViewCount` items are in its scroll area.
async function openClusterCard(ids, inViewCount) {
  const list = document.createElement('ul');
  list.setAttribute('aria-label', 'Properties in this area');
  list.innerHTML = ids.map((id) => `<li><a href="/properties/${id}"><img alt=""></a><a href="/properties/${id}">£650,000</a><a href="/properties/${id}"><p>Flat</p></a></li>`).join('');
  [...list.children].forEach((li, i) => inView.set(li, i < inViewCount));
  document.body.appendChild(list);
  await sleep(DEBOUNCE_MS);
  return list;
}

// Rightmove swaps a hidden card's contents for this panel, which has no listing link.
async function hideOnRightmove(card, id) {
  card.innerHTML = `<p>You've hidden this property</p><button data-testid="show-hidden-property">Show</button>
    <label for="hide-questionnaire-${id}">Why?</label>`;
  await sleep(DEBOUNCE_MS);
}

// The page as it loads: Rightmove's embedded search results, and a card already on screen
// whose listing states its size there.
const nextData = { props: { pageProps: { searchResults: { properties: [{ id: 2001, displaySize: '750 sq. ft.' }] } } } };
document.body.insertAdjacentHTML('beforeend', `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`);
const seededCard = makeCard('2001');
document.body.appendChild(seededCard);

document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/src/content.css' }));
for (const src of ['/src/shared/listing.js', '/src/content/core.js', '/src/content/rightmove.js']) {
  await new Promise((resolve, reject) => {
    document.head.appendChild(Object.assign(document.createElement('script'), { src, onload: resolve, onerror: reject }));
  });
}
await sleep(SEARCH_REPLY_MS + 50); // settings load, the page's sizes arrive, then the page is watched for changes

// ---- Tests ---------------------------------------------------------------------------

test('a size the search page already states is shown without a lookup', () => {
  const searches = sent.filter((m) => m.type === 'searchSizes');
  equal(searches.map((m) => [m.pageUrl, m.data.properties.length]), [[location.href, 1]], 'searchSizes sent');
  equal(getSizes('2001').length, 0, 'getSize sent');
  assert(/750 sq ft/.test(badgeOf(seededCard)?.textContent), `badge: ${badgeOf(seededCard)?.textContent}`);
});

test('a card in view is looked up and shows its size', async () => {
  const card = await addCard('1001');
  // The 1200px-margin observer fires first, then the on-screen one raises the priority.
  const messages = sent.filter((m) => m.listing?.id === '1001').map((m) => `${m.type} ${m.priority}`);
  equal(messages, ['getSize nearby', 'setPriority visible'], 'messages');
  await reply('1001', found(800));
  assert(/800 sq ft/.test(badgeOf(card)?.textContent), `badge: ${badgeOf(card)?.textContent}`);
});

test('turned off: badges go, and nothing is looked up or re-drawn', async () => {
  const waiting = await addCard('1002'); // its lookup is still running when the switch is turned off
  const far = await addCard('1003', { visible: false });
  equal(getSizes('1003').length, 0, 'far card not looked up yet');

  await setSetting('enabled', false);
  equal(document.querySelectorAll('.rmse-size').length, 0, 'badges left');

  await scroll(far, true);
  await reply('1002', found(650));
  equal([getSizes('1003').length, document.querySelectorAll('.rmse-size').length, Boolean(badgeOf(waiting))], [0, 0, false], '[lookups for far card, badges, late reply drew a badge]');
});

test('turned back on: cards that were never looked up are looked up', async () => {
  await setSetting('enabled', true);
  await sleep(DEBOUNCE_MS);
  equal(getSizes('1003').length, 1, 'lookups for the far card');
  await reply('1003', found(900));
  assert(document.querySelectorAll('.rmse-size').length >= 3, 'badges redrawn');
});

test('a lookup cancelled by another tab is asked for again while the card is shown here', async () => {
  const card = await addCard('1004');
  await reply('1004', { status: 'cancelled' });
  equal(getSizes('1004').length, 2, 'getSize sent');
  await reply('1004', found(720));
  assert(/720 sq ft/.test(badgeOf(card)?.textContent), 'badge filled in');
});

test('hiding a card cancels its lookup once and does not ask again', async () => {
  const card = await addCard('1005');
  await hideOnRightmove(card, '1005');
  equal(sent.filter((m) => m.type === 'cancelSize' && m.listing?.id === '1005').length, 1, 'cancelSize sent');
  await reply('1005', { status: 'cancelled' });
  equal(getSizes('1005').length, 1, 'getSize sent');
});

test('hidden properties are removed from results while the option is on', async () => {
  const card = await addCard('1006');
  await reply('1006', found(500));
  await hideOnRightmove(card, '1006');
  const byDefault = getComputedStyle(card).display;
  await setSetting('collapseHidden', true);
  const whenOn = getComputedStyle(card).display;
  await setSetting('collapseHidden', false);
  const whenOff = getComputedStyle(card).display;
  equal([card.hasAttribute('data-rmse-hidden'), byDefault, whenOn, whenOff], [true, 'block', 'none', 'block'], '[marked, display by default, on, off]');
});

test('clicking a "Size n/a" badge retries with force', async () => {
  const card = await addCard('1007');
  await reply('1007', { status: 'none', checked: ['description'] });
  equal(badgeOf(card)?.dataset.state, 'none', 'badge state');
  badgeOf(card).click();
  await sleep(10);
  equal(getSizes('1007').map((m) => m.force), [false, true], 'force flags');
  await reply('1007', found(610));
});

// ---- Map view --------------------------------------------------------------------------

const pins = {};
const label = (pin) => pin.getAttribute('data-rmse-size');
const messagesFor = (id) => sent.filter((m) => m.listing?.id === id).map((m) => `${m.type} ${m.priority}`);

test('map pins: known sizes get a label, others none, from one search per page URL', async () => {
  history.pushState({}, '', `${location.pathname}${location.search}&view=map`);
  pins.known = addPin(51.531315, -0.095274);
  pins.unknown = addPin(51.529876, -0.13323);
  pins.shared = addPin(51.5485, -0.13965);
  pins.later = addPin(51.55196, -0.074557);
  pins.stray = addPin(51.6, -0.2); // not in the search results: never placed, never searched for again
  await sleep(DEBOUNCE_MS + SEARCH_REPLY_MS + 50);
  const searches = sent.filter((m) => m.type === 'searchSizes' && !m.data);
  equal(searches.map((m) => m.pageUrl), [location.href], 'searches');
  equal([label(pins.known), label(pins.unknown), label(pins.shared), label(pins.stray)], ['664 ft²', null, null, null], 'labels');
  equal(['3001', '3002', '3003', '3004', '3007'].map((id) => getSizes(id).length), [0, 0, 0, 0, 0], 'lookups from pins');
});

test('opening a pin card looks the listing up on screen, and the answer labels its pin', async () => {
  const card = await openPinCard('3002');
  equal(messagesFor('3002')[0], 'getSize visible', 'first message');
  await reply('3002', { ...found(700), source: 'floorplan', sourceLabel: 'Floorplan (OCR)', confidence: 88 });
  assert(/700 sq ft/.test(badgeOf(card)?.textContent), `badge: ${badgeOf(card)?.textContent}`);
  equal(label(pins.unknown), '≈700 ft²', 'pin label');
});

test('closing a card whose lookup is still waiting lowers its priority', async () => {
  const card = await openPinCard('3005');
  card.parentElement.remove();
  await sleep(DEBOUNCE_MS);
  const messages = messagesFor('3005');
  equal([messages[0], messages.at(-1)], ['getSize visible', 'setPriority nearby']);
});

test('a big cluster looks up only the listings in view', async () => {
  const ids = ['3101', '3102', '3103', '3104', '3105', '3106'];
  await openClusterCard(ids, 2);
  equal(ids.map((id) => getSizes(id).length), [1, 1, 0, 0, 0, 0]);
});

test('a listing shown only as a pin is not asked for again after a cancel', async () => {
  const card = await openPinCard('3007');
  card.parentElement.remove();
  await sleep(DEBOUNCE_MS);
  await reply('3007', { status: 'cancelled' }); // another tab hid it while it was queued
  equal(getSizes('3007').length, 1, 'getSize sent');
});

test('switching off removes pin labels, and switching on brings them back', async () => {
  await setSetting('enabled', false);
  const whenOff = document.querySelectorAll('[data-rmse-size]').length;
  await setSetting('enabled', true);
  await sleep(DEBOUNCE_MS);
  equal([whenOff, label(pins.known)], [0, '664 ft²']);
});
