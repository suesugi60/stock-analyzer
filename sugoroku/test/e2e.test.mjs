// 画面のスモークテスト(Playwright)。node --test sugoroku/test/e2e.test.mjs で実行。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// 環境にプリインストールされた playwright は require でしか解決できない
const { chromium } = createRequire(import.meta.url)('playwright');
import { INDEX_HTML } from './helpers.mjs';

const URL = 'file://' + INDEX_HTML;
const T = { timeout: 4000 };
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
  assert.equal(await page.locator('.rank-row').count(), 2);
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
