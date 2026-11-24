// Sync codes for PaperDesk: a small store that lets one paper account move between devices.
// "Get my code" uploads the account and returns a code like K7QD-M2XP; typing the code on another
// device downloads it, and both then keep the same account up to date.
//
// Each code is one Durable Object (SyncBox) holding one JSON document: the paper account (cash,
// positions, orders, trade history and settings). No names, emails or passwords are stored. A code
// that is not used for 400 days is deleted. Paper money only.
//
// Routes (served by worker/index.js):
//   POST /sync/new             body {state}            -> {code, rev}
//   GET  /sync/<code>?since=N                          -> {rev, same:true} or {rev, updatedAt, state}
//   PUT  /sync/<code>          body {baseRev, state}   -> {rev} or 409 with the newer {rev, updatedAt, state}

const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L
const MAX_BYTES = 1800000;
const CHUNK = 100000;
const IDLE_MS = 400 * 86400 * 1000;

export function normCode(s) {
  const x = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (x.length !== 8) return null;
  for (const ch of x) if (!ALPHA.includes(ch)) return null;
  return x.slice(0, 4) + '-' + x.slice(4);
}

function newCode() {
  let s = '';
  while (s.length < 8) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    for (const x of b) if (x < 248 && s.length < 8) s += ALPHA[x % 31]; // 248 = 31 * 8, so no bias
  }
  return s.slice(0, 4) + '-' + s.slice(4);
}

function json(obj, status) {
  return new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

async function readBody(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BYTES) return { error: 'too-big' };
  const text = await request.text();
  if (text.length > MAX_BYTES) return { error: 'too-big' };
  try { return { body: JSON.parse(text) }; } catch (e) { return { error: 'bad-json' }; }
}

function validState(s) {
  return s && typeof s === 'object' && s.version === 1 && Array.isArray(s.positions) && Array.isArray(s.orders) && Array.isArray(s.history) && typeof s.balance === 'number';
}

// ---- the store behind one code (Durable Object storage, or a Map in tests) ----
async function readState(storage) {
  const n = (await storage.get('chunks')) || 0;
  if (!n) return '';
  const keys = []; for (let i = 0; i < n; i++) keys.push('s' + i);
  const m = await storage.get(keys);
  let out = ''; for (const k of keys) out += m.get(k) || '';
  return out;
}
async function writeState(storage, text, rev) {
  const old = (await storage.get('chunks')) || 0;
  const entries = { rev, updatedAt: Date.now(), chunks: Math.ceil(text.length / CHUNK) };
  for (let i = 0; i * CHUNK < text.length; i++) entries['s' + i] = text.slice(i * CHUNK, (i + 1) * CHUNK);
  await storage.put(entries);
  const stale = []; for (let i = entries.chunks; i < old; i++) stale.push('s' + i);
  if (stale.length) await storage.delete(stale);
}

export async function boxHandle(request, storage, setAlarm) {
  const url = new URL(request.url);
  // Read the body before touching storage, so the read-check-write below runs without a gap.
  const text = request.method === 'GET' ? '' : await request.text();
  const rev = (await storage.get('rev')) || 0;
  const touch = () => (setAlarm ? setAlarm(Date.now() + IDLE_MS) : null);
  if (url.pathname === '/create' && request.method === 'POST') {
    if (rev) return json({ error: 'taken' }, 409);
    await writeState(storage, text, 1);
    await touch();
    return json({ rev: 1 });
  }
  if (!rev) return json({ error: 'No paper account uses that code. Check it and try again.' }, 404);
  if (url.pathname === '/get' && request.method === 'GET') {
    const since = Number(url.searchParams.get('since'));
    if (since === rev) return json({ rev, same: true });
    await touch();
    return json('{"rev":' + rev + ',"updatedAt":' + Number(await storage.get('updatedAt')) + ',"state":' + (await readState(storage)) + '}');
  }
  if (url.pathname === '/put' && request.method === 'PUT') {
    if (text.length > MAX_BYTES) return json({ error: 'This account is too big to sync.' }, 413);
    const r = {}; try { r.body = JSON.parse(text); } catch (e) { return json({ error: 'Bad request.' }, 400); }
    if (!r.body || !validState(r.body.state)) return json({ error: 'That is not a PaperDesk account.' }, 400);
    if (Number(r.body.baseRev) !== rev) {
      return json('{"rev":' + rev + ',"updatedAt":' + Number(await storage.get('updatedAt')) + ',"state":' + (await readState(storage)) + '}', 409);
    }
    await writeState(storage, JSON.stringify(r.body.state), rev + 1);
    await touch();
    return json({ rev: rev + 1 });
  }
  return json({ error: 'Not found.' }, 404);
}

// Durable Object class: one per code.
export class SyncBox {
  constructor(state) { this.state = state; }
  fetch(request) { return boxHandle(request, this.state.storage, (t) => this.state.storage.setAlarm(t)); }
  async alarm() { await this.state.storage.deleteAll(); }
}

// The public routes. env.SYNC is the Durable Object namespace binding.
export async function syncRoute(request, env) {
  if (!env || !env.SYNC) return json({ error: 'Sync is not set up on this server yet.' }, 503);
  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/sync\/?/, '');
  const box = (code) => env.SYNC.get(env.SYNC.idFromName(code));
  if (rest === 'new' && request.method === 'POST') {
    const r = await readBody(request);
    if (r.error) return json({ error: r.error === 'too-big' ? 'This account is too big to sync.' : 'Bad request.' }, r.error === 'too-big' ? 413 : 400);
    if (!validState(r.body && r.body.state)) return json({ error: 'That is not a PaperDesk account.' }, 400);
    const text = JSON.stringify(r.body.state);
    for (let k = 0; k < 6; k++) {
      const code = newCode();
      const res = await box(code).fetch('https://box/create', { method: 'POST', body: text });
      if (res.status === 409) continue;
      if (!res.ok) return json({ error: 'Could not save right now. Try again in a minute.' }, 502);
      return json({ code, rev: 1 });
    }
    return json({ error: 'Could not make a code. Try again.' }, 503);
  }
  const code = normCode(rest);
  if (!code) return json({ error: 'Codes look like K7QD-M2XP: 8 letters and numbers.' }, 400);
  if (request.method === 'GET') return box(code).fetch('https://box/get?since=' + encodeURIComponent(url.searchParams.get('since') || ''));
  if (request.method === 'PUT') {
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BYTES) return json({ error: 'This account is too big to sync.' }, 413);
    return box(code).fetch('https://box/put', { method: 'PUT', body: await request.text(), headers: { 'Content-Type': 'application/json' } });
  }
  return json({ error: 'Not found.' }, 405);
}

// An in-memory stand-in for the Durable Object namespace, for local testing.
export function memoryNamespace() {
  const boxes = new Map();
  const storageFor = () => {
    const m = new Map();
    return {
      async get(k) { if (Array.isArray(k)) { const out = new Map(); for (const x of k) if (m.has(x)) out.set(x, m.get(x)); return out; } return m.get(k); },
      async put(k, v) { if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, b); } else m.set(k, v); },
      async delete(k) { for (const x of [].concat(k)) m.delete(x); },
      async deleteAll() { m.clear(); },
    };
  };
  return {
    idFromName(name) { return name; },
    get(id) {
      if (!boxes.has(id)) boxes.set(id, storageFor());
      const storage = boxes.get(id);
      return { fetch: (u, init) => boxHandle(new Request(u, init), storage, null) };
    },
  };
}
