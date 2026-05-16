// Zero-dep dev server. Serves static files + /env.js generated from .env / .env.local.
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, unlink, stat, mkdir, access } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
// Per-workdir active SDK run aborters. Regenerate kicks off a fresh
// chapter_summary for the same dir; we abort the prior run first so
// its in-flight subagents stop writing files into the freshly-wiped
// directory (which would otherwise pollute the new run with stale
// plan.json / sections / index.html).
const _activeRuns = new Map();
const DATA_DIR = process.env.PAPERCHAT_DATA || join(homedir(), '.paperchat');
const PAPERS_DIR = join(DATA_DIR, 'papers');
const THREADS_DIR = join(DATA_DIR, 'threads');
const MESSAGES_DIR = join(DATA_DIR, 'messages');
await mkdir(PAPERS_DIR, { recursive: true });
await mkdir(THREADS_DIR, { recursive: true });
await mkdir(MESSAGES_DIR, { recursive: true });

// Whitelist — anything here is readable by any script on the page. Add deliberately.
const EXPOSED_KEYS = ['OPENROUTER_API_KEY'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function parseEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

async function readEnvFiles() {
  const merged = {};
  for (const name of ['.env', '.env.local']) {
    try {
      const raw = await readFile(join(ROOT, name), 'utf8');
      Object.assign(merged, parseEnv(raw));
    } catch {}
  }
  return merged;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MAX_FETCH_BYTES = 200_000;
const MAX_RETURN_CHARS = 80_000;

async function proxyFetch(target) {
  let parsed;
  try { parsed = new URL(target); }
  catch { throw Object.assign(new Error('invalid url'), { status: 400 }); }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw Object.assign(new Error('only http(s) URLs allowed'), { status: 400 });
  }
  // Block private hosts to keep the proxy from being abused for SSRF.
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '0.0.0.0'
  ) {
    throw Object.assign(new Error('private/loopback hosts blocked'), { status: 403 });
  }

  const r = await fetch(target, {
    redirect: 'follow',
    headers: { 'user-agent': 'paperchat/0.1 (+local dev)' },
  });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  // Cap incoming bytes.
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let raw = '';
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > MAX_FETCH_BYTES) {
      raw += dec.decode(value.slice(0, MAX_FETCH_BYTES - (bytes - value.length)));
      try { reader.cancel(); } catch {}
      raw += '\n\n[truncated at ' + MAX_FETCH_BYTES + ' bytes]';
      break;
    }
    raw += dec.decode(value, { stream: true });
  }
  raw += dec.decode();

  let text;
  let viaJina = false;
  if (ct.includes('html') || ct.includes('xml+xhtml')) {
    text = stripHtml(raw);
    // If the page appears JS-rendered (lots of <script>, almost no
    // extracted body text) retry via r.jina.ai, which loads the URL in
    // a real browser and returns clean markdown. Free, no auth.
    const looksEmpty = text.length < 500;
    const isSpa = /<script[\s>]/i.test(raw) && raw.length > 2000;
    if (looksEmpty && isSpa) {
      try {
        const jr = await fetch(`https://r.jina.ai/${target}`, {
          headers: { 'user-agent': 'paperchat/0.1', accept: 'text/plain' },
          signal: AbortSignal.timeout(20000),
        });
        if (jr.ok) {
          const jt = await jr.text();
          // Only accept the rendered version if it's clearly more useful
          // than the raw HTML strip — defends against jina returning a
          // captcha/error page that's also short.
          if (jt && jt.length > Math.max(text.length + 200, 600)) {
            text = jt;
            viaJina = true;
          }
        }
      } catch {
        // network/timeout — keep the original stripped text
      }
    }
  } else if (ct.includes('pdf')) {
    text = `[content-type: ${ct}] PDF fetched from URL is not extracted server-side. ` +
           `For arXiv papers, prefer the /abs/ or /html/ URL instead of /pdf/.`;
  } else if (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript')
  ) {
    text = raw;
  } else {
    text = `[unsupported content-type: ${ct}]`;
  }
  if (text.length > MAX_RETURN_CHARS) {
    text = text.slice(0, MAX_RETURN_CHARS) + `\n\n[truncated at ${MAX_RETURN_CHARS} chars]`;
  }
  return { status: r.status, finalUrl: r.url, contentType: ct, text, viaJina };
}

// On macOS, the local `claude` CLI stores its API key in the login keychain
// under service name "Claude Code". We can read it as a free fallback so the
// @code path uses the same billing account as the user's local Claude Code
// session, without them having to copy the key into .env.
import { spawn } from 'node:child_process';
async function readMacKeychain(service) {
  if (process.platform !== 'darwin') return '';
  return await new Promise((resolve) => {
    const p = spawn('security', ['find-generic-password', '-s', service, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => resolve(code === 0 ? out.trim() : ''));
    p.on('error', () => resolve(''));
  });
}

// Run a CLI command, resolve with { code, out, err }. Used to shell out to
// pdftocairo from the chapter-summary endpoint.
function runCmd(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    let done = false;
    const finish = (code) => { if (done) return; done = true; resolve({ code, out, err }); };
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish(-1); }, timeoutMs);
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => { clearTimeout(t); finish(code ?? -1); });
    p.on('error', e => { clearTimeout(t); err += '\n' + e.message; finish(-1); });
  });
}

// Recursively copy a directory tree. Used to stage _lib/ into the agent
// workdir so the agent can link/reference (and ultimately inline) the
// CSS/JS primitives + autogo reference.
async function copyDir(src, dst) {
  const { copyFile, readdir, mkdir, stat } = await import('node:fs/promises');
  await mkdir(dst, { recursive: true });
  for (const name of await readdir(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    const st = await stat(s);
    if (st.isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

// POST /api/chapter_summary
// Body: {
//   paperId, chapterId, paperName, chapterTitle, startPage, endPage,
//   pdfBase64, plannerModel?, writerModel?
// }
// Stages a workdir under cc-workdir/chapter-<paperId>-<chapterId>/, rasterizes
// the chapter pages via pdftocairo, copies _lib/ in, then launches the
// Claude Agent SDK to produce an interactive HTML chapter site. SSE-streams
// progress events back.
// The per-message `usage` we emit during streaming only covers the
// parent agent's own turns — subagent token usage is NOT included.
// The SDK's final `result` message has the authoritative aggregate
// (parent + every subagent, broken out per model) in `modelUsage`.
// Flatten + forward so the client can show real totals (incl. all the
// HTML the section-writers actually wrote).
function emitFinalUsage(send, msg) {
  const mu = msg.modelUsage || {};
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const v of Object.values(mu)) {
    totals.input         += v.inputTokens || 0;
    totals.output        += v.outputTokens || 0;
    totals.cacheCreation += v.cacheCreationInputTokens || 0;
    totals.cacheRead     += v.cacheReadInputTokens || 0;
  }
  send({ type: 'usage_total', modelUsage: mu, totals, totalCostUsd: msg.total_cost_usd });
}

async function handleChapterSummary(req, res) {
  let apiKey = await readMacKeychain('Claude Code');
  if (!apiKey) {
    const env = await readEnvFiles();
    apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  }
  if (!apiKey) {
    res.writeHead(400);
    return res.end('No Anthropic credentials. Sign in to `claude` CLI or set ANTHROPIC_API_KEY.');
  }

  let payload;
  try { payload = await readJsonBody(req, 200 * 1024 * 1024); }
  catch (e) { res.writeHead(e.status || 400); return res.end('invalid JSON: ' + e.message); }

  const {
    paperId, chapterId, paperName = 'Untitled', chapterTitle = 'Chapter',
    startPage, endPage, pdfBase64,
    plannerModel = 'claude-opus-4-7',
    writerModel  = 'claude-sonnet-4-6',
  } = payload || {};

  if (!paperId || !chapterId || !pdfBase64
      || !Number.isInteger(startPage) || !Number.isInteger(endPage) || endPage < startPage) {
    res.writeHead(400);
    return res.end('paperId, chapterId, startPage, endPage, pdfBase64 required');
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  // Stage workdir.
  // Fresh kickoff = blow away any prior workdir for this (paper, chapter)
  // so the agent doesn't re-edit a stale index.html. The resume endpoint
  // is the only path that preserves prior state.
  const safeId = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const dirName = `chapter-${safeId(paperId)}-${safeId(chapterId)}`;
  const workdir = join(ROOT, 'cc-workdir', dirName);
  // Cancel any prior run for the same dir BEFORE the wipe — otherwise
  // its in-flight subagents will write files back into the freshly-
  // recreated workdir and the new agent will see stale plan.json /
  // sections / index.html.
  const prev = _activeRuns.get(dirName);
  if (prev) {
    try { prev.abort(); } catch {}
    _activeRuns.delete(dirName);
    // Brief beat to let the SDK's spawned processes wind down before
    // we wipe — open file handles can otherwise re-create files.
    await new Promise(r => setTimeout(r, 200));
  }
  const { rm } = await import('node:fs/promises');
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });

  // Persist every SSE event to <workdir>/trace.jsonl so the user can
  // inspect the run later (thinking, tool calls, streamed text, errors,
  // final result). One JSON object per line.
  //
  // The trace is the source of truth. If the SSE client disconnects (page
  // reload, panel closed) we keep the agent + trace writes alive — a
  // separate /api/chapter_runs/replay endpoint can attach to the trace
  // and replay+tail it. Hence the clientGone flag below.
  const { createWriteStream } = await import('node:fs');
  const traceStream = createWriteStream(join(workdir, 'trace.jsonl'), { flags: 'w' });
  const traceStart = Date.now();
  let clientGone = false;
  res.on('close', () => { clientGone = true; });
  const send = (obj) => {
    const line = JSON.stringify({ t: Date.now() - traceStart, ...obj }) + '\n';
    traceStream.write(line);
    if (!clientGone) {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
      catch { clientGone = true; }
    }
  };

  // Persist the run's parameters so /api/chapter_runs/resume can re-invoke
  // the agent with the right models + chapter context after a crash.
  await writeFile(join(workdir, 'params.json'), JSON.stringify({
    paperId, chapterId, paperName, chapterTitle,
    startPage, endPage, plannerModel, writerModel,
  }, null, 2));

  send({ type: 'stage', message: `Workdir: ${workdir}` });
  send({ type: 'stage', message: `Trace: ${join(workdir, 'trace.jsonl')}` });

  // Wrap the setup phase so an internal error (pdftocairo crash, magick
  // failure, etc.) becomes a streamed `error` event instead of crashing
  // the dev-server process. Without this, the unhandled exception
  // escapes to the top-level handler which tries writeHead(500) on an
  // already-streaming SSE response → ERR_HTTP_HEADERS_SENT → server dies.
  // Hoisted so they survive the try-block scope and are available to the
  // agent launch below.
  let systemPrompt, userPrompt;
  try {

  // 1) Save the PDF
  const pdfPath = join(workdir, 'chapter.pdf');
  await writeFile(pdfPath, Buffer.from(pdfBase64, 'base64'));
  send({ type: 'stage', message: `Wrote chapter.pdf (${(pdfBase64.length * 0.75 / 1024 / 1024).toFixed(2)} MB)` });

  // 2) Rasterize chapter pages with pdftocairo at 200 DPI. Output named
  //    page-<N>.png with absolute PDF page number. pdftocairo doesn't
  //    print per-page progress, but it writes each page as a separate
  //    .png as it goes — so we poll the output dir and surface (i/N)
  //    progress while the command is running.
  const pagesDir = join(workdir, 'pages');
  await mkdir(pagesDir, { recursive: true });
  const totalPages = endPage - startPage + 1;
  send({ type: 'stage', message: `Rasterizing pages ${startPage}-${endPage}… (0/${totalPages})` });
  const t0 = Date.now();
  const rasterPromise = runCmd('pdftocairo', [
    '-png', '-r', '200',
    '-f', String(startPage), '-l', String(endPage),
    pdfPath, join(pagesDir, 'page'),
  ], { timeoutMs: 300_000 });
  let lastCount = -1;
  const poller = setInterval(async () => {
    try {
      const n = (await readdir(pagesDir)).filter(f => f.endsWith('.png')).length;
      if (n !== lastCount) {
        lastCount = n;
        send({ type: 'stage', message: `Rasterizing pages ${startPage}-${endPage}… (${n}/${totalPages})` });
      }
    } catch {}
  }, 250);
  const pc = await rasterPromise;
  clearInterval(poller);
  if (pc.code !== 0) {
    send({ type: 'error', message: `pdftocairo exited ${pc.code}: ${pc.err.slice(0, 500)}` });
    return res.end();
  }
  const pageFiles = (await readdir(pagesDir)).filter(n => n.endsWith('.png')).sort();
  send({ type: 'stage', message: `Rasterized ${pageFiles.length} pages in ${Date.now() - t0}ms` });

  // 2b) Compose batches of N pages into labeled JPEG grids — gives the
  //     agent compact multi-page views instead of N independent images.
  //     Each composite tiles its pages vertically, labeled with the
  //     absolute PDF page number. Saved at moderate resolution so a single
  //     image stays under Anthropic's 5MB/8000px limits.
  const compositesDir = join(workdir, 'composites');
  await mkdir(compositesDir, { recursive: true });
  const BATCH = 4;
  const composites = [];
  // pageFiles are sorted lexicographically; map back to absolute page numbers
  // by stripping the page-<NNN>.png pattern.
  const pageFileNum = (n) => parseInt(n.match(/page-(\d+)\.png/)?.[1] || '0', 10);
  const sortedPages = [...pageFiles].sort((a, b) => pageFileNum(a) - pageFileNum(b));
  for (let i = 0; i < sortedPages.length; i += BATCH) {
    const slice = sortedPages.slice(i, i + BATCH);
    const firstPn = pageFileNum(slice[0]);
    const lastPn = pageFileNum(slice[slice.length - 1]);
    const outName = `pages-${String(firstPn).padStart(3, '0')}-${String(lastPn).padStart(3, '0')}.jpg`;
    const outPath = join(compositesDir, outName);
    // magick montage: tile 1×N, label each panel with its page number,
    // moderate panel size so the whole composite stays under ~6000px tall.
    const inputs = slice.map(n => `label:Page ${pageFileNum(n)}\n${join(pagesDir, n)}`);
    // Use the array form so panel labels work; -label prefixes the next file.
    const args = [];
    for (const n of slice) {
      args.push('-label', `Page ${pageFileNum(n)}`, join(pagesDir, n));
    }
    args.push('-tile', `1x${slice.length}`, '-geometry', '1100x>+8+8',
              '-background', '#faf8f3', '-fill', '#1f1d1a',
              '-pointsize', '20',
              // macOS ImageMagick can't resolve 'Helvetica' by name without
              // a fontconfig setup; point straight at the system font.
              '-font', '/System/Library/Fonts/Helvetica.ttc',
              '-quality', '85',
              outPath);
    const r = await runCmd('magick', ['montage', ...args], { timeoutMs: 60_000 });
    if (r.code !== 0) {
      send({ type: 'stage', message: `magick montage exited ${r.code}: ${r.err.slice(0, 200)}` });
      continue;
    }
    composites.push({ name: outName, firstPn, lastPn, count: slice.length });
  }
  send({ type: 'stage', message: `Built ${composites.length} composite(s) of up to ${BATCH} pages each → composites/` });

  // 3) Extract every embedded raster figure with pdfimages. Each file is
  //    named img-<page>-<idx>.<ext>. The agent can either reference these
  //    directly with <img> tags or recreate the figure as SVG — its call.
  const figuresDir = join(workdir, 'figures');
  await mkdir(figuresDir, { recursive: true });
  const pi = await runCmd('pdfimages', [
    '-all', '-p', '-f', String(startPage), '-l', String(endPage),
    pdfPath, join(figuresDir, 'img'),
  ], { timeoutMs: 120_000 });
  const figFiles = (await readdir(figuresDir)).filter(n => /\.(png|jpg|jpeg|tif|tiff|jb2)$/i.test(n)).sort();
  if (pi.code !== 0) {
    send({ type: 'stage', message: `pdfimages exited ${pi.code} (continuing): ${pi.err.slice(0, 200)}` });
  } else {
    send({ type: 'stage', message: `Extracted ${figFiles.length} embedded image(s) → figures/` });
  }

  // 4) Copy _lib/ into the workdir so the agent can read (and link to) it.
  await copyDir(join(ROOT, '_lib'), join(workdir, '_lib'));
  send({ type: 'stage', message: 'Copied _lib/ (pc.css, pc.js, pc-math.js, template.html, ref/autogo.html)' });

  // 5) Drop a tiny crop helper so the agent can extract figures from
  //    the rasterized pages with one short command.
  const cropScript = `#!/bin/bash
# crop PAGE x y W H out.png  — crop a region of pages/page-PAGE.png
#   PAGE is the absolute PDF page number; x/y are pixel coords measured
#   from the top-left of the rasterized page (200 DPI, ≈2.78 px/pt).
#   Use this to extract vector figures the PDF doesn't embed as bitmaps.
set -euo pipefail
PAGE="$1"; X="$2"; Y="$3"; W="$4"; H="$5"; OUT="$6"
src="pages/page-$(printf '%03d' "$PAGE").png"
[ -f "$src" ] || { echo "no such page raster: $src" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
magick "$src" -crop "\${W}x\${H}+\${X}+\${Y}" +repage "$OUT"
echo "wrote $OUT ($(magick identify -format '%wx%h' "$OUT"))"
`;
  await writeFile(join(workdir, 'crop'), cropScript, { mode: 0o755 });
  send({ type: 'stage', message: 'Wrote crop helper (./crop PAGE x y W H out.png)' });

  // Build the system prompt. For the skeleton run, this is a minimal one
  // pass — once it's working end-to-end the 4-pass plan replaces it.
  systemPrompt = buildChapterAgentPrompt({
    paperName, chapterTitle, startPage, endPage,
    pageFiles, figFiles, composites, plannerModel, writerModel,
  });
  // Initial user prompt — tell the agent what to read first.
  const compList = composites.map(c =>
    c.count === 1
      ? `  composites/${c.name}  (page ${c.firstPn})`
      : `  composites/${c.name}  (pages ${c.firstPn}–${c.lastPn})`
  ).join('\n');
  userPrompt = `Generate the chapter site for "${chapterTitle}" now.

Read these composite page-grid images first to understand the chapter — each one is up to 4 pages stacked vertically, labeled by page number:

${compList}

Then write index.html using the _lib/pc.css vocabulary and the autogo aesthetic. Recreate figures inline as SVG/Canvas where it makes sense, or embed extracted bitmaps from figures/ — your call per figure.`;

  } catch (setupErr) {
    // From my outer try wrapping the setup phase (rasterize / composite
    // / pdfimages / copy _lib / drop crop / save params). Any failure
    // here streams a clean error event and ends the response without
    // crashing the dev-server.
    console.error('chapter_summary setup failed:', setupErr?.stack || setupErr);
    send({ type: 'error', message: 'Setup failed: ' + (setupErr?.message || setupErr) });
    try { traceStream.end(); } catch {}
    if (!clientGone) { try { res.end(); } catch {} }
    return;
  }

  let query;
  try {
    ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
  } catch (e) {
    send({ type: 'error', message: 'SDK not installed: ' + e.message });
    return res.end();
  }

  // Watch the workdir's .phase file — the agent writes phase names to
  // it at transitions ("planning", "skeleton", "dispatching", "writing",
  // "polishing") via `echo <phase> > .phase`. Each change becomes a
  // `phase` SSE event so the UI can switch step indicators without
  // relying on text/thinking heuristics. fs.watch in the dir picks up
  // create/rename/modify events on the file.
  const { watch } = await import('node:fs');
  const phasePath = join(workdir, '.phase');
  let lastPhase = '';
  const phaseWatcher = watch(workdir, async (evType, filename) => {
    if (filename !== '.phase') return;
    try {
      const v = (await readFile(phasePath, 'utf8')).trim();
      if (v && v !== lastPhase) {
        lastPhase = v;
        send({ type: 'phase', name: v });
      }
    } catch {}
  });

  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = apiKey;
  // Register our abort controller for this dirName so a subsequent
  // regenerate can cancel us cleanly.
  const abortController = new AbortController();
  _activeRuns.set(dirName, abortController);
  try {
    send({ type: 'stage', message: 'Launching agent…' });
    // Load the subagent brief so we can pass it as the section-writer's
    // system prompt — that's the cleanest way to share global rules
    // (vocabulary, image paths, JS pitfalls, brevity) across subagents.
    let subagentBrief = '';
    try { subagentBrief = await readFile(join(workdir, '_lib/ref/subagent-brief.md'), 'utf8'); } catch {}
    const iter = query({
      prompt: userPrompt,
      options: {
        systemPrompt,
        abortController,
        cwd: workdir,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        settingSources: [],
        skills: [],
        // Default model is the writer; agent can override per-call.
        model: writerModel,
        // The planner's job is to FAN OUT, not to author content. Cap
        // thinking so it doesn't draft full HTML in its head — we saw
        // 6+ min of pure thinking and 30K thinking-chars (≈10K tokens)
        // drafting all 10 sections inline before any tool call. Budget
        // here is calibrated to allow real planning (pick sections,
        // pair pages to concepts, choose components) but not enough to
        // fit drafts of 10 SVGs.
        effort: 'medium',
        thinking: { type: 'enabled', budgetTokens: 8000 },
        // Define the section-writer subagent so the main agent can dispatch
        // N of these in parallel via the Task tool. Each runs as Sonnet
        // with the brief as its system prompt — sharing the global rules.
        agents: {
          'section-writer': {
            description: 'Writes one HTML fragment to sections/<id>.html for one concept page of a paperchat chapter site. Use one of these per planned section, dispatched in parallel.',
            prompt: subagentBrief || 'Write a paperchat chapter section as an HTML fragment to sections/<id>.html. Use only the .pc-* class vocabulary. Image paths are relative to index.html (use figures/, not ../figures/).',
            tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
            model: writerModel,
            // Subagents do the actual authoring — let them think
            // deeply about each section's prose, figure choice, and
            // SVG geometry. AgentDefinition's effort does NOT inherit
            // from the parent (per SDK type def), so set it here.
            effort: 'high',
          },
        },
      },
    });
    // With includePartialMessages: true, the SDK re-yields the same
    // assistant message many times as it streams. Dedupe so we don't
    // forward (and double-count) the same tool_use / usage / thinking.
    const seenToolUseIds = new Set();
    const seenUsageMsgIds = new Set();
    const seenThinkingMsgIds = new Set();
    for await (const msg of iter) {
      const t = msg?.type;
      if (t === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta') {
          // Visible assistant text
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            send({ type: 'text', content: ev.delta.text });
          }
          // Extended-thinking reasoning. Forward so the trace captures it
          // and the UI panel can display a dimmed "thinking…" stream.
          else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            send({ type: 'thinking', content: ev.delta.thinking });
          }
        }
        continue;
      }
      if (t === 'assistant') {
        // Streaming yields the same assistant message multiple times
        // (partial → complete). Dedupe tool_use by id; for usage, emit
        // the LATEST observation per msgId (later partials have the
        // final output_tokens count) so the client can replace earlier
        // partials with the complete usage when summing totals.
        const msgId = msg.message?.id;
        for (const b of msg.message?.content || []) {
          if (b.type === 'tool_use' && b.id && !seenToolUseIds.has(b.id)) {
            seenToolUseIds.add(b.id);
            send({ type: 'tool_use', id: b.id, name: b.name, args: b.input || {} });
          } else if (b.type === 'thinking' && !seenThinkingMsgIds.has(msgId)) {
            send({ type: 'thinking_complete', content: b.thinking || '' });
          }
        }
        if (msgId) seenThinkingMsgIds.add(msgId);
        const u = msg.message?.usage;
        if (u && msgId) {
          // Emit msgId so client can keep one canonical usage per turn
          // and replace partial reports with the complete one.
          send({
            type: 'usage',
            msgId,
            input: u.input_tokens || 0,
            output: u.output_tokens || 0,
            cacheCreation: u.cache_creation_input_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0,
          });
        }
      } else if (t === 'user') {
        for (const b of msg.message?.content || []) {
          if (b.type === 'tool_result') {
            const content = Array.isArray(b.content)
              ? b.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n')
              : String(b.content ?? '');
            send({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, result: content });
          }
        }
      } else if (t === 'result') {
        emitFinalUsage(send, msg);
        if (msg.subtype && msg.subtype.startsWith('error_')) {
          send({ type: 'error', message: (msg.errors && msg.errors.join('\n')) || msg.subtype });
        } else {
          send({ type: 'done', stopReason: msg.stop_reason, totalCostUsd: msg.total_cost_usd, workdir });
        }
      } else if (t === 'system') {
        // Init / model info — small payload for trace.
        send({ type: 'system', subtype: msg.subtype, model: msg.model });
      }
    }
  } catch (err) {
    send({ type: 'error', message: err.message || String(err) });
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    try { phaseWatcher.close(); } catch {}
    try { traceStream.end(); } catch {}
    if (!clientGone) { try { res.end(); } catch {} }
    // Only clear the active-run slot if it's still OUR controller.
    // A subsequent regenerate may have already replaced it.
    if (_activeRuns.get(dirName) === abortController) {
      _activeRuns.delete(dirName);
    }
  }
}

// GET /api/chapter_runs/active?paperId=X
// Lists chapter-summary runs whose trace.jsonl exists but doesn't end
// with a terminal event (done / error). Used on page load to reattach
// the progress panel to in-flight runs that survived a reload.
async function handleListActiveRuns(req, res, url) {
  const paperId = url.searchParams.get('paperId');
  if (!paperId) { res.writeHead(400); return res.end('paperId required'); }
  const safe = String(paperId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const prefix = `chapter-${safe}-`;
  const ccDir = join(ROOT, 'cc-workdir');
  let entries;
  try { entries = await readdir(ccDir); }
  catch (e) { if (e.code === 'ENOENT') return sendJson(res, 200, []); throw e; }
  const out = [];
  // Runs whose trace.jsonl hasn't been written for this long are
  // considered "stale" — the agent process died (server restart, crash).
  // We still return them with status='stale' so the client can resume
  // them via /api/chapter_runs/resume; only terminal runs are filtered.
  const STALE_THRESHOLD_MS = 90_000;
  const nowMs = Date.now();
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const tracePath = join(ccDir, name, 'trace.jsonl');
    let st;
    try { st = await stat(tracePath); } catch { continue; }
    if (!st.isFile()) continue;
    let buf;
    try { buf = await readFile(tracePath, 'utf8'); } catch { continue; }
    const lines = buf.split('\n').filter(Boolean);
    if (!lines.length) continue;
    let lastEv;
    try { lastEv = JSON.parse(lines[lines.length - 1]); } catch {}
    const isTerminal = lastEv?.type === 'done' || lastEv?.type === 'error';
    if (isTerminal) continue;
    const stale = (nowMs - st.mtimeMs) > STALE_THRESHOLD_MS;
    const chapterId = name.slice(prefix.length);
    out.push({
      chapterId,
      dirName: name,
      lineCount: lines.length,
      lastEventAtMs: lastEv?.t || 0,
      traceMtime: st.mtimeMs,
      status: stale ? 'stale' : 'live',
    });
  }
  sendJson(res, 200, out);
}

// POST /api/chapter_runs/resume?dir=<dirName>
// Re-invokes the Claude Agent SDK against an existing chapter workdir,
// using `continue: true` so the SDK resumes the prior conversation in
// that directory. Appends to the existing trace.jsonl. Streams new
// events as SSE just like /api/chapter_summary. Used when a previous
// run was interrupted (server restart, network drop) and the trace
// shows no terminal event.
async function handleResumeRun(req, res, url) {
  const dirName = url.searchParams.get('dir') || '';
  if (!/^chapter-[a-zA-Z0-9._-]+$/.test(dirName)) {
    res.writeHead(400); return res.end('invalid dir');
  }
  const workdir = join(ROOT, 'cc-workdir', dirName);
  let params;
  try { params = JSON.parse(await readFile(join(workdir, 'params.json'), 'utf8')); }
  catch { res.writeHead(404); return res.end('no params.json — run was started before resume support'); }

  let apiKey = await readMacKeychain('Claude Code');
  if (!apiKey) {
    const env = await readEnvFiles();
    apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  }
  if (!apiKey) { res.writeHead(400); return res.end('No Anthropic credentials'); }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  const { createWriteStream } = await import('node:fs');
  // Append to the existing trace so the full history is preserved.
  const traceStream = createWriteStream(join(workdir, 'trace.jsonl'), { flags: 'a' });
  const traceStart = Date.now();
  let clientGone = false;
  res.on('close', () => { clientGone = true; });
  const send = (obj) => {
    const line = JSON.stringify({ t: Date.now() - traceStart, ...obj }) + '\n';
    traceStream.write(line);
    if (!clientGone) {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
      catch { clientGone = true; }
    }
  };

  send({ type: 'stage', message: `Resuming agent in ${dirName} (continue: true)…` });

  let query;
  try { ({ query } = await import('@anthropic-ai/claude-agent-sdk')); }
  catch (e) {
    send({ type: 'error', message: 'SDK not installed: ' + e.message });
    try { traceStream.end(); } catch {}
    if (!clientGone) try { res.end(); } catch {}
    return;
  }

  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = apiKey;
  try {
    const iter = query({
      prompt:
        'You are resuming a chapter-site build. ' +
        'STEP 1 (mandatory): assess current state. ' +
        '  - Does `index.html` exist at workdir root? ' +
        '  - Does `plan.json` exist? ' +
        '  - For every page listed in `plan.json`, does `sections/<id>.html` exist? ' +
        '  - Read the final 50 lines of `index.html` to confirm it is the multi-file ' +
        '    skeleton (uses `[data-section-loader]` placeholders) and NOT a monolithic ' +
        '    inlined file. ' +
        'IF every check passes — the chapter is COMPLETE. Run `echo done > .phase` ' +
        'and immediately exit (no further tool calls, no writes). Do NOT rebuild anything. ' +
        'IF anything is missing or wrong — continue from where the prior run left off. ' +
        'Use the same multi-file architecture: skeleton index.html + sections/<id>.html ' +
        'fragments dispatched via Task subagents. Do NOT consolidate into a monolithic file.',
      options: {
        cwd: workdir,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        settingSources: [],
        skills: [],
        model: params.writerModel || 'claude-sonnet-4-6',
        // Same anti-overthinking guardrails as the fresh-run config —
        // resumes were observed spending minutes in pure thinking,
        // drafting content in the model's head instead of dispatching.
        // Mirrors the fresh-run budget (8K, medium) — enough room to
        // plan, not enough room to draft a whole site inline.
        effort: 'medium',
        thinking: { type: 'enabled', budgetTokens: 8000 },
        continue: true,
      },
    });
    for await (const msg of iter) {
      const t = msg?.type;
      if (t === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) send({ type: 'text', content: ev.delta.text });
          else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) send({ type: 'thinking', content: ev.delta.thinking });
        }
        continue;
      }
      if (t === 'assistant') {
        for (const b of msg.message?.content || []) {
          if (b.type === 'tool_use') send({ type: 'tool_use', id: b.id, name: b.name, args: b.input || {} });
          else if (b.type === 'thinking') send({ type: 'thinking_complete', content: b.thinking || '' });
        }
        const u = msg.message?.usage;
        if (u) send({
          type: 'usage',
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheCreation: u.cache_creation_input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
        });
      } else if (t === 'user') {
        for (const b of msg.message?.content || []) {
          if (b.type === 'tool_result') {
            const content = Array.isArray(b.content)
              ? b.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n')
              : String(b.content ?? '');
            send({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, result: content });
          }
        }
      } else if (t === 'result') {
        emitFinalUsage(send, msg);
        if (msg.subtype && msg.subtype.startsWith('error_')) {
          send({ type: 'error', message: (msg.errors && msg.errors.join('\n')) || msg.subtype });
        } else {
          send({ type: 'done', stopReason: msg.stop_reason, totalCostUsd: msg.total_cost_usd, workdir });
        }
      }
    }
  } catch (err) {
    send({ type: 'error', message: err.message || String(err) });
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    try { traceStream.end(); } catch {}
    if (!clientGone) { try { res.end(); } catch {} }
  }
}

// GET /api/chapter_runs/replay?dir=<dirName>
// SSE-streams the entire trace.jsonl of a chapter run, then continues to
// tail-poll the file every 500 ms for newly-appended lines. Closes when a
// terminal event (done / error) is observed. Lets the UI reattach to a
// run whose original connection was lost.
async function handleReplayRun(req, res, url) {
  const dirName = url.searchParams.get('dir') || '';
  if (!/^chapter-[a-zA-Z0-9._-]+$/.test(dirName)) {
    res.writeHead(400); return res.end('invalid dir');
  }
  const tracePath = join(ROOT, 'cc-workdir', dirName, 'trace.jsonl');
  let st;
  try { st = await stat(tracePath); }
  catch { res.writeHead(404); return res.end('no trace'); }
  if (!st.isFile()) { res.writeHead(404); return res.end('no trace'); }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  let clientClosed = false;
  res.on('close', () => { clientClosed = true; });

  const { open } = await import('node:fs/promises');
  let offset = 0;
  const writeLine = (line) => {
    if (clientClosed) return;
    try { res.write(`data: ${line}\n\n`); }
    catch { clientClosed = true; }
  };

  // ---- 1) HISTORICAL REPLAY (compressed) ----
  // The full trace can be 1+ MB with hundreds of thinking deltas. Replaying
  // every event blocks the client for seconds. Strategy: drop verbose
  // `text` and `thinking` deltas from the historical pass; keep the state-
  // affecting events (stage, tool_use, tool_result, usage, system, error,
  // done, thinking_complete). Live tail (step 2) emits everything.
  const SKIP_IN_REPLAY = new Set(['text', 'thinking']);
  let fh;
  try {
    fh = await open(tracePath, 'r');
    const s0 = await fh.stat();
    const buf0 = Buffer.alloc(s0.size);
    await fh.read(buf0, 0, buf0.length, 0);
    offset = s0.size;
    await fh.close();
    let dropped = 0, kept = 0, terminal = false;
    for (const line of buf0.toString('utf8').split('\n')) {
      if (!line) continue;
      let t;
      try { t = JSON.parse(line)?.type; } catch {}
      if (SKIP_IN_REPLAY.has(t)) { dropped++; continue; }
      writeLine(line);
      kept++;
      if (t === 'done' || t === 'error') terminal = true;
    }
    // Tell the client how much we dropped so it can show a hint.
    writeLine(JSON.stringify({ type: 'stage', message: `Replay: ${kept} state events restored (${dropped} text/thinking deltas skipped — live tail will show new ones).` }));
    if (terminal) { try { res.end(); } catch {} return; }
  } catch (e) {
    try { await fh?.close(); } catch {}
    writeLine(JSON.stringify({ type: 'error', message: 'replay error: ' + e.message }));
    try { res.end(); } catch {}
    return;
  }

  // ---- 2) LIVE TAIL ----
  // From here on, send EVERY new line including text/thinking — those are
  // the events the user actually wants to see in real time.
  const readAppended = async () => {
    let fh;
    try {
      fh = await open(tracePath, 'r');
      const s = await fh.stat();
      if (s.size <= offset) { await fh.close(); return false; }
      const buf = Buffer.alloc(s.size - offset);
      await fh.read(buf, 0, buf.length, offset);
      offset = s.size;
      await fh.close();
      const text = buf.toString('utf8');
      let terminal = false;
      for (const line of text.split('\n')) {
        if (!line) continue;
        writeLine(line);
        let t;
        try { t = JSON.parse(line)?.type; } catch {}
        if (t === 'done' || t === 'error') terminal = true;
      }
      return terminal;
    } catch {
      try { await fh?.close(); } catch {}
      return false;
    }
  };

  const intervalId = setInterval(async () => {
    if (clientClosed) { clearInterval(intervalId); return; }
    const done2 = await readAppended();
    if (done2) {
      clearInterval(intervalId);
      try { res.end(); } catch {}
      clientClosed = true;
    }
  }, 500);
}

// GET /api/chapter_summaries?paperId=X
// Lists past chapter-summary runs for a paper that produced an index.html.
// Returns: [{ chapterId, indexUrl, traceUrl, mtime }]
async function handleListChapterSummaries(req, res, url) {
  const paperId = url.searchParams.get('paperId');
  if (!paperId) { res.writeHead(400); return res.end('paperId required'); }
  const safe = String(paperId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  const prefix = `chapter-${safe}-`;
  const ccDir = join(ROOT, 'cc-workdir');
  let entries;
  try { entries = await readdir(ccDir); }
  catch (e) { if (e.code === 'ENOENT') return sendJson(res, 200, []); throw e; }
  const out = [];
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const dir = join(ccDir, name);
    const indexPath = join(dir, 'index.html');
    let st;
    try { st = await stat(indexPath); }
    catch { continue; }
    if (!st.isFile()) continue;
    const tracePath = join(dir, 'trace.jsonl');
    const hasTrace = await stat(tracePath).then(s => s.isFile()).catch(() => false);
    // chapter-<paperId>-<chapterId> — strip the prefix to get chapterId.
    const chapterId = name.slice(prefix.length);
    out.push({
      chapterId,
      dirName: name,
      indexUrl: `/cc-workdir/${encodeURIComponent(name)}/index.html`,
      traceUrl: hasTrace ? `/cc-workdir/${encodeURIComponent(name)}/trace.jsonl` : null,
      mtime: st.mtimeMs,
      sizeBytes: st.size,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  sendJson(res, 200, out);
}

// System prompt for the chapter-summary agent. Skeleton stage: one pass
// only — read page rasters + write an interactive index.html using the
// pc.css vocabulary and the autogo aesthetic. The full 4-pass plan is
// layered in once the loop is verified end-to-end.
function buildChapterAgentPrompt({ paperName, chapterTitle, startPage, endPage, pageFiles, figFiles, composites, plannerModel, writerModel }) {
  const compositeList = (composites || []).map(c =>
    c.count === 1
      ? `  composites/${c.name}  (page ${c.firstPn})`
      : `  composites/${c.name}  (pages ${c.firstPn}–${c.lastPn})`
  ).join('\n');
  const nFigs = (figFiles || []).length;
  return `You build interactive HTML chapter sites for paperchat — autogo aesthetic, multi-file, parallel.

# This chapter

Paper:   "${paperName}"
Chapter: "${chapterTitle}" (PDF pages ${startPage}-${endPage})

# Workdir (cwd is already set — use relative paths only)

  composites/pages-N-M.jpg   ⭐ read FIRST. Up to 4 PDF pages tiled vertically.
  pages/page-NNN.png         full-res pages at 200 DPI. Zoom into one when needed.
  figures/img-P-I.<ext>      ${nFigs} embedded raster(s) from pdfimages. Use, recreate, or discard.
  _lib/pc.css                stylesheet — link, don't inline.
  _lib/pc.js                 runtime (animations, math, nav). Loaded as a module.
  _lib/pc-math.js            KaTeX wrapper, loaded by pc.js.
  _lib/template.html         <head> boilerplate (KaTeX CDN).
  _lib/ref/design.md         ⭐ READ — palette, fonts, classes, idioms.
  _lib/ref/components.html   ⭐ READ — usage examples for the pc-* web component library (10 components: chain, stepped, timeline, grid, toggle, slider, plot, annotated, equation, tree). One JSON-attr tag per figure, no inline SVG/script.
${compositeList}

# Your role: FAN OUT, do not author

You are a planner/dispatcher. The work is parallelizable across sections —
spawn one \`section-writer\` Task per concept page, all in ONE turn, and
they run concurrently. A 5-section chapter ships in ~max(per-section
time), not sum.

Do NOT draft HTML/SVG/prose in your thinking. Do NOT consolidate
everything into one big index.html. Do NOT spend minutes "planning"
without emitting tool_use blocks — if you've been thinking >30s
without acting, you're over-planning; commit and dispatch.

# Phase signal — narrate

Whenever your focus genuinely shifts, run:

    echo "<1-4 word label>" > .phase

Examples (just examples, no fixed taxonomy): \`reading composites\`,
\`vetting figures\`, \`planning sections\`, \`dispatching writers\`,
\`fixing Bragg's-law SVG\`, \`polishing math\`, \`done\`. Don't repeat the
same label. Don't echo paths or full sentences — it's a phase
indicator, not a status log.

# Process

## 1) Read + vet figures

Read \`design.md\`, \`components.html\`, and every composite. Then **vet
the extracted figures BEFORE assigning any.** \`pdfimages\` extracts are
unreliable — many are slivers of whitespace, upside-down logos,
ligature fragments, or the wrong figure entirely. For each \`figures/img-*\`
you intend to assign with \`role: embed\`:

- \`Read\` the image (Read accepts PNG/JPG; you'll actually see it).
- Confirm: recognizable, oriented correctly, not mostly blank, matches
  the caption you'd give it.
- If it fails, choose: (a) a different verified figure, (b) crop the
  region from the page raster via \`./crop PAGE x y W H out.png\` and
  Read the crop, or (c) tell the subagent to recreate it as SVG.
- Subagents trust your assignments and will not re-verify. Never
  assign garbage with \`role: embed\`.

## 2) Write plan.json

Schema:

\`\`\`json
{
  "pages": [
    {
      "id": "structure",
      "title": "Atomic Structure",
      "eyebrow": "Section 2.2",
      "source_pages": [40, 41, 42],
      "figures": [
        {"role": "embed",    "path": "figures/img-040-002.jpg", "caption": "..."},
        {"role": "recreate", "kind": "chain",  "label": "..."}
      ],
      "concepts": ["Bohr model", "wave-mechanical model", "quantum numbers"],
      "worked_example": "Hydrogen atom: predict the n=2 → n=1 transition wavelength using E_n = -13.6/n² eV → ΔE = 10.2 eV → λ = hc/ΔE ≈ 121.6 nm (Lyman α, observed)."
    }
  ]
}
\`\`\`

\`worked_example\` is optional but RECOMMENDED for quantitative or
named-case concepts. Omit it for sections that are overviews,
definitions, or historical asides where a forced example would feel
out of place. Lift from the textbook when it has one; don't invent
contrived ones. The subagent decides target length itself per
section — no target_words field.

## 3) Write index.html (skeleton, NOT monolithic)

- \`<head>\`: KaTeX CDN links (from \`_lib/template.html\`).
- \`<link rel="stylesheet" href="_lib/pc.css">\` — link, don't inline.
- \`<nav class="pc-nav">\`: chapter title + one link per plan page.
- One \`<section class="pc-page" id="<id>">\` per page: eyebrow + \`<h2>\`
  + \`<div data-section-loader="<id>">Loading…</div>\`.
- \`<script type="module" src="_lib/pc.js"></script>\` — link, don't inline.
- Inline loader \`<script>\` that fetches each \`sections/<id>.html\` and
  replaces its placeholder. Copy this verbatim:

\`\`\`html
<script>
(async () => {
  function execScripts(root) {
    for (const old of root.querySelectorAll('script')) {
      const s = document.createElement('script');
      for (const a of old.attributes) s.setAttribute(a.name, a.value);
      s.text = old.textContent;
      old.replaceWith(s);
    }
  }
  for (const el of document.querySelectorAll('[data-section-loader]')) {
    const id = el.dataset.sectionLoader;
    try {
      const r = await fetch('sections/' + id + '.html');
      if (!r.ok) continue;
      const tpl = document.createElement('template');
      tpl.innerHTML = await r.text();
      execScripts(tpl.content);
      el.replaceWith(tpl.content);
    } catch {}
  }
  if (window.pcSite) { pcSite.primeReveals(document); pcSite.observeReveals(document); }
  if (window.pcMath) pcMath.renderMathIn(document.body);
})();
</script>
\`\`\`

The loader pattern is critical: \`<script>\` tags inserted via innerHTML
DO NOT execute (HTML5 marks them "already started"). The template +
\`execScripts\` re-recreates each script so its body runs.

## 4) Dispatch section-writers — ONE turn, N Tasks

The \`section-writer\` subagent is pre-registered. It has the global
rules (vocabulary, animations, JS pitfalls, brevity) in its system
prompt — do NOT re-explain them. Your Task prompt is just the
section-specific brief.

In ONE assistant turn, emit one \`Task\` tool_use per page in plan.json.
They run in parallel. WAIT for all tool_results before step 5.

Per-Task prompt template (~2–3 KB — rich, specific, with at least one
WORKED EXAMPLE per section. The audience is meeting this material for
the FIRST TIME; ~250 words is too short to actually teach anything):

> "Write \`sections/<id>.html\`.
>
> Concept: <3–5 specific bullets — definitions, formulas, claims —
> NOT a topic label>.
>
> Worked example (RECOMMENDED if it fits — skip for overviews,
> definitions, historical asides): <a concrete, numerical or named-case
> example walked through end-to-end. For quantitative concepts give
> real numbers and the result. For qualitative concepts give a named
> instance with its actual properties. E.g. \"FCC copper, R = 0.128 nm,
> A = 63.5 g/mol → ρ ≈ 8.94 g/cm³\" or \"NaCl: cubic, brittle, melts at
> 801 °C, dissolves in water\". Use the textbook's example if it has
> one; don't invent contrived ones. Omit this line entirely if no
> example would teach.>
>
> Source: PDF pages <list>.
>
> Figures available (use as-is, paths relative to index.html):
>   - figures/<name>.jpg — <caption + role: 'embed' | 'recreate as <component>'>
>
> Interactivity FIRST. For any concept with parameters, choices,
> sequence, structure, or comparison — DEFAULT to building an
> interactive figure instead of explaining it in prose. The reader
> learns by manipulating, not by reading. Pick:
>   (a) one or MORE pc-* components (chain / stepped / timeline /
>       grid / toggle / slider / plot / annotated / equation / tree /
>       term) and provide the JSON content. Sections often want
>       multiple — e.g. a pc-grid AND a pc-slider, not just one.
>   (b) a CUSTOM interactive figure: describe what the user can
>       manipulate (slider, click, drag, hover), what changes in
>       response, what concept it teaches. The subagent wraps it as
>       a one-off web component.
> Pick (a) when a component fits; pick (b) when the concept has
> structure the user should manipulate to grok (electron shells,
> wave interference, phase cursor, draggable lever, Fourier builder,
> Punnett square, …). Pick BOTH when both serve the section. Only
> fall back to prose paragraphs for genuinely linear narrative
> (historical intro, plain definition).
>
> Length: as short as possible while still teaching the concept. No
> word target — the subagent decides per section. Always shorter than
> the source; if the source is a stub, the summary is a stub. The
> section must walk the reader from 'never heard of this' to 'I could
> now explain this to a friend' — define every term on first use,
> build any formula step by step, then ground it with the worked
> example above. End with a callout: '<the exact pull-quote, written
> by you>'."

Strict: no \`"Working directory:"\` line, no absolute paths (\`/Users/...\`)
in the Task prompt — the subagent's cwd is set and absolute paths
make it hallucinate. No re-explaining vocabulary or JS pitfalls — the
brief already covers those.

# Final structure

    index.html             skeleton (linked _lib/, fetched sections/)
    sections/<id>.html     one fragment per concept page
    plan.json              the work breakdown
    figures/               extracted images + any crops
    _lib/                  pre-staged primitives

\`sections/<id>.html\` is a pure fragment: NO \`<html>\`, NO \`<head>\`, NO
outer \`<section>\` wrapper. Top-level is \`<div class="pc-prose pc-stagger">\`.

# Hard rules

- **Animations are mandatory.** Every \`.pc-page\` \`pc-stagger\`s its
  children; every heading \`pc-rise\`s; every paragraph/figure
  \`pc-fade-in\` or \`pc-rise\`. Every interactive figure has at least
  one user-driven animation. A diagram that's just 4 static boxes with
  → between them isn't interactive — make it an \`<svg>\` with clickable
  nodes that animate state.
- Teach, don't summarize-into-bullets. Always shorter than the book;
  beyond that, the subagent decides length by what the concept needs.
  Define every term on first use, build any formula step by step,
  and include a worked example or named case where it would teach
  (skip where it would feel forced). Wrap optional depth in
  \`<details class="pc-skip">\`.
- NEVER embed a full \`pages/page-*.png\` as a chapter figure — those are
  your reference, not artifacts.
- NEVER redeclare a \`.pc-*\` selector in your own \`<style>\` — pc.css owns them.
- NEVER use \`.card\` or invent ad-hoc colors. Stick to design.md.
- NEVER use HTML entities (\`&#9658;\`) inside CSS \`content\`. Use literal
  Unicode (\`"▸ "\`) or hex escapes (\`"\\25BA "\`).
- Skip \`TodoWrite\` — plan.json IS the work breakdown.

When recreating figures: teach the concept, not pixel-perfect. Interactivity
where it helps (slider over a parameter, before/after toggle, animated reveal).`;
}

// SSE handler that streams Claude Agent SDK events to the browser.
async function handleClaudeCode(req, res) {
  // Prefer the local Claude Code session's key (read from macOS Keychain) so
  // @code uses the same billing account as the user's `claude` CLI. Fall back
  // to .env / process.env on non-Mac or when the keychain item is missing.
  let apiKey = await readMacKeychain('Claude Code');
  if (!apiKey) {
    const env = await readEnvFiles();
    apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  }
  if (!apiKey) {
    res.writeHead(400);
    return res.end('No Anthropic credentials found. Sign in to the local `claude` CLI, or set ANTHROPIC_API_KEY in .env.');
  }

  // Read the JSON body
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    res.writeHead(400);
    return res.end('invalid JSON: ' + e.message);
  }

  const { systemPrompt = '', userPrompt = '', workdirName = 'default' } = payload;
  if (!userPrompt) {
    res.writeHead(400);
    return res.end('userPrompt required');
  }

  // Per-paper sandbox dir so the agent has somewhere safe to write/read files.
  const safeDir = String(workdirName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'default';
  const workdir = join(fileURLToPath(new URL('.', import.meta.url)), 'cc-workdir', safeDir);
  await mkdir(workdir, { recursive: true });

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let query;
  try {
    ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
  } catch (e) {
    send({ type: 'error', message: 'SDK not installed: ' + e.message });
    return res.end();
  }

  // The SDK reads ANTHROPIC_API_KEY from env. Inject it for this call.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = apiKey;

  try {
    const iter = query({
      prompt: userPrompt,
      options: {
        systemPrompt: systemPrompt || undefined,
        cwd: workdir,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        // SDK-isolation mode: ignore the user's ~/.claude/ settings, plugins,
        // and skills so the @code agent doesn't pick up unrelated context like
        // 'install the Vercel CLI'. Just paperchat's prompt + paper context.
        settingSources: [],
        skills: [],
      },
    });
    for await (const msg of iter) {
      // Normalize SDK events into our SSE protocol.
      const t = msg?.type;
      // Token-level streaming. Forward text_delta events as they arrive;
      // ignore tool input_json_delta (we get the assembled tool_use later).
      if (t === 'stream_event') {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          send({ type: 'text', content: ev.delta.text });
        }
        continue;
      }
      if (t === 'assistant') {
        // Full assistant turn — text was already streamed via stream_event,
        // so only forward tool_use blocks here (assembled with parsed input).
        const blocks = msg.message?.content || [];
        for (const b of blocks) {
          if (b.type === 'tool_use') {
            send({ type: 'tool_use', id: b.id, name: b.name, args: b.input || {} });
          }
        }
      } else if (t === 'user') {
        // Tool results come back as user messages.
        const blocks = msg.message?.content || [];
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            const content = Array.isArray(b.content)
              ? b.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n')
              : String(b.content ?? '');
            send({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, result: content });
          }
        }
      } else if (t === 'result') {
        // Surface SDK-level errors (e.g. credit balance too low) as a clean
        // 'error' event with a help link when relevant.
        if (msg.subtype && msg.subtype.startsWith('error_')) {
          const errs = (msg.errors && msg.errors.length) ? msg.errors.join('\n') : msg.subtype;
          let pretty = errs;
          if (/credit balance is too low|out_of_credits|insufficient.*credit/i.test(errs)) {
            pretty = `Anthropic credit balance is too low for @code. Top up at https://console.anthropic.com/settings/billing\n\n(The @claude / @grok / @gpt mentions go through OpenRouter and use a separate credit pool.)`;
          }
          send({ type: 'error', message: pretty });
        } else {
          send({ type: 'done', stopReason: msg.stop_reason, totalCostUsd: msg.total_cost_usd });
        }
      } else if (t === 'system') {
        // Init / model info — don't surface for now.
      }
    }
  } catch (err) {
    send({ type: 'error', message: err.message || String(err) });
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    res.end();
  }
}

// ---- Local filesystem storage for papers/threads/messages -------------
// IDs must be filesystem-safe so they can be used as filenames directly.
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const safeId = (id) => typeof id === 'string' && ID_RE.test(id) ? id : null;

async function exists(fp) {
  try { await access(fp); return true; } catch { return false; }
}

async function readJsonFile(fp) {
  const raw = await readFile(fp, 'utf8');
  return JSON.parse(raw);
}

async function listJsonDir(dir) {
  let names;
  try { names = await readdir(dir); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(await readJsonFile(join(dir, n))); }
    catch { /* skip bad/concurrently-deleted file */ }
  }
  return out;
}

async function readJsonBody(req, max = 50 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readBinaryBody(req, max = 200 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(buf);
}

async function deletePaperCascade(id) {
  await unlink(join(PAPERS_DIR, `${id}.json`)).catch(() => {});
  await unlink(join(PAPERS_DIR, `${id}.pdf`)).catch(() => {});
  // Cascade: threads for paper, and messages for each thread
  const threads = await listJsonDir(THREADS_DIR);
  const toDelete = threads.filter(t => t.paperId === id);
  for (const t of toDelete) await deleteThreadCascade(t.id);
}

async function deleteThreadCascade(id) {
  await unlink(join(THREADS_DIR, `${id}.json`)).catch(() => {});
  const msgs = await listJsonDir(MESSAGES_DIR);
  for (const m of msgs.filter(x => x.threadId === id)) {
    await unlink(join(MESSAGES_DIR, `${m.id}.json`)).catch(() => {});
  }
}

async function handleStorage(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  // /api/papers and /api/papers/:id (+ /blob)
  let mPaper = p.match(/^\/api\/papers(?:\/([^/]+)(\/blob)?)?$/);
  if (mPaper) {
    const id = mPaper[1] ? safeId(mPaper[1]) : null;
    const isBlob = !!mPaper[2];
    if (mPaper[1] && !id) { res.writeHead(400); return res.end('invalid id'); }
    // /api/papers
    if (!id) {
      if (m === 'GET') {
        const all = await listJsonDir(PAPERS_DIR);
        return sendJson(res, 200, all);
      }
      res.writeHead(405); return res.end('method not allowed');
    }
    // /api/papers/:id/blob
    if (isBlob) {
      const fp = join(PAPERS_DIR, `${id}.pdf`);
      if (m === 'HEAD') {
        if (await exists(fp)) { res.writeHead(200); return res.end(); }
        res.writeHead(404); return res.end();
      }
      if (m === 'GET') {
        if (!(await exists(fp))) { res.writeHead(404); return res.end('not found'); }
        const buf = await readFile(fp);
        res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store' });
        return res.end(buf);
      }
      if (m === 'PUT') {
        const buf = await readBinaryBody(req);
        await writeFile(fp, buf);
        res.writeHead(204); return res.end();
      }
      res.writeHead(405); return res.end('method not allowed');
    }
    // /api/papers/:id
    const fp = join(PAPERS_DIR, `${id}.json`);
    if (m === 'GET') {
      if (!(await exists(fp))) { res.writeHead(404); return res.end('not found'); }
      return sendJson(res, 200, await readJsonFile(fp));
    }
    if (m === 'PUT') {
      const body = await readJsonBody(req);
      if (body.id !== id) { res.writeHead(400); return res.end('id mismatch'); }
      delete body.blob; // never store blob in JSON
      await writeFile(fp, JSON.stringify(body));
      res.writeHead(204); return res.end();
    }
    if (m === 'DELETE') {
      await deletePaperCascade(id);
      res.writeHead(204); return res.end();
    }
    res.writeHead(405); return res.end('method not allowed');
  }

  // /api/threads and /api/threads/:id
  let mThread = p.match(/^\/api\/threads(?:\/([^/]+))?$/);
  if (mThread) {
    const id = mThread[1] ? safeId(mThread[1]) : null;
    if (mThread[1] && !id) { res.writeHead(400); return res.end('invalid id'); }
    if (!id) {
      if (m === 'GET') {
        const paperId = url.searchParams.get('paperId');
        let all = await listJsonDir(THREADS_DIR);
        if (paperId) all = all.filter(t => t.paperId === paperId);
        return sendJson(res, 200, all);
      }
      res.writeHead(405); return res.end('method not allowed');
    }
    const fp = join(THREADS_DIR, `${id}.json`);
    if (m === 'GET') {
      if (!(await exists(fp))) { res.writeHead(404); return res.end('not found'); }
      return sendJson(res, 200, await readJsonFile(fp));
    }
    if (m === 'PUT') {
      const body = await readJsonBody(req);
      if (body.id !== id) { res.writeHead(400); return res.end('id mismatch'); }
      await writeFile(fp, JSON.stringify(body));
      res.writeHead(204); return res.end();
    }
    if (m === 'DELETE') {
      await deleteThreadCascade(id);
      res.writeHead(204); return res.end();
    }
    res.writeHead(405); return res.end('method not allowed');
  }

  // /api/messages and /api/messages/:id
  let mMsg = p.match(/^\/api\/messages(?:\/([^/]+))?$/);
  if (mMsg) {
    const id = mMsg[1] ? safeId(mMsg[1]) : null;
    if (mMsg[1] && !id) { res.writeHead(400); return res.end('invalid id'); }
    if (!id) {
      if (m === 'GET') {
        const threadId = url.searchParams.get('threadId');
        let all = await listJsonDir(MESSAGES_DIR);
        if (threadId) all = all.filter(x => x.threadId === threadId);
        return sendJson(res, 200, all);
      }
      res.writeHead(405); return res.end('method not allowed');
    }
    const fp = join(MESSAGES_DIR, `${id}.json`);
    if (m === 'GET') {
      if (!(await exists(fp))) { res.writeHead(404); return res.end('not found'); }
      return sendJson(res, 200, await readJsonFile(fp));
    }
    if (m === 'PUT') {
      const body = await readJsonBody(req);
      if (body.id !== id) { res.writeHead(400); return res.end('id mismatch'); }
      await writeFile(fp, JSON.stringify(body));
      res.writeHead(204); return res.end();
    }
    if (m === 'DELETE') {
      await unlink(fp).catch(() => {});
      res.writeHead(204); return res.end();
    }
    res.writeHead(405); return res.end('method not allowed');
  }

  return false; // no match
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/papers') || url.pathname.startsWith('/api/threads') || url.pathname.startsWith('/api/messages')) {
      const handled = await handleStorage(req, res, url);
      if (handled !== false) return;
    }
    if (url.pathname === '/api/claude_code' && req.method === 'POST') {
      return handleClaudeCode(req, res);
    }
    if (url.pathname === '/api/chapter_summary' && req.method === 'POST') {
      return handleChapterSummary(req, res);
    }
    if (url.pathname === '/api/chapter_summaries' && req.method === 'GET') {
      return handleListChapterSummaries(req, res, url);
    }
    if (url.pathname === '/api/chapter_runs/active' && req.method === 'GET') {
      return handleListActiveRuns(req, res, url);
    }
    if (url.pathname === '/api/chapter_runs/replay' && req.method === 'GET') {
      return handleReplayRun(req, res, url);
    }
    if (url.pathname === '/api/chapter_runs/index_mtime' && req.method === 'GET') {
      const dirName = url.searchParams.get('dir') || '';
      if (!/^chapter-[a-zA-Z0-9._-]+$/.test(dirName)) { res.writeHead(400); return res.end('invalid dir'); }
      const idxPath = join(ROOT, 'cc-workdir', dirName, 'index.html');
      try {
        const s = await stat(idxPath);
        return sendJson(res, 200, { mtime: s.mtimeMs, size: s.size });
      } catch {
        return sendJson(res, 200, { mtime: 0, size: 0 });
      }
    }
    if (url.pathname === '/api/chapter_runs/files' && req.method === 'GET') {
      // List every file in a chapter workdir (recursive) with size + mtime.
      // Used by the artifact browser in the panel.
      const dirName = url.searchParams.get('dir') || '';
      if (!/^chapter-[a-zA-Z0-9._-]+$/.test(dirName)) { res.writeHead(400); return res.end('invalid dir'); }
      const root = join(ROOT, 'cc-workdir', dirName);
      const out = [];
      async function walk(abs, rel) {
        let entries;
        try { entries = await readdir(abs, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          const sub = rel ? `${rel}/${e.name}` : e.name;
          // Skip only the giant cached PDF; pages/ is useful to browse
          // while the agent is mid-run and hasn't written index.html yet.
          if (sub === 'chapter.pdf') continue;
          const a = join(abs, e.name);
          if (e.isDirectory()) {
            await walk(a, sub);
          } else if (e.isFile()) {
            try {
              const s = await stat(a);
              out.push({ path: sub, size: s.size, mtime: s.mtimeMs });
            } catch {}
          }
        }
      }
      try { await walk(root, ''); }
      catch (e) { return sendJson(res, 200, []); }
      out.sort((a, b) => a.path.localeCompare(b.path));
      sendJson(res, 200, out);
    }
    if (url.pathname === '/api/chapter_runs/resume' && req.method === 'POST') {
      return handleResumeRun(req, res, url);
    }
    if (url.pathname === '/api/fetch_pdf') {
      const target = url.searchParams.get('url');
      if (!target) { res.writeHead(400); return res.end('missing url'); }
      let parsed;
      try { parsed = new URL(target); }
      catch { res.writeHead(400); return res.end('invalid url'); }
      if (!/^https?:$/.test(parsed.protocol)) { res.writeHead(400); return res.end('http(s) only'); }
      const host = parsed.hostname.toLowerCase();
      if (
        host === 'localhost' || /^127\./.test(host) || /^10\./.test(host) ||
        /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '0.0.0.0'
      ) {
        res.writeHead(403); return res.end('private/loopback hosts blocked');
      }
      try {
        const r = await fetch(target, { redirect: 'follow', headers: { 'user-agent': 'paperchat/0.1' } });
        if (!r.ok) { res.writeHead(r.status); return res.end(`upstream ${r.status}`); }
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('pdf') && !parsed.pathname.toLowerCase().endsWith('.pdf')) {
          res.writeHead(415); return res.end(`expected PDF, got content-type: ${ct}`);
        }
        res.writeHead(200, { 'content-type': 'application/pdf' });
        for await (const chunk of r.body) res.write(chunk);
        res.end();
      } catch (err) {
        res.writeHead(502);
        res.end('fetch_pdf error: ' + err.message);
      }
      return;
    }
    if (url.pathname === '/api/fetch') {
      const target = url.searchParams.get('url');
      if (!target) { res.writeHead(400); return res.end('missing url'); }
      try {
        const out = await proxyFetch(target);
        const header = `# fetched\nurl: ${out.finalUrl}\nstatus: ${out.status}\ncontent-type: ${out.contentType}${out.viaJina ? '\nrendered-via: r.jina.ai (JS-rendered fallback)' : ''}\n\n`;
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(header + out.text);
      } catch (err) {
        res.writeHead(err.status || 502);
        return res.end('fetch_url error: ' + err.message);
      }
    }
    if (url.pathname === '/env.js') {
      const env = await readEnvFiles();
      const exposed = {};
      for (const k of EXPOSED_KEYS) exposed[k] = env[k] || '';
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(`window.__ENV__ = ${JSON.stringify(exposed)};`);
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const fp = join(ROOT, safe);
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    const s = await stat(fp).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const buf = await readFile(fp);
    res.writeHead(200, {
      'content-type': MIME[extname(fp).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch (err) {
    // If the response was already started (e.g. an SSE handler crashed
    // mid-stream) we can't write a 500 header — that's the underlying
    // ERR_HTTP_HEADERS_SENT crash. Just end the response so the server
    // process survives.
    console.error('top-level handler error:', err?.stack || err);
    try {
      if (res.headersSent) { res.end(); }
      else { res.writeHead(500); res.end('Server error: ' + err.message); }
    } catch {}
  }
}).listen(PORT, () => {
  console.log(`paperchat → http://localhost:${PORT}`);
});
