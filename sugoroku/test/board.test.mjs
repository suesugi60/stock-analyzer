import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSugoroku, seeded } from './helpers.mjs';

const S = loadSugoroku();
const SIZES = [16, 32, 50, 100];
const DIFFS = ['easy', 'normal', 'hard', 'oni'];

function counts(board) {
  const c = {};
  for (const t of board) c[t.cat] = (c[t.cat] || 0) + 1;
  return c;
}

/** 最大剰余法で期待個数を出す(テスト側の独立実装)。 */
function expectedCounts(n, ratios) {
  const cats = Object.keys(ratios);
  const raw = cats.map((k) => (n * ratios[k]) / 100);
  const base = raw.map(Math.floor);
  let rest = n - base.reduce((a, b) => a + b, 0);
  const order = cats
    .map((k, i) => ({ k, r: raw[i] - base[i], i }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const o of order) {
    if (rest <= 0) break;
    base[o.i] += 1;
    rest -= 1;
  }
  return Object.fromEntries(cats.map((k, i) => [k, base[i]]));
}

test('ボードは N 個で、先頭が start、末尾が goal', () => {
  for (const size of SIZES) {
    const b = S.generateBoard(size, 'normal', seeded(1));
    assert.equal(b.length, size);
    assert.equal(b[0].cat, 'start');
    assert.equal(b[size - 1].cat, 'goal');
    b.forEach((t, i) => assert.equal(t.index, i));
  }
});

test('カテゴリ個数が難易度の配分(最大剰余法)と一致する', () => {
  for (const size of SIZES) {
    for (const d of DIFFS) {
      const b = S.generateBoard(size, d, seeded(7));
      const got = counts(b.slice(1, -1));
      const want = expectedCounts(size - 2, S.DIFFICULTIES[d].ratios);
      for (const k of Object.keys(want)) {
        assert.equal(got[k] || 0, want[k], `${size}/${d}/${k}`);
      }
    }
  }
});

test('一気マスは隣接せず、マス1〜3に一気・全員が置かれない', () => {
  for (const size of SIZES) {
    for (const d of DIFFS) {
      for (let seed = 1; seed <= 30; seed++) {
        const b = S.generateBoard(size, d, seeded(seed));
        for (let i = 1; i < size - 2; i++) {
          assert.ok(!(b[i].cat === 'chug' && b[i + 1].cat === 'chug'), `${size}/${d}/seed${seed}: 一気が隣接 @${i}`);
        }
        for (let i = 1; i <= 3; i++) {
          assert.ok(b[i].cat !== 'chug' && b[i].cat !== 'all', `${size}/${d}/seed${seed}: マス${i}が ${b[i].cat}`);
        }
      }
    }
  }
});

test('指令マスには文言があり、休憩・start・goal には文言がない', () => {
  const b = S.generateBoard(100, 'hard', seeded(3));
  for (const t of b) {
    if (['start', 'goal', 'rest'].includes(t.cat)) {
      assert.equal(t.text, undefined, `index ${t.index}`);
    } else {
      assert.ok(typeof t.text === 'string' && t.text.length > 0, `index ${t.index}`);
      assert.ok(!t.text.includes('{'), `未置換: ${t.text}`);
    }
  }
});

test('難易度ごとの量の文言が指令に入る', () => {
  const expectWord = { easy: '3分の1', normal: '半分', hard: '一気', oni: 'ショット' };
  for (const d of DIFFS) {
    const b = S.generateBoard(100, d, seeded(11));
    const texts = b.filter((t) => t.cat === 'self').map((t) => t.text);
    assert.ok(texts.length > 0);
    for (const t of texts) assert.ok(t.includes(expectWord[d]), `${d}: ${t}`);
  }
});

test('同じカテゴリの文言はプールを使い切るまで重複しない', () => {
  const b = S.generateBoard(100, 'normal', seeded(5));
  for (const cat of ['self', 'pick', 'all', 'chug']) {
    const texts = b.filter((t) => t.cat === cat).map((t) => t.text);
    const poolSize = S.DIFFICULTIES.normal.ratios[cat] > 0 ? S.TEXTS[cat].length : 0;
    const firstRound = texts.slice(0, Math.min(poolSize, texts.length));
    assert.equal(new Set(firstRound).size, firstRound.length, `${cat}: 早すぎる重複`);
  }
});

test('同じシードなら同じボード、違うシードなら違うボード', () => {
  const a = S.generateBoard(50, 'normal', seeded(42));
  const b = S.generateBoard(50, 'normal', seeded(42));
  const c = S.generateBoard(50, 'normal', seeded(43));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});
