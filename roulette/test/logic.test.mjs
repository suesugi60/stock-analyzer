// ルーレットのロジック(純粋関数)のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLogic, seeded } from './helpers.mjs';

const L = loadLogic();
const items = (...labels) => labels.map((t) => ({ t, w: 1 }));

test('sanitizeItems: 空の項目を捨て、文字数と当たりやすさを範囲に収める', () => {
  const out = L.sanitizeItems([
    { t: '  あたり  ', w: 2 }, { t: '', w: 1 }, { t: '   ', w: 3 }, { t: 'x'.repeat(50), w: 99 }, { t: 'はずれ', w: -3 }, { t: 'a\n b', w: 2.7 }, null, 'もじ',
  ]);
  assert.deepEqual(out, [
    { t: 'あたり', w: 2 }, { t: 'x'.repeat(L.MAX_LABEL), w: L.MAX_WEIGHT }, { t: 'はずれ', w: 1 }, { t: 'a b', w: 2 }, { t: 'もじ', w: 1 },
  ]);
  assert.deepEqual(L.sanitizeItems(null), []);
  assert.equal(L.sanitizeItems(Array.from({ length: 100 }, (_, i) => ({ t: `i${i}`, w: 1 }))).length, L.MAX_ITEMS);
});

test('sanitizeItems: 絵文字を途中で切らない', () => {
  const out = L.sanitizeItems([{ t: '🎉'.repeat(30), w: 1 }]);
  assert.equal(Array.from(out[0].t).length, L.MAX_LABEL);
  assert.equal(out[0].t, '🎉'.repeat(L.MAX_LABEL));
});

test('segBounds: 当たりやすさに比例した角度で、最後は 360 度', () => {
  const b = L.segBounds([{ t: 'a', w: 1 }, { t: 'b', w: 2 }, { t: 'c', w: 1 }]);
  assert.deepEqual(b, [0, 90, 270, 360]);
  assert.deepEqual(L.segBounds([]), [0]);
});

test('pickIndex: 当たりやすさどおりの確率で選ぶ', () => {
  const segs = [{ t: 'a', w: 1 }, { t: 'b', w: 3 }];
  const rng = seeded(11);
  let b = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (L.pickIndex(segs, rng()) === 1) b++;
  assert.ok(Math.abs(b / N - 0.75) < 0.015, `b の割合 ${b / N}`);
  assert.equal(L.pickIndex(segs, 0), 0);
  assert.equal(L.pickIndex(segs, 0.9999999), 1);
});

test('planSpin: 止まったとき、針は必ず選ばれた項目を指す', () => {
  const rng = seeded(3);
  for (let n = 2; n <= 40; n += 3) {
    const segs = Array.from({ length: n }, (_, i) => ({ t: `s${i}`, w: 1 + (i % 4) }));
    let from = 0;
    for (let k = 0; k < 60; k++) {
      const plan = L.planSpin(segs, from, rng);
      assert.equal(L.indexAt(segs, plan.to), plan.index, `n=${n} k=${k}`);
      assert.equal(plan.from, from);
      assert.ok(plan.to - plan.from >= 5 * 360, '5 周以上回る');
      assert.ok(plan.ms >= 6000 && plan.ms <= 9000);
      from = L.mod(plan.to, 360);
    }
  }
});

test('planSpin: 項目が 2 つ未満なら回せない', () => {
  assert.equal(L.planSpin([], 0, Math.random), null);
  assert.equal(L.planSpin(items('ひとつ'), 0, Math.random), null);
});

test('planSpin: 針は項目の境目すれすれには止まらない(どちらか分からなくならない)', () => {
  const rng = seeded(8);
  const segs = items('a', 'b', 'c', 'd', 'e');
  const b = L.segBounds(segs);
  for (let k = 0; k < 500; k++) {
    const plan = L.planSpin(segs, 0, rng);
    const theta = L.mod(-plan.to, 360);
    const frac = (theta - b[plan.index]) / (b[plan.index + 1] - b[plan.index]);
    assert.ok(frac > 0.05 && frac < 0.95, `frac=${frac}`);
  }
});

test('angleAt: 始まりは from、終わりは to、途中で逆回転しない', () => {
  const spin = { from: 30, to: 30 + 6 * 360 + 77, ms: 7000 };
  assert.equal(L.angleAt(spin, 0), 30);
  assert.equal(L.angleAt(spin, 7000), spin.to);
  assert.equal(L.angleAt(spin, 99999), spin.to);
  assert.equal(L.angleAt(spin, -5), 30);
  let prev = -Infinity;
  for (let t = 0; t <= 7000; t += 50) {
    const a = L.angleAt(spin, t);
    assert.ok(a >= prev, `t=${t}`);
    prev = a;
  }
  // 最後はゆっくり: 残り 10% の時間で進むのは 1 周の 1/10 未満
  assert.ok(spin.to - L.angleAt(spin, 6300) < 36);
});

test('indexAt: 回した角度から、針(右)が指す項目を求める', () => {
  const segs = items('a', 'b', 'c', 'd'); // 90 度ずつ
  assert.equal(L.indexAt(segs, 0), 0);
  assert.equal(L.indexAt(segs, -45), 0);
  assert.equal(L.indexAt(segs, -100), 1);
  assert.equal(L.indexAt(segs, 10), 3); // 時計回りに 10 度回すと、手前(最後)の項目が針に来る
  assert.equal(L.indexAt(segs, 360 * 3 - 190), 2);
  assert.equal(L.indexAt([], 10), -1);
});

test('colorIndex: 隣どうし(最後と最初も)同じ色にならない', () => {
  for (let n = 2; n <= 60; n++) {
    for (let i = 0; i < n; i++) {
      const a = L.colorIndex(i, n);
      const b = L.colorIndex((i + 1) % n, n);
      assert.notEqual(a, b, `n=${n} i=${i}`);
      assert.ok(a >= 0 && a < L.COLORS.length);
    }
  }
});

test('createState / normalizeState: 最初は見本の項目が入っていて、壊れた入力でも安全な形になる', () => {
  const st = L.createState();
  assert.equal(st.phase, 'open');
  assert.equal(st.kind, 'items');
  assert.ok(st.items.length >= 2);
  assert.deepEqual(L.normalizeState(JSON.parse(JSON.stringify(st))), st);

  const bad = L.normalizeState({ phase: 'x', kind: 'evil', items: 'nope', seq: 'NaN', turn: 5, won: [1], history: { a: 1 }, spin: { id: 1, segs: 'x' }, dismissed: {} });
  assert.equal(bad.phase, 'open');
  assert.equal(bad.kind, 'items');
  assert.deepEqual(bad.items, []);
  assert.equal(bad.seq, 0);
  assert.equal(bad.turn, null);
  assert.equal(bad.spin, null);
  assert.deepEqual(bad.history, []);
  assert.equal(L.normalizeState(null).phase, 'open');
  assert.equal(L.normalizeState(undefined).spin, null);
});

test('normalizeState: おかしな spin(範囲外の番号・無限の角度・長すぎる時間)は捨てる', () => {
  const segs = items('a', 'b');
  const ok = { id: 3, kind: 'items', segs, index: 1, from: 0, to: 2000, ms: 7000, byName: '' };
  assert.equal(L.normalizeState({ spin: ok }).spin.index, 1);
  assert.equal(L.normalizeState({ spin: { ...ok, index: 2 } }).spin, null);
  assert.equal(L.normalizeState({ spin: { ...ok, to: 'Infinity' } }).spin, null);
  assert.equal(L.normalizeState({ spin: { ...ok, ms: 1e9 } }).spin, null);
  assert.equal(L.normalizeState({ spin: { ...ok, segs: items('a') } }).spin, null);
  // 文字は長すぎれば切る(画面を壊さない)
  const long = L.normalizeState({ spin: { ...ok, segs: [{ t: 'z'.repeat(500), w: 1 }, { t: 'b', w: 1 }] } }).spin;
  assert.ok(long.segs[0].t.length <= 40);
});

test('startSpin: 記録の先頭に結果が足され、指名は解除され、番号が進む', () => {
  let st = L.setTurn(L.setItems(L.createState(), items('a', 'b', 'c')), 'u1');
  const next = L.startSpin(st, L.itemSegs(st.items), { by: 'u1', byName: 'たろう', rng: seeded(5) });
  assert.equal(next.seq, 1);
  assert.equal(next.spin.id, 1);
  assert.equal(next.spin.kind, 'items');
  assert.equal(next.spin.byName, 'たろう');
  assert.equal(next.turn, null);
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].t, next.spin.segs[next.spin.index].t);
  assert.equal(next.history[0].by, 'たろう');
  assert.equal(L.showingResult(next), true);
  assert.equal(L.indexAt(next.spin.segs, next.spin.to), next.spin.index);
  // 2 回目は前回の止まった角度から回り始める
  const third = L.startSpin(next, L.itemSegs(next.items), { rng: seeded(6) });
  assert.equal(third.spin.from, L.mod(next.spin.to, 360));
  assert.equal(third.history.length, 2);
  assert.equal(third.history[0].id, 2);
  // 元の state は書き換えない
  assert.equal(st.seq, 0);
  assert.equal(st.history.length, 0);
});

test('startSpin: 項目が足りなければ何もしない(null)', () => {
  const st = L.setItems(L.createState(), items('ひとつ'));
  assert.equal(L.startSpin(st, L.itemSegs(st.items), {}), null);
});

test('startSpin: 記録は新しい順に MAX_HISTORY 件まで', () => {
  let st = L.setItems(L.createState(), items('a', 'b'));
  const rng = seeded(1);
  for (let i = 0; i < L.MAX_HISTORY + 5; i++) st = L.startSpin(st, L.itemSegs(st.items), { rng });
  assert.equal(st.history.length, L.MAX_HISTORY);
  assert.equal(st.history[0].id, L.MAX_HISTORY + 5);
});

test('startSpin: 「当たった項目は消していく」なら、当たった項目だけが消える', () => {
  let st = L.setOption(L.setItems(L.createState(), items('a', 'b', 'c', 'd')), 'removeHit', true);
  const next = L.startSpin(st, L.itemSegs(st.items), { rng: seeded(9) });
  const hit = next.spin.segs[next.spin.index].t;
  assert.equal(next.items.length, 3);
  assert.ok(!next.items.some((x) => x.t === hit));
  assert.equal(next.spin.segs.length, 4, '回っている盤は消す前の 4 項目のまま');
  // オフなら減らない
  st = L.setOption(st, 'removeHit', false);
  assert.equal(L.startSpin(st, L.itemSegs(st.items), { rng: seeded(9) }).items.length, 4);
});

const roomWith = (state, names, extra = {}) => {
  const players = {};
  const queue = {};
  names.forEach((n, i) => { players[`u${i}`] = { name: n, char: 'kappa', joinedAt: 100 + i, ...(extra[`u${i}`] || {}) }; queue[`u${i}`] = { joinedAt: 100 + i }; });
  return { state, players, queue };
};

test('nameSegs: 参加した順に並び、ブロックした人は入らず、非表示の人は ？？？ になる', () => {
  const st = L.setKind(L.createState(), 'names');
  const room = roomWith(st, ['あ', 'い', 'う', 'え'], { u1: { banned: true }, u2: { hidden: true } });
  room.queue.ghost = { joinedAt: 1 }; // players に無い人は入らない
  const segs = L.nameSegs(room);
  assert.deepEqual(segs.map((s) => s.t), ['あ', '？？？', 'え']);
  assert.deepEqual(segs.map((s) => s.u), ['u0', 'u2', 'u3']);
  assert.deepEqual(L.liveSegs(room), segs);
  assert.deepEqual(L.entrants(room).map((e) => e.uid), ['u0', 'u2', 'u3']);
});

test('抽選: 当たった人は記録され、「次から外す」がオンなら次の抽選の対象から外れる', () => {
  let st = L.setKind(L.createState(), 'names');
  let room = roomWith(st, ['あ', 'い', 'う']);
  st = L.startSpin(st, L.nameSegs(room), { rng: seeded(4) });
  const winner = st.spin.segs[st.spin.index];
  assert.equal(st.won[winner.u], true);
  assert.equal(st.history[0].u, winner.u);
  assert.equal(st.history[0].k, 'names');
  room = { ...room, state: st };
  assert.equal(L.nameSegs(room).length, 2);
  assert.ok(!L.nameSegs(room).some((s) => s.u === winner.u));
  // オフにすると全員が対象に戻る
  room = { ...room, state: L.setOption(st, 'removeWinner', false) };
  assert.equal(L.nameSegs(room).length, 3);
  // 当選のリセット
  room = { ...room, state: L.resetWon(st) };
  assert.equal(L.nameSegs(room).length, 3);
});

test('setKind / dismiss: 切り替えると出ていた結果は閉じる。dismiss で結果を閉じる', () => {
  let st = L.setItems(L.createState(), items('a', 'b'));
  st = L.startSpin(st, L.itemSegs(st.items), { rng: seeded(2) });
  assert.equal(L.showingResult(st), true);
  assert.equal(L.showingResult(L.dismiss(st)), false);
  const names = L.setKind(st, 'names');
  assert.equal(names.kind, 'names');
  assert.equal(L.showingResult(names), false);
  assert.equal(L.setKind(st, 'bogus').kind, 'items');
  assert.equal(L.restAngle(st), L.mod(st.spin.to, 360));
  assert.equal(L.restAngle(L.createState()), 0);
});

test('preset: 見本はどれも 2 項目以上で、飲みの見本には印が付く', () => {
  for (const key of Object.keys(L.PRESETS)) {
    const p = L.PRESETS[key];
    assert.ok(L.sanitizeItems(p.items).length >= 2, key);
    assert.equal(L.sanitizeItems(p.items).length, p.items.length, `${key}: 見本の文字が長すぎる`);
    assert.ok(p.label);
  }
  assert.equal(L.PRESETS.nomi.drink, true);
});
