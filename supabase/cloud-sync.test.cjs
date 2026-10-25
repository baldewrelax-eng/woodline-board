'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WoodlineCloud } = require('../cloud-sync.js');
class Store {
  data = new Map(); get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
function backend() {
  const boards = new Map(); let offline = false, block;
  const reply = (status, obj) => ({ ok: status < 400, status, text: async () => obj == null ? '' : JSON.stringify(obj) });
  return {
    boards,
    offline(value) { offline = value; },
    blockNext() { let release; const wait = new Promise(r => release = r); block = wait; return release; },
    async fetch(url, options) {
      if (offline) throw new TypeError('network unavailable');
      const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : {}, token = options.headers.Authorization?.split(' ')[1];
      if (path === '/auth/v1/signup') return reply(200, { id: 'user-new', email: body.email });
      if (path === '/auth/v1/token') {
        const uid = body.email?.startsWith('second') ? 'user-b' : 'user-a';
        return reply(200, { access_token: uid, refresh_token: 'refresh-' + uid, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid, email: body.email || 'owner@example.org' } });
      }
      if (path === '/auth/v1/user') return reply(200, { id: token, email: token + '@example.org' });
      if (path === '/auth/v1/logout' || path === '/auth/v1/recover') return reply(200, {});
      if (path === '/rest/v1/woodline_boards') return reply(200, boards.has(token) ? [structuredClone(boards.get(token))] : []);
      if (path === '/rest/v1/rpc/woodline_save_board') {
        const gate = block; block = null; if (gate) await gate;
        const current = boards.get(token);
        if (current?.mutation_id === body.p_mutation_id) return reply(200, { conflict: false, board: current });
        if ((current?.revision || 0) !== body.p_expected_revision) return reply(200, { conflict: true, board: current || null });
        const saved = { revision: (current?.revision || 0) + 1, payload: body.p_payload, mutation_id: body.p_mutation_id, updated_at: new Date().toISOString() };
        boards.set(token, saved); return reply(200, { conflict: false, board: structuredClone(saved) });
      }
      return reply(404, {});
    }
  };
}
function client(api, storage = new Store(), events = []) {
  return new WoodlineCloud({ url: 'https://project.supabase.co', anonKey: 'public-test-key', storage, fetch: api.fetch,
    debounce: 60000, pollInterval: 60000, onState: (payload, meta) => events.push({ payload, meta }), onStatus: status => events.push(status) });
}
const credentials = ['owner@example.org', 'test-password'];
const board = title => ({ version: 2, tasks: [{ id: 'one', title }] });

test('empty cloud never uploads anonymous data; email signup without session requires confirmation', async () => {
  const api = backend(), events = [], c = client(api, new Store(), events);
  try {
    const result = await c.signUp(...credentials); assert.equal(result.confirmationRequired, true); assert.equal(c.user, null);
    await c.signIn(...credentials); assert.equal(c.ready, true); assert.equal(c.remote, null); assert.equal(api.boards.size, 0);
    assert.ok(events.some(e => e.payload === null && e.meta.empty));
    await c.save(board('First')); await c.sync(); assert.equal(api.boards.get('user-a').revision, 1); assert.equal(c.status, 'synced');
  } finally { c.dispose(); }
});

test('two devices load the same authenticated board and refresh remote changes', async () => {
  const api = backend(), a = client(api), b = client(api);
  try { await a.signIn(...credentials); await a.save(board('Desktop')); await a.sync(); await b.signIn(...credentials); assert.equal(b.remote.tasks[0].title, 'Desktop'); await b.save(board('Phone')); await b.sync(); await a.sync(); assert.equal(a.remote.tasks[0].title, 'Phone'); }
  finally { a.dispose(); b.dispose(); }
});

test('offline outbox survives a recreated client and resumes without losing edits', async () => {
  const api = backend(), store = new Store(), a = client(api, store), events = [];
  await a.signIn(...credentials); await a.save(board('Baseline')); await a.sync(); api.offline(true);
  await a.save(board('Offline edit')); await a.sync(); assert.equal(a.status, 'offline'); a.dispose();
  const restored = client(api, store, events);
  try { await restored.init(); assert.equal(restored.pending.payload.tasks[0].title, 'Offline edit'); assert.equal(restored.status, 'offline'); api.offline(false); await restored.sync(); assert.equal(restored.pending, null); assert.equal(api.boards.get('user-a').payload.tasks[0].title, 'Offline edit'); }
  finally { restored.dispose(); }
});

test('concurrent edits require explicit resolution and archive the rejected draft', async () => {
  const api = backend(), a = client(api), b = client(api);
  try {
    await a.signIn(...credentials); await a.save(board('Original')); await a.sync(); await b.signIn(...credentials);
    await a.save(board('Desktop update')); await a.sync(); await b.save(board('Phone update')); await b.sync();
    assert.equal(b.status, 'conflict'); assert.equal(b.pending.payload.tasks[0].title, 'Phone update'); assert.equal(api.boards.get('user-a').payload.tasks[0].title, 'Desktop update');
    await b.resolveConflict('remote'); assert.equal(b.remote.tasks[0].title, 'Desktop update'); assert.ok(b.listRecoveryDrafts().some(d => d.payload.tasks[0].title === 'Phone update'));
  } finally { a.dispose(); b.dispose(); }
});

test('explicit local resolution creates a new revision and archives cloud snapshot', async () => {
  const api = backend(), a = client(api), b = client(api);
  try { await a.signIn(...credentials); await a.save(board('One')); await a.sync(); await b.signIn(...credentials); await a.save(board('Two')); await a.sync(); await b.save(board('Three')); await b.sync(); await b.resolveConflict('local'); assert.equal(api.boards.get('user-a').payload.tasks[0].title, 'Three'); assert.ok(b.listRecoveryDrafts().some(d => d.source === 'remote' && d.payload.tasks[0].title === 'Two')); }
  finally { a.dispose(); b.dispose(); }
});

test('account change never exposes or uploads another account outbox', async () => {
  const api = backend(), store = new Store(), c = client(api, store), events = [];
  try { await c.signIn(...credentials); api.offline(true); await c.save(board('Private A')); await c.signOut(); api.offline(false); c.options.onState = (payload, meta) => events.push({ payload, meta }); await c.signIn('second@example.org', 'test-password'); assert.equal(c.pending, null); assert.equal(c.remote, null); assert.equal(api.boards.has('user-b'), false); assert.ok(!events.some(e => e.payload?.tasks?.[0]?.title === 'Private A')); await c.signOut(); await c.signIn(...credentials); await c.sync(); assert.equal(api.boards.get('user-a').payload.tasks[0].title, 'Private A'); }
  finally { c.dispose(); }
});

test('editing during a network save preserves newer snapshot and increments base revision', async () => {
  const api = backend(), c = client(api);
  try { await c.signIn(...credentials); await c.save(board('Before')); const release = api.blockNext(); const syncing = c.sync(); await new Promise(r => setImmediate(r)); await c.save(board('After')); release(); await syncing; assert.equal(api.boards.get('user-a').payload.tasks[0].title, 'After'); assert.equal(api.boards.get('user-a').revision, 2); assert.equal(c.pending, null); }
  finally { c.dispose(); }
});

test('multiple writers on one device retain both outboxes after restart', async () => {
  const api = backend(), store = new Store(), a = client(api, store), b = client(api, store);
  await a.signIn(...credentials); await b.signIn(...credentials); api.offline(true); await a.save(board('Tab A')); await b.save(board('Tab B')); a.dispose(); b.dispose(); api.offline(false);
  const restored = client(api, store);
  try { await restored.init(); assert.equal(restored.status, 'conflict'); assert.equal(restored.listRecoveryDrafts(false).length, 2); assert.equal(api.boards.size, 0); }
  finally { restored.dispose(); }
});

test('storage failure never claims durable local save and cloud can still recover', async () => {
  const api = backend(), store = new Store(), c = client(api, store);
  try { await c.signIn(...credentials); store.setItem = () => { throw new Error('quota'); }; api.offline(true); await c.save(board('In memory')); assert.equal(c.pending.durable, false); assert.equal(c.status, 'storage-error'); await c.sync(); assert.equal(c.status, 'offline'); assert.ok(c.pending); api.offline(false); await c.sync(); assert.equal(c.status, 'synced'); assert.equal(c.pending, null); }
  finally { c.dispose(); }
});

test('expired auth never claims cloud saved and preserves durable outbox', async () => {
  const api = backend(), c = client(api), events = [];
  try {
    await c.signIn(...credentials); await c.save(board('Needs auth')); c.session.expires_at = 1;
    const originalFetch = c.fetch; c.fetch = async (url, opts) => new URL(url).pathname === '/auth/v1/token' ? { ok: false, status: 400, text: async () => JSON.stringify({ error_code: 'refresh_token_not_found' }) } : originalFetch(url, opts);
    c.options.onStatus = event => events.push(event);
    await c.sync(); assert.equal(c.status, 'error'); assert.ok(c.pending?.durable); assert.ok(!events.some(e => e.state === 'synced')); assert.equal(api.boards.size, 0);
  } finally { c.dispose(); }
});

test('late save response after sign-out cannot restore the previous account', async () => {
  const api = backend(), c = client(api);
  try { await c.signIn(...credentials); await c.save(board('A in flight')); const release = api.blockNext(); const saving = c.sync(); await new Promise(r => setImmediate(r)); await c.signOut(); await c.signIn('second@example.org', 'test-password'); release(); await saving; assert.equal(c.user.id, 'user-b'); assert.equal(c.remote, null); assert.equal(c.pending, null); assert.equal(api.boards.has('user-b'), false); }
  finally { c.dispose(); }
});

test('sign-out during restored-session verification cannot resurrect a session', async () => {
  const api = backend(), store = new Store(), first = client(api, store); await first.signIn(...credentials); first.dispose();
  let release; const gate = new Promise(r => release = r); const c = client(api, store); const original = c.fetch; c.fetch = async (url, opts) => { if (new URL(url).pathname === '/auth/v1/user') await gate; return original(url, opts); };
  try { const initializing = c.init(); await new Promise(r => setImmediate(r)); await c.signOut(); release(); await initializing; assert.equal(c.user, null); assert.equal(c.status, 'signed-out'); }
  finally { c.dispose(); }
});

test('password update is distinct from board synchronization', async () => {
  const api = backend(), c = client(api);
  try { await c.signIn(...credentials); await c.save(board('Still pending')); await c.updatePassword('new-password'); assert.equal(c.status, 'password-updated'); assert.ok(c.pending); }
  finally { c.dispose(); }
});

test('administrative Supabase keys are rejected in the browser client', () => {
  assert.throws(() => new WoodlineCloud({ url: 'https://project.supabase.co', anonKey: 'sb_secret_no-browser' }), /публичный/);
  const jwt = 'e30.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.fake';
  assert.throws(() => new WoodlineCloud({ url: 'https://project.supabase.co', anonKey: jwt }), /service_role/);
});

test('late sign-in response cannot log back in after explicit sign-out', async () => {
  const api = backend(), c = client(api); let release; const gate = new Promise(r => release = r); const original = c.fetch;
  c.fetch = async (url, options) => { if (new URL(url).pathname === '/auth/v1/token') await gate; return original(url, options); };
  try { const signingIn = c.signIn(...credentials); await new Promise(r => setImmediate(r)); await c.signOut(); release(); await signingIn; assert.equal(c.user, null); assert.equal(c.status, 'signed-out'); }
  finally { c.dispose(); }
});

test('conflict resolution response cannot apply account A data after switching to B', async () => {
  const api = backend(), store = new Store(), c = client(api, store);
  let release; const gate = new Promise(r => release = r);
  try {
    await c.signIn(...credentials); await c.save(board('A original')); await c.sync();
    api.boards.set('user-a', { ...api.boards.get('user-a'), payload: board('A remote private'), revision: 2 });
    await c.save(board('A local private')); await c.sync(); assert.equal(c.status, 'conflict');
    const original = c.fetch; let intercept = true;
    c.fetch = async (url, opts) => { const result = await original(url, opts); if (intercept && new URL(url).pathname === '/rest/v1/woodline_boards') { intercept = false; await gate; } return result; };
    const resolving = c.resolveConflict('local'); const rejected = assert.rejects(resolving, /Аккаунт изменился/);
    await new Promise(r => setImmediate(r)); await c.signOut(); await c.signIn('second@example.org', 'test-password'); release(); await rejected;
    assert.equal(c.user.id, 'user-b'); assert.equal(c.remote, null); assert.equal(c.pending, null); assert.equal(api.boards.has('user-b'), false);
    for (const [key, value] of store.data) if (key.includes('user-b:')) assert.ok(!value.includes('A remote private') && !value.includes('A local private'));
  } finally { c.dispose(); }
});

test('history metadata and payload promises are rejected after account change', async () => {
  const api = backend(), c = client(api); let release; const gate = new Promise(r => release = r);
  try {
    await c.signIn(...credentials); const original = c.fetch;
    c.fetch = async (url, opts) => {
      if (new URL(url).pathname === '/rest/v1/woodline_board_history') {
        const rows = [{ revision: 1, updated_at: new Date().toISOString(), payload: board('A historical private') }];
        await gate; return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
      }
      return original(url, opts);
    };
    const history = c.listHistory(), revision = c.getRevision(1);
    const rejectedHistory = assert.rejects(history, /Аккаунт изменился/), rejectedRevision = assert.rejects(revision, /Аккаунт изменился/);
    await new Promise(r => setImmediate(r)); await c.signOut(); await c.signIn('second@example.org', 'test-password'); release(); await Promise.all([rejectedHistory, rejectedRevision]);
    assert.equal(c.user.id, 'user-b'); assert.equal(c.remote, null);
  } finally { c.dispose(); }
});

test('late recovery update cannot change the next account status', async () => {
  const api = backend(), c = client(api); let release; const gate = new Promise(r => release = r);
  try {
    await c.signIn(...credentials); c.recovery = true; const original = c.fetch;
    c.fetch = async (url, opts) => { const result = await original(url, opts); if (new URL(url).pathname === '/auth/v1/user' && opts.method === 'PUT') await gate; return result; };
    const updating = c.updatePassword('new-password'); const rejected = assert.rejects(updating, /Аккаунт изменился/);
    await new Promise(r => setImmediate(r)); await c.signOut(); await c.signIn('second@example.org', 'test-password'); release(); await rejected;
    assert.equal(c.user.id, 'user-b'); assert.equal(c.status, 'synced'); assert.equal(c.recovery, false);
  } finally { c.dispose(); }
});

test('account switch during token preparation prevents sending old board under a new token', async () => {
  const api = backend(), c = client(api); let release; const gate = new Promise(r => release = r);
  try {
    await c.signIn(...credentials); await c.save(board('A sensitive data'));
    const originalEnsure = c.ensureToken.bind(c); let intercept = true;
    c.ensureToken = async () => { await originalEnsure(); if (intercept) { intercept = false; await gate; } };
    const saving = c.sync(); await new Promise(r => setImmediate(r)); await c.signOut(); await c.signIn('second@example.org', 'test-password'); release(); await saving;
    assert.equal(c.user.id, 'user-b'); assert.equal(api.boards.has('user-b'), false); assert.equal(api.boards.has('user-a'), false);
  } finally { c.dispose(); }
});
