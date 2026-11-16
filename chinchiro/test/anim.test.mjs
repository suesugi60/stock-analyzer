import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../anim.js');
const v = (name, lang, extra = {}) => ({ name, lang, voiceURI: name, localService: true, ...extra });

test('pickVoice: 日本語の声から、拡張(premium/enhanced)→ 知られた自然な声 → その他 の順で選ぶ', () => {
  const voices = [v('Alex', 'en-US'), v('Kyoko', 'ja-JP'), v('Kyoko', 'ja-JP', { voiceURI: 'com.apple.voice.premium.ja-JP.Kyoko' }), v('Otoya', 'ja-JP')];
  assert.equal(A.pickVoice(voices).voiceURI, 'com.apple.voice.premium.ja-JP.Kyoko');
  assert.equal(A.pickVoice([v('Alex', 'en-US'), v('Otoya', 'ja-JP'), v('Google 日本語', 'ja-JP')]).name, 'Google 日本語');
  assert.equal(A.pickVoice([v('Microsoft Ayumi', 'ja-JP'), v('Microsoft Nanami Online (Natural)', 'ja-JP')]).name, 'Microsoft Nanami Online (Natural)');
  assert.equal(A.pickVoice([v('Alex', 'en-US'), v('Otoya', 'ja-JP')]).name, 'Otoya');
  assert.equal(A.pickVoice([v('Alex', 'en-US')]), null);
  assert.equal(A.pickVoice([]), null);
});

test('VOICE_KEYS: 役ごとの音声ファイル名と文言が揃っている', () => {
  const keys = Object.keys(A.VOICE_LINES);
  for (const k of ['pinzoro', 'zoro2', 'zoro6', 'shigoro', 'me1', 'me6', 'none', 'hifumi', 'shonben']) assert.ok(keys.includes(k), k);
  assert.equal(A.VOICE_LINES.pinzoro, 'ピンゾロ！');
  assert.equal(A.VOICE_LINES.me5, '5の目');
  assert.equal(A.voiceKeyFor({ type: 'zoro', value: 4 }), 'zoro4');
  assert.equal(A.voiceKeyFor({ type: 'me', value: 1 }), 'me1');
  assert.equal(A.voiceKeyFor({ type: 'shonben' }), 'shonben');
  assert.equal(A.voiceKeyFor(null), 'none');
});

test('reachPlan: 最後の1個の選び方と見える形', () => {
  const plans = (dice) => Array.from({ length: 400 }, (_, s) => A.reachPlan(dice, false, s));
  // 2つ同じ+1つ違う: 違う1つが最後のとき(ゾロ目リーチ)と、先のときがどちらもある
  const me = plans([3, 3, 5]);
  assert.ok(me.some((p) => p.lastIdx === 2 && p.kind === 'zoro'));
  assert.ok(me.some((p) => p.lastIdx !== 2 && p.kind === null)); // 5・3 が先 → 形なし
  assert.ok(me.every((p) => (p.lastIdx === 2 ? p.kind === 'zoro' : p.kind === null)));
  const me2 = plans([4, 4, 5]);
  assert.ok(me2.some((p) => p.lastIdx !== 2 && p.kind === 'shigoro')); // 5・4 が先 → シゴロリーチ → 外れて5の目
  assert.ok(plans([1, 4, 1]).some((p) => p.kind === 'pinzoro'));
  // バラバラ: 多数派が先(シゴロリーチ / ピンチ)のときと、混ざった2つが先(形なし)のときがある
  const none = plans([4, 2, 6]);
  assert.ok(none.some((p) => p.lastIdx === 1 && p.kind === 'shigoro'));
  assert.ok(none.some((p) => p.lastIdx !== 1 && p.kind === null));
  const none2 = plans([5, 1, 2]);
  assert.ok(none2.some((p) => p.lastIdx === 0 && p.kind === 'pinch' && p.pinch));
  assert.ok(none2.every((p) => p.level <= 2));
  assert.deepEqual(A.reachPlan([2, 3, 5], true, 1), { lastIdx: 2, kind: null, level: 0, pinch: false, need: null, target: null }); // ションベン
  assert.deepEqual(A.reachPlan([9, 0, 'x'], false, 1), { lastIdx: 2, kind: null, level: 0, pinch: false, need: null, target: null }); // 不正
  // 誰が見てもわかるように: 何が出れば何の役か
  const zoro = me.find((p) => p.kind === 'zoro'); assert.equal(zoro.need, 3); assert.equal(zoro.target, '3ゾロ ×3');
  const pz = plans([1, 4, 1]).find((p) => p.kind === 'pinzoro'); assert.equal(pz.need, 1); assert.equal(pz.target, 'ピンゾロ ×5');
  const sg = none.find((p) => p.kind === 'shigoro'); assert.equal(sg.need, 5); // 4・6 が見えている → 5 が必要 assert.equal(sg.target, 'シゴロ ×2');
  const pc = none2.find((p) => p.kind === 'pinch'); assert.equal(pc.need, 3); assert.equal(pc.target, 'ヒフミ(2倍払い)'); // 1・2 が見えている → 3 でヒフミ
  assert.equal(me.find((p) => p.kind === null).need, null);
  assert.ok(plans([4, 5, 6]).every((p) => p.kind === 'shigoro'));
  assert.ok(plans([1, 2, 3]).every((p) => p.kind === 'pinch' && p.pinch && p.level <= 2));
  assert.ok(plans([6, 6, 6]).every((p) => p.kind === 'zoro'));
  assert.ok(plans([1, 1, 1]).every((p) => p.kind === 'pinzoro'));
  assert.ok(plans([6, 6, 6]).some((p) => p.lastIdx === 0) && plans([6, 6, 6]).some((p) => p.lastIdx === 2));
  assert.deepEqual(A.reachPlan([6, 6, 6], false, 42), A.reachPlan([6, 6, 6], false, 42)); // 同じ seed なら同じ
  assert.equal(A.reachPlan([2, 4, 6], false, 1, 3).level, 3);     // 強制
  assert.equal(A.reachPlan([2, 4, 6], false, 1, 0).level, 0);
  assert.ok(plans([2, 4, 6]).every((p) => p.kind !== null || p.level === 0)); // 形なしならレベル0
});

test('reachPlan: レベルの分布(信頼度)', () => {
  const dist = (dice) => { const c = [0, 0, 0, 0]; for (let s = 0; s < 3000; s++) c[A.reachPlan(dice, false, s).level]++; return c.map((x) => x / 3000); };
  const pz = dist([1, 1, 1]); assert.ok(pz[3] > 0.6 && pz[0] === 0, JSON.stringify(pz));
  const me = dist([3, 3, 5]); assert.ok(me[0] > 0.75 && me[3] < 0.05, JSON.stringify(me)); // 半分は形なし(L0)なので L0 が多い
  const hf = dist([1, 2, 3]); assert.equal(hf[3], 0); assert.ok(hf[2] > 0.5, JSON.stringify(hf));
  const sg = dist([4, 5, 6]); assert.ok(sg[0] === 0 && sg[3] > 0.2, JSON.stringify(sg));
  assert.deepEqual(A.REACH_HOLD_MS, { 1: 1400, 2: 2400, 3: 3600 });
  // 強い役のリーチほど長く: ピンゾロ 1.5 倍、ゾロ目 1.25 倍、シゴロ・ピンチ 1 倍
  assert.equal(A.holdMs(3, 'pinzoro'), 5400); assert.equal(A.holdMs(2, 'zoro'), 3000); assert.equal(A.holdMs(1, 'shigoro'), 1400); assert.equal(A.holdMs(2, 'pinch'), 2400);
  assert.equal(A.holdMs(0, 'zoro'), 0);
  assert.deepEqual(Object.keys(A.REACH_WEIGHTS).sort(), ['hifumi', 'me', 'nonePinch', 'noneShigoro', 'pinzoro', 'shigoro', 'zoro']);
});

test('freezeAnims/thawAnims: 終わったアニメは止めず、止めたものだけ再開する(巻き戻し防止)', () => {
  const mk = (st) => ({ playState: st, paused: 0, played: 0, pause() { this.playState = 'paused'; this.paused++; }, play() { this.playState = 'running'; this.played++; } });
  const run = mk('running'); const fin = mk('finished');
  const frozen = A.freezeAnims([run, fin]);
  assert.deepEqual([run.paused, fin.paused], [1, 0]);
  fin.play = () => { throw new Error('finished を play すると巻き戻る'); };
  A.thawAnims(frozen);
  assert.equal(run.played, 1);
  assert.equal(A.freezeAnims([]).length, 0);
});
