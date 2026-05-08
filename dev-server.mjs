// Zero-dep dev server. Serves static files + /env.js generated from .env / .env.local.
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;

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
  if (ct.includes('html') || ct.includes('xml+xhtml')) {
    text = stripHtml(raw);
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
  return { status: r.status, finalUrl: r.url, contentType: ct, text };
}

// SSE handler that streams Claude Agent SDK events to the browser.
async function handleClaudeCode(req, res) {
  const env = await readEnvFiles();
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    res.writeHead(400);
    return res.end('ANTHROPIC_API_KEY not set in .env');
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
        send({ type: 'done', stopReason: msg.stop_reason, totalCostUsd: msg.total_cost_usd });
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

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/claude_code' && req.method === 'POST') {
      return handleClaudeCode(req, res);
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
        const header = `# fetched\nurl: ${out.finalUrl}\nstatus: ${out.status}\ncontent-type: ${out.contentType}\n\n`;
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
    });
    res.end(buf);
  } catch (err) {
    res.writeHead(500);
    res.end('Server error: ' + err.message);
  }
}).listen(PORT, () => {
  console.log(`paperchat → http://localhost:${PORT}`);
});
