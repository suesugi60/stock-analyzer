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
