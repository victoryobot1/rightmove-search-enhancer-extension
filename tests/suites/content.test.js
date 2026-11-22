// The real content script on a fake search page: lookups, badges, the enabled switch,
// cancelled lookups and hidden properties. See "M5" and "M7" in docs/state-machines.md.
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
const pending = new Map(); // id -> resolve(reply) for the latest getSize
let onSettingsChanged;
globalThis.chrome = {
  runtime: {
    sendMessage: async (msg) => {
      sent.push(msg);
      if (msg.type !== 'getSize') return undefined;
      return new Promise((resolve) => pending.set(msg.id, resolve));
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

const getSizes = (id) => sent.filter((m) => m.type === 'getSize' && m.id === id);
const found = (sqft) => ({ status: 'found', sqft, sqm: Math.round(sqft / 10.7639), source: 'listing', sourceLabel: 'Size section', confidence: 97 });
const badgeOf = (card) => card.querySelector('.rmse-size');

// ---- Fake search page ----------------------------------------------------------------

let cardCount = 0;
async function addCard(id, { visible = true } = {}) {
  const card = document.createElement('div');
  card.dataset.testid = `propertyCard-${cardCount++}`;
  card.innerHTML = `<a href="/properties/${id}">Flat</a><div data-testid="property-information"></div>`;
  inView.set(card, visible);
  document.body.appendChild(card);
  await sleep(DEBOUNCE_MS);
  return card;
}

// Rightmove swaps a hidden card's contents for this panel, which has no listing link.
async function hideOnRightmove(card, id) {
  card.innerHTML = `<p>You've hidden this property</p><button data-testid="show-hidden-property">Show</button>
    <label for="hide-questionnaire-${id}">Why?</label>`;
  await sleep(DEBOUNCE_MS);
}

document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/src/content.css' }));
await new Promise((resolve, reject) => {
  document.head.appendChild(Object.assign(document.createElement('script'), { src: '/src/content.js', onload: resolve, onerror: reject }));
});
await sleep(20); // settings load, then the page is watched for changes

// ---- Tests ---------------------------------------------------------------------------

test('a card in view is looked up and shows its size', async () => {
  const card = await addCard('1001');
  // The 1200px-margin observer fires first, then the on-screen one raises the priority.
  const messages = sent.filter((m) => m.id === '1001').map((m) => `${m.type} ${m.priority}`);
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
  equal(sent.filter((m) => m.type === 'cancelSize' && m.id === '1005').length, 1, 'cancelSize sent');
  await reply('1005', { status: 'cancelled' });
  equal(getSizes('1005').length, 1, 'getSize sent');
});

test('hidden properties are removed from results, and shown again when the option is off', async () => {
  const card = await addCard('1006');
  await reply('1006', found(500));
  await hideOnRightmove(card, '1006');
  const hiddenWhenOn = getComputedStyle(card).display;
  await setSetting('collapseHidden', false);
  const shownWhenOff = getComputedStyle(card).display;
  await setSetting('collapseHidden', true);
  equal([card.hasAttribute('data-rmse-hidden'), hiddenWhenOn, shownWhenOff], [true, 'none', 'block'], '[marked, display on, display off]');
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
