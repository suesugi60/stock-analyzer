// 同期アダプタ(mock)のテスト。本番の Firebase には接続しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSync, seeded, waitFor } from './helpers.mjs';

const SY = loadSync();
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const mock = (storage, uid) => SY.createBackend({ kind: 'mock', storage, uid, channel: null });

test('roomPath: チンチロの部屋(4文字そのまま)と重ならない場所に置く', () => {
  assert.equal(SY.roomPath('AB7K'), 'rooms/RL-AB7K');
  assert.ok(SY.CODE_RE.test('AB7K'));
  assert.ok(!SY.CODE_RE.test('ab7k'));
  assert.ok(!SY.CODE_RE.test('AB7'));
  assert.ok(!SY.CODE_RE.test('AB1K'), '読み間違えやすい 1・0・I・O・L は使わない');
});

test('roomCode / allocateRoomCode: 4 文字のコードを作り、使われているコードは避ける', async () => {
  const code = SY.roomCode(seeded(1));
  assert.match(code, SY.CODE_RE);
  const b = await mock(memoryStorage(), 'host');
  const first = SY.roomCode(seeded(7));
  await b.set(SY.roomPath(first), { hostUid: 'someone' });
  const got = await SY.allocateRoomCode(b, seeded(7));
  assert.notEqual(got, first);
  assert.match(got, SY.CODE_RE);
  b.close();
});

test('mock: set / get / update / remove と watch(書くたびに順番どおり届く)', async () => {
  const b = await mock(memoryStorage(), 'u1');
  const seen = [];
  const off = b.watch('rooms/RL-TEST/state', (v) => seen.push(v));
  await b.set('rooms/RL-TEST', { hostUid: 'u1', state: { seq: 0 } });
  await b.update('rooms/RL-TEST/state', { seq: 1, kind: 'names' });
  await b.set('rooms/RL-TEST/queue/u2', { joinedAt: 5 });
  await waitFor(() => seen.length >= 3);
  assert.deepEqual(seen, [null, { seq: 0 }, { seq: 1, kind: 'names' }]);
  assert.deepEqual(await b.get('rooms/RL-TEST/queue'), { u2: { joinedAt: 5 } });
  await b.remove('rooms/RL-TEST/queue/u2');
  assert.equal(await b.get('rooms/RL-TEST/queue'), null, '空になった入れ物は消える(Firebase と同じ)');
  off();
  b.close();
});

test('mock: 同じ保存先を見ている 2 つの端末で、部屋の中身が同じになる', async () => {
  const storage = memoryStorage();
  const host = await mock(storage, 'host');
  const guest = await mock(storage, 'guest');
  assert.notEqual(host.uid, guest.uid);
  await host.set(SY.roomPath('AB7K'), { hostUid: host.uid, state: { phase: 'open' } });
  await guest.set(`${SY.roomPath('AB7K')}/queue/${guest.uid}`, { joinedAt: 1 });
  assert.deepEqual(await host.get(`${SY.roomPath('AB7K')}/queue`), { guest: { joinedAt: 1 } });
  host.close();
  guest.close();
});

test('explainError: Firebase のエラーを、次に何をすればよいか分かる日本語にする', () => {
  assert.ok(SY.explainError({ code: 'PERMISSION_DENIED' }).includes('ルール'));
  assert.ok(SY.explainError({ code: 'auth/network-request-failed' }).includes('ネットワーク'));
  assert.equal(SY.explainError(new Error('そのまま')), 'そのまま');
});
