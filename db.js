// HTTP-backed store. Talks to the dev-server's /api/{papers,threads,messages}
// endpoints so papers, threads and messages are persisted on disk under
// ~/.paperchat/ (configurable via PAPERCHAT_DATA). Same exported surface as the
// previous IndexedDB version so app.js doesn't have to change.

const LEGACY_DB_NAMES = ['paperchat', 'fermat-clone'];

async function jsonOrNull(r) {
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function okOrThrow(r) {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
}

// ---- Papers ------------------------------------------------------------
export const Papers = {
  async list() {
    await ensureMigrated();
    const r = await fetch('/api/papers');
    if (!r.ok) throw new Error(`list papers: ${r.status}`);
    const all = await r.json();
    return all.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  },
  async get(id) {
    await ensureMigrated();
    const meta = await jsonOrNull(await fetch(`/api/papers/${encodeURIComponent(id)}`));
    if (!meta) return null;
    // Load the PDF blob alongside metadata so callers can pass paper.blob
    // straight to pdf.js, matching the old IndexedDB shape.
    const br = await fetch(`/api/papers/${encodeURIComponent(id)}/blob`);
    if (br.ok) meta.blob = await br.blob();
    return meta;
  },
  async put(paper) {
    await ensureMigrated();
    const { blob, ...meta } = paper;
    await okOrThrow(await fetch(`/api/papers/${encodeURIComponent(paper.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(meta),
    }));
    // Upload the PDF only if we have one in memory AND the server doesn't
    // already have it on disk. The id is a content hash so a blob, once
    // stored, never needs re-uploading even on touch/title-backfill puts.
    if (blob) {
      const head = await fetch(`/api/papers/${encodeURIComponent(paper.id)}/blob`, { method: 'HEAD' });
      if (!head.ok) {
        await okOrThrow(await fetch(`/api/papers/${encodeURIComponent(paper.id)}/blob`, {
          method: 'PUT',
          headers: { 'content-type': 'application/pdf' },
          body: blob,
        }));
      }
    }
    return paper;
  },
  async delete(id) {
    await ensureMigrated();
    await okOrThrow(await fetch(`/api/papers/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  },
  async touch(id) {
    const p = await this.get(id);
    if (!p) return;
    p.lastOpened = Date.now();
    await this.put(p);
  },
};

// ---- Threads -----------------------------------------------------------
export const Threads = {
  async byPaper(paperId) {
    await ensureMigrated();
    const r = await fetch(`/api/threads?paperId=${encodeURIComponent(paperId)}`);
    if (!r.ok) throw new Error(`list threads: ${r.status}`);
    const all = await r.json();
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },
  async get(id) {
    await ensureMigrated();
    return jsonOrNull(await fetch(`/api/threads/${encodeURIComponent(id)}`));
  },
  async put(thread) {
    await ensureMigrated();
    await okOrThrow(await fetch(`/api/threads/${encodeURIComponent(thread.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(thread),
    }));
    return thread;
  },
  async delete(id) {
    await ensureMigrated();
    await okOrThrow(await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  },
};

// ---- Messages ----------------------------------------------------------
export const Messages = {
  async byThread(threadId) {
    await ensureMigrated();
    const r = await fetch(`/api/messages?threadId=${encodeURIComponent(threadId)}`);
    if (!r.ok) throw new Error(`list messages: ${r.status}`);
    const all = await r.json();
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },
  async put(msg) {
    await ensureMigrated();
    await okOrThrow(await fetch(`/api/messages/${encodeURIComponent(msg.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
    }));
    return msg;
  },
  async delete(id) {
    await ensureMigrated();
    await okOrThrow(await fetch(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  },
};

export function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export async function hashBlob(blob) {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- One-time IndexedDB → server migration -----------------------------
// Runs lazily the first time any store method is called. If the server has
// no papers yet AND any of the legacy IDB databases exist locally, copy
// their contents over via the HTTP API.

let _migratePromise = null;
function ensureMigrated() {
  if (!_migratePromise) _migratePromise = migrateLegacyIfNeeded();
  return _migratePromise;
}

async function migrateLegacyIfNeeded() {
  if (typeof indexedDB === 'undefined') return;
  // If the server already has papers, do nothing.
  try {
    const r = await fetch('/api/papers');
    if (r.ok) {
      const all = await r.json();
      if (all.length > 0) return;
    }
  } catch { return; }

  let migrated = 0;
  for (const name of LEGACY_DB_NAMES) {
    if (!(await idbExists(name))) continue;
    let db;
    try { db = await idbOpen(name); } catch { continue; }
    const papers = await idbGetAll(db, 'papers').catch(() => []);
    const threads = await idbGetAll(db, 'threads').catch(() => []);
    const messages = await idbGetAll(db, 'messages').catch(() => []);
    db.close();
    if (!papers.length && !threads.length && !messages.length) continue;
    console.log(`[paperchat] migrating ${papers.length} papers + ${threads.length} threads + ${messages.length} messages from legacy IDB "${name}"`);
    for (const p of papers) await uploadPaper(p);
    for (const t of threads) await fetch(`/api/threads/${encodeURIComponent(t.id)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t),
    });
    for (const m of messages) await fetch(`/api/messages/${encodeURIComponent(m.id)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m),
    });
    migrated += papers.length;
  }
  if (migrated) console.log(`[paperchat] migration complete — ${migrated} papers now on disk`);
}

async function uploadPaper(p) {
  const { blob, ...meta } = p;
  await fetch(`/api/papers/${encodeURIComponent(p.id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta),
  });
  if (blob) {
    await fetch(`/api/papers/${encodeURIComponent(p.id)}/blob`, {
      method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: blob,
    });
  }
}

function idbExists(name) {
  if (typeof indexedDB.databases !== 'function') return Promise.resolve(false);
  return indexedDB.databases().then(
    list => list.some(d => d.name === name),
    () => false,
  );
}

function idbOpen(name) {
  return new Promise((res, rej) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
    req.onblocked = () => rej(new Error('blocked'));
  });
}

function idbGetAll(db, store) {
  return new Promise((res, rej) => {
    if (!db.objectStoreNames.contains(store)) return res([]);
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
