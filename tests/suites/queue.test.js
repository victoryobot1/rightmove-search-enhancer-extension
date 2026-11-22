// The real background worker's lookup queue (fast lane, OCR lane, priority, cancelling),
// with Chrome's extension APIs, Rightmove and OCR simulated using timed delays.
import { test, equal, assert, sleep } from '../lib/t.js';

const FETCH_MS = 60; // property page download
const SLOW_FETCH_MS = 400;
const OCR_MS = 250; // one OCR job
// Shortened time limits (the real ones are 10s / 15s / 30s).
const TIMEOUTS = { fetchMs: 1000, offscreenMs: 600, ocrLookupMs: 1000 };
globalThis.RMSE_TIMEOUTS = TIMEOUTS;

// ---- Simulated environment ------------------------------------------------------

const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);
const events = []; // { t, kind, id }
const fixtures = new Map(); // id -> propertyData
const slowFetch = new Set();
const store = {};
const counters = { fetches: 0, maxFetches: 0, ocr: 0, maxOcr: 0, closedOffscreen: 0, storageReads: 0 };
const hangs = new Set(); // ids whose OCR job never finishes
let messageListener;
const installedListeners = [];
const permissionListeners = {};
const synced = {}; // what background.js wrote to storage.sync

globalThis.chrome = {
  tabs: { onUpdated: { addListener() {} }, query: async () => [] },
  runtime: {
    onInstalled: { addListener(fn) { installedListeners.push(fn); } },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { messageListener ??= fn; } },
    getContexts: async () => [{}], // pretend the offscreen document exists
    // Only the background calls runtime.sendMessage, and only to reach the offscreen document.
    sendMessage: async (msg) => {
      const id = (msg.url || '').match(/(\d+)/)?.[1];
      if (hangs.has(id)) {
        events.push({ t: now(), kind: 'ocr-hang', id });
        return new Promise(() => {}); // never replies
      }
      counters.maxOcr = Math.max(counters.maxOcr, ++counters.ocr);
      events.push({ t: now(), kind: 'ocr-start', id });
      await sleep(OCR_MS);
      counters.ocr--;
      // Floorplan n of a listing ("<id>-<n>.jpeg") reads as planTexts[n - 1], else planText.
      const n = Number((msg.url || '').match(/-(\d+)\.jpeg$/)?.[1] ?? 1);
      return { result: fixtures.get(id)?.planTexts?.[n - 1] ?? fixtures.get(id)?.planText ?? '' };
    },
  },
  storage: {
    local: {
      get: async (k) => {
        counters.storageReads++;
        if (k === null) return { ...store };
        return Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in store).map((x) => [x, store[x]]));
      },
      set: async (o) => Object.assign(store, o),
      remove: async (keys) => keys.forEach((k) => delete store[k]),
    },
    sync: { get: async (defaults) => defaults, set: async (o) => Object.assign(synced, o) },
  },
  action: { setIcon: async () => {}, setTitle: async () => {} },
  permissions: {
    contains: async () => false,
    onAdded: { addListener(fn) { permissionListeners.added = fn; } },
    onRemoved: { addListener(fn) { permissionListeners.removed = fn; } },
  },
  offscreen: { createDocument: async () => {}, closeDocument: async () => { counters.closedOffscreen++; } },
};

globalThis.fetch = async (url) => {
  const id = String(url).match(/properties\/(\d+)/)?.[1];
  counters.maxFetches = Math.max(counters.maxFetches, ++counters.fetches);
  events.push({ t: now(), kind: 'fetch-start', id });
  await sleep(slowFetch.has(id) ? SLOW_FETCH_MS : FETCH_MS);
  counters.fetches--;
  const html = `<script>window.__PAGE_MODEL = ${JSON.stringify({ propertyData: fixtures.get(id) })};<\/script>`;
  return { ok: true, status: 200, text: async () => html };
};

let nextId = 100000;
function listing(fields) {
  const id = String(nextId++);
  fixtures.set(id, { id, sizings: [], text: { description: '' }, keyFeatures: [], floorplans: [], brochures: [], bedrooms: 1, ...fields(id) });
  return id;
}
const listed = () => listing(() => ({ sizings: [{ unit: 'sqft', minimumSize: 800, maximumSize: 800 }] }));
const inDescription = () => listing(() => ({ text: { description: 'Lovely flat extending to approx 650 sq ft' } }));
const needsOcr = () =>
  listing((id) => ({
    floorplans: [{ url: `https://media.rightmove.co.uk/fp/${id}.jpeg`, type: 'IMAGE' }],
    planText: 'Approx Gross Internal Area 720 sq ft',
  }));
const nothingToRead = () => listing(() => ({}));
const withFloorplans = (planTexts, bedrooms = 1) =>
  listing((id) => ({
    bedrooms,
    floorplans: planTexts.map((_, i) => ({ url: `https://media.rightmove.co.uk/fp/${id}-${i + 1}.jpeg`, type: 'IMAGE' })),
    planTexts,
  }));

// Real Tesseract output for listing 95508042, a 3-bed flat drawn one floor per image: the
// ground floor states its area; the first floor (three bedrooms) states none.
const GROUND_FLOOR_PLAN =
  "RECEPTION ROOM\n\n16'x 12'8\n\n4.87m x 3.86m\n\n=\n\n| =\n\nv\n\nHALLWAY\n\nES\n\nST\n\nKITCHEN\n\n=\n\n10' x 8'4\n\n’\n\n3.05m x 2.53m\n\n-— —\n\n| WC\n\nj=\n\ncm\n\nCE ——— ee 4\n\nGROUND FLOOR\n\nAPPROX. FLOOR\n\nAREA 321 SQ.FT\n\n(29.9 SQ.M.)\n";
const FIRST_FLOOR_PLAN =
  "BEDROOM\n\nBEDROOM\n\n98 x7\n\n294m x 2.14m\n\n12'9 x 10'6\n\n3.88m x 3.19m\n\nLANDING] |\n\nBEDROOM\n\n12'8 x 10'6\n\n———\n\n3.86m x 3.19m\n\n=\n\n|\n";
const manyFloorplansNoTotal = () =>
  listing((id) => ({
    floorplans: [1, 2, 3].map((n) => ({ url: `https://media.rightmove.co.uk/fp/${id}-${n}.jpeg`, type: 'IMAGE' })),
    planText: 'Bedroom', // no total and no room sizes: every OCR pass runs
  }));

// ---- Load the real background worker --------------------------------------------

await import('/src/background.js');
globalThis.rmse.logging = false;

const send = (msg) => new Promise((resolve) => { if (!messageListener(msg, {}, resolve)) resolve(undefined); });
const rm = (id) => ({ site: 'rightmove', id });
const getSize = (id, priority = 'nearby', force = false) => send({ type: 'getSize', listing: rm(id), priority, force });
const idle = async () => { while (counters.fetches || counters.ocr) await sleep(20); await sleep(50); };
const ocrOrder = (ids) => events.filter((e) => e.kind === 'ocr-start' && ids.includes(e.id)).map((e) => e.id);
const ranOcr = (id) => events.some((e) => e.kind === 'ocr-start' && e.id === id);
const named = (names) => (ids) => ids.map((id) => names[id] ?? id).join(' → ');

// Lets the first lookup take the single OCR slot so later ones have to queue.
async function startBlocker() {
  const blocker = needsOcr();
  const done = getSize(blocker);
  await sleep(FETCH_MS + 30);
  return { blocker, done };
}

// ---- Tests -------------------------------------------------------------------------

test('fast-lane results arrive while the OCR lane is busy', async () => {
  const ocrIds = [needsOcr(), needsOcr(), needsOcr(), needsOcr()];
  const fastIds = [listed(), inDescription(), listed()];
  const start = now();
  const ocrDone = Promise.all(ocrIds.map((id) => getSize(id)));
  await sleep(5);
  const fast = await Promise.all(fastIds.map((id) => getSize(id)));
  const fastMs = now() - start;
  await ocrDone;
  const ocrMs = now() - start;
  equal(fast.map((r) => `${r.sqft}/${r.source}`), ['800/listing', '650/description', '800/listing'], 'fast results');
  assert(fastMs < OCR_MS * 2, `fast results took ${fastMs}ms`);
  await idle();
  return `fast done at ${fastMs}ms, OCR backlog at ${ocrMs}ms`;
});

test('OCR lane order: page, then visible, then nearby oldest-first', async () => {
  const { blocker, done } = await startBlocker();
  const n1 = needsOcr(), n2 = needsOcr(), vis = needsOcr(), page = needsOcr();
  const p = [done, getSize(n1), getSize(n2)];
  await sleep(5);
  p.push(getSize(vis, 'visible'));
  await sleep(5);
  p.push(getSize(page, 'page'));
  await Promise.all(p);
  const name = named({ [blocker]: 'blocker', [n1]: 'nearby1', [n2]: 'nearby2', [vis]: 'visible', [page]: 'page' });
  equal(name(ocrOrder([blocker, n1, n2, vis, page])), 'blocker → page → visible → nearby1 → nearby2', 'order');
  await idle();
});

test('a card scrolled on screen jumps the OCR queue', async () => {
  const { blocker, done } = await startBlocker();
  const a = needsOcr(), b = needsOcr(), c = needsOcr();
  const p = [done, getSize(a), getSize(b), getSize(c)];
  await sleep(FETCH_MS * 2 + 40); // a, b, c are all waiting for OCR
  await send({ type: 'setPriority', listing: rm(c), priority: 'visible' });
  await Promise.all(p);
  equal(named({ [blocker]: 'blocker', [a]: 'a', [b]: 'b', [c]: 'c' })(ocrOrder([blocker, a, b, c])), 'blocker → c → a → b', 'order');
  await idle();
});

test('a priority change arriving during the cache check is kept', async () => {
  const { blocker, done } = await startBlocker();
  const old1 = needsOcr(), old2 = needsOcr(), racer = needsOcr();
  const p = [done, getSize(old1), getSize(old2)];
  await sleep(5);
  p.push(getSize(racer, 'nearby'));
  send({ type: 'setPriority', listing: rm(racer), priority: 'visible' }); // same tick, before the lookup registers
  await Promise.all(p);
  equal(named({ [blocker]: 'blocker', [old1]: 'old1', [old2]: 'old2', [racer]: 'racer' })(ocrOrder([blocker, old1, old2, racer])), 'blocker → racer → old1 → old2', 'order');
  await idle();
});

test('cancel removes a lookup waiting for OCR, which never runs or gets cached', async () => {
  const { done } = await startBlocker();
  const victim = needsOcr();
  const pending = getSize(victim);
  await sleep(FETCH_MS + 30);
  const reply = await send({ type: 'cancelSize', listing: rm(victim) });
  const result = await pending;
  await done;
  equal([reply?.cancelled, result.status, ranOcr(victim), Boolean(store[`size:rightmove:${victim}`])], [true, 'cancelled', false, false], '[cancelled, status, ran OCR, cached]');
  await idle();
});

test('cancel during the fast lane stops it before OCR', async () => {
  const victim = needsOcr();
  slowFetch.add(victim);
  const pending = getSize(victim);
  await sleep(50); // its page fetch is in progress
  const reply = await send({ type: 'cancelSize', listing: rm(victim) });
  const result = await pending;
  equal([reply?.cancelled, result.status, ranOcr(victim)], [true, 'cancelled', false], '[cancelled, status, ran OCR]');
  await idle();
});

test('a cancelled property can be requested again (unhidden)', async () => {
  const { done } = await startBlocker();
  const id = needsOcr();
  const pending = getSize(id);
  await sleep(FETCH_MS + 30);
  await send({ type: 'cancelSize', listing: rm(id) });
  await pending;
  const again = await getSize(id, 'visible');
  await done;
  equal([again.status, again.sqft], ['found', 720]);
  await idle();
});

test('a listing with nothing to read never enters the OCR lane', async () => {
  const id = nothingToRead();
  const result = await getSize(id);
  equal([result.status, ranOcr(id)], ['none', false], '[status, ran OCR]');
  await idle();
});

test('simultaneous requests share one lookup; later ones hit the cache', async () => {
  const id = listed();
  const fetchesFor = () => events.filter((e) => e.kind === 'fetch-start' && e.id === id).length;
  const [a, b] = await Promise.all([getSize(id), getSize(id)]);
  equal([fetchesFor(), a.sqft === b.sqft], [1, true], '[fetches, same result]');
  await getSize(id);
  equal(fetchesFor(), 1, 'fetches after cache hit');
});

test('a stuck OCR job times out, restarts the OCR engine, and the lane moves on', async () => {
  const stuck = needsOcr();
  hangs.add(stuck);
  const next = needsOcr();
  const closedBefore = counters.closedOffscreen;
  const start = now();
  const [stuckResult, nextResult] = await Promise.all([getSize(stuck), (await sleep(5), getSize(next))]);
  const ms = now() - start;
  equal([stuckResult.status, nextResult.status, nextResult.sqft], ['error', 'found', 720], '[stuck, next, next sqft]');
  equal(counters.closedOffscreen > closedBefore, true, 'OCR engine restarted');
  equal(Boolean(store[`size:rightmove:${stuck}`]), false, 'timed-out result cached');
  await idle();
  return `both settled after ${ms}ms (job limit ${TIMEOUTS.offscreenMs}ms)`;
});

test('a listing stops OCR once it reaches its time limit', async () => {
  const id = manyFloorplansNoTotal();
  const start = now();
  const result = await getSize(id);
  const ms = now() - start;
  const passes = events.filter((e) => e.kind === 'ocr-start' && e.id === id).length;
  equal(result.status, 'error', 'status');
  equal(passes < 6, true, `ran ${passes} of 6 OCR passes`);
  await idle();
  return `stopped after ${passes} of 6 passes, ${ms}ms (limit ${TIMEOUTS.ocrLookupMs}ms)`;
});

test('slot limits hold under load and both lanes drain', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => (i % 3 ? needsOcr() : listed()));
  await Promise.all(ids.map((id) => getSize(id)));
  const snapshot = globalThis.rmse.queue();
  equal([counters.maxFetches <= 2, counters.maxOcr <= 1], [true, true], `[≤2 fetches (max ${counters.maxFetches}), ≤1 OCR (max ${counters.maxOcr})]`);
  equal(snapshot, { fast: { running: [], waiting: [] }, ocr: { running: [], waiting: [] } }, 'queue snapshot');
});

test('a priority change for a settled lookup is dropped, not applied to a later retry', async () => {
  const late = needsOcr();
  await getSize(late);
  await send({ type: 'setPriority', listing: rm(late), priority: 'visible' }); // arrives just after it settled
  equal(globalThis.rmse.lookups()[`rightmove:${late}`], undefined, 'no record kept');
  const { blocker, done } = await startBlocker();
  const older = needsOcr();
  const p = [done, getSize(older)];
  await sleep(5);
  p.push(getSize(late, 'nearby', true)); // retry: must queue as nearby, behind the older one
  await Promise.all(p);
  equal(named({ [blocker]: 'blocker', [older]: 'older', [late]: 'retry' })(ocrOrder([blocker, older, late]).slice(-3)), 'blocker → older → retry', 'order');
  await idle();
});

test('requests arriving during the cache check join it: one storage read, one fetch', async () => {
  const id = listed();
  const reads = counters.storageReads;
  const [a, b] = await Promise.all([getSize(id), getSize(id)]);
  const fetches = events.filter((e) => e.kind === 'fetch-start' && e.id === id).length;
  equal([counters.storageReads - reads, fetches, a.sqft, b.sqft], [1, 1, 800, 800], '[storage reads, fetches, a, b]');
  await idle();
});

test('rmse.lookups() shows each listing\'s state while it runs', async () => {
  const id = needsOcr();
  slowFetch.add(id);
  const pending = getSize(id, 'visible');
  await sleep(50);
  const during = globalThis.rmse.lookups()[`rightmove:${id}`];
  await pending;
  assert(/^fast, visible, fetching property page/.test(during), `got "${during}"`);
  equal(globalThis.rmse.lookups()[`rightmove:${id}`], undefined, 'removed once settled');
  await idle();
  return during;
});

test('the agents\' websites setting follows the optional permission', () => {
  permissionListeners.added({ origins: ['https://*/*'] });
  const afterAdd = synced.externalBrochures;
  permissionListeners.removed({ origins: ['https://*/*'] });
  const afterRemove = synced.externalBrochures;
  permissionListeners.added({ origins: ['https://example.com/*'] });
  equal([afterAdd, afterRemove, synced.externalBrochures], [true, false, false], '[added, removed, unrelated origin]');
});

test('listings that are malformed or from an unknown site are ignored', async () => {
  const fetchesBefore = events.filter((e) => e.kind === 'fetch-start').length;
  const replies = await Promise.all([
    send({ type: 'getSize', listing: { site: 'rightmove', id: '12a' } }),
    send({ type: 'getSize', listing: { site: 'rightmove', id: 123 } }), // a number, not a string
    send({ type: 'getSize', listing: { site: 'rightmove', id: '123', extra: 'x' } }),
    send({ type: 'getSize', listing: { site: 'zoopla', id: '123' } }),
    send({ type: 'getSize', listing: { site: 'constructor', id: '123' } }), // not a registered site
    send({ type: 'getSize', id: '123' }), // the old message shape
  ]);
  const fetches = events.filter((e) => e.kind === 'fetch-start').length - fetchesBefore;
  equal([replies.every((r) => r === undefined), fetches], [true, 0], '[all ignored, property pages fetched]');
});

test('old "size:<id>" cache entries are deleted when the extension updates', async () => {
  store['size:555'] = { status: 'found', sqft: 1000 };
  store['size:rightmove:556'] = { status: 'found', sqft: 1000 };
  for (const listener of installedListeners) listener({ reason: 'update' });
  await sleep(20);
  equal(['size:555' in store, 'size:rightmove:556' in store], [false, true], '[old key kept, new key kept]');
});

test('one floor\'s area is not taken as the total of a home on several floors', async () => {
  const result = await getSize(withFloorplans([GROUND_FLOOR_PLAN, FIRST_FLOOR_PLAN], 3));
  equal(result.source, 'roomEstimate', 'source');
  assert(result.sqft > 321 * 1.5 && result.sqft < 1000, `estimated ${result.sqft} sq ft from both floors`);
  await idle();
  return `${result.sqft} sq ft (ground floor alone: 321)`;
});

test('areas stated for two floors are added up', async () => {
  const firstFloor = 'FIRST FLOOR\n\nAPPROX. FLOOR\n\nAREA 300 SQ.FT\n\n(27.9 SQ.M.)';
  const result = await getSize(withFloorplans([GROUND_FLOOR_PLAN, firstFloor]));
  equal([result.sqft, result.source], [621, 'floorplan']);
  await idle();
});

test('the one floor of a single-floor home is its total', async () => {
  const result = await getSize(withFloorplans(['GROUND FLOOR FLAT\n\nAPPROX. FLOOR AREA 650 SQ.FT\n\n(60.4 SQ.M.)']));
  equal([result.sqft, result.source], [650, 'floorplan']);
  await idle();
});

test('when only one floor\'s area can be read and no rooms can, it is shown with low confidence', async () => {
  const result = await getSize(withFloorplans(['GROUND FLOOR\n\nAPPROX. FLOOR\n\nAREA 321 SQ.FT\n\n(29.9 SQ.M.)', 'LANDING']));
  equal([result.sqft, result.source, result.confidence], [321, 'floorplan', 40]);
  await idle();
});
