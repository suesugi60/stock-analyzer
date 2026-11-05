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
