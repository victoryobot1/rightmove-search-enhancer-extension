// Search pages: the sizes they already state, read by the real background worker without
// caching anything or starting lookups. Chrome's APIs and Rightmove are simulated.
import { test, equal, fixture } from '../lib/t.js';

const store = {};
const fetched = []; // every URL the background fetched
let messageListener;

globalThis.chrome = {
  tabs: { onUpdated: { addListener() {} }, query: async () => [] },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { messageListener ??= fn; } },
    getContexts: async () => [{}],
    sendMessage: async () => ({ result: '' }),
  },
  storage: {
    local: {
      get: async (k) =>
        k === null ? { ...store } : Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in store).map((x) => [x, store[x]])),
      set: async (o) => Object.assign(store, o),
      remove: async (keys) => keys.forEach((k) => delete store[k]),
    },
    sync: { get: async (defaults) => defaults, set: async () => {} },
  },
  action: { setIcon: async () => {}, setTitle: async () => {} },
  permissions: { contains: async () => false, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
};

// Trimmed real responses: the map search API's, and a list page's embedded results.
const mapFixture = await fixture('map-search.json');
const listFixture = await fixture('list-search.json');
let searchStatus = 200;

// The map search API answers with the fixture. Every property page states 999 sq ft, so a
// real lookup can put a size in the cache.
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  if (String(url).includes('/api/property-search/map/search')) {
    return { ok: searchStatus === 200, status: searchStatus, json: async () => mapFixture };
  }
  const model = { propertyData: { sizings: [{ unit: 'sqft', minimumSize: 999, maximumSize: 999 }] } };
  const html = `<script>window.__PAGE_MODEL = ${JSON.stringify(model)};<\/script>`;
  return { ok: true, status: 200, text: async () => html };
};

await import('/src/background.js');
globalThis.rmse.logging = false;

const send = (msg) => new Promise((resolve) => { if (!messageListener(msg, {}, resolve)) resolve(undefined); });
const LIST_URL = 'https://www.rightmove.co.uk/property-for-sale/find.html?locationIdentifier=REGION%5E87490';
const MAP_URL = `https://www.rightmove.co.uk/property-to-rent/map.html?${mapFixture.query}`;
const summary = (reply) => reply.map((r) => [r.listing.id, r.result?.sqft ?? null, r.result?.source ?? null]);

test('stated sizes come back, listings without one get null, and nothing is cached or fetched', async () => {
  const data = {
    properties: [
      { id: 9001, displaySize: '750 sq. ft.', location: { latitude: 51.5, longitude: -0.1 } },
      { id: 9002, displaySize: '' },
      { id: 'x9', displaySize: '800 sq. ft.' }, // malformed id: dropped
      { id: 9003, displaySize: '61 sq. m.' },
      { id: 9004, displaySize: '1 sq. ft.' }, // agent placeholder, not a size
    ],
  };
  const reply = await send({ type: 'searchSizes', pageUrl: LIST_URL, data });
  equal(summary(reply), [['9001', 750, 'listing'], ['9002', null, null], ['9003', 657, 'listing'], ['9004', null, null]], 'results');
  equal([reply[0].lat, reply[0].lng, reply[1].lat], [51.5, -0.1, null], 'coordinates');
  equal([Object.keys(store).length, fetched.length], [0, 0], '[cache entries written, URLs fetched]');
});

test('a fresh cached size wins over the stated one; an expired one does not', async () => {
  await send({ type: 'getSize', listing: { site: 'rightmove', id: '9101' } }); // a lookup caches 999 sq ft
  const data = { properties: [{ id: 9101, displaySize: '750 sq. ft.' }] };
  const fresh = await send({ type: 'searchSizes', pageUrl: LIST_URL, data });
  store['size:rightmove:9101'].ts -= 15 * 24 * 60 * 60 * 1000; // older than the 14-day lifetime
  const expired = await send({ type: 'searchSizes', pageUrl: LIST_URL, data });
  equal([summary(fresh), summary(expired)], [[['9101', 999, 'listing']], [['9101', 750, 'listing']]], '[fresh, expired]');
});

test('a page on a site we do not support, or data in an unknown shape, gives nothing', async () => {
  const data = { properties: [{ id: 9201, displaySize: '750 sq. ft.' }] };
  const otherSite = await send({ type: 'searchSizes', pageUrl: 'https://www.zoopla.co.uk/for-sale/', data });
  const oddData = await send({ type: 'searchSizes', pageUrl: LIST_URL, data: { properties: 'nope' } });
  equal([otherSite, oddData], [[], []]);
});

test('a map page fetches the map search API once, with its own query, and reads every pin', async () => {
  const fetchedBefore = fetched.length;
  const keysBefore = Object.keys(store).length;
  const reply = await send({ type: 'searchSizes', pageUrl: MAP_URL });
  equal(fetched.slice(fetchedBefore), [`https://www.rightmove.co.uk/api/property-search/map/search?${mapFixture.query}`], 'fetched');
  equal(
    summary(reply),
    [['95728494', 726, 'listing'], ['93275232', null, null], ['95065563', null, null], ['95308629', null, null], ['95628276', 838, 'listing'], ['95293194', 797, 'listing']],
    'results',
  );
  equal([reply[0].lat, reply[0].lng], [51.531315, -0.095274], 'first pin position');
  equal(Object.keys(store).length - keysBefore, 0, 'cache entries written');
});

test('results embedded in a list page read the same way', async () => {
  const reply = await send({ type: 'searchSizes', pageUrl: LIST_URL, data: listFixture });
  equal(
    summary(reply),
    [['95728494', 726, 'listing'], ['94425615', 646, 'listing'], ['94821477', 848, 'listing'], ['95408958', null, null], ['95685954', null, null], ['93182211', null, null]],
  );
});

test('a page with no search API, or an API that fails, gives nothing', async () => {
  const fetchedBefore = fetched.length;
  const listWithoutData = await send({ type: 'searchSizes', pageUrl: LIST_URL });
  searchStatus = 503;
  const failing = await send({ type: 'searchSizes', pageUrl: MAP_URL });
  searchStatus = 200;
  equal([listWithoutData, failing, fetched.length - fetchedBefore], [[], [], 1], '[list page, failing API, URLs fetched]');
});
