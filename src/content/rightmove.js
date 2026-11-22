// Rightmove's track, content side: where sizes appear on rightmove.co.uk pages, for the
// engine in core.js. The background side (reading listings and searches) is src/sites/rightmove.js.
(() => {
  const listing = (id) => (id ? { site: 'rightmove', id } : null);
  const idFromLink = (link) => link?.getAttribute('href')?.match(/\/properties\/(\d+)/)?.[1] ?? null;

  // Search result cards are nested (propertyCard-N > propertyCard-vrt-N); use the outermost.
  const CARD = '[data-testid^="propertyCard-"]';
  function outermostCard(el) {
    let card = el.closest(CARD);
    while (card?.parentElement?.closest(CARD)) card = card.parentElement.closest(CARD);
    return card;
  }

  const listCard = {
    name: 'listCard',
    lookup: 'observed',
    lookahead: 1200,
    find() {
      const cards = new Set();
      for (const link of document.querySelectorAll('a[href*="/properties/"]')) {
        const card = outermostCard(link);
        if (card) cards.add(card);
      }
      return [...cards].map((card) => ({
        listing: listing(idFromLink(card.querySelector('a[href*="/properties/"]'))),
        el: card,
        mount:
          card.querySelector('[data-testid="property-information"]') ||
          card.querySelector('[data-testid="property-address"]')?.parentElement,
        price: RMSE.parseSalePrice(card.querySelector('[data-testid="property-price"]')?.textContent || ''),
      }));
    },
  };

  // Map view: the card that opens when a pin is clicked. A single listing's card is a
  // tooltip; a cluster's is a list with one item per listing. Opening one is the user
  // asking about it, so it's looked up as soon as it's on screen. The badge goes in the
  // card's last listing link, which holds its details.
  const MAP_CARD = '[role="tooltip"], ul[aria-label="Properties in this area"] > li';

  const mapCard = {
    name: 'mapCard',
    lookup: 'observed',
    lookahead: 0,
    find() {
      const linksByCard = new Map();
      for (const link of document.querySelectorAll('a[href*="/properties/"]')) {
        const card = link.closest(MAP_CARD);
        if (!card || link.closest(CARD)) continue; // search result cards belong to listCard
        linksByCard.set(card, [...(linksByCard.get(card) || []), link]);
      }
      return [...linksByCard].map(([card, links]) => ({
        listing: listing(idFromLink(links[0])),
        el: card,
        mount: links.at(-1),
        price: RMSE.parseSalePrice(card.textContent),
      }));
    },
    show: (target, result, view) => RMSE.placeBadge(target, view, 'rmse-size--card'),
  };

  // Map view: price pins. They have a position but no listing id, so the engine places
  // them using the page's search data. Clusters ("Cluster with 2 properties") have no
  // single listing and are left alone. The label hangs off the pin's plain wrapper,
  // because Rightmove's CSS already uses the pin's own ::before (hit area) and ::after
  // (pointer).
  const mapPin = {
    name: 'mapPin',
    lookup: 'displayOnly',
    find() {
      return [...document.querySelectorAll('gmp-advanced-marker [aria-label^="Price:"]')].flatMap((pin) => {
        const position = pin.closest('gmp-advanced-marker').getAttribute('position') || '';
        const [lat, lng] = position.split(',').map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !pin.parentElement) return [];
        return [{ at: { lat, lng }, el: pin.parentElement }];
      });
    },
    show: RMSE.showPinLabel,
  };

  // Property page (/properties/123): fill Rightmove's own SIZE slot in the key-facts strip.
  const PAGE_BADGE = 'rmse-size--page';
  const REPLACED_ATTR = 'data-rmse-replaced';

  const propertyPage = {
    name: 'propertyPage',
    lookup: 'page',
    find() {
      const id = location.pathname.match(/^\/properties\/(\d+)/)?.[1];
      if (!id) return [];
      const slot = document.querySelector('[data-testid="info-reel-SIZE-text"]')?.parentElement; // the <dd> under "SIZE"
      const priceBox = document.querySelector('[data-testid="primaryPrice"]');
      return [
        {
          listing: listing(id),
          el: document.body,
          mount: slot || priceBox?.parentElement,
          slot,
          price: RMSE.parseSalePrice(priceBox?.textContent || ''),
        },
      ];
    },
    show(target, result, view) {
      const { slot, price } = target;
      if (!target.mount) return;
      if (slot && result?.status === 'found' && result.source === 'listing') {
        // Rightmove already shows the agent's figure here; just add £/sq ft.
        slot.removeAttribute(REPLACED_ATTR);
        const perSqft = RMSE.pricePerSqft(price, result);
        if (!perSqft) return RMSE.removeBadge(target, PAGE_BADGE);
        view = { ...view, text: perSqft, pill: '' };
      } else if (slot) {
        // "Ask agent" (or an implausible agent figure): show ours in its place.
        slot.setAttribute(REPLACED_ATTR, '');
      }
      RMSE.placeBadge(target, view, PAGE_BADGE);
    },
  };

  RMSE.start({
    site: 'rightmove',
    surfaces: [propertyPage, listCard, mapCard, mapPin],

    // A hidden listing's card becomes a "You've hidden this property / Show" panel with no
    // link to the listing; its id only survives in the "why did you hide it?" questionnaire.
    hiddenListings() {
      return [...document.querySelectorAll('[data-testid="show-hidden-property"]')].flatMap((button) => {
        const el = outermostCard(button) || button.parentElement?.parentElement;
        if (!el) return [];
        const ref =
          el.querySelector('label[for^="hide-questionnaire-"]')?.getAttribute('for') ||
          el.querySelector('select[data-testid^="hide-questionnaire-"]')?.dataset.testid ||
          '';
        return [{ el, listing: listing(ref.match(/(\d+)$/)?.[1]) }];
      });
    },

    // Search pages (list and map) embed their results, including each listing's Size field.
    searchData() {
      try {
        return JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.searchResults ?? null;
      } catch {
        return null; // page structure changed: those listings are looked up as usual
      }
    },
  });
})();
