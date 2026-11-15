import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSync, waitFor, seeded } from './helpers.mjs';

const { createBackend, roomCode } = loadSync();

function memStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

async function pair() {
  const ch = 'chinchiro-test-' + Date.now() + '-' + Math.random();
  const storage = memStorage();
  const a = await createBackend({ kind: 'mock', storage, channel: new BroadcastChannel(ch), uid: 'host' });
  const b = await createBackend({ kind: 'mock', storage, channel: new BroadcastChannel(ch), uid: 'kid' });
  return { a, b };
}

test('mock: set/update/remove した値を別の端末の watch が受け取る', async () => {
  const { a, b } = await pair();
  assert.equal(a.uid, 'host');
  assert.equal(b.uid, 'kid');
  const seen = [];
  const off = b.watch('rooms/T1/state', (v) => seen.push(v));
  await a.set('rooms/T1/state', { phase: 'lobby' });
  await a.update('rooms/T1/state', { phase: 'parent', 'match/round': 1 });
  await waitFor(() => seen.length >= 3);
  assert.deepEqual(seen, [null, { phase: 'lobby' }, { phase: 'parent', match: { round: 1 } }]);
  assert.equal(await b.get('rooms/T1/state/phase'), 'parent');
  assert.deepEqual(await b.get('rooms/T1'), { state: { phase: 'parent', match: { round: 1 } } });
  await a.remove('rooms/T1/state');
  await waitFor(() => seen.length >= 4);
  assert.equal(seen[3], null);
  assert.equal(await b.get('rooms/T1/state'), null);
  off();
  await a.set('rooms/T1/state', { phase: 'x' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 4, 'unsubscribe 後は呼ばれない');
  a.close(); b.close();
});

test('mock: 同じ値を set しても watch は呼ばれない。子の値の変更は親の watch にも届く', async () => {
  const { a, b } = await pair();
  const seen = [];
  b.watch('rooms/T2', (v) => seen.push(v));
  await a.set('rooms/T2/players/k1', { name: 'A' });
  await waitFor(() => seen.length >= 2);
  await a.set('rooms/T2/players/k1', { name: 'A' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 2);
  await a.set('rooms/T2/players/k1/name', 'B');
  await waitFor(() => seen.length >= 3);
  assert.deepEqual(seen[2], { players: { k1: { name: 'B' } } });
  a.close(); b.close();
});

test('mock: 自分の set も自分の watch に届く。now() は数値', async () => {
  const { a, b } = await pair();
  const seen = [];
  a.watch('rooms/T3/x', (v) => seen.push(v));
  await a.set('rooms/T3/x', 1);
  await waitFor(() => seen.length >= 2);
  assert.deepEqual(seen, [null, 1]);
  assert.equal(typeof a.now(), 'number');
  await a.onDisconnectRemove('rooms/T3/x'); // Node では no-op だが例外にならない
  await a.onDisconnectSet('rooms/T3/y', false);
  a.close(); b.close();
});

test('mock: uid は opts.uid → storage の保存値 → 新規 の順', async () => {
  const storage = memStorage();
  const ch = 'c-' + Math.random();
  const x = await createBackend({ kind: 'mock', storage, channel: new BroadcastChannel(ch) });
  assert.match(x.uid, /^u_[a-z0-9]{8,}$/);
  const y = await createBackend({ kind: 'mock', storage, channel: new BroadcastChannel(ch) });
  assert.equal(y.uid, x.uid, '同じ端末(storage)なら同じ uid');
  x.close(); y.close();
});

test('roomCode: 4文字で紛らわしい文字(0,O,1,I,L)を含まない', () => {
  for (let s = 1; s <= 200; s++) {
    const c = roomCode(seeded(s));
    assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/, c);
  }
});

test('firebase: config が無ければ分かるエラー', async () => {
  await assert.rejects(createBackend({ kind: 'firebase' }), /FIREBASE_CONFIG/);
  await assert.rejects(createBackend({ kind: 'firebase', config: null }), /FIREBASE_CONFIG/);
});

test('mock: onConnected は接続時に true で呼ばれ、serverTimestamp は数値', async () => {
  const { a, b } = await pair();
  const seen = [];
  a.onConnected((v) => seen.push(v));
  await waitFor(() => seen.length >= 1);
  assert.deepEqual(seen, [true]);
  assert.equal(typeof a.serverTimestamp(), 'number');
  a.close(); b.close();
});
