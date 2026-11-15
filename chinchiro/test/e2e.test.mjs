// 画面のテスト(Playwright)。mock 同期とローカル HTTP サーバーで動かす。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { serve } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const T = { timeout: 8000 };
let browser, srv, url;

before(async () => { browser = await chromium.launch(); srv = await serve(); url = srv.url; });
after(async () => { await browser?.close(); await srv?.close(); });

async function newPage(ctx, path, viewport = { width: 390, height: 844 }) {
  const context = ctx || await browser.newContext({ viewport });
  context.setDefaultTimeout(T.timeout);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${url}/${path}`);
  return { page, context, errors };
}

// ---------- サイコロの演出(デモ) ----------
test('デモ: 4,5,6 を投げると3つの立体サイコロが出てシゴロの演出になる', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?demo=1&dice=4,5,6&seed=7');
  await page.locator('#stage .cube').nth(2).waitFor({ state: 'visible', ...T });
  assert.equal(await page.locator('#stage .cube').count(), 3);
  await page.locator('#stage .result-stamp[data-hand="shigoro"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.locator('#stage .result-stamp').innerText(), 'シゴロ!');
  const faces = await page.locator('#stage .cube').evaluateAll((els) => els.map((e) => Number(e.dataset.face)).sort());
  assert.deepEqual(faces, [4, 5, 6]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('デモ: ションベンは1つ器の外へ出て「ションベン!」', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?demo=1&dice=2,3,5&seed=3&shonben=1');
  await page.locator('#stage .result-stamp[data-hand="shonben"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.locator('#stage .result-stamp').innerText(), 'ションベン!');
  assert.equal(await page.locator('#stage .cube.out').count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('デモ: 目なし・ピンゾロ・ヒフミ・目 の文言', async () => {
  const cases = [
    ['1,3,5', 'none', '目なし… あと2投', '&remaining=2'],
    ['1,3,5', 'none', '目なし…', '&remaining=0'],
    ['1,1,1', 'pinzoro', 'ピンゾロ!!', ''],
    ['1,2,3', 'hifumi', 'ヒフミ…', ''],
    ['2,2,5', 'me', '5の目', ''],
    ['6,6,6', 'zoro', '6ゾロ!', ''],
  ];
  for (const [dice, hand, text, extra] of cases) {
    const { page, context } = await newPage(null, `index.html?demo=1&dice=${dice}&seed=5&skip=1${extra}`);
    await page.locator(`#stage .result-stamp[data-hand="${hand}"]`).waitFor({ state: 'visible', ...T });
    assert.equal(await page.locator('#stage .result-stamp').innerText(), text, dice);
    await context.close();
  }
});

test('デモ: タップで演出を飛ばせる(2秒以内に結果)', async () => {
  const { page, context } = await newPage(null, 'index.html?demo=1&dice=2,2,5&seed=9');
  await page.locator('#stage .cube').nth(0).waitFor({ state: 'visible', ...T });
  const t0 = Date.now();
  await page.locator('#stage').click({ position: { x: 20, y: 20 } });
  await page.locator('#stage .result-stamp[data-hand="me"]').waitFor({ state: 'visible', ...T });
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
  await context.close();
});

test('不正な出目でも落ちない: dice=9,0,x → 演出を飛ばして「?」を表示、ページエラーなし', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?demo=1&dice=9,0,x&seed=1');
  await page.locator('#stage .result-stamp[data-hand="invalid"]').waitFor({ state: 'visible', ...T });
  assert.equal(await page.locator('#stage .result-stamp').innerText(), '?');
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------- 親機 ----------
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
async function createRoom(page, { name = '配信者', mode = 'points', unit = '10', drink = 'sip' } = {}) {
  await page.locator('#screen-host-entry').waitFor({ state: 'visible', ...T });
  await page.locator('#host-name').fill(name);
  await page.click(`[data-mode="${mode}"]`);
  await page.click(`[data-unit="${unit}"]`);
  await page.click(`[data-drink="${drink}"]`);
  await page.click('#create-room');
  await page.locator('#screen-host').waitFor({ state: 'visible', ...T });
  return (await page.locator('#room-code').innerText()).trim();
}
const readRoom = (page, code) => page.evaluate((c) => JSON.parse(localStorage.getItem('chinchiro.mock.db')).rooms[c], code);

test('親機: 名前とモードを選んで部屋を作ると、4文字のコードと参加URLが出る', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(page, { mode: 'both', unit: '20', drink: 'half' });
  assert.match(code, CODE_RE);
  assert.ok((await page.locator('#join-url').innerText()).includes(`room=${code}`));
  assert.match(await page.locator('#host-record').innerText(), /100/);
  const room = await readRoom(page, code);
  assert.equal(room.state.phase, 'lobby');
  assert.deepEqual(room.settings, { mode: 'both', unit: 20, drinkUnit: 'half', hostName: '配信者', hostChar: 'momotaro' });
  assert.ok(room.hostUid);
  assert.deepEqual(errors, []);
  await context.close();
});

test('表示専用: ?room=CODE&stage=1 を開くと同じ部屋の状態が見え、ボタンが無い', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(page);
  const stagePage = await context.newPage();
  await stagePage.goto(`${url}/index.html?mock=1&room=${code}&stage=1`);
  await stagePage.locator('#screen-stage').waitFor({ state: 'visible', ...T });
  assert.ok((await stagePage.locator('#screen-stage').innerText()).includes(code));
  assert.equal(await stagePage.locator('#screen-stage button').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('親機: 再読み込みすると「前回の部屋を続ける」で同じコードに戻る', async () => {
  const { page, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(page);
  await page.reload();
  await page.locator('#resume-room').waitFor({ state: 'visible', ...T });
  await page.click('#resume-room');
  await page.locator('#screen-host').waitFor({ state: 'visible', ...T });
  assert.equal((await page.locator('#room-code').innerText()).trim(), code);
  await context.close();
});
