// A minimal test API. A test passes unless it throws; returning a string attaches a note
// to the result (e.g. a measured error rate).

export const realFetch = fetch.bind(globalThis);

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export async function runAll() {
  const results = [];
  for (const { name, fn } of tests) {
    try {
      const note = await fn();
      results.push({ name, ok: true, note: typeof note === 'string' ? note : undefined });
    } catch (err) {
      results.push({ name, ok: false, error: String(err?.message || err) });
    }
  }
  return results;
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function equal(actual, expected, label = 'value') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export async function fixture(name) {
  const res = await realFetch(`/tests/fixtures/${name}`);
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
  return name.endsWith('.json') ? res.json() : res.text();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
