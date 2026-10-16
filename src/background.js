import { extractPageModel } from './pageModel.js';
import { findSize, htmlToText, sizeFromSizings } from './extract.js';
import { estimateFromRooms, readRooms } from './estimate.js';
import { getSettings } from './settings.js';
import { isRightmoveUrl } from './site.js';

const CACHE_PREFIX = 'size:';
// Bump when extraction rules change so results cached by older versions are looked up again.
const CACHE_VERSION = 3;
const TTL_FOUND_MS = 14 * 24 * 60 * 60 * 1000;
const TTL_NONE_MS = 24 * 60 * 60 * 1000; // agents often add floorplans after listing
const MAX_CONCURRENT_LOOKUPS = 2;
const MAX_FLOORPLANS = 3;
const MAX_BROCHURE_OCR_PAGES = 4;
const OFFSCREEN_IDLE_MS = 90 * 1000;

const SOURCE_LABELS = {
  listing: 'Size section',
  description: 'Description',
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
    getSize(String(msg.id), Boolean(msg.force)).then(sendResponse);
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

const inFlight = new Map();
let activeLookups = 0;
const waiting = [];

async function withLookupSlot(fn) {
  while (activeLookups >= MAX_CONCURRENT_LOOKUPS) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  activeLookups++;
  try {
    return await fn();
  } finally {
    activeLookups--;
    waiting.shift()?.();
  }
}

async function getSize(id, force) {
  const key = CACHE_PREFIX + id;
  if (!force) {
    const { [key]: cached } = await chrome.storage.local.get(key);
    const ttl = cached?.status === 'found' ? TTL_FOUND_MS : TTL_NONE_MS;
    if (cached?.v === CACHE_VERSION && Date.now() - cached.ts < ttl) return cached;
  }

  if (!inFlight.has(id)) {
    const promise = withLookupSlot(() => lookup(id))
      .catch((err) => ({ status: 'error', message: String(err?.message || err) }))
      .then(async (result) => {
        result.ts = Date.now();
        result.v = CACHE_VERSION;
        if (result.status !== 'error') await chrome.storage.local.set({ [key]: result });
        return result;
      })
      .finally(() => inFlight.delete(id));
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

async function lookup(id) {
  const settings = await getSettings();
  const res = await fetch(`https://www.rightmove.co.uk/properties/${id}`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Rightmove returned HTTP ${res.status}`);

  const model = extractPageModel(await res.text());
  const pd = model?.propertyData;
  if (!pd) throw new Error('Could not read the property page');

  const fromListing = sizeFromSizings(pd.sizings);
  if (fromListing) return found(fromListing, 'listing');

  const checked = ['size section', 'description'];
  const text = [htmlToText(pd.text?.description), ...(pd.keyFeatures || [])].join('\n');
  const fromText = findSize(text);
  if (fromText) return found(fromText, 'description');

  const floorplanTexts = []; // best OCR text per floorplan, kept for the room-size estimate
  if (settings.ocrFloorplans) {
    const floorplans = (pd.floorplans || []).filter((f) => f?.url && (!f.type || f.type === 'IMAGE'));
    for (const fp of floorplans.slice(0, MAX_FLOORPLANS)) {
      checked.push('floorplan');
      try {
        const passes = [];
        for (const enhanced of [false, true]) {
          const ocrText = await offscreen('ocrImage', { url: fp.url, enhanced });
          const size = findSize(ocrText);
          if (size) return found(size, 'floorplan');
          passes.push(ocrText);
        }
        floorplanTexts.push(passes.sort((a, b) => readRooms(b).rooms.length - readRooms(a).rooms.length)[0]);
      } catch (err) {
        console.warn('Floorplan OCR failed', id, fp.url, err);
      }
    }
  }

  if (settings.scanBrochures) {
    const size = await searchBrochures(id, pd.brochures || [], settings, checked);
    if (size) return size;
  }

  if (floorplanTexts.length) {
    const estimate = estimateFromRooms(floorplanTexts, { bedrooms: pd.bedrooms });
    if (estimate) return found(estimate, 'roomEstimate');
  }

  return { status: 'none', checked: [...new Set(checked)] };
}

function isRightmoveHosted(url) {
  return /(^|\.)rightmove\.co\.uk$/i.test(url.hostname);
}

async function canFetchBrochure(url, settings) {
  if (isRightmoveHosted(url)) return true;
  if (!settings.externalBrochures) return false;
  return chrome.permissions.contains({ origins: [`${url.origin}/*`] });
}

async function searchBrochures(id, brochures, settings, checked) {
  const allowed = [];
  for (const b of brochures) {
    let url;
    try {
      url = new URL(b.url);
    } catch {
      continue;
    }
    if (await canFetchBrochure(url, settings)) allowed.push(url);
  }
  // Rightmove-hosted PDFs first: they're the most likely to be the agent's particulars.
  allowed.sort((a, b) => isRightmoveHosted(b) - isRightmoveHosted(a));

  for (const url of allowed) {
    checked.push('brochure');
    try {
      const doc = await offscreen('readDocument', { url: url.href });
      const size = findSize(doc.text);
      if (size) return found(size, 'brochure');

      if (doc.kind === 'pdf' && settings.ocrFloorplans) {
        // Floorplans are usually image-only and near the end of the particulars.
        const pages = [];
        for (let p = doc.numPages; p >= 1 && pages.length < MAX_BROCHURE_OCR_PAGES; p--) pages.push(p);
        for (const page of pages) {
          const ocrSize = findSize(await offscreen('ocrPdfPage', { url: url.href, page }));
          if (ocrSize) return found(ocrSize, 'brochureOcr');
        }
      }
    } catch (err) {
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
  try {
    const reply = await chrome.runtime.sendMessage({ target: 'offscreen', op, ...args });
    if (!reply) throw new Error('No reply from offscreen document');
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  } finally {
    offscreenIdleTimer = setTimeout(() => {
      if (activeLookups === 0) chrome.offscreen.closeDocument().catch(() => {});
    }, OFFSCREEN_IDLE_MS);
  }
}
