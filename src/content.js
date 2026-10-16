// Adds total floor area (and £/sq ft) to each card on Rightmove search results.
(() => {
  const SQFT_PER_SQM = 10.7639;
  // Same range as extract.js (content scripts can't import modules). Anything outside it,
  // like an agent's "1 sq ft" placeholder, is left for the background lookup to resolve.
  const MIN_SQFT = 100;
  const MAX_SQFT = 50000;
  const BADGE_CLASS = 'rmse-size';
  const DEFAULTS = { enabled: true, unit: 'sqft', showPricePerSqft: true };

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

  function findCards() {
    const cards = new Set();
    for (const link of document.querySelectorAll('a[href*="/properties/"]')) {
      // Cards are nested (propertyCard-N > propertyCard-vrt-N); use the outermost.
      let card = link.closest(CARD_SELECTOR);
      while (card?.parentElement?.closest(CARD_SELECTOR)) card = card.parentElement.closest(CARD_SELECTOR);
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

  function salePrice(card) {
    const text = card.querySelector('[data-testid="property-price"]')?.textContent || '';
    if (/pcm|pw|per\s+(week|month)/i.test(text)) return null; // rentals
    const m = text.match(/£\s?([\d,]+)/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  // Badge colour follows the confidence score.
  function confidenceBand(confidence) {
    if (confidence >= 85) return 'high';
    if (confidence >= 65) return 'medium';
    if (confidence >= 45) return 'low';
    return 'verylow';
  }

  function badgeContent(card, r) {
    if (!r) return { state: 'loading', text: 'Size…', title: 'Looking up floor area' };

    if (r.status === 'found') {
      const confidence = r.confidence ?? 97;
      const estimated = r.source === 'roomEstimate';
      const derived = r.source !== 'listing' || r.fromMetric;
      let text = `${estimated ? 'est. ' : derived ? '≈ ' : ''}${formatArea(r)}`;
      const price = settings.showPricePerSqft && salePrice(card);
      if (price) text += ` · £${fmt(price / r.sqft)}/sq ft`;

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

  function renderCard(card) {
    const id = propertyIdFromCard(card);
    const mount = id && mountPoint(card);
    if (!mount) return;

    let badge = card.querySelector(`.${BADGE_CLASS}`);
    if (!badge) {
      badge = document.createElement('span');
      badge.className = BADGE_CLASS;
      badge.addEventListener('click', onBadgeClick);
      mount.appendChild(badge);
      visibility.observe(card);
    }
    badge.dataset.id = id;

    const { state, band = '', text, pill = '', title } = badgeContent(card, results.get(id));
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
    request(id, true);
  }

  function renderAll() {
    if (!settings.enabled) return;
    findCards().forEach(renderCard);
  }

  function removeAll() {
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
  }

  // -------------------------------------------------------------------------
  // Fetching (only for cards near the viewport)

  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = propertyIdFromCard(entry.target);
        if (id && !results.has(id)) request(id, false);
      }
    },
    { rootMargin: '1200px 0px' },
  );

  async function request(id, force) {
    if (requested.has(id)) return;
    requested.add(id);
    rerender(id);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'getSize', id, force });
      results.set(id, result || { status: 'error', message: 'No response' });
    } catch (err) {
      // Usually "Extension context invalidated" after the extension is reloaded.
      results.set(id, { status: 'error', message: String(err?.message || err) });
    }
    rerender(id);
  }

  function rerender(id) {
    for (const card of findCards()) if (propertyIdFromCard(card) === id) renderCard(card);
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
    else removeAll();
  });

  chrome.storage.sync.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    seedFromSearchJson();
    renderAll();
    mutations.observe(document.body, { childList: true, subtree: true });
  });
})();
