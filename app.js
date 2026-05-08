// Top-level app wiring: library, viewer, threads, settings.

import { Papers, Threads, Messages, uid, hashBlob } from './db.js';
import { renderPdf, getOutline, getPdfMetadataTitle, extractText, captureSelection, drawHighlight, clearHighlights, highlightQuoteOnPage } from './pdf.js';
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
const threadList = $('#thread-list');
const threadsEmpty = $('#threads-empty');
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
  viewerPlaceholder.style.display = 'none';
  viewer.innerHTML = '';
  viewer.appendChild(viewerPlaceholder);
  viewerPlaceholder.style.display = 'block';
  viewerPlaceholder.innerHTML = `<p>Rendering <b>${paper.name}</b>…</p>`;
  const { doc, pages } = await renderPdf(paper.blob, viewer);
  state.pages = pages;
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

function closePaper() {
  state.paper = null;
  state.pages = [];
  state.threads = [];
  state.activeThreadId = null;
  paperTitleEl.textContent = 'No paper open';
  document.title = 'paperchat';
  viewer.innerHTML = '';
  viewer.appendChild(viewerPlaceholder);
  viewerPlaceholder.style.display = 'block';
  viewerPlaceholder.innerHTML = '<p>Open or drop a PDF to begin.</p>';
  threadList.innerHTML = '';
  threadsEmpty.hidden = false;
  $('#contents-panel').hidden = true;
}

// ---- Threads (sidebar list + highlights) ----

function redrawHighlights() {
  clearHighlights(state.pages);
  for (const t of state.threads) {
    const page = state.pages.find(p => p.pageNum === t.pageNum);
    if (!page) continue;
    drawHighlight(page, t, {
      active: t.id === state.activeThreadId,
      onClick: openThread,
    });
  }
}

async function renderThreadList() {
  // Prefetch all messages BEFORE touching the DOM so concurrent calls can't interleave appends.
  const data = await Promise.all(
    state.threads.map(async t => ({ t, msgs: await Messages.byThread(t.id) }))
  );
  threadList.innerHTML = '';
  threadsEmpty.hidden = data.length > 0;
  for (const { t, msgs } of data) {
    const li = document.createElement('li');
    li.className = 'thread-card' + (t.id === state.activeThreadId ? ' active' : '');
    const last = msgs[msgs.length - 1];
    const lastText = last ? (last.role === 'assistant' ? `${last.mention || '@?'}: ${stripMd(last.content)}` : stripMd(last.content)) : '(empty)';
    li.innerHTML = `
      <div class="quote"></div>
      <div class="last"></div>
      <div class="meta"><span>p.${t.pageNum} · ${msgs.length} msg${msgs.length === 1 ? '' : 's'}</span><span class="time"></span></div>
    `;
    li.querySelector('.quote').textContent = t.quote;
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
    threadList.appendChild(li);
  }
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
  renderMathIn(el);
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
    defaultMention,
    createdAt: Date.now(),
  };
  await Threads.put(t);
  state.threads.push(t);
  redrawHighlights();
  await openThread(t.id, { prefill: defaultMention + ' ' });
}

// ---- Thread dialog ----

async function openThread(id, { prefill = '' } = {}) {
  const t = state.threads.find(x => x.id === id) || await Threads.get(id);
  if (!t) return;
  state.activeThreadId = id;
  threadDlgTitle.textContent = `Page ${t.pageNum} · default ${t.defaultMention}`;
  threadQuoteEl.textContent = t.quote;
  threadMsgsEl.innerHTML = '';
  const msgs = await Messages.byThread(id);
  for (const m of msgs) renderMessage(m);
  threadInput.value = prefill;
  threadDlg.showModal();
  threadMsgsEl.scrollTop = threadMsgsEl.scrollHeight;
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
  threadMsgsEl.scrollTop = threadMsgsEl.scrollHeight;
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
  threadMsgsEl.scrollTop = threadMsgsEl.scrollHeight;

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
        threadMsgsEl.scrollTop = threadMsgsEl.scrollHeight;
      },
      onToolCall: (tc) => {
        toolCalls.push(tc);
        freezeCurrentSegment();
        const tcEl = buildToolCard(tc);
        // Insert tool card before the (empty) currentBody so order is preserved
        card.el.insertBefore(tcEl, currentBody);
        segments.push({ type: 'tool', tc });
        threadMsgsEl.scrollTop = threadMsgsEl.scrollHeight;
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
  return detailsEl;
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
