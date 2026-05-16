// Top-level app wiring: library, viewer, threads, settings.

import { Papers, Threads, Messages, uid, hashBlob } from './db.js';
import { renderPdf, ensurePageRendered, BASE_SCALE, getOutline, getPdfMetadataTitle, extractText, captureSelection, drawHighlight, clearHighlights, highlightQuoteOnPage, deriveChapters, detectBookMode, chapterForPage, extractOutlineAndChaptersFromBlob } from './pdf.js';
import {
  streamChat, parseMention, MENTIONS, mentionClass, extractPaperTitle,
  getKey, setKey, envKey, getModels, setModels, modelFor,
} from './ai.js';
import {
  renderMathIn,
  stashMathAndRunMarked,
  preprocessMarkdownMath,
  fixMathInDom,
} from './_lib/pc-math.js';

const $ = (sel) => document.querySelector(sel);

// ---- DOM ----
const libraryList = $('#library-list');
const libraryEmpty = $('#library-empty');
const viewer = $('#viewer');
const viewerPlaceholder = $('#viewer-placeholder');
const paperTitleEl = $('#paper-title');
const passageList = $('#passage-list');
const wholeList = $('#whole-list');
const passageEmpty = $('#passage-empty');
const wholeEmpty = $('#whole-empty');
const floatingAsk = $('#floating-ask');
const dropOverlay = $('#drop-overlay');
const fileInput = $('#file-input');

// Thread dialog
const threadDlg = $('#thread-dialog');
const threadDlgTitle = $('#thread-dlg-title');
const threadDlgClose = $('#thread-dlg-close');
const threadQuoteEl = $('#thread-quote');
const threadMsgsEl = $('#thread-msgs');
const threadForm = $('#thread-form');
const threadInput = $('#thread-input');
const threadSend = $('#thread-send');
const threadStop = $('#thread-stop');

// Settings dialog
const settingsDlg = $('#settings-dialog');
const settingsForm = $('#settings-form');
const settingsKey = $('#settings-key');
const settingsClaude = $('#settings-claude');
const settingsGrok = $('#settings-grok');
const settingsGpt = $('#settings-gpt');
const settingsChapterPlanner = $('#settings-chapter-planner');
const settingsChapterWriter = $('#settings-chapter-writer');
const settingsChapterAutoOpen = $('#settings-chapter-autoopen');

// ---- State ----
const state = {
  paper: null,        // { id, name, blob, pagesText, outline, chapters, bookMode, lastPage, ... }
  pages: [],          // rendered pages from pdf.js
  threads: [],        // threads on the current paper
  activeThreadId: null,
  pendingSelection: null, // { pageNum, quote, rects, anchor }
  zoomFactor: Number(localStorage.getItem('paperchat.zoom')) || 1.0,
  // Book-mode runtime state. currentChapter follows the topmost visible page.
  currentChapter: null,
  scrollObserver: null,   // IntersectionObserver tracking visible pages
  scrollHandler: null,    // viewer-wrap 'scroll' listener (debounced lastPage write)
  topVisiblePage: 1,
  // threadId -> { card: HTMLElement, controller: AbortController }
  // Kept across dialog close/reopen so a request started in one thread keeps
  // running while the user browses others; on reopen, the card is reattached
  // to threadMsgsEl. The controller is wired through to the fetch underlying
  // streamChat so a stop button can abort the stream.
  inflight: new Map(),
};

// ---- Library ----

function isPaperArchived(p) { return !!p.archivedAt; }

async function renderLibrary() {
  const papers = await Papers.list();
  const active = papers.filter(p => !isPaperArchived(p));
  const archived = papers
    .filter(isPaperArchived)
    .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));

  libraryList.innerHTML = '';
  libraryEmpty.hidden = active.length > 0;
  for (const p of active) libraryList.appendChild(buildLibraryItem(p, false));

  const archSec = $('#library-archived');
  const archList = $('#library-archived-list');
  archList.innerHTML = '';
  archSec.hidden = archived.length === 0;
  $('#library-archived-count').textContent = `Archived (${archived.length})`;
  for (const p of archived) archList.appendChild(buildLibraryItem(p, true));
}

function buildLibraryItem(p, archived) {
  const li = document.createElement('li');
  li.className = 'lib-item' +
    (state.paper?.id === p.id ? ' active' : '') +
    (archived ? ' archived' : '');
  li.innerHTML = `
    <span class="title"></span>
    <button class="arch" title=""></button>
    <button class="del" title="Delete">✕</button>
  `;
  const title = li.querySelector('.title');
  title.textContent = p.title || p.name;
  title.title = p.name;
  title.addEventListener('click', () => openPaper(p.id));

  const archBtn = li.querySelector('.arch');
  archBtn.textContent = archived ? '↩' : '📁';
  archBtn.title = archived ? 'Unarchive' : 'Archive';
  archBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await setPaperArchived(p.id, !archived);
  });

  li.querySelector('.del').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!await confirmAction(`Delete "${p.title || p.name}" and all of its threads?`)) return;
    await Papers.delete(p.id);
    if (state.paper?.id === p.id) closePaper();
    renderLibrary();
  });
  return li;
}

async function setPaperArchived(id, archived) {
  const p = await Papers.get(id);
  if (!p) return;
  p.archivedAt = archived ? Date.now() : null;
  await Papers.put(p);
  // If the currently-open paper was archived, close it.
  if (archived && state.paper?.id === id) closePaper();
  await renderLibrary();
  showToast(archived ? 'Paper archived' : 'Paper unarchived', { type: 'info', durationMs: 2000 });
}

async function addPaperFromFile(file) {
  if (!file || file.type !== 'application/pdf') {
    showToast('Only PDF files are supported.', { type: 'error' });
    return;
  }
  const id = await hashBlob(file);
  const existing = await Papers.get(id);
  if (existing) {
    await openPaper(id);
    return;
  }
  // Show a placeholder while extracting
  viewerPlaceholder.style.display = 'block';
  viewerPlaceholder.innerHTML = `<p>Extracting text from <b>${file.name}</b>…</p>`;
  const [pagesText, metaTitle, outlineInfo] = await Promise.all([
    extractText(file),
    getPdfMetadataTitle(file),
    extractOutlineAndChaptersFromBlob(file),
  ]);
  // Prefer LLM extraction (works on most papers); fall back to metadata, then filename.
  const llmTitle = await extractPaperTitle(pagesText[0]).catch(() => null);
  const autoBookMode = detectBookMode(outlineInfo.chapters, pagesText.length);
  const paper = {
    id,
    name: file.name,
    title: llmTitle || metaTitle || null,
    blob: file,
    pagesText,
    outline: outlineInfo.outline,
    chapters: outlineInfo.chapters,
    bookMode: autoBookMode ? 'auto' : 'off',
    bookModeToastShown: false,
    lastPage: 1,
    addedAt: Date.now(),
    lastOpened: Date.now(),
  };
  await Papers.put(paper);
  await renderLibrary();
  await openPaper(id);
}

// Backfill paper.title for any library entries that were imported before
// title extraction existed. Runs in the background; refreshes UI as titles
// arrive. Skips silently when no API key is set.
async function backfillTitles() {
  if (!getKey()) return;
  const all = await Papers.list();
  const todo = all.filter(p => !p.title && p.pagesText?.[0]);
  for (const p of todo) {
    const title = await extractPaperTitle(p.pagesText[0]).catch(() => null);
    if (!title) continue;
    p.title = title;
    await Papers.put(p);
    if (state.paper?.id === p.id) {
      paperTitleEl.textContent = title;
      document.title = `${title} — paperchat`;
    }
    renderLibrary();
  }
}

async function openPaper(id) {
  teardownBookMode();
  const paper = await Papers.get(id);
  if (!paper) return;
  await Papers.touch(id);
  state.paper = paper;
  state.activeThreadId = null;
  state.pendingSelection = null;
  const displayTitle = paper.title || paper.name;
  paperTitleEl.textContent = displayTitle;
  document.title = `${displayTitle} — paperchat`;
  $('#new-whole-btn').hidden = false;
  viewerPlaceholder.style.display = 'none';
  viewer.innerHTML = '';
  viewer.appendChild(viewerPlaceholder);
  viewerPlaceholder.style.display = 'block';
  viewerPlaceholder.innerHTML = `<p>Rendering <b>${paper.name}</b>…</p>`;
  const { doc, pages } = await renderPdf(paper.blob, viewer, BASE_SCALE * state.zoomFactor);
  state.pages = pages;
  $('#zoom-controls').hidden = false;
  updateZoomLabel();
  viewerPlaceholder.style.display = 'none';
  state.threads = await Threads.byPaper(id);
  redrawHighlights();
  renderThreadList();
  renderLibrary();

  // Backfill outline/chapters for papers added before book mode existed.
  if (paper.outline === undefined || paper.chapters === undefined) {
    const outline = await getOutline(doc);
    const chapters = deriveChapters(outline, doc.numPages);
    paper.outline = outline;
    paper.chapters = chapters;
    if (paper.bookMode === undefined) {
      paper.bookMode = detectBookMode(chapters, doc.numPages) ? 'auto' : 'off';
      paper.bookModeToastShown = false;
    }
    Papers.put(paper).catch(() => { /* best-effort */ });
  }

  renderOutline(paper.outline || []);
  setupBookMode(paper);
  restoreLastPage(paper);
  // Cache existing chapter summaries so the chip can offer "View" instead
  // of regenerating. Best-effort: missing endpoint just leaves it empty.
  refreshChapterSummaries(paper).catch(() => {});
  // Reattach to any chapter runs that are still in-flight from a previous
  // tab/session — the trace.jsonl is the source of truth.
  reattachActiveRuns(paper).catch(() => {});
}

// In-memory cache of past chapter summaries per paper.id → array of
// { chapterId, indexUrl, traceUrl, mtime }.
const _chapterSummaries = new Map();

async function refreshChapterSummaries(paper) {
  if (!paper?.id) return;
  try {
    const r = await fetch(`/api/chapter_summaries?paperId=${encodeURIComponent(paper.id)}`);
    if (!r.ok) return;
    const list = await r.json();
    _chapterSummaries.set(paper.id, list);
    // Re-render the chapter context + TOC so the menus and badges update.
    if (state.paper?.id === paper.id) {
      renderBookModeChip(paper);
      renderOutline(paper.outline || []);
    }
  } catch {}
}

function summaryForChapter(paper, chapterId) {
  const list = _chapterSummaries.get(paper?.id) || [];
  // chapterId is what we send to the server; the server-side dirName uses
  // safeId(chapterId), so compare both raw and sanitized forms.
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  return list.find(s => s.chapterId === chapterId || s.chapterId === safe(chapterId)) || null;
}

function renderOutline(tree) {
  const panel = $('#contents-panel');
  const treeEl = $('#contents-tree');
  const emptyEl = $('#contents-empty');
  panel.hidden = false;
  treeEl.innerHTML = '';
  if (!tree.length) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  treeEl.appendChild(buildOutlineList(tree));
}

function buildOutlineList(items, depth = 0) {
  const ul = document.createElement('ul');
  for (const it of items) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'toc-item' + (it.pageNum == null ? ' disabled' : '');
    const title = document.createElement('span');
    title.className = 'toc-title';
    title.textContent = it.title;
    row.appendChild(title);
    if (it.pageNum != null) {
      const page = document.createElement('span');
      page.className = 'toc-page';
      page.textContent = it.pageNum;
      row.appendChild(page);
      row.addEventListener('click', (e) => {
        // Don't jump when clicking the menu button.
        if (e.target.closest('.toc-menu-btn')) return;
        jumpToPage(it.pageNum);
      });
    }
    // Top-level entries that correspond to chapters get an actions menu.
    if (depth === 0 && it.pageNum != null) {
      const chap = (state.paper?.chapters || []).find(c => c.startPage === it.pageNum);
      if (chap) {
        const menuBtn = document.createElement('button');
        menuBtn.type = 'button';
        menuBtn.className = 'toc-menu-btn';
        menuBtn.title = 'Chapter actions';
        menuBtn.setAttribute('aria-label', 'Chapter actions');
        menuBtn.textContent = '⋯';
        menuBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openChapterMenu(menuBtn, chap);
        });
        row.appendChild(menuBtn);
        // Visual badge if a summary already exists.
        if (summaryForChapter(state.paper, chap.id)) {
          row.classList.add('has-summary');
        }
      }
    }
    li.appendChild(row);
    if (it.children?.length) li.appendChild(buildOutlineList(it.children, depth + 1));
    ul.appendChild(li);
  }
  return ul;
}

function jumpToPage(pageNum) {
  const page = state.pages.find(p => p.pageNum === pageNum);
  if (!page) return;
  ensurePageRendered(page);
  page.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Scroll the PDF viewer so the thread's first anchor rect is visible,
// positioned roughly a quarter from the top of the viewport (so the
// passage and some context above it are both shown). No-op for whole-
// paper threads (no anchor) or when the rect is already on screen.
function scrollViewerToThread(t) {
  if (!t || !t.pageNum) return;
  const page = state.pages.find(p => p.pageNum === t.pageNum);
  if (!page) return;
  const wrap = document.querySelector('.viewer-wrap');
  if (!wrap) return;
  // Kick off render of the target page immediately — by the time the smooth
  // scroll lands, the canvas will be there instead of a blank placeholder.
  ensurePageRendered(page);

  const r0 = t.anchorRects?.[0];
  if (!r0) {
    // No rect on file — fall back to the page top.
    page.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Anchor rects are in page-local pixels at the scale they were captured
  // at; scale to the current zoom.
  const currentScale = BASE_SCALE * state.zoomFactor;
  const ratio = currentScale / (t.anchorScale || BASE_SCALE);

  // Convert page.wrap's current viewport position into scroll-content coords:
  //   pageTopInWrap = (page.wrap.top − wrap.top) + wrap.scrollTop
  const wrapRect = wrap.getBoundingClientRect();
  const pageRect = page.wrap.getBoundingClientRect();
  const pageTopInWrap = (pageRect.top - wrapRect.top) + wrap.scrollTop;
  const rectTop = pageTopInWrap + r0.y * ratio;
  const rectBot = rectTop + r0.h * ratio;

  // Skip if the rect is already comfortably on screen (margin of 20/60 px
  // above/below the visible band so we don't bounce on near-misses).
  const visTop = wrap.scrollTop + 20;
  const visBot = wrap.scrollTop + wrap.clientHeight - 60;
  if (rectTop >= visTop && rectBot <= visBot) return;

  // Place the rect ~25% down from the top of the viewport.
  const target = Math.max(0, rectTop - wrap.clientHeight * 0.25);
  wrap.scrollTo({ top: target, behavior: 'smooth' });
}

// ---- Book mode ----

function bookModeActive(paper) {
  return paper?.chapters?.length > 0 && (paper.bookMode === 'auto' || paper.bookMode === 'on-manual');
}

// Persist a paper-record field without re-uploading the blob. Best-effort —
// failures are silent so a flaky write doesn't disrupt reading flow.
async function patchPaper(paper, patch) {
  Object.assign(paper, patch);
  try { await Papers.put({ ...paper, blob: undefined }); } catch { /* swallow */ }
}

// Debounce a function by `ms`, returning a callable that also has .flush().
function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.flush = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

function setupBookMode(paper) {
  renderBookModeChip(paper);

  // One-time toast announcing auto-on, so the user knows what changed.
  if (bookModeActive(paper) && paper.bookMode === 'auto' && !paper.bookModeToastShown) {
    showToast(
      `Book mode on — chat is scoped to the chapter you're reading. Toggle in the header.`,
      { type: 'info', durationMs: 6000 },
    );
    patchPaper(paper, { bookModeToastShown: true });
  }

  // IntersectionObserver: figure out the topmost visible page-wrap so we can
  // update state.currentChapter + lastPage as the user scrolls. Threshold 0
  // is enough — we just need each page to fire when it crosses the viewport.
  const wrap = document.querySelector('.viewer-wrap');
  if (!wrap) return;
  const visible = new Set();
  const persistLastPage = debounce((page) => {
    if (state.paper?.id !== paper.id) return;
    if (page === paper.lastPage) return;
    patchPaper(paper, { lastPage: page });
  }, 600);

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const pn = Number(e.target.dataset.page);
      if (!pn) continue;
      if (e.isIntersecting) visible.add(pn);
      else visible.delete(pn);
    }
    if (!visible.size) return;
    const top = Math.min(...visible);
    if (top === state.topVisiblePage) return;
    state.topVisiblePage = top;
    persistLastPage(top);
    if (bookModeActive(paper)) {
      const ch = chapterForPage(paper.chapters, top);
      if (ch?.id !== state.currentChapter?.id) {
        state.currentChapter = ch;
        renderBookModeChip(paper);
      }
    }
  }, { root: wrap, threshold: 0 });
  for (const p of state.pages) observer.observe(p.wrap);
  state.scrollObserver = observer;
}

function teardownBookMode() {
  if (state.scrollObserver) {
    state.scrollObserver.disconnect();
    state.scrollObserver = null;
  }
  state.currentChapter = null;
  state.topVisiblePage = 1;
  hideBookModeChip();
}

function restoreLastPage(paper) {
  const target = paper.lastPage;
  if (!target || target <= 1) return;
  const page = state.pages.find(p => p.pageNum === target);
  if (!page) return;
  ensurePageRendered(page);
  // 'auto' (no smooth) — restoring shouldn't animate the user across N pages.
  page.wrap.scrollIntoView({ block: 'start' });
  state.topVisiblePage = target;
  if (bookModeActive(paper)) {
    state.currentChapter = chapterForPage(paper.chapters, target);
    renderBookModeChip(paper);
  }
}

function ensureBookModeChipEl() {
  // Vestigial — chapter actions live in the menu attached to the chapter
  // name in the topbar title now. Returned as a hidden node so callers
  // like teardownBookMode → hideBookModeChip don't break.
  let chip = $('#book-mode-chip');
  if (chip) return chip;
  chip = document.createElement('div');
  chip.id = 'book-mode-chip';
  chip.hidden = true;
  document.body.appendChild(chip);
  return chip;
}

function renderBookModeChip(paper) {
  // Refresh the topbar title; the chip itself is gone.
  updatePaperTitle();
}

function toggleBookMode() {
  const paper = state.paper;
  if (!paper) return;
  const active = bookModeActive(paper);
  const next = active ? 'off-manual' : 'on-manual';
  patchPaper(paper, { bookMode: next });
  state.currentChapter = next === 'on-manual'
    ? chapterForPage(paper.chapters, state.topVisiblePage)
    : null;
  renderBookModeChip(paper);
  showToast(
    active ? 'Book mode off — full document in context.' : 'Book mode on — current chapter only.',
    { type: 'info', durationMs: 3000 },
  );
}

// Render the central topbar title: paper name + (when book mode is on
// and a current chapter is detected) the chapter name as a subtitle.
function updatePaperTitle() {
  const paper = state.paper;
  if (!paper) return;
  const baseTitle = paper.title || paper.name || 'Untitled';
  paperTitleEl.classList.add('with-chapter');
  if (bookModeActive(paper) && state.currentChapter) {
    const c = state.currentChapter;
    paperTitleEl.innerHTML =
      `<span class="pt-paper">${escapeHtml(baseTitle)}</span>` +
      `<span class="pt-sep">›</span>` +
      `<span class="pt-chapter"><span class="pt-text">${escapeHtml(c.title)}</span></span>` +
      `<button class="pt-menu-btn" id="pt-menu-btn" type="button" title="Chapter actions" aria-label="Chapter actions" aria-haspopup="menu">⋯</button>`;
    paperTitleEl.title = `${baseTitle} — ${c.title} (pp. ${c.startPage}-${c.endPage})`;
    document.getElementById('pt-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openChapterMenu(e.currentTarget);
    });
  } else {
    paperTitleEl.classList.remove('with-chapter');
    paperTitleEl.textContent = baseTitle;
    paperTitleEl.title = baseTitle;
  }
}

// Popup menu attached to a chapter — opens from the topbar ⋯ button
// (uses state.currentChapter) or from a TOC chapter entry (caller passes
// the chapter object explicitly).
function openChapterMenu(anchor, chapter) {
  document.getElementById('pt-menu')?.remove();
  const paper = state.paper;
  const ch = chapter || state.currentChapter;
  if (!paper || !ch) return;
  const existing = summaryForChapter(paper, ch.id);

  const menu = document.createElement('div');
  menu.id = 'pt-menu';
  menu.className = 'pt-menu';
  menu.setAttribute('role', 'menu');
  const items = [];
  if (existing) {
    items.push({ id: 'open',  label: 'Open chapter site', primary: true });
    items.push({ id: 'trace', label: 'View past run' });
    items.push({ id: 'regen', label: 'Regenerate' });
  } else {
    items.push({ id: 'summarize', label: 'Summarize chapter', primary: true });
  }

  for (const it of items) {
    if (it.divider) {
      const hr = document.createElement('div');
      hr.className = 'pt-menu-divider';
      menu.appendChild(hr);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pt-menu-item' + (it.primary ? ' primary' : '');
    btn.innerHTML = `<span class="pt-menu-label">${escapeHtml(it.label)}</span>`;
    btn.addEventListener('click', () => {
      close();
      if (it.id === 'open' && existing) openChapterSiteInline(existing.indexUrl, `${paper.name || ''} — ${ch.title}`);
      else if (it.id === 'summarize') kickoffChapterSummary(ch);
      else if (it.id === 'regen')     kickoffChapterSummary(ch);
      else if (it.id === 'trace')     openPastRun(paper, ch);
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  // Position below the anchor. If the anchor is on the LEFT half of the
  // viewport (e.g. the ⋯ button in the Contents TOC sidebar), left-align
  // the menu so it extends rightward into visible area. Otherwise (e.g.
  // the topbar ⋯ button), right-align so the menu extends leftward.
  const r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 6) + 'px';
  if (r.left < window.innerWidth / 2) {
    menu.style.left = Math.max(8, r.left) + 'px';
    menu.style.right = 'auto';
  } else {
    menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    menu.style.left = 'auto';
  }

  function close() {
    menu.remove();
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey);
  }
  function onDocClick(e) { if (!menu.contains(e.target)) close(); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  setTimeout(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey);
  }, 0);
}

function hideBookModeChip() {
  const chip = document.getElementById('book-mode-chip');
  if (chip) chip.hidden = true;
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function closePaper() {
  teardownBookMode();
  state.paper = null;
  state.pages = [];
  state.threads = [];
  state.activeThreadId = null;
  paperTitleEl.textContent = 'No paper open';
  document.title = 'paperchat';
  $('#zoom-controls').hidden = true;
  $('#new-whole-btn').hidden = true;
  viewer.innerHTML = '';
  viewer.appendChild(viewerPlaceholder);
  viewerPlaceholder.style.display = 'block';
  viewerPlaceholder.innerHTML = '<p>Open or drop a PDF to begin.</p>';
  passageList.innerHTML = '';
  wholeList.innerHTML = '';
  passageEmpty.hidden = false;
  wholeEmpty.hidden = false;
  $('#contents-panel').hidden = true;
}

// ---- Threads (sidebar list + highlights) ----

function redrawHighlights() {
  clearHighlights(state.pages);
  const currentScale = BASE_SCALE * state.zoomFactor;
  for (const t of state.threads) {
    const page = state.pages.find(p => p.pageNum === t.pageNum);
    if (!page) continue;
    // anchorScale defaults to BASE_SCALE for threads created before the zoom
    // feature shipped (they were always captured at the base scale).
    const ratio = currentScale / (t.anchorScale || BASE_SCALE);
    drawHighlight(page, t, {
      active: t.id === state.activeThreadId,
      ratio,
      onClick: openThread,
    });
  }
}

async function renderThreadList() {
  // Prefetch all messages BEFORE touching the DOM so concurrent calls can't interleave appends.
  const data = await Promise.all(
    state.threads.map(async t => ({ t, msgs: await Messages.byThread(t.id) }))
  );
  const passage = data.filter(d => d.t.pageNum);
  const whole = data.filter(d => !d.t.pageNum);

  passageList.innerHTML = '';
  passageEmpty.hidden = passage.length > 0;
  for (const { t, msgs } of passage) passageList.appendChild(buildThreadCard(t, msgs));

  wholeList.innerHTML = '';
  wholeEmpty.hidden = whole.length > 0;
  for (const { t, msgs } of whole) wholeList.appendChild(buildThreadCard(t, msgs));
}

function buildThreadCard(t, msgs) {
  const li = document.createElement('li');
  const inflight = state.inflight.has(t.id);
  li.className = 'thread-card'
    + (t.id === state.activeThreadId ? ' active' : '')
    + (inflight ? ' inflight' : '');
  const last = msgs[msgs.length - 1];
  const lastText = last
    ? (last.role === 'assistant' ? `${last.mention || '@?'}: ${stripMd(last.content)}` : stripMd(last.content))
    : '(empty)';
  const isWhole = !t.pageNum;
  const meta = isWhole
    ? `whole paper · ${msgs.length} msg${msgs.length === 1 ? '' : 's'}`
    : `p.${t.pageNum} · ${msgs.length} msg${msgs.length === 1 ? '' : 's'}`;
  li.innerHTML = `
    <div class="quote"></div>
    <div class="last"></div>
    <div class="meta"><span>${meta}</span><span class="time"></span></div>
  `;
  li.querySelector('.quote').textContent = isWhole ? '(whole paper)' : t.quote;
  if (isWhole) li.querySelector('.quote').classList.add('whole');
  li.querySelector('.last').textContent = lastText;
  li.querySelector('.time').textContent = relTime(t.createdAt);
  li.addEventListener('click', () => openThread(t.id));
  const delBtn = document.createElement('button');
  delBtn.className = 'thread-card-del';
  delBtn.title = 'Delete thread';
  delBtn.textContent = '✕';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!await confirmAction('Delete this thread and its messages?')) return;
    await deleteThread(t.id);
  });
  li.appendChild(delBtn);
  return li;
}

async function deleteThread(id) {
  await Threads.delete(id);
  state.threads = state.threads.filter(x => x.id !== id);
  if (state.activeThreadId === id) {
    state.activeThreadId = null;
    if (threadDlg.open) threadDlg.close();
  }
  redrawHighlights();
  renderThreadList();
}

function setMarkdown(el, text) {
  el.innerHTML = stashMathAndRunMarked(preprocessMarkdownMath(text || ''));
  for (const a of el.querySelectorAll('a')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  // Syntax-highlight fenced code blocks (e.g. ```python ... ```)
  if (window.hljs) {
    for (const block of el.querySelectorAll('pre code')) {
      // Skip blocks already highlighted (avoids re-highlight churn during streaming)
      if (block.dataset.highlighted) continue;
      try {
        window.hljs.highlightElement(block);
        block.dataset.highlighted = '1';
      } catch {}
    }
  }
  // Auto-fix common LaTeX subscript mistakes the model loves to make
  // (e.g. `\mathcal{L}{x}` → `\mathcal{L}_{x}`, `\sum{i}` → `\sum_{i}`).
  // Runs on text nodes only, skipping <pre>/<code>, before KaTeX renders.
  fixMathInDom(el);
  renderMathIn(el);
}

// Auto-scroll behavior: stay pinned to bottom by default, but back off if the
// user scrolls up while a reply is streaming so they can read earlier content
// without being yanked back. Resumes pinning when they scroll back to bottom.
let _pinned = true;
threadMsgsEl.addEventListener('scroll', () => {
  const distance = threadMsgsEl.scrollHeight - threadMsgsEl.scrollTop - threadMsgsEl.clientHeight;
  _pinned = distance < 40;
});
function scrollIfPinned() {
  if (_pinned) threadMsgsEl.scrollTop = threadMsgsEl.scrollHeight;
}
function scrollToBottomNow() {
  _pinned = true;
  threadMsgsEl.scrollTop = threadMsgsEl.scrollHeight;
}

// Streaming-aware body painter: setMarkdown rewrites innerHTML, which destroys
// any selection the user has inside the body. While they're actively selecting
// text in this body, defer the render — the latest text is stashed and flushed
// once the selection moves away or collapses, so they can copy mid-stream.
const _selectionPending = new Set();
function selectionInside(el) {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    if (el.contains(r.startContainer) || el.contains(r.endContainer)) return true;
  }
  return false;
}
function paintLiveBody(el, text) {
  if (selectionInside(el)) {
    el._pendingText = text;
    _selectionPending.add(el);
    return;
  }
  el._pendingText = null;
  _selectionPending.delete(el);
  setMarkdown(el, text);
  // Only show the blinking cursor while streaming is still active for this
  // card — a deferred flush after stream-end shouldn't re-add it.
  const card = el.closest('.msg.assistant');
  const stillStreaming = card && [...state.inflight.values()].some(v => v.card === card);
  if (stillStreaming) {
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    cursor.textContent = '▍';
    el.appendChild(cursor);
  }
  scrollIfPinned();
}
document.addEventListener('selectionchange', () => {
  for (const el of [..._selectionPending]) {
    if (!selectionInside(el)) paintLiveBody(el, el._pendingText ?? '');
  }
});

window.addEventListener('load', () => {
  if (!window.renderMathInElement) return;
  // Re-render every assistant body in the current DOM (cheap, idempotent).
  for (const body of document.querySelectorAll('.msg.assistant .body')) {
    renderMathIn(body);
  }
});

function stripMd(s) {
  return (s || '').replace(/[#*`_>]/g, '').trim().slice(0, 120);
}

function relTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

// ---- Selection capture ----

document.addEventListener('mouseup', (e) => {
  if (!state.paper) return;
  // Don't trigger when clicking inside the floating button itself
  if (floatingAsk.contains(document.activeElement)) return;
  // Don't trigger when clicking inside any open <dialog> — otherwise clicks
  // on the dialog (Send, Cancel, etc.) hit-test against highlights underneath
  // the modal and accidentally open another thread.
  if (e.target instanceof Element && e.target.closest('dialog')) return;
  const cap = captureSelection(state.pages);
  if (cap) {
    state.pendingSelection = cap;
    showFloatingAsk(cap);
    return;
  }
  state.pendingSelection = null;
  floatingAsk.hidden = true;
  // No selection — treat as click. Only open a thread when the click landed
  // inside a rendered .page-wrap. Otherwise we'd hit-test scrollbar releases,
  // empty gutter clicks, etc., which would auto-scroll the viewer to a
  // random thread the cursor happened to be over.
  if (!(e.target instanceof Element) || !e.target.closest('.page-wrap')) return;
  const threadId = threadAtPoint(e.clientX, e.clientY);
  if (threadId) openThread(threadId);
});

function threadAtPoint(clientX, clientY) {
  // Search in reverse insertion order so newer highlights win ties.
  let hit = null;
  for (const page of state.pages) {
    const els = page.highlightLayer.querySelectorAll('.highlight[data-thread-id]');
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        hit = el.dataset.threadId;
      }
    }
  }
  return hit;
}

document.addEventListener('mousedown', (e) => {
  if (!floatingAsk.contains(e.target)) {
    floatingAsk.hidden = true;
  }
});

function showFloatingAsk(cap) {
  // Position relative to viewer-wrap (offsetParent of floatingAsk).
  const wrapRect = cap.anchor.pageWrap.getBoundingClientRect();
  const parentRect = floatingAsk.parentElement.getBoundingClientRect();
  const left = wrapRect.left - parentRect.left + cap.anchor.x - 60;
  const top = wrapRect.top - parentRect.top + cap.anchor.y + 6
    + floatingAsk.parentElement.scrollTop;
  floatingAsk.style.left = Math.max(8, left) + 'px';
  floatingAsk.style.top = top + 'px';
  floatingAsk.hidden = false;
}

floatingAsk.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', async () => {
    const mention = btn.dataset.mention;
    if (!state.pendingSelection) return;
    await startThread(state.pendingSelection, mention);
    floatingAsk.hidden = true;
    window.getSelection()?.removeAllRanges();
  });
});

async function startThread(cap, defaultMention) {
  const t = {
    id: uid(),
    paperId: state.paper.id,
    pageNum: cap.pageNum,
    quote: cap.quote,
    anchorRects: cap.rects,
    anchorScale: BASE_SCALE * state.zoomFactor,
    defaultMention,
    createdAt: Date.now(),
  };
  await Threads.put(t);
  state.threads.push(t);
  redrawHighlights();
  await openThread(t.id, { prefill: defaultMention + ' ' });
}

// Whole-paper thread (no selection). Distinguished by pageNum=null + empty quote.
async function startWholePaperThread(defaultMention) {
  if (!state.paper) return;
  const t = {
    id: uid(),
    paperId: state.paper.id,
    pageNum: null,
    quote: '',
    anchorRects: [],
    defaultMention,
    createdAt: Date.now(),
    wholePaper: true,
  };
  await Threads.put(t);
  state.threads.push(t);
  await openThread(t.id, { prefill: defaultMention + ' ' });
}

// "+ new whole-paper thread" button + popover with mention picker.
const newWholeBtn = $('#new-whole-btn');
const newWholePopover = $('#new-whole-popover');
newWholeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  newWholePopover.hidden = !newWholePopover.hidden;
});
document.addEventListener('click', (e) => {
  if (newWholePopover.hidden) return;
  if (e.target.closest('#new-whole-popover, #new-whole-btn')) return;
  newWholePopover.hidden = true;
});
for (const btn of newWholePopover.querySelectorAll('.ntr-btn')) {
  btn.addEventListener('click', () => {
    newWholePopover.hidden = true;
    startWholePaperThread(btn.dataset.mention);
  });
}

// ---- Thread dialog ----

async function openThread(id, { prefill = '' } = {}) {
  const t = state.threads.find(x => x.id === id) || await Threads.get(id);
  if (!t) return;
  state.activeThreadId = id;
  // Scroll the viewer to the anchor first (smooth) so when the user dismisses
  // the dialog they're at the right spot. Fire-and-forget; no-op for whole
  // paper threads.
  scrollViewerToThread(t);
  const isWhole = !t.pageNum;
  threadDlgTitle.textContent = isWhole
    ? `Whole paper · default ${t.defaultMention}`
    : `Page ${t.pageNum} · default ${t.defaultMention}`;
  if (isWhole) {
    threadQuoteEl.hidden = true;
  } else {
    threadQuoteEl.hidden = false;
    threadQuoteEl.textContent = t.quote;
  }
  threadMsgsEl.innerHTML = '';
  const msgs = await Messages.byThread(id);
  for (const m of msgs) renderMessage(m);
  // Reattach an in-flight streaming card if one exists for this thread —
  // the request kept running while the dialog was closed or showing a
  // different thread; now that the user is viewing this thread again, hook
  // its live output back into the DOM.
  const liveEntry = state.inflight.get(id);
  if (liveEntry) threadMsgsEl.appendChild(liveEntry.card);
  threadInput.value = prefill;
  syncSendButton();
  threadDlg.showModal();
  scrollToBottomNow(); // opening a thread always jumps to the latest message
  if (prefill) threadInput.focus();
  redrawHighlights();
  renderThreadList();
}

// X button just closes the dialog; the 'close' event handler does the cleanup
// once, regardless of whether the user clicked X or hit Esc.
threadDlgClose.addEventListener('click', () => threadDlg.close());

// Click outside the dialog (on the backdrop) closes it. target===threadDlg
// alone isn't enough: it's also true for the resize handle and any padding
// inside the dialog box, so we'd close on innocuous in-dialog clicks. Gate
// on the click coordinates being OUTSIDE the dialog's bounding rect — that
// uniquely identifies a backdrop click.
threadDlg.addEventListener('mousedown', (e) => {
  if (e.target !== threadDlg) return;
  const r = threadDlg.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right
              && e.clientY >= r.top  && e.clientY <= r.bottom;
  if (!inside) threadDlg.close();
});

$('#thread-delete').addEventListener('click', async () => {
  if (!state.activeThreadId) return;
  const id = state.activeThreadId;
  // Close the thread dialog first so the confirm dialog isn't stacked on it.
  threadDlg.close();
  if (!await confirmAction('Delete this thread and its messages?')) return;
  await deleteThread(id);
});

threadDlg.addEventListener('close', () => {
  state.activeThreadId = null;
  redrawHighlights();
  renderThreadList();
});

function renderMessage(m) {
  const div = document.createElement('div');
  const cls = m.role === 'assistant' ? `msg assistant ${mentionClass(m.mention || '@claude')}` : 'msg user';
  div.className = cls;
  const who = m.role === 'assistant' ? (m.mention || '@ai') : 'you';
  div.innerHTML = `<div class="who">${escapeHtml(who)}</div>`;

  if (m.role === 'assistant' && m.segments?.length) {
    // Interleaved layout: render text segments and tool cards in fired order.
    for (const seg of m.segments) {
      if (seg.type === 'text') {
        const body = document.createElement('div');
        body.className = 'body';
        setMarkdown(body, seg.content || '');
        div.appendChild(body);
      } else if (seg.type === 'tool') {
        div.appendChild(buildToolCard(seg.tc));
      }
    }
  } else {
    // Legacy / user messages: single body + trailing tool cards.
    const body = document.createElement('div');
    body.className = 'body';
    if (m.role === 'assistant') {
      setMarkdown(body, m.content || '');
    } else {
      body.innerHTML = escapeHtml(m.content);
    }
    div.appendChild(body);
    if (m.toolCalls?.length) {
      for (const tc of m.toolCalls) div.appendChild(buildToolCard(tc));
    }
  }
  threadMsgsEl.appendChild(div);
  scrollIfPinned();
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

threadInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    threadForm.requestSubmit();
  }
});

threadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = threadInput.value.trim();
  if (!text || !state.activeThreadId) return;
  const t = state.threads.find(x => x.id === state.activeThreadId);
  if (!t) return;

  const parsed = parseMention(text);
  const mention = parsed?.mention || t.defaultMention;
  const body = parsed ? parsed.body : text;

  // Persist user message
  const userMsg = {
    id: uid(),
    threadId: t.id,
    role: 'user',
    content: text,
    createdAt: Date.now(),
  };
  await Messages.put(userMsg);
  renderMessage(userMsg);
  threadInput.value = '';
  syncSendButton();

  // Build history for the model: strip leading @mention from user content for cleanliness.
  const history = (await Messages.byThread(t.id)).map(m => {
    if (m.role === 'user') return { role: 'user', content: stripLeadingMention(m.content) };
    if (m.role === 'assistant') return { role: 'assistant', content: m.content };
    return null;
  }).filter(Boolean);
  // Last user message: ensure it carries the explicit body.
  history[history.length - 1] = { role: 'user', content: body || stripLeadingMention(text) };

  // Stream into a live assistant card with tool cards interleaved at the
  // position they fire (text segment → tool card → text segment → ...).
  const card = createStreamingCard(mention);
  threadMsgsEl.appendChild(card.el);
  // Track this request as inflight for the thread so it survives dialog close
  // / thread-switch — re-renders the thread list to show a busy indicator.
  // Controller wires through to fetch() so the stop button can abort.
  const controller = new AbortController();
  state.inflight.set(t.id, { card: card.el, controller });
  syncSendButton();
  renderThreadList();
  scrollToBottomNow(); // user just hit Send — re-pin to bottom

  const segments = [];      // [{ type: 'text', content } | { type: 'tool', tc }]
  let segText = '';
  let currentBody = card.body;
  const toolCalls = [];

  function freezeCurrentSegment() {
    if (segText.trim()) {
      segments.push({ type: 'text', content: segText });
      segText = '';
      // Body is being frozen — discard any deferred-render entry so a stale
      // _pendingText doesn't get flushed onto a no-longer-active body.
      _selectionPending.delete(currentBody);
      currentBody._pendingText = null;
      // Strip blinking cursor on the now-frozen segment
      currentBody.querySelectorAll('.cursor').forEach(c => c.remove());
      const newBody = document.createElement('div');
      newBody.className = 'body';
      newBody.innerHTML = '<span class="cursor">▍</span>';
      card.el.appendChild(newBody);
      currentBody = newBody;
    }
    // If currentBody is empty (segText was blank), reuse it for upcoming text.
  }

  try {
    const { content } = await streamChat({
      paperTitle: state.paper.name,
      paperPagesText: state.paper.pagesText,
      thread: t,
      history,
      mention,
      viewer: viewerCapabilities(),
      python: pythonCapability(),
      signal: controller.signal,
      chapters: bookModeActive(state.paper) ? state.paper.chapters : null,
      currentChapter: bookModeActive(state.paper)
        ? (t.pageNum
            ? chapterForPage(state.paper.chapters, t.pageNum)
            : state.currentChapter)
        : null,
      onDelta: (delta) => {
        segText += delta;
        paintLiveBody(currentBody, segText);
      },
      onToolCall: (tc) => {
        toolCalls.push(tc);
        freezeCurrentSegment();
        const tcEl = buildToolCard(tc);
        // Insert tool card before the (empty) currentBody so order is preserved
        card.el.insertBefore(tcEl, currentBody);
        segments.push({ type: 'tool', tc });
        scrollIfPinned();
      },
    });

    // Final segment: persist whatever text was streaming when the loop ended.
    if (segText.trim()) {
      setMarkdown(currentBody, segText);
      segments.push({ type: 'text', content: segText });
    } else if (content && !segments.some(s => s.type === 'text')) {
      // Edge case: model only returned a final non-streamed content payload.
      setMarkdown(currentBody, content);
      segments.push({ type: 'text', content });
    } else {
      // No trailing text — drop the empty body.
      currentBody.remove();
    }
    // Strip any leftover cursors
    card.el.querySelectorAll('.cursor').forEach(c => c.remove());

    const finalText = segments.filter(s => s.type === 'text').map(s => s.content).join('\n\n');
    const aiMsg = {
      id: uid(),
      threadId: t.id,
      role: 'assistant',
      mention,
      content: finalText,
      toolCalls,
      segments,
      createdAt: Date.now(),
    };
    await Messages.put(aiMsg);
    renderThreadList();
  } catch (err) {
    card.el.querySelectorAll('.cursor').forEach(c => c.remove());
    const stopped = err?.name === 'AbortError';
    // Persist whatever text streamed before the abort, plus a [stopped] tag —
    // an aborted reply is partial but worth keeping so the user can re-prompt
    // with context. A real error gets the bold "Error:" treatment.
    if (stopped) {
      const partial = segText.trim() ? segText + '\n\n_[stopped]_' : '_[stopped]_';
      setMarkdown(currentBody, partial);
      segments.push({ type: 'text', content: partial });
      const finalText = segments.filter(s => s.type === 'text').map(s => s.content).join('\n\n');
      await Messages.put({
        id: uid(), threadId: t.id, role: 'assistant', mention,
        content: finalText, toolCalls, segments, createdAt: Date.now(),
      });
    } else {
      setMarkdown(currentBody, `**Error:** ${err.message}`);
      await Messages.put({
        id: uid(), threadId: t.id, role: 'assistant', mention,
        content: `**Error:** ${err.message}`, createdAt: Date.now(),
      });
    }
  } finally {
    state.inflight.delete(t.id);
    syncSendButton();
    renderThreadList();
  }
});

// The send/stop buttons reflect whether the currently-open thread has an
// in-flight request. Other threads' inflight state doesn't affect them —
// each thread tracks its own controller.
function syncSendButton() {
  const hasInflight = state.activeThreadId && state.inflight.has(state.activeThreadId);
  if (!state.activeThreadId) { threadSend.disabled = true; threadStop.hidden = true; return; }
  threadSend.disabled = hasInflight;
  threadStop.hidden = !hasInflight;
}

threadStop.addEventListener('click', () => {
  const id = state.activeThreadId;
  if (!id) return;
  const entry = state.inflight.get(id);
  entry?.controller?.abort();
});

function buildToolCard(tc) {
  const argsStr = (() => {
    try { return JSON.stringify(tc.args, null, 0); } catch { return String(tc.args); }
  })();
  const summary = `${tc.name}(${argsStr.length > 80 ? argsStr.slice(0, 80) + '…' : argsStr})`;
  const status = tc.ok === false ? '✗' : '✓';
  const detailsEl = document.createElement('details');
  detailsEl.className = 'tool-card' + (tc.ok === false ? ' fail' : '');
  const sum = document.createElement('summary');
  sum.innerHTML = `<span class="tstatus">${status}</span> <span class="tname">${escapeHtml(tc.name)}</span><span class="tsig">${escapeHtml(summary.slice(tc.name.length))}</span>`;
  detailsEl.appendChild(sum);
  const body = document.createElement('div');
  body.className = 'tcontent';
  const argsBlock = document.createElement('pre');
  argsBlock.className = 'tblock';
  argsBlock.textContent = 'args: ' + argsStr;
  body.appendChild(argsBlock);
  if (tc.error) {
    const errBlock = document.createElement('pre');
    errBlock.className = 'tblock terr';
    errBlock.textContent = 'error: ' + tc.error;
    body.appendChild(errBlock);
  }
  if (tc.result != null) {
    const resBlock = document.createElement('pre');
    resBlock.className = 'tblock';
    const text = String(tc.result);
    resBlock.textContent = 'result: ' + (text.length > 4000 ? text.slice(0, 4000) + '\n…[truncated]' : text);
    body.appendChild(resBlock);
  }
  detailsEl.appendChild(body);

  // Inline artifact preview: any tool call whose args carry an HTML/SVG/markdown
  // payload gets a sandboxed iframe right inside the message, so the user
  // doesn't have to open files in a separate tab.
  const artifact = detectArtifact(tc);
  if (artifact && tc.ok !== false) {
    const wrap = document.createElement('div');
    wrap.className = 'tool-card-wrap';
    wrap.appendChild(detailsEl);
    wrap.appendChild(buildArtifactBlock(artifact));
    return wrap;
  }
  return detailsEl;
}

// Recognize common shapes of "artifact-producing" tool calls. Returns
// { kind: 'html'|'svg'|'markdown', content, label } or null.
function detectArtifact(tc) {
  if (!tc || !tc.args) return null;
  const path = (tc.args.file_path || tc.args.filepath || tc.args.path || '').toLowerCase();
  const content = tc.args.content || tc.args.body || tc.args.html;
  if (!content || typeof content !== 'string') return null;
  if (/\.html?$/.test(path) || /^<!doctype html|<html[\s>]/i.test(content.slice(0, 200))) {
    return { kind: 'html', content, label: path || 'artifact.html' };
  }
  if (/\.svg$/.test(path) || /^<svg[\s>]/i.test(content.slice(0, 200))) {
    return { kind: 'svg', content, label: path || 'artifact.svg' };
  }
  if (/\.(md|markdown)$/.test(path)) {
    return { kind: 'markdown', content, label: path };
  }
  return null;
}

function buildArtifactBlock(art) {
  const wrap = document.createElement('div');
  wrap.className = 'artifact';

  const head = document.createElement('div');
  head.className = 'artifact-head';
  head.innerHTML = `<span class="artifact-label">📎 ${escapeHtml(art.label)}</span>`;
  const expandBtn = document.createElement('button');
  expandBtn.className = 'artifact-expand';
  expandBtn.textContent = 'Open full';
  expandBtn.title = 'Open in a new tab';
  expandBtn.addEventListener('click', () => openArtifactFull(art));
  head.appendChild(expandBtn);
  wrap.appendChild(head);

  const frameWrap = document.createElement('div');
  frameWrap.className = 'artifact-frame';
  if (art.kind === 'svg') {
    // Inline SVG so it scales naturally with the card; no iframe needed.
    frameWrap.innerHTML = art.content;
  } else if (art.kind === 'html') {
    const iframe = document.createElement('iframe');
    iframe.className = 'artifact-iframe';
    iframe.sandbox = 'allow-scripts'; // no allow-same-origin → can't reach app state
    iframe.srcdoc = art.content;
    iframe.loading = 'lazy';
    frameWrap.appendChild(iframe);
  } else if (art.kind === 'markdown') {
    const md = document.createElement('div');
    md.className = 'body';
    setMarkdown(md, art.content);
    frameWrap.appendChild(md);
  }
  wrap.appendChild(frameWrap);
  return wrap;
}

function openArtifactFull(art) {
  const win = window.open('', '_blank');
  if (!win) {
    showToast('Pop-up blocked — allow pop-ups for paperchat to use "Open full".', { type: 'error' });
    return;
  }
  if (art.kind === 'html') {
    win.document.open(); win.document.write(art.content); win.document.close();
  } else if (art.kind === 'svg') {
    win.document.open();
    win.document.write(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(art.label)}</title><body style="margin:0;display:flex;align-items:center;justify-content:center;background:#1a1a1a">${art.content}</body>`);
    win.document.close();
  } else if (art.kind === 'markdown') {
    win.document.open();
    win.document.write(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(art.label)}</title><pre style="white-space:pre-wrap;font:14px ui-serif;padding:24px;max-width:780px;margin:auto">${escapeHtml(art.content)}</pre>`);
    win.document.close();
  }
}

function showToast(message, opts = {}) {
  const { type = 'info', durationMs = 3500, action = null } = opts;
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  // Card-style toast: icon · text · (optional action) · close · progress bar
  // — matches the side-stack reference. The bottom progress bar shrinks
  // over `durationMs` so the user can see how much time is left.
  const icons = { info: 'ℹ', success: '✓', warn: '!', error: '✗' };
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</span>
    <span class="toast-msg"></span>
  `;
  t.querySelector('.toast-msg').textContent = message;
  if (action && action.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    t.appendChild(btn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.innerHTML = '&times;';
  t.appendChild(closeBtn);
  const bar = document.createElement('div');
  bar.className = 'toast-bar';
  t.appendChild(bar);
  host.appendChild(t);
  requestAnimationFrame(() => {
    t.classList.add('show');
    bar.style.transition = `transform ${durationMs}ms linear`;
    bar.style.transform = 'scaleX(0)';
  });
  const dismiss = () => {
    if (t.classList.contains('toast-out')) return;
    t.classList.remove('show');
    t.classList.add('toast-out');
    setTimeout(() => t.remove(), 250);
  };
  closeBtn.addEventListener('click', dismiss);
  if (action) {
    t.querySelector('.toast-action').addEventListener('click', () => {
      try { action.onClick(); } finally { dismiss(); }
    });
  }
  setTimeout(dismiss, durationMs);
}

const confirmAction = (() => {
  let dlg, msgEl, cancelBtn, okBtn;
  function ensure() {
    if (dlg) return;
    dlg = document.createElement('dialog');
    dlg.className = 'confirm-dialog';
    dlg.innerHTML = `
      <p class="confirm-msg"></p>
      <div class="confirm-actions">
        <button type="button" class="confirm-cancel">Cancel</button>
        <button type="button" class="confirm-ok">OK</button>
      </div>
    `;
    document.body.appendChild(dlg);
    msgEl = dlg.querySelector('.confirm-msg');
    cancelBtn = dlg.querySelector('.confirm-cancel');
    okBtn = dlg.querySelector('.confirm-ok');
  }
  return function (message, { confirmLabel = 'Delete', destructive = true } = {}) {
    ensure();
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    okBtn.classList.toggle('destructive', destructive);
    return new Promise((resolve) => {
      function cleanup(result) {
        cancelBtn.removeEventListener('click', onCancel);
        okBtn.removeEventListener('click', onOk);
        dlg.removeEventListener('cancel', onCancel);
        if (dlg.open) dlg.close();
        resolve(result);
      }
      const onCancel = (e) => { e?.preventDefault?.(); cleanup(false); };
      const onOk = () => cleanup(true);
      cancelBtn.addEventListener('click', onCancel);
      okBtn.addEventListener('click', onOk);
      dlg.addEventListener('cancel', onCancel);
      dlg.showModal();
      cancelBtn.focus();
    });
  };
})();

function viewerCapabilities() {
  return {
    scrollToPage(p) { jumpToPage(p); },
    highlightPassage(pageNum, quote) {
      const page = state.pages.find(x => x.pageNum === pageNum);
      if (!page) return false;
      return highlightQuoteOnPage(page, quote);
    },
  };
}

// Pyodide loaded lazily on first use; persists across calls in the session.
let _pyodide = null;
let _pyodideLoading = null;

function pythonCapability() {
  return {
    async run(code) {
      const py = await getPyodide();
      let stdout = '', stderr = '';
      py.setStdout({ batched: (s) => { stdout += s + '\n'; } });
      py.setStderr({ batched: (s) => { stderr += s + '\n'; } });
      try { await py.loadPackagesFromImports(code); } catch {}
      let result;
      try {
        result = await py.runPythonAsync(code);
      } catch (e) {
        return [
          stdout && `stdout:\n${stdout}`,
          stderr && `stderr:\n${stderr}`,
          `error: ${e.message || e}`,
        ].filter(Boolean).join('\n\n');
      }
      const reprResult = (result === undefined || result === null)
        ? ''
        : `result: ${typeof result === 'object' && result.toString ? result.toString() : String(result)}`;
      return [
        stdout && `stdout:\n${stdout.trimEnd()}`,
        stderr && `stderr:\n${stderr.trimEnd()}`,
        reprResult,
      ].filter(Boolean).join('\n\n') || '(no output)';
    },
  };
}

async function getPyodide() {
  if (_pyodide) return _pyodide;
  if (!_pyodideLoading) {
    _pyodideLoading = (async () => {
      // Lazy-load the Pyodide bootstrap script
      if (!window.loadPyodide) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
          s.onload = resolve;
          s.onerror = () => reject(new Error('failed to load pyodide.js'));
          document.head.appendChild(s);
        });
      }
      _pyodide = await window.loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
      });
      return _pyodide;
    })();
  }
  return _pyodideLoading;
}

function createStreamingCard(mention) {
  const el = document.createElement('div');
  el.className = `msg assistant ${mentionClass(mention)}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = mention;
  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = '<span class="cursor">▍</span>';
  el.append(who, body);
  return { el, body };
}

function stripLeadingMention(text) {
  const p = parseMention(text);
  return p ? p.body : text;
}

// ---- Settings ----

$('#btn-settings').addEventListener('click', () => {
  if (envKey()) {
    settingsKey.value = '';
    settingsKey.placeholder = '(loaded from .env)';
    settingsKey.disabled = true;
  } else {
    settingsKey.value = localStorage.getItem('fermat.openrouter.key') || '';
    settingsKey.placeholder = 'sk-or-...';
    settingsKey.disabled = false;
  }
  const m = getModels();
  settingsClaude.value = m['@claude'] || '';
  settingsGrok.value = m['@grok'] || '';
  settingsGpt.value = m['@gpt'] || '';
  settingsChapterPlanner.value = m['@chapter.planner'] || '';
  settingsChapterWriter.value = m['@chapter.writer'] || '';
  // Default on: auto-open the live preview the moment index.html lands.
  settingsChapterAutoOpen.checked = localStorage.getItem('paperchat.chsum.autoOpen') !== '0';
  settingsDlg.showModal();
});
$('#settings-cancel').addEventListener('click', () => settingsDlg.close());
settingsForm.addEventListener('submit', () => {
  setKey(settingsKey.value.trim());
  setModels({
    '@claude': settingsClaude.value.trim() || undefined,
    '@grok': settingsGrok.value.trim() || undefined,
    '@gpt': settingsGpt.value.trim() || undefined,
    '@chapter.planner': settingsChapterPlanner.value.trim() || undefined,
    '@chapter.writer': settingsChapterWriter.value.trim() || undefined,
  });
  localStorage.setItem('paperchat.chsum.autoOpen', settingsChapterAutoOpen.checked ? '1' : '0');
});

// ---- Chapter summary (interactive HTML chapter site) ----
async function kickoffChapterSummary(chapter) {
  const paper = state.paper;
  if (!paper) return;
  const ch = chapter || state.currentChapter || chapterForPage(paper.chapters, state.topVisiblePage);
  if (!ch) {
    showToast('Open book mode on a chapter first.', { type: 'warn', durationMs: 3000 });
    return;
  }

  // A fresh kickoff is a regenerate from the user's POV — wipe the
  // existing tab (steps, log, tokens, cost) before opening a new one
  // so progress doesn't accumulate across runs.
  resetChapterTab(ch.id);

  const panel = openChapterSummaryPanel(paper, ch);
  panel.log(`Paper: ${paper.name || '(untitled)'}`);
  panel.log(`Chapter: ${ch.title}  (pp. ${ch.startPage}-${ch.endPage})`);
  panel.log('Encoding PDF…');

  // Base64-encode the PDF in chunks to avoid stack overflows on big files.
  const buf = new Uint8Array(await paper.blob.arrayBuffer());
  let s = '';
  const chunk = 32_768;
  for (let i = 0; i < buf.length; i += chunk) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  const pdfBase64 = btoa(s);
  panel.log(`PDF: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);

  const models = getModels();
  const body = {
    paperId: paper.id,
    chapterId: ch.id,
    paperName: paper.name || 'Untitled',
    chapterTitle: ch.title,
    startPage: ch.startPage,
    endPage: ch.endPage,
    pdfBase64,
    plannerModel: models['@chapter.planner'],
    writerModel: models['@chapter.writer'],
  };

  panel.log('POST /api/chapter_summary');
  const resp = await fetch('/api/chapter_summary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    panel.log(`Error: ${resp.status} ${await resp.text()}`);
    return;
  }
  await consumeSseToPanel(resp, panel);
}

// Reads an SSE stream from a fetch Response and routes each event to a
// progress panel. Shared by fresh kickoff (POST /api/chapter_summary) and
// replay/reattach (GET /api/chapter_runs/replay) paths.
async function consumeSseToPanel(resp, panel) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, nl);
      pending = pending.slice(nl + 2);
      if (!frame.startsWith('data:')) continue;
      const payload = frame.slice(5).trim();
      try { handleChapterSummaryEvent(panel, JSON.parse(payload)); }
      catch {}
    }
  }
}

// On paper open, reattach progress panels to any chapter runs whose
// trace.jsonl exists but doesn't have a terminal event yet (page reload
// during regeneration → don't lose the run).
// Open the chsum panel for a chapter whose run is already complete
// (or stale) and replay the saved trace.jsonl from disk. Same UI as
// a live run — steps, log, tokens, workers — just historical. Useful
// when the user wants to inspect what the agent did without
// regenerating. resetChapterTab() wipes any prior tab state for this
// chapter first so the replay starts clean.
async function openPastRun(paper, ch) {
  if (!paper?.id || !ch?.id) return;
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const dirName = `chapter-${safe(paper.id)}-${safe(ch.id)}`;
  resetChapterTab(ch.id);
  const panel = openChapterSummaryPanel(paper, ch);
  // Suppress the side-effects that a LIVE run produces: don't
  // auto-open the chapter site iframe on the index.html write, and
  // don't fire the completion toast / button-pop on the done event.
  // The user explicitly asked for the trace; they're not building
  // anything, they're inspecting history.
  panel._replaying = true;
  panel._indexNotified = true;  // skips the index.html auto-open + toast
  panel.log(`Replaying past run for "${ch.title}"…`);
  let resp;
  try {
    resp = await fetch(`/api/chapter_runs/replay?dir=${encodeURIComponent(dirName)}`);
  } catch (e) {
    panel.log(`Replay request failed: ${e.message}`);
    return;
  }
  if (!resp.ok) {
    panel.log(`Replay failed: ${resp.status} ${await resp.text().catch(() => '')}`);
    return;
  }
  consumeSseToPanel(resp, panel).catch(() => {});
}

async function reattachActiveRuns(paper) {
  if (!paper?.id) return;
  let runs;
  try {
    const r = await fetch(`/api/chapter_runs/active?paperId=${encodeURIComponent(paper.id)}`);
    if (!r.ok) return;
    runs = await r.json();
  } catch { return; }
  if (!Array.isArray(runs) || !runs.length) return;
  // Map dirName "chapter-<paperId>-<chapterId>" → the chapter itself.
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const prefix = `chapter-${safe(paper.id)}-`;
  for (const run of runs) {
    const chapterIdSafe = run.dirName.slice(prefix.length);
    const ch = (paper.chapters || []).find(c => safe(c.id) === chapterIdSafe || c.id === chapterIdSafe);
    if (!ch) continue;
    const panel = openChapterSummaryPanel(paper, ch);
    panel.log(`Reattaching to run for "${ch.title}" (status: ${run.status || 'unknown'})…`);
    panel.log(`(trace.jsonl has ${run.lineCount} lines so far)`);

    // If the run is stale (agent process died with the server), kick off
    // a SDK resume — it appends to the same trace.jsonl and /replay
    // below tails it.
    if (run.status === 'stale') {
      panel.log('Run is stale — asking the Agent SDK to continue…');
      fetch(`/api/chapter_runs/resume?dir=${encodeURIComponent(run.dirName)}`, {
        method: 'POST',
      }).catch(() => {});
      // Deliberately fire-and-forget; the trace is the rendezvous point.
    }

    const resp = await fetch(`/api/chapter_runs/replay?dir=${encodeURIComponent(run.dirName)}`);
    if (!resp.ok) {
      panel.log(`Replay failed: ${resp.status}`);
      continue;
    }
    consumeSseToPanel(resp, panel).catch(() => {});
  }
}

function handleChapterSummaryEvent(panel, ev) {
  // 1) Conversation log — rich DOM elements (clickable file paths,
  // collapsible tool results) instead of flat textContent. This is the
  // "Claude Code app" view; visible in dev mode.
  switch (ev.type) {
    case 'stage':   panel.logStage(ev.message); break;
    case 'text':    panel.text(ev.content); break;
    case 'thinking': panel.thinking(ev.content); break;
    case 'tool_use': panel.logToolUse(ev); break;
    case 'tool_result': panel.logToolResult(ev); break;
    case 'usage':   panel.addUsage(ev); break;
    case 'usage_total': panel.setFinalUsage(ev); break;
    case 'phase':   panel.logStage(`◆ ${ev.name}`); break;
    case 'error':   panel.log(`✗ ${ev.message}`); break;
    case 'done':    panel.logStage(`Done. stopReason=${ev.stopReason} cost=$${(ev.totalCostUsd || 0).toFixed(4)}`);
                    panel.setCost(ev.totalCostUsd);
                    break;
  }

  // 2) Project the event onto a friendly stage for the default UI.
  switch (ev.type) {
    case 'stage': {
      // Server-side setup messages collapse into one "Preparing chapter" step.
      // The pdftocairo poller streams "Rasterizing pages X-Y… (n/N)" — surface
      // that count inline so the user sees the rasterizer's progress.
      const rasterM = ev.message.match(/^Rasterizing pages [\d-]+… \((\d+)\/(\d+)\)/);
      if (rasterM) {
        panel.setStep('prep', `Preparing chapter — rasterizing ${rasterM[1]}/${rasterM[2]} pages`, { icon: '📦', at: ev.t });
      } else if (/^Workdir:/.test(ev.message) || /^Trace:/.test(ev.message)
       || /Wrote chapter\.pdf/.test(ev.message) || /^Rasteriz/.test(ev.message)
       || /^Copied _lib/.test(ev.message) || /Rasterized \d+ pages/.test(ev.message)) {
        panel.setStep('prep', 'Preparing chapter', { icon: '📦', at: ev.t });
      } else if (/Launching agent/.test(ev.message)) {
        panel.completeStep('prep', ev.t);
        panel.setStep('think', 'Reading the chapter', { icon: '👀', at: ev.t });
      }
      break;
    }
    case 'phase': {
      // Agent-emitted phase signal (via `echo <name> > .phase`). The
      // agent picks its own labels — no fixed taxonomy — so the UI
      // shows whatever vocabulary the agent finds useful ("vetting
      // figures", "fixing Bragg's-law SVG", etc.). Each distinct phase
      // becomes its own step row (id = slug of the label).
      const raw = String(ev.name || '').trim();
      if (!raw) break;
      const id = 'phase:' + raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const label = raw.charAt(0).toUpperCase() + raw.slice(1);
      panel.setStep(id, label, { icon: '◆', at: ev.t });
      break;
    }
    case 'tool_use': {
      // Phase steps come from the agent's `.phase` signals (handled
      // above) — we no longer infer phases from tool_use paths. The
      // tool_use handler also surfaces side toasts for two events
      // the user cares about: index.html landing (≈ live preview ready)
      // and each section file landing (build progress).
      if (ev.name === 'Task') {
        const desc = ev.args?.description || ev.args?.subagent_type || 'subagent';
        panel.addWorker(ev.id, desc, ev.t);
      } else if (ev.name === 'Write' || ev.name === 'Edit') {
        // Replays inspect history — they should NOT auto-open the
        // live preview or fire section-write toasts. The user's
        // explicit intent was "show me the trace."
        if (panel._replaying) break;
        const path = ev.args?.file_path || '';
        const indexHit = /\/index\.html$/.test(path) || path.endsWith('index.html');
        const sectionHit = path.match(/sections\/([a-zA-Z0-9_-]+)\.html$/);
        const chTitle = panel.chapterId
          ? (state.paper?.chapters || []).find(c => c.id === panel.chapterId)?.title
          : '';
        const chLabel = chTitle ? `Ch. ${truncate(chTitle, 36)}` : 'Chapter';
        // Derive the workdir name the same way the server does, mirroring
        // the safeId regex (alnum + ._- only, max 48 chars).
        const safeIdCli = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
        const localDir = state.paper && panel.chapterId
          ? `chapter-${safeIdCli(state.paper.id)}-${safeIdCli(panel.chapterId)}`
          : null;
        if (indexHit && !panel._indexNotified && localDir) {
          panel._indexNotified = true;
          const url = `/cc-workdir/${encodeURIComponent(localDir)}/index.html`;
          const siteTitle = `${state.paper?.name || ''} — ${chTitle || ''}`.trim().replace(/^—\s*/, '');
          const autoOpen = localStorage.getItem('paperchat.chsum.autoOpen') !== '0';
          if (autoOpen) {
            openChapterSiteInline(url, siteTitle, { liveDirName: localDir });
            showToast(`${chLabel} — live preview opened`, { type: 'success', durationMs: 2800 });
          } else {
            showToast(`${chLabel} — skeleton ready`, {
              type: 'info', durationMs: 8000,
              action: { label: 'Open', onClick: () => openChapterSiteInline(url, siteTitle, { liveDirName: localDir }) },
            });
          }
        } else if (sectionHit) {
          showToast(`${chLabel} · wrote ${sectionHit[1]}`, { type: 'info', durationMs: 2400 });
        }
      }
      break;
    }
    case 'tool_result': {
      // If the result is for a Task subagent, mark that worker done.
      if (ev.id) panel.completeWorker(ev.id, ev.ok, ev.t);
      break;
    }
    case 'error': {
      panel.failStep(ev.message);
      break;
    }
    case 'done': {
      panel.completeAll(ev.t);
      panel.setCost(ev.totalCostUsd);  // Reveal the cost element + mirror onto the tab.
      panel.done(ev.workdir);
      // On replay, the run already finished historically — no need to
      // refresh summaries, fire a "Generated" toast, or flash the tab
      // title. The trace is the deliverable.
      if (panel._replaying) break;
      if (state.paper) refreshChapterSummaries(state.paper).catch(() => {});
      const chTitle = panel.chapterId
        ? (state.paper?.chapters || []).find(c => c.id === panel.chapterId)?.title
        : null;
      const label = chTitle ? `"${truncate(chTitle, 40)}"` : 'chapter';
      const cost = ev.totalCostUsd ? ` ($${ev.totalCostUsd.toFixed(2)})` : '';
      const safeDir = encodeURIComponent((ev.workdir || '').split('/').pop());
      const siteUrl = `/cc-workdir/${safeDir}/index.html`;
      const siteTitle = `${state.paper?.name || ''} — ${chTitle || ''}`.trim().replace(/^—\s*/, '');
      showToast(`✓ Generated ${label}${cost}`, {
        type: 'info',
        durationMs: 10000,
        action: { label: 'Open', onClick: () => openChapterSiteInline(siteUrl, siteTitle) },
      });
      flashTabTitle(`✓ Chapter ready`);
      break;
    }
  }
}

function shortToolArgs(name, args) {
  if (!args) return '';
  if (name === 'Read' && args.file_path) return args.file_path;
  if (name === 'Write' && args.file_path) return args.file_path;
  if (name === 'Edit' && args.file_path) return args.file_path;
  if (name === 'Bash' && args.command) return truncate(args.command, 120);
  if (name === 'Glob' && args.pattern) return args.pattern;
  return truncate(JSON.stringify(args), 120);
}

// Singleton chapter-summary panel that holds one or more chapter runs as
// tabs. Each tab maintains its own steps list, log, usage totals, and
// result link — perfect for batch generating across chapters.

const _chapterTabs = new Map();  // chapter.id → tab api (so reattach/regenerate finds the existing tab)

// Remove an existing tab for a chapter (DOM + registry). Used by
// kickoffChapterSummary so a regenerate starts with a clean slate
// instead of accumulating log/usage from the previous run.
function resetChapterTab(chapterId) {
  const existing = _chapterTabs.get(chapterId);
  if (!existing) return;
  const panel = document.getElementById('chsum-panel');
  if (panel) {
    panel.querySelector(`.chsum-tab[data-tab="${existing.tabId}"]`)?.remove();
    panel.querySelector(`.chsum-body[data-tab="${existing.tabId}"]`)?.remove();
  }
  _chapterTabs.delete(chapterId);
}

function ensureChapterPanel() {
  let panel = document.getElementById('chsum-panel');
  if (panel) return panel;
  const devMode = localStorage.getItem('paperchat.chsum.dev') === '1';
  const minimized = localStorage.getItem('paperchat.chsum.min') === '1';
  panel = document.createElement('div');
  panel.id = 'chsum-panel';
  panel.classList.toggle('dev', devMode);
  panel.classList.toggle('minimized', minimized);
  panel.innerHTML = `
    <header class="chsum-head">
      <ul class="chsum-tabs" id="chsum-tabs"></ul>
      <button class="chsum-dev" type="button" title="Toggle technical log">Details</button>
      <button class="chsum-min" type="button" title="Minimize (keeps running)" aria-label="Minimize">_</button>
      <button class="chsum-close" type="button" title="Close all tabs (agent runs keep going server-side)">✕</button>
    </header>
    <div class="chsum-bodies" id="chsum-bodies"></div>
  `;
  document.body.appendChild(panel);
  panel.querySelector('.chsum-min').addEventListener('click', () => {
    panel.classList.toggle('minimized');
    localStorage.setItem('paperchat.chsum.min', panel.classList.contains('minimized') ? '1' : '0');
    const btn = panel.querySelector('.chsum-min');
    btn.textContent = panel.classList.contains('minimized') ? '▢' : '_';
    btn.title = panel.classList.contains('minimized') ? 'Maximize' : 'Minimize (keeps running)';
  });
  // Set the initial label so it matches the restored state.
  const minBtn = panel.querySelector('.chsum-min');
  if (minimized) { minBtn.textContent = '▢'; minBtn.title = 'Maximize'; }
  panel.querySelector('.chsum-close').addEventListener('click', () => {
    // The agent keeps running server-side regardless; this just hides the
    // panel and clears the in-memory tab registry. Reopen via the chapter
    // menu or a fresh kickoff.
    panel.remove();
    _chapterTabs.clear();
  });
  panel.querySelector('.chsum-dev').addEventListener('click', () => {
    panel.classList.toggle('dev');
    localStorage.setItem('paperchat.chsum.dev', panel.classList.contains('dev') ? '1' : '0');
  });
  return panel;
}

function setActiveTab(tabId) {
  const panel = document.getElementById('chsum-panel');
  if (!panel) return;
  for (const t of panel.querySelectorAll('.chsum-tab')) {
    t.classList.toggle('chsum-tab--active', t.dataset.tab === tabId);
  }
  for (const b of panel.querySelectorAll('.chsum-body')) {
    b.hidden = b.dataset.tab !== tabId;
  }
}

function openChapterSummaryPanel(paper, ch) {
  // If a tab for this chapter already exists, reactivate it and return
  // its api (regenerate / reattach paths reuse rather than duplicate).
  if (_chapterTabs.has(ch.id)) {
    const existing = _chapterTabs.get(ch.id);
    setActiveTab(existing.tabId);
    return existing;
  }

  const panel = ensureChapterPanel();
  const tabsEl = panel.querySelector('#chsum-tabs');
  const bodiesEl = panel.querySelector('#chsum-bodies');
  const tabId = `tab-${Math.random().toString(36).slice(2, 9)}`;

  // Tab bar entry
  const tab = document.createElement('li');
  tab.className = 'chsum-tab';
  tab.dataset.tab = tabId;
  tab.innerHTML = `
    <span class="chsum-tab-spin"></span>
    <span class="chsum-tab-label" title="${escapeHtml(ch.title)}">${escapeHtml(truncate(ch.title, 22))}</span>
    <span class="chsum-tab-tokens" title="Tokens used so far: input · output"></span>
    <span class="chsum-tab-cost" title="Anthropic API cost (from SDK total_cost_usd)"></span>
    <button class="chsum-tab-close" type="button" title="Close tab" aria-label="Close tab">✕</button>
  `;
  tabsEl.appendChild(tab);
  tab.addEventListener('click', (e) => {
    if (e.target.closest('.chsum-tab-close')) return;
    setActiveTab(tabId);
  });
  tab.querySelector('.chsum-tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tabId);
  });

  // Body for this tab
  const body = document.createElement('div');
  body.className = 'chsum-body';
  body.dataset.tab = tabId;
  body.innerHTML = `
    <div class="chsum-meta">
      <span class="chsum-tokens">0 in · 0 out</span>
      <span class="chsum-cost" hidden></span>
      <button class="chsum-live" type="button" title="Open live preview — auto-reloads as the agent writes">👁 Watch live</button>
      <button class="chsum-files" type="button" title="Browse all artifacts in the workdir">📁 Files</button>
    </div>
    <div class="chsum-view chsum-view--conv">
      <ol class="chsum-steps"></ol>
      <ul class="chsum-workers" hidden></ul>
      <pre class="chsum-log"></pre>
      <div class="chsum-result" hidden></div>
    </div>
    <div class="chsum-view chsum-view--files" hidden>
      <header class="chsum-files-head">
        <button class="chsum-files-back" type="button" title="Back to conversation">‹ Back</button>
        <span class="chsum-files-path">Workdir</span>
        <a class="chsum-files-open-new" target="_blank" rel="noopener" title="Open raw" hidden>⤴</a>
      </header>
      <div class="chsum-files-body">Loading…</div>
    </div>
  `;
  bodiesEl.appendChild(body);
  // Derive the dirName for live preview from the chapter id (mirrors the
  // server-side safeId). Used by Watch-live + file-path links.
  const safeIdCli = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const dirName = `chapter-${safeIdCli(paper.id)}-${safeIdCli(ch.id)}`;
  // Absolute workdir prefix the agent may emit; we strip it to render
  // clickable relative paths in the log.
  const workdirAbsForLinks = `/Users/eporat/paperchat/cc-workdir/${dirName}`;
  body.querySelector('.chsum-live').addEventListener('click', () => {
    const url = `/cc-workdir/${encodeURIComponent(dirName)}/index.html`;
    openChapterSiteInline(url, `${paper.name || ''} — ${ch.title}`, { liveDirName: dirName });
  });
  // In-tab files view — swaps between the conversation log and a file
  // browser without opening a modal. Click ← Back to return.
  const convView = body.querySelector('.chsum-view--conv');
  const filesView = body.querySelector('.chsum-view--files');
  const filesPath = filesView.querySelector('.chsum-files-path');
  const filesOpenNew = filesView.querySelector('.chsum-files-open-new');
  const filesBody = filesView.querySelector('.chsum-files-body');

  function showConv() {
    convView.hidden = false;
    filesView.hidden = true;
  }
  function showFilesList() {
    convView.hidden = true;
    filesView.hidden = false;
    filesPath.textContent = 'Workdir / ' + dirName;
    filesOpenNew.hidden = true;
    filesBody.textContent = 'Loading…';
    fetch(`/api/chapter_runs/files?dir=${encodeURIComponent(dirName)}`)
      .then(r => r.ok ? r.json() : [])
      .then(files => {
        if (!files.length) { filesBody.textContent = '(no files yet)'; return; }
        const ul = document.createElement('ul');
        ul.className = 'chsum-files-list';
        for (const f of files) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = '#';
          a.className = 'chsum-files-link';
          a.textContent = f.path;
          a.addEventListener('click', (e) => { e.preventDefault(); showFile(f.path); });
          const meta = document.createElement('span');
          meta.className = 'chsum-files-meta';
          meta.textContent = `${(f.size / 1024).toFixed(1)} KB`;
          li.appendChild(a); li.appendChild(meta);
          ul.appendChild(li);
        }
        filesBody.innerHTML = '';
        filesBody.appendChild(ul);
      })
      .catch(e => { filesBody.textContent = 'Failed: ' + e.message; });
  }
  function showFile(relPath) {
    convView.hidden = true;
    filesView.hidden = false;
    const url = `/cc-workdir/${encodeURIComponent(dirName)}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
    filesPath.textContent = relPath;
    filesOpenNew.href = url;
    filesOpenNew.hidden = false;
    filesBody.textContent = 'Loading…';
    const ext = (relPath.split('.').pop() || '').toLowerCase();
    if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) {
      filesBody.innerHTML = `<img class="chsum-files-img" src="${url}" />`;
      return;
    }
    if (ext === 'html' || ext === 'htm') {
      filesBody.innerHTML = `
        <div class="chsum-files-split">
          <iframe class="chsum-files-frame" src="${url}"></iframe>
          <pre class="chsum-files-source">Loading…</pre>
        </div>`;
      fetch(url).then(r => r.text()).then(t => {
        filesBody.querySelector('.chsum-files-source').textContent = t;
      });
      return;
    }
    fetch(url).then(r => r.text()).then(t => {
      if (ext === 'json') { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch {} }
      else if (ext === 'jsonl') {
        try { t = t.split('\n').filter(Boolean).map(l => JSON.stringify(JSON.parse(l), null, 2)).join('\n---\n'); } catch {}
      }
      filesBody.innerHTML = `<pre class="chsum-files-source"></pre>`;
      filesBody.querySelector('.chsum-files-source').textContent = t;
    }).catch(e => { filesBody.textContent = 'Failed: ' + e.message; });
  }

  body.querySelector('.chsum-files').addEventListener('click', showFilesList);
  filesView.querySelector('.chsum-files-back').addEventListener('click', () => {
    if (filesPath.textContent.startsWith('Workdir')) showConv();
    else showFilesList();  // from a file → list
  });

  const tokensEl = body.querySelector('.chsum-tokens');
  const costEl = body.querySelector('.chsum-cost');
  const stepsEl = body.querySelector('.chsum-steps');
  const workersEl = body.querySelector('.chsum-workers');
  const logEl = body.querySelector('.chsum-log');
  const resultEl = body.querySelector('.chsum-result');

  // Auto-follow + manual lock. Standard chat-app behavior: if the user
  // is at (or near) the bottom of the log, new lines auto-scroll into
  // view; if they've scrolled up, hold their position and surface a
  // small "↓ jump to latest" affordance so they can rejoin the tail.
  let _autoFollow = true;
  const NEAR_BOTTOM_PX = 24;
  function isAtBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < NEAR_BOTTOM_PX;
  }
  logEl.addEventListener('scroll', () => {
    _autoFollow = isAtBottom();
    if (jumpBtn) jumpBtn.hidden = _autoFollow;
  });
  // "Jump to latest" pill — appears when the user has scrolled up
  // and we're no longer auto-following. Click to snap back to the
  // bottom and resume following.
  const jumpBtn = document.createElement('button');
  jumpBtn.type = 'button';
  jumpBtn.className = 'chsum-jump-btn';
  jumpBtn.hidden = true;
  jumpBtn.textContent = '↓ Jump to latest';
  jumpBtn.addEventListener('click', () => {
    logEl.scrollTop = logEl.scrollHeight;
    _autoFollow = true;
    jumpBtn.hidden = true;
  });
  logEl.parentElement?.appendChild(jumpBtn);
  // Replace the previous "always scroll to bottom" idiom: call this
  // after every appendChild so each log helper can stay one-liners.
  function followIfAtBottom() {
    if (_autoFollow) logEl.scrollTop = logEl.scrollHeight;
    else if (jumpBtn) jumpBtn.hidden = false;
  }

  // Track parallel Task subagents (one per section). Each adds a chip
  // with a spinner; tool_result flips it to ✓/✗.
  const workersById = new Map();
  function addWorker(id, desc, at) {
    if (!id || workersById.has(id)) return;
    if (typeof at === 'number') api._latestEventT = at;
    workersEl.hidden = false;
    const li = document.createElement('li');
    li.className = 'chsum-worker';
    li.dataset.workerId = id;
    li.dataset.startedAt = String(at ?? Date.now());
    li.innerHTML = `<span class="chsum-worker-spin"></span><span class="chsum-worker-label">${escapeHtml(truncate(desc, 50))}</span><span class="chsum-dur"></span>`;
    workersEl.appendChild(li);
    workersById.set(id, li);
  }
  function completeWorker(id, ok, at) {
    const li = workersById.get(id);
    if (!li) return;
    if (typeof at === 'number') api._latestEventT = at;
    li.classList.add(ok === false ? 'chsum-worker--fail' : 'chsum-worker--done');
    li.querySelector('.chsum-worker-spin').textContent = ok === false ? '✗' : '✓';
    const startedAt = Number(li.dataset.startedAt || 0);
    const endedAt = typeof at === 'number' ? at : Date.now();
    if (startedAt > 0 && endedAt > startedAt) {
      li.querySelector('.chsum-dur').textContent = fmtDur(endedAt - startedAt);
    }
  }
  // Tick active workers' duration once a second (same idea as steps).
  setInterval(() => {
    let anyActive = false;
    for (const li of workersById.values()) {
      if (li.classList.contains('chsum-worker--done') || li.classList.contains('chsum-worker--fail')) continue;
      anyActive = true;
      const startedAt = Number(li.dataset.startedAt || 0);
      const now = api._latestEventT || Date.now();
      if (startedAt > 0) li.querySelector('.chsum-dur').textContent = fmtDur(now - startedAt);
    }
  }, 1000);

  function closeTab(id) {
    panel.querySelector(`.chsum-tab[data-tab="${id}"]`)?.remove();
    panel.querySelector(`.chsum-body[data-tab="${id}"]`)?.remove();
    // Remove the api from the registry.
    for (const [k, v] of _chapterTabs.entries()) if (v.tabId === id) _chapterTabs.delete(k);
    // Activate the next remaining tab, or close the whole panel if none.
    const remaining = panel.querySelector('.chsum-tab');
    if (remaining) setActiveTab(remaining.dataset.tab);
    else panel.remove();
  }

  // Per-tab running token totals — straight from the API's usage object.
  // The SDK emits a `usage` event for every partial assistant message,
  // each with the latest tokens-so-far for that turn. We keep one
  // canonical entry per msgId and sum across turns, so a partial
  // report gets overwritten by the final one for the same turn.
  // (Per Anthropic's SDK type def, the Usage object has no
  // thinking_tokens field — thinking is rolled into output_tokens.)
  const usageByMsg = new Map();
  const usageTotals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  function recomputeUsageTotals() {
    usageTotals.input = 0;
    usageTotals.output = 0;
    usageTotals.cacheCreation = 0;
    usageTotals.cacheRead = 0;
    for (const u of usageByMsg.values()) {
      usageTotals.input         += u.input         || 0;
      usageTotals.output        += u.output        || 0;
      usageTotals.cacheCreation += u.cacheCreation || 0;
      usageTotals.cacheRead     += u.cacheRead     || 0;
    }
  }
  function fmtK(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function renderTokens() {
    // Real input = fresh input + cache_creation (new content added to
    // context this turn). cache_read is just re-counting cached content
    // we already saw on a prior turn, so summing it inflates the number
    // misleadingly.
    const inSum = usageTotals.input + usageTotals.cacheCreation;
    tokensEl.textContent =
      `${inSum.toLocaleString()} in · ${usageTotals.output.toLocaleString()} out`;
    tokensEl.title =
      `${usageTotals.input.toLocaleString()} fresh + ${usageTotals.cacheCreation.toLocaleString()} cached this run ` +
      `(${usageTotals.cacheRead.toLocaleString()} cache reads also; ignored in display since they re-count prior context). ` +
      'output_tokens already includes any thinking tokens.';
    const tabTokens = tab.querySelector('.chsum-tab-tokens');
    if (tabTokens) {
      tabTokens.textContent = `${fmtK(inSum)}·${fmtK(usageTotals.output)}`;
    }
  }

  // Per-tab step state. Each step tracks startedAt + endedAt so we
  // can show how long every phase took.
  const steps = new Map();
  let activeStepId = null;
  function fmtDur(ms) {
    if (!ms || ms < 0) return '';
    const s = ms / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
    const m = Math.floor(s / 60), rs = Math.round(s - m * 60);
    return rs ? `${m}m ${rs}s` : `${m}m`;
  }
  function stepDur(s) {
    // For an active step: use the latest known event-clock value
    // (so replay durations match the original wall-clock, and live
    // durations grow as long as new events keep arriving).
    if (s.status === 'active') {
      const now = api._latestEventT || Date.now();
      return now - (s.startedAt || now);
    }
    return (s.endedAt || 0) - (s.startedAt || 0);
  }
  function endStep(s) {
    if (s.endedAt) return;
    s.endedAt = api._latestEventT || Date.now();
  }
  function renderSteps() {
    stepsEl.innerHTML = '';
    for (const s of steps.values()) {
      const li = document.createElement('li');
      li.className = `chsum-step chsum-step--${s.status}`;
      const mark = s.status === 'done' ? '✓'
                  : s.status === 'fail' ? '✗'
                  : s.status === 'active' ? '<span class="chsum-spin"></span>'
                  : '○';
      const dur = fmtDur(stepDur(s));
      li.innerHTML = `<span class="chsum-mark">${mark}</span><span class="chsum-icon">${s.icon || ''}</span><span class="chsum-label">${escapeHtml(s.label)}</span>${dur ? `<span class="chsum-dur">${dur}</span>` : ''}`;
      stepsEl.appendChild(li);
    }
  }
  // Use the event-stream timestamp (`ev.t`, ms since run-start) when
  // available so REPLAYED durations show the real historical gaps
  // instead of the near-zero gaps caused by replay racing through the
  // SSE stream at memory speed. Falls back to Date.now() for callers
  // that don't have an event timestamp (boot stages, etc.).
  function setStep(id, label, { icon, at } = {}) {
    const now = (typeof at === 'number') ? at : Date.now();
    api._latestEventT = now;
    if (steps.has(id)) {
      const s = steps.get(id);
      s.label = label;
      if (icon) s.icon = icon;
      // Allow re-entering a phase: if the agent has done planning →
      // reading → planning again, swing back to plan rather than
      // getting stuck on the prior phase. Don't override a fail.
      if (s.status !== 'fail') {
        for (const other of steps.values()) {
          if (other.id !== id && other.status === 'active') { other.status = 'done'; endStepAt(other, now); }
        }
        if (s.status === 'done') { s.startedAt = now; s.endedAt = null; }  // re-entering resets the timer
        s.status = 'active';
      }
    } else {
      for (const s of steps.values()) if (s.status === 'active') { s.status = 'done'; endStepAt(s, now); }
      steps.set(id, { id, label, icon, status: 'active', startedAt: now, endedAt: null });
    }
    activeStepId = id;
    renderSteps();
    if (!tab.classList.contains('chsum-tab--active')) {
      tab.classList.add('chsum-tab--update');
      setTimeout(() => tab.classList.remove('chsum-tab--update'), 1200);
    }
  }
  function endStepAt(s, t) {
    if (s.endedAt) return;
    s.endedAt = t;
  }
  // Live-tick the active step's duration once a second so the user
  // can see it grow. Stops automatically when no active step remains.
  setInterval(() => {
    let anyActive = false;
    for (const s of steps.values()) if (s.status === 'active') { anyActive = true; break; }
    if (anyActive) renderSteps();
  }, 1000);
  function completeStep(id, at) {
    if (typeof at === 'number') api._latestEventT = at;
    const s = steps.get(id);
    if (s) { s.status = 'done'; endStep(s); renderSteps(); }
  }
  function completeAll(at) {
    if (typeof at === 'number') api._latestEventT = at;
    for (const s of steps.values()) if (s.status === 'active') { s.status = 'done'; endStep(s); }
    renderSteps();
    tab.classList.add('chsum-tab--done');
  }
  function failStep(msg) {
    const s = activeStepId ? steps.get(activeStepId) : null;
    if (s) { s.status = 'fail'; s.label += ` — ${msg}`; renderSteps(); }
    tab.classList.add('chsum-tab--fail');
  }

  const api = {
    tabId,
    chapterId: ch.id,
    log(line) {
      const div = document.createElement('div');
      div.className = 'chsum-line';
      div.textContent = line;
      logEl.appendChild(div);
      followIfAtBottom();
    },
    logStage(message) {
      const div = document.createElement('div');
      div.className = 'chsum-line chsum-line--stage';
      div.textContent = '■ ' + message;
      logEl.appendChild(div);
      followIfAtBottom();
    },
    logToolUse(ev) {
      const div = document.createElement('div');
      div.className = 'chsum-line chsum-line--tool';
      div.dataset.toolId = ev.id;
      const name = document.createElement('span');
      name.className = 'chsum-tool-name';
      name.textContent = '→ ' + ev.name;
      div.appendChild(name);
      div.appendChild(document.createTextNode('  '));
      // For file-path tools, render the path as a clickable link that
      // opens the file in an inline viewer. For Bash, show the command.
      const path = ev.args?.file_path;
      const cmd  = ev.args?.command;
      const pat  = ev.args?.pattern;
      if (path) {
        const a = document.createElement('a');
        a.className = 'chsum-tool-path';
        a.href = '#';
        a.textContent = path.replace(workdirAbsForLinks, '').replace(/^\//, '');
        a.title = 'Open ' + path;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const rel = path.startsWith('/') ? path.replace(workdirAbsForLinks, '').replace(/^\//, '') : path;
          showFile(rel);  // in-tab view, not a modal
        });
        div.appendChild(a);
        // Inline thumbnail for images — the agent reads composites,
        // figures, page rasters, and preview screenshots dozens of
        // times per chapter. Showing what it actually saw makes the
        // log much more useful. Click the thumb to zoom (uses the
        // same overlay as the chapter site's .pc-figure--zoom).
        const rel = path.startsWith('/')
          ? path.replace(workdirAbsForLinks, '').replace(/^\//, '')
          : path;
        if (/\.(png|jpe?g|gif|webp|svg)$/i.test(rel)) {
          const imgUrl = `/cc-workdir/${dirName}/${rel.split('/').map(encodeURIComponent).join('/')}`;
          const wrap = document.createElement('span');
          wrap.className = 'chsum-tool-thumb';
          const img = document.createElement('img');
          img.src = imgUrl;
          img.loading = 'lazy';
          img.alt = rel;
          img.title = 'Click to zoom';
          img.addEventListener('click', (e) => {
            e.preventDefault();
            openImageZoom(imgUrl, rel);
          });
          wrap.appendChild(img);
          div.appendChild(wrap);
        }
      } else if (ev.name === 'Task') {
        const span = document.createElement('span');
        span.className = 'chsum-tool-args';
        span.textContent = ev.args?.description || ev.args?.subagent_type || '';
        div.appendChild(span);
      } else if (cmd) {
        const span = document.createElement('span');
        span.className = 'chsum-tool-cmd';
        span.textContent = truncate(cmd, 120);
        div.appendChild(span);
      } else if (pat) {
        const span = document.createElement('span');
        span.className = 'chsum-tool-args';
        span.textContent = pat;
        div.appendChild(span);
      }
      logEl.appendChild(div);
      followIfAtBottom();
    },
    logToolResult(ev) {
      const div = document.createElement('div');
      div.className = 'chsum-line chsum-line--result' + (ev.ok ? ' ok' : ' fail');
      div.textContent = '  ' + (ev.ok ? '✓' : '✗') + ' ' + truncate(ev.result || '', 160);
      logEl.appendChild(div);
      followIfAtBottom();
    },
    text(t) {
      // Streaming assistant text — append to the last text line if there
      // is one, else create a new one.
      let last = logEl.lastElementChild;
      if (!last || !last.classList.contains('chsum-line--text')) {
        last = document.createElement('div');
        last.className = 'chsum-line chsum-line--text';
        logEl.appendChild(last);
      }
      last.textContent += t;
      followIfAtBottom();
    },
    thinking(t) {
      let last = logEl.lastElementChild;
      if (!last || !last.classList.contains('chsum-line--think')) {
        last = document.createElement('div');
        last.className = 'chsum-line chsum-line--think';
        logEl.appendChild(last);
      }
      last.textContent += t;
      followIfAtBottom();
    },
    setStep,
    completeStep,
    completeAll,
    failStep,
    addWorker,
    completeWorker,
    addUsage(ev) {
      // Skip parent-only usage events once the SDK has emitted the
      // authoritative aggregate (which includes every subagent). Without
      // this, late streaming partials would overwrite the real totals.
      if (this._haveFinalUsage) return;
      // Replace any prior usage for this message id (partial → final).
      // Falls back to a synthetic id for very old runs without msgId.
      const id = ev.msgId || `anon-${usageByMsg.size}`;
      usageByMsg.set(id, {
        input: ev.input || 0,
        output: ev.output || 0,
        cacheCreation: ev.cacheCreation || 0,
        cacheRead: ev.cacheRead || 0,
      });
      recomputeUsageTotals();
      renderTokens();
    },
    setFinalUsage(ev) {
      // Authoritative per-model aggregate from the SDK's result message.
      // Parent agent's per-turn `usage` events only cover the parent's
      // own work — subagent (section-writer) token output is missing
      // from those. modelUsage sums parent + every subagent, broken out
      // per model, so the totals reflect real spend.
      this._haveFinalUsage = true;
      const t = ev.totals || {};
      usageByMsg.clear();
      usageByMsg.set('final', {
        input: t.input || 0,
        output: t.output || 0,
        cacheCreation: t.cacheCreation || 0,
        cacheRead: t.cacheRead || 0,
      });
      recomputeUsageTotals();
      renderTokens();
      if (typeof ev.totalCostUsd === 'number') this.setCost(ev.totalCostUsd);
    },
    setCost(usd) {
      if (typeof usd !== 'number' || !isFinite(usd)) return;
      costEl.textContent = `$${usd.toFixed(4)}`;
      costEl.hidden = false;
      // Mirror onto the tab so the run's cost is visible from the tab bar.
      const tabCost = tab.querySelector('.chsum-tab-cost');
      if (tabCost) tabCost.textContent = `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
    },
    done(workdir) {
      resultEl.hidden = false;
      const safe = encodeURIComponent(workdir.split('/').pop());
      const url = `/cc-workdir/${safe}/index.html`;
      resultEl.innerHTML = `<button class="chsum-open" type="button">Open chapter site →</button>`;
      resultEl.querySelector('.chsum-open').addEventListener('click', () => {
        openChapterSiteInline(url, `${paper.name || ''} — ${ch.title}`);
      });
      tab.classList.add('chsum-tab--done');
      // Skip the "pop minimized + scroll into view + focus tab"
      // attention-grabbing on replay — the user opened the panel
      // deliberately to read history, they don't need it grabbed.
      if (api._replaying) return;
      const panel = document.getElementById('chsum-panel');
      if (panel?.classList.contains('minimized')) {
        panel.classList.remove('minimized');
        try { localStorage.setItem('paperchat.chsum.min', '0'); } catch {}
        const btn = panel.querySelector('.chsum-min');
        if (btn) { btn.textContent = '_'; btn.title = 'Minimize (keeps running)'; }
      }
      tab.click();
      resultEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  };

  _chapterTabs.set(ch.id, api);
  setActiveTab(tabId);
  return api;
}

// Inline file viewer — opens any file from a chapter workdir in a modal
// with content tailored to the file type. Used by clickable file paths
// in the conversation log + the Files browser button.
function openFileViewer(dirName, relPath) {
  document.getElementById('file-viewer')?.remove();
  const url = `/cc-workdir/${encodeURIComponent(dirName)}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  const wrap = document.createElement('div');
  wrap.id = 'file-viewer';
  wrap.innerHTML = `
    <header class="fv-head">
      <button class="fv-back" type="button" title="Close (Esc)">✕</button>
      <span class="fv-path">${escapeHtml(relPath)}</span>
      <a class="fv-open-new" href="${url}" target="_blank" rel="noopener" title="Open raw">⤴</a>
    </header>
    <div class="fv-body" id="fv-body">Loading…</div>
  `;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc); };
  function esc(e) { if (e.key === 'Escape') close(); }
  wrap.querySelector('.fv-back').addEventListener('click', close);
  document.addEventListener('keydown', esc);

  const body = wrap.querySelector('#fv-body');
  const ext = (relPath.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    body.innerHTML = `<img src="${url}" />`;
    return;
  }
  if (ext === 'html' || ext === 'htm') {
    // Show the raw HTML source AND a rendered preview side-by-side.
    body.innerHTML = `
      <div class="fv-split">
        <iframe class="fv-frame" src="${url}"></iframe>
        <pre class="fv-source">Loading…</pre>
      </div>
    `;
    fetch(url).then(r => r.text()).then(t => {
      const pre = body.querySelector('.fv-source');
      pre.textContent = t;
    });
    return;
  }
  // Default: fetch as text + display in a <pre>; pretty-print JSON.
  fetch(url).then(r => r.text()).then(t => {
    if (ext === 'json' || ext === 'jsonl') {
      try {
        if (ext === 'json') { t = JSON.stringify(JSON.parse(t), null, 2); }
        else { t = t.split('\n').filter(Boolean).map(l => JSON.stringify(JSON.parse(l), null, 2)).join('\n---\n'); }
      } catch {}
    }
    body.innerHTML = `<pre class="fv-source">${escapeHtml(t)}</pre>`;
  }).catch(e => { body.textContent = 'Failed: ' + e.message; });
}

// File browser for a chapter workdir. Lists every artifact (sections,
// plan.json, figures, trace, etc.) with click-to-view.
async function openWorkdirFiles(dirName, displayTitle) {
  document.getElementById('file-viewer')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'file-viewer';
  wrap.innerHTML = `
    <header class="fv-head">
      <button class="fv-back" type="button" title="Close (Esc)">✕</button>
      <span class="fv-path">${escapeHtml(displayTitle || 'Files')} — workdir</span>
    </header>
    <div class="fv-body fv-list-body" id="fv-body">Loading…</div>
  `;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc); };
  function esc(e) { if (e.key === 'Escape') close(); }
  wrap.querySelector('.fv-back').addEventListener('click', close);
  document.addEventListener('keydown', esc);

  const body = wrap.querySelector('#fv-body');
  try {
    const r = await fetch(`/api/chapter_runs/files?dir=${encodeURIComponent(dirName)}`);
    if (!r.ok) { body.textContent = 'Listing failed: ' + r.status; return; }
    const files = await r.json();
    if (!files.length) { body.textContent = '(no files yet)'; return; }
    const ul = document.createElement('ul');
    ul.className = 'fv-list';
    for (const f of files) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'fv-list-link';
      a.textContent = f.path;
      a.addEventListener('click', (e) => { e.preventDefault(); openFileViewer(dirName, f.path); });
      const meta = document.createElement('span');
      meta.className = 'fv-list-meta';
      meta.textContent = `${(f.size / 1024).toFixed(1)} KB`;
      li.appendChild(a);
      li.appendChild(meta);
      ul.appendChild(li);
    }
    body.innerHTML = '';
    body.appendChild(ul);
  } catch (e) {
    body.textContent = 'Failed: ' + e.message;
  }
}

// Flash the browser tab title to alert the user when a chapter run
// finishes while paperchat is in a background tab. Restores when the
// tab regains focus or after 60s.
let _titleFlashTimer = null;
function flashTabTitle(prefix) {
  // Don't flash if the page is already visible.
  if (document.visibilityState === 'visible') return;
  const original = document.title;
  document.title = `${prefix} — ${original}`;
  const restore = () => {
    if (_titleFlashTimer) { clearTimeout(_titleFlashTimer); _titleFlashTimer = null; }
    document.title = original;
    document.removeEventListener('visibilitychange', onVis);
  };
  function onVis() { if (document.visibilityState === 'visible') restore(); }
  document.addEventListener('visibilitychange', onVis);
  _titleFlashTimer = setTimeout(restore, 60_000);
}

// Inline SPA-style viewer for a generated chapter site. Opens the URL in
// an iframe overlay with a back button instead of a new tab so the user
// stays inside paperchat.
//
// When `liveDirName` is provided, the viewer polls the server for
// index.html mtime every 1s and reloads the iframe on change — useful
// while the agent is still generating the site.
// Full-screen zoom overlay for inline thumbnails in the chapter-summary
// log. Click anywhere or press Esc to close. Mirrors the chapter-site
// lightbox idiom so the interaction is consistent across surfaces.
function openImageZoom(url, alt) {
  document.getElementById('chsum-img-zoom')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'chsum-img-zoom';
  overlay.className = 'chsum-img-zoom';
  const img = document.createElement('img');
  img.src = url;
  img.alt = alt || '';
  overlay.appendChild(img);
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', esc);
  };
  function esc(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', esc);
  document.body.appendChild(overlay);
}

// One-time MutationObserver: whenever #chapter-viewer is removed from
// the DOM by ANY path (close button, Esc, opening a new viewer that
// swaps it out, openPaper switching the underlying paper, etc.), the
// sessionStorage persistence is cleared. Without this, the entry can
// outlive its viewer and refresh teleports the user back into a
// chapter site they had already left.
if (!window._chsiteWatchInstalled) {
  window._chsiteWatchInstalled = true;
  new MutationObserver((muts) => {
    let removed = false, added = false;
    for (const m of muts) {
      for (const node of m.removedNodes) if (node && node.id === 'chapter-viewer') removed = true;
      for (const node of m.addedNodes)   if (node && node.id === 'chapter-viewer') added = true;
    }
    // Only clear when removed-without-replacement. Swap (remove + add
    // in same batch) is openChapterSiteInline reopening with a new
    // URL — sessionStorage already has the new entry by then.
    if (removed && !added) {
      try { sessionStorage.removeItem('paperchat.chsite'); } catch {}
    }
  }).observe(document.body, { childList: true });
}

// Listen for "jump to PDF page N" messages from the chapter-site
// iframe (pc.js posts these when the user clicks a .pc-source
// citation). On receive: close the chapter overlay so the PDF is
// visible, then scroll the viewer to that page. Filtered to only
// fire while we're inside the chapter-viewer (its iframe is the
// only sender we expect) and only for the goto-page type.
if (!window._chsiteMsgInstalled) {
  window._chsiteMsgInstalled = true;
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.type !== 'paperchat:goto-page') return;
    const page = parseInt(d.page, 10);
    if (!Number.isFinite(page) || page < 1) return;
    // Verify the message came from our chapter-viewer iframe — we
    // don't want random pages on the open web triggering jumps.
    const wrap = document.getElementById('chapter-viewer');
    const frame = wrap?.querySelector('iframe');
    if (!frame || ev.source !== frame.contentWindow) return;
    // Close the overlay (the MutationObserver clears sessionStorage),
    // then jump on the next tick so the PDF viewer is the active surface.
    wrap.remove();
    setTimeout(() => jumpToPage(page), 0);
  });
}

function openChapterSiteInline(url, title, opts = {}) {
  document.getElementById('chapter-viewer')?.remove();
  const liveDirName = opts.liveDirName || null;
  // Persist so a page refresh restores the chapter viewer instead of
  // dumping the user back into the underlying PDF viewer. sessionStorage
  // (not localStorage) — we want this scoped to the current tab, and
  // gone when the tab closes. The MutationObserver above clears it
  // automatically the moment the viewer leaves the DOM.
  try {
    sessionStorage.setItem('paperchat.chsite', JSON.stringify({ url, title, liveDirName }));
  } catch {}
  const wrap = document.createElement('div');
  wrap.id = 'chapter-viewer';
  // In live mode the iframe starts blank with a "waiting" placeholder.
  // We only point it at the chapter URL once we've observed the file
  // exists (mtime > 0) — otherwise an early click yields a 404 that
  // sticks until manual reload.
  const initialSrc = liveDirName ? 'about:blank' : url;
  wrap.innerHTML = `
    <header class="cv-head">
      <button class="cv-back" type="button" title="Back to paper">← Back</button>
      <span class="cv-title">${escapeHtml(title || 'Chapter site')}</span>
      ${liveDirName ? '<span class="cv-live" title="Live preview — auto-reloads on each save"><span class="cv-live-dot"></span>LIVE</span>' : ''}
      <a class="cv-open-new" href="${url}" target="_blank" rel="noopener" title="Open in new tab">⤴</a>
    </header>
    ${liveDirName ? '<div class="cv-waiting">⠋ Waiting for the agent\'s first write of index.html…</div>' : ''}
    <iframe class="cv-frame" src="${initialSrc}"${liveDirName ? ' hidden' : ''}></iframe>
  `;
  document.body.appendChild(wrap);
  const iframe = wrap.querySelector('.cv-frame');
  const waitingEl = wrap.querySelector('.cv-waiting');

  let pollTimer = null;
  let lastMtime = 0;
  if (liveDirName) {
    const poll = async () => {
      try {
        const r = await fetch(`/api/chapter_runs/index_mtime?dir=${encodeURIComponent(liveDirName)}`);
        if (!r.ok) return;
        const { mtime } = await r.json();
        if (mtime > 0 && mtime !== lastMtime) {
          // First non-zero mtime → reveal the iframe and load the page.
          // Subsequent changes → cache-bust to force a fresh load.
          iframe.src = url + (url.includes('?') ? '&' : '?') + 't=' + mtime;
          if (lastMtime === 0) {
            iframe.hidden = false;
            if (waitingEl) waitingEl.remove();
          }
          lastMtime = mtime;
        }
      } catch {}
    };
    poll();
    pollTimer = setInterval(poll, 1000);
  }

  const close = () => {
    wrap.remove();
    if (pollTimer) clearInterval(pollTimer);
    document.removeEventListener('keydown', esc);
    try { sessionStorage.removeItem('paperchat.chsite'); } catch {}
  };
  function esc(e) { if (e.key === 'Escape') close(); }
  wrap.querySelector('.cv-back').addEventListener('click', close);
  document.addEventListener('keydown', esc);
}

function chTitleFromPanel(panel) {
  // not used yet — placeholder for richer titling
  return document.querySelector('#chsum-panel .chsum-sub')?.textContent || '';
}

// ---- Upload + drop ----

// ---- Zoom ----
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0];

function updateZoomLabel() {
  $('#zoom-label').textContent = Math.round(state.zoomFactor * 100) + '%';
}

// Collapse-queue: rapid wheel/button events all just update the target;
// the in-flight render finishes, then loops to the latest target. No two
// renderPdf() calls ever run concurrently against the same container.
let _zoomTarget = null;
let _zoomRunning = false;

async function setZoom(newFactor) {
  if (!state.paper) return;
  const clamped = Math.max(0.25, Math.min(4, newFactor));
  _zoomTarget = clamped;
  if (_zoomRunning) return;
  _zoomRunning = true;
  try {
    while (_zoomTarget != null && Math.abs(_zoomTarget - state.zoomFactor) >= 0.001) {
      const target = _zoomTarget;
      _zoomTarget = null;
      await applyZoom(target);
    }
  } finally {
    _zoomRunning = false;
  }
}

async function applyZoom(target) {
  const wrap = $('.viewer-wrap') || viewer.parentElement;
  // Capture viewport anchor (which page is at top + how far down) so the user
  // doesn't drift to a different page across the re-render.
  const anchor = captureViewportAnchor(wrap);

  state.zoomFactor = target;
  localStorage.setItem('paperchat.zoom', String(target));
  updateZoomLabel();

  const { pages } = await renderPdf(state.paper.blob, viewer, BASE_SCALE * target);
  state.pages = pages;
  redrawHighlights();
  restoreViewportAnchor(wrap, anchor);
}

// Find the page currently anchoring the top of the viewport and the fraction
// of that page's height we've scrolled past. Returns { pageNum, fraction } or
// null if no page intersects the top edge.
function captureViewportAnchor(wrap) {
  if (!wrap || !state.pages.length) return null;
  const wrapRect = wrap.getBoundingClientRect();
  // Use a small offset (8px) so a one-pixel sliver of the previous page
  // doesn't latch us to it.
  const probe = 8;
  for (const page of state.pages) {
    const r = page.wrap.getBoundingClientRect();
    const topRel = r.top - wrapRect.top;
    const botRel = topRel + r.height;
    if (topRel <= probe && botRel > probe) {
      const offset = probe - topRel; // pixels into this page
      const fraction = r.height > 0 ? offset / r.height : 0;
      return { pageNum: page.pageNum, fraction };
    }
  }
  // Fallback: clamp to first / last page when nothing intersects.
  const first = state.pages[0].wrap.getBoundingClientRect();
  if (first.top - wrapRect.top > probe) return { pageNum: state.pages[0].pageNum, fraction: 0 };
  return { pageNum: state.pages[state.pages.length - 1].pageNum, fraction: 1 };
}

function restoreViewportAnchor(wrap, anchor) {
  if (!anchor || !wrap) return;
  const page = state.pages.find(p => p.pageNum === anchor.pageNum);
  if (!page) return;
  const wrapRect = wrap.getBoundingClientRect();
  const pageRect = page.wrap.getBoundingClientRect();
  const pageTopInContent = (pageRect.top - wrapRect.top) + wrap.scrollTop;
  const target = pageTopInContent + anchor.fraction * pageRect.height - 8; // mirror probe offset
  wrap.scrollTop = Math.max(0, target);
}

function zoomStep(delta) {
  // Snap to the nearest defined step and move by `delta` indices.
  const cur = state.zoomFactor;
  let nearest = 0;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i] - cur) < Math.abs(ZOOM_STEPS[nearest] - cur)) nearest = i;
  }
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, nearest + delta));
  setZoom(ZOOM_STEPS[next]);
}

$('#zoom-in').addEventListener('click', () => zoomStep(+1));
$('#zoom-out').addEventListener('click', () => zoomStep(-1));
$('#zoom-label').addEventListener('click', () => setZoom(1.0));

// Cmd/Ctrl + scroll-wheel zoom over the viewer (matches native PDF readers).
document.querySelector('.viewer-wrap')?.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (!state.paper) return;
  e.preventDefault();
  zoomStep(e.deltaY < 0 ? +1 : -1);
}, { passive: false });

$('#btn-upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (f) await addPaperFromFile(f);
  fileInput.value = '';
});

// ---- Add by URL (arXiv etc.) ----
const urlDlg = $('#url-dialog');
const urlInput = $('#url-input');
const urlError = $('#url-error');
const urlSubmit = $('#url-submit');

$('#btn-from-url').addEventListener('click', () => {
  urlInput.value = '';
  urlError.hidden = true;
  urlError.textContent = '';
  urlSubmit.disabled = false;
  urlSubmit.textContent = 'Add';
  urlDlg.showModal();
  urlInput.focus();
});
$('#url-cancel').addEventListener('click', () => urlDlg.close());

$('#url-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = urlInput.value.trim();
  if (!raw) return;
  let target;
  try {
    target = normalizePaperUrl(raw);
  } catch (err) {
    urlError.textContent = err.message;
    urlError.hidden = false;
    return;
  }
  urlError.hidden = true;
  urlSubmit.disabled = true;
  urlSubmit.textContent = 'Fetching…';
  try {
    const r = await fetch(`/api/fetch_pdf?url=${encodeURIComponent(target)}`);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`${r.status}: ${t.slice(0, 200)}`);
    }
    const blob = await r.blob();
    const filename = filenameFromUrl(target);
    const file = new File([blob], filename, { type: 'application/pdf' });
    urlDlg.close();
    showToast(`Adding ${filename}…`, { type: 'info', durationMs: 2000 });
    await addPaperFromFile(file);
  } catch (err) {
    urlError.textContent = `Fetch failed: ${err.message}`;
    urlError.hidden = false;
    urlSubmit.disabled = false;
    urlSubmit.textContent = 'Add';
  }
});

// Normalize various arXiv-flavored inputs into a direct PDF URL. Returns the
// fetch target. Throws on inputs we can't make sense of.
function normalizePaperUrl(input) {
  // Bare arXiv ID, e.g. "2304.12345" or "math.AG/0302234"
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(input) || /^[a-z\-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(input)) {
    return `https://arxiv.org/pdf/${input}`;
  }
  let u;
  try { u = new URL(input); }
  catch { throw new Error('Not a URL or arXiv ID.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported.');
  // arXiv abstract → PDF
  if (/(^|\.)arxiv\.org$/i.test(u.hostname)) {
    const m = u.pathname.match(/\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?$/i);
    if (m) return `https://arxiv.org/pdf/${m[1]}`;
  }
  // Otherwise pass through unchanged — assume the URL itself points at a PDF.
  return u.toString();
}

function filenameFromUrl(target) {
  try {
    const u = new URL(target);
    if (/(^|\.)arxiv\.org$/i.test(u.hostname)) {
      const m = u.pathname.match(/\/pdf\/(.+?)(\.pdf)?$/i);
      if (m) return `arxiv-${m[1].replace(/[^\w.-]/g, '_')}.pdf`;
    }
    const last = u.pathname.split('/').filter(Boolean).pop() || 'paper.pdf';
    return last.toLowerCase().endsWith('.pdf') ? last : last + '.pdf';
  } catch {
    return 'paper.pdf';
  }
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) await addPaperFromFile(f);
});

// ---- Init ----

(async function init() {
  await renderLibrary();
  // Open the most-recent paper if any
  const all = await Papers.list();
  if (all.length) await openPaper(all[0].id);
  // Restore the chapter-viewer overlay if the user was on one before
  // the refresh. The actual run state (steps, log, live preview) is
  // already restored by reattachActiveRuns; this just brings back the
  // overlay surface so the user lands where they left off.
  try {
    const saved = sessionStorage.getItem('paperchat.chsite');
    if (saved) {
      const { url, title, liveDirName } = JSON.parse(saved);
      if (url) openChapterSiteInline(url, title || '', liveDirName ? { liveDirName } : {});
    }
  } catch {}
  // One-shot: extract titles for any papers that don't have one (background)
  backfillTitles();
})();
