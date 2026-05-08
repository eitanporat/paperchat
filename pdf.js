// PDF rendering, text extraction, selection capture.
// Uses pdf.js loaded from CDN (see index.html).

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';

const RENDER_SCALE = 1.5;

// Render a PDF into the given container. Returns { doc, pages: [{pageNum, viewport, wrap, textLayer, highlightLayer}] }
export async function renderPdf(blob, container) {
  container.innerHTML = '';
  const data = await blob.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const dpr = window.devicePixelRatio || 1;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = String(i);
    wrap.style.width = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    wrap.appendChild(canvas);

    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    textLayer.style.width = viewport.width + 'px';
    textLayer.style.height = viewport.height + 'px';
    wrap.appendChild(textLayer);

    const linkLayer = document.createElement('div');
    linkLayer.className = 'link-layer';
    wrap.appendChild(linkLayer);

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';
    wrap.appendChild(highlightLayer);

    container.appendChild(wrap);

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;

    const textContent = await page.getTextContent();
    const layerTask = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport,
    });
    await layerTask.render();

    await renderLinkLayer(page, viewport, linkLayer);
    linkifyTextLayer(textLayer, linkLayer, wrap);

    pages.push({ pageNum: i, viewport, wrap, textLayer, linkLayer, highlightLayer });
  }
  return { doc, pages };
}

// Scan rendered text layer for plain-text URLs and overlay transparent <a>
// elements on top of them in the link layer. Uses Range.getBoundingClientRect
// to position the link precisely over the matched substring.
function linkifyTextLayer(textLayer, linkLayer, wrap) {
  const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;
  const wrapRect = wrap.getBoundingClientRect();
  // Walk every text node under the text layer.
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text || !text.includes('http')) continue;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      // Range may produce multiple rects if the URL wraps within the node;
      // create one anchor per rect, all pointing at the same URL.
      const rects = range.getClientRects();
      for (const r of rects) {
        if (r.width < 1 || r.height < 1) continue;
        const link = document.createElement('a');
        link.href = m[0];
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = m[0];
        link.style.left = (r.left - wrapRect.left) + 'px';
        link.style.top = (r.top - wrapRect.top) + 'px';
        link.style.width = r.width + 'px';
        link.style.height = r.height + 'px';
        linkLayer.appendChild(link);
      }
    }
  }
}

async function renderLinkLayer(page, viewport, layer) {
  const annotations = await page.getAnnotations({ intent: 'display' });
  for (const a of annotations) {
    if (a.subtype !== 'Link') continue;
    const url = a.url || a.unsafeUrl;
    if (!url) continue; // skip internal-destination links for now
    const [x1, y1, x2, y2] = pdfjsLib.Util.normalizeRect(
      viewport.convertToViewportRectangle(a.rect)
    );
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = url;
    link.style.left = Math.min(x1, x2) + 'px';
    link.style.top = Math.min(y1, y2) + 'px';
    link.style.width = Math.abs(x2 - x1) + 'px';
    link.style.height = Math.abs(y2 - y1) + 'px';
    layer.appendChild(link);
  }
}

// Try to read the PDF's embedded title from its metadata. Returns null when
// missing or trivial.
export async function getPdfMetadataTitle(blob) {
  try {
    const data = await blob.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const meta = await doc.getMetadata().catch(() => null);
    const title = (meta?.info?.Title || '').trim();
    if (!title || title.length < 4 || /^untitled|microsoft word|^layout|^paper$|\.(docx?|tex|pdf)$/i.test(title)) {
      return null;
    }
    return title;
  } catch {
    return null;
  }
}

// Extract the PDF outline (table of contents). Returns a tree of
// { title, pageNum, children: [...] }. pageNum is 1-indexed or null if unresolvable.
export async function getOutline(doc) {
  const raw = await doc.getOutline();
  if (!raw || !raw.length) return [];
  async function resolve(items) {
    const out = [];
    for (const it of items) {
      let pageNum = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          const idx = await doc.getPageIndex(dest[0]);
          pageNum = idx + 1;
        }
      } catch { /* unresolvable destination — skip */ }
      out.push({
        title: it.title || '(untitled)',
        pageNum,
        children: it.items?.length ? await resolve(it.items) : [],
      });
    }
    return out;
  }
  return resolve(raw);
}

// Extract full plaintext per page. Returns array of strings indexed by pageNum-1.
export async function extractText(blob) {
  const data = await blob.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = '';
    let lastY = null;
    for (const item of tc.items) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 2) text += '\n';
      text += item.str;
      if (item.hasEOL) text += '\n';
      lastY = item.transform[5];
    }
    pages.push(text);
  }
  return pages;
}

// Given a Selection inside the text layer of a page, return rects in page-local coords.
export function captureSelection(pages) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  // find page wrap that contains the range
  const startPage = findPageWrap(range.startContainer, pages);
  const endPage = findPageWrap(range.endContainer, pages);
  if (!startPage || startPage !== endPage) return null; // single-page selections only for v1
  const wrapRect = startPage.wrap.getBoundingClientRect();
  const clientRects = range.getClientRects();
  const rects = [];
  for (const r of clientRects) {
    if (r.width < 1 || r.height < 1) continue;
    rects.push({
      x: r.left - wrapRect.left,
      y: r.top - wrapRect.top,
      w: r.width,
      h: r.height,
    });
  }
  if (!rects.length) return null;
  return {
    pageNum: startPage.pageNum,
    quote: sel.toString().trim(),
    rects,
    // anchor for the floating ask: center of the last rect
    anchor: {
      x: rects[rects.length - 1].x + rects[rects.length - 1].w / 2,
      y: rects[rects.length - 1].y + rects[rects.length - 1].h,
      pageWrap: startPage.wrap,
    },
  };
}

function findPageWrap(node, pages) {
  while (node && node.nodeType !== 1) node = node.parentNode;
  while (node) {
    if (node.classList && node.classList.contains('page-wrap')) {
      const pn = Number(node.dataset.page);
      return pages.find(p => p.pageNum === pn);
    }
    node = node.parentNode;
  }
  return null;
}

// Draw highlights for a thread on its page.
export function drawHighlight(page, thread, { active = false, onClick } = {}) {
  for (const r of thread.anchorRects) {
    const el = document.createElement('div');
    el.className = 'highlight' + (active ? ' active' : '');
    el.style.left = r.x + 'px';
    el.style.top = r.y + 'px';
    el.style.width = r.w + 'px';
    el.style.height = r.h + 'px';
    el.dataset.threadId = thread.id;
    if (onClick) el.addEventListener('click', () => onClick(thread.id));
    page.highlightLayer.appendChild(el);
  }
}

export function clearHighlights(pages) {
  for (const p of pages) p.highlightLayer.innerHTML = '';
}

// Locate a quote in the rendered text layer of a page and add a temporary
// "AI" highlight over it. Returns true if found.
export function highlightQuoteOnPage(page, quote, durationMs = 8000) {
  const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();
  const target = norm(quote);
  if (!target) return false;
  const wrapRect = page.wrap.getBoundingClientRect();
  const walker = document.createTreeWalker(page.textLayer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue;
    if (!text) continue;
    const lo = norm(text);
    const idx = lo.indexOf(target);
    if (idx < 0) continue;
    // Map normalized index back to original-string indices.
    const { start, end } = mapNormalizedRange(text, idx, idx + target.length);
    if (start == null) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const rects = range.getClientRects();
    const created = [];
    for (const r of rects) {
      if (r.width < 1 || r.height < 1) continue;
      const el = document.createElement('div');
      el.className = 'highlight ai-temp';
      el.style.left = (r.left - wrapRect.left) + 'px';
      el.style.top = (r.top - wrapRect.top) + 'px';
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';
      page.highlightLayer.appendChild(el);
      created.push(el);
    }
    if (created.length) {
      page.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => { for (const el of created) el.remove(); }, durationMs);
      return true;
    }
  }
  return false;
}

// Given an original string and start/end indices into its whitespace-collapsed
// lowercase form, find the corresponding indices in the original.
function mapNormalizedRange(orig, normStart, normEnd) {
  let normIdx = 0;
  let prevWs = false;
  let start = null, end = null;
  for (let i = 0; i < orig.length; i++) {
    const ch = orig[i];
    const isWs = /\s/.test(ch);
    if (isWs) {
      if (prevWs) continue;
      if (normIdx === normStart && start == null) start = i;
      if (normIdx === normEnd) { end = i; break; }
      normIdx++;
      prevWs = true;
    } else {
      if (normIdx === normStart && start == null) start = i;
      if (normIdx === normEnd) { end = i; break; }
      normIdx++;
      prevWs = false;
    }
  }
  if (start == null) start = orig.length;
  if (end == null) end = orig.length;
  return { start, end };
}
