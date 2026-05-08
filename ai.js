// OpenRouter chat with @mention routing + tool-calling loop.
// Mirrors the manga-gen pattern.

const KEY_STORAGE = 'fermat.openrouter.key';
const MODELS_STORAGE = 'fermat.models';

const DEFAULT_MODELS = {
  '@claude': 'anthropic/claude-opus-4.7',
  '@grok': 'x-ai/grok-4.3',
  '@gpt': 'openai/gpt-5.5',
  '@code': 'claude-code',  // local agent SDK, model is internal
};

export const MENTIONS = ['@claude', '@grok', '@gpt', '@code'];

export function envKey() {
  return (typeof window !== 'undefined' && window.__ENV__ && window.__ENV__.OPENROUTER_API_KEY) || '';
}

export function getKey() {
  return envKey() || localStorage.getItem(KEY_STORAGE) || '';
}
export function setKey(k) {
  if (k) localStorage.setItem(KEY_STORAGE, k);
  else localStorage.removeItem(KEY_STORAGE);
}

export function getModels() {
  const stored = JSON.parse(localStorage.getItem(MODELS_STORAGE) || '{}');
  return { ...DEFAULT_MODELS, ...stored };
}
export function setModels(map) {
  localStorage.setItem(MODELS_STORAGE, JSON.stringify(map));
}

export function modelFor(mention) {
  const models = getModels();
  return models[mention] || DEFAULT_MODELS[mention] || DEFAULT_MODELS['@claude'];
}

// Parse leading @mention from a user message. Returns { mention, body } or null.
export function parseMention(text) {
  const m = text.match(/^\s*(@\w+)\s*/);
  if (!m) return null;
  const mention = m[1].toLowerCase();
  if (!MENTIONS.includes(mention)) return null;
  return { mention, body: text.slice(m[0].length) };
}

// Tools we expose to the model.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_page_text',
      description: 'Fetch the full plain text of a specific page of THE CURRENTLY OPEN PAPER (the one in the user\'s viewer). Does NOT work for cited or external papers — use arxiv_lookup / semantic_scholar / fetch_url for those.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'integer', description: '1-indexed page number' },
        },
        required: ['page'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_in_paper',
      description: 'Case-insensitive substring search across every page of THE CURRENTLY OPEN PAPER ONLY (the one the user is viewing). Returns page number + ~200-char snippet per hit. Does NOT search cited papers or external sources — for those use semantic_scholar / arxiv_lookup / fetch_url.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for.' },
          max_results: { type: 'integer', description: 'Max matches to return (default 10).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a web page (HTML, text, JSON, or XML) by absolute http(s) URL and return its text content. Use for cited papers (arXiv abstract pages, blog posts), repositories (GitHub README), API responses, etc. JS-rendered SPAs are auto-handled — when the raw HTML strip is empty the proxy transparently falls back to r.jina.ai (browser-rendered markdown). PDFs and private/loopback hosts are not supported. Up to ~80k chars returned.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'arxiv_lookup',
      description: 'Fetch an arXiv paper\'s metadata (title, authors, abstract, categories) by arXiv ID, e.g. "2304.12345" or "math.AG/0302234". Returns Atom XML.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'arXiv identifier' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_to_page',
      description: 'Scroll the user\'s PDF viewer to the given 1-indexed page number. Use to direct the user to specific sections you reference.',
      parameters: {
        type: 'object',
        properties: { page: { type: 'integer' } },
        required: ['page'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'highlight_passage',
      description: 'Add a temporary visual highlight over a passage on a specific page. The quote must appear verbatim in the page text (whitespace-collapsed, case-insensitive). Use to draw the user\'s attention to a specific sentence or term.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'integer', description: '1-indexed page' },
          quote: { type: 'string', description: 'Exact passage to highlight' },
        },
        required: ['page', 'quote'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_python',
      description: 'Execute Python code in a browser-side Pyodide sandbox. Use for verifying equations, plotting (returns base64 PNG), or running short snippets. numpy/scipy/sympy/matplotlib/pandas auto-load from imports. Persistent globals across calls in the same session. Returns stdout + the value of the last expression. Network access is unavailable.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source code to execute.' },
        },
        required: ['code'],
      },
    },
  },
];

function buildPaperContext({ paperTitle, paperPagesText, thread }) {
  const totalPages = paperPagesText.length;
  const fullText = paperPagesText.map((t, i) => `=== Page ${i + 1} ===\n${t}`).join('\n\n');
  const trimmed = fullText.length > 40000
    ? fullText.slice(0, 40000) + `\n\n[truncated — paper has ${totalPages} pages]`
    : fullText;
  const anchor = thread.pageNum
    ? `The user has selected a passage on page ${thread.pageNum} and started this thread:\n"""\n${thread.quote}\n"""\n\n`
    : `This thread is about the whole paper — no specific passage was selected.\n\n`;
  return `PAPER: "${paperTitle}" (${totalPages} pages)

${anchor}PAPER TEXT:
${trimmed}`;
}

function buildSystemPrompt({ paperTitle, paperPagesText, thread }) {
  const ctx = buildPaperContext({ paperTitle, paperPagesText, thread });
  return `You are an expert reader helping a user understand a paper through threaded discussion.

${ctx}

Stay grounded in the paper. Cite page numbers when you reference content. Be concise unless asked for depth. The user may invite other models with @mentions; you are answering as your model.

Tools available — note carefully which target THE OPEN PAPER vs EXTERNAL SOURCES:

OPEN PAPER (the one above; only this paper):
- get_page_text(page) — plain text of any page of the open paper.
- find_in_paper(query, max_results?) — substring search across the open paper only.

EXTERNAL / OTHER PAPERS:
- arxiv_lookup(id) — structured arXiv metadata via the official API.
- fetch_url(url) — read any HTML/text/JSON URL. **For arXiv papers, ALWAYS use the HTML rendering at \`https://arxiv.org/html/<id>\` (or \`/abs/<id>\` for just the abstract). NEVER fetch \`/pdf/\` URLs — PDFs are not extracted server-side and the call will return a useless placeholder.** For other sources: blog posts, GitHub READMEs, API responses, etc.
- Built-in web search (implicit, no explicit tool call) — broad lookups when no specific URL is known.

VIEWER + COMPUTE:
- scroll_to_page(page) — scroll the user's viewer to a page when you reference content there.
- highlight_passage(page, quote) — visually highlight a specific passage; quote must appear verbatim (whitespace-collapsed) in the open paper.
- run_python(code) — Pyodide sandbox: numpy/scipy/sympy/matplotlib/pandas auto-install; persistent globals across calls; no network. Use for verifying equations or running paper code.

Routing rules:
1. If the user asks about content of THE OPEN PAPER, use find_in_paper / get_page_text.
2. If the user asks about a DIFFERENT paper (cited reference, comparison, prior work), DO NOT use find_in_paper — it cannot see other papers. Use arxiv_lookup, fetch_url, or web search instead.
3. If unsure whether the question is about the open paper or another, ask one clarifying question rather than searching the wrong source.

## Math formatting — strict

Render ALL mathematical notation as LaTeX, wrapped in \`$...$\` (inline) or \`$$...$$\` (display). KaTeX renders it for the user.

NEVER output bare Unicode math symbols. The frontend will display them as literal text and the math will look broken. Specifically forbidden as raw characters:
- accents/decorations: \`x̄\`, \`x̂\`, \`ẋ\`, \`x⃗\` → write \`$\\bar x$\`, \`$\\hat x$\`, \`$\\dot x$\`, \`$\\vec x$\`
- subscripts/superscripts: \`hᵢ\`, \`x²\`, \`Rᵈ\` → write \`$h_i$\`, \`$x^2$\`, \`$\\mathbb R^d$\`
- operators: \`∑\`, \`∏\`, \`∫\`, \`∇\`, \`∂\` → write \`$\\sum$\`, \`$\\prod$\`, \`$\\int$\`, \`$\\nabla$\`, \`$\\partial$\`
- relations: \`∈\`, \`⊆\`, \`≤\`, \`≥\`, \`≈\`, \`≠\` → write \`$\\in$\`, \`$\\subseteq$\`, \`$\\le$\`, \`$\\ge$\`, \`$\\approx$\`, \`$\\ne$\`
- sets: \`ℝ\`, \`ℕ\`, \`ℂ\`, \`ℤ\`, \`ℚ\` → write \`$\\mathbb R$\`, \`$\\mathbb N$\`, \`$\\mathbb C$\`, \`$\\mathbb Z$\`, \`$\\mathbb Q$\`
- greek (when used as math): \`φ\`, \`θ\`, \`λ\`, \`σ\`, \`ε\` → write \`$\\phi$\`, \`$\\theta$\`, \`$\\lambda$\`, \`$\\sigma$\`, \`$\\varepsilon$\`

Also: keep math inside a single \`$...$\` pair — never break a formula across multiple \`$...$\` snippets, and never write \`$\` on its own line. Inside \`$$...$$\` blocks, use proper LaTeX subscript/superscript syntax. After ANY operator/letter that takes an argument (\`\\mathbb{}\`, \`\\mathcal{}\`, \`\\mathbf{}\`, \`\\sum\`, \`\\prod\`, \`\\int\`, \`\\max\`, \`\\min\`, \`\\sup\`, \`\\inf\`, \`\\lim\`, \`\\bigcup\`, \`\\bigcap\`), a subscript ALWAYS needs an explicit \`_\`:

  - WRONG: \`\\mathbb{E}{t, x}\`        RIGHT: \`\\mathbb{E}_{t, x}\`
  - WRONG: \`\\mathcal{L}z(\\theta)\`     RIGHT: \`\\mathcal{L}_z(\\theta)\`
  - WRONG: \`\\sum{i=1}^N\`             RIGHT: \`\\sum_{i=1}^N\`
  - WRONG: \`\\max{x \\in S}\`           RIGHT: \`\\max_{x \\in S}\`

Use \`\\,\` (thin space) between an operator and its body, NEVER a comma: \`\\mathbb{E}_{t}\\,\\lVert x \\rVert^2\` not \`\\mathbb{E}_{t}, \\lVert x \\rVert^2\`.

## Code formatting

When you write code in your reply, ALWAYS use fenced markdown blocks with an explicit language tag (e.g. \`\`\`python, \`\`\`bash, \`\`\`typescript, \`\`\`json) so it renders with syntax highlighting. For inline code, use single backticks.

Chain tools freely — the loop budget is generous. Prefer arxiv_lookup over scraping arxiv.org with fetch_url; when you do need full-text from an arXiv paper, use \`https://arxiv.org/html/<id>\`, not \`/pdf/\`.`;
}

async function callOpenRouter(key, model, messages, { stream = false } = {}) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': location.origin,
      'X-Title': 'paperchat',
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      plugins: [{ id: 'web' }],
      stream,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    let m = `${res.status}`;
    try { m = JSON.parse(txt).error?.message || m; } catch {}
    throw new Error(m);
  }
  return res;
}

// Stream one round of completion. Returns { content, tool_calls } once the SSE
// stream ends. tool_calls is null if the model produced plain text.
async function streamOnce(key, model, messages, onDelta) {
  const res = await callOpenRouter(key, model, messages, { stream: true });
  // body might be missing on JSON-only error responses; we already threw on !ok.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls = {};

  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':')) continue; // SSE comment / keep-alive
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break outer;
      let obj;
      try { obj = JSON.parse(data); } catch { continue; }
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          const dst = toolCalls[idx];
          if (tc.id) dst.id = tc.id;
          if (tc.type) dst.type = tc.type;
          if (tc.function?.name) dst.function.name += tc.function.name;
          if (tc.function?.arguments) dst.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const tcArr = Object.values(toolCalls);
  return { content, tool_calls: tcArr.length ? tcArr : null };
}

// Streaming variant of chat(). Calls onDelta(text) for each text fragment and
// onToolCall({ name, args, ok, error, result }) once a tool call resolves.
// `viewer` and `python` are optional capability adapters provided by app.js.
export async function streamChat({ paperTitle, paperPagesText, thread, history, mention, onDelta, onToolCall, viewer, python }) {
  // @code routes to the local Claude Agent SDK via /api/claude_code (SSE).
  if (mention === '@code') {
    const systemPrompt = buildCodeSystemPrompt({ paperTitle, paperPagesText, thread });
    return await streamClaudeCode({ systemPrompt, history, thread, onDelta, onToolCall });
  }

  const key = getKey();
  if (!key) throw new Error('Set your OpenRouter API key in settings or in .env (OPENROUTER_API_KEY).');

  const systemPrompt = buildSystemPrompt({ paperTitle, paperPagesText, thread });
  const messages = [{ role: 'system', content: systemPrompt }, ...history];
  const model = modelFor(mention);

  let finalContent = '';
  let safety = 0;
  while (safety++ < 100) {
    const round = await streamOnce(key, model, messages, onDelta);
    if (round.content) finalContent = round.content;

    if (round.tool_calls?.length) {
      messages.push({
        role: 'assistant',
        content: round.content || null,
        tool_calls: round.tool_calls,
      });
      for (const tc of round.tool_calls) {
        const name = tc.function?.name;
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        let result;
        let ok = true;
        let errMsg = null;
        try {
          result = await runTool(name, args, { paperPagesText, viewer, python });
        } catch (err) {
          ok = false;
          errMsg = err.message;
          result = `Error: ${err.message}`;
        }
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        onToolCall?.({ name, args, ok, error: errMsg, result: resultStr });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultStr,
        });
      }
      continue;
    }

    return { content: finalContent, model };
  }
  throw new Error('Tool loop exceeded safety limit (100).');
}

async function runTool(name, args, ctx) {
  const { paperPagesText, viewer, python } = ctx;
  if (name === 'get_page_text') {
    const p = Number(args.page);
    if (!Number.isInteger(p) || p < 1 || p > paperPagesText.length) {
      throw new Error(`Invalid page ${args.page} (paper has ${paperPagesText.length} pages)`);
    }
    return paperPagesText[p - 1];
  }
  if (name === 'find_in_paper') {
    const q = String(args.query || '').trim();
    if (!q) throw new Error('query required');
    const max = Math.max(1, Math.min(50, Number(args.max_results) || 10));
    const needle = q.toLowerCase();
    const hits = [];
    for (let i = 0; i < paperPagesText.length; i++) {
      const text = paperPagesText[i];
      const lower = text.toLowerCase();
      let from = 0;
      while (hits.length < max) {
        const idx = lower.indexOf(needle, from);
        if (idx < 0) break;
        const start = Math.max(0, idx - 80);
        const end = Math.min(text.length, idx + needle.length + 120);
        const snippet = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
        hits.push({ page: i + 1, snippet });
        from = idx + needle.length;
      }
      if (hits.length >= max) break;
    }
    if (!hits.length) return `No matches for "${q}".`;
    return hits.map(h => `p.${h.page}: ${h.snippet}`).join('\n');
  }
  if (name === 'fetch_url') {
    const u = String(args.url || '').trim();
    if (!u) throw new Error('url required');
    const r = await fetch(`/api/fetch?url=${encodeURIComponent(u)}`);
    const body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
    return body;
  }
  if (name === 'arxiv_lookup') {
    const id = String(args.id || '').trim();
    if (!id) throw new Error('id required');
    const url = `http://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
    const r = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
    const body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
    return body;
  }
  if (name === 'scroll_to_page') {
    const p = Number(args.page);
    if (!viewer?.scrollToPage) throw new Error('viewer not available');
    if (!Number.isInteger(p) || p < 1) throw new Error(`invalid page ${args.page}`);
    viewer.scrollToPage(p);
    return `Scrolled to page ${p}.`;
  }
  if (name === 'highlight_passage') {
    const p = Number(args.page);
    const q = String(args.quote || '').trim();
    if (!viewer?.highlightPassage) throw new Error('viewer not available');
    if (!Number.isInteger(p) || p < 1) throw new Error(`invalid page ${args.page}`);
    if (!q) throw new Error('quote required');
    const ok = viewer.highlightPassage(p, q);
    if (!ok) throw new Error(`could not locate quote on page ${p} (whitespace-collapsed, case-insensitive)`);
    return `Highlighted passage on page ${p}.`;
  }
  if (name === 'run_python') {
    const code = String(args.code || '');
    if (!code) throw new Error('code required');
    if (!python?.run) throw new Error('python sandbox not available');
    return await python.run(code);
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function mentionClass(mention) {
  return mention.replace('@', '');
}

// Extract a clean paper title from the first page text using a cheap+fast
// model. Returns null on failure (caller falls back to PDF metadata or
// filename). Costs ~$0.0001 per call.
export async function extractPaperTitle(firstPageText) {
  const key = getKey();
  if (!key) return null;
  const text = (firstPageText || '').slice(0, 3000);
  if (text.replace(/\s+/g, '').length < 30) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin,
        'X-Title': 'paperchat',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        messages: [{
          role: 'user',
          content:
            `Extract the paper's title from this first page of a research paper. Reply with ONLY the title text — no quotes, no commentary, no "Title:" prefix. If the text is not from a paper or you cannot identify a title, reply with exactly UNKNOWN.\n\nFIRST PAGE:\n${text}`,
        }],
        max_tokens: 80,
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    let out = (json.choices?.[0]?.message?.content || '').trim();
    out = out.replace(/^["“”'`]+|["“”'`]+$/g, '');
    out = out.replace(/^(title:|paper title:)\s*/i, '');
    if (!out || out.length < 4 || out.length > 250 || /^unknown$/i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

// System prompt for the @code path. The Claude Agent SDK has its own toolset
// (Read/Edit/Bash/Grep/WebFetch/WebSearch) — DO NOT advertise the OpenRouter-
// path tools (run_python, find_in_paper, etc.) here, or the agent will try to
// call tools that don't exist.
function buildCodeSystemPrompt({ paperTitle, paperPagesText, thread }) {
  const ctx = buildPaperContext({ paperTitle, paperPagesText, thread });
  return `You are an expert reader helping a user understand a paper through threaded discussion. You have Claude Code's filesystem and shell tools (Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch) available in a sandboxed working directory. Use them to write/run code that verifies claims in the paper, fetch external resources, or otherwise help the user explore.

${ctx}

Stay grounded in the paper; cite page numbers when referencing content. Be concise unless asked for depth.

When fetching arXiv papers via WebFetch, ALWAYS use the HTML rendering at \`https://arxiv.org/html/<id>\` (or \`/abs/<id>\` for just the abstract). NEVER use \`/pdf/\` URLs — Claude Code's WebFetch can't extract PDF text.

When you write code in your reply, ALWAYS use fenced markdown blocks with an explicit language tag (e.g. \`\`\`python, \`\`\`bash, \`\`\`typescript, \`\`\`json) so it renders with syntax highlighting. For inline code, use single backticks.

## Math formatting — strict

Render ALL math as LaTeX, wrapped in \`$...$\` (inline) or \`$$...$$\` (display). KaTeX renders it for the user. NEVER output bare Unicode math symbols (\`x̄\`, \`∑\`, \`∈\`, \`ℝ\`, \`ᵢ\`, etc.) — write \`$\\bar x$\`, \`$\\sum$\`, \`$\\in$\`, \`$\\mathbb R$\`, \`$x_i$\` instead. Keep each formula inside a single \`$...$\` pair; never break a formula across snippets. Inside \`$$...$$\` use proper subscripts (\`\\sum_{i=1}^N\` not \`\\sum{i=1}^N\`).`;
}

// ===== @code path: Claude Agent SDK via local SSE endpoint =====
async function streamClaudeCode({ systemPrompt, history, thread, onDelta, onToolCall }) {
  // Flatten the prior conversation into a single prompt block so the SDK can
  // treat it as one "user message". The SDK manages its own context, so we
  // don't need to mimic OpenAI message-array semantics.
  const transcript = history.map(m => {
    if (m.role === 'user') return `USER: ${m.content}`;
    if (m.role === 'assistant') return `ASSISTANT: ${m.content}`;
    return '';
  }).filter(Boolean).join('\n\n');

  const userPrompt = transcript || 'Please answer.';
  const workdirName = `${(thread.paperId || 'paper')}-${thread.id}`;

  const res = await fetch('/api/claude_code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ systemPrompt, userPrompt, workdirName }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`/api/claude_code: ${res.status} ${t.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let finalText = '';
  // Track tool_use → tool_result so we fire one onToolCall per matched pair.
  const pending = new Map();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let evt;
      try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (evt.type === 'text') {
        finalText += evt.content;
        onDelta?.(evt.content);
      } else if (evt.type === 'tool_use') {
        pending.set(evt.id, { name: evt.name, args: evt.args });
      } else if (evt.type === 'tool_result') {
        const start = pending.get(evt.id) || { name: 'unknown', args: {} };
        pending.delete(evt.id);
        onToolCall?.({
          name: start.name,
          args: start.args,
          ok: evt.ok !== false,
          error: evt.ok === false ? String(evt.result || '').slice(0, 500) : null,
          result: String(evt.result ?? ''),
        });
      } else if (evt.type === 'error') {
        throw new Error(evt.message || 'claude_code error');
      } else if (evt.type === 'done') {
        // stop reading further; the server will end shortly
      }
    }
  }
  return { content: finalText, model: 'claude-code' };
}
