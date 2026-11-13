// サーバーのテスト。node --test test/room.test.mjs で実行(ローカルの wrangler dev を起動する)。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_PASSWORD, startServer, Client, closeAll, joinPlayer, joinHost,
} from './helpers.mjs';

let server;
before(async () => { server = await startServer(); });
after(async () => { closeAll(); await server?.stop(); });
afterEach(() => closeAll());

const EMPTY_YOU = { name: null, blocked: false, pending: null, rejected: false, cards: [] };

// ---- 接続と認証 ----

test('静的ファイルとWebSocketの入口', async () => {
  assert.equal((await fetch(server.http + '/ws')).status, 426);
  assert.equal((await fetch(server.http + '/nope')).status, 404);
});

test('hello: 知らない合い札は未申請の状態が返る', async () => {
  const { state } = await joinPlayer(server);
  assert.deepEqual(state, {
    t: 'state', accepting: false, delay: 0, draws: [], lastAge: null, winners: [], you: EMPTY_YOU,
  });
});

test('hello: 合い札の形が違えば bad_message', async () => {
  const c = await Client.open(server.ws);
  c.send({ t: 'hello', token: 'xyz' });
  assert.equal((await c.next('error')).code, 'bad_message');
});

test('hello の前の request は need_hello', async () => {
  const c = await Client.open(server.ws);
  c.send({ t: 'request', name: 'たろう', count: 1 });
  assert.equal((await c.next('error')).code, 'need_hello');
});

test('auth: 合言葉が違えば auth_fail wrong、合っていれば host が返る', async () => {
  const c = await Client.open(server.ws);
  c.send({ t: 'auth', password: 'nope' });
  assert.equal((await c.next('auth_fail')).reason, 'wrong');
  c.send({ t: 'auth', password: HOST_PASSWORD });
  assert.deepEqual(await c.next('host'), {
    t: 'host', accepting: false, delay: 0, draws: [], winners: [], requests: [], players: [], blocked: [],
  });
});

test('auth: 合言葉が文字列でなければ auth_fail wrong', async () => {
  const c = await Client.open(server.ws);
  c.send({ t: 'auth', password: 12345 });
  assert.equal((await c.next('auth_fail')).reason, 'wrong');
});

test('主催者でない接続の主催者用操作は forbidden', async () => {
  const { c } = await joinPlayer(server);
  const ops = [
    { t: 'draw' }, { t: 'call', n: 1 }, { t: 'undo' }, { t: 'approve', id: 1, count: 1 }, { t: 'approve_all' },
    { t: 'reject', id: 1 }, { t: 'accepting', on: true }, { t: 'delay', sec: 5 }, { t: 'block', pid: 1 },
    { t: 'unblock', pid: 1 }, { t: 'new_round' }, { t: 'reset_all' },
  ];
  for (const m of ops) {
    c.send(m);
    assert.equal((await c.next('error')).code, 'forbidden', JSON.stringify(m));
  }
  // 認証していない新しい接続でも同じ
  const fresh = await Client.open(server.ws);
  fresh.send({ t: 'reset_all' });
  assert.equal((await fresh.next('error')).code, 'forbidden');
});

test('auth: 5回続けて間違えると、正しい合言葉でも locked', async () => {
  const s2 = await startServer();
  try {
    const c = await Client.open(s2.ws);
    for (let i = 0; i < 5; i++) {
      c.send({ t: 'auth', password: 'x' + i });
      assert.equal((await c.next('auth_fail')).reason, 'wrong');
    }
    c.send({ t: 'auth', password: HOST_PASSWORD });
    assert.equal((await c.next('auth_fail')).reason, 'locked');
    // 別の接続から試しても同じ接続元なので locked
    const c2 = await Client.open(s2.ws);
    c2.send({ t: 'auth', password: HOST_PASSWORD });
    assert.equal((await c2.next('auth_fail')).reason, 'locked');
  } finally {
    closeAll();
    await s2.stop();
  }
});

test('auth: HOST_PASSWORD が未設定なら誰も入れない(unset)', async () => {
  const s3 = await startServer({ vars: { HOST_PASSWORD: null } });
  try {
    const c = await Client.open(s3.ws);
    c.send({ t: 'auth', password: '' });
    assert.equal((await c.next('auth_fail')).reason, 'unset');
    c.send({ t: 'auth', password: HOST_PASSWORD });
    assert.equal((await c.next('auth_fail')).reason, 'unset');
  } finally {
    closeAll();
    await s3.stop();
  }
});
