// PDF rendering, text extraction, selection capture.
// Uses pdf.js loaded from CDN (see index.html).

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';

export const BASE_SCALE = 1.5;

// Render a PDF into the given container. Returns { doc, pages: [{pageNum, viewport, wrap, textLayer, highlightLayer}] }
// `scale` is the absolute pdf.js viewport scale (default = BASE_SCALE).
//
// Pages are placeholder-rendered immediately (correct dimensions, empty
// highlight layer ready) and lazy canvas-rendered as they approach the
// viewport. Big papers open in milliseconds; pages 5+ render on demand.
export async function renderPdf(blob, container, scale = BASE_SCALE) {
  container.innerHTML = '';
  const data = await blob.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const dpr = window.devicePixelRatio || 1;
  const pages = [];

  // First pass: get every page's viewport (cheap — no canvas) and create
  // empty placeholder DOM with the correct dimensions. This makes the
  // total scroll height correct from the start so anchor / scroll math
  // works even for pages that haven't rendered yet.
  for (let i = 1; i <= doc.numPages; i++) {
    const pdfPage = await doc.getPage(i);
    const viewport = pdfPage.getViewport({ scale });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap loading';
    wrap.dataset.page = String(i);
    wrap.style.width = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    // Highlight layer exists from the start so redrawHighlights and
    // threadAtPoint work uniformly across rendered + unrendered pages.
    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';
    wrap.appendChild(highlightLayer);

    container.appendChild(wrap);

    pages.push({
      pageNum: i, viewport, wrap, highlightLayer,
      textLayer: null, linkLayer: null, canvas: null,
      _pdfPage: pdfPage, _rendered: false, _renderPromise: null,
    });
  }

  // Lazy canvas render driven by IntersectionObserver. The viewer-wrap
  // (container's parent) is the scroll root; we trigger rendering when a
  // page's placeholder is within 800px of the viewport in either direction.
  const root = container.parentElement;
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const p = pages.find(pg => pg.wrap === e.target);
      if (!p || p._rendered) continue;
      observer.unobserve(p.wrap);
      ensurePageRendered(p, dpr);
    }
  }, { root, rootMargin: '800px 0px' });
  for (const p of pages) observer.observe(p.wrap);

  return { doc, pages };
}

// Render the canvas + text/link layers for a single placeholder page. Idempotent:
// concurrent calls return the same in-flight promise. Dispatches a
// 'paperchat:page-rendered' CustomEvent on the page-wrap when done so
// callers can re-draw highlights and reposition layers.
export function ensurePageRendered(p, dpr = window.devicePixelRatio || 1) {
  if (p._rendered) return Promise.resolve();
  if (p._renderPromise) return p._renderPromise;
  p._renderPromise = (async () => {
    const { _pdfPage: pdfPage, viewport, wrap } = p;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    // Insert before highlight-layer so highlights overlay the canvas.
    wrap.insertBefore(canvas, wrap.firstChild);

    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    textLayer.style.width = viewport.width + 'px';
    textLayer.style.height = viewport.height + 'px';
    // pdfjs v4 TextLayer scales each <span> via the --scale-factor CSS var.
    // Without it the spans are mis-sized and selection rectangles end at the
    // wrong x — text looks correctly placed because of font baseline auto-
    // adjust, but drag-selection misses the right edge of every line.
    textLayer.style.setProperty('--scale-factor', String(viewport.scale));
    canvas.after(textLayer);

    const linkLayer = document.createElement('div');
    linkLayer.className = 'link-layer';
    textLayer.after(linkLayer);

    await pdfPage.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;

    const textContent = await pdfPage.getTextContent();
    const layerTask = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport,
    });
    await layerTask.render();

    await renderLinkLayer(pdfPage, viewport, linkLayer);
    linkifyTextLayer(textLayer, linkLayer, wrap);

    p.canvas = canvas;
    p.textLayer = textLayer;
    p.linkLayer = linkLayer;
    p._rendered = true;
    wrap.classList.remove('loading');
    wrap.dispatchEvent(new CustomEvent('paperchat:page-rendered', {
      bubbles: true,
      detail: { pageNum: p.pageNum },
    }));
  })();
  return p._renderPromise;
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

// Heuristic match for "this outline entry is a top-level chapter".
// Catches "1. Foo", "Chapter 1 — Foo", "Part II", "Lecture 3", "§1 Foo".
// Excludes Cover, Copyright, Preface, Index, Glossary, Appendix*, Bibliography…
const CHAPTER_TITLE_RE = /^\s*(chapter|chap\.?|part|lecture|§)?\s*(\d+|[IVXLC]+)([.)\s:\-—]|$)/i;
const NON_CHAPTER_TITLE_RE = /^\s*(cover|title page|copyright|dedication|preface|acknowledgments?|table of contents|contents|list of (figures|tables|symbols|abbreviations)|foreword|introduction to the (\w+ )?edition|about the authors?|index|glossary|bibliography|references|notes|errata|colophon|eula|end ?user license|appendi(x|ces)( [a-z0-9]+)?( .*)?|questions and problems)\s*$/i;

function looksLikeChapter(title) {
  const t = (title || '').trim();
  if (!t) return false;
  if (NON_CHAPTER_TITLE_RE.test(t)) return false;
  return CHAPTER_TITLE_RE.test(t);
}

// Derive a flat chapter index from an outline tree + total page count.
// Returns [{ id, title, startPage, endPage }], ordered by startPage.
// endPage is the page just before the next chapter's start (or totalPages
// for the last chapter). Returns [] if no chapter-like entries found.
export function deriveChapters(outline, totalPages) {
  if (!outline?.length || !totalPages) return [];
  // Only top-level entries are eligible — sub-entries are sections, not chapters.
  const candidates = outline
    .filter(it => it.pageNum != null && looksLikeChapter(it.title))
    .map(it => ({ title: it.title.trim(), startPage: it.pageNum }))
    .sort((a, b) => a.startPage - b.startPage);
  if (!candidates.length) return [];
  // Dedupe identical startPage entries (keep first).
  const seen = new Set();
  const uniq = candidates.filter(c => {
    if (seen.has(c.startPage)) return false;
    seen.add(c.startPage);
    return true;
  });
  return uniq.map((c, i) => ({
    id: `ch-${i}-p${c.startPage}`,
    title: c.title,
    startPage: c.startPage,
    endPage: (i + 1 < uniq.length ? uniq[i + 1].startPage - 1 : totalPages),
  }));
}

// Decide whether a PDF should default into book mode.
// Heuristic: long doc with at least a handful of chapter-like entries.
export function detectBookMode(chapters, totalPages) {
  return totalPages > 100 && chapters.length >= 5;
}

// Open a PDF blob, derive outline + chapters, then close. Used at upload time
// (and as a lazy backfill for older library entries) so the chapter index is
// cached on the paper record instead of recomputed on every open.
export async function extractOutlineAndChaptersFromBlob(blob) {
  try {
    const data = await blob.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const outline = await getOutline(doc);
    const chapters = deriveChapters(outline, doc.numPages);
    return { outline, chapters };
  } catch {
    return { outline: [], chapters: [] };
  }
}

// Look up the chapter containing a given 1-indexed page. Null if outside any.
export function chapterForPage(chapters, pageNum) {
  if (!chapters?.length || !pageNum) return null;
  for (const c of chapters) {
    if (pageNum >= c.startPage && pageNum <= c.endPage) return c;
  }
  return null;
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
export function drawHighlight(page, thread, { active = false, ratio = 1, onClick } = {}) {
  for (const r of thread.anchorRects) {
    const el = document.createElement('div');
    el.className = 'highlight' + (active ? ' active' : '');
    el.style.left = (r.x * ratio) + 'px';
    el.style.top = (r.y * ratio) + 'px';
    el.style.width = (r.w * ratio) + 'px';
    el.style.height = (r.h * ratio) + 'px';
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

// Pull every embedded image XObject from a page range, plus a rasterized
// full-page image (for vector figures that don't show up as XObjects), plus
// per-page text. Used by the chapter-summary feature so the agent can see
// what's in the chapter without going through pdf.js itself.
//
// Returns:
//   {
//     figures: [{ id, page, indexOnPage, dataUrl, width, height, op }],
//     pages:   [{ page, rasterDataUrl, width, height, text }],
//     diagnostics: { byOp: {opName: {seen, kept, skipped: {reason: count}}} },
//   }
//
// `onProgress` is an optional ({ page, totalPages }) callback so the UI can
// stream progress while extraction runs.
// `minSize` filters out spacer/icon images. Lower it to catch small figures.
export async function extractChapterFigures(doc, startPage, endPage, { onProgress, rasterScale = 1.6, minSize = 16 } = {}) {
  const figures = [];
  const pages = [];
  const diag = { byOp: {} };
  const tick = (opName, bucket) => {
    const o = diag.byOp[opName] = diag.byOp[opName] || { seen: 0, kept: 0, skipped: {} };
    if (bucket === 'seen') o.seen++;
    else if (bucket === 'kept') o.kept++;
    else { o.skipped[bucket] = (o.skipped[bucket] || 0) + 1; }
  };
  const totalPages = endPage - startPage + 1;

  const OPS = pdfjsLib.OPS;
  // All paint-image variants pdf.js emits. Mask/Group/Repeat all paint a
  // bitmap that the user thinks of as a figure.
  const IMAGE_OPS = new Map();
  const register = (op, name) => { if (op != null) IMAGE_OPS.set(op, name); };
  register(OPS.paintInlineImageXObject, 'inline');
  register(OPS.paintInlineImageXObjectGroup, 'inlineGroup');
  register(OPS.paintImageXObject, 'image');
  register(OPS.paintImageXObjectRepeat, 'imageRepeat');
  register(OPS.paintJpegXObject, 'jpeg');
  register(OPS.paintImageMaskXObject, 'mask');
  register(OPS.paintImageMaskXObjectGroup, 'maskGroup');
  register(OPS.paintImageMaskXObjectRepeat, 'maskRepeat');

  for (let pn = startPage; pn <= endPage; pn++) {
    const page = await doc.getPage(pn);

    // 1) Rasterize full page — single visual reference for the agent.
    const vp = page.getViewport({ scale: rasterScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const rasterDataUrl = canvas.toDataURL('image/jpeg', 0.85);

    // 2) Plaintext (we already have this on the paper record, but this
    //    version is scoped to the chapter and bundled with the figures).
    const tc = await page.getTextContent();
    let text = '';
    let lastY = null;
    for (const item of tc.items) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 2) text += '\n';
      text += item.str;
      if (item.hasEOL) text += '\n';
      lastY = item.transform[5];
    }

    // 3) Walk op list for image-paint ops. Render-pass forces pdf.js to
    //    populate page.objs so paintImage* lookups don't race the decoder.
    let ops;
    try { ops = await page.getOperatorList(); }
    catch { ops = { fnArray: [], argsArray: [] }; }

    // Track image-mask group composites: maskGroup/imageGroup args[0] is
    // an array of names rather than a single name.
    let idx = 0;
    const dedupe = new Set();
    for (let i = 0; i < ops.fnArray.length; i++) {
      const op = ops.fnArray[i];
      const opName = IMAGE_OPS.get(op);
      if (!opName) continue;
      tick(opName, 'seen');
      const args = ops.argsArray[i] || [];

      // Resolve to one-or-more image objects depending on the op shape.
      const imgs = [];
      try {
        if (opName === 'inline') {
          if (args[0]) imgs.push(args[0]);
        } else if (opName === 'inlineGroup') {
          // args[0] is an array of inline image dicts in some builds.
          const arr = Array.isArray(args[0]) ? args[0] : [];
          imgs.push(...arr);
        } else if (opName.endsWith('Group') || opName.endsWith('Repeat')) {
          // Group/Repeat variants: args[0] is either a string name (Repeat)
          // or an array of name/positions (Group). Defensive handling.
          const a0 = args[0];
          if (typeof a0 === 'string') {
            imgs.push(await resolvePageObject(page, a0));
          } else if (Array.isArray(a0)) {
            for (const entry of a0) {
              const name = typeof entry === 'string' ? entry : entry?.name;
              if (name) imgs.push(await resolvePageObject(page, name));
            }
          } else {
            tick(opName, 'unhandled-args');
          }
        } else {
          // image | jpeg | mask — args[0] is the xobject name.
          const name = args[0];
          if (typeof name === 'string') {
            imgs.push(await resolvePageObject(page, name));
          } else {
            tick(opName, 'no-name');
          }
        }
      } catch {
        tick(opName, 'resolve-error');
        continue;
      }

      for (const img of imgs) {
        if (!img) { tick(opName, 'resolve-null'); continue; }
        const result = imageObjectToDataUrl(img, { minSize });
        if (!result) { tick(opName, 'decode-skip'); continue; }
        // Dedupe: the same xobject can be painted multiple times on a page
        // (e.g. a brand logo). Keep only the first paint per (page, hash).
        const key = `${result.width}x${result.height}:${result.dataUrl.length}`;
        if (dedupe.has(key)) { tick(opName, 'duplicate'); continue; }
        dedupe.add(key);
        figures.push({
          id: `p${pn}-i${idx}`,
          page: pn,
          indexOnPage: idx,
          op: opName,
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
        });
        tick(opName, 'kept');
        idx++;
      }
    }

    pages.push({ page: pn, rasterDataUrl, width: canvas.width, height: canvas.height, text });
    if (onProgress) onProgress({ page: pn, totalPages, soFar: pn - startPage + 1 });
  }
  return { figures, pages, diagnostics: diag };
}

// page.objs.get(name) returns the resolved object once decoded; before that,
// the callback-form schedules a resolver. Wrap in a promise with a short
// timeout so a stuck image doesn't hang the whole extraction.
function resolvePageObject(page, name, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    try {
      if (page.objs.has(name)) return finish(page.objs.get(name));
      page.objs.get(name, (obj) => finish(obj));
      setTimeout(() => finish(null), timeoutMs);
    } catch { finish(null); }
  });
}

// Convert a resolved pdf.js image object into a PNG data URL. Handles:
//   - `.bitmap` (ImageBitmap)            modern pdf.js path
//   - raw `.data` + width + height       RGBA / RGB / grayscale / 1-bit mask
// Returns null on anything weirder — caller logs and skips.
function imageObjectToDataUrl(img, { minSize = 16 } = {}) {
  if (!img) return null;
  try {
    const w = img.width || img.bitmap?.width;
    const h = img.height || img.bitmap?.height;
    if (!w || !h) return null;
    if (w < minSize || h < minSize) return null;

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');

    if (img.bitmap) {
      ctx.drawImage(img.bitmap, 0, 0);
      return { dataUrl: c.toDataURL('image/png'), width: w, height: h };
    }

    const src = img.data;
    if (!src) return null;
    const imageData = ctx.createImageData(w, h);
    const dst = imageData.data;

    if (src.length === dst.length) {
      // RGBA
      dst.set(src);
    } else if (src.length === w * h * 3) {
      // RGB
      for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
        dst[j] = src[i]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i + 2]; dst[j + 3] = 255;
      }
    } else if (src.length === w * h) {
      // Grayscale (8 bpp)
      for (let i = 0, j = 0; i < src.length; i++, j += 4) {
        dst[j] = dst[j + 1] = dst[j + 2] = src[i]; dst[j + 3] = 255;
      }
    } else if (src.length === Math.ceil(w / 8) * h) {
      // 1-bpp image mask. Each bit set = opaque pixel (black on white).
      const stride = Math.ceil(w / 8);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const byte = src[y * stride + (x >> 3)];
          const bit = (byte >> (7 - (x & 7))) & 1;
          const j = (y * w + x) * 4;
          const v = bit ? 0 : 255;
          dst[j] = dst[j + 1] = dst[j + 2] = v;
          dst[j + 3] = 255;
        }
      }
    } else {
      return null;
    }
    ctx.putImageData(imageData, 0, 0);
    return { dataUrl: c.toDataURL('image/png'), width: w, height: h };
  } catch {
    return null;
  }
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
