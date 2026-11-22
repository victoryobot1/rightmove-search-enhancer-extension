import './shared/listing.js';
import { findSize, sizeFromDisplaySize, sizeFromListingText, sizeFromSizings } from './extract.js';
import { estimateFromRooms, readRooms } from './estimate.js';
import { getSettings } from './settings.js';
import { safeExternalUrl } from './safeUrl.js';
import { SITES, parseListing, siteForUrl } from './sites/index.js';

const { listingKey } = globalThis;

const CACHE_PREFIX = 'size:'; // + listingKey(listing), e.g. "size:rightmove:95556576"
// Bump when extraction rules change so results cached by older versions are looked up again.
const CACHE_VERSION = 6;
const TTL_FOUND_MS = 14 * 24 * 60 * 60 * 1000;
const TTL_NONE_MS = 24 * 60 * 60 * 1000; // agents often add floorplans after listing
// Fast lane: fetch the property page and check the Size field + description (network only).
// OCR lane: floorplans and brochures. One slot, because there's one OCR worker; a second
// slot would only interleave two listings' OCR jobs and delay both.
const FAST_LANE_SLOTS = 2;
const OCR_LANE_SLOTS = 1;
const MAX_FLOORPLANS = 3;
const MAX_BROCHURE_OCR_PAGES = 4;
const OFFSCREEN_IDLE_MS = 90 * 1000;

// Time limits, so one stuck download or OCR job can't hold the single OCR slot forever.
// Tests shorten these by setting globalThis.RMSE_TIMEOUTS before loading this file.
const TIMEOUTS = {
  fetchMs: 10 * 1000, // property page download
  offscreenMs: 15 * 1000, // one OCR job or brochure read; the OCR engine is restarted after
  ocrLookupMs: 30 * 1000, // all OCR for one listing
  ...globalThis.RMSE_TIMEOUTS,
};

const SOURCE_LABELS = {
  listing: 'Size section',
  description: 'Description',
  keyFeatures: 'Key features',
  floorplan: 'Floorplan (OCR)',
  brochure: 'Brochure',
  brochureOcr: 'Brochure (OCR)',
  roomEstimate: 'Estimated from floorplan room sizes',
};

// How much a stated total from each source can be trusted, before adjusting for the
// wording around it (findSize's context score). Room-size estimates score themselves.
const BASE_CONFIDENCE = {
  listing: 97,
  description: 82,
  keyFeatures: 85,
  brochure: 82,
  floorplan: 85,
  brochureOcr: 78,
};

function confidenceFor(source, size) {
  if (source === 'listing') return size.fromMetric ? 95 : 97;
  const contextBonus = Math.max(-12, Math.min(8, Math.round((size.score ?? 0) * 1.5)));
  return Math.max(40, Math.min(95, BASE_CONFIDENCE[source] + contextBonus));
}

// ---------------------------------------------------------------------------
// Toolbar icon: coloured on supported sites, greyed out everywhere else (the manifest default).
// The popup still opens when greyed out, so it can explain why.

// Leading slash matters: in a service worker, setIcon resolves relative paths against the
// worker's own location (src/), not the extension root.
const ACTIVE_ICONS = { 16: '/icons/icon16.png', 32: '/icons/icon32.png', 48: '/icons/icon48.png' };
const INACTIVE_ICONS = {
  16: '/icons/icon16-disabled.png',
  32: '/icons/icon32-disabled.png',
  48: '/icons/icon48-disabled.png',
};

async function updateActionForTab(tabId, url) {
  const active = Boolean(siteForUrl(url));
  try {
    await chrome.action.setIcon({ tabId, path: active ? ACTIVE_ICONS : INACTIVE_ICONS });
    await chrome.action.setTitle({
      tabId,
      title: active ? 'Rightmove Search Enhancer' : 'Rightmove Search Enhancer only works on rightmove.co.uk',
    });
  } catch (err) {
    // "No tab with id" just means the tab closed first; anything else is a real problem.
    if (!/no tab with id/i.test(String(err?.message))) console.error('Could not update toolbar icon', tabId, err);
  }
}

async function updateActionForAllTabs() {
  for (const tab of await chrome.tabs.query({})) updateActionForTab(tab.id, tab.url);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading') updateActionForTab(tabId, tab.url);
});
chrome.runtime.onInstalled.addListener(() => {
  updateActionForAllTabs();
  dropLegacyCacheKeys();
});
chrome.runtime.onStartup.addListener(updateActionForAllTabs);

// Before listings were keyed by site, sizes were cached as "size:<id>". Nothing reads
// those any more; they would only take up space.
async function dropLegacyCacheKeys() {
  const all = await chrome.storage.local.get(null);
  const legacy = Object.keys(all).filter((key) => /^size:\d+$/.test(key));
  if (legacy.length) await chrome.storage.local.remove(legacy);
}

// ---------------------------------------------------------------------------
// The "agents' websites" brochure setting follows the optional permission, whichever way
// it changes: the popup can close while Chrome's permission prompt is open (so its own
// save never runs), and the permission can be removed in chrome://extensions.

const EXTERNAL_ORIGINS = 'https://*/*';

chrome.permissions.onAdded.addListener(({ origins = [] }) => {
  if (origins.includes(EXTERNAL_ORIGINS)) chrome.storage.sync.set({ externalBrochures: true });
});
chrome.permissions.onRemoved.addListener(({ origins = [] }) => {
  if (origins.includes(EXTERNAL_ORIGINS)) chrome.storage.sync.set({ externalBrochures: false });
});

// ---------------------------------------------------------------------------
// Messaging

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;

  // getSize, setPriority and cancelSize name a listing; ignore any that doesn't check out.
  const listing = parseListing(msg?.listing);
  if (msg?.type === 'getSize' && listing) {
    getSize(listing, Boolean(msg.force), msg.priority).then(sendResponse);
    return true;
  }
  if (msg?.type === 'setPriority' && listing) {
    setPriority(listingKey(listing), msg.priority);
    return false;
  }
  if (msg?.type === 'cancelSize' && listing) {
    sendResponse({ cancelled: cancelQueued(listingKey(listing)) });
    return false;
  }
  if (msg?.type === 'searchSizes' && typeof msg.pageUrl === 'string') {
    searchSizes(msg.pageUrl, msg.data)
      .catch((err) => {
        console.warn('Search sizes failed', msg.pageUrl, err);
        return [];
      })
      .then(sendResponse);
    return true;
  }
  if (msg?.type === 'clearCache') {
    clearCache().then(sendResponse);
    return true;
  }
  if (msg?.type === 'cacheStats') {
    cacheStats().then(sendResponse);
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Cache + queue
//
// Every lookup goes through the fast lane. Only listings that still have no size, and
// have a floorplan or brochure to read, move on to the OCR lane. Within each lane the
// property page being viewed goes first, then cards on screen, then cards further down.
//
// Queue logging is shown in the service worker console: chrome://extensions → this
// extension → "Inspect views: service worker". There, `rmse.queue()` prints a snapshot,
// `rmse.lookups()` lists each listing's state, and `rmse.logging = false` silences it.

const PRIORITY = { page: 0, visible: 1, nearby: 2 };
const PRIORITY_NAMES = Object.keys(PRIORITY);

// One record per listing while it's being looked up ("M1" in docs/state-machines.md). It's
// created synchronously when getSize is first called, so priority changes and repeat
// requests that arrive during the cache check find it, and deleted once the lookup settles.
//   checkingCache → fastQueued → fast → ocrQueued → ocr     (queued states are skipped
//                                                             when a slot is free)
// `cancelRequested` is set when a cancel arrives while the fast lane is running: the
// lookup then stops before OCR.
const NEXT_STATES = {
  checkingCache: ['fastQueued', 'fast'],
  fastQueued: ['fast'],
  fast: ['ocrQueued', 'ocr'],
  ocrQueued: ['ocr'],
  ocr: [],
};
// Keyed by listingKey(listing); lanes, logs and rmse.lookups() show that key as the id.
const lookups = new Map(); // key -> { listing, state, priority, force, cancelRequested, promise }
const priorityOf = (key) => lookups.get(key)?.priority ?? PRIORITY.nearby;

function moveTo(key, state) {
  const entry = lookups.get(key);
  if (!entry || entry.state === state) return;
  // Never throws: an unexpected transition is a bug worth seeing, not worth a failed lookup.
  if (!NEXT_STATES[entry.state]?.includes(state)) console.warn(`[lookup] ${key}: unexpected ${entry.state} → ${state}`);
  entry.state = state;
}

const secs = (since) => `${((performance.now() - since) / 1000).toFixed(1)}s`;
const cancelled = () => ({ status: 'cancelled' });

function summarise(result) {
  if (result.status === 'found') return `${result.sqft} sq ft from ${result.source} (${result.confidence}%)`;
  if (result.status === 'error') return `error: ${result.message}`;
  if (result.status === 'needsOcr') return 'no stated size, moving to OCR lane';
  return result.status;
}

const byPriority = (a, b) => priorityOf(a.id) - priorityOf(b.id) || a.since - b.since;

class Lane {
  constructor(name, slots, colour, [queuedState, runningState]) {
    this.name = name;
    this.slots = slots;
    this.colour = colour;
    this.queuedState = queuedState;
    this.runningState = runningState;
    this.active = 0;
    this.waiting = []; // { id, since, resolve(go: boolean) }
    this.running = new Map(); // id -> { since, stage }
  }

  async run(id, fn) {
    const queuedAt = performance.now();
    if (this.active < this.slots) {
      this.active++;
    } else {
      moveTo(id, this.queuedState);
      // A finishing lookup hands its slot straight to us (go = true), or we're cancelled.
      const go = await new Promise((resolve) => {
        this.waiting.push({ id, since: queuedAt, resolve });
        this.log('queued', id, `position ${this.position(id)}, priority ${PRIORITY_NAMES[priorityOf(id)]}`);
      });
      if (!go) return cancelled();
    }
    moveTo(id, this.runningState);
    this.running.set(id, { since: performance.now(), stage: 'starting' });
    this.log('start', id, `waited ${secs(queuedAt)}, priority ${PRIORITY_NAMES[priorityOf(id)]}`);
    try {
      const result = await fn();
      this.log('done', id, `${summarise(result)} in ${secs(this.running.get(id).since)}`);
      return result;
    } catch (err) {
      this.log('failed', id, `${String(err?.message || err)} after ${secs(this.running.get(id).since)}`);
      throw err;
    } finally {
      this.running.delete(id);
      const next = this.takeNext();
      if (next) next.resolve(true);
      else this.active--;
    }
  }

  takeNext() {
    if (!this.waiting.length) return null;
    const next = [...this.waiting].sort(byPriority)[0];
    this.waiting.splice(this.waiting.indexOf(next), 1);
    return next;
  }

  ordered() {
    return [...this.waiting].sort(byPriority);
  }

  position(id) {
    return this.ordered().findIndex((w) => w.id === id) + 1;
  }

  has(id) {
    return this.waiting.some((w) => w.id === id);
  }

  cancel(id) {
    const entry = this.waiting.find((w) => w.id === id);
    if (!entry) return false;
    const position = this.position(id);
    this.waiting.splice(this.waiting.indexOf(entry), 1);
    entry.resolve(false);
    this.log('cancelled', id, `was position ${position}, waited ${secs(entry.since)}`);
    return true;
  }

  // Records which step a running lookup is on, so a slow one shows where it's stuck.
  setStage(id, stage) {
    const r = this.running.get(id);
    if (!r) return;
    r.stage = stage;
    this.log('  stage', id, `${stage} (${secs(r.since)} in)`);
  }

  snapshot() {
    return {
      running: [...this.running].map(([id, r]) => `${id} (${secs(r.since)}, ${r.stage})`),
      waiting: this.ordered().map((w) => `${w.id} (${PRIORITY_NAMES[priorityOf(w.id)]}, ${secs(w.since)})`),
    };
  }

  log(event, id, detail = '') {
    if (!globalThis.rmse.logging) return;
    const list = (ids) => (ids.length > 8 ? `${ids.slice(0, 8).join(', ')} +${ids.length - 8} more` : ids.join(', ') || '—');
    console.log(
      `%c[${this.name}]%c ${event} %c${id}%c${detail ? ` — ${detail}` : ''}   ` +
        `[running ${this.running.size}/${this.slots}: ${list([...this.running.keys()])} | ` +
        `waiting ${this.waiting.length}: ${list(this.ordered().map((w) => w.id))}]`,
      `color:${this.colour};font-weight:bold`,
      'font-weight:bold',
      'color:#2563eb',
      'color:inherit',
    );
  }
}

const fastLane = new Lane('fast', FAST_LANE_SLOTS, '#00a88f', ['fastQueued', 'fast']);
const ocrLane = new Lane('ocr', OCR_LANE_SLOTS, '#d97706', ['ocrQueued', 'ocr']);

globalThis.rmse = {
  logging: true,
  queue: () => ({ fast: fastLane.snapshot(), ocr: ocrLane.snapshot() }),
  lookups: () =>
    Object.fromEntries(
      [...lookups].map(([id, e]) => {
        const stage = (fastLane.running.get(id) ?? ocrLane.running.get(id))?.stage;
        const parts = [e.state, PRIORITY_NAMES[e.priority], e.cancelRequested && 'cancel requested', stage];
        return [id, parts.filter(Boolean).join(', ')];
      }),
    ),
};

function logEvent(event, id, detail) {
  if (globalThis.rmse.logging) console.log(`%c[queue]%c ${event} %c${id}%c — ${detail}`, 'color:#6b7280;font-weight:bold', 'font-weight:bold', 'color:#2563eb', 'color:inherit');
}

function setStage(id, stage) {
  fastLane.setStage(id, stage);
  ocrLane.setStage(id, stage);
}

// A change for a listing that isn't being looked up (it just settled) is dropped.
function setPriority(key, name) {
  const entry = lookups.get(key);
  if (!entry || !(name in PRIORITY)) return;
  // The property page someone is looking at stays first, whatever another tab's cards say.
  if (entry.priority === PRIORITY.page || entry.priority === PRIORITY[name]) return;
  entry.priority = PRIORITY[name];
  for (const lane of [fastLane, ocrLane]) {
    if (lane.has(key)) lane.log('priority', key, `now ${name}, position ${lane.position(key)}`);
  }
}

// Drops a lookup that hasn't started (e.g. the user hid that property). One in the fast
// lane is stopped before it reaches OCR; one already doing OCR is left to finish, and its
// result is cached like any other.
function cancelQueued(key) {
  if (fastLane.cancel(key) || ocrLane.cancel(key)) return true;
  if (fastLane.running.has(key)) {
    lookups.get(key).cancelRequested = true;
    logEvent('cancel', key, 'in fast lane now; will not continue to OCR');
    return true;
  }
  logEvent('cancel ignored', key, ocrLane.running.has(key) ? 'already doing OCR' : 'not queued');
  return false;
}

async function lookup(key, listing) {
  const quick = await fastLane.run(key, () => quickLookup(key, listing));
  if (quick.status !== 'needsOcr') return quick;
  if (lookups.get(key)?.cancelRequested) return cancelled();
  return ocrLane.run(key, () => ocrLookup(key, quick));
}

function getSize(listing, force, priority = 'nearby') {
  const key = listingKey(listing);
  const existing = lookups.get(key);
  if (existing) {
    logEvent('joined', key, `already being looked up (${existing.state})`);
    setPriority(key, priority);
    // A retry that arrives during the cache check must not be answered from the cache.
    if (force) existing.force = true;
    return existing.promise;
  }
  const entry = { listing, state: 'checkingCache', priority: PRIORITY[priority] ?? PRIORITY.nearby, force, cancelRequested: false };
  lookups.set(key, entry);
  entry.promise = cachedOrLookup(key, entry)
    .catch((err) => ({ status: 'error', message: String(err?.message || err) }))
    .finally(() => lookups.delete(key));
  return entry.promise;
}

function isFresh(cached) {
  const ttl = cached?.status === 'found' ? TTL_FOUND_MS : TTL_NONE_MS;
  return cached?.v === CACHE_VERSION && Date.now() - cached.ts < ttl;
}

async function cachedOrLookup(key, entry) {
  const cacheKey = CACHE_PREFIX + key;
  if (!entry.force) {
    const { [cacheKey]: cached } = await chrome.storage.local.get(cacheKey);
    if (!entry.force && isFresh(cached)) {
      logEvent('cache hit', key, summarise(cached));
      return cached;
    }
  }
  const result = await lookup(key, entry.listing).catch((err) => ({ status: 'error', message: String(err?.message || err) }));
  result.ts = Date.now();
  result.v = CACHE_VERSION;
  if (result.status !== 'error' && result.status !== 'cancelled') await chrome.storage.local.set({ [cacheKey]: result });
  return result;
}

// ---------------------------------------------------------------------------
// Search pages: sizes they already state, for every listing they show, from one read of
// the results the page embeds (`data`) or, failing that, of the site's search API. One
// request covers a whole map view. Read-only: it neither caches anything nor starts
// lookups, so a lookup stays the only thing that writes a listing's cache entry.

/** @returns {Promise<{ listing: object, lat: number|null, lng: number|null, result: object|null }[]>} */
async function searchSizes(pageUrl, data) {
  const site = siteForUrl(pageUrl);
  if (!site) return [];
  const json = data ?? (await fetchSearch(site, pageUrl));
  if (!json) return [];
  const entries = site.readSearch(json);
  const cacheKeys = entries.map((entry) => CACHE_PREFIX + listingKey(entry.listing));
  const cached = cacheKeys.length ? await chrome.storage.local.get(cacheKeys) : {};
  return entries.map(({ listing, lat, lng, displaySize }, i) => {
    const hit = cached[cacheKeys[i]];
    const stated = sizeFromDisplaySize(displaySize);
    return { listing, lat, lng, result: isFresh(hit) ? hit : stated ? found(stated, 'listing') : null };
  });
}

async function fetchSearch(site, pageUrl) {
  const url = site.searchApiUrl(pageUrl);
  if (!url) return null;
  logEvent('search', site.id, url);
  const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(TIMEOUTS.fetchMs) });
  if (!res.ok) throw new Error(`${site.name} search returned HTTP ${res.status}`);
  return res.json();
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  await chrome.storage.local.remove(keys);
  return { cleared: keys.length };
}

async function cacheStats() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith(CACHE_PREFIX));
  return {
    total: entries.length,
    found: entries.filter(([, v]) => v.status === 'found').length,
  };
}

// ---------------------------------------------------------------------------
// Lookup pipeline: Size section → description → floorplan totals → brochures
// → (last resort) estimate from the floorplan's room dimensions.

function found(size, source) {
  const { score, ...rest } = size;
  return {
    status: 'found',
    ...rest,
    confidence: size.confidence ?? confidenceFor(source, size),
    source,
    sourceLabel: SOURCE_LABELS[source],
  };
}

async function quickLookup(key, listing) {
  const site = SITES[listing.site];
  const settings = await getSettings();
  setStage(key, 'fetching property page');
  const res = await fetch(site.listingUrl(listing), {
    credentials: 'omit',
    signal: AbortSignal.timeout(TIMEOUTS.fetchMs),
  });
  if (!res.ok) throw new Error(`${site.name} returned HTTP ${res.status}`);

  const page = site.readListing(await res.text());
  if (!page) throw new Error('Could not read the property page');

  const fromListing = sizeFromSizings(page.sizings);
  if (fromListing) return found(fromListing, 'listing');

  const checked = ['size section', 'description', 'key features'];
  const fromText = sizeFromListingText(page.description, page.keyFeatures);
  if (fromText) return found(fromText.size, fromText.source);

  const hasOcrWork =
    (settings.ocrFloorplans && page.floorplans.length > 0) || (settings.scanBrochures && page.brochures.length > 0);
  if (!hasOcrWork) return { status: 'none', checked };

  return { status: 'needsOcr', site, page, settings, checked };
}

async function ocrLookup(key, { site, page, settings, checked }) {
  const budget = { deadline: performance.now() + TIMEOUTS.ocrLookupMs, timedOut: false };
  const floorplanTexts = []; // best OCR text per floorplan, kept for the room-size estimate
  if (settings.ocrFloorplans) {
    const toScan = page.floorplans.slice(0, MAX_FLOORPLANS);
    for (const [i, url] of toScan.entries()) {
      if (overBudget(key, budget)) break;
      checked.push('floorplan');
      try {
        const passes = [];
        for (const enhanced of [false, true]) {
          if (overBudget(key, budget)) break;
          setStage(key, `OCR floorplan ${i + 1}/${toScan.length}, ${enhanced ? 'enhanced' : 'first'} pass`);
          const ocrText = await offscreen('ocrImage', { url, enhanced });
          const size = findSize(ocrText);
          if (size) return found(size, 'floorplan');
          passes.push(ocrText);
        }
        if (passes.length) floorplanTexts.push(passes.sort((a, b) => readRooms(b).rooms.length - readRooms(a).rooms.length)[0]);
      } catch (err) {
        noteFailure(budget, err);
        console.warn('Floorplan OCR failed', key, url, err);
      }
    }
  }

  if (settings.scanBrochures && !overBudget(key, budget)) {
    const size = await searchBrochures(key, site, page.brochures, settings, checked, budget);
    if (size) return size;
  }

  if (floorplanTexts.length) {
    setStage(key, 'estimating from room sizes');
    const estimate = estimateFromRooms(floorplanTexts, { bedrooms: page.bedrooms });
    if (estimate) return found(estimate, 'roomEstimate');
  }

  // Not "none": something was left unread, so don't cache it; the badge offers a retry.
  if (budget.timedOut) return { status: 'error', message: 'Gave up: reading the floorplan or brochure took too long' };
  return { status: 'none', checked: [...new Set(checked)] };
}

function overBudget(key, budget) {
  if (performance.now() < budget.deadline) return false;
  if (!budget.timedOut) setStage(key, `stopping: OCR time limit (${TIMEOUTS.ocrLookupMs / 1000}s) reached`);
  budget.timedOut = true;
  return true;
}

function noteFailure(budget, err) {
  if (err?.name === 'TimeoutError' || /timed out/i.test(String(err?.message))) budget.timedOut = true;
}

// Brochures on the listing's own site are always read; others need the user's opt-in
// and Chrome's permission for that origin.
async function canFetchBrochure(url, site, settings) {
  if (site.matches(url)) return true;
  if (!settings.externalBrochures) return false;
  return chrome.permissions.contains({ origins: [`${url.origin}/*`] });
}

async function searchBrochures(key, site, brochures, settings, checked, budget) {
  const allowed = [];
  for (const link of brochures) {
    const url = safeExternalUrl(link);
    if (!url) {
      console.warn('Skipping brochure link that is not a public https URL', key, link);
      continue;
    }
    if (await canFetchBrochure(url, site, settings)) allowed.push(url);
  }
  // Brochures the site hosts first: they're the most likely to be the agent's particulars.
  allowed.sort((a, b) => site.matches(b) - site.matches(a));

  for (const url of allowed) {
    if (overBudget(key, budget)) break;
    checked.push('brochure');
    try {
      setStage(key, `reading brochure (${url.hostname})`);
      const doc = await offscreen('readDocument', { url: url.href });
      const size = findSize(doc.text);
      if (size) return found(size, 'brochure');

      if (doc.kind === 'pdf' && settings.ocrFloorplans) {
        // Floorplans are usually image-only and near the end of the particulars.
        const pages = [];
        for (let p = doc.numPages; p >= 1 && pages.length < MAX_BROCHURE_OCR_PAGES; p--) pages.push(p);
        for (const page of pages) {
          if (overBudget(key, budget)) break;
          setStage(key, `OCR brochure page ${page}/${doc.numPages}`);
          const ocrSize = findSize(await offscreen('ocrPdfPage', { url: url.href, page }));
          if (ocrSize) return found(ocrSize, 'brochureOcr');
        }
      }
    } catch (err) {
      noteFailure(budget, err);
      console.warn('Brochure scan failed', key, url.href, err);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Offscreen document (Tesseract OCR + pdf.js need a DOM and Web Workers)

let creatingOffscreen = null;
let offscreenIdleTimer = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: 'src/offscreen.html',
      reasons: ['WORKERS', 'DOM_PARSER', 'BLOBS'],
      justification: 'Read floorplan images and brochure PDFs to find the square footage',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function offscreen(op, args) {
  await ensureOffscreen();
  clearTimeout(offscreenIdleTimer);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${op} timed out after ${TIMEOUTS.offscreenMs / 1000}s`)),
      TIMEOUTS.offscreenMs,
    );
  });
  try {
    const reply = await Promise.race([chrome.runtime.sendMessage({ target: 'offscreen', op, ...args }), timeout]);
    if (!reply) throw new Error('No reply from offscreen document');
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  } catch (err) {
    if (/timed out/.test(err.message)) {
      // The OCR worker may be wedged; close the document so the next job gets a fresh one.
      logEvent('timeout', args?.url ?? op, `${err.message}; restarting the OCR engine`);
      await chrome.offscreen.closeDocument().catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(timer);
    offscreenIdleTimer = setTimeout(() => {
      if (ocrLane.active === 0) chrome.offscreen.closeDocument().catch(() => {});
    }, OFFSCREEN_IDLE_MS);
  }
}
