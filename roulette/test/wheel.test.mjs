// 盤とテーブルの絵(文字列)と、音の下ごしらえのテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWheel, loadLogic } from './helpers.mjs';

const W = loadWheel();
const L = loadLogic();
const count = (s, re) => (s.match(re) || []).length;

test('wheelSvg: 37 マスが色つきで並び、数字が 1 回ずつ書かれる', () => {
  const svg = W.wheelSvg();
  assert.equal(count(svg, /class="pocket /g), 37);
  assert.equal(count(svg, /class="pocket red"/g), 18);
  assert.equal(count(svg, /class="pocket black"/g), 18);
  assert.equal(count(svg, /class="pocket green"/g), 1);
  for (let n = 0; n <= 36; n++) assert.equal(count(svg, new RegExp(`dy="\\.36em">${n}</text>`, 'g')), 1, `数字 ${n}`);
  assert.equal(count(svg, /win-ring/g), 0);
});

test('wheelSvg: 出た数字のマスだけを囲む', () => {
  const svg = W.wheelSvg(17);
  assert.equal(count(svg, /class="win-ring"/g), 1);
  const pocket = /<path class="pocket black" data-n="17" d="([^"]+)"/.exec(svg)[1];
  assert.ok(svg.includes(`class="win-ring" d="${pocket}"`), '囲む線は 17 のマスと同じ形');
});

test('tableHtml: 賭ける場所が 49 個あり、数字は赤 18・黒 18・みどり 1', () => {
  const html = W.tableHtml({ interactive: true });
  assert.equal(count(html, /data-spot="/g), 49);
  for (let s = 0; s < L.SPOT_COUNT; s++) assert.equal(count(html, new RegExp(`data-spot="${s}"`, 'g')), 1, `場所 ${s}`);
  assert.equal(count(html, /class="cell num red/g), 18);
  assert.equal(count(html, /class="cell num black/g), 18);
  assert.equal(count(html, /class="cell num green/g), 1);
  assert.equal(count(html, /disabled/g), 0);
  assert.equal(count(W.tableHtml({}), /disabled/g), 49, '押せないときは全部の場所が無効');
});

test('tableHtml: 数字 n は「たて (n−1)%3 列目」に並ぶ(下の「たて1列」と同じ列)', () => {
  const html = W.tableHtml({});
  const colOf = (spot) => Number(new RegExp(`data-spot="${spot}" data-base="[^"]*" style="grid-row:[^;]+;grid-column:(\\d)`).exec(html)[1]);
  for (let n = 1; n <= 36; n++) {
    const c = (n - 1) % 3;
    assert.equal(colOf(n), colOf(L.SPOT.COLUMN + c), `数字 ${n}`);
    assert.equal(L.spotWins(L.SPOT.COLUMN + c, n), true);
  }
});

test('tableHtml: 自分のチップ(ピンク)と、ほかの人の合計(白)を分けて出す', () => {
  const html = W.tableHtml({ mine: { 17: 30 }, totals: { 17: { sum: 130, count: 3 }, 5: { sum: 50, count: 1 } } });
  const cell = (spot) => new RegExp(`data-spot="${spot}"[^>]*>(.*?)</button>`).exec(html)[1];
  assert.ok(cell(17).includes('<span class="chip mine" data-v="30">30</span>'));
  assert.ok(cell(17).includes('<span class="chip all" data-v="100">100</span>'), 'ほかの人 = 合計 130 − 自分 30');
  assert.ok(cell(5).includes('<span class="chip all" data-v="50">50</span>'));
  assert.ok(!cell(5).includes('chip mine'));
  assert.ok(!cell(6).includes('class="chip '), '賭けの無い場所にはチップを出さない');
});

test('tableHtml: 結果が出たら、当たった場所だけ光る(17 → 17・黒・奇数・1〜18・13〜24・たて2列目)', () => {
  const html = W.tableHtml({ win: 17 });
  const wins = [...html.matchAll(/class="cell [^"]* win[^"]*" data-spot="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  assert.deepEqual(wins, [17, L.SPOT.BLACK, L.SPOT.ODD, L.SPOT.LOW, L.SPOT.DOZEN + 1, L.SPOT.COLUMN + 1].sort((a, b) => a - b));
  assert.equal(count(html, / lose/g), 49 - 6);
  assert.ok(html.includes('class="rtable settled"'));
  assert.equal(count(W.tableHtml({ win: 0 }), / win/g), 1, '0 のときは 0 だけ');
});

test('renderTable: 2 回目からはボタンを作り直さず、変わったところだけ書きかえる', () => {
  // DOM の代わりになる最小限の入れ物(firstElementChild / querySelectorAll / innerHTML)
  const made = [];
  const container = {
    firstElementChild: null,
    set innerHTML(html) {
      made.push(html);
      const cells = [...html.matchAll(/<button type="button" class="([^"]*)" data-spot="(\d+)" data-base="([^"]*)"[^>]*?( disabled)?\s+aria-label/g)].map((m) => {
        const box = { innerHTML: '', __last: undefined };
        return { className: m[1], dataset: { spot: m[2], base: m[3] }, disabled: !!m[4], lastElementChild: box };
      });
      this.firstElementChild = { className: /^<div class="([^"]*)"/.exec(html)[1], classList: { contains: (c) => c === 'rtable' }, querySelectorAll: () => cells, cells };
    },
  };
  W.renderTable(container, { interactive: true });
  assert.equal(made.length, 1);
  const cell17 = container.firstElementChild.cells.find((c) => c.dataset.spot === '17');
  W.renderTable(container, { interactive: true, mine: { 17: 20 }, totals: { 17: { sum: 20, count: 1 } } });
  assert.equal(made.length, 1, '作り直さない');
  assert.ok(cell17.className.includes('has-mine'));
  assert.equal(cell17.lastElementChild.innerHTML, '<span class="chip mine" data-v="20">20</span>');
  W.renderTable(container, { interactive: false, win: 17 });
  assert.ok(cell17.className.includes(' win') && !cell17.className.includes('has-mine'));
  assert.equal(cell17.disabled, true);
  assert.equal(container.firstElementChild.className, 'rtable settled');
});

test('shortAmount: 大きな数は短く書く', () => {
  assert.equal(W.shortAmount(10), '10');
  assert.equal(W.shortAmount(990), '990');
  assert.equal(W.shortAmount(1000), '1千');
  assert.equal(W.shortAmount(1550), '1.5千');
  assert.equal(W.shortAmount(12000), '1.2万');
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
