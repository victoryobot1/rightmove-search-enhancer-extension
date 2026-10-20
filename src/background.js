import { extractPageModel } from './pageModel.js';
import { findSize, sizeFromListingText, sizeFromSizings } from './extract.js';
import { estimateFromRooms, readRooms } from './estimate.js';
import { getSettings } from './settings.js';
import { isRightmoveUrl, safeExternalUrl } from './site.js';

const CACHE_PREFIX = 'size:';
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
// Toolbar icon: coloured on Rightmove, greyed out everywhere else (the manifest default).
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
  const active = isRightmoveUrl(url);
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
chrome.runtime.onInstalled.addListener(updateActionForAllTabs);
chrome.runtime.onStartup.addListener(updateActionForAllTabs);

// ---------------------------------------------------------------------------
// Messaging

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;

  if (msg?.type === 'getSize' && /^\d+$/.test(String(msg.id))) {
    getSize(String(msg.id), Boolean(msg.force), msg.priority).then(sendResponse);
    return true;
  }
  if (msg?.type === 'setPriority' && /^\d+$/.test(String(msg.id))) {
    setPriority(String(msg.id), msg.priority);
    return false;
  }
  if (msg?.type === 'cancelSize' && /^\d+$/.test(String(msg.id))) {
    sendResponse({ cancelled: cancelQueued(String(msg.id)) });
    return false;
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
// extension → "Inspect views: service worker". There, `rmse.queue()` prints a snapshot
// and `rmse.logging = false` silences it.

const PRIORITY = { page: 0, visible: 1, nearby: 2 };
const PRIORITY_NAMES = Object.keys(PRIORITY);
const priorities = new Map(); // id -> PRIORITY value, only while a lookup is in flight
// A priority change can arrive while getSize is still checking the cache, before the
// lookup is registered; hold it here so it isn't lost.
const pendingPriority = new Map();
const priorityOf = (id) => priorities.get(id) ?? PRIORITY.nearby;

const inFlight = new Map();
const skipOcr = new Set(); // cancelled while in the fast lane: don't continue to OCR

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
  constructor(name, slots, colour) {
    this.name = name;
    this.slots = slots;
    this.colour = colour;
    this.active = 0;
    this.waiting = []; // { id, since, resolve(go: boolean) }
    this.running = new Map(); // id -> { since, stage }
  }

  async run(id, fn) {
    const queuedAt = performance.now();
    if (this.active < this.slots) {
      this.active++;
    } else {
      // A finishing lookup hands its slot straight to us (go = true), or we're cancelled.
      const go = await new Promise((resolve) => {
        this.waiting.push({ id, since: queuedAt, resolve });
        this.log('queued', id, `position ${this.position(id)}, priority ${PRIORITY_NAMES[priorityOf(id)]}`);
      });
      if (!go) return cancelled();
    }
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

const fastLane = new Lane('fast', FAST_LANE_SLOTS, '#00a88f');
const ocrLane = new Lane('ocr', OCR_LANE_SLOTS, '#d97706');

globalThis.rmse = {
  logging: true,
  queue: () => ({ fast: fastLane.snapshot(), ocr: ocrLane.snapshot() }),
};

function logEvent(event, id, detail) {
  if (globalThis.rmse.logging) console.log(`%c[queue]%c ${event} %c${id}%c — ${detail}`, 'color:#6b7280;font-weight:bold', 'font-weight:bold', 'color:#2563eb', 'color:inherit');
}

function setStage(id, stage) {
  fastLane.setStage(id, stage);
  ocrLane.setStage(id, stage);
}

function setPriority(id, name) {
  if (!(name in PRIORITY)) return;
  if (!inFlight.has(id)) {
    pendingPriority.set(id, PRIORITY[name]);
    return;
  }
  const current = priorityOf(id);
  // The property page someone is looking at stays first, whatever another tab's cards say.
  if (current === PRIORITY.page || current === PRIORITY[name]) return;
  priorities.set(id, PRIORITY[name]);
  for (const lane of [fastLane, ocrLane]) {
    if (lane.has(id)) lane.log('priority', id, `now ${name}, position ${lane.position(id)}`);
  }
}

// Drops a lookup that hasn't started (e.g. the user hid that property). One in the fast
// lane is stopped before it reaches OCR; one already doing OCR is left to finish, and its
// result is cached like any other.
function cancelQueued(id) {
  if (fastLane.cancel(id) || ocrLane.cancel(id)) return true;
  if (fastLane.running.has(id)) {
    skipOcr.add(id);
    logEvent('cancel', id, 'in fast lane now; will not continue to OCR');
    return true;
  }
  logEvent('cancel ignored', id, ocrLane.running.has(id) ? 'already doing OCR' : 'not queued');
  return false;
}

async function lookup(id) {
  try {
    const quick = await fastLane.run(id, () => quickLookup(id));
    if (quick.status !== 'needsOcr') return quick;
    if (skipOcr.has(id)) return cancelled();
    return await ocrLane.run(id, () => ocrLookup(id, quick));
  } finally {
    skipOcr.delete(id);
  }
}

async function getSize(id, force, priority = 'nearby') {
  const key = CACHE_PREFIX + id;
  if (!force) {
    const { [key]: cached } = await chrome.storage.local.get(key);
    const ttl = cached?.status === 'found' ? TTL_FOUND_MS : TTL_NONE_MS;
    if (cached?.v === CACHE_VERSION && Date.now() - cached.ts < ttl) {
      pendingPriority.delete(id);
      logEvent('cache hit', id, summarise(cached));
      return cached;
    }
  }

  if (inFlight.has(id)) {
    logEvent('joined', id, 'already being looked up');
    setPriority(id, priority);
  } else {
    // A priority change that arrived during the cache check is newer than the request's.
    priorities.set(id, pendingPriority.get(id) ?? PRIORITY[priority] ?? PRIORITY.nearby);
    pendingPriority.delete(id);
    const promise = lookup(id)
      .catch((err) => ({ status: 'error', message: String(err?.message || err) }))
      .then(async (result) => {
        result.ts = Date.now();
        result.v = CACHE_VERSION;
        if (result.status !== 'error' && result.status !== 'cancelled') await chrome.storage.local.set({ [key]: result });
        return result;
      })
      .finally(() => {
        inFlight.delete(id);
        priorities.delete(id);
      });
    inFlight.set(id, promise);
  }
  return inFlight.get(id);
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

async function quickLookup(id) {
  const settings = await getSettings();
  setStage(id, 'fetching property page');
  const res = await fetch(`https://www.rightmove.co.uk/properties/${id}`, {
    credentials: 'omit',
    signal: AbortSignal.timeout(TIMEOUTS.fetchMs),
  });
  if (!res.ok) throw new Error(`Rightmove returned HTTP ${res.status}`);

  const model = extractPageModel(await res.text());
  const pd = model?.propertyData;
  if (!pd) throw new Error('Could not read the property page');

  const fromListing = sizeFromSizings(pd.sizings);
  if (fromListing) return found(fromListing, 'listing');

  const checked = ['size section', 'description', 'key features'];
  const fromText = sizeFromListingText(pd.text?.description, pd.keyFeatures || []);
  if (fromText) return found(fromText.size, fromText.source);

  const floorplans = (pd.floorplans || []).filter((f) => f?.url && (!f.type || f.type === 'IMAGE'));
  const hasOcrWork =
    (settings.ocrFloorplans && floorplans.length > 0) || (settings.scanBrochures && (pd.brochures || []).length > 0);
  if (!hasOcrWork) return { status: 'none', checked };

  return { status: 'needsOcr', pd, floorplans, settings, checked };
}

async function ocrLookup(id, { pd, floorplans, settings, checked }) {
  const budget = { deadline: performance.now() + TIMEOUTS.ocrLookupMs, timedOut: false };
  const floorplanTexts = []; // best OCR text per floorplan, kept for the room-size estimate
  if (settings.ocrFloorplans) {
    const toScan = floorplans.slice(0, MAX_FLOORPLANS);
    for (const [i, fp] of toScan.entries()) {
      if (overBudget(id, budget)) break;
      checked.push('floorplan');
      try {
        const passes = [];
        for (const enhanced of [false, true]) {
          if (overBudget(id, budget)) break;
          setStage(id, `OCR floorplan ${i + 1}/${toScan.length}, ${enhanced ? 'enhanced' : 'first'} pass`);
          const ocrText = await offscreen('ocrImage', { url: fp.url, enhanced });
          const size = findSize(ocrText);
          if (size) return found(size, 'floorplan');
          passes.push(ocrText);
        }
        if (passes.length) floorplanTexts.push(passes.sort((a, b) => readRooms(b).rooms.length - readRooms(a).rooms.length)[0]);
      } catch (err) {
        noteFailure(budget, err);
        console.warn('Floorplan OCR failed', id, fp.url, err);
      }
    }
  }

  if (settings.scanBrochures && !overBudget(id, budget)) {
    const size = await searchBrochures(id, pd.brochures || [], settings, checked, budget);
    if (size) return size;
  }

  if (floorplanTexts.length) {
    setStage(id, 'estimating from room sizes');
    const estimate = estimateFromRooms(floorplanTexts, { bedrooms: pd.bedrooms });
    if (estimate) return found(estimate, 'roomEstimate');
  }

  // Not "none": something was left unread, so don't cache it; the badge offers a retry.
  if (budget.timedOut) return { status: 'error', message: 'Gave up: reading the floorplan or brochure took too long' };
  return { status: 'none', checked: [...new Set(checked)] };
}

function overBudget(id, budget) {
  if (performance.now() < budget.deadline) return false;
  if (!budget.timedOut) setStage(id, `stopping: OCR time limit (${TIMEOUTS.ocrLookupMs / 1000}s) reached`);
  budget.timedOut = true;
  return true;
}

function noteFailure(budget, err) {
  if (err?.name === 'TimeoutError' || /timed out/i.test(String(err?.message))) budget.timedOut = true;
}

function isRightmoveHosted(url) {
  return /(^|\.)rightmove\.co\.uk$/i.test(url.hostname);
}

async function canFetchBrochure(url, settings) {
  if (isRightmoveHosted(url)) return true;
  if (!settings.externalBrochures) return false;
  return chrome.permissions.contains({ origins: [`${url.origin}/*`] });
}

async function searchBrochures(id, brochures, settings, checked, budget) {
  const allowed = [];
  for (const b of brochures) {
    const url = safeExternalUrl(b.url);
    if (!url) {
      console.warn('Skipping brochure link that is not a public https URL', id, b.url);
      continue;
    }
    if (await canFetchBrochure(url, settings)) allowed.push(url);
  }
  // Rightmove-hosted PDFs first: they're the most likely to be the agent's particulars.
  allowed.sort((a, b) => isRightmoveHosted(b) - isRightmoveHosted(a));

  for (const url of allowed) {
    if (overBudget(id, budget)) break;
    checked.push('brochure');
    try {
      setStage(id, `reading brochure (${url.hostname})`);
      const doc = await offscreen('readDocument', { url: url.href });
      const size = findSize(doc.text);
      if (size) return found(size, 'brochure');

      if (doc.kind === 'pdf' && settings.ocrFloorplans) {
        // Floorplans are usually image-only and near the end of the particulars.
        const pages = [];
        for (let p = doc.numPages; p >= 1 && pages.length < MAX_BROCHURE_OCR_PAGES; p--) pages.push(p);
        for (const page of pages) {
          if (overBudget(id, budget)) break;
          setStage(id, `OCR brochure page ${page}/${doc.numPages}`);
          const ocrSize = findSize(await offscreen('ocrPdfPage', { url: url.href, page }));
          if (ocrSize) return found(ocrSize, 'brochureOcr');
        }
      }
    } catch (err) {
      noteFailure(budget, err);
      console.warn('Brochure scan failed', id, url.href, err);
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
