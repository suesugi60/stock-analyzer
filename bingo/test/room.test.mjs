// サーバーのテスト。node --test test/room.test.mjs で実行(ローカルの wrangler dev を起動する)。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_PASSWORD, startServer, Client, closeAll, joinPlayer, joinHost, fresh, grant,
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

// ---- 受付・申請・許可 ----

const EMPTY_HOST = { requests: [], players: [], blocked: [], draws: [], winners: [] };

test('すべてリセット: 主催者に空の host が返り、受付と遅れはそのまま', async () => {
  const { c: host } = await joinHost(server);
  host.send({ t: 'accepting', on: true });
  await host.next('host');
  host.send({ t: 'delay', sec: 5 });
  await host.next('host');
  host.send({ t: 'reset_all' });
  assert.deepEqual(await host.next('host'), { t: 'host', accepting: true, delay: 5, ...EMPTY_HOST });
});

test('受付が締め切りなら申請は closed', async () => {
  const { c: host } = await fresh(server);
  host.send({ t: 'accepting', on: false });
  await host.next('host');
  const { c } = await joinPlayer(server);
  c.send({ t: 'request', name: 'たろう', count: 1 });
  assert.equal((await c.next('error')).code, 'closed');
});

test('accepting は全員に届く', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  const b = await joinPlayer(server);
  assert.equal(a.state.accepting, true);
  host.send({ t: 'accepting', on: false });
  assert.deepEqual(await a.c.next('accepting'), { t: 'accepting', on: false });
  assert.deepEqual(await b.c.next('accepting'), { t: 'accepting', on: false });
  assert.equal((await host.next('host')).accepting, false);
  host.send({ t: 'accepting', on: 'yes' });
  assert.equal((await host.next('error')).code, 'bad_message');
});

test('申請すると主催者に req_add、本人に you', async () => {
  const { c: host } = await fresh(server);
  const { c } = await joinPlayer(server);
  c.send({ t: 'request', name: '  たろう ', count: 3 });
  const { req } = await host.next('req_add');
  assert.deepEqual({ name: req.name, count: req.count }, { name: 'たろう', count: 3 });
  assert.ok(Number.isInteger(req.id) && Number.isInteger(req.pid));
  assert.deepEqual((await c.next('you')).you, { name: 'たろう', blocked: false, pending: 3, rejected: false, cards: [] });
});

test('許可するまでカードは届かない', async () => {
  const { c: host } = await fresh(server);
  const { c, token } = await joinPlayer(server);
  c.send({ t: 'request', name: 'たろう', count: 3 });
  await host.next('req_add');
  await c.next('you');
  await c.none('you');
  const again = await joinPlayer(server, token);
  assert.deepEqual(again.state.you.cards, []);
  assert.equal(again.state.you.pending, 3);
});

test('許可すると許可した枚数が本人にだけ届く', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  const b = await joinPlayer(server);
  a.c.send({ t: 'request', name: 'たろう', count: 3 });
  const { req } = await host.next('req_add');
  await a.c.next('you');
  host.send({ t: 'approve', id: req.id, count: 2 });
  const { you } = await a.c.next('you');
  assert.deepEqual({ name: you.name, pending: you.pending, rejected: you.rejected }, { name: 'たろう', pending: null, rejected: false });
  assert.deepEqual(you.cards.map((c) => c.no), [1, 2]);
  for (const card of you.cards) {
    assert.equal(card.numbers.length, 25);
    assert.equal(card.numbers[12], 0);
    assert.equal(new Set(card.numbers).size, 25);
  }
  assert.notDeepEqual(you.cards[0].numbers, you.cards[1].numbers);
  assert.deepEqual(await host.next('req_del'), { t: 'req_del', id: req.id });
  assert.deepEqual((await host.next('player')).player, { pid: req.pid, name: 'たろう', cards: 2, bingo: 0, reach: 0 });
  await b.c.none('you');
});

test('追加申請でカード番号が続く', async () => {
  const { c: host } = await fresh(server);
  const { c } = await joinPlayer(server);
  await grant(host, c, 'たろう', 2);
  const you = await grant(host, c, 'たろう', 2);
  assert.deepEqual(you.cards.map((x) => x.no), [1, 2, 3, 4]);
});

test('却下すると本人に伝わり、再申請できる', async () => {
  const { c: host } = await fresh(server);
  const { c } = await joinPlayer(server);
  c.send({ t: 'request', name: 'たろう', count: 1 });
  const { req } = await host.next('req_add');
  await c.next('you');
  host.send({ t: 'reject', id: req.id });
  assert.deepEqual((await c.next('you')).you, { name: 'たろう', blocked: false, pending: null, rejected: true, cards: [] });
  assert.deepEqual(await host.next('req_del'), { t: 'req_del', id: req.id });
  host.send({ t: 'reject', id: req.id });
  assert.equal((await host.next('error')).code, 'not_found');
  c.send({ t: 'request', name: 'たろう2', count: 2 });
  assert.deepEqual((await c.next('you')).you, { name: 'たろう2', blocked: false, pending: 2, rejected: false, cards: [] });
});

test('取り消し', async () => {
  const { c: host } = await fresh(server);
  const { c } = await joinPlayer(server);
  c.send({ t: 'cancel' });
  assert.equal((await c.next('error')).code, 'no_pending');
  c.send({ t: 'request', name: 'たろう', count: 1 });
  const { req } = await host.next('req_add');
  await c.next('you');
  c.send({ t: 'cancel' });
  assert.deepEqual((await c.next('you')).you, { name: 'たろう', blocked: false, pending: null, rejected: false, cards: [] });
  assert.deepEqual(await host.next('req_del'), { t: 'req_del', id: req.id });
});

test('申請中にできる申請は1人1件', async () => {
  const { c: host } = await fresh(server);
  const { c } = await joinPlayer(server);
  c.send({ t: 'request', name: 'たろう', count: 1 });
  await host.next('req_add');
  c.send({ t: 'request', name: 'たろう', count: 2 });
  assert.equal((await c.next('error')).code, 'already_pending');
  await host.none('req_add');
});

test('名前と枚数の検証', async () => {
  const { c: host } = await fresh(server);
  const { c } = await joinPlayer(server);
  for (const name of ['   ', '', 'あ'.repeat(21), 123, null, undefined]) {
    c.send({ t: 'request', name, count: 1 });
    assert.equal((await c.next('error')).code, 'bad_name', String(name));
  }
  for (const count of [0, 51, 2.5, -1, 1e9, '3', null, undefined]) {
    c.send({ t: 'request', name: 'たろう', count });
    assert.equal((await c.next('error')).code, 'bad_count', String(count));
  }
  await host.none('req_add');
});

test('カードを持ったら名前は変わらない', async () => {
  const { c: host } = await fresh(server);
  const { c } = await joinPlayer(server);
  await grant(host, c, 'たろう', 1);
  c.send({ t: 'request', name: 'べつじん', count: 1 });
  assert.equal((await host.next('req_add')).req.name, 'たろう');
  assert.equal((await c.next('you')).you.name, 'たろう');
});

test('同じ申請を2回許可しても配るのは1回', async () => {
  const { c: host } = await fresh(server);
  const { c, token } = await joinPlayer(server);
  c.send({ t: 'request', name: 'たろう', count: 2 });
  const { req } = await host.next('req_add');
  host.send({ t: 'approve', id: req.id, count: 2 });
  host.send({ t: 'approve', id: req.id, count: 2 });
  assert.equal((await host.next('error')).code, 'not_found');
  const again = await joinPlayer(server, token);
  assert.equal(again.state.you.cards.length, 2);
});

test('取り消し済み・存在しない申請は許可できない', async () => {
  const { c: host } = await fresh(server);
  const { c } = await joinPlayer(server);
  c.send({ t: 'request', name: 'たろう', count: 2 });
  const { req } = await host.next('req_add');
  c.send({ t: 'cancel' });
  await host.next('req_del');
  host.send({ t: 'approve', id: req.id, count: 2 });
  assert.equal((await host.next('error')).code, 'not_found');
  for (const id of [999999, 'x', null, 1.5]) {
    host.send({ t: 'approve', id, count: 1 });
    assert.equal((await host.next('error')).code, 'not_found', String(id));
  }
});

test('許可の枚数の検証', async () => {
  const { c: host } = await fresh(server);
  const { c } = await joinPlayer(server);
  c.send({ t: 'request', name: 'たろう', count: 2 });
  const { req } = await host.next('req_add');
  for (const count of [0, 51, '2', undefined]) {
    host.send({ t: 'approve', id: req.id, count });
    assert.equal((await host.next('error')).code, 'bad_count', String(count));
  }
  host.send({ t: 'approve', id: req.id, count: 50 });
  await host.next('req_del');
});

test('すべて許可', async () => {
  const { c: host } = await fresh(server);
  const people = [];
  for (const [name, count] of [['A', 1], ['B', 2], ['C', 3]]) {
    const p = await joinPlayer(server);
    p.c.send({ t: 'request', name, count });
    await host.next('req_add');
    await p.c.next('you');
    people.push({ ...p, name, count });
  }
  host.send({ t: 'approve_all' });
  const snap = await host.next('host');
  assert.deepEqual(snap.requests, []);
  assert.deepEqual(snap.players.map((p) => [p.name, p.cards]), [['A', 1], ['B', 2], ['C', 3]]);
  for (const p of people) assert.equal((await p.c.next('you')).you.cards.length, p.count);
});

test('部屋全体のカードの上限と、申請中の上限', async () => {
  const s2 = await startServer({ vars: { CARDS_MAX: 5, PENDING_MAX: 2 } });
  try {
    const { c: host } = await fresh(s2);
    const a = await joinPlayer(s2);
    const b = await joinPlayer(s2);
    const c = await joinPlayer(s2);
    a.c.send({ t: 'request', name: 'A', count: 3 });
    await host.next('req_add');
    await a.c.next('you');
    b.c.send({ t: 'request', name: 'B', count: 3 });
    const { req: reqB } = await host.next('req_add');
    await b.c.next('you');
    c.c.send({ t: 'request', name: 'C', count: 1 });
    assert.equal((await c.c.next('error')).code, 'busy');

    host.send({ t: 'approve_all' });
    const snap = await host.next('host');
    assert.deepEqual(snap.players.map((p) => [p.name, p.cards]), [['A', 3]]);
    assert.deepEqual(snap.requests.map((r) => r.name), ['B']);
    assert.equal((await a.c.next('you')).you.cards.length, 3);
    await b.c.none('you');

    host.send({ t: 'approve', id: reqB.id, count: 3 });
    assert.equal((await host.next('error')).code, 'cards_full');
    host.send({ t: 'approve', id: reqB.id, count: 2 });
    assert.equal((await b.c.next('you')).you.cards.length, 2);
  } finally {
    closeAll();
    await s2.stop();
  }
});

test('同じ人が2つのタブを開いても、同じカードが届き、申請は1件', async () => {
  const { c: host } = await fresh(server);
  const tab1 = await joinPlayer(server);
  const tab2 = await joinPlayer(server, tab1.token);
  tab1.c.send({ t: 'request', name: 'たろう', count: 2 });
  const { req } = await host.next('req_add');
  assert.equal((await tab1.c.next('you')).you.pending, 2);
  assert.equal((await tab2.c.next('you')).you.pending, 2);
  tab2.c.send({ t: 'request', name: 'たろう', count: 1 });
  assert.equal((await tab2.c.next('error')).code, 'already_pending');
  host.send({ t: 'approve', id: req.id, count: 2 });
  const y1 = (await tab1.c.next('you')).you;
  const y2 = (await tab2.c.next('you')).you;
  assert.equal(y1.cards.length, 2);
  assert.deepEqual(y1, y2);
});

test('delay の設定は全員に届く', async () => {
  const { c: host } = await fresh(server);
  const { c } = await joinPlayer(server);
  host.send({ t: 'delay', sec: 5 });
  assert.deepEqual(await c.next('delay'), { t: 'delay', sec: 5 });
  assert.equal((await host.next('host')).delay, 5);
  for (const sec of [4, -1, '5', null]) {
    host.send({ t: 'delay', sec });
    assert.equal((await host.next('error')).code, 'bad_delay', String(sec));
  }
  assert.equal((await joinPlayer(server)).state.delay, 5);
});
