// サーバーのテスト。node --test test/room.test.mjs で実行(ローカルの wrangler dev を起動する)。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCard } from '../public/logic.mjs';
import {
  HOST_PASSWORD, startServer, Client, closeAll, joinPlayer, joinHost, fresh, grant, lineNumbers, findTie,
} from './helpers.mjs';

let server;
before(async () => { server = await startServer(); });
after(async () => {
  closeAll();
  await server?.stop();
  // サーバー側で捕まえられなかった例外が出ていないこと
  assert.doesNotMatch(server.log(), /Uncaught|\[ERROR\]/);
});
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

// ---- 番号の発表とビンゴ ----

// 主催者が番号を発表し、リスナー c に届いた draw を返す。主催者に届く host も受け取っておく。
async function call(host, c, n) {
  host.send({ t: 'call', n });
  const d = await c.next('draw');
  await host.next('host');
  return d;
}

test('call が全員に届く', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  const b = await joinPlayer(server);
  host.send({ t: 'call', n: 7 });
  assert.deepEqual(await a.c.next('draw'), { t: 'draw', n: 7, seq: 1, winners: [] });
  assert.deepEqual(await b.c.next('draw'), { t: 'draw', n: 7, seq: 1, winners: [] });
  assert.deepEqual((await host.next('host')).draws, [7]);
  host.send({ t: 'call', n: 70 });
  assert.deepEqual(await a.c.next('draw'), { t: 'draw', n: 70, seq: 2, winners: [] });
  assert.deepEqual((await joinPlayer(server)).state.draws, [7, 70]);
});

test('同じ番号は二重に出ない', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  await call(host, a.c, 7);
  host.send({ t: 'call', n: 7 });
  assert.equal((await host.next('error')).code, 'already_called');
  await a.c.none('draw');
});

test('番号の検証', async () => {
  const { c: host } = await fresh(server);
  for (const n of [0, 76, 1.5, 'x', null, undefined, -3]) {
    host.send({ t: 'call', n });
    assert.equal((await host.next('error')).code, 'bad_number', String(n));
  }
  assert.deepEqual((await joinPlayer(server)).state.draws, []);
});

test('draw はまだ出ていない番号を選び、75個出たら all_called', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  const seen = new Set();
  for (let i = 1; i <= 75; i++) {
    host.send({ t: 'draw' });
    const d = await a.c.next('draw');
    assert.equal(d.seq, i);
    assert.ok(Number.isInteger(d.n) && d.n >= 1 && d.n <= 75 && !seen.has(d.n));
    seen.add(d.n);
  }
  host.send({ t: 'draw' });
  assert.equal((await host.next('error')).code, 'all_called');
});

test('ビンゴの検出と順位', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  const b = await joinPlayer(server);
  const ya = await grant(host, a.c, 'A', 1);
  const yb = await grant(host, b.c, 'B', 1);
  const rowA = lineNumbers(ya.cards[0].numbers, 0);
  assert.equal(rowA.length, 5);
  for (const n of rowA.slice(0, 4)) assert.deepEqual((await call(host, a.c, n)).winners, []);
  const d = await call(host, a.c, rowA[4]);
  assert.deepEqual(d.winners, [{ rank: 1, name: 'A', no: 1, at: 5 }]);
  // B にも同じ5通が届いている(最後の1通に A のビンゴが入っている)
  for (let i = 0; i < 4; i++) assert.deepEqual((await b.c.next('draw')).winners, []);
  assert.deepEqual((await b.c.next('draw')).winners, [{ rank: 1, name: 'A', no: 1, at: 5 }]);

  const called = new Set(rowA);
  let last;
  for (const n of lineNumbers(yb.cards[0].numbers, 0)) {
    if (called.has(n)) continue;
    last = await call(host, b.c, n);
  }
  assert.deepEqual(last.winners, [{ rank: 2, name: 'B', no: 1, at: last.seq }]);
  const again = await joinPlayer(server);
  assert.deepEqual(again.state.winners, [
    { rank: 1, name: 'A', no: 1, at: 5 }, { rank: 2, name: 'B', no: 1, at: last.seq },
  ]);
});

test('同じ番号で同時にそろったカードは同順位', async () => {
  let host; let a; let c3; let tie; let yc;
  for (let i = 0; i < 20 && !tie; i++) {
    closeAll();
    ({ c: host } = await fresh(server));
    a = await joinPlayer(server);
    const b = await joinPlayer(server);
    c3 = await joinPlayer(server);
    const ya = await grant(host, a.c, 'A', 1);
    const yb = await grant(host, b.c, 'B', 1);
    yc = await grant(host, c3.c, 'C', 1);
    const t = findTie(ya.cards[0].numbers, yb.cards[0].numbers);
    // 3人目のカードが途中でそろってしまう組は使わない
    if (t && analyzeCard(yc.cards[0].numbers, new Set([...t.pre, t.last])).lines === 0) tie = t;
  }
  assert.ok(tie, '同時にそろう組が作れませんでした');
  for (const n of tie.pre) assert.deepEqual((await call(host, a.c, n)).winners, []);
  const d = await call(host, a.c, tie.last);
  assert.deepEqual(d.winners.map((w) => [w.rank, w.name, w.at]), [[1, 'A', d.seq], [1, 'B', d.seq]]);

  const called = new Set([...tie.pre, tie.last]);
  let third;
  for (const n of lineNumbers(yc.cards[0].numbers, 0)) {
    if (called.has(n)) continue;
    const dd = await call(host, a.c, n);
    third = dd.winners.find((w) => w.name === 'C') ?? third;
  }
  assert.equal(third.rank, 3);
});

test('主催者の集計: リーチとビンゴの枚数', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  const ya = await grant(host, a.c, 'A', 2);
  const row = lineNumbers(ya.cards[0].numbers, 0);
  host.drain();
  let snap;
  for (const n of row.slice(0, 4)) { host.send({ t: 'call', n }); snap = await host.next('host'); }
  const reachCards = ya.cards.filter((c) => {
    const an = analyzeCard(c.numbers, new Set(row.slice(0, 4)));
    return an.lines === 0 && an.reach > 0;
  }).length;
  assert.ok(reachCards >= 1);
  assert.deepEqual(snap.players, [{ pid: ya.pid, name: 'A', cards: 2, bingo: 0, reach: reachCards }]);
  host.send({ t: 'call', n: row[4] });
  snap = await host.next('host');
  assert.equal(snap.players[0].bingo >= 1, true);
  assert.deepEqual(snap.winners[0], { rank: 1, name: 'A', no: 1, at: 5 });
});

test('undo: 最後の番号から順に戻り、その番号のビンゴも消える', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  host.send({ t: 'undo' });
  assert.equal((await host.next('error')).code, 'nothing_to_undo');
  const ya = await grant(host, a.c, 'A', 1);
  const row = lineNumbers(ya.cards[0].numbers, 0);
  for (const n of row) await call(host, a.c, n);
  host.drain();
  host.send({ t: 'undo' });
  assert.deepEqual(await a.c.next('undo'), { t: 'undo', seq: 5 });
  let snap = await host.next('host');
  assert.deepEqual(snap.draws, row.slice(0, 4));
  assert.deepEqual(snap.winners, []);
  host.send({ t: 'undo' });
  assert.deepEqual(await a.c.next('undo'), { t: 'undo', seq: 4 });
  snap = await host.next('host');
  assert.deepEqual(snap.draws, row.slice(0, 3));
  assert.deepEqual((await joinPlayer(server)).state.winners, []);
});

test('undo のあと同じ番号を出せる', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  await call(host, a.c, 10);
  await call(host, a.c, 20);
  host.send({ t: 'undo' });
  await a.c.next('undo');
  assert.deepEqual(await call(host, a.c, 20), { t: 'draw', n: 20, seq: 2, winners: [] });
});

test('途中で配ったカードには発表済みの番号が効き、配った時点でそろっていればビンゴ', async () => {
  const { c: host } = await fresh(server);
  const watcher = await joinPlayer(server);
  for (let i = 0; i < 75; i++) host.send({ t: 'draw' });
  for (let i = 0; i < 75; i++) await watcher.c.next('draw');
  for (let i = 0; i < 75; i++) await host.next('host');
  const late = await joinPlayer(server);
  assert.equal(late.state.draws.length, 75);
  const you = await grant(host, late.c, 'おそい', 1);
  assert.equal(you.cards.length, 1);
  assert.deepEqual(await watcher.c.next('winners'), { t: 'winners', winners: [{ rank: 1, name: 'おそい', no: 1, at: 75 }] });
  assert.deepEqual((await host.next('host')).winners, [{ rank: 1, name: 'おそい', no: 1, at: 75 }]);
});

test('lastAge: 最後の番号が発表されてからの経過ミリ秒', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  assert.equal(a.state.lastAge, null);
  await call(host, a.c, 33);
  const { state } = await joinPlayer(server);
  assert.ok(typeof state.lastAge === 'number' && state.lastAge >= 0 && state.lastAge < 2000, String(state.lastAge));
  await new Promise((r) => setTimeout(r, 600));
  const later = (await joinPlayer(server)).state.lastAge;
  assert.ok(later >= 500 && later < 3000, String(later));
});

test('hello を送り直しても同じ状態が返る', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  await grant(host, a.c, 'A', 2);
  await call(host, a.c, 5);
  a.c.send({ t: 'hello', token: a.token });
  const s1 = await a.c.next('state');
  a.c.send({ t: 'hello', token: a.token });
  const s2 = await a.c.next('state');
  assert.deepEqual({ ...s1, lastAge: 0 }, { ...s2, lastAge: 0 });
  assert.deepEqual(s1.draws, [5]);
  assert.equal(s1.you.cards.length, 2);
  // 送り直しても、発表は1回ずつしか届かない
  const d = await call(host, a.c, 6);
  assert.equal(d.seq, 2);
  await a.c.none('draw');
});

// ---- ブロック・リセット ----

test('ブロック: カードが消え、ビンゴ一覧からも外れ、以後は申請できない', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  const b = await joinPlayer(server);
  const ya = await grant(host, a.c, 'A', 1);
  await grant(host, b.c, 'B', 1);
  for (const n of lineNumbers(ya.cards[0].numbers, 0)) await call(host, a.c, n);
  a.c.drain(); b.c.drain(); host.drain();

  host.send({ t: 'block', pid: ya.pid });
  const { you } = await a.c.next('you');
  assert.deepEqual({ blocked: you.blocked, cards: you.cards, pending: you.pending }, { blocked: true, cards: [], pending: null });
  assert.deepEqual(await b.c.next('winners'), { t: 'winners', winners: [] });
  const snap = await host.next('host');
  assert.deepEqual(snap.players.map((p) => p.name), ['B']);
  assert.deepEqual(snap.blocked, [{ pid: ya.pid, name: 'A' }]);
  assert.deepEqual(snap.winners, []);

  a.c.send({ t: 'request', name: 'A', count: 1 });
  assert.equal((await a.c.next('error')).code, 'blocked');
  assert.equal((await joinPlayer(server, a.token)).state.you.blocked, true);
});

test('申請中だけの人もブロックできる', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  a.c.send({ t: 'request', name: 'あらし', count: 50 });
  const { req } = await host.next('req_add');
  await a.c.next('you');
  host.send({ t: 'block', pid: req.pid });
  const snap = await host.next('host');
  assert.deepEqual(snap.requests, []);
  assert.deepEqual(snap.blocked, [{ pid: req.pid, name: 'あらし' }]);
  const { you } = await a.c.next('you');
  assert.deepEqual({ blocked: you.blocked, pending: you.pending }, { blocked: true, pending: null });
});

test('ブロック解除: カードは戻らないが、再申請できる', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  const ya = await grant(host, a.c, 'A', 2);
  host.send({ t: 'block', pid: ya.pid });
  await a.c.next('you');
  await host.next('host');
  host.send({ t: 'unblock', pid: ya.pid });
  const { you } = await a.c.next('you');
  assert.deepEqual({ blocked: you.blocked, cards: you.cards }, { blocked: false, cards: [] });
  assert.deepEqual((await host.next('host')).blocked, []);
  a.c.send({ t: 'request', name: 'A', count: 1 });
  assert.equal((await host.next('req_add')).req.count, 1);
});

test('存在しない人のブロック・解除は not_found', async () => {
  const { c: host } = await fresh(server);
  for (const m of [{ t: 'block', pid: 99999 }, { t: 'block', pid: 'x' }, { t: 'block' }, { t: 'unblock', pid: 99999 }]) {
    host.send(m);
    assert.equal((await host.next('error')).code, 'not_found', JSON.stringify(m));
  }
});

test('次のゲーム: 番号とビンゴだけ消え、カードと申請は残る', async () => {
  const { c: host } = await fresh(server);
  const a = await joinPlayer(server);
  const b = await joinPlayer(server);
  const ya = await grant(host, a.c, 'A', 2);
  for (const n of lineNumbers(ya.cards[0].numbers, 0)) await call(host, a.c, n);
  b.c.send({ t: 'request', name: 'B', count: 1 });
  await host.next('req_add');
  a.c.drain(); host.drain();

  host.send({ t: 'new_round' });
  assert.deepEqual(await a.c.next('round'), { t: 'round' });
  const snap = await host.next('host');
  assert.deepEqual([snap.draws, snap.winners], [[], []]);
  assert.deepEqual(snap.players, [{ pid: ya.pid, name: 'A', cards: 2, bingo: 0, reach: 0 }]);
  assert.deepEqual(snap.requests.map((r) => r.name), ['B']);

  const again = await joinPlayer(server, a.token);
  assert.deepEqual(again.state.you.cards, ya.cards);
  assert.deepEqual([again.state.draws, again.state.winners, again.state.lastAge], [[], [], null]);
  assert.equal((await call(host, a.c, 1)).seq, 1);
});

test('すべてリセット: 全員が未申請に戻り、同じ接続のまま申請し直せる', async () => {
  const { c: host } = await fresh(server);
  host.send({ t: 'delay', sec: 3 });
  await host.next('host');
  const a = await joinPlayer(server);
  const b = await joinPlayer(server);
  const ya = await grant(host, a.c, 'A', 2);
  await call(host, a.c, 9);
  b.c.send({ t: 'request', name: 'B', count: 1 });
  await host.next('req_add');
  host.send({ t: 'block', pid: ya.pid });
  await host.next('host');
  a.c.drain(); b.c.drain(); host.drain();

  host.send({ t: 'reset_all' });
  assert.deepEqual(await a.c.next('reset'), { t: 'reset' });
  assert.deepEqual(await b.c.next('reset'), { t: 'reset' });
  assert.deepEqual(await host.next('host'), { t: 'host', accepting: true, delay: 3, ...EMPTY_HOST });
  assert.deepEqual((await joinPlayer(server, a.token)).state, {
    t: 'state', accepting: true, delay: 3, draws: [], lastAge: null, winners: [], you: EMPTY_YOU,
  });
  a.c.send({ t: 'request', name: 'A2', count: 1 });
  assert.equal((await host.next('req_add')).req.name, 'A2');
  assert.equal((await a.c.next('you')).you.pending, 1);
});

// ---- 壊れた入力・負荷・再起動 ----

test('壊れた入力でもサーバーは動き続ける', async () => {
  const { c: host } = await fresh(server);
  const bad = await joinPlayer(server);
  const good = await joinPlayer(server);
  for (const raw of ['not json', '[]', '{"t":5}', '"hello"', 'null', '{"t":"unknown"}', '{}']) {
    bad.c.sendRaw(raw);
    assert.equal((await bad.c.next('error')).code, 'bad_message', raw);
  }
  assert.equal((await call(host, good.c, 12)).n, 12);
  assert.equal((await bad.c.next('draw')).n, 12);
});

test('大きすぎるメッセージを送る接続は閉じられ、他の接続は生きている', async () => {
  const { c: host } = await fresh(server);
  const bad = await joinPlayer(server);
  const good = await joinPlayer(server);
  bad.c.send({ t: 'request', name: 'x'.repeat(3000), count: 1 });
  await bad.c.closed();
  assert.equal((await call(host, good.c, 12)).n, 12);
});

test('短時間に送りすぎる接続は閉じられる(主催者は対象外)', async () => {
  const { c: host } = await fresh(server);
  const bad = await joinPlayer(server);
  const good = await joinPlayer(server);
  for (let i = 0; i < 40; i++) bad.c.send({ t: 'cancel' });
  await bad.c.closed();
  // 主催者は75個続けて引ける
  for (let i = 0; i < 75; i++) host.send({ t: 'draw' });
  for (let i = 0; i < 75; i++) await good.c.next('draw');
});

test('サーバーを起動し直しても、カード・番号・申請が残っている', async () => {
  const s1 = await startServer();
  let s2;
  try {
    const { c: host } = await fresh(s1);
    const a = await joinPlayer(s1);
    const b = await joinPlayer(s1);
    const ya = await grant(host, a.c, 'A', 3);
    const row = lineNumbers(ya.cards[0].numbers, 0);
    for (const n of row) await call(host, a.c, n);
    b.c.send({ t: 'request', name: 'B', count: 2 });
    await host.next('req_add');
    closeAll();
    await s1.stop();

    s2 = await startServer({ persistTo: s1.persistTo });
    const a2 = await joinPlayer(s2, a.token);
    assert.deepEqual(a2.state.you.cards, ya.cards);
    assert.deepEqual(a2.state.draws, row);
    assert.deepEqual(a2.state.winners, [{ rank: 1, name: 'A', no: 1, at: 5 }]);
    assert.equal((await joinPlayer(s2, b.token)).state.you.pending, 2);
    const h2 = await joinHost(s2);
    assert.equal(h2.snap.accepting, true);
    assert.deepEqual(h2.snap.requests.map((r) => [r.name, r.count]), [['B', 2]]);
    assert.deepEqual(h2.snap.players.map((p) => [p.name, p.cards]), [['A', 3]]);
    h2.c.send({ t: 'draw' });
    assert.equal((await a2.c.next('draw')).seq, 6);
  } finally {
    closeAll();
    await s1.stop();
    await s2?.stop();
  }
});

test('200人がつながっていても、発表が全員に3秒以内に届く', async () => {
  const { c: host } = await fresh(server);
  const players = await Promise.all(Array.from({ length: 200 }, () => joinPlayer(server)));
  host.send({ t: 'call', n: 42 });
  const draws = await Promise.all(players.map((p) => p.c.next('draw', 3000)));
  assert.equal(draws.length, 200);
  for (const d of draws) assert.deepEqual(d, { t: 'draw', n: 42, seq: 1, winners: [] });
});
