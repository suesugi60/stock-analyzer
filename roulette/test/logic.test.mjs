// カジノ式ルーレットのロジック(純粋関数)のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLogic, seeded } from './helpers.mjs';

const L = loadLogic();
const S = L.SPOT;
/** いつも同じ数字が出る乱数(planSpin の最初の 1 回が数字を決める)。 */
const rngFor = (n) => { let first = true; const rest = seeded(n + 1); return () => { if (first) { first = false; return (n + 0.5) / 37; } return rest(); }; };
const bet = (st, uid, spot, amount) => {
  const patch = L.applyOp(st, uid, L.decodeOp(L.encodeOp(st.round, spot, amount)));
  assert.ok(patch, `賭けが受け付けられる(${uid} ${spot} ${amount})`);
  return L.applyPatch(st, patch);
};

test('盤: 0〜36 が 1 回ずつ並び、赤 18・黒 18・みどり(0)1', () => {
  assert.equal(L.WHEEL.length, 37);
  assert.deepEqual([...L.WHEEL].sort((a, b) => a - b), Array.from({ length: 37 }, (_, i) => i));
  const colors = L.WHEEL.map(L.colorOf);
  assert.equal(colors.filter((c) => c === 'red').length, 18);
  assert.equal(colors.filter((c) => c === 'black').length, 18);
  assert.equal(L.colorOf(0), 'green');
  assert.equal(L.colorOf(1), 'red');
  assert.equal(L.colorOf(2), 'black');
  assert.equal(L.colorOf(36), 'red');
  // 0 の両どなりは 26 と 32(本物の盤と同じ並び)
  assert.equal(L.WHEEL[0], 0);
  assert.equal(L.WHEEL[1], 32);
  assert.equal(L.WHEEL[36], 26);
});

test('当たり判定: 数字・赤黒・奇数偶数・前半後半・1〜12 など・たて1列', () => {
  assert.equal(L.spotWins(17, 17), true);
  assert.equal(L.spotWins(17, 18), false);
  assert.equal(L.spotWins(S.RED, 1), true);
  assert.equal(L.spotWins(S.RED, 2), false);
  assert.equal(L.spotWins(S.BLACK, 2), true);
  assert.equal(L.spotWins(S.ODD, 35), true);
  assert.equal(L.spotWins(S.EVEN, 36), true);
  assert.equal(L.spotWins(S.LOW, 18), true);
  assert.equal(L.spotWins(S.LOW, 19), false);
  assert.equal(L.spotWins(S.HIGH, 19), true);
  assert.equal(L.spotWins(S.DOZEN, 12), true);
  assert.equal(L.spotWins(S.DOZEN + 1, 13), true);
  assert.equal(L.spotWins(S.DOZEN + 2, 36), true);
  assert.equal(L.spotWins(S.DOZEN + 2, 24), false);
  assert.equal(L.spotWins(S.COLUMN, 34), true);     // 1,4,7,…,34
  assert.equal(L.spotWins(S.COLUMN + 1, 35), true); // 2,5,8,…,35
  assert.equal(L.spotWins(S.COLUMN + 2, 36), true); // 3,6,9,…,36
  assert.equal(L.spotWins(S.COLUMN + 2, 34), false);
});

test('当たり判定: 0 が出たら、数字の 0 に賭けた人だけが当たり', () => {
  for (let spot = 0; spot < L.SPOT_COUNT; spot++) assert.equal(L.spotWins(spot, 0), spot === 0, `spot ${spot}`);
});

test('当たり判定: どの数字が出ても、当たる場所の数は決まっている(2択 3 つ・3択 2 つ・数字 1 つ)', () => {
  for (let n = 1; n <= 36; n++) {
    const hits = [];
    for (let spot = 0; spot < L.SPOT_COUNT; spot++) if (L.spotWins(spot, n)) hits.push(spot);
    assert.equal(hits.length, 6, `n=${n}: ${hits}`);
    assert.equal(hits.filter((s) => L.spotPays(s) === 2).length, 3);
    assert.equal(hits.filter((s) => L.spotPays(s) === 3).length, 2);
    assert.equal(hits.filter((s) => L.spotPays(s) === 36).length, 1);
  }
});

test('倍率: 数字 36倍・3択 3倍・2択 2倍(本物と同じで、0 があるぶんだけ配信者が少し有利)', () => {
  assert.equal(L.spotPays(0), 36);
  assert.equal(L.spotPays(36), 36);
  assert.equal(L.spotPays(S.RED), 2);
  assert.equal(L.spotPays(S.HIGH), 2);
  assert.equal(L.spotPays(S.DOZEN), 3);
  assert.equal(L.spotPays(S.COLUMN + 2), 3);
  // どこに賭けても、37 回に 1 回ぶんだけ戻りが少ない(期待値 36/37)
  for (let spot = 0; spot < L.SPOT_COUNT; spot++) {
    let back = 0;
    for (let n = 0; n <= 36; n++) if (L.spotWins(spot, n)) back += L.spotPays(spot);
    assert.equal(back, 36, `spot ${spot}`);
  }
});

test('describe / spotLabel: 画面に出す言葉', () => {
  assert.equal(L.describe(0), 'みどり');
  assert.equal(L.describe(17), '黒・奇数・1〜18');
  assert.equal(L.describe(36), '赤・偶数・19〜36');
  assert.equal(L.spotLabel(5), '5');
  assert.equal(L.spotLabel(S.RED), '赤');
  assert.equal(L.spotLabel(S.DOZEN + 1), '13〜24');
  assert.equal(L.spotLabel(S.COLUMN + 2), 'たて3列目');
});

test('合図の詰め方: 回戦・種類・チップ数を 1 つの数にして、元に戻せる', () => {
  for (const [round, code, amount] of [[1, 0, 10], [7, 36, 500], [123, S.RED, 9999990], [99999, L.OP.CLEAR, 0], [100003, L.OP.REBUY, 0], [42, 48, 10]]) {
    const at = L.encodeOp(round, code, amount);
    assert.ok(Number.isSafeInteger(at), `安全に送れる整数: ${at}`);
    assert.deepEqual(L.decodeOp(at), { round: round % 100000, code, amount });
  }
});

test('合図の詰め方: おかしな数は捨てる', () => {
  assert.equal(L.decodeOp(-1), null);
  assert.equal(L.decodeOp(1.5), null);
  assert.equal(L.decodeOp(NaN), null);
  assert.equal(L.decodeOp('123'), null);
  assert.equal(L.decodeOp(Number.MAX_SAFE_INTEGER), null);
  assert.equal(L.decodeOp(L.encodeOp(1, 49, 10)), null, '無い場所');
  assert.equal(L.decodeOp(L.encodeOp(1, 89, 10)), null);
  // ふつうの時刻(いまの時刻の数)が来ても、賭けとしては通らない(回戦が合わない)
  const st = L.createState();
  assert.equal(L.applyOp(st, 'u1', L.decodeOp(1763500000000)), null);
});

test('賭ける: 最初は 1000 チップ。賭けた分だけ減り、同じ場所に重ねると足される', () => {
  let st = L.createState();
  assert.equal(L.chipsOf(st, 'u1'), 1000);
  st = bet(st, 'u1', S.RED, 100);
  st = bet(st, 'u1', S.RED, 50);
  st = bet(st, 'u1', 17, 10);
  assert.equal(L.chipsOf(st, 'u1'), 840);
  assert.deepEqual(L.betsOf(st, 'u1'), { [S.RED]: 150, 17: 10 });
  assert.equal(L.stakeOf(st, 'u1'), 160);
  assert.equal(L.chipsOf(st, 'u2'), 1000, 'ほかの人には影響しない');
  const t = L.totals(bet(st, 'u2', S.RED, 500));
  assert.deepEqual(t.bySpot[S.RED], { sum: 650, count: 2 });
  assert.equal(t.total, 660);
  assert.equal(t.players, 2);
});

test('賭ける: 持っている以上・10 未満・10 の倍数でない・ちがう回戦・締め切り後は受け付けない', () => {
  const st = L.createState();
  const op = (round, code, amount) => L.decodeOp(L.encodeOp(round, code, amount));
  assert.equal(L.applyOp(st, 'u1', op(1, S.RED, 1010)), null);
  assert.equal(L.applyOp(st, 'u1', op(1, S.RED, 5)), null);
  assert.equal(L.applyOp(st, 'u1', op(1, S.RED, 15)), null);
  assert.equal(L.applyOp(st, 'u1', op(1, S.RED, 0)), null);
  assert.equal(L.applyOp(st, 'u1', op(2, S.RED, 10)), null);
  assert.ok(L.applyOp(st, 'u1', op(1, S.RED, 1000)), '全部賭けるのはできる');
  const done = L.spin(st, rngFor(5));
  assert.equal(L.applyOp(done, 'u1', op(1, S.RED, 10)), null, '締め切り後');
  assert.equal(L.applyOp(st, 'u1', null), null);
});

test('取り消す: 置いた賭けが全部戻る。置いていなければ何もしない', () => {
  let st = bet(bet(L.createState(), 'u1', 7, 50), 'u1', S.ODD, 100);
  const clear = L.decodeOp(L.encodeOp(1, L.OP.CLEAR));
  st = L.applyPatch(st, L.applyOp(st, 'u1', clear));
  assert.equal(L.chipsOf(st, 'u1'), 1000);
  assert.deepEqual(L.betsOf(st, 'u1'), {});
  assert.equal(L.applyOp(st, 'u1', clear), null);
});

test('精算: 当たった場所は倍率ぶん戻り、はずれた分は消える', () => {
  const bets = { a: { 17: 10, [S.BLACK]: 100, [S.RED]: 50 }, b: { [S.DOZEN]: 30 }, c: { 0: 10 } };
  const r = L.settle(bets, 17); // 17 は黒・奇数・1〜18・13〜24・たて2列目
  assert.deepEqual(r.a, { stake: 160, payout: 10 * 36 + 100 * 2, net: 400, hits: [17, S.BLACK] });
  assert.deepEqual(r.b, { stake: 30, payout: 0, net: -30, hits: [] });
  assert.deepEqual(r.c, { stake: 10, payout: 0, net: -10, hits: [] });
  assert.equal(L.settle(bets, 0).c.net, 350);
  assert.equal(L.settle(bets, 0).a.net, -160);
});

test('回す: 出た数字・精算後のチップ・出目の記録・配信者の収支が 1 回で決まる', () => {
  let st = L.createState();
  st = bet(st, 'a', 17, 10);
  st = bet(st, 'a', S.RED, 100);
  st = bet(st, 'b', S.BLACK, 200);
  const done = L.spin(st, rngFor(17));
  assert.equal(done.phase, 'done');
  assert.equal(done.spin.n, 17);
  assert.equal(done.spin.id, 1);
  assert.equal(L.chipsOf(done, 'a'), 1000 - 110 + 360);
  assert.equal(L.chipsOf(done, 'b'), 1000 - 200 + 400);
  assert.equal(L.chipsOf(done, 'c'), 1000, '賭けていない人は変わらない');
  assert.deepEqual(done.history, [17]);
  assert.equal(done.house, (110 - 360) + (200 - 400), '配信者の収支 = 集めた分 − 払った分');
  assert.deepEqual(L.results(done).a, { stake: 110, payout: 360, net: 250, hits: [17] });
  assert.deepEqual(done.bets, st.bets, '結果を見せるあいだ、賭けは置いたまま');
  assert.equal(L.spin(done, rngFor(1)), null, '回っている・結果が出ているあいだは回せない');
  assert.equal(st.phase, 'bet', '元の state は書き換えない');
});

test('回す: チップの合計は「配信者の収支」と合わせていつも同じ(増えも減りもしない)', () => {
  const rng = seeded(21);
  let st = L.createState();
  const uids = ['a', 'b', 'c', 'd'];
  for (let round = 0; round < 60; round++) {
    for (const uid of uids) {
      for (let k = 0; k < 3; k++) {
        const spot = Math.floor(rng() * L.SPOT_COUNT);
        const amount = (1 + Math.floor(rng() * 5)) * 10;
        const patch = L.applyOp(st, uid, { round: st.round % 100000, code: spot, amount });
        if (patch) st = L.applyPatch(st, patch);
      }
    }
    st = L.spin(st, rng);
    const total = uids.reduce((s, u) => s + L.chipsOf(st, u), 0) + st.house;
    assert.equal(total, uids.length * L.START_CHIPS, `round ${round}`);
    st = L.nextRound(st);
    assert.deepEqual(st.bets, {});
  }
  assert.equal(st.round, 61);
  assert.equal(st.history.length, L.MAX_HISTORY);
});

test('次のゲーム: 賭けを片づけて回戦が進む。受付中に押しても何も起きない', () => {
  let st = bet(L.createState(), 'a', S.RED, 100);
  assert.equal(L.nextRound(st), st);
  st = L.nextRound(L.spin(st, rngFor(2)));
  assert.equal(st.phase, 'bet');
  assert.equal(st.round, 2);
  assert.deepEqual(st.bets, {});
  assert.equal(st.spin.n, 2, '前回の玉の位置は残す(盤の絵に使う)');
  // 前の回戦の合図は、もう通らない
  assert.equal(L.applyOp(st, 'a', L.decodeOp(L.encodeOp(1, S.RED, 10))), null);
});

test('おかわり: チップが尽きたときだけ 1000 に戻せて、回数が数えられる', () => {
  let st = bet(L.createState(), 'a', S.RED, 1000);
  const rebuy = (s) => L.applyOp(s, 'a', L.decodeOp(L.encodeOp(s.round, L.OP.REBUY)));
  assert.equal(L.isBroke(st, 'a'), false, 'テーブルに置いているあいだは、まだ尽きていない');
  assert.equal(rebuy(st), null);
  st = L.spin(st, rngFor(2)); // 2 は黒 → 全部なくなる
  assert.equal(L.chipsOf(st, 'a'), 0);
  assert.equal(L.isBroke(st, 'a'), true);
  st = L.applyPatch(st, rebuy(st)); // 結果が出ているあいだでも、おかわりできる
  assert.equal(L.chipsOf(st, 'a'), 1000);
  assert.equal(st.rebuys.a, 1);
  assert.equal(rebuy(st), null, 'チップがあるときはできない');
  assert.equal(rebuy(L.createState()), null);
});

test('盤と玉: 止まったとき、玉は必ず出た数字のマスにいる', () => {
  const rng = seeded(4);
  let prev = null;
  for (let k = 0; k < 400; k++) {
    const plan = L.planSpin(prev, rng);
    assert.ok(plan.n >= 0 && plan.n <= 36);
    const end = L.pose(plan, plan.ms);
    assert.equal(L.numberAt(end.rel), plan.n, `k=${k}`);
    assert.equal(end.r, L.R_REST);
    assert.equal(end.settled, true);
    assert.ok(Math.abs(L.mod(end.rel, 360) - L.pocketAngle(plan.n)) < 1e-6, 'マスのまん中');
    if (prev) assert.equal(plan.w0, L.mod(prev.w0 + prev.wd, 360), '盤は前回止まった角度から回り始める');
    prev = plan;
  }
});

test('盤と玉: 玉は外周から走り始め、逆回転せず、最後は盤と一緒に回る', () => {
  const plan = L.planSpin(null, seeded(9));
  const start = L.pose(plan, 0);
  assert.equal(start.r, L.R_TRACK);
  assert.equal(start.rel, plan.r0);
  assert.equal(start.wheel, plan.w0);
  let prevRel = -Infinity;
  let prevWheel = Infinity;
  for (let t = 0; t <= plan.ms; t += 40) {
    const p = L.pose(plan, t);
    assert.ok(p.rel >= prevRel - 1e-9, `玉は盤の上を時計回りにだけ進む t=${t}`);
    assert.ok(p.wheel <= prevWheel + 1e-9, `盤は反時計回りにだけ回る t=${t}`);
    assert.ok(p.r <= L.R_TRACK + 1e-9 && p.r >= L.R_REST - 1e-9, `玉は外周とマスの間にいる t=${t}`);
    prevRel = p.rel;
    prevWheel = p.wheel;
  }
  // 玉が収まったあとは、盤から見た位置が変わらない(盤と一緒に回る)
  const a = L.pose(plan, plan.ms - 800);
  const b = L.pose(plan, plan.ms - 100);
  assert.equal(a.settled, true);
  assert.equal(a.rel, b.rel);
  assert.notEqual(a.wheel, b.wheel);
  assert.equal(L.pose(plan, -50).rel, plan.r0);
  assert.equal(L.pose(plan, plan.ms + 9999).rel, L.pose(plan, plan.ms).rel);
});

test('出目のかたより: 0〜36 がほぼ同じ回数だけ出る', () => {
  const rng = seeded(77);
  const count = new Array(37).fill(0);
  const N = 37000;
  for (let i = 0; i < N; i++) count[L.planSpin(null, rng).n]++;
  for (let n = 0; n <= 36; n++) assert.ok(Math.abs(count[n] - 1000) < 150, `n=${n}: ${count[n]}`);
});

test('normalizeState: 保存した形から元に戻せて、壊れた入力でも安全な形になる', () => {
  let st = bet(bet(L.createState(), 'a', 17, 10), 'b', S.RED, 100);
  st = L.spin(st, rngFor(17));
  const saved = JSON.parse(JSON.stringify(L.serializeState(st)));
  assert.deepEqual(Object.keys(saved.bets.a), ['s17'], '数字だけのキーにしない(保存先で配列に化けるため)');
  assert.deepEqual(L.normalizeState(saved), st);

  const bad = L.normalizeState({ phase: 'x', round: -3, chips: { a: -5, b: 'many', c: 1.5, d: 20 }, bets: { a: { s99: 10, s5: -1, s6: 20, x: 3 }, b: 'no' }, spin: { id: 1, n: 37 }, history: [1, 99, 'a', 36], house: 'x' });
  assert.equal(bad.phase, 'bet');
  assert.equal(bad.round, 1);
  assert.deepEqual(bad.chips, { d: 20 });
  assert.deepEqual(bad.bets, { a: { 6: 20 } });
  assert.equal(bad.spin, null);
  assert.deepEqual(bad.history, [1, 36]);
  assert.equal(bad.house, 0);
  assert.equal(L.normalizeState(null).phase, 'bet');
  assert.deepEqual(L.normalizeState(undefined).bets, {});
  // おかしな回転(長すぎる時間・無限の角度)は捨てる
  const ok = { id: 1, n: 5, ms: 9000, w0: 0, wd: -700, r0: 10, bt: 10 };
  assert.deepEqual(L.normalizeState({ spin: ok }).spin, ok);
  assert.equal(L.normalizeState({ spin: { ...ok, ms: 1e9 } }).spin, null);
  assert.equal(L.normalizeState({ spin: { ...ok, wd: 'Infinity' } }).spin, null);
});

test('members / ranking: ブロックした人と名前の無い人は入らず、チップの多い順に並ぶ', () => {
  let st = L.createState();
  const players = {
    a: { name: 'あ', char: 'kappa', joinedAt: 1 }, b: { name: 'い', joinedAt: 2, hidden: true }, c: { name: 'う', joinedAt: 3, banned: true },
    d: { joinedAt: 4 }, e: { name: 'え', joinedAt: 5 },
  };
  st = bet(st, 'a', S.RED, 300);   // 受付中は、置いた分も数える → 1000
  st = bet(st, 'e', S.BLACK, 100);
  assert.deepEqual(L.members({ players }).map((m) => m.uid), ['a', 'b', 'e']);
  assert.deepEqual(L.ranking({ players, state: st }).map((m) => [m.uid, m.chips]), [['a', 1000], ['b', 1000], ['e', 1000]]);
  st = L.spin(st, rngFor(2)); // 黒 → a は 700、e は 1100
  const rank = L.ranking({ players, state: st });
  assert.deepEqual(rank.map((m) => [m.uid, m.chips]), [['e', 1100], ['b', 1000], ['a', 700]]);
  assert.equal(rank[1].hidden, true);
  assert.deepEqual(L.members(null), []);
});

test('チップの配り直し・部屋を閉じる', () => {
  let st = L.spin(bet(L.createState(), 'a', S.RED, 100), rngFor(2));
  st = L.resetChips(st);
  assert.equal(L.chipsOf(st, 'a'), 1000);
  assert.equal(st.house, 0);
  assert.deepEqual(st.bets, {});
  assert.equal(L.close(st).phase, 'closed');
});
