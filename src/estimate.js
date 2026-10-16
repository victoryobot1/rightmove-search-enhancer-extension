// Estimates total floor area from the room dimensions on a floorplan, for when the plan
// doesn't state a total. Works from OCR text, so it has to tolerate dropped decimal points
// ("534x413" = 5.34 × 4.13 m), lost quote marks on imperial twins ("176x137" = 17'6" × 13'7")
// and labels that come out on different lines from their dimensions.

import { SQFT_PER_SQM, isPlausibleSqft } from './extract.js';

const FT_TO_M = 0.3048;

// Room dimensions skip hallways, landings, stairs and internal walls.
const CIRCULATION_FACTOR = 1.12; // calibrated on 19 London floorplans with a stated total (median error ~11%)
const MULTI_FLOOR_EXTRA = 0.05; // stairs and landings on every floor
const MEASURED_HALL_DISCOUNT = 0.04; // the plan already measured some circulation space

const MIN_DIM_M = 0.7;
const MAX_DIM_M = 16;
const MIN_ROOM_M2 = 1;
const MAX_ROOM_M2 = 150;
const TWIN_TOLERANCE = 0.08;

// Rough typical sizes by bedroom count (sq ft), only used as a sense check on the estimate.
const TYPICAL_SQFT_BY_BEDROOMS = { 0: 400, 1: 520, 2: 760, 3: 1000, 4: 1350, 5: 1800 };

// Typical UK room sizes (m²), used when a room is labelled but its size is unreadable.
const TYPICAL_ROOM_M2 = [
  [/\b(en\s?suite|shower|bath\s?room|bathroom)\b/i, 4],
  [/\b(wc|cloak\s?room|cloaks)\b/i, 1.5],
  [/\bkitchen\b/i, 9],
  [/\b(living|lounge|reception|sitting|family)\b/i, 16],
  [/\bbed\s?room|\bbed\b/i, 10],
  [/\b(study|office)\b/i, 7],
  [/\butility\b/i, 4],
  [/\b(closet|store|storage|cupboard|wardrobe)\b/i, 1.5],
];

const ROOM_WORD_RE =
  /\b(bed\s?room|bed|kitchen|living|lounge|reception|dining|diner|bath\s?room|shower|en\s?suite|wc|cloak\s?room|utility|study|office|hall(way)?|landing|garage|store|storage|closet|dressing|conservatory|family|sitting|snug|play\s?room|loft|attic|cellar|basement|gym|pantry|breakfast|room)\b/i;
const OUTDOOR_RE = /\b(garden|terrace|balcony|patio|courtyard|decking|driveway|parking|roof|yard)\b/i;
const CIRCULATION_RE = /\b(hall(way)?|landing|entrance|lobby|corridor)\b/i;
const FLOOR_NAME_RE = /\b(ground|first|second|third|lower ground|upper|top|basement|1st|2nd|3rd)\s+floor\b/gi;
const BEDROOM_RE = /\bbed\s?room|\bbed\b|\bprimary\b|\bmaster\b/i;

const METRIC_NUM = String.raw`\d{1,2}[.,]\d{1,2}|\d{3,4}`;
const METRIC_PAIR_RE = new RegExp(String.raw`(?<![\d.,'"])(${METRIC_NUM})\s*m?\s*[xX×*]\s*(${METRIC_NUM})(\s*m\b)?(?![\d'"])`, 'g');
const IMPERIAL_PAIR_RE = /(\d{1,2})\s*['’′]\s*(\d{1,2})?\s*(?:["”″]|'')?\s*[xX×]\s*(\d{1,2})\s*['’′]\s*(\d{1,2})?/g;
const GARBLED_PAIR_RE = /\d\s*[xX×]\s*\d|\d\s*[xX×]\s*$|^\s*[xX×]\s*\d/;

function parseMetric(token) {
  if (/[.,]/.test(token)) return parseFloat(token.replace(',', '.'));
  return Number(token) / 100; // OCR dropped the decimal point
}

// "176" as feet-and-inches: 17'6". "511" could be 5'11".
function asFeetInches(token) {
  if (/[.,]/.test(token)) return null;
  const options = [];
  if (token.length === 3) {
    options.push(Number(token.slice(0, 2)) + Number(token.slice(2)) / 12);
    if (Number(token.slice(1)) < 12) options.push(Number(token[0]) + Number(token.slice(1)) / 12);
  } else if (token.length === 4 && Number(token.slice(2)) < 12) {
    options.push(Number(token.slice(0, 2)) + Number(token.slice(2)) / 12);
  }
  return options.map((ft) => ft * FT_TO_M);
}

const close = (a, b) => Math.abs(a - b) / Math.max(a, b) <= TWIN_TOLERANCE;

function sameRoom(pairA, pairB) {
  const [a1, a2] = pairA;
  return (close(a1, pairB[0]) && close(a2, pairB[1])) || (close(a1, pairB[1]) && close(a2, pairB[0]));
}

function plausibleRoom(w, l) {
  const area = w * l;
  return w >= MIN_DIM_M && l >= MIN_DIM_M && w <= MAX_DIM_M && l <= MAX_DIM_M && area >= MIN_ROOM_M2 && area <= MAX_ROOM_M2;
}

const fmt1 = (n) => n.toFixed(1);
const fmt2 = (n) => n.toFixed(2);
const fmtInt = (n) => Math.round(n).toLocaleString('en-GB');

/** Pulls room dimensions out of one floorplan's OCR text. */
export function readRooms(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const labels = []; // { line, text, used }
  const metric = []; // { line, dims: [w, l], raw, ambiguous: [w?, l?] as feet-inches options }
  const imperial = []; // { line, dims }
  let garbled = 0;

  lines.forEach((line, i) => {
    let matched = false;
    for (const m of line.matchAll(METRIC_PAIR_RE)) {
      const hasMarker = /[.,]/.test(m[1]) || /[.,]/.test(m[2]) || Boolean(m[3]);
      metric.push({
        line: i,
        dims: [parseMetric(m[1]), parseMetric(m[2])],
        raw: m[0].trim(),
        feetInches: hasMarker ? null : [asFeetInches(m[1]), asFeetInches(m[2])],
      });
      matched = true;
    }
    for (const m of line.matchAll(IMPERIAL_PAIR_RE)) {
      const ft = (f, inch) => (Number(f) + Number(inch || 0) / 12) * FT_TO_M;
      imperial.push({ line: i, dims: [ft(m[1], m[2]), ft(m[3], m[4])] });
      matched = true;
    }
    if (!matched && GARBLED_PAIR_RE.test(line)) garbled++;
    if (!matched && ROOM_WORD_RE.test(line) && line.length <= 40 && !/\d{2,}/.test(line)) {
      labels.push({ line: i, text: line.replace(/[^A-Za-z0-9 /&-]/g, '').replace(/\s+/g, ' ').trim(), used: false });
    }
  });

  // OCR splits multi-word labels ("Kitchen /" + "Dining Room") over consecutive lines.
  const merged = [];
  for (const label of labels) {
    const prev = merged.at(-1);
    if (prev && label.line === prev.lastLine + 1) {
      prev.text = `${prev.text} ${label.text}`.replace(/\s+/g, ' ');
      prev.lastLine = label.line;
    } else {
      merged.push({ ...label, lastLine: label.line });
    }
  }
  labels.length = 0;
  labels.push(...merged);

  // Drop imperial twins that OCR printed without quote marks (they parse as metric).
  const rooms = [];
  let twins = 0;
  for (const pair of metric) {
    const prev = rooms.slice(-2);
    const isTwin =
      pair.feetInches &&
      prev.some((r) => {
        const [opts1, opts2] = pair.feetInches;
        return opts1?.some((a) => opts2?.some((b) => sameRoom([a, b], r.dims)));
      });
    if (isTwin) {
      twins++;
      continue;
    }
    rooms.push({ ...pair, source: 'metric' });
  }

  // Explicit imperial pairs: a twin confirms a metric room; otherwise it's a room we
  // only have in feet (its metric line was unreadable).
  for (const imp of imperial) {
    const twin = rooms.find((r) => Math.abs(r.line - imp.line) <= 10 && sameRoom(r.dims, imp.dims));
    if (twin) {
      twin.confirmed = true;
      twins++;
    } else {
      rooms.push({ line: imp.line, dims: imp.dims, raw: null, source: 'imperial' });
    }
  }
  rooms.sort((a, b) => a.line - b.line);

  // Label each room with the nearest unused room name above it.
  for (const room of rooms) {
    const label = labels
      .filter((l) => !l.used && l.line <= room.line && room.line - l.lastLine <= 4)
      .sort((a, b) => b.line - a.line)[0];
    if (label) {
      label.used = true;
      room.label = label.text;
    }
    const context = lines.slice(Math.max(0, room.line - 2), room.line + 1).join(' ');
    room.outdoor = OUTDOOR_RE.test(room.label || '') || (!room.label && OUTDOOR_RE.test(context));
  }

  const floors = new Set((String(text).match(FLOOR_NAME_RE) || []).map((f) => f.toLowerCase().replace(/\s+/g, ' ')));
  const unmeasured = labels.filter((l) => !l.used && !OUTDOOR_RE.test(l.text) && !CIRCULATION_RE.test(l.text));
  return { rooms, unmeasured, twins, garbled, floors: floors.size };
}

/**
 * @param {string[]} texts OCR text of each floorplan image.
 * @param {{bedrooms?: number}} listing
 * @returns {null | {sqft, sqm, confidence, working: string[]}}
 */
export function estimateFromRooms(texts, { bedrooms } = {}) {
  // Several floorplan images can be separate floors, or the same plan uploaded twice.
  const plans = [];
  for (const text of texts) {
    const plan = readRooms(text);
    const dims = plan.rooms.map((r) => r.dims);
    const duplicate = plans.some(
      (p) => dims.length && dims.filter((d) => p.rooms.some((r) => sameRoom(r.dims, d))).length / dims.length > 0.7,
    );
    if (!duplicate) plans.push(plan);
  }

  const all = plans.flatMap((p) => p.rooms);
  const measured = all.filter((r) => !r.outdoor && plausibleRoom(...r.dims));
  const implausible = all.filter((r) => !r.outdoor && !plausibleRoom(...r.dims));
  const outdoor = all.filter((r) => r.outdoor);
  if (measured.length < 2) return null;

  const unmeasured = plans.flatMap((p) => p.unmeasured);
  const imputed = unmeasured
    .map((l) => ({ label: l.text, area: TYPICAL_ROOM_M2.find(([re]) => re.test(l.text))?.[1] }))
    .filter((r) => r.area);

  const measuredM2 = measured.reduce((sum, r) => sum + r.dims[0] * r.dims[1], 0);
  const imputedM2 = imputed.reduce((sum, r) => sum + r.area, 0);
  const roomsM2 = measuredM2 + imputedM2;

  const floors = Math.max(1, ...plans.map((p) => p.floors), plans.length);
  const hallMeasured = measured.some((r) => CIRCULATION_RE.test(r.label || ''));
  const factor = CIRCULATION_FACTOR + (floors > 1 ? MULTI_FLOOR_EXTRA : 0) - (hallMeasured ? MEASURED_HALL_DISCOUNT : 0);
  const totalM2 = roomsM2 * factor;
  const sqft = Math.round(totalM2 * SQFT_PER_SQM);
  if (!isPlausibleSqft(sqft)) return null;

  // ---- Confidence -------------------------------------------------------
  const reasons = [];
  let confidence = 35;
  const add = (points, why) => {
    if (!points) return;
    confidence += points;
    reasons.push(`${points > 0 ? '+' : '−'}${Math.abs(points)}  ${why}`);
  };

  const n = measured.length;
  add(n >= 6 ? 15 : n >= 4 ? 10 : n >= 3 ? 5 : 0, `${n} rooms measured`);

  const twins = plans.reduce((s, p) => s + p.twins, 0);
  if (twins >= Math.ceil(n / 2)) add(10, 'metric and imperial figures agree');

  const bedroomsFound = measured.filter((r) => BEDROOM_RE.test(r.label || '')).length;
  if (bedrooms > 0) {
    if (bedroomsFound >= bedrooms) add(10, bedrooms === 1 ? 'the bedroom is measured' : bedrooms === 2 ? 'both bedrooms measured' : `all ${bedrooms} bedrooms measured`);
    else add(-Math.min(25, 10 * (bedrooms - bedroomsFound)), `only ${bedroomsFound} of ${bedrooms} bedrooms measured`);
  }

  const labels = measured.map((r) => r.label || '').join(' ');
  if (/kitchen/i.test(labels)) add(5, 'kitchen measured');
  if (/living|lounge|reception|sitting|family/i.test(labels)) add(5, 'living space measured');

  if (imputed.length) add(-Math.min(18, 6 * imputed.length), `${imputed.length} room(s) labelled but unreadable — typical size assumed`);
  const unreadable = plans.reduce((s, p) => s + p.garbled, 0) + implausible.length;
  if (unreadable) add(-Math.min(12, 3 * unreadable), `${unreadable} dimension(s) unreadable or implausible`);

  if (bedrooms >= 0 && bedrooms !== null && bedrooms !== undefined) {
    const typical = TYPICAL_SQFT_BY_BEDROOMS[Math.min(5, bedrooms)];
    const ratio = sqft / typical;
    const label = `${bedrooms}-bed`;
    if (ratio < 0.65 || ratio > 1.6) add(-15, `far from a typical ${label} (~${fmtInt(typical)} sq ft)`);
    else if (ratio < 0.8 || ratio > 1.3) add(-5, `unusual for a typical ${label} (~${fmtInt(typical)} sq ft)`);
    else add(5, `in line with a typical ${label} (~${fmtInt(typical)} sq ft)`);
  }

  confidence = Math.max(10, Math.min(75, confidence));

  // ---- Working (shown in the tooltip) ------------------------------------
  const working = [`No total area on the floorplan, so this is estimated from its room sizes.`, '', 'Rooms measured:'];
  for (const r of measured) {
    const [w, l] = r.dims;
    const unit = r.source === 'imperial' ? ' (from feet)' : '';
    working.push(`• ${r.label || 'Unlabelled room'}: ${fmt2(w)} × ${fmt2(l)} m = ${fmt1(w * l)} m²${unit}`);
  }
  for (const r of imputed) working.push(`• ${r.label}: size unreadable, assumed ${r.area} m²`);
  for (const r of outdoor) working.push(`• ${r.label || 'Outdoor space'}: excluded (outdoor)`);
  for (const r of implausible) working.push(`• ${r.raw || 'Dimension'}: ignored (implausible reading)`);

  const factorWhy = [
    'hallways, stairs and walls',
    floors > 1 ? `${floors} floors` : null,
    hallMeasured ? 'some hall space already measured' : null,
  ]
    .filter(Boolean)
    .join('; ');
  working.push(
    '',
    `Rooms total: ${fmt1(roomsM2)} m² (${fmtInt(roomsM2 * SQFT_PER_SQM)} sq ft)`,
    `× ${factor.toFixed(2)} for ${factorWhy}`,
    `= ${fmt1(totalM2)} m² ≈ ${fmtInt(sqft)} sq ft`,
    '',
    `Confidence ${confidence}% (starts at 35%, capped at 75% for estimates):`,
    ...reasons.map((r) => `  ${r}`),
  );

  return { sqft, sqm: Math.round(totalM2), fromMetric: false, snippet: '', confidence, working };
}
