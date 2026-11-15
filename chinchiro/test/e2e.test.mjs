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

// ---------- リスナー ----------
async function openListener(context, code, extra = '') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${url}/index.html?mock=1&room=${code}${extra}`);
  return { page, errors };
}
async function joinAs(context, code, name, char) {
  const { page, errors } = await openListener(context, code);
  await page.locator('#screen-join').waitFor({ state: 'visible', ...T });
  await page.locator('#join-name').fill(name);
  if (char) {
    await page.locator('#join-avatar').click();
    await page.click(`#screen-pick .pick[data-char="${char}"]`);
    await page.locator('#screen-join').waitFor({ state: 'visible', ...T });
  }
  await page.click('#join-challenge');
  await page.locator('#screen-listener').waitFor({ state: 'visible', ...T });
  return { page, errors };
}

test('リスナー: 名前とキャラを入れて挑戦すると、親機の順番待ちに出る', async () => {
  const { page: host, context, errors } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  const a = await joinAs(context, code, 'うさ', 'kappa');
  await host.locator('#queue .queue-row').first().waitFor({ state: 'visible', ...T });
  assert.equal(await host.locator('#queue .queue-row').count(), 1);
  assert.ok((await host.locator('#queue .queue-row .qname').first().innerText()).includes('うさ'));
  assert.equal(await host.locator('#queue .queue-row .avatar svg').count(), 1);
  assert.match(await a.page.locator('#my-status').innerText(), /1 番目/);
  const b = await joinAs(context, code, 'たろ', 'akaoni');
  await b.page.locator('#my-status').filter({ hasText: '2 番目' }).waitFor({ state: 'visible', ...T });
  await host.locator('#queue .queue-row').nth(1).waitFor({ state: 'visible', ...T });
  const room = await readRoom(host, code);
  assert.equal(Object.keys(room.players).length, 2);
  assert.equal(Object.keys(room.queue).length, 2);
  const me = Object.values(room.players).find((p) => p.name === 'うさ');
  assert.equal(me.char, 'kappa');
  assert.equal(me.online, true);
  assert.equal(me.points, undefined, 'リスナーは自分の点数を書かない');
  assert.deepEqual(errors.concat(a.errors, b.errors), []);
  await context.close();
});

test('名前の HTML はエスケープ: <b>x</b> が文字のまま出る', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  await joinAs(context, code, '<b>x</b>');
  await host.locator('#queue .queue-row').first().waitFor({ state: 'visible', ...T });
  assert.ok((await host.locator('#queue .queue-row .qname').first().innerText()).includes('<b>x</b>'));
  assert.equal(await host.locator('#queue .queue-row .qname b').count(), 0);
  await context.close();
});

test('親機の「ブロック」で列から消え、本人は「参加できません」になる。「非表示」で名前が？？？になる', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  const a = await joinAs(context, code, 'あらし');
  const b = await joinAs(context, code, 'ふつう');
  await host.locator('#queue .queue-row').nth(1).waitFor({ state: 'visible', ...T });
  await host.locator('#queue .queue-row').first().locator('[data-act="hide"]').click();
  await host.locator('#queue .queue-row .qname').filter({ hasText: '？？？' }).waitFor({ state: 'visible', ...T });
  await host.locator('#queue .queue-row').first().locator('[data-act="ban"]').click();
  await host.locator('#queue .queue-row').filter({ hasText: 'ふつう' }).waitFor({ state: 'visible', ...T });
  assert.equal(await host.locator('#queue .queue-row').count(), 1);
  await a.page.locator('#screen-banned').waitFor({ state: 'visible', ...T });
  assert.match(await b.page.locator('#my-status').innerText(), /1 番目/);
  await context.close();
});

test('満員: presence が 80 ある部屋を見るだけで開くと満員表示', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  await host.evaluate((c) => {
    const db = JSON.parse(localStorage.getItem('chinchiro.mock.db'));
    db.rooms[c].presence = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`ghost${i}`, true]));
    localStorage.setItem('chinchiro.mock.db', JSON.stringify(db));
  }, code);
  const { page } = await openListener(context, code);
  await page.locator('#screen-full').waitFor({ state: 'visible', ...T });
  const room = await readRoom(host, code);
  assert.equal(Object.keys(room.presence).length, 80, '満員のときは自分の presence を書かない');
  await context.close();
});
