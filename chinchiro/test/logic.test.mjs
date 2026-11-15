import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLogic, seeded } from './helpers.mjs';

const L = loadLogic();
const pick = (h) => h && { type: h.type, value: h.value, mult: h.mult, lose: h.lose, label: h.label };

test('役判定: 全パターン', () => {
  assert.deepEqual(pick(L.evaluate([1, 1, 1])), { type: 'pinzoro', value: 1, mult: 5, lose: false, label: 'ピンゾロ' });
  assert.deepEqual(pick(L.evaluate([5, 5, 5])), { type: 'zoro', value: 5, mult: 3, lose: false, label: '5ゾロ' });
  assert.deepEqual(pick(L.evaluate([6, 4, 5])), { type: 'shigoro', value: 0, mult: 2, lose: false, label: 'シゴロ' });
  assert.deepEqual(pick(L.evaluate([3, 1, 2])), { type: 'hifumi', value: 0, mult: 1, lose: true, label: 'ヒフミ' });
  assert.deepEqual(pick(L.evaluate([2, 6, 2])), { type: 'me', value: 6, mult: 1, lose: false, label: '6の目' });
  assert.deepEqual(pick(L.evaluate([4, 4, 1])), { type: 'me', value: 1, mult: 1, lose: false, label: '1の目' });
  assert.equal(L.evaluate([1, 3, 5]), null);
  assert.equal(L.evaluate([2, 4, 6]), null);
  assert.throws(() => L.evaluate([0, 1, 2]));
  assert.throws(() => L.evaluate([1, 2]));
  assert.throws(() => L.evaluate(null));
});

test('役の強さ: ピンゾロ > 6ゾロ > 2ゾロ > シゴロ > 6の目 > 1の目 > 目なし > ションベン > ヒフミ', () => {
  const r = (d) => L.evaluate(d).rank;
  assert.ok(r([1, 1, 1]) > r([6, 6, 6]));
  assert.ok(r([6, 6, 6]) > r([2, 2, 2]));
  assert.ok(r([2, 2, 2]) > r([4, 5, 6]));
  assert.ok(r([4, 5, 6]) > r([3, 3, 6]));
  assert.ok(r([3, 3, 6]) > r([3, 3, 1]));
  assert.ok(r([3, 3, 1]) > L.NONE.rank);
  assert.ok(L.NONE.rank > L.SHONBEN.rank);
  assert.ok(L.SHONBEN.rank > r([1, 2, 3]));
  assert.equal(L.NONE.lose, true);
  assert.equal(L.SHONBEN.lose, true);
  assert.equal(L.NONE.label, '目なし');
  assert.equal(L.SHONBEN.label, 'ションベン');
});

test('judge: 同じ役は引き分け、親の負け役は子の不戦勝、倍率は勝者の倍率と敗者の罰倍率の大きい方', () => {
  const H = (d) => L.evaluate(d);
  assert.deepEqual(L.judge(H([3, 3, 3]), L.NONE), { winner: 'parent', mult: 3 });
  assert.deepEqual(L.judge(H([5, 5, 2]), H([1, 2, 3])), { winner: 'parent', mult: 2 });
  assert.deepEqual(L.judge(H([3, 3, 2]), H([1, 1, 1])), { winner: 'child', mult: 5 });
  assert.deepEqual(L.judge(H([1, 2, 3]), null), { winner: 'child', mult: 2 });
  assert.deepEqual(L.judge(L.SHONBEN, null), { winner: 'child', mult: 1 });
  assert.deepEqual(L.judge(L.NONE, null), { winner: 'child', mult: 1 });
  assert.deepEqual(L.judge(H([2, 2, 5]), H([5, 4, 4])), { winner: 'draw', mult: 0 });
  assert.deepEqual(L.judge(H([4, 5, 6]), H([6, 5, 4])), { winner: 'draw', mult: 0 });
  assert.deepEqual(L.judge(H([2, 2, 5]), H([2, 2, 6])), { winner: 'child', mult: 1 });
  assert.deepEqual(L.judge(H([6, 6, 6]), H([4, 5, 6])), { winner: 'parent', mult: 3 });
  assert.deepEqual(L.judge(H([2, 2, 5]), L.SHONBEN), { winner: 'parent', mult: 1 });
  assert.equal(L.penaltyMult(H([1, 2, 3])), 2);
  assert.equal(L.penaltyMult(L.NONE), 1);
  assert.equal(L.penaltyMult(H([2, 2, 5])), 1);
});

test('resultDeltas: 点数は単位×倍率を移し、飲みは倍率ぶんの個数', () => {
  const both = { mode: 'both', unit: 10, drinkUnit: 'sip' };
  assert.deepEqual(L.resultDeltas({ winner: 'child', mult: 3 }, both), {
    parent: { points: -30, drinks: 3, wins: 0, losses: 1 },
    child: { points: 30, drinks: 0, wins: 1, losses: 0 },
  });
  assert.deepEqual(L.resultDeltas({ winner: 'parent', mult: 5 }, { mode: 'points', unit: 20, drinkUnit: 'sip' }), {
    parent: { points: 100, drinks: 0, wins: 1, losses: 0 },
    child: { points: -100, drinks: 0, wins: 0, losses: 1 },
  });
  assert.deepEqual(L.resultDeltas({ winner: 'parent', mult: 2 }, { mode: 'drink', unit: 10, drinkUnit: 'glass' }), {
    parent: { points: 0, drinks: 0, wins: 1, losses: 0 },
    child: { points: 0, drinks: 2, wins: 0, losses: 1 },
  });
  assert.deepEqual(L.resultDeltas({ winner: 'draw', mult: 0 }, both), {
    parent: { points: 0, drinks: 0, wins: 0, losses: 0 },
    child: { points: 0, drinks: 0, wins: 0, losses: 0 },
  });
  assert.deepEqual(L.DRINK_UNITS, { sip: { label: '1口' }, half: { label: '半分' }, glass: { label: '1杯' } });
  assert.deepEqual(L.POINT_UNITS, [10, 20, 50]);
});

test('rollDice: 1〜6 が3つ、seed は整数、ションベンは rng<0.03 のとき', () => {
  for (let s = 1; s <= 50; s++) {
    const r = L.rollDice(seeded(s));
    assert.equal(r.dice.length, 3);
    for (const d of r.dice) assert.ok(Number.isInteger(d) && d >= 1 && d <= 6);
    assert.ok(Number.isInteger(r.seed) && r.seed >= 0);
    assert.equal(typeof r.shonben, 'boolean');
  }
  assert.deepEqual(L.rollDice(seeded(3)), L.rollDice(seeded(3)), '同じ乱数なら同じ結果');
  const low = [0.01, 0.5, 0.5, 0.5, 0.5]; // 最初の rng がションベン判定
  assert.equal(L.rollDice(() => low.shift()).shonben, true);
  const hi = [0.5, 0.5, 0.5, 0.5, 0.5];
  assert.equal(L.rollDice(() => hi.shift()).shonben, false);
});

// ---------- 対戦の状態遷移 ----------
const SETTINGS = { mode: 'both', unit: 10, drinkUnit: 'sip' };
const roll = (dice, shonben = false) => ({ dice, seed: 1, shonben });

test('createState: ロビー、持ち点100、seq 0', () => {
  assert.deepEqual(L.createState(), {
    seq: 0, phase: 'lobby', match: null, result: null, host: { points: 100, wins: 0, losses: 0, drinks: 0 }, lastThrow: null,
  });
});

test('startMatch → 親の番', () => {
  const s = L.startMatch(L.createState(), 'kid1');
  assert.equal(s.phase, 'parent');
  assert.deepEqual(s.match, { childUid: 'kid1', round: 1, parent: { throws: [], hand: null, done: false }, child: { throws: [], hand: null, done: false } });
  assert.equal(L.canThrow(s, 'parent'), true);
  assert.equal(L.canThrow(s, 'child'), false);
});

test('親が1投目で役 → 子の番。親が3投役なし → 目なしで子の不戦勝(result)', () => {
  let s = L.startMatch(L.createState(), 'kid1');
  let r = L.applyThrow(s, 'parent', roll([2, 2, 5]), SETTINGS);
  assert.equal(r.state.phase, 'child');
  assert.equal(r.result, null);
  assert.equal(r.state.match.parent.hand.label, '5の目');
  assert.equal(r.state.match.parent.done, true);
  assert.equal(L.canThrow(r.state, 'child'), true);
  assert.equal(L.canThrow(r.state, 'parent'), false);

  s = L.startMatch(L.createState(), 'kid1');
  s = L.applyThrow(s, 'parent', roll([1, 3, 5]), SETTINGS).state;
  assert.equal(s.phase, 'parent');
  assert.equal(s.match.parent.throws.length, 1);
  assert.equal(s.match.parent.hand, null);
  s = L.applyThrow(s, 'parent', roll([2, 4, 6]), SETTINGS).state;
  r = L.applyThrow(s, 'parent', roll([1, 4, 6]), SETTINGS);
  assert.equal(r.state.phase, 'result');
  assert.equal(r.state.match.parent.hand.type, 'none');
  assert.equal(r.result.winner, 'child');
  assert.equal(r.result.mult, 1);
  assert.equal(r.result.childHand, null);
  assert.equal(r.result.childUid, 'kid1');
});

test('親ヒフミは1投で終了して子の不戦勝、倍率2。ションベンも1投で終了', () => {
  const s = L.startMatch(L.createState(), 'kid1');
  const r = L.applyThrow(s, 'parent', roll([3, 2, 1]), SETTINGS);
  assert.equal(r.state.phase, 'result');
  assert.deepEqual([r.result.winner, r.result.mult], ['child', 2]);
  const r2 = L.applyThrow(s, 'parent', roll([3, 2, 5], true), SETTINGS);
  assert.equal(r2.state.match.parent.hand.type, 'shonben');
  assert.deepEqual([r2.result.winner, r2.result.mult], ['child', 1]);
});

test('子が役を作ると判定。引き分けなら round+1 で親の番に戻り throws が空', () => {
  let s = L.startMatch(L.createState(), 'kid1');
  s = L.applyThrow(s, 'parent', roll([2, 2, 5]), SETTINGS).state;
  let r = L.applyThrow(s, 'child', roll([1, 3, 6]), SETTINGS);
  assert.equal(r.state.phase, 'child');
  assert.equal(r.state.match.child.throws.length, 1);
  r = L.applyThrow(r.state, 'child', roll([4, 4, 5]), SETTINGS); // 5の目 = 親と同じ → 引き分け
  assert.equal(r.result, null);
  assert.equal(r.state.phase, 'parent');
  assert.equal(r.state.match.round, 2);
  assert.deepEqual(r.state.match.parent, { throws: [], hand: null, done: false });
  assert.deepEqual(r.state.match.child, { throws: [], hand: null, done: false });
  assert.equal(r.state.lastThrow.throw.hand.label, '5の目');
});

test('結果で host の points/wins/losses/drinks が動く(both/unit 10/sip)', () => {
  let s = L.startMatch(L.createState(), 'kid1');
  s = L.applyThrow(s, 'parent', roll([2, 2, 5]), SETTINGS).state;
  const r = L.applyThrow(s, 'child', roll([6, 6, 6]), SETTINGS); // 子 6ゾロ(3倍)
  assert.equal(r.state.phase, 'result');
  assert.deepEqual([r.result.winner, r.result.mult], ['child', 3]);
  assert.deepEqual(r.result.deltas.parent, { points: -30, drinks: 3, wins: 0, losses: 1 });
  assert.deepEqual(r.result.deltas.child, { points: 30, drinks: 0, wins: 1, losses: 0 });
  assert.deepEqual(r.state.host, { points: 70, wins: 0, losses: 1, drinks: 3 });
  assert.deepEqual(r.state.result, r.result);
  assert.equal(r.result.parentHand.label, '5の目');
  assert.equal(r.result.childHand.label, '6ゾロ');
});

test('canThrow: result では誰も振れず、手番でない側の applyThrow は例外', () => {
  let s = L.startMatch(L.createState(), 'kid1');
  assert.throws(() => L.applyThrow(s, 'child', roll([2, 2, 5]), SETTINGS));
  s = L.applyThrow(s, 'parent', roll([2, 2, 5]), SETTINGS).state;
  assert.throws(() => L.applyThrow(s, 'parent', roll([2, 2, 5]), SETTINGS));
  const done = L.applyThrow(s, 'child', roll([3, 3, 1]), SETTINGS).state;
  assert.equal(L.canThrow(done, 'parent'), false);
  assert.equal(L.canThrow(done, 'child'), false);
  assert.equal(L.canThrow(L.createState(), 'parent'), false);
});

test('applyThrow は元の state を変えず、seq が1ずつ増え、lastThrow に by/seq/throw が入る', () => {
  const s0 = L.startMatch(L.createState(), 'kid1');
  const snapshot = JSON.stringify(s0);
  const r = L.applyThrow(s0, 'parent', roll([2, 2, 5]), SETTINGS);
  assert.equal(JSON.stringify(s0), snapshot);
  assert.equal(r.state.seq, s0.seq + 1);
  assert.equal(r.state.lastThrow.by, 'parent');
  assert.equal(r.state.lastThrow.seq, r.state.seq);
  assert.deepEqual(r.state.lastThrow.throw.dice, [2, 2, 5]);
  assert.equal(typeof r.state.lastThrow.throw.at, 'number');
  assert.equal(L.startMatch(L.createState(), 'k').seq, 1);
});

test('nextMatch で lobby に戻り match/result が null、host の成績は残る', () => {
  let s = L.startMatch(L.createState(), 'kid1');
  s = L.applyThrow(s, 'parent', roll([2, 2, 5]), SETTINGS).state;
  s = L.applyThrow(s, 'child', roll([6, 6, 6]), SETTINGS).state;
  const n = L.nextMatch(s);
  assert.equal(n.phase, 'lobby');
  assert.equal(n.match, null);
  assert.equal(n.result, null);
  assert.deepEqual(n.host, { points: 70, wins: 0, losses: 1, drinks: 3 });
  assert.equal(n.seq, s.seq + 1);
});

test('normalizeState: 同期で消えた空配列や null を補い、その状態でも進行できる', () => {
  const s = L.startMatch(L.createState(), 'k');
  // Firebase は空配列と null を保存しないので、それを模す
  const stripped = JSON.parse(JSON.stringify(s), (k, v) => (v === null || (Array.isArray(v) && v.length === 0) ? undefined : v));
  assert.equal(stripped.match.parent.throws, undefined);
  assert.equal(stripped.result, undefined);
  assert.deepEqual(L.normalizeState(stripped), s);
  assert.equal(L.canThrow(stripped, 'parent'), true);
  const r = L.applyThrow(stripped, 'parent', roll([2, 2, 5]), SETTINGS);
  assert.equal(r.state.phase, 'child');
  assert.deepEqual(L.normalizeState(undefined), L.createState());
  assert.deepEqual(L.nextMatch(stripped).phase, 'lobby');
});
