# State machines

These are the extension's stateful lifecycles, written as state × event → next state, with the side effects of each transition. Read this before changing the lookup queue, the badges, the map view or hidden-property handling. If you change a transition, update its row here and its test.

**UNKNOWN** marks behaviour that can't be confirmed from the code alone, usually because it depends on Chrome or on the site's markup. **Measured** marks behaviour checked in a real browser. **Tests** points to the suite that pins a row.

A **listing** is an object: the site it's on plus the fields that identify it there (`{ site: 'rightmove', id: '95556576' }`). `listingKey()` (src/shared/listing.js) turns it into the string used as a `Map` key and in the cache (`rightmove:95556576`).

## M1. Listing lookup: `background.js`, one record per listing

There's one record in `lookups` per listing being looked up, keyed by its listing key: `{ listing, state, priority, force, cancelRequested, promise }`. It's created synchronously on the first `getSize` and deleted when the lookup settles. `moveTo()` records each state change and warns (never throws) on a transition that isn't in `NEXT_STATES`. To inspect them, run `rmse.lookups()` in the service worker console.

```
(no record) ─getSize─▶ checkingCache ─miss─▶ fastQueued ─▶ fast ─needs OCR─▶ ocrQueued ─▶ ocr
                            │ hit                                │ found/none/error    │ found/none/error
                            ▼                                    ▼                     ▼
                       (no record)  ◀──────────── settled: cached unless error/cancelled
```

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| any | a message whose `listing` is malformed or on an unknown site | unchanged | ignored (`parseListing`): no reply, no fetch | queue |
| no record | `getSize`, cached entry fresh with the same `v`, not `force` | no record | one `storage.local.get`; log `cache hit`; reply with the cached result | queue |
| no record | `getSize`, miss, stale or `force` | checkingCache → fastQueued / fast | record created with the request's priority; log `queued` / `start` | queue |
| no record | `setPriority` | no record | dropped (the lookup has already settled) | queue |
| no record | `cancelSize` | no record | log `cancel ignored`; reply `{cancelled: false}` | — |
| checkingCache | `setPriority` | checkingCache | `record.priority` updated | queue |
| checkingCache / any running state | another `getSize` | unchanged | joins the same promise (no second storage read or fetch); priority raised; `force` is remembered so the cache isn't used | queue |
| fastQueued / ocrQueued | slot frees | fast / ocr | the lane picks page < visible < nearby, oldest first; log `start` | queue |
| fastQueued / ocrQueued | `setPriority` | unchanged, reordered | ignored if the record is `page`; log `priority` | queue |
| fastQueued / ocrQueued | `cancelSize` | settled (cancelled) | waiter dropped; log `cancelled`; not cached | queue |
| fast | — | fast | fetch the site's listing page (10 s limit); the site adapter's `readListing` reads it | site, queue |
| fast | Size section, description or key feature gives a size | settled (found) | cached for 14 days | queue |
| fast | no size and nothing to OCR | settled (none) | cached for 1 day | queue |
| fast | no size, floorplan or brochure to read | ocrQueued / ocr | — | queue |
| fast | HTTP error, timeout, unreadable page | settled (error) | not cached; the badge offers a retry | — |
| fast | `cancelSize` | fast, `cancelRequested` | reply `{cancelled: true}` | queue |
| fast, `cancelRequested` | needs OCR | settled (cancelled) | not cached. Other tabs that joined also get `cancelled` and re-request it themselves (M5) | queue, content |
| fast, `cancelRequested` | found / none | settled | cached as normal | — |
| ocr | `cancelSize` | ocr | ignored on purpose (the work is mostly done); log `already doing OCR` | — |
| ocr | see M3 | settled | see M3 | queue |
| settled | — | no record | `ts` and `v` stamped; written to the cache unless error or cancelled | queue |
| any | `clearCache` | unchanged | `size:*` keys removed; a lookup still in flight writes its result afterwards | — |

A lookup is the only thing that writes a listing's cache entry. `searchSizes` (M14) only reads.

## M2. Lane slots: the `Lane` class (fast lane 2 slots, OCR lane 1)

| State | Event | Next state | Side effects |
|---|---|---|---|
| free (`active < slots`) | `run` | free / full | `active++`; record → running state |
| full | `run` | full | added to `waiting`; record → queued state |
| full | job finishes, someone waiting | full | slot handed straight to the next waiter (`active` unchanged) |
| any | job finishes, nobody waiting | free | `active--` |
| waiting | cancelled | — | removed from `waiting`; the lookup settles as cancelled |

## M3. OCR stage of one lookup: `ocrLookup` and `searchBrochures`

There is a 30 s budget per lookup (`budget.deadline`) and a 15 s limit per offscreen job.

| State | Event | Next state | Side effects |
|---|---|---|---|
| floorplan *i*, normal pass | `findSize` finds a total | settled (found, floorplan) | — |
| floorplan *i*, normal pass | nothing | floorplan *i*, enhanced pass | `offscreen('ocrImage', {enhanced: true})` |
| floorplan *i*, enhanced pass | nothing | floorplan *i+1* (max 3), then brochures | the OCR text with the most rooms is kept for the estimate |
| floorplan pass | throws | next floorplan | a timeout sets `budget.timedOut` |
| brochures (on the listing's own site first) | text gives a total | settled (found, brochure) | `offscreen('readDocument')` |
| brochure PDF, no total in text | OCR of the last ≤4 pages gives a total | settled (found, brochureOcr) | `offscreen('ocrPdfPage')` |
| any | budget used up | stop reading | `budget.timedOut = true` |
| sources done | floorplan text with room sizes | settled (found, roomEstimate) | — |
| sources done | `timedOut` | settled (error "Gave up…") | not cached, so it retries next time |
| sources done | otherwise | settled (none) | cached for 1 day |

## M4. Offscreen document and OCR engine: `ensureOffscreen` / `offscreen()` in `background.js`, plus `offscreen.js`

| State | Event | Next state | Side effects |
|---|---|---|---|
| absent | `offscreen(op)` | creating → ready | `createDocument`; concurrent callers share one creation |
| ready | job replies | ready | 90 s idle timer restarted |
| ready | job takes over 15 s | absent | `closeDocument()` (restarts the OCR engine); log `timeout` |
| ready | idle timer, OCR lane idle | absent | `closeDocument()` |
| ready | idle timer, OCR lane busy | ready | — |
| closing | new job before the close completes | **UNKNOWN** | `getContexts` might still list the closing document, giving "No reply". Unlikely: both paths depend on the single OCR slot being idle or timed out |
| Tesseract worker: none | first OCR job | creating → ready | on failure back to none, so the next job retries |
| PDF cache (2) | a third PDF opened | 2 | the oldest is destroyed |

## M5. Lookups from a page: `content/core.js`, per listing

Each site's track (`content/<site>.js`) lists **surfaces**, the places a size can appear. Each surface says when the engine should look a size up:

| Surface (Rightmove) | Lookup mode | Means |
|---|---|---|
| listCard (search results) | `observed`, lookahead 1200 px | `getSize nearby` once within 1200 px of the viewport, `visible` while on screen |
| mapCard (the card a map pin opens) | `observed`, lookahead 0 | `getSize visible` as soon as it's on screen; opening a card is the user asking |
| propertyPage | `page` | `getSize page` at once |
| mapPin | `displayOnly` | never looks up; shows sizes already known (M13) |

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| unseen | a surface finds the listing | shown, not requested ("Size…") | badge drawn; `observed` targets watched by two IntersectionObservers | content |
| shown, not requested | target within its lookahead (or a `page` target) | requested | `getSize` (priority per the table above) | content |
| requested | target enters / leaves the screen | requested | `setPriority visible` / `nearby` | content |
| requested | every observed target for the listing has left the page (a map card closed, a page of results replaced) | requested | `setPriority nearby`. **Measured** (Chrome 157): IntersectionObserver sends nothing when a target is removed, so the engine compares what it rendered last time | content |
| requested | reply found / none / error | found / none / error | badge (and pin label, M13) redrawn | content |
| requested | reply `cancelled`, a surface that looks sizes up still shows the listing | requested | `getSize` again (`page` on a property page) | content |
| requested | reply `cancelled`, only a pin (or nothing) shows it | not requested | — (asked again if a card or result shows it later) | content |
| requested | the listing's card becomes a hidden panel | requested, cancel sent | `cancelSize` once | content |
| none / error | click the badge | requested | `getSize` with `force` | content |
| (page load) | the page's embedded search results state its size (M14) | found | no lookup | content, search |
| any | `enabled` turned off | off | badges and pin labels removed; observers disconnected; late replies are stored but not drawn; no new lookups or searches | content |
| off | `enabled` turned on | shown, not requested | badges and labels redrawn; targets re-observed, so lookups start for listings not yet looked up | content |
| any | `unit` / `showPricePerSqft` changed | unchanged | badge and label text redrawn | — |

An element belongs to the first surface (in the track's order) that finds it, so no element gets two badges.

## M6. Property page SIZE slot: the `propertyPage` surface's `show`

| State | Event | Next state | Side effects |
|---|---|---|---|
| loading | found from the Size section, price known | agent's figure + £/sq ft badge | slot left as Rightmove's |
| loading | found from the Size section, no price | agent's figure only | page badge removed |
| loading | any other result | replaced | `data-rmse-replaced` on the slot; our badge shown |
| no SIZE slot | any | fallback | badge placed next to the price |

## M7. Hidden property: the track's `hiddenListings()`, the engine's `markHidden`, and `content.css`

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| normal card | hidden on Rightmove | hidden panel, marked | `data-rmse-hidden`; `display: none` while `collapseHidden` is on (applied within 250 ms; off by default) | content |
| hidden panel | `collapseHidden` turned off | shown | Rightmove's "Show" button usable again | content |
| hidden panel | unhidden on Rightmove | normal card | mark removed if the element is reused. **UNKNOWN** whether Rightmove reuses it | — |
| panel outside a `propertyCard-*` | — | marked via the grandparent fallback | **UNKNOWN** whether Rightmove's markup ever does this | — |

## M8. Cache entry: `chrome.storage.local` `size:<listing key>`

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| missing | lookup settles found / none | fresh | written with `ts` and `v` | queue |
| fresh | 14 days (found) / 1 day (none) pass, or `v ≠ CACHE_VERSION` | stale | the next `getSize` looks it up again and overwrites it | search |
| any | `clearCache` | missing | — | — |
| old format (`size:<id>`, before listings had a site) | the extension installs or updates | deleted | never read again, so removed rather than renamed | queue |
| stale, never revisited | — | kept | **UNKNOWN** whether this ever approaches the 10 MB `storage.local` quota (no `unlimitedStorage`); room-estimate entries are the largest | — |

## M9. "Also read brochures on agents' websites": popup plus `background.js`

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| off | ticked in the popup | on / off | `permissions.request`, then the setting is saved | — |
| on | unticked | off | `permissions.remove` | — |
| any | optional `https://*/*` permission granted | on | `background.js` sets `externalBrochures: true`. This covers the popup closing while Chrome's prompt is open (**UNKNOWN** whether that happens in current Chrome; this makes it safe either way) | queue |
| any | permission removed (popup or chrome://extensions) | off | `background.js` sets `externalBrochures: false` | queue |

Brochure fetching checks `permissions.contains` itself, so the setting can never grant access on its own. Brochures on the listing's own site need no permission.

## M10–M12. Small machines

- **Toolbar icon, per tab:** active on any site in the registry (`siteForUrl`), inactive elsewhere, updated on a URL change via `setIcon` / `setTitle`.
- **Popup view:** "unsupported" or "settings", depending on whether the active tab's URL is on a supported site.
- **Content script start-up:** settings load → if enabled, send the page's embedded search results (M14) and wait up to 500 ms for the answer → first render → watch the DOM (re-rendering debounced idle ↔ scheduled, 250 ms). An answer after 500 ms still applies; the listings it covers just may have been requested already. If the extension starts disabled, the same send happens when it's turned on.

## M13. Map pins: `content/core.js` with the `mapPin` surface, per pin

A pin has a position but no listing id. The engine keeps `locations`, a map from `"lat,lng"` (6 decimals) to a listing, filled from search results (M14). All 89 price pins on a real map view matched exactly one listing this way (**measured**).

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| unplaced (position not in `locations`) | render | unplaced | asks for search results for the page's URL (M14) | content |
| unplaced | search results include its position | placed | — | content |
| unplaced | search results don't include it | unplaced | never searched for again at this URL | content |
| any | two listings share the position | ambiguous | no label; their cards still work | content |
| placed, size unknown | — | placed | no label (no "n/a" on pins) | content |
| placed | the listing's size becomes known (search results, or a lookup started by its card) | labelled | `data-rmse-size` / `data-rmse-band` on the pin's wrapper; content.css draws the label | content |
| labelled | Rightmove re-renders the pin | labelled | the next render sets the attributes again | — |
| labelled | `enabled` turned off | placed | attributes removed | content |

Clusters ("Cluster with 2 properties") have no single listing and are left alone. Opening one lists its listings as cards (M5, mapCard).

## M14. Search results: `searchSizes`, from `content/core.js` to `background.js`

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| idle | start-up, page embeds search results (list or map) | answered | sends them as `data`; the background reads them with the site's `readSearch` (no network) | content, search |
| idle | unplaced pins, `location.href` not searched yet | searching | `searchSizes { pageUrl }`: the background fetches the site's search API for that URL (`searchApiUrl`; on Rightmove, map pages only). One request covers a whole map view: 73–86 KB, 0.24–0.33 s (**measured**, 6 runs) | content, search |
| searching | more unplaced pins | searching | nothing (one request at a time) | content |
| searching | answer | idle | `results` and `locations` filled; re-render | content |
| idle | unplaced pins, same URL already searched | idle | one re-render 1 s later, in case the pins changed before the URL did | content |
| any | `enabled` off | — | no searches | content |

The background answers each listing with a fresh cache entry, else the size it states (`displaySize`), else `null`. It writes nothing and starts no lookups. Sizes stated only in the `summary` text are ignored: they added 6 pins of 383 measured, and the 300-character cut can lose the total and leave a single floor's figure.
