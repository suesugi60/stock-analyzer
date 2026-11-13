// 純粋関数のテスト。node --test test/logic.test.mjs で実行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE, LINES, makeCard, analyzeCard, pickUncalled, normalizeName,
  isValidCount, isValidToken, rankWinners, seededRng, cryptoRng, LIMITS, DELAYS, MAX_NUMBER,
} from '../public/logic.mjs';

test('定数: 上限と遅れの選択肢', () => {
  assert.equal(MAX_NUMBER, 75);
  assert.deepEqual(LIMITS, { NAME_MAX: 20, COUNT_MAX: 50, CARDS_MAX: 5000, PENDING_MAX: 1000 });
  assert.deepEqual(DELAYS, [0, 3, 5, 8, 10, 15, 20, 30]);
});

test('makeCard: 25マス・中央FREE・列ごとの範囲・重複なし', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const c = makeCard(seededRng(seed));
    assert.equal(c.length, 25);
    assert.equal(c[12], FREE);
    for (let i = 0; i < 25; i++) {
      if (i === 12) continue;
      const col = i % 5;
      assert.ok(c[i] >= col * 15 + 1 && c[i] <= col * 15 + 15, `seed ${seed} index ${i}`);
    }
    assert.equal(new Set(c).size, 25);
  }
});

test('makeCard: 乱数が違えばカードも違う', () => {
  assert.notDeepEqual(makeCard(seededRng(1)), makeCard(seededRng(2)));
});

test('makeCard: 暗号用の乱数でも正しいカードになる', () => {
  const c = makeCard(cryptoRng);
  assert.equal(c.length, 25);
  assert.equal(c[12], FREE);
  assert.equal(new Set(c).size, 25);
});

test('LINES: 縦5・横5・斜め2の12本', () => {
  assert.equal(LINES.length, 12);
  for (const l of LINES) assert.equal(l.length, 5);
  assert.ok(LINES.some((l) => l.join() === '0,1,2,3,4'));
  assert.ok(LINES.some((l) => l.join() === '0,5,10,15,20'));
  assert.ok(LINES.some((l) => l.join() === '0,6,12,18,24'));
  assert.ok(LINES.some((l) => l.join() === '4,8,12,16,20'));
});

test('analyzeCard: 何も出ていなければ FREE だけ開いている', () => {
  const a = analyzeCard(makeCard(seededRng(3)), new Set());
  assert.equal(a.marked.filter(Boolean).length, 1);
  assert.equal(a.marked[12], true);
  assert.deepEqual([a.lines, a.reach, a.need], [0, 0, 4]);
});

test('analyzeCard: 12本それぞれがそろう', () => {
  const c = makeCard(seededRng(4));
  for (const line of LINES) {
    const called = new Set(line.map((i) => c[i]).filter((n) => n !== FREE));
    assert.ok(analyzeCard(c, called).lines >= 1);
    assert.equal(analyzeCard(c, called).need, 0);
  }
});

test('analyzeCard: あと1個でリーチ', () => {
  const c = makeCard(seededRng(5));
  const a = analyzeCard(c, new Set([c[0], c[1], c[2], c[3]])); // 1行目を4つ
  assert.deepEqual([a.lines, a.reach, a.need], [0, 1, 1]);
});

test('analyzeCard: カードにない番号は無視する', () => {
  const c = makeCard(seededRng(6));
  const missing = [];
  for (let n = 1; n <= 75; n++) if (!c.includes(n)) missing.push(n);
  const a = analyzeCard(c, new Set(missing));
  assert.equal(a.marked.filter(Boolean).length, 1);
});

test('pickUncalled: 出ていない番号だけ、全部出たら null', () => {
  const called = new Set();
  for (let i = 0; i < 75; i++) {
    const n = pickUncalled(called, seededRng(i + 1));
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 75);
    assert.ok(!called.has(n));
    called.add(n);
  }
  assert.equal(called.size, 75);
  assert.equal(pickUncalled(called, seededRng(1)), null);
});

test('normalizeName', () => {
  assert.equal(normalizeName('  たろう  '), 'たろう');
  assert.equal(normalizeName('a\u0000b‮c'), 'abc');
  assert.equal(normalizeName('   '), null);
  assert.equal(normalizeName(''), null);
  assert.equal(normalizeName('あ'.repeat(20)), 'あ'.repeat(20));
  assert.equal(normalizeName('あ'.repeat(21)), null);
  assert.equal(normalizeName('😀'.repeat(20)), '😀'.repeat(20));
  assert.equal(normalizeName(123), null);
  assert.equal(normalizeName(null), null);
});

test('isValidCount / isValidToken', () => {
  for (const ok of [1, 50]) assert.equal(isValidCount(ok), true);
  for (const ng of [0, 51, 2.5, -1, 1e9, '3', null, NaN]) assert.equal(isValidCount(ng), false);
  assert.equal(isValidToken('a'.repeat(64)), true);
  assert.equal(isValidToken('0123456789abcdef'.repeat(4)), true);
  for (const ng of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 1, null]) assert.equal(isValidToken(ng), false);
});

test('rankWinners: at・id 順、同時は同順位(1,1,3)', () => {
  const w = rankWinners([
    { id: 9, name: 'c', no: 1, at: 12 }, { id: 2, name: 'a', no: 1, at: 11 }, { id: 5, name: 'b', no: 2, at: 11 },
  ]);
  assert.deepEqual(w, [
    { rank: 1, name: 'a', no: 1, at: 11 }, { rank: 1, name: 'b', no: 2, at: 11 }, { rank: 3, name: 'c', no: 1, at: 12 },
  ]);
  assert.deepEqual(rankWinners([]), []);
});
