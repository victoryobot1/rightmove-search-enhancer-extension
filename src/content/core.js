// The content-script engine: settings, badges, when to look sizes up, and listings the
// user hid. It knows no site's markup. Each site's track (src/content/<site>.js) describes
// where sizes appear on that site's pages and calls RMSE.start(track):
//
//   track = {
//     site,
//     surfaces: [...],     // in order: an element belongs to the first surface that finds it
//     hiddenListings(),    // → [{ el, listing }] for listings the user hid (listing may be null)
//     searchData(),        // the search results the page embeds, or null
//   }
//   surface = {
//     name,
//     lookup,              // when to ask the background for a size:
//                          //   'observed'    once the target is within `lookahead` px of the viewport
//                          //   'page'        at once, first in the queue (the listing's own page)
//                          //   'displayOnly' never; only show sizes already known
//     lookahead,           // px, for 'observed'
//     find(),              // → [{ listing, el, mount, price }] on the page now; a target
//                          //   with no listing id (a map pin) gives `at: { lat, lng }` instead,
//                          //   and the engine places it using the page's search data
//     show(target, result, view),  // optional; default: a badge appended to `mount`
//   }
//
// Per listing (see "M5" in docs/state-machines.md):
//   shown, not requested → requested (getSize sent) → found / none / error
//   none / error --click--> requested again (forced)
//   requested --cancelled--> not requested; asked again if a surface that looks sizes up
//                            still shows the listing
// While `enabled` is off nothing is requested or drawn, and the observers are disconnected
// so turning it back on starts lookups afresh.
globalThis.RMSE = (() => {
  const { listingKey } = globalThis;
  const SQFT_PER_SQM = 10.7639;
  const BADGE_CLASS = 'rmse-size';
  const REPLACED_ATTR = 'data-rmse-replaced';
  const HIDDEN_ATTR = 'data-rmse-hidden';
  const COLLAPSE_CLASS = 'rmse-collapse-hidden';
  const SIZE_ATTR = 'data-rmse-size'; // pin labels; content.css draws them
  const BAND_ATTR = 'data-rmse-band';
  // How long the first render waits for the sizes a search page already states, so cards
  // that have one aren't looked up for nothing.
  const SEED_WAIT_MS = 500;
  // Pins can change before the page's URL does; look again once, this long after.
  const PIN_RECHECK_MS = 1000;
  // Keep in step with DEFAULT_SETTINGS in settings.js (content scripts can't import it).
  const DEFAULTS = { enabled: true, unit: 'sqft', showPricePerSqft: true, collapseHidden: false };

  let settings = { ...DEFAULTS };
  let track = null;
  let seeded = false;
  const results = new Map(); // listing key -> result from the background
  const requested = new Set(); // listing keys sent to getSize
  const cancelSent = new Set();
  const badgeListings = new WeakMap(); // badge element -> its listing, for retry clicks

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

  // -------------------------------------------------------------------------
  // Formatting

  const fmt = (n) => Math.round(n).toLocaleString('en-GB');

  function formatArea(r) {
    const range = (a, b, unit) => (b ? `${fmt(a)}–${fmt(b)} ${unit}` : `${fmt(a)} ${unit}`);
    const ft = range(r.sqft, r.sqftMax, 'sq ft');
    const m = range(r.sqm, r.sqftMax && r.sqftMax / SQFT_PER_SQM, 'm²');
    if (settings.unit === 'sqm') return m;
    if (settings.unit === 'both') return `${ft} · ${m}`;
    return ft;
  }

  function parseSalePrice(text) {
    if (/pcm|pw|per\s+(week|month)/i.test(text)) return null; // rentals
    const m = String(text).match(/£\s?([\d,]+)/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  const pricePerSqft = (price, r) => (settings.showPricePerSqft && price ? `£${fmt(price / r.sqft)}/sq ft` : '');

  // Badge colour follows the confidence score.
  function confidenceBand(confidence) {
    if (confidence >= 85) return 'high';
    if (confidence >= 65) return 'medium';
    if (confidence >= 45) return 'low';
    return 'verylow';
  }

  function badgeContent(r, price) {
    if (!r) return { state: 'loading', text: 'Size…', title: 'Looking up floor area' };

    if (r.status === 'found') {
      const confidence = r.confidence ?? 97;
      const estimated = r.source === 'roomEstimate';
      const derived = r.source !== 'listing' || r.fromMetric;
      let text = `${estimated ? 'est. ' : derived ? '≈ ' : ''}${formatArea(r)}`;
      const perSqft = pricePerSqft(price, r);
      if (perSqft) text += ` · ${perSqft}`;

      let title;
      if (estimated) {
        title = `Estimated floor area — ${confidence}% confidence\n\n${(r.working || []).join('\n')}`;
      } else {
        title = `Source: ${r.sourceLabel}${r.fromMetric ? ' (converted from m²)' : ''}\nConfidence: ${confidence}%`;
        if (r.snippet) title += `\n“${r.snippet}”`;
      }
      return {
        state: 'found',
        band: confidenceBand(confidence),
        text,
        // Agent-stated sizes don't need a score on the badge; everything else shows it.
        pill: r.source === 'listing' ? '' : `${confidence}%`,
        title,
      };
    }

    if (r.status === 'none') {
      return {
        state: 'none',
        text: 'Size n/a',
        title: `No floor area found (checked: ${(r.checked || []).join(', ')}). Click to retry.`,
      };
    }
    return { state: 'error', text: 'Size ?', title: `Lookup failed: ${r.message}. Click to retry.` };
  }

  // -------------------------------------------------------------------------
  // Badges

  /** Draws `view` in the target's badge, creating it in `target.mount` if needed. */
  function placeBadge(target, view, extraClass) {
    if (!target.mount) return;
    let badge = target.el.querySelector(`.${extraClass || BADGE_CLASS}`);
    if (badge && badge.parentElement !== target.mount) {
      badge.remove();
      badge = null;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = extraClass ? `${BADGE_CLASS} ${extraClass}` : BADGE_CLASS;
      badge.addEventListener('click', onBadgeClick);
      target.mount.appendChild(badge);
    }
    badge.dataset.listing = target.key;
    badgeListings.set(badge, target.listing);
    updateBadge(badge, view);
  }

  function removeBadge(target, extraClass) {
    target.el.querySelector(`.${extraClass || BADGE_CLASS}`)?.remove();
  }

  const setAttr = (el, name, value) => el.getAttribute(name) !== value && el.setAttribute(name, value);

  // Map pins are small: a short label with the size only, drawn by content.css from
  // attributes, so the site re-rendering the pin doesn't remove it. Unknown sizes get none.
  function showPinLabel(target, result) {
    const { el } = target;
    if (result?.status !== 'found') {
      el.removeAttribute(SIZE_ATTR);
      el.removeAttribute(BAND_ATTR);
      return;
    }
    const estimated = result.source === 'roomEstimate';
    const derived = result.source !== 'listing' || result.fromMetric;
    const value = settings.unit === 'sqm' ? `${fmt(result.sqm)} m²` : `${fmt(result.sqft)} ft²`;
    setAttr(el, SIZE_ATTR, `${estimated ? 'est. ' : derived ? '≈' : ''}${value}`);
    setAttr(el, BAND_ATTR, confidenceBand(result.confidence ?? 97));
  }

  function updateBadge(badge, { state, band = '', text, pill = '', title }) {
    const key = `${state}|${band}|${text}|${pill}`;
    if (badge.dataset.key !== key) {
      badge.dataset.key = key;
      badge.dataset.state = state;
      badge.dataset.band = band;
      badge.textContent = text;
      if (pill) {
        const pillEl = document.createElement('span');
        pillEl.className = `${BADGE_CLASS}-confidence`;
        pillEl.textContent = pill;
        badge.appendChild(pillEl);
      }
    }
    if (badge.title !== title) badge.title = title;
  }

  function onBadgeClick(event) {
    const badge = event.currentTarget;
    if (badge.dataset.state !== 'none' && badge.dataset.state !== 'error') return;
    // Badges usually sit inside the listing's link; don't navigate when retrying.
    event.preventDefault();
    event.stopPropagation();
    const listing = badgeListings.get(badge);
    const key = listingKey(listing);
    results.delete(key);
    requested.delete(key);
    request(listing, true, 'visible');
  }

  // -------------------------------------------------------------------------
  // Listings the user hid on the site: marked so content.css can collapse them (the
  // collapseHidden setting), and any lookup still queued for them is cancelled.

  function markHidden() {
    const hidden = track.hiddenListings?.() ?? [];
    const els = new Set(hidden.map((h) => h.el));
    // The site may reuse the element when a listing is unhidden; unmark it then.
    for (const el of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) if (!els.has(el)) el.removeAttribute(HIDDEN_ATTR);
    for (const el of els) el.setAttribute(HIDDEN_ATTR, '');
    document.documentElement.classList.toggle(COLLAPSE_CLASS, Boolean(settings.collapseHidden));
    return hidden;
  }

  function cancelHiddenLookups(hidden) {
    for (const { listing } of hidden) {
      if (!listing) continue;
      const key = listingKey(listing);
      if (!requested.has(key) || results.has(key) || cancelSent.has(key)) continue;
      // Still queued: dropped. Already running: left to finish, and the result is cached.
      cancelSent.add(key);
      send({ type: 'cancelSize', listing });
    }
  }

  // -------------------------------------------------------------------------
  // Lookups

  // Observed targets within their surface's lookahead are looked up ahead of time
  // ("nearby" priority); ones actually on screen jump ahead ("visible"), and drop back
  // when they leave the screen.
  let observed = new WeakMap(); // element -> its latest target
  const onScreenKeys = new Set();
  const lookaheadObservers = new Map(); // lookahead px -> IntersectionObserver

  function lookaheadObserver(px) {
    if (!lookaheadObservers.has(px)) {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const target = observed.get(entry.target);
            if (!entry.isIntersecting || !target || results.has(target.key)) continue;
            const visible = px === 0 || onScreenKeys.has(target.key);
            request(target.listing, false, visible ? 'visible' : 'nearby');
          }
        },
        { rootMargin: `${px}px 0px` },
      );
      lookaheadObservers.set(px, observer);
    }
    return lookaheadObservers.get(px);
  }

  const onScreen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const target = observed.get(entry.target);
      if (!target) continue;
      if (entry.isIntersecting) onScreenKeys.add(target.key);
      else onScreenKeys.delete(target.key);
      if (requested.has(target.key) && !results.has(target.key)) {
        send({ type: 'setPriority', listing: target.listing, priority: entry.isIntersecting ? 'visible' : 'nearby' });
      }
    }
  });

  function schedule(target) {
    const { surface, el } = target;
    if (surface.lookup === 'page') {
      if (!results.has(target.key)) request(target.listing, false, 'page');
    } else if (surface.lookup === 'observed') {
      const isNew = !observed.has(el);
      observed.set(el, target);
      if (isNew) {
        lookaheadObserver(surface.lookahead ?? 0).observe(el);
        onScreen.observe(el);
      }
    }
  }

  async function request(listing, force, priority = 'nearby') {
    const key = listingKey(listing);
    if (!settings.enabled || requested.has(key)) return;
    requested.add(key);
    cancelSent.delete(key);
    rerender(key);
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: 'getSize', listing, force, priority });
    } catch (err) {
      // Usually "Extension context invalidated" after the extension is reloaded.
      result = { status: 'error', message: String(err?.message || err) };
    }
    if (result?.status === 'cancelled') {
      // Hidden while queued; forget it so unhiding the listing requests it again.
      requested.delete(key);
      // The cancel may have come from another tab that hid it. If a surface here that looks
      // sizes up still shows the listing, ask again (hidden panels aren't found by surfaces).
      const shown = targets().find((t) => t.key === key && t.surface.lookup !== 'displayOnly');
      if (shown) {
        const again = shown.surface.lookup === 'page' ? 'page' : onScreenKeys.has(key) ? 'visible' : 'nearby';
        request(listing, false, again);
      }
      return;
    }
    results.set(key, result || { status: 'error', message: 'No response' });
    rerender(key);
  }

  // -------------------------------------------------------------------------
  // Rendering

  // Everything the track's surfaces show right now. A target without a listing id (a map
  // pin) is placed by its position; one we can't place yet sends for the page's search data.
  function targets() {
    const claimed = new Set();
    const out = [];
    let unplaced = false;
    for (const surface of track.surfaces) {
      for (const target of surface.find()) {
        let { listing } = target;
        if (!listing && target.at) {
          listing = locations.get(coordKey(target.at));
          if (listing === undefined) unplaced = true;
        }
        if (!listing || claimed.has(target.el)) continue;
        claimed.add(target.el);
        out.push({ ...target, listing, surface, key: listingKey(listing) });
      }
    }
    if (unplaced) searchForPins();
    return out;
  }

  function draw(target) {
    const result = results.get(target.key);
    const view = badgeContent(result, target.price);
    if (target.surface.show) target.surface.show(target, result, view);
    else placeBadge(target, view);
  }

  // Listings that observed surfaces showed at the last render. Chrome doesn't tell an
  // IntersectionObserver when a target is removed, so a card that goes away (a map card
  // being closed, a page of results being replaced) is noticed here instead.
  let shown = new Map(); // listing key -> listing

  function renderAll() {
    const hidden = markHidden();
    if (!settings.enabled) return;
    const nowShown = new Map();
    for (const target of targets()) {
      draw(target);
      schedule(target);
      if (target.surface.lookup === 'observed') nowShown.set(target.key, target.listing);
    }
    for (const [key, listing] of shown) {
      if (nowShown.has(key) || !onScreenKeys.delete(key)) continue;
      if (requested.has(key) && !results.has(key)) send({ type: 'setPriority', listing, priority: 'nearby' });
    }
    shown = nowShown;
    cancelHiddenLookups(hidden);
  }

  function rerender(key) {
    if (!settings.enabled) return;
    for (const target of targets()) if (target.key === key) draw(target);
  }

  function removeAll() {
    // Re-observing an element later only fires a fresh intersection if it was unobserved first.
    for (const observer of lookaheadObservers.values()) observer.disconnect();
    onScreen.disconnect();
    onScreenKeys.clear();
    observed = new WeakMap();
    shown = new Map();
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`[${REPLACED_ATTR}]`).forEach((el) => el.removeAttribute(REPLACED_ATTR));
    for (const el of document.querySelectorAll(`[${SIZE_ATTR}]`)) {
      el.removeAttribute(SIZE_ATTR);
      el.removeAttribute(BAND_ATTR);
    }
  }

  // -------------------------------------------------------------------------
  // Sizes the page already states. Search pages embed their results; the background reads
  // them (one parser, there) and answers with any size each listing already has, so those
  // listings are never looked up. The answer also says where each listing is, which is
  // how map pins (a position, no id) are matched to listings.

  const locations = new Map(); // "lat,lng" -> listing, or null where several listings share a spot
  const coordKey = ({ lat, lng }) => `${lat.toFixed(6)},${lng.toFixed(6)}`;

  function learn(reply) {
    for (const { listing, lat, lng, result } of Array.isArray(reply) ? reply : []) {
      const key = listingKey(listing);
      if (result && !results.has(key)) results.set(key, result);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const at = coordKey({ lat, lng });
      const there = locations.get(at);
      locations.set(at, there === undefined || (there && listingKey(there) === key) ? listing : null);
    }
  }

  // Pins we can't place: ask the background for the page's search results. The map writes
  // its viewport into the URL as it moves, so once per URL is enough; one request at a time.
  let searchedUrl = null;
  let recheckedUrl = null;
  let searching = false;

  function searchForPins() {
    if (!settings.enabled || searching) return;
    if (location.href === searchedUrl) {
      if (recheckedUrl !== location.href) {
        recheckedUrl = location.href;
        setTimeout(renderAll, PIN_RECHECK_MS);
      }
      return;
    }
    searchedUrl = location.href;
    searching = true;
    (async () => {
      try {
        learn(await chrome.runtime.sendMessage({ type: 'searchSizes', pageUrl: searchedUrl }));
      } catch {
        // no answer: those pins stay unlabelled; their cards still look sizes up
      }
      searching = false;
      renderAll();
    })();
  }

  async function seed() {
    seeded = true;
    const data = track.searchData?.();
    if (!data) return;
    const answered = (async () => {
      try {
        learn(await chrome.runtime.sendMessage({ type: 'searchSizes', pageUrl: location.href, data }));
      } catch {
        return; // no answer: those listings are just looked up as usual
      }
      renderAll(); // in case it answered after the first render
    })();
    await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, SEED_WAIT_MS))]);
  }

  // -------------------------------------------------------------------------
  // Boot: React re-renders and client-side navigation replace elements, so re-apply on DOM changes.

  let scheduled = false;
  const mutations = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      renderAll();
    }, 250);
  });

  async function start(siteTrack) {
    track = siteTrack;
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'sync') return;
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (key in DEFAULTS) settings[key] = newValue ?? DEFAULTS[key];
      }
      if (!settings.enabled) {
        removeAll();
        markHidden();
        return;
      }
      if (!seeded) await seed();
      renderAll();
    });

    settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
    if (settings.enabled) await seed();
    renderAll();
    mutations.observe(document.body, { childList: true, subtree: true });
  }

  return { start, placeBadge, removeBadge, showPinLabel, pricePerSqft, parseSalePrice };
})();
