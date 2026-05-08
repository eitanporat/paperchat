// Tiny IndexedDB wrapper. Three stores: papers, threads, messages.
const DB_NAME = 'paperchat';
const LEGACY_DB_NAMES = ['fermat-clone'];
const DB_VERSION = 1;

let _db = null;

export function openDb() {
  if (_db) return Promise.resolve(_db);
  return openInternal().then(async (db) => {
    _db = db;
    await maybeMigrateLegacy(db);
    return db;
  });
}

function openInternal(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('papers')) {
        const papers = db.createObjectStore('papers', { keyPath: 'id' });
        papers.createIndex('lastOpened', 'lastOpened');
      }
      if (!db.objectStoreNames.contains('threads')) {
        const threads = db.createObjectStore('threads', { keyPath: 'id' });
        threads.createIndex('paperId', 'paperId');
      }
      if (!db.objectStoreNames.contains('messages')) {
        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('threadId', 'threadId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// One-shot copy of papers/threads/messages from any legacy DB whose name we
// used to use (e.g. an older project name) into the current DB. Runs only when
// the new DB is empty so it never clobbers fresh data.
async function maybeMigrateLegacy(newDb) {
  const tx = newDb.transaction('papers', 'readonly');
  const count = await new Promise((res, rej) => {
    const r = tx.objectStore('papers').count();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  if (count > 0) return;

  for (const legacyName of LEGACY_DB_NAMES) {
    const legacyExists = await dbExists(legacyName);
    if (!legacyExists) continue;
    let legacy;
    try { legacy = await openInternal(legacyName); }
    catch { continue; }
    const stores = ['papers', 'threads', 'messages'];
    const data = {};
    for (const s of stores) {
      if (!legacy.objectStoreNames.contains(s)) continue;
      data[s] = await new Promise((res, rej) => {
        const r = legacy.transaction(s, 'readonly').objectStore(s).getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    legacy.close();
    if (!data.papers?.length) continue;
    console.log(`[paperchat] migrating ${data.papers.length} papers + ${data.threads?.length || 0} threads from legacy "${legacyName}" DB`);
    for (const s of stores) {
      if (!data[s]?.length) continue;
      const wt = newDb.transaction(s, 'readwrite').objectStore(s);
      for (const item of data[s]) await new Promise((res, rej) => {
        const r = wt.put(item);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      });
    }
  }
}

async function dbExists(name) {
  if (typeof indexedDB.databases === 'function') {
    const list = await indexedDB.databases().catch(() => []);
    return list.some(d => d.name === name);
  }
  // Older Firefox: open and check if it's a fresh DB. Skip migration on those.
  return false;
}

function tx(store, mode = 'readonly') {
  return openDb().then(db => db.transaction(store, mode).objectStore(store));
}

function awaitReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const Papers = {
  async list() {
    const store = await tx('papers');
    const all = await awaitReq(store.getAll());
    return all.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  },
  async get(id) {
    const store = await tx('papers');
    return awaitReq(store.get(id));
  },
  async put(paper) {
    const store = await tx('papers', 'readwrite');
    await awaitReq(store.put(paper));
    return paper;
  },
  async delete(id) {
    const store = await tx('papers', 'readwrite');
    await awaitReq(store.delete(id));
    // cascade
    const ts = await Threads.byPaper(id);
    for (const t of ts) await Threads.delete(t.id);
  },
  async touch(id) {
    const p = await this.get(id);
    if (!p) return;
    p.lastOpened = Date.now();
    await this.put(p);
  },
};

export const Threads = {
  async byPaper(paperId) {
    const store = await tx('threads');
    const idx = store.index('paperId');
    const all = await awaitReq(idx.getAll(paperId));
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },
  async get(id) {
    const store = await tx('threads');
    return awaitReq(store.get(id));
  },
  async put(thread) {
    const store = await tx('threads', 'readwrite');
    await awaitReq(store.put(thread));
    return thread;
  },
  async delete(id) {
    const store = await tx('threads', 'readwrite');
    await awaitReq(store.delete(id));
    const msgs = await Messages.byThread(id);
    for (const m of msgs) await Messages.delete(m.id);
  },
};

export const Messages = {
  async byThread(threadId) {
    const store = await tx('messages');
    const idx = store.index('threadId');
    const all = await awaitReq(idx.getAll(threadId));
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },
  async put(msg) {
    const store = await tx('messages', 'readwrite');
    await awaitReq(store.put(msg));
    return msg;
  },
  async delete(id) {
    const store = await tx('messages', 'readwrite');
    await awaitReq(store.delete(id));
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
