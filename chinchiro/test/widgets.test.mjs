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
  assert.ok(!W.legendHtml().includes('目なし'), '目なしは負けではないので順位に出さない');
  const rules = W.rulesHtml({ mode: 'points', unit: 10 });
  assert.ok(rules.includes('振り直し') && !rules.includes('3回振っても') && !rules.includes('3投まで'), rules);
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
