// Top-level app wiring: library, viewer, threads, settings.

import { Papers, Threads, Messages, uid, hashBlob } from './db.js';
import { renderPdf, BASE_SCALE, getOutline, getPdfMetadataTitle, extractText, captureSelection, drawHighlight, clearHighlights, highlightQuoteOnPage } from './pdf.js';
import {
  streamChat, parseMention, MENTIONS, mentionClass, extractPaperTitle,
  getKey, setKey, envKey, getModels, setModels, modelFor,
} from './ai.js';

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

// Settings dialog
const settingsDlg = $('#settings-dialog');
const settingsForm = $('#settings-form');
const settingsKey = $('#settings-key');
const settingsClaude = $('#settings-claude');
const settingsGrok = $('#settings-grok');
const settingsGpt = $('#settings-gpt');

// ---- State ----
const state = {
  paper: null,        // { id, name, blob, pagesText, ... }
  pages: [],          // rendered pages from pdf.js
  threads: [],        // threads on the current paper
  activeThreadId: null,
  pendingSelection: null, // { pageNum, quote, rects, anchor }
  zoomFactor: Number(localStorage.getItem('paperchat.zoom')) || 1.0,
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
  const [pagesText, metaTitle] = await Promise.all([
    extractText(file),
    getPdfMetadataTitle(file),
  ]);
  // Prefer LLM extraction (works on most papers); fall back to metadata, then filename.
  const llmTitle = await extractPaperTitle(pagesText[0]).catch(() => null);
  const paper = {
    id,
    name: file.name,
    title: llmTitle || metaTitle || null,
    blob: file,
    pagesText,
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
  renderOutline(await getOutline(doc));
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

function buildOutlineList(items) {
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
      row.addEventListener('click', () => jumpToPage(it.pageNum));
    }
    li.appendChild(row);
    if (it.children?.length) li.appendChild(buildOutlineList(it.children));
    ul.appendChild(li);
  }
  return ul;
}

function jumpToPage(pageNum) {
  const page = state.pages.find(p => p.pageNum === pageNum);
  if (!page) return;
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

function closePaper() {
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
  li.className = 'thread-card' + (t.id === state.activeThreadId ? ' active' : '');
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
  el.innerHTML = marked.parse(text || '');
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

function fixMathInDom(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== root) {
        const tag = p.nodeType === 1 ? p.tagName : '';
        if (tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const n of nodes) {
    const fixed = autoFixMathSyntax(n.nodeValue);
    if (fixed !== n.nodeValue) n.nodeValue = fixed;
  }
}

// Apply LaTeX subscript repairs only inside $...$ / $$...$$ regions so we
// don't touch prose that happens to contain backslashes.
function autoFixMathSyntax(text) {
  if (!text || (!text.includes('$') && !text.includes('\\['))) return text;
  return text.replace(
    /(\$\$[\s\S]*?\$\$|\$[^\$\n]+\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g,
    (block) => block
      // \mathcal{L}{x} → \mathcal{L}_{x}, also for \mathbb / \mathbf / \mathrm / \mathit / \mathfrak
      .replace(/(\\(?:mathcal|mathbb|mathbf|mathrm|mathit|mathfrak|mathsf|mathtt)\{[^{}]+\})\s*\{/g, '$1_{')
      // \sum{...} → \sum_{...} (and other big operators / functions)
      .replace(/\\(sum|prod|int|oint|iint|iiint|coprod|max|min|sup|inf|lim|liminf|limsup|bigcup|bigcap|bigotimes|bigoplus|bigsqcup)\s*\{/g, '\\$1_{')
  );
}

const _pendingMath = new WeakSet();
function renderMathIn(el) {
  if (window.renderMathInElement) {
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
        ignoredTags: ['script', 'style', 'pre', 'code'],
        // KaTeX defaults to 'htmlAndMathml' which emits BOTH a visible
        // .katex-html span and a .katex-mathml span (hidden via clip).
        // If anything in the page CSS interferes with the clip rect, the
        // mathml leaks through and the user sees the formula twice (once
        // properly typeset, once spelled out one symbol per line). Force
        // 'html' only — accessibility tools can still read the alt text.
        output: 'html',
        // Inside a narrow markdown table cell, KaTeX can mis-line-wrap a
        // long expression. trust:true lets users opt-in to \htmlClass etc.
        // strict:false silences benign warnings.
        strict: false,
      });
    } catch {}
    return;
  }
  // KaTeX hasn't loaded yet — defer until window.load.
  _pendingMath.add(el);
}
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
  // No selection — treat as click. If point falls inside one or more highlights,
  // open the topmost (most-recently-created) thread under the cursor.
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
  threadInput.value = prefill;
  threadDlg.showModal();
  scrollToBottomNow(); // opening a thread always jumps to the latest message
  if (prefill) threadInput.focus();
  redrawHighlights();
  renderThreadList();
}

// X button just closes the dialog; the 'close' event handler does the cleanup
// once, regardless of whether the user clicked X or hit Esc.
threadDlgClose.addEventListener('click', () => threadDlg.close());

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
  threadSend.disabled = true;

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
  scrollToBottomNow(); // user just hit Send — re-pin to bottom

  const segments = [];      // [{ type: 'text', content } | { type: 'tool', tc }]
  let segText = '';
  let currentBody = card.body;
  const toolCalls = [];

  function freezeCurrentSegment() {
    if (segText.trim()) {
      segments.push({ type: 'text', content: segText });
      segText = '';
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
      onDelta: (delta) => {
        segText += delta;
        setMarkdown(currentBody, segText);
        // Markdown render strips the cursor; re-attach it at the end of streaming text
        const cursor = document.createElement('span');
        cursor.className = 'cursor';
        cursor.textContent = '▍';
        currentBody.appendChild(cursor);
        scrollIfPinned();
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
    setMarkdown(currentBody, `**Error:** ${err.message}`);
    const errMsg = {
      id: uid(),
      threadId: t.id,
      role: 'assistant',
      mention,
      content: `**Error:** ${err.message}`,
      createdAt: Date.now(),
    };
    await Messages.put(errMsg);
  } finally {
    threadSend.disabled = false;
  }
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
  const { type = 'info', durationMs = 3500 } = opts;
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = message;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);
  }, durationMs);
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
  settingsDlg.showModal();
});
$('#settings-cancel').addEventListener('click', () => settingsDlg.close());
settingsForm.addEventListener('submit', () => {
  setKey(settingsKey.value.trim());
  setModels({
    '@claude': settingsClaude.value.trim() || undefined,
    '@grok': settingsGrok.value.trim() || undefined,
    '@gpt': settingsGpt.value.trim() || undefined,
  });
});

// ---- Upload + drop ----

// ---- Zoom ----
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0];

function updateZoomLabel() {
  $('#zoom-label').textContent = Math.round(state.zoomFactor * 100) + '%';
}

async function setZoom(newFactor) {
  if (!state.paper) return;
  const clamped = Math.max(0.25, Math.min(4, newFactor));
  if (Math.abs(clamped - state.zoomFactor) < 0.001) return;
  // Preserve scroll position roughly across re-render.
  const wrap = $('.viewer-wrap') || viewer.parentElement;
  const oldRange = wrap.scrollHeight - wrap.clientHeight;
  const ratio = oldRange > 0 ? wrap.scrollTop / oldRange : 0;

  state.zoomFactor = clamped;
  localStorage.setItem('paperchat.zoom', String(clamped));
  updateZoomLabel();

  const { pages } = await renderPdf(state.paper.blob, viewer, BASE_SCALE * clamped);
  state.pages = pages;
  redrawHighlights();

  const newRange = wrap.scrollHeight - wrap.clientHeight;
  wrap.scrollTop = ratio * newRange;
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
  // One-shot: extract titles for any papers that don't have one (background)
  backfillTitles();
})();
