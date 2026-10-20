/* global Tesseract */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { safeExternalUrl } from './site.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');

const MAX_PDF_TEXT_PAGES = 15;
const OCR_TARGET_WIDTH = 2000; // floorplan text is small; upscaling helps Tesseract a lot
const MAX_CACHED_PDFS = 2;
// Download caps, so a listing linking to a huge file can't exhaust memory. The largest
// real brochure seen so far was about 10 MB.
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  // Only the background worker drives OCR; messages from a tab's content script are ignored.
  if (sender.tab || sender.id !== chrome.runtime.id) return false;
  const handler = HANDLERS[msg.op];
  if (!handler) return false;

  handler(msg)
    .then((result) => sendResponse({ result }))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

const HANDLERS = {
  ocrImage: ({ url, enhanced }) => ocrImage(url, Boolean(enhanced)),
  readDocument: ({ url }) => readDocument(url),
  ocrPdfPage: ({ url, page }) => ocrPdfPage(url, page),
};

// ---------------------------------------------------------------------------
// OCR

let ocrWorker = null;

function getOcrWorker() {
  ocrWorker ??= Tesseract.createWorker('eng', 1, {
    workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
    corePath: chrome.runtime.getURL('vendor/tesseract/core'),
    langPath: chrome.runtime.getURL('vendor/tesseract/lang'),
    workerBlobURL: false,
    cacheMethod: 'none',
  }).catch((err) => {
    ocrWorker = null;
    throw err;
  });
  return ocrWorker;
}

// Sparse-text segmentation suits floorplans (scattered labels, no paragraphs) far better
// than Tesseract's default page layout analysis.
const PSM_SPARSE_TEXT = '11';

async function recognize(canvas) {
  const worker = await getOcrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: PSM_SPARSE_TEXT });
  const { data } = await worker.recognize(canvas);
  return data.text || '';
}

const FETCH_TIMEOUT_MS = 10 * 1000; // under background.js's 15s limit per job

async function fetchOk(url) {
  const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

// Reads a response body, giving up as soon as it passes `maxBytes` (whether or not the
// server announced its size).
async function readCapped(res, maxBytes) {
  const tooBig = () => new Error(`File too large (over ${Math.round(maxBytes / 1024 / 1024)} MB): ${res.url}`);
  if (Number(res.headers.get('content-length')) > maxBytes) throw tooBig();

  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Brochure links are checked before they're sent here, but a redirect could still land
// somewhere local; refuse to read it if so.
function checkFinalUrl(res) {
  if (res.url && !safeExternalUrl(res.url)) throw new Error(`Brochure redirected to a disallowed address: ${res.url}`);
}

// `enhanced` is a second pass for faint grey text; it's not the default because the
// contrast boost occasionally turns thousands separators into digits.
async function ocrImage(url, enhanced) {
  const res = await fetchOk(url);
  const bitmap = await createImageBitmap(new Blob([await readCapped(res, MAX_IMAGE_BYTES)]));
  const targetWidth = enhanced ? OCR_TARGET_WIDTH * 1.3 : OCR_TARGET_WIDTH;
  const scale = Math.min(3, Math.max(1, targetWidth / bitmap.width));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNG floorplans otherwise OCR as black-on-black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  if (enhanced) ctx.filter = 'grayscale(1) contrast(1.6)';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return recognize(canvas);
}

// ---------------------------------------------------------------------------
// Brochures (PDF or agent web page)

const pdfCache = new Map(); // url -> Promise<PDFDocumentProxy>

function rememberPdf(url, promise) {
  pdfCache.set(url, promise);
  while (pdfCache.size > MAX_CACHED_PDFS) {
    const [oldUrl, oldPromise] = pdfCache.entries().next().value;
    pdfCache.delete(oldUrl);
    oldPromise.then((doc) => doc.destroy()).catch(() => {});
  }
  return promise;
}

function openPdf(url, bytes) {
  if (pdfCache.has(url)) return pdfCache.get(url);
  const load = async () => {
    let data = bytes;
    if (!data) {
      const res = await fetchOk(url);
      checkFinalUrl(res);
      data = await readCapped(res, MAX_DOCUMENT_BYTES);
    }
    return pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  };
  return rememberPdf(url, load());
}

function looksLikePdf(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

async function readDocument(url) {
  const res = await fetchOk(url);
  checkFinalUrl(res);
  const contentType = res.headers.get('content-type') || '';
  const bytes = await readCapped(res, MAX_DOCUMENT_BYTES);

  if (contentType.includes('pdf') || looksLikePdf(bytes)) {
    const doc = await openPdf(url, bytes);
    const parts = [];
    for (let p = 1; p <= Math.min(doc.numPages, MAX_PDF_TEXT_PAGES); p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      parts.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
    }
    return { kind: 'pdf', numPages: doc.numPages, text: parts.join('\n') };
  }

  if (contentType.includes('html') || contentType.startsWith('text/')) {
    const html = new TextDecoder().decode(bytes);
    const dom = new DOMParser().parseFromString(html, 'text/html');
    dom.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());
    const text = (dom.body?.textContent || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n');
    return { kind: 'html', text };
  }

  return { kind: 'other', text: '' };
}

async function ocrPdfPage(url, pageNumber) {
  const doc = await openPdf(url);
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(4, OCR_TARGET_WIDTH / base.width) });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();

  return recognize(canvas);
}
