// Chapter-site runtime. Wires the primitives defined in pc.css:
//   - click any .pc-figure--zoom image to open a lightbox
//   - "Hide skipped" button in .pc-nav toggles all .pc-skip blocks
//   - hash-routed pagination across .pc-page elements when more than one
//   - KaTeX render pass on load via the shared pc-math util
//
// The module is intentionally framework-free so a generated single-file
// chapter bundle stays standalone.

import { renderMathIn } from './pc-math.js';

// --- Zoom lightbox --------------------------------------------------
function openZoom(src, alt) {
  const overlay = document.createElement('div');
  overlay.className = 'pc-zoom-overlay';
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt || '';
  overlay.appendChild(img);
  const close = () => overlay.remove();
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(overlay);
}

function wireZoom(root = document) {
  for (const fig of root.querySelectorAll('.pc-figure--zoom')) {
    const img = fig.querySelector('img');
    if (!img || img.dataset.pcZoom) continue;
    img.dataset.pcZoom = '1';
    img.addEventListener('click', () => openZoom(img.currentSrc || img.src, img.alt));
  }
}

// --- Skip toggle ----------------------------------------------------
function wireSkipToggle() {
  const btn = document.querySelector('.pc-skip-toggle');
  if (!btn) return;
  const sync = () => {
    const hidden = document.body.classList.contains('pc-skip-hide');
    btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    btn.textContent = hidden ? 'Show skipped' : 'Hide skipped';
  };
  btn.addEventListener('click', () => {
    document.body.classList.toggle('pc-skip-hide');
    sync();
  });
  sync();
}

// --- Infinite-scroll section tracking (autogo-style) ---------------
// All <section class="pc-page"> sections are laid out as one long
// document. As the user scrolls, IntersectionObserver detects which
// section is currently "active" (most visible in viewport) and updates
// the .pc-nav links + URL hash. Arrow keys advance to prev/next.
function wireSectionTracking() {
  const pages = [...document.querySelectorAll('section.pc-page')];
  if (!pages.length) return;
  const navLinks = [...document.querySelectorAll('.pc-nav a[href^="#"]')];
  let activeId = pages[0].id;

  function setActive(id) {
    if (id === activeId) return;
    activeId = id;
    for (const a of navLinks) {
      if (a.getAttribute('href') === '#' + id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    // Quietly update the URL hash without triggering a scroll.
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  }

  // Track which sections are visible. Pick the most-visible one as active.
  const visible = new Map(); // id -> intersectionRatio
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
      else visible.delete(e.target.id);
    }
    if (visible.size === 0) return;
    let bestId = null, bestRatio = -1;
    for (const p of pages) {
      const r = visible.get(p.id);
      if (r === undefined) continue;
      if (r > bestRatio) { bestRatio = r; bestId = p.id; }
    }
    if (bestId) setActive(bestId);
  }, {
    // Slim middle band — section is "active" when its top is roughly in
    // the upper-third of the viewport (autogo's pattern).
    rootMargin: '-30% 0px -55% 0px',
    threshold: [0, 0.25, 0.5, 0.75, 1.0],
  });
  for (const p of pages) observer.observe(p);

  // Nav-link click → smooth scroll to the target section.
  for (const a of navLinks) {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href').slice(1);
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(id);
    });
  }

  // Arrow-key navigation: ← / → move to prev/next page section.
  document.addEventListener('keydown', (e) => {
    // Ignore when the user is typing in an input or contentEditable.
    if (e.target.matches?.('input, textarea, [contenteditable="true"]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const idx = pages.findIndex(p => p.id === activeId);
    if (idx < 0) return;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'j') {
      if (idx < pages.length - 1) next = pages[idx + 1];
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'k') {
      if (idx > 0) next = pages[idx - 1];
    }
    if (next) {
      e.preventDefault();
      next.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActive(next.id);
    }
  });

  // If the page loads with a hash, scroll to it after a tick.
  if (location.hash) {
    const target = document.getElementById(location.hash.slice(1));
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'instant', block: 'start' }), 0);
  }
}

// --- Reveal-on-scroll animations -----------------------------------
// Elements with .pc-fade-in / .pc-rise / .pc-draw start invisible; when
// they enter the viewport we add .pc-revealed which triggers the CSS
// animation. Re-armed on each page change.
let _revealObserver = null;
function getRevealObserver() {
  if (_revealObserver) return _revealObserver;
  _revealObserver = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('pc-revealed');
        obs.unobserve(e.target);
      }
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });
  return _revealObserver;
}

function primeReveals(root = document) {
  // Number stagger children so the CSS calc() picks up an index.
  for (const group of root.querySelectorAll('.pc-stagger')) {
    let i = 0;
    for (const child of group.children) {
      if (child.classList.contains('pc-fade-in') || child.classList.contains('pc-rise')) {
        child.style.setProperty('--pc-i', String(i++));
      }
    }
  }
  // For .pc-draw, measure the SVG path length so CSS can dash it.
  for (const path of root.querySelectorAll('.pc-draw')) {
    try {
      const len = path.getTotalLength?.();
      if (Number.isFinite(len) && len > 0) {
        path.style.setProperty('--pc-len', String(Math.ceil(len)));
      }
    } catch {}
  }
  // Reset reveal state — used on page re-entry so animations replay.
  for (const el of root.querySelectorAll('.pc-fade-in, .pc-rise, .pc-draw')) {
    el.classList.remove('pc-revealed');
  }
}

function observeReveals(root = document) {
  const obs = getRevealObserver();
  for (const el of root.querySelectorAll('.pc-fade-in, .pc-rise, .pc-draw')) {
    if (!el.classList.contains('pc-revealed')) obs.observe(el);
  }
}

// --- Public timeline helper for figure animations ------------------
// Sequences a set of steps over time. Each step is { at, run } where
// `at` is ms from start and `run` is a callback. Cancellable via the
// returned function. Honors prefers-reduced-motion (snaps to last step).
function timeline(steps) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced && steps.length) { steps[steps.length - 1].run?.(); return () => {}; }
  const timers = [];
  for (const s of steps) {
    timers.push(setTimeout(() => { try { s.run?.(); } catch (e) { console.warn(e); } }, s.at || 0));
  }
  return () => { for (const t of timers) clearTimeout(t); };
}

// Animate an SVG path's stroke drawing in. Pass the <path> element + a
// duration in ms. Useful for the agent's interactive figures.
function drawPath(pathEl, durationMs = 1200) {
  try {
    const len = pathEl.getTotalLength?.() || 1000;
    pathEl.style.strokeDasharray = String(len);
    pathEl.style.strokeDashoffset = String(len);
    pathEl.getBoundingClientRect();  // force layout
    pathEl.style.transition = `stroke-dashoffset ${durationMs}ms cubic-bezier(0.2, 0.7, 0.2, 1)`;
    pathEl.style.strokeDashoffset = '0';
  } catch {}
}

// --- Heading anchors -----------------------------------------------
function wireAnchors() {
  for (const h of document.querySelectorAll('.pc-prose :is(h2, h3)[id]')) {
    if (h.querySelector('.pc-anchor')) continue;
    const a = document.createElement('a');
    a.className = 'pc-anchor';
    a.href = '#' + h.id;
    a.textContent = '#';
    a.title = 'Copy link';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const url = new URL(location.href);
      url.hash = h.id;
      navigator.clipboard?.writeText(url.toString());
    });
    h.prepend(a);
  }
}

// --- Source-page citations: click → jump in parent PDF viewer ------
// Every section has a `<div class="pc-source" data-page="40">pp. 40–42</div>`.
// When the chapter site is loaded inside paperchat (in an iframe),
// clicking the citation postMessage's the parent so it can close the
// chapter overlay and scroll the PDF viewer to that page. When the
// site is opened standalone (new tab), the click is a no-op (the
// parent isn't paperchat).
function wireSourceCitations() {
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('.pc-source');
    if (!el) return;
    e.preventDefault();
    const explicit = parseInt(el.dataset.page || '0', 10);
    // Fallback: parse the first number out of the visible text
    // (e.g. "pp. 40–42" → 40) so older sections without data-page
    // still work.
    const fromText = explicit || (() => {
      const m = (el.textContent || '').match(/\d+/);
      return m ? parseInt(m[0], 10) : 0;
    })();
    if (!fromText) return;
    try { window.parent?.postMessage({ type: 'paperchat:goto-page', page: fromText }, '*'); }
    catch {}
  });
}

// --- Boot ----------------------------------------------------------
function boot() {
  wireZoom();
  wireSkipToggle();
  wireSectionTracking();
  wireAnchors();
  wireSourceCitations();
  renderMathIn(document.body);
  // Always arm reveal animations across the whole document (sections
  // are no longer hidden/shown — they're all stacked and observed).
  primeReveals(document);
  observeReveals(document);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Expose for agent-generated interactive figures that mount after boot.
window.pcSite = {
  wireZoom, openZoom,
  timeline, drawPath,
  primeReveals, observeReveals,
};

// ====================================================================
// pc-* web components — reusable interactive figures
// --------------------------------------------------------------------
// The agent writes one tag like <pc-chain data='[…]'></pc-chain> and
// the component handles SVG geometry, animations, design tokens, and
// click wiring. That collapses ~30 lines of bug-prone SVG into ~4
// lines of JSON the agent fills in.
//
// All tokens come from pc.css via `style="fill: var(--accent)"` —
// inline SVG attrs like `fill="var(--accent)"` do NOT work (SVG
// doesn't parse CSS variables in presentation attributes).
//
// Pattern: every component reads its `data` attribute as JSON, falls
// back to an empty payload on parse failure, and renders into its own
// subtree. Boot wires `pcSite.primeReveals/observeReveals` so any
// .pc-fade-in/.pc-rise inside still animates on scroll.
// ====================================================================

function _pcData(el, fallback = null) {
  const raw = el.getAttribute('data');
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch (e) { console.warn(el.tagName + ' bad JSON:', e.message); return fallback; }
}
const _pcEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- pc-chain ---------------------------------------------------------
// data = [{label, sub?, detail?}, …]   3–5 nodes; click reveals detail.
class PcChain extends HTMLElement {
  connectedCallback() {
    const data = _pcData(this, []);
    if (!data.length) { this.innerHTML = '<em>pc-chain: empty data</em>'; return; }
    const W = 600, H = 120, gap = 24, n = data.length;
    const nw = (W - gap * (n - 1)) / n;
    const nodes = data.map((d, i) => {
      const x = i * (nw + gap);
      const cx = x + nw / 2;
      return `
        <g class="pc-chain-node" data-i="${i}" style="cursor:pointer">
          <rect x="${x}" y="35" width="${nw}" height="50" rx="6"
                style="fill: var(--paper); stroke: var(--accent); stroke-width: 1.5"/>
          <text x="${cx}" y="58" text-anchor="middle"
                style="font-family: var(--mono); font-size: 12px; fill: var(--ink); font-weight: 600">${_pcEsc(d.label)}</text>
          <text x="${cx}" y="74" text-anchor="middle"
                style="font-size: 10px; fill: var(--ink-soft)">${_pcEsc(d.sub || '')}</text>
        </g>
        ${i < n - 1 ? `<line x1="${x + nw}" y1="60" x2="${x + nw + gap}" y2="60"
          style="stroke: var(--ink-soft); stroke-width: 1.5" marker-end="url(#pc-arrow)"/>` : ''}`;
    }).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:${W}px; display:block; margin:0 auto;">
          <defs><marker id="pc-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" style="fill: var(--ink-soft)"/>
          </marker></defs>
          ${nodes}
        </svg>
        <div class="pc-chain-detail" style="margin-top:.6rem; min-height:2.4rem; padding:.5rem .8rem;
             background: var(--accent-soft); border-radius: 4px; font-size: 13px; color: var(--ink);">
          Click a node to see what it means.
        </div>
      </figure>`;
    const det = this.querySelector('.pc-chain-detail');
    const ns = this.querySelectorAll('.pc-chain-node');
    ns.forEach((el, i) => el.addEventListener('click', () => {
      det.textContent = data[i].detail || data[i].label;
      ns.forEach(o => o.querySelector('rect').style.fill = 'var(--paper)');
      el.querySelector('rect').style.fill = 'var(--accent-soft)';
    }));
  }
}

// --- pc-stepped -------------------------------------------------------
// data = [{title?, body, svg?}, …]   one step shown at a time; prev/next.
class PcStepped extends HTMLElement {
  connectedCallback() {
    const data = _pcData(this, []);
    if (!data.length) { this.innerHTML = '<em>pc-stepped: empty data</em>'; return; }
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div class="pc-stepped-stage" style="min-height: 160px; padding: 1rem 1.2rem;
             border: 1px solid var(--border); border-radius: 6px; background: var(--paper);"></div>
        <div class="pc-stepped-bar" style="display:flex; align-items:center; justify-content:space-between;
             margin-top:.5rem; font-family: var(--mono); font-size: 12px; color: var(--ink-soft);">
          <button class="pc-stepped-prev" style="font: inherit; border: 0; background: transparent;
                  cursor: pointer; color: var(--accent); padding: 4px 8px;">← prev</button>
          <span class="pc-stepped-count"></span>
          <button class="pc-stepped-next" style="font: inherit; border: 0; background: transparent;
                  cursor: pointer; color: var(--accent); padding: 4px 8px;">next →</button>
        </div>
      </figure>`;
    let i = 0;
    const stage = this.querySelector('.pc-stepped-stage');
    const count = this.querySelector('.pc-stepped-count');
    const render = () => {
      const s = data[i] || {};
      stage.innerHTML = (s.title ? `<h4 style="margin:0 0 .4rem; font-size: 14px; font-family: var(--mono); color: var(--accent);">${_pcEsc(s.title)}</h4>` : '') +
        (s.svg ? `<div style="margin: .4rem 0;">${s.svg}</div>` : '') +
        `<div style="font-size: 14px; line-height: 1.5;">${s.body || ''}</div>`;
      count.textContent = `${i + 1} / ${data.length}`;
    };
    this.querySelector('.pc-stepped-prev').addEventListener('click', () => { i = (i - 1 + data.length) % data.length; render(); });
    this.querySelector('.pc-stepped-next').addEventListener('click', () => { i = (i + 1) % data.length; render(); });
    render();
  }
}

// --- pc-timeline ------------------------------------------------------
// data = [{when, label, detail?}, …]   horizontal axis, click for detail.
class PcTimeline extends HTMLElement {
  connectedCallback() {
    const data = _pcData(this, []);
    if (!data.length) { this.innerHTML = '<em>pc-timeline: empty data</em>'; return; }
    const W = 640, H = 160, padX = 30, axisY = 80, n = data.length;
    const dx = n > 1 ? (W - padX * 2) / (n - 1) : 0;
    const dots = data.map((d, i) => {
      const x = padX + i * dx;
      return `
        <g class="pc-timeline-pt" data-i="${i}" style="cursor:pointer">
          <line x1="${x}" y1="${axisY}" x2="${x}" y2="${axisY - 18}" style="stroke: var(--ink-soft); stroke-width: 1"/>
          <circle cx="${x}" cy="${axisY}" r="6" style="fill: var(--accent); stroke: var(--paper); stroke-width: 2"/>
          <text x="${x}" y="${axisY - 24}" text-anchor="middle"
                style="font-family: var(--mono); font-size: 10px; fill: var(--ink); letter-spacing: 0.04em;">${_pcEsc(d.when)}</text>
          <text x="${x}" y="${axisY + 22}" text-anchor="middle"
                style="font-size: 12px; fill: var(--ink);">${_pcEsc(d.label)}</text>
        </g>`;
    }).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:${W}px; display:block; margin:0 auto;">
          <line x1="${padX}" y1="${axisY}" x2="${W - padX}" y2="${axisY}" style="stroke: var(--ink-soft); stroke-width: 1.5"/>
          ${dots}
        </svg>
        <div class="pc-timeline-detail" style="margin-top:.4rem; min-height: 2.4rem; padding:.5rem .8rem;
             background: var(--accent-soft); border-radius: 4px; font-size: 13px; color: var(--ink);">
          Click a point for context.
        </div>
      </figure>`;
    const det = this.querySelector('.pc-timeline-detail');
    this.querySelectorAll('.pc-timeline-pt').forEach((el, i) => el.addEventListener('click', () => {
      det.textContent = data[i].detail || data[i].label;
    }));
  }
}

// --- pc-grid ---------------------------------------------------------
// data = [{title, body, eyebrow?}, …]   responsive grid of comparison cards.
class PcGrid extends HTMLElement {
  connectedCallback() {
    const data = _pcData(this, []);
    if (!data.length) { this.innerHTML = '<em>pc-grid: empty data</em>'; return; }
    const cards = data.map(d => `
      <div class="pc-grid-card" style="padding: .8rem 1rem; border: 1px solid var(--border);
           border-radius: 6px; background: var(--paper);">
        ${d.eyebrow ? `<div style="font-family: var(--mono); font-size: 10px; text-transform: uppercase;
             letter-spacing: 0.08em; color: var(--accent); margin-bottom:.3rem;">${_pcEsc(d.eyebrow)}</div>` : ''}
        <div style="font-weight: 600; font-size: 14px; margin-bottom:.3rem; color: var(--ink);">${_pcEsc(d.title)}</div>
        <div style="font-size: 13px; color: var(--ink-soft); line-height: 1.5;">${d.body || ''}</div>
      </div>`).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .8rem;">
          ${cards}
        </div>
      </figure>`;
  }
}

// --- pc-toggle --------------------------------------------------------
// data = {a: {label, body}, b: {label, body}}   2-state A/B switch.
class PcToggle extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    if (!d.a || !d.b) { this.innerHTML = '<em>pc-toggle: need a and b</em>'; return; }
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div style="display:flex; gap:0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; width: max-content; margin: 0 auto;">
          <button class="pc-toggle-a" style="font: inherit; font-family: var(--mono); font-size: 12px;
                  padding: 6px 16px; border: 0; background: var(--accent); color: var(--paper); cursor: pointer;">${_pcEsc(d.a.label)}</button>
          <button class="pc-toggle-b" style="font: inherit; font-family: var(--mono); font-size: 12px;
                  padding: 6px 16px; border: 0; background: var(--paper); color: var(--ink); cursor: pointer;">${_pcEsc(d.b.label)}</button>
        </div>
        <div class="pc-toggle-body" style="margin-top:.8rem; padding: 1rem; border: 1px solid var(--border);
             border-radius: 6px; background: var(--paper); min-height: 100px;"></div>
      </figure>`;
    const body = this.querySelector('.pc-toggle-body');
    const aBtn = this.querySelector('.pc-toggle-a');
    const bBtn = this.querySelector('.pc-toggle-b');
    const setAB = (which) => {
      body.innerHTML = (which === 'a' ? d.a.body : d.b.body) || '';
      aBtn.style.background = which === 'a' ? 'var(--accent)' : 'var(--paper)';
      aBtn.style.color = which === 'a' ? 'var(--paper)' : 'var(--ink)';
      bBtn.style.background = which === 'b' ? 'var(--accent)' : 'var(--paper)';
      bBtn.style.color = which === 'b' ? 'var(--paper)' : 'var(--ink)';
    };
    aBtn.addEventListener('click', () => setAB('a'));
    bBtn.addEventListener('click', () => setAB('b'));
    setAB('a');
  }
}

// --- pc-slider --------------------------------------------------------
// data = {min, max, step?, value?, label, formula?, unit?}
// formula is a JS expression in `x` returning a number (or HTML string).
class PcSlider extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    if (d.min == null || d.max == null) { this.innerHTML = '<em>pc-slider: need min and max</em>'; return; }
    const { min, max, step = (max - min) / 100, value = min, label = 'x', formula, unit = '' } = d;
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div style="display:flex; align-items:center; gap: 1rem; font-family: var(--mono); font-size: 12px;">
          <label style="color: var(--ink-soft);">${_pcEsc(label)}</label>
          <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" style="flex:1; accent-color: var(--accent);"/>
          <span class="pc-slider-x" style="min-width: 4rem; text-align: right; color: var(--ink); font-weight: 600;"></span>
        </div>
        ${formula ? `<div class="pc-slider-out" style="margin-top:.8rem; padding:.8rem 1rem; background: var(--accent-soft);
             border-radius: 4px; font-family: var(--mono); font-size: 14px; color: var(--ink); text-align: center;"></div>` : ''}
      </figure>`;
    const range = this.querySelector('input[type=range]');
    const xEl = this.querySelector('.pc-slider-x');
    const out = this.querySelector('.pc-slider-out');
    const fmt = (v) => Number.isInteger(v) ? v : Number(v).toPrecision(4);
    const fn = formula ? new Function('x', `return (${formula});`) : null;
    const render = () => {
      const x = Number(range.value);
      xEl.textContent = fmt(x) + (unit ? ' ' + unit : '');
      if (fn && out) { try { out.innerHTML = String(fn(x)); } catch (e) { out.textContent = e.message; } }
    };
    range.addEventListener('input', render);
    render();
  }
}

// --- pc-plot ----------------------------------------------------------
// data = {kind: 'line'|'bar'|'scatter', series: [{name, points: [[x,y],…]}],
//         xLabel?, yLabel?, title?}
class PcPlot extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    const series = d.series || [];
    if (!series.length) { this.innerHTML = '<em>pc-plot: need series</em>'; return; }
    const W = 540, H = 320, m = { l: 50, r: 20, t: 28, b: 40 };
    const innerW = W - m.l - m.r, innerH = H - m.t - m.b;
    const all = series.flatMap(s => s.points);
    const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = Math.min(0, ...ys), ymax = Math.max(...ys);
    const sx = (x) => m.l + ((x - xmin) / (xmax - xmin || 1)) * innerW;
    const sy = (y) => m.t + innerH - ((y - ymin) / (ymax - ymin || 1)) * innerH;
    const palette = ['var(--accent)', 'var(--accent-alt)', 'var(--ink-soft)'];
    const renderSeries = (s, i) => {
      const color = palette[i % palette.length];
      if (d.kind === 'bar') {
        const bw = innerW / s.points.length * 0.7;
        return s.points.map(([x, y]) => `<rect x="${sx(x) - bw / 2}" y="${sy(y)}" width="${bw}" height="${sy(0) - sy(y)}"
          style="fill: ${color}; opacity: 0.85"/>`).join('');
      }
      if (d.kind === 'scatter') {
        return s.points.map(([x, y]) => `<circle cx="${sx(x)}" cy="${sy(y)}" r="4" style="fill: ${color}"/>`).join('');
      }
      // line
      const path = s.points.map(([x, y], j) => `${j ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');
      return `<path d="${path}" style="fill: none; stroke: ${color}; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round"/>` +
        s.points.map(([x, y]) => `<circle cx="${sx(x)}" cy="${sy(y)}" r="3" style="fill: ${color}"/>`).join('');
    };
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        ${d.title ? `<figcaption style="text-align:center; font-family: var(--mono); font-size: 12px; color: var(--ink-soft); margin-bottom:.4rem;">${_pcEsc(d.title)}</figcaption>` : ''}
        <svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:${W}px; display:block; margin:0 auto;">
          <line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${m.t + innerH}" style="stroke: var(--ink-soft); stroke-width: 1"/>
          <line x1="${m.l}" y1="${m.t + innerH}" x2="${m.l + innerW}" y2="${m.t + innerH}" style="stroke: var(--ink-soft); stroke-width: 1"/>
          ${series.map(renderSeries).join('')}
          ${d.xLabel ? `<text x="${m.l + innerW / 2}" y="${H - 8}" text-anchor="middle" style="font-family: var(--mono); font-size: 11px; fill: var(--ink-soft);">${_pcEsc(d.xLabel)}</text>` : ''}
          ${d.yLabel ? `<text transform="rotate(-90 ${14} ${m.t + innerH / 2})" x="${14}" y="${m.t + innerH / 2}" text-anchor="middle" style="font-family: var(--mono); font-size: 11px; fill: var(--ink-soft);">${_pcEsc(d.yLabel)}</text>` : ''}
          <text x="${m.l - 6}" y="${m.t + 4}" text-anchor="end" style="font-family: var(--mono); font-size: 10px; fill: var(--ink-soft);">${fmtNum(ymax)}</text>
          <text x="${m.l - 6}" y="${m.t + innerH + 4}" text-anchor="end" style="font-family: var(--mono); font-size: 10px; fill: var(--ink-soft);">${fmtNum(ymin)}</text>
          <text x="${m.l}" y="${m.t + innerH + 16}" text-anchor="middle" style="font-family: var(--mono); font-size: 10px; fill: var(--ink-soft);">${fmtNum(xmin)}</text>
          <text x="${m.l + innerW}" y="${m.t + innerH + 16}" text-anchor="middle" style="font-family: var(--mono); font-size: 10px; fill: var(--ink-soft);">${fmtNum(xmax)}</text>
        </svg>
        ${series.length > 1 ? `<div style="display:flex; gap:1rem; justify-content:center; margin-top:.4rem; font-size: 11px; font-family: var(--mono); color: var(--ink-soft);">
          ${series.map((s, i) => `<span><span style="display:inline-block; width:10px; height:10px; background:${palette[i % palette.length]}; margin-right:4px; vertical-align:middle;"></span>${_pcEsc(s.name || '')}</span>`).join('')}
        </div>` : ''}
      </figure>`;
    function fmtNum(v) { return Number.isInteger(v) ? v : Number(v).toPrecision(3); }
  }
}

// --- pc-annotated -----------------------------------------------------
// data = {src, hotspots: [{x, y, label, body?}]}  x,y in % (0-100).
class PcAnnotated extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    if (!d.src) { this.innerHTML = '<em>pc-annotated: need src</em>'; return; }
    const spots = (d.hotspots || []).map((h, i) => `
      <button class="pc-anno-pin" data-i="${i}" style="position: absolute; left: ${h.x}%; top: ${h.y}%;
              transform: translate(-50%, -50%); width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--paper);
              background: var(--accent); color: var(--paper); font-family: var(--mono); font-size: 11px; font-weight: 700;
              cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,.3); padding: 0;">${i + 1}</button>`).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div style="position: relative; display: inline-block; max-width: 100%;">
          <img src="${_pcEsc(d.src)}" alt="${_pcEsc(d.alt || '')}" style="display: block; max-width: 100%; height: auto;"/>
          ${spots}
        </div>
        <div class="pc-anno-detail" style="margin-top:.6rem; padding:.6rem .9rem; background: var(--accent-soft);
             border-radius: 4px; font-size: 13px; color: var(--ink); min-height: 2rem;">
          Click a numbered pin to read its label.
        </div>
      </figure>`;
    const det = this.querySelector('.pc-anno-detail');
    this.querySelectorAll('.pc-anno-pin').forEach((el, i) => el.addEventListener('click', () => {
      const h = d.hotspots[i];
      det.innerHTML = `<strong>${i + 1}. ${_pcEsc(h.label)}</strong>${h.body ? ' — ' + h.body : ''}`;
    }));
  }
}

// --- pc-equation ------------------------------------------------------
// data = {tex, terms: {symbol: definition}}   click any term in legend.
// `terms` keys are LaTeX (e.g. "\\chi_A"); the legend renders each as
// inline math via KaTeX, and the detail panel does the same on click.
class PcEquation extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    if (!d.tex) { this.innerHTML = '<em>pc-equation: need tex</em>'; return; }
    const terms = d.terms || {};
    // data-k stores the raw LaTeX key (used to look up the definition);
    // the button content wraps it in $...$ so KaTeX renders the symbol.
    const legend = Object.entries(terms).map(([k]) => `
      <button class="pc-eq-term" data-k="${_pcEsc(k)}" style="font: inherit; font-size: 13px;
              border: 1px solid var(--border); background: var(--paper); color: var(--ink); padding: 3px 10px;
              border-radius: 3px; cursor: pointer; min-width: 36px;">$${k}$</button>`).join('');
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise">
        <div class="pc-eq-display" style="text-align: center; font-size: 18px; padding: 1rem 0;">$$${d.tex}$$</div>
        ${Object.keys(terms).length ? `<div style="display:flex; flex-wrap:wrap; gap: .4rem; justify-content: center; margin: .4rem 0;">${legend}</div>
        <div class="pc-eq-detail" style="margin-top:.4rem; padding:.6rem .9rem; background: var(--accent-soft);
             border-radius: 4px; font-size: 14px; color: var(--ink); min-height: 2rem; text-align: center; line-height: 1.5;">
          Click any symbol above to see what it means.
        </div>` : ''}
      </figure>`;
    if (window.pcMath) window.pcMath.renderMathIn(this);
    const det = this.querySelector('.pc-eq-detail');
    this.querySelectorAll('.pc-eq-term').forEach(el => el.addEventListener('click', () => {
      const k = el.dataset.k;
      if (!det) return;
      // Highlight active term.
      this.querySelectorAll('.pc-eq-term').forEach(o => o.style.background = 'var(--paper)');
      el.style.background = 'var(--accent-soft)';
      // Render definition with the symbol re-rendered via KaTeX.
      det.innerHTML = `$${k}$ — ${terms[k]}`;
      if (window.pcMath) window.pcMath.renderMathIn(det);
    }));
  }
}

// --- pc-tree ----------------------------------------------------------
// data = {root: {label, body?, children: [{label, body?, children?}, …]}}
// Hierarchical content. Renders as nested collapsible cards (HTML, not
// SVG) so arbitrary-length labels and descriptions wrap naturally and
// the layout handles any depth. Each branch is a <details> the user
// can collapse — leaves are flat cards. Optional `body` is a longer
// description (or inline HTML) under the label.
class PcTree extends HTMLElement {
  connectedCallback() {
    const d = _pcData(this, {});
    if (!d.root) { this.innerHTML = '<em>pc-tree: need root</em>'; return; }
    const renderNode = (n, depth) => {
      const hasKids = Array.isArray(n.children) && n.children.length > 0;
      const label = `<span style="font-weight: 600; color: var(--ink);">${_pcEsc(n.label)}</span>`;
      const body = n.body
        ? `<div style="margin-top:.3rem; font-size: 13px; color: var(--ink-soft); line-height: 1.5;">${n.body}</div>`
        : '';
      const childrenHtml = hasKids
        ? `<div style="margin-top:.5rem; display: flex; flex-direction: column; gap:.4rem;">
             ${n.children.map(c => renderNode(c, depth + 1)).join('')}
           </div>`
        : '';
      const borderColor = depth === 0 ? 'var(--accent)' : 'var(--border)';
      if (hasKids) {
        return `
          <details ${depth < 2 ? 'open' : ''} style="border-left: 3px solid ${borderColor};
                  padding: .5rem .8rem; background: var(--paper); border-radius: 0 4px 4px 0;">
            <summary style="cursor: pointer; list-style: revert; user-select: none;">${label}</summary>
            ${body}
            ${childrenHtml}
          </details>`;
      }
      return `
        <div style="border-left: 3px solid ${borderColor}; padding: .5rem .8rem;
             background: var(--paper); border-radius: 0 4px 4px 0;">
          ${label}
          ${body}
        </div>`;
    };
    this.innerHTML = `
      <figure class="pc-fig-interactive pc-rise" style="max-width: 640px; margin: 0 auto;">
        ${renderNode(d.root, 0)}
      </figure>`;
  }
}

// --- pc-term ----------------------------------------------------------
// Inline term with a hover/focus tooltip showing its definition. Use
// for technical terms on first (or important) appearance:
//
//   The smallest repeating unit is the <pc-term def="The minimum
//   3D building block whose translation tiles the whole crystal.">
//   unit cell</pc-term>.
//
// The definition may contain inline HTML (including KaTeX delimiters);
// it's rendered via pcMath after the tooltip mounts.
// Mobile: tap toggles. Keyboard: focusable, Enter / Space toggle.
class PcTerm extends HTMLElement {
  connectedCallback() {
    if (this._wired) return;
    this._wired = true;
    const def = this.getAttribute('def') || '';
    // Preserve the original term text as the trigger; build the
    // tooltip alongside it. Use display:inline so it flows with prose.
    const text = this.textContent;
    this.textContent = '';
    this.classList.add('pc-term');
    this.setAttribute('tabindex', '0');
    this.setAttribute('role', 'button');
    this.setAttribute('aria-label', `${text} — definition`);
    const trigger = document.createElement('span');
    trigger.className = 'pc-term-trigger';
    trigger.textContent = text;
    const tip = document.createElement('span');
    tip.className = 'pc-term-tip';
    tip.setAttribute('role', 'tooltip');
    tip.innerHTML = def;
    this.appendChild(trigger);
    this.appendChild(tip);
    if (window.pcMath) window.pcMath.renderMathIn(tip);
    // Tap-to-toggle on touch / click; hover handled by CSS :hover.
    let open = false;
    const setOpen = (v) => {
      open = v;
      this.classList.toggle('pc-term-open', v);
    };
    this.addEventListener('click', (e) => {
      // Don't intercept clicks on links inside the definition.
      if (e.target.closest('a')) return;
      e.preventDefault();
      setOpen(!open);
    });
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); }
      if (e.key === 'Escape') setOpen(false);
    });
    // Dismiss when focus leaves.
    this.addEventListener('blur', () => setOpen(false));
  }
}

customElements.define('pc-chain',     PcChain);
customElements.define('pc-stepped',   PcStepped);
customElements.define('pc-timeline',  PcTimeline);
customElements.define('pc-grid',      PcGrid);
customElements.define('pc-toggle',    PcToggle);
customElements.define('pc-slider',    PcSlider);
customElements.define('pc-plot',      PcPlot);
customElements.define('pc-annotated', PcAnnotated);
customElements.define('pc-equation',  PcEquation);
customElements.define('pc-tree',      PcTree);
customElements.define('pc-term',      PcTerm);
