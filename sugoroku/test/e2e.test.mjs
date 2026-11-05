// 画面のスモークテスト(Playwright)。node --test sugoroku/test/e2e.test.mjs で実行。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// 環境にプリインストールされた playwright は require でしか解決できない
const { chromium } = createRequire(import.meta.url)('playwright');
import { INDEX_HTML } from './helpers.mjs';

const URL = 'file://' + INDEX_HTML;
const T = { timeout: 8000 };
let browser;

before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  ctx.setDefaultTimeout(T.timeout);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);
  return { page, ctx, errors };
}

async function setupAndStart(page, names = ['あきら', 'いくみ', 'うみ'], size = '16', diff = 'normal') {
  await page.click(`[data-size="${size}"]`);
  await page.click(`[data-diff="${diff}"]`);
  while ((await page.locator('.player-name').count()) < names.length) await page.click('#add-player');
  for (let i = 0; i < names.length; i++) await page.locator('.player-name').nth(i).fill(names[i]);
  await page.click('#start');
  // キャラ選択画面: 各プレイヤーが順にキャラをタップする(今のキャラをそのまま選ぶ)
  for (let i = 0; i < names.length; i++) {
    await page.locator('#screen-pick').waitFor({ state: 'visible', ...T });
    await page.locator('#screen-pick .pick.selected').click();
  }
  await page.locator('#screen-play').waitFor({ state: 'visible', ...T });
}

test('セットアップ → 振る → 指令カード → OK で次の人の手番になる', async () => {
  const { page, ctx, errors } = await newPage();
  await setupAndStart(page);
  assert.match(await page.locator('#turn-name').innerText(), /あきら/);
  assert.equal(await page.locator('.tile').count(), 16);

  await page.click('#roll');
  await page.locator('#card').waitFor({ state: 'visible', ...T });
  assert.ok((await page.locator('#card-text').innerText()).length > 0);
  await page.click('#card-ok');
  await page.locator('#card').waitFor({ state: 'hidden', ...T });
  assert.match(await page.locator('#turn-name').innerText(), /いくみ/);
  // 駒がボード上に表示されている
  assert.equal(await page.locator('.token').count(), 3);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('リロードしても「続きから」で復帰できる', async () => {
  const { page, ctx } = await newPage();
  await setupAndStart(page);
  await page.click('#roll');
  await page.locator('#card').waitFor({ state: 'visible', ...T });
  await page.click('#card-ok');
  await page.locator('#card').waitFor({ state: 'hidden', ...T });

  await page.reload();
  await page.locator('#resume').waitFor({ state: 'visible', ...T });
  await page.click('#resume');
  await page.locator('#screen-play').waitFor({ state: 'visible', ...T });
  assert.match(await page.locator('#turn-name').innerText(), /いくみ/);
  await ctx.close();
});

test('終了ボタンで結果画面に全員の順位が出る', async () => {
  const { page, ctx } = await newPage();
  page.on('dialog', (d) => d.accept());
  await setupAndStart(page, ['A', 'B'], '100', 'oni');
  assert.equal(await page.locator('.tile').count(), 100);
  await page.click('#end');
  await page.locator('#screen-result').waitFor({ state: 'visible', ...T });
  // 上位3人は表彰台、それ以外は順位の行。合わせて全員分
  const spots = await page.locator('.podium .spot').count();
  const rows = await page.locator('.rank-row').count();
  assert.equal(spots + rows, 2);
  assert.equal(await page.locator('.podium .avatar[data-char]').count(), 2);
  await ctx.close();
});

test('マスをタップすると指令が見える', async () => {
  const { page, ctx } = await newPage();
  await setupAndStart(page, ['A', 'B'], '32', 'hard');
  await page.locator('.tile[data-index="5"]').click();
  await page.locator('#peek').waitFor({ state: 'visible', ...T });
  const txt = await page.locator('#peek').innerText();
  assert.ok(txt.length > 0);
  await ctx.close();
});

test('マスは蛇行の向きに線路でつながり、ゴールには線路が出ない', async () => {
  const { page, ctx } = await newPage(); // 390px 幅 → 16マスは4列
  await setupAndStart(page, ['A', 'B'], '16');
  const cls = async (i) => (await page.locator(`.tile[data-index="${i}"]`).getAttribute('class')).split(/\s+/);
  assert.ok((await cls(0)).includes('link-right'), 'START は右へ');
  assert.ok((await cls(3)).includes('link-down'), '行末は下へ');
  assert.ok((await cls(4)).includes('link-left'), '2行目は左へ');
  assert.ok((await cls(7)).includes('link-down'), '2行目の行末は下へ');
  assert.ok((await cls(8)).includes('link-right'), '3行目は右へ');
  assert.ok(!(await cls(15)).some((c) => c.startsWith('link-')), 'GOAL からは出ない');
  await ctx.close();
});

test('サイコロを振ると出目のピップが表示される', async () => {
  const { page, ctx } = await newPage();
  await setupAndStart(page, ['A', 'B'], '16');
  await page.click('#roll');
  await page.locator('#card').waitFor({ state: 'visible', ...T });
  const face = Number(await page.locator('#die').getAttribute('data-face'));
  assert.ok(face >= 1 && face <= 6, `data-face=${face}`);
  assert.equal(await page.locator('#die .pip').count(), face);
  await ctx.close();
});

test('スタート後にキャラ選択画面が出て、選んだキャラが駒と手番表示に出る', async () => {
  const { page, ctx, errors } = await newPage();
  await page.locator('.player-name').nth(0).fill('A');
  await page.locator('.player-name').nth(1).fill('B');
  await page.click('#start');

  // 1人目: A さんの番。12体から kappa を選ぶ
  await page.locator('#screen-pick').waitFor({ state: 'visible', ...T });
  assert.match(await page.locator('#pick-title').innerText(), /A/);
  assert.equal(await page.locator('#screen-pick .pick').count(), 12);
  await page.click('#screen-pick .pick[data-char="kappa"]');

  // 2人目: B さんの番。kappa は選べない
  await page.locator('#pick-title').filter({ hasText: 'B' }).waitFor({ state: 'visible', ...T });
  assert.ok(await page.locator('#screen-pick .pick[data-char="kappa"]').isDisabled());
  await page.click('#screen-pick .pick[data-char="momotaro"]');

  await page.locator('#screen-play').waitFor({ state: 'visible', ...T });
  assert.equal(await page.locator('.token[data-char="kappa"]').count(), 1);
  assert.equal(await page.locator('.token[data-char="momotaro"]').count(), 1);
  assert.equal(await page.locator('#turn-avatar').getAttribute('data-char'), 'kappa');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('セットアップの顔をタップすると、その人だけキャラを選び直してセットアップに戻る', async () => {
  const { page, ctx } = await newPage();
  await page.locator('.player-avatar').nth(1).click();
  await page.locator('#screen-pick').waitFor({ state: 'visible', ...T });
  await page.click('#screen-pick .pick[data-char="binbo"]');
  await page.locator('#screen-setup').waitFor({ state: 'visible', ...T });
  assert.equal(await page.locator('.player-avatar').nth(1).getAttribute('data-char'), 'binbo');
  await ctx.close();
});

test('サイコロを振ると器のシーンが出て、立体のサイコロが転がってから指令カードになる', async () => {
  const { page, ctx, errors } = await newPage();
  await setupAndStart(page, ['A', 'B'], '16');
  await page.click('#roll');
  await page.locator('#dice-overlay').waitFor({ state: 'visible', ...T });
  assert.equal(await page.locator('#dice-overlay .cube .face').count(), 6);
  assert.match(await page.locator('#dice-thrower-name').innerText(), /A/);
  await page.locator('#card').waitFor({ state: 'visible', ...T });
  await page.locator('#dice-overlay').waitFor({ state: 'hidden', ...T });
  const face = Number(await page.locator('#die').getAttribute('data-face'));
  assert.equal(await page.locator('#dice-result').innerText(), `${face}!`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('器のシーンをタップすると演出を飛ばせる', async () => {
  const { page, ctx } = await newPage();
  await setupAndStart(page, ['A', 'B'], '16');
  await page.click('#roll');
  await page.locator('#dice-overlay').waitFor({ state: 'visible', ...T });
  const t0 = Date.now();
  await page.locator('#dice-overlay').click({ position: { x: 10, y: 10 } });
  await page.locator('#card').waitFor({ state: 'visible', ...T });
  assert.ok(Date.now() - t0 < 2500, `スキップ後 ${Date.now() - t0}ms かかった`);
  await ctx.close();
});

test('順番に選ぶとき、まだ選んでいない後の人の仮キャラは選べる(先に選んだ人のキャラだけ選べない)', async () => {
  const { page, ctx } = await newPage();
  await page.click('#add-player'); // 3人。仮は momotaro / kintaro / urashima
  await page.click('#start');
  await page.locator('#screen-pick').waitFor({ state: 'visible', ...T });
  assert.ok(!(await page.locator('#screen-pick .pick[data-char="urashima"]').isDisabled()), '3人目の仮キャラを1人目が選べる');
  await page.click('#screen-pick .pick[data-char="urashima"]');
  // 2人目: urashima は選べない
  await page.locator('#pick-title').filter({ hasText: '2/3' }).waitFor({ state: 'visible', ...T });
  assert.ok(await page.locator('#screen-pick .pick[data-char="urashima"]').isDisabled());
  await page.locator('#screen-pick .pick.selected').click();
  // 3人目: 仮キャラが別のものに振り直されていて、urashima は選べない
  await page.locator('#pick-title').filter({ hasText: '3/3' }).waitFor({ state: 'visible', ...T });
  assert.notEqual(await page.locator('#pick-avatar').getAttribute('data-char'), 'urashima');
  assert.ok(await page.locator('#screen-pick .pick[data-char="urashima"]').isDisabled());
  assert.equal(await page.locator('#screen-pick .pick.selected').count(), 1);
  await page.locator('#screen-pick .pick.selected').click();
  await page.locator('#screen-play').waitFor({ state: 'visible', ...T });
  assert.equal(await page.locator('.token[data-char="urashima"]').count(), 1);
  await ctx.close();
});
