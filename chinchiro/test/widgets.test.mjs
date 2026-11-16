import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('../widgets.js');

test('diceHtml: 3つのミニサイコロ。4 の目は <i> が4つ', () => {
  const h = W.diceHtml([4, 5, 6]);
  assert.equal((h.match(/class="mdice"/g) || []).length, 3);
  assert.ok(/data-n="4">(<i[^>]*><\/i>){4}<\/span>/.test(h), h);
  assert.ok(W.diceHtml([9, 0, 'x']).includes('?'));
  assert.ok(W.diceHtml(null).includes('?'));
});

test('throwsHtml: 投げた順に出目と役名', () => {
  const h = W.throwsHtml([{ dice: [2, 4, 6], hand: null }, { dice: [3, 3, 5], hand: { type: 'me', value: 5, label: '5の目' } }]);
  assert.ok(h.startsWith('<div class="throws">'));
  assert.ok(h.indexOf('目なし') < h.indexOf('5の目'));
  assert.equal((h.match(/class="mdice"/g) || []).length, 6);
  assert.equal(W.throwsHtml([]), '');
  assert.equal(W.throwsHtml(undefined), '');
});

test('legendHtml / rulesHtml: 倍率と部屋の設定が入る', () => {
  assert.ok(W.legendHtml().includes('ピンゾロ ×5'));
  assert.ok(W.legendHtml().includes('ヒフミ ×2払い'));
  assert.ok(W.legendHtml().includes('目 ×1 ＞ 目なし ＞ ヒフミ ×2払い'), '目なしはいちばん弱い役として順位に出す');
  const rules = W.rulesHtml({ mode: 'points', unit: 10 });
  assert.ok(rules.includes('各3投まで') && rules.includes('いちばん弱い') && rules.includes('引き分け'), rules);
  const h = W.rulesHtml({ mode: 'both', unit: 20, drinkUnit: 'half', startPoints: 300 });
  for (const s of ['ルール', 'ピンゾロ', '×5', 'シゴロ', '×2', 'ヒフミ', '2倍', 'ションベン', '持ち点 300', '1戦 20点', '半分', '40点']) assert.ok(h.includes(s), s);
  const d = W.rulesHtml({ mode: 'drink', drinkUnit: 'sip' });
  assert.ok(!d.includes('持ち点') && d.includes('1口 × 2'));
  assert.ok(W.rulesHtml({ mode: 'points', unit: 10 }).includes('持ち点 100'));
  assert.ok(W.rulesHtml(null).includes('ピンゾロ'));
});

test('logHtml: 自分の行に mine、非表示の人は？？？、点は親から見た符号', () => {
  const log = [
    { n: 2, uid: 'u2', name: '<b>x</b>', round: 1, p: { dice: [1, 2, 3], hand: { type: 'hifumi', value: 0, label: 'ヒフミ' } }, c: null, w: 'child', m: 2, pt: -20, dr: 2 },
    { n: 1, uid: 'u1', name: 'たろう', round: 2, p: { dice: [4, 4, 6], hand: { type: 'me', value: 6, label: '6の目' } }, c: { dice: [2, 2, 5], hand: { type: 'me', value: 5, label: '5の目' } }, w: 'parent', m: 1, pt: 10, dr: 0 },
  ];
  const h = W.logHtml(log, { meUid: 'u1', players: { u2: { hidden: true } }, settings: { mode: 'both', drinkUnit: 'sip' } });
  assert.equal((h.match(/class="log-row/g) || []).length, 2);
  assert.ok(h.includes('log-row mine'));
  assert.ok(h.includes('？？？') && !h.includes('<b>x</b>'));
  for (const s of ['#2', '(振らず)', '-20点', '🍺×2', '#1', 'たろう', '+10点', '親の勝ち', '2回戦']) assert.ok(h.includes(s), s);
  assert.ok(!W.logHtml(log, { settings: { mode: 'points' } }).includes('🍺'));
  assert.ok(!W.logHtml(log, { settings: { mode: 'drink' } }).includes('点'));
  assert.ok(W.logHtml([], {}).includes('まだ対戦がありません'));
  assert.ok(W.logHtml(undefined, {}).includes('まだ対戦がありません'));
});

test('resultSummary: 誰がどうやって勝ったかを文で返す(見出し・理由・支払い)', () => {
  const H = (type, value, label, mult, lose) => ({ type, value, label, mult, lose });
  const names = { host: 'おやま', child: 'うさ' };
  const pts = { mode: 'points', unit: 10 };
  // 親 6の目 vs 子 ヒフミ → 親の勝ち ×2
  let r = W.resultSummary({ winner: 'parent', mult: 2, parentHand: H('me', 6, '6の目', 1, false), childHand: H('hifumi', 0, 'ヒフミ', 1, true) }, names, pts);
  assert.equal(r.headline, 'おやま の勝ち!');
  assert.ok(r.why.includes('ヒフミ') && r.why.includes('2倍'), r.why);
  assert.equal(r.pay, 'うさ → おやま に 20点');
  // 親 2の目 vs 子 4ゾロ → 子の勝ち ×3(強い役が勝つ)
  r = W.resultSummary({ winner: 'child', mult: 3, parentHand: H('me', 2, '2の目', 1, false), childHand: H('zoro', 4, '4ゾロ', 3, false) }, names, pts);
  assert.equal(r.headline, 'うさ の勝ち!');
  assert.equal(r.why, '4ゾロ(×3) ＞ 2の目(×1)');
  assert.equal(r.pay, 'おやま → うさ に 30点');
  // 親がションベンで子は振らず
  r = W.resultSummary({ winner: 'child', mult: 1, parentHand: H('shonben', 0, 'ションベン', 1, true), childHand: null }, names, pts);
  assert.ok(r.why.includes('ションベン') && r.why.includes('振らず'), r.why);
  // 飲み・両方
  r = W.resultSummary({ winner: 'parent', mult: 2, parentHand: H('shigoro', 0, 'シゴロ', 2, false), childHand: H('me', 5, '5の目', 1, false) }, names, { mode: 'drink', drinkUnit: 'sip' });
  assert.equal(r.pay, 'うさ が 1口 × 2 飲む');
  r = W.resultSummary({ winner: 'parent', mult: 2, parentHand: H('shigoro', 0, 'シゴロ', 2, false), childHand: H('me', 5, '5の目', 1, false) }, names, { mode: 'both', unit: 20, drinkUnit: 'half' });
  assert.equal(r.pay, 'うさ → おやま に 40点 ・ うさ が 半分 × 2 飲む');
  assert.equal(r.why, 'シゴロ(×2) ＞ 5の目(×1)');
  // 目なし同士は引き分け
  r = W.resultSummary({ winner: 'draw', mult: 0, parentHand: H('none', 0, '目なし', 1, false), childHand: H('none', 0, '目なし', 1, false) }, names, pts);
  assert.equal(r.headline, '引き分け! もう一度');
  assert.equal(r.why, '目なし 同士'); assert.equal(r.pay, '');
  // 名前は呼び出し側で伏せる前提(そのまま使う)。HTML には入れないので文字列のまま
  r = W.resultSummary({ winner: 'child', mult: 1, parentHand: H('none', 0, '目なし', 1, false), childHand: H('me', 1, '1の目', 1, false) }, { host: '親', child: '？？？' }, pts);
  assert.equal(r.headline, '？？？ の勝ち!'); assert.equal(r.why, '1の目(×1) ＞ 目なし');
});
