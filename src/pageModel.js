// Extracts `window.__PAGE_MODEL` from a Rightmove property page's HTML.
//
// Rightmove ships the model either as plain JSON ({ propertyData: ... }) or in a
// flattened form ({ encoding, data }) where `data` is a JSON array and every value
// is an index into that array (negative indices mean null/undefined).

function matchingBrace(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

function decodeFlat(table) {
  const memo = new Map();
  const resolve = (ref) => {
    if (typeof ref !== 'number') return ref;
    if (ref < 0) return null;
    if (memo.has(ref)) return memo.get(ref);

    const value = table[ref];
    if (Array.isArray(value)) {
      const out = [];
      memo.set(ref, out);
      for (const item of value) out.push(resolve(item));
      return out;
    }
    if (value && typeof value === 'object') {
      const out = {};
      memo.set(ref, out);
      for (const key of Object.keys(value)) out[key] = resolve(value[key]);
      return out;
    }
    return value;
  };
  return resolve(0);
}

export function extractPageModel(html) {
  const marker = html.indexOf('window.__PAGE_MODEL');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  const end = start < 0 ? -1 : matchingBrace(html, start);
  if (end < 0) return null;

  const raw = JSON.parse(html.slice(start, end + 1));
  if (raw.propertyData) return raw;
  if (typeof raw.data === 'string') return decodeFlat(JSON.parse(raw.data));
  return null;
}
