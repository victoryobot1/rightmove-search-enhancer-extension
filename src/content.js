// Adds total floor area (and £/sq ft) to Rightmove search results and property pages.
(() => {
  const SQFT_PER_SQM = 10.7639;
  // Same range as extract.js (content scripts can't import modules). Anything outside it,
  // like an agent's "1 sq ft" placeholder, is left for the background lookup to resolve.
  const MIN_SQFT = 100;
  const MAX_SQFT = 50000;
  const BADGE_CLASS = 'rmse-size';
  const DEFAULTS = { enabled: true, unit: 'sqft', showPricePerSqft: true, collapseHidden: true };

  let settings = { ...DEFAULTS };
  const results = new Map(); // property id -> result from background (or search-page JSON)
  const requested = new Set();
  const cardIds = new WeakMap();

  // -------------------------------------------------------------------------
  // Card discovery

  function propertyIdFromCard(card) {
    if (cardIds.has(card)) return cardIds.get(card);
    const link = card.querySelector('a[href*="/properties/"]');
    const id = link?.getAttribute('href').match(/\/properties\/(\d+)/)?.[1] ?? null;
    if (id) cardIds.set(card, id);
    return id;
  }

  const CARD_SELECTOR = '[data-testid^="propertyCard-"]';

  // Cards are nested (propertyCard-N > propertyCard-vrt-N); use the outermost.
  function outermostCard(el) {
    let card = el.closest(CARD_SELECTOR);
    while (card?.parentElement?.closest(CARD_SELECTOR)) card = card.parentElement.closest(CARD_SELECTOR);
    return card;
  }

  function findCards() {
    const cards = new Set();
    for (const link of document.querySelectorAll('a[href*="/properties/"]')) {
      const card = outermostCard(link);
      if (card) cards.add(card);
    }
    return [...cards];
  }

  // The first page of results ships with Rightmove's own `displaySize` when the agent
  // filled in the Size field, which saves a page fetch for those listings.
  function seedFromSearchJson() {
    try {
      const json = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null');
      for (const p of json?.props?.pageProps?.searchResults?.properties || []) {
        const sqft = parseDisplaySize(p.displaySize);
        if (sqft >= MIN_SQFT && sqft <= MAX_SQFT && !results.has(String(p.id))) {
          results.set(String(p.id), {
            status: 'found',
            sqft,
            sqm: Math.round(sqft / SQFT_PER_SQM),
            source: 'listing',
            sourceLabel: 'Size section',
            confidence: 97,
          });
        }
      }
    } catch {
      // Search page structure changed; every card will just be looked up instead.
    }
  }

  function parseDisplaySize(text) {
    const m = String(text || '').match(/([\d,]+(?:\.\d+)?)\s*sq\.?\s*(ft|m)/i);
    if (!m) return null;
    const value = parseFloat(m[1].replace(/,/g, ''));
    return Math.round(m[2].toLowerCase() === 'ft' ? value : value * SQFT_PER_SQM);
  }

  // -------------------------------------------------------------------------
  // Rendering

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

  const cardPrice = (card) => parseSalePrice(card.querySelector('[data-testid="property-price"]')?.textContent || '');
  const pagePrice = () => parseSalePrice(document.querySelector('[data-testid="primaryPrice"]')?.textContent || '');
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

  function mountPoint(card) {
    return (
      card.querySelector('[data-testid="property-information"]') ||
      card.querySelector('[data-testid="property-address"]')?.parentElement ||
      null
    );
  }

  // -------------------------------------------------------------------------
  // Hidden properties: Rightmove swaps the whole card for a "You've hidden this property /
  // Show" panel with no link to the listing, so findCards never sees it and it gets no
  // badge. We mark those panels so content.css can collapse them (the collapseHidden
  // setting), and cancel any lookup that was queued before the user hid the property.

  const HIDDEN_PANEL_BUTTON = '[data-testid="show-hidden-property"]';
  const HIDDEN_ATTR = 'data-rmse-hidden';
  const COLLAPSE_CLASS = 'rmse-collapse-hidden';
  const cancelSent = new Set();

  function hiddenPanels() {
    return [...document.querySelectorAll(HIDDEN_PANEL_BUTTON)].map(
      (button) => outermostCard(button) || button.parentElement?.parentElement,
    );
  }

  function markHiddenPanels() {
    const panels = new Set(hiddenPanels().filter(Boolean));
    // React may reuse the element when a property is unhidden; unmark it then.
    for (const el of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) if (!panels.has(el)) el.removeAttribute(HIDDEN_ATTR);
    for (const panel of panels) panel.setAttribute(HIDDEN_ATTR, '');
    document.documentElement.classList.toggle(COLLAPSE_CLASS, Boolean(settings.collapseHidden));
  }

  function hiddenPropertyIds() {
    const ids = new Set();
    for (const panel of hiddenPanels()) {
      // The listing id only survives in the "why did you hide it?" questionnaire.
      const ref =
        panel?.querySelector('label[for^="hide-questionnaire-"]')?.getAttribute('for') ||
        panel?.querySelector('select[data-testid^="hide-questionnaire-"]')?.dataset.testid ||
        '';
      const id = ref.match(/(\d+)$/)?.[1];
      if (id) ids.add(id);
    }
    return ids;
  }

  function cancelHiddenLookups() {
    for (const id of hiddenPropertyIds()) {
      if (!requested.has(id) || results.has(id) || cancelSent.has(id)) continue;
      // Still queued: dropped. Already running: left to finish, and the result is cached.
      cancelSent.add(id);
      chrome.runtime.sendMessage({ type: 'cancelSize', id }).catch(() => {});
    }
  }

  function createBadge(id, extraClass) {
    const badge = document.createElement('span');
    badge.className = extraClass ? `${BADGE_CLASS} ${extraClass}` : BADGE_CLASS;
    badge.dataset.id = id;
    badge.addEventListener('click', onBadgeClick);
    return badge;
  }

  function renderCard(card) {
    const id = propertyIdFromCard(card);
    const mount = id && mountPoint(card);
    if (!mount) return;

    let badge = card.querySelector(`.${BADGE_CLASS}`);
    if (!badge) {
      badge = createBadge(id);
      mount.appendChild(badge);
      visibility.observe(card);
      onScreen.observe(card);
    }
    badge.dataset.id = id;
    updateBadge(badge, badgeContent(results.get(id), cardPrice(card)));
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
    // Badge sits inside the card's link; don't navigate when retrying.
    event.preventDefault();
    event.stopPropagation();
    const id = badge.dataset.id;
    results.delete(id);
    requested.delete(id);
    request(id, true, 'visible');
  }

  // -------------------------------------------------------------------------
  // Property page (/properties/123): fill Rightmove's own SIZE slot in the key-facts strip.

  const PAGE_BADGE_CLASS = `${BADGE_CLASS}--page`;
  const REPLACED_ATTR = 'data-rmse-replaced';

  function propertyPageId() {
    return location.pathname.match(/^\/properties\/(\d+)/)?.[1] ?? null;
  }

  function renderPropertyPage() {
    const id = propertyPageId();
    if (!id) return;
    if (!results.has(id)) request(id, false, 'page');

    const sizeText = document.querySelector('[data-testid="info-reel-SIZE-text"]');
    const slot = sizeText?.parentElement; // the <dd> under "SIZE"
    const priceBox = document.querySelector('[data-testid="primaryPrice"]')?.parentElement;
    const mount = slot || priceBox;
    if (!mount) return;

    const r = results.get(id);
    const price = pagePrice();
    let content = badgeContent(r, price);

    if (slot && r?.status === 'found' && r.source === 'listing') {
      // Rightmove already shows the agent's figure here; just add £/sq ft.
      slot.removeAttribute(REPLACED_ATTR);
      const perSqft = pricePerSqft(price, r);
      if (!perSqft) return removePageBadge();
      content = { ...content, text: perSqft, pill: '' };
    } else if (slot) {
      // "Ask agent" (or an implausible agent figure): show ours in its place.
      slot.setAttribute(REPLACED_ATTR, '');
    }

    let badge = document.querySelector(`.${PAGE_BADGE_CLASS}`);
    if (!badge || badge.parentElement !== mount) {
      badge?.remove();
      badge = createBadge(id, PAGE_BADGE_CLASS);
      mount.appendChild(badge);
    }
    badge.dataset.id = id;
    updateBadge(badge, content);
  }

  function removePageBadge() {
    document.querySelector(`.${PAGE_BADGE_CLASS}`)?.remove();
  }

  function renderAll() {
    markHiddenPanels();
    if (!settings.enabled) return;
    findCards().forEach(renderCard);
    cancelHiddenLookups();
    renderPropertyPage();
  }

  function removeAll() {
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`[${REPLACED_ATTR}]`).forEach((el) => el.removeAttribute(REPLACED_ATTR));
  }

  // -------------------------------------------------------------------------
  // Fetching (only for cards near the viewport)

  // Cards within 1200px of the viewport are looked up ahead of time ("nearby" priority);
  // ones actually on screen jump ahead of them ("visible"), and drop back when scrolled off.
  const onScreenIds = new Set();

  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = propertyIdFromCard(entry.target);
        if (id && !results.has(id)) request(id, false, onScreenIds.has(id) ? 'visible' : 'nearby');
      }
    },
    { rootMargin: '1200px 0px' },
  );

  const onScreen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = propertyIdFromCard(entry.target);
      if (!id) continue;
      if (entry.isIntersecting) onScreenIds.add(id);
      else onScreenIds.delete(id);
      if (requested.has(id) && !results.has(id)) {
        const priority = entry.isIntersecting ? 'visible' : 'nearby';
        chrome.runtime.sendMessage({ type: 'setPriority', id, priority }).catch(() => {});
      }
    }
  });

  async function request(id, force, priority = 'nearby') {
    if (requested.has(id)) return;
    requested.add(id);
    cancelSent.delete(id);
    rerender(id);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'getSize', id, force, priority });
      if (result?.status === 'cancelled') {
        // Hidden while queued; forget it so unhiding the card requests it again.
        requested.delete(id);
        // Another tab's search page cancelled a lookup this property page still needs.
        if (propertyPageId() === id) request(id, false, 'page');
        return;
      }
      results.set(id, result || { status: 'error', message: 'No response' });
    } catch (err) {
      // Usually "Extension context invalidated" after the extension is reloaded.
      results.set(id, { status: 'error', message: String(err?.message || err) });
    }
    rerender(id);
  }

  function rerender(id) {
    for (const card of findCards()) if (propertyIdFromCard(card) === id) renderCard(card);
    if (propertyPageId() === id) renderPropertyPage();
  }

  // -------------------------------------------------------------------------
  // Boot: React re-renders and client-side pagination replace cards, so re-apply on DOM changes.

  let scheduled = false;
  const mutations = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      renderAll();
    }, 250);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = newValue ?? DEFAULTS[key];
    }
    if (settings.enabled) renderAll();
    else {
      removeAll();
      markHiddenPanels();
    }
  });

  chrome.storage.sync.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    seedFromSearchJson();
    renderAll();
    mutations.observe(document.body, { childList: true, subtree: true });
  });
})();
