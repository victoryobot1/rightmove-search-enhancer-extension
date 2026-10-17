// Finds a property's total floor area in free text (descriptions, OCR output, brochure text).

export const SQFT_PER_SQM = 10.7639;

const MIN_SQFT = 100;
const MAX_SQFT = 50000;

// Agents sometimes put placeholders like "1 sq ft" in the Size field; treat those as missing.
export const isPlausibleSqft = (sqft) => sqft >= MIN_SQFT && sqft <= MAX_SQFT;

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,3}))?`;
// OCR often reads "²" as "2" or "?", and some floorplans write "217ft square".
// Agents also write "579 Sq'" (the foot mark standing in for "ft").
const FT_UNIT = String.raw`sq(?:uare)?[\s.]*f(?:ee|oo)?t\b\.?|ft[2²?](?!\d)|f(?:ee)?t\.?\s*sq(?:uare|\.)?\b|sq\.?\s*['’′](?!\s*\d)`;
const M_UNIT = String.raw`sq(?:uare)?[\s.]*m(?:etres?|eters?|trs?)?\b\.?|m[2²?](?!\d)|m(?:etres?)?\s*sq(?:uare|\.)?\b`;
const SIZE_RE = new RegExp(String.raw`(?<![\d.,])${NUM}\s*(?:(${FT_UNIT})|(${M_UNIT}))`, 'gi');

const TOTAL_RE = /\b(total|gross|internal|g\.?i\.?a|overall|in all|combined|entire|whole)\b/;
const HINT_RE = /\b(approx\w*|c\.|circa|extend\w*|measur\w*|offer\w*|provid\w*|compris\w*|floor ?area|living (space|area)|accommodation|size|footage|area|space)\b/;
const NOT_HOUSE_RE = /\b(garden|plot|land|grounds|site|terrace|balcony|patio|decking|garage|outbuilding|annexe?|shed|cabin|workshop|office|storage|store|planning|extension|commercial|retail|shop|warehouse|parking|driveway)\b/;
const ROOM_RE = /\b(bedroom|reception|kitchen|lounge|dining|bathroom|room)\b/;
// "One bedroom apartment (434 sq ft)" describes the whole property, not a single room.
const BEDROOM_COUNT_RE = /\b(\d+|one|two|three|four|five|six|seven|studio)[\s-]*(bed(room)?s?)\b/g;
const PROPERTY_RE = /\b(apartment|flat|house|home|property|maisonette|duplex|penthouse|cottage|bungalow|studio|townhouse|residence)\b/;
const SINGLE_FLOOR_RE = /\b(ground|first|second|third|lower|upper|top|basement)\s+floor\b/;
const EXCLUDING_RE = /\b(exclud\w*|excl\.?|not including)\b/;
const LIVING_AFTER_RE = /^\W*(of\s+)?(living|internal|accommodation|floor\s?space|interior)\b/;

const ENTITIES = { amp: '&', nbsp: ' ', sup2: '²', quot: '"', apos: "'", lt: '<', gt: '>', pound: '£' };

export function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-z0-9]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ');
}

function scoreCandidate(text, start, end) {
  const before = text.slice(Math.max(0, start - 80), start).toLowerCase();
  const nearBefore = before.slice(-40);
  const after = text.slice(end, end + 30).toLowerCase();

  let score = 0;
  if (TOTAL_RE.test(before)) score += 4;
  if (HINT_RE.test(nearBefore)) score += 2;
  if (PROPERTY_RE.test(nearBefore.slice(-30))) score += 2;
  if (LIVING_AFTER_RE.test(after)) return score + 3;

  if (NOT_HOUSE_RE.test(nearBefore.slice(-25))) score -= 4;
  if (NOT_HOUSE_RE.test(after.slice(0, 15)) && !EXCLUDING_RE.test(after)) score -= 4;
  if (ROOM_RE.test(nearBefore.slice(-25).replace(BEDROOM_COUNT_RE, ' '))) score -= 3;
  if (SINGLE_FLOOR_RE.test(nearBefore.slice(-30))) score -= 1;
  return score;
}

// "720 sq ft (67 sq m)" is one measurement written twice: keep the imperial figure,
// scored with the better context of the two.
function mergeUnitPairs(candidates) {
  const dropped = new Set();
  for (let i = 0; i < candidates.length - 1; i++) {
    const a = candidates[i];
    const b = candidates[i + 1];
    if (a.fromMetric === b.fromMetric || b.start - a.end > 12) continue;
    if (Math.abs(a.sqft - b.sqft) / Math.max(a.sqft, b.sqft) > 0.05) continue;
    const [keep, drop] = a.fromMetric ? [b, a] : [a, b];
    keep.score = Math.max(keep.score, drop.score + 0.5);
    dropped.add(drop);
  }
  return candidates.filter((c) => !dropped.has(c));
}

/**
 * Returns the most likely total floor area mentioned in `text`, or null.
 * @returns {{sqft:number, sqm:number, fromMetric:boolean, snippet:string} | null}
 */
export function findSize(text) {
  if (!text) return null;
  const candidates = [];

  for (const m of text.matchAll(SIZE_RE)) {
    const [whole, intPart, frac, ftUnit] = m;
    const isFt = Boolean(ftUnit);
    const digits = intPart.replace(/,/g, '');

    let value;
    if (isFt && frac?.length === 3 && digits.length <= 2) {
      // "1.373 sq ft" is almost always a misread (or continental) thousands separator.
      value = Number(digits + frac);
    } else {
      value = parseFloat(frac ? `${digits}.${frac}` : digits);
    }

    const sqft = isFt ? value : value * SQFT_PER_SQM;
    if (!isPlausibleSqft(sqft)) continue;

    const start = m.index;
    const end = start + whole.length;
    candidates.push({
      sqft,
      start,
      end,
      fromMetric: !isFt,
      // Prefer the agent's own imperial figure over a converted metric one.
      score: scoreCandidate(text, start, end) + (isFt ? 0.5 : 0),
      snippet: text.slice(Math.max(0, start - 50), end + 15).replace(/\s+/g, ' ').trim(),
    });
  }

  const ranked = mergeUnitPairs(candidates).sort((a, b) => b.score - a.score || b.sqft - a.sqft);
  const best = ranked[0];
  if (!best || best.score < -1) return null;

  return {
    sqft: Math.round(best.sqft),
    sqm: Math.round(best.sqft / SQFT_PER_SQM),
    fromMetric: best.fromMetric,
    snippet: best.snippet,
    score: best.score, // context score: higher means "total"/"gross internal" wording nearby
  };
}

/**
 * Searches a listing's description and each of its key features for the total area.
 * Each key feature is searched on its own: a bullet like "650 sq ft" must not pick up
 * context from the bullet before it (e.g. "Private garden").
 * @returns {{size: object, source: 'description' | 'keyFeatures'} | null}
 */
export function sizeFromListingText(descriptionHtml, keyFeatures = []) {
  const candidates = [];
  const fromDescription = findSize(htmlToText(descriptionHtml));
  if (fromDescription) candidates.push({ size: fromDescription, source: 'description' });
  for (const feature of keyFeatures) {
    const size = findSize(htmlToText(feature));
    if (size) candidates.push({ size, source: 'keyFeatures' });
  }
  // Best context wins; on a tie, prefer the key feature, a deliberate standalone statement.
  const isFeature = (c) => (c.source === 'keyFeatures' ? 1 : 0);
  candidates.sort((a, b) => b.size.score - a.size.score || isFeature(b) - isFeature(a));
  return candidates[0] ?? null;
}

/** Reads Rightmove's structured `sizings` array (the "Size" section on a listing). */
export function sizeFromSizings(sizings) {
  if (!Array.isArray(sizings)) return null;

  for (const [unit, factor] of [['sqft', 1], ['sqm', SQFT_PER_SQM]]) {
    const entry = sizings.find((s) => s?.unit === unit);
    const sqft = Math.round((entry?.minimumSize || 0) * factor);
    if (!isPlausibleSqft(sqft)) continue;

    const sqftMax = Math.round((entry.maximumSize || entry.minimumSize) * factor);
    return {
      sqft,
      sqftMax: sqftMax > sqft && isPlausibleSqft(sqftMax) ? sqftMax : undefined,
      sqm: Math.round(sqft / SQFT_PER_SQM),
      fromMetric: unit === 'sqm',
      snippet: '',
    };
  }
  return null;
}
