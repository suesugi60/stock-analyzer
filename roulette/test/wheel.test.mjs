// 盤の絵(SVG の文字列)と音の下ごしらえのテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWheel, loadLogic } from './helpers.mjs';

const W = loadWheel();
const L = loadLogic();
const count = (s, re) => (s.match(re) || []).length;

test('wheelSvg: 項目の数だけ扇形と文字が出る。色は隣どうしで違う', () => {
  const segs = [{ t: 'あ', w: 1 }, { t: 'い', w: 2 }, { t: 'う', w: 1 }];
  const svg = W.wheelSvg(segs);
  assert.equal(count(svg, /<path class="seg"/g), 3);
  assert.equal(count(svg, /<text class="lbl"/g), 3);
  assert.ok(svg.includes(`fill="${L.COLORS[0]}"`) && svg.includes(`fill="${L.COLORS[1]}"`));
  assert.equal(count(svg, /win-ring/g), 0);
});

test('wheelSvg: 当たった項目だけ目立たせ、囲む線を 1 本引く', () => {
  const segs = [{ t: 'あ', w: 1 }, { t: 'い', w: 1 }, { t: 'う', w: 1 }];
  const svg = W.wheelSvg(segs, { win: 1 });
  assert.equal(count(svg, /class="seg win"/g), 1);
  assert.equal(count(svg, /class="seg dim"/g), 2);
  assert.equal(count(svg, /class="win-ring"/g), 1);
  assert.equal(count(svg, /class="lbl dim"/g), 2);
});

test('wheelSvg: 文字はそのまま文字として出す(タグにならない)', () => {
  const svg = W.wheelSvg([{ t: '<img src=x onerror=alert(1)>', w: 1 }, { t: 'a&b"c', w: 1 }]);
  assert.ok(!svg.includes('<img'));
  assert.ok(svg.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(svg.includes('a&amp;b&quot;c'));
});

test('wheelSvg: 項目が無いときは案内、1 つだけのときは丸', () => {
  const empty = W.wheelSvg([], { empty: '項目を入れてね' });
  assert.ok(empty.includes('項目を入れてね'));
  assert.equal(count(empty, /class="seg/g), 0);
  const one = W.wheelSvg([{ t: 'ひとり', w: 1 }]);
  assert.equal(count(one, /<circle class="seg"/g), 1);
});

test('labelSize: 長い文字・細い扇形ほど小さくなり、半角は全角より大きく入る', () => {
  assert.ok(W.labelSize('あたり', 60) > W.labelSize('とてもとても長い項目のなまえ', 60));
  assert.ok(W.labelSize('あたり', 60) > W.labelSize('あたり', 6));
  assert.ok(W.labelSize('abc', 30) >= W.labelSize('あいう', 30));
  assert.ok(W.labelSize('あ'.repeat(40), 3) >= 1.5);
});

test('silentWav: 正しい形の無音 WAV(data URI)になる', () => {
  const uri = W.silentWav(0.5);
  assert.ok(uri.startsWith('data:audio/wav;base64,'));
  const bytes = Buffer.from(uri.split(',')[1], 'base64');
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString(), 'WAVE');
  assert.equal(bytes.length, 44 + 4000);
  assert.ok(bytes.subarray(44).every((b) => b === 0x80));
});
