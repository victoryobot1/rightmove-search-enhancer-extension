# State machines

These are the extension's stateful lifecycles, written as state × event → next state, with the side effects of each transition. Read this before changing the lookup queue, the badges or hidden-property handling. If you change a transition, update its row here and its test.

**UNKNOWN** marks behaviour that can't be confirmed from the code alone, usually because it depends on Chrome or on Rightmove's markup. **Tests** points to the suite that pins a row.

## M1. Listing lookup: `background.js`, one record per property id

There's one record in `lookups` per listing being looked up: `{ state, priority, force, cancelRequested, promise }`. It's created synchronously on the first `getSize` and deleted when the lookup settles. `moveTo()` records each state change and warns (never throws) on a transition that isn't in `NEXT_STATES`. To inspect them, run `rmse.lookups()` in the service worker console.

```
(no record) ─getSize─▶ checkingCache ─miss─▶ fastQueued ─▶ fast ─needs OCR─▶ ocrQueued ─▶ ocr
                            │ hit                                │ found/none/error    │ found/none/error
                            ▼                                    ▼                     ▼
                       (no record)  ◀──────────── settled: cached unless error/cancelled
```

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| no record | `getSize`, cached entry fresh with the same `v`, not `force` | no record | one `storage.local.get`; log `cache hit`; reply with the cached result | queue |
| no record | `getSize`, miss, stale or `force` | checkingCache → fastQueued / fast | record created with the request's priority; log `queued` / `start` | queue |
| no record | `setPriority` | no record | dropped (the lookup has already settled) | queue |
| no record | `cancelSize` | no record | log `cancel ignored`; reply `{cancelled: false}` | — |
| checkingCache | `setPriority` | checkingCache | `record.priority` updated | queue |
| checkingCache / any running state | another `getSize` | unchanged | joins the same promise (no second storage read or fetch); priority raised; `force` is remembered so the cache isn't used | queue |
| fastQueued / ocrQueued | slot frees | fast / ocr | the lane picks page < visible < nearby, oldest first; log `start` | queue |
| fastQueued / ocrQueued | `setPriority` | unchanged, reordered | ignored if the record is `page`; log `priority` | queue |
| fastQueued / ocrQueued | `cancelSize` | settled (cancelled) | waiter dropped; log `cancelled`; not cached | queue |
| fast | — | fast | fetch the property page (10 s limit), decode `__PAGE_MODEL` | — |
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
| brochures (Rightmove-hosted first) | text gives a total | settled (found, brochure) | `offscreen('readDocument')` |
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

## M5. Card badge: `content.js`, per listing

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| unseen | card found by `renderAll` | shown, not requested ("Size…") | badge created; card observed by both IntersectionObservers | content |
| shown, not requested | card within 1200 px | requested | `getSize nearby` (or `visible`) | content |
| requested | card enters / leaves the screen | requested | `setPriority visible` / `nearby` | content |
| requested | reply found / none / error | found / none / error | badge redrawn | content |
| requested | reply `cancelled`, listing still shown in this tab | requested | `getSize` again (`page` on a property page) | content |
| requested | reply `cancelled`, card hidden in this tab | not requested | — (asked again if unhidden) | content |
| requested | card becomes a hidden panel | requested, cancel sent | `cancelSize` once | content |
| none / error | click the badge | requested | `getSize` with `force` | content |
| any | `enabled` turned off | off | badges removed; observers disconnected; late replies are stored but not drawn; no new lookups | content |
| off | `enabled` turned on | shown, not requested | badges redrawn; cards re-observed, so lookups start for cards not yet looked up | content |
| any | `unit` / `showPricePerSqft` changed | unchanged | badge text redrawn | — |
| (page load) | `__NEXT_DATA__` has `displaySize` | found | no fetch needed | — |

## M6. Property page SIZE slot: `renderPropertyPage`

| State | Event | Next state | Side effects |
|---|---|---|---|
| loading | found from the Size section, price known | agent's figure + £/sq ft badge | slot left as Rightmove's |
| loading | found from the Size section, no price | agent's figure only | page badge removed |
| loading | any other result | replaced | `data-rmse-replaced` on the slot; our badge shown |
| no SIZE slot | any | fallback | badge placed next to the price |

## M7. Hidden property: `markHiddenPanels` and `content.css`

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| normal card | hidden on Rightmove | hidden panel, marked | `data-rmse-hidden`; `display: none` while `collapseHidden` is on (applied within 250 ms) | content |
| hidden panel | `collapseHidden` turned off | shown | Rightmove's "Show" button usable again | content |
| hidden panel | unhidden on Rightmove | normal card | mark removed if the element is reused. **UNKNOWN** whether Rightmove reuses it | — |
| panel outside a `propertyCard-*` | — | marked via the grandparent fallback | **UNKNOWN** whether Rightmove's markup ever does this | — |

## M8. Cache entry: `chrome.storage.local` `size:<id>`

| State | Event | Next state | Side effects |
|---|---|---|---|
| missing | lookup settles found / none | fresh | written with `ts` and `v` |
| fresh | 14 days (found) / 1 day (none) pass, or `v ≠ CACHE_VERSION` | stale | the next `getSize` looks it up again and overwrites it |
| any | `clearCache` | missing | — |
| stale, never revisited | — | kept | **UNKNOWN** whether this ever approaches the 10 MB `storage.local` quota (no `unlimitedStorage`); room-estimate entries are the largest |

## M9. "Also read brochures on agents' websites": popup plus `background.js`

| State | Event | Next state | Side effects | Tests |
|---|---|---|---|---|
| off | ticked in the popup | on / off | `permissions.request`, then the setting is saved | — |
| on | unticked | off | `permissions.remove` | — |
| any | optional `https://*/*` permission granted | on | `background.js` sets `externalBrochures: true`. This covers the popup closing while Chrome's prompt is open (**UNKNOWN** whether that happens in current Chrome; this makes it safe either way) | queue |
| any | permission removed (popup or chrome://extensions) | off | `background.js` sets `externalBrochures: false` | queue |

Brochure fetching checks `permissions.contains` itself, so the setting can never grant access on its own.

## M10–M12. Small machines

- **Toolbar icon, per tab:** active ↔ inactive on a URL change, via `setIcon` / `setTitle`.
- **Popup view:** "unsupported" or "settings", depending on the active tab's URL.
- **Content script start-up:** starting (defaults, no MutationObserver) → running once `storage.sync` loads. Re-rendering is debounced idle ↔ scheduled (250 ms). `storage.onChanged` is registered before start-up finishes. A settings change in that window renders before the search-page sizes are seeded, so those cards are fetched instead (harmless).
