// Safety checks in the real offscreen document: who may send it work, download size
// caps, and brochure redirects. Downloads are simulated; no OCR runs here.
import { test, equal, assert } from '../lib/t.js';

const EXTENSION_ID = 'test-extension';
const MB = 1024 * 1024;

let listener;
globalThis.chrome = {
  runtime: { id: EXTENSION_ID, getURL: (p) => `${location.origin}/${p}`, onMessage: { addListener(fn) { listener = fn; } } },
};

// Each test sets `nextResponse` to whatever the next download should return.
let nextResponse;
let streamCancelled = false;
globalThis.fetch = async () => nextResponse();

await import('/src/offscreen.js');

const fromExtension = { id: EXTENSION_ID };
const send = (msg, sender = fromExtension) =>
  new Promise((resolve) => {
    if (!listener({ target: 'offscreen', ...msg }, sender, resolve)) resolve('ignored');
  });

function response(body, { headers = {}, url = 'https://agent.example.com/brochure' } = {}) {
  const res = new Response(body, { status: 200, headers });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

// A body that streams `totalMb` of data without announcing its size.
function endlessStream(totalMb) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalMb) return controller.close();
      sent++;
      controller.enqueue(new Uint8Array(MB));
    },
    cancel() {
      streamCancelled = true;
    },
  });
}

test('ignores work sent from a tab (a content script)', async () => {
  nextResponse = () => response('<p>720 sq ft</p>', { headers: { 'content-type': 'text/html' } });
  equal(await send({ op: 'readDocument', url: 'https://agent.example.com/b' }, { id: EXTENSION_ID, tab: { id: 1 } }), 'ignored');
});

test('ignores work sent by another extension', async () => {
  equal(await send({ op: 'readDocument', url: 'https://agent.example.com/b' }, { id: 'someone-else' }), 'ignored');
});

test('reads a normal brochure web page', async () => {
  nextResponse = () => response('<html><body><p>Approx 720 sq ft</p><script>bad()</script></body></html>', { headers: { 'content-type': 'text/html' } });
  const reply = await send({ op: 'readDocument', url: 'https://agent.example.com/b' });
  equal(reply.result?.kind, 'html', 'kind');
  assert(reply.result.text.includes('720 sq ft') && !reply.result.text.includes('bad()'), reply.result.text);
});

test('refuses a brochure whose stated size is over 30 MB', async () => {
  nextResponse = () => response('x', { headers: { 'content-type': 'application/pdf', 'content-length': String(31 * MB) } });
  const reply = await send({ op: 'readDocument', url: 'https://agent.example.com/b' });
  assert(/too large/i.test(reply.error), `reply: ${JSON.stringify(reply)}`);
});

test('stops a brochure download that passes 30 MB without stating its size', async () => {
  streamCancelled = false;
  nextResponse = () => response(endlessStream(40), { headers: { 'content-type': 'application/pdf' } });
  const reply = await send({ op: 'readDocument', url: 'https://agent.example.com/b' });
  assert(/too large/i.test(reply.error), `reply: ${JSON.stringify(reply)}`);
  equal(streamCancelled, true, 'download cancelled');
});

test('stops a floorplan image download that passes 15 MB', async () => {
  nextResponse = () => response(endlessStream(20), { headers: { 'content-type': 'image/jpeg' }, url: 'https://media.rightmove.co.uk/fp.jpg' });
  const reply = await send({ op: 'ocrImage', url: 'https://media.rightmove.co.uk/fp.jpg' });
  assert(/too large/i.test(reply.error), `reply: ${JSON.stringify(reply)}`);
});

test('refuses to read a brochure that redirected to the local network', async () => {
  nextResponse = () => response('<p>secret router page 720 sq ft</p>', { headers: { 'content-type': 'text/html' }, url: 'http://192.168.1.1/' });
  const reply = await send({ op: 'readDocument', url: 'https://agent.example.com/b' });
  assert(/disallowed address/i.test(reply.error), `reply: ${JSON.stringify(reply)}`);
});
