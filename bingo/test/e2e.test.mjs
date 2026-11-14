// 画面のテスト(Playwright)。node --test test/e2e.test.mjs で実行。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, closeAll, fresh, joinPlayer, grant, Client, HOST_PASSWORD } from './helpers.mjs';
// 環境にプリインストールされた playwright は require でしか解決できない
const { chromium } = createRequire(import.meta.url)('playwright');

const PHONE = { width: 390, height: 844 };
const TIMEOUT = 8000;
let server;
let browser;
const contexts = [];

before(async () => {
  server = await startServer();
  browser = await chromium.launch();
});
after(async () => {
  closeAll();
  await browser?.close();
  await server?.stop();
  assert.doesNotMatch(server.log(), /Uncaught|\[ERROR\]/);
});
afterEach(async () => {
  closeAll();
  for (const ctx of contexts.splice(0)) await ctx.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 新しいブラウザ(別の人)でページを開く。エラーは errors に集まる。
// motion: true にすると抽選の演出が出る。既定は「動きを減らす」設定(演出なし)。
async function openPage(path = '/', { viewport = PHONE, context, motion = false } = {}) {
  const ctx = context ?? (await browser.newContext({ viewport, reducedMotion: motion ? 'no-preference' : 'reduce' }));
  if (!context) contexts.push(ctx);
  ctx.setDefaultTimeout(TIMEOUT);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(server.http + path);
  return { page, ctx, errors };
}

// 画面から申請し、主催者役(WebSocket)が許可する。
async function seat(host, page, name, count, approve = count) {
  await page.fill('#name', name);
  await page.fill('#count', String(count));
  await page.click('#request-btn');
  const { req } = await host.next('req_add');
  host.send({ t: 'approve', id: req.id, count: approve });
  await host.next('req_del');
  await page.locator('#cards .card').nth(approve - 1).waitFor();
  return req;
}

// カードの数字を画面から読む(25個。中央は 0)。
async function readCard(page, no = 1) {
  const texts = await page.locator(`#cards .card[data-no="${no}"] .cell`).allTextContents();
  return texts.map((t) => (t.trim() === 'FREE' ? 0 : Number(t.trim())));
}

async function markedIndexes(page, no = 1) {
  return page.locator(`#cards .card[data-no="${no}"] .cell`).evaluateAll(
    (cells) => cells.map((c, i) => (c.classList.contains('marked') ? i : -1)).filter((i) => i >= 0));
}

async function call(host, n) {
  host.send({ t: 'call', n });
  await host.next('host');
}

// ---- リスナー画面 ----

test('リスナー: 受付前は申請できない', async () => {
  const { c: host } = await fresh(server);
  host.send({ t: 'accepting', on: false });
  await host.next('host');
  const { page, errors } = await openPage();
  await page.locator('#status', { hasText: 'いまは受付していません' }).waitFor();
  assert.equal(await page.locator('#request-btn').isDisabled(), true);
  // 受付が始まると、そのまま申請できるようになる
  host.send({ t: 'accepting', on: true });
  await page.locator('#request-btn:not([disabled])').waitFor();
  assert.deepEqual(errors, []);
});

test('リスナー: 申請から許可まで', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage();
  await page.locator('#conn', { hasText: '接続中' }).waitFor();
  await page.fill('#name', 'たろう');
  await page.fill('#count', '3');
  await page.click('#request-btn');
  const status = page.locator('#status');
  await status.filter({ hasText: '許可を待っています' }).waitFor();
  assert.match(await status.textContent(), /3枚/);
  assert.equal(await page.locator('#cards .card').count(), 0);

  const { req } = await host.next('req_add');
  assert.deepEqual({ name: req.name, count: req.count }, { name: 'たろう', count: 3 });
  host.send({ t: 'approve', id: req.id, count: 3 });
  await page.locator('#cards .card').nth(2).waitFor();
  assert.equal(await page.locator('#cards .card').count(), 3);
  for (const no of [1, 2, 3]) {
    const cells = page.locator(`#cards .card[data-no="${no}"] .cell`);
    assert.equal(await cells.count(), 25);
    assert.equal((await cells.nth(12).textContent()).trim(), 'FREE');
    assert.deepEqual(await markedIndexes(page, no), [12]);
  }
  assert.match(await page.locator('#summary').textContent(), /たろう/);
  assert.match(await page.locator('#summary').textContent(), /3枚/);
  assert.deepEqual(errors, []);
});

test('リスナー: 番号で穴が開き、リーチ、ビンゴと進む', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage();
  await seat(host, page, 'たろう', 1);
  const row = (await readCard(page)).slice(0, 5);

  await call(host, row[0]);
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor();
  assert.deepEqual(await markedIndexes(page), [0, 12]);
  assert.match(await page.locator('#current').textContent(), new RegExp(`\\b${row[0]}\\b`));
  assert.match(await page.locator('#drawn-count').textContent(), /1個目/);
  assert.match(await page.locator('#history').textContent(), new RegExp(`\\b${row[0]}\\b`));

  for (const n of row.slice(1, 4)) await call(host, n);
  await page.locator('#cards .card[data-no="1"].reach').waitFor();
  assert.equal(await page.locator('#winners li').count(), 0);

  await call(host, row[4]);
  await page.locator('#cards .card[data-no="1"].bingo').waitFor();
  await page.locator('#winners li', { hasText: 'たろう' }).waitFor();
  assert.deepEqual(await markedIndexes(page), [0, 1, 2, 3, 4, 12]);
  assert.match(await page.locator('#drawn-count').textContent(), /5個目/);
  assert.deepEqual(errors, []);
});

test('リスナー: 再読み込みしてもカードと穴が残る', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage();
  await seat(host, page, 'たろう', 3);
  const before = [await readCard(page, 1), await readCard(page, 2), await readCard(page, 3)];
  await call(host, before[0][0]);
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor();

  await page.reload();
  await page.locator('#cards .card').nth(2).waitFor();
  assert.deepEqual([await readCard(page, 1), await readCard(page, 2), await readCard(page, 3)], before);
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor();
  assert.deepEqual(await markedIndexes(page, 1), [0, 12]);
  assert.match(await page.locator('#summary').textContent(), /たろう/);
  assert.deepEqual(errors, []);
});

test('リスナー: 却下と取り消しの表示', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage();
  await page.fill('#name', 'たろう');
  await page.click('#request-btn');
  const { req } = await host.next('req_add');
  host.send({ t: 'reject', id: req.id });
  await page.locator('#status', { hasText: '今回は見送られました' }).waitFor();
  assert.equal(await page.inputValue('#name'), 'たろう');

  await page.click('#request-btn');
  await host.next('req_add');
  await page.locator('#status', { hasText: '許可を待っています' }).waitFor();
  assert.equal(await page.locator('#form').isVisible(), false);
  await page.click('#cancel-btn');
  await host.next('req_del');
  await page.locator('#form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#cancel-btn').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('リスナー: カードを持ったあとの追加申請', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage();
  await seat(host, page, 'たろう', 1);
  assert.equal(await page.locator('#form').isVisible(), false);
  await page.click('#more-btn');
  assert.equal(await page.locator('#name').isVisible(), false);
  await page.fill('#count', '2');
  await page.click('#request-btn');
  const { req } = await host.next('req_add');
  assert.deepEqual({ name: req.name, count: req.count }, { name: 'たろう', count: 2 });
  await page.locator('#status', { hasText: '許可を待っています' }).waitFor();
  host.send({ t: 'approve', id: req.id, count: 2 });
  await page.locator('#cards .card').nth(2).waitFor();
  assert.equal(await page.locator('#cards .card').count(), 3);
  assert.deepEqual(errors, []);
});

test('リスナー: 入力の誤りはその場で知らせる', async () => {
  await fresh(server);
  const { page, errors } = await openPage();
  await page.fill('#name', '   ');
  await page.click('#request-btn');
  await page.locator('#toast', { hasText: '名前' }).waitFor();
  await page.fill('#name', 'たろう');
  await page.fill('#count', '99');
  await page.click('#request-btn');
  await page.locator('#toast', { hasText: '50' }).waitFor();
  assert.deepEqual(errors, []);
});

test('リスナー: 反映の遅れを設定すると、その秒数のあとで番号が出る', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage();
  await seat(host, page, 'たろう', 1);
  const row = (await readCard(page)).slice(0, 5);
  await call(host, row[0]);
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor();

  host.send({ t: 'delay', sec: 3 });
  await host.next('host');
  await call(host, row[1]);
  await sleep(1200);
  assert.deepEqual(await markedIndexes(page), [0, 12]);
  assert.match(await page.locator('#current').textContent(), new RegExp(`\\b${row[0]}\\b`));
  assert.match(await page.locator('#drawn-count').textContent(), /1個目/);
  await sleep(2600);
  assert.deepEqual(await markedIndexes(page), [0, 1, 12]);
  assert.match(await page.locator('#current').textContent(), new RegExp(`\\b${row[1]}\\b`));

  // 待っている途中で開き直しても、残りの時間だけ待つ
  await call(host, row[2]);
  await page.reload();
  await page.locator('#cards .card').first().waitFor();
  await sleep(600);
  assert.deepEqual(await markedIndexes(page), [0, 1, 12]);
  await sleep(3200);
  assert.deepEqual(await markedIndexes(page), [0, 1, 2, 12]);
  assert.deepEqual(errors, []);
});

test('リスナー: 遅れの途中で取り消された番号は表示しない', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage();
  await seat(host, page, 'たろう', 1);
  const row = (await readCard(page)).slice(0, 5);
  host.send({ t: 'delay', sec: 3 });
  await host.next('host');
  await call(host, row[0]);
  host.send({ t: 'undo' });
  await host.next('host');
  await sleep(4000);
  assert.deepEqual(await markedIndexes(page), [12]);
  assert.doesNotMatch(await page.locator('#current').textContent(), /\d/);
  assert.deepEqual(errors, []);
});

test('リスナー: 切断中に発表された番号が、復帰後に操作なしで反映される', async () => {
  const { c: host } = await fresh(server);
  const ctx = await browser.newContext({ viewport: PHONE, reducedMotion: 'reduce' });
  contexts.push(ctx);
  const page = await ctx.newPage();
  ctx.setDefaultTimeout(TIMEOUT);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let offline = false;
  const open = new Set();
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (offline) { ws.close(); return; }
    const upstream = ws.connectToServer();
    open.add({ ws, upstream });
  });
  await page.goto(server.http + '/');
  await seat(host, page, 'たろう', 1);
  const row = (await readCard(page)).slice(0, 5);

  offline = true;
  for (const c of open) { c.ws.close(); c.upstream.close(); }
  open.clear();
  await page.locator('#conn', { hasText: '再接続中' }).waitFor();
  await call(host, row[0]);
  await sleep(500);
  assert.deepEqual(await markedIndexes(page), [12]);

  offline = false;
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor({ timeout: 12000 });
  assert.deepEqual(await markedIndexes(page), [0, 12]);
  await page.locator('#conn', { hasText: '接続中' }).waitFor();
  assert.deepEqual(errors, []);
});

test('リスナー: 止まった接続のまま画面に戻っても、取り直して最新になる', async () => {
  const { c: host } = await fresh(server);
  const ctx = await browser.newContext({ viewport: PHONE, reducedMotion: 'reduce' });
  contexts.push(ctx);
  const page = await ctx.newPage();
  ctx.setDefaultTimeout(TIMEOUT);
  // サーバーからの通知が届かなくなった接続(アプリを切り替えて放置されたスマホ)を真似る
  const conns = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const conn = { dead: false };
    conns.push(conn);
    const upstream = ws.connectToServer();
    upstream.onMessage((m) => { if (!conn.dead) ws.send(m); });
  });
  await page.goto(server.http + '/');
  await seat(host, page, 'たろう', 1);
  const row = (await readCard(page)).slice(0, 5);

  for (const conn of conns) conn.dead = true;
  await call(host, row[0]);
  await sleep(500);
  assert.deepEqual(await markedIndexes(page), [12]);

  // 画面に戻った合図。返事が来ないので、つなぎ直して取り直す。
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor({ timeout: 12000 });
  assert.deepEqual(await markedIndexes(page), [0, 12]);
});

test('リスナー: 引き継ぎリンクを別のブラウザで開くと同じカードが出る', async () => {
  const { c: host } = await fresh(server);
  const ctx = await browser.newContext({ viewport: PHONE, reducedMotion: 'reduce' });
  contexts.push(ctx);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { page, errors } = await openPage('/', { context: ctx });
  await seat(host, page, 'たろう', 2);
  const cards = [await readCard(page, 1), await readCard(page, 2)];

  await page.click('#copy-link');
  await page.locator('#toast', { hasText: 'コピーしました' }).waitFor();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /#k=[0-9a-f]{64}$/);
  assert.equal(await page.inputValue('#link-text'), link);

  // 何も持っていない別のブラウザ
  const other = await openPage(link.replace(server.http, ''));
  await other.page.locator('#cards .card').nth(1).waitFor();
  assert.deepEqual([await readCard(other.page, 1), await readCard(other.page, 2)], cards);
  assert.match(await other.page.locator('#summary').textContent(), /たろう/);
  assert.doesNotMatch(other.page.url(), /#k=/);
  // 開き直しても同じ(合い札が保存されている)
  await other.page.goto(server.http + '/');
  await other.page.locator('#cards .card').nth(1).waitFor();

  // すでに自分のカードを持っているブラウザでは、置き換える前に確認する
  const third = await openPage('/');
  await seat(host, third.page, 'はなこ', 1);
  await third.page.goto(link);
  await third.page.locator('#dialog').waitFor({ state: 'visible' });
  await third.page.click('#dialog-cancel');
  await third.page.locator('#summary', { hasText: 'はなこ' }).waitFor();
  assert.doesNotMatch(third.page.url(), /#k=/);
  await third.page.goto(link);
  await third.page.locator('#dialog').waitFor({ state: 'visible' });
  await third.page.click('#dialog-ok');
  await third.page.locator('#summary', { hasText: 'たろう' }).waitFor();
  assert.equal(await third.page.locator('#cards .card').count(), 2);
  assert.deepEqual([...errors, ...other.errors, ...third.errors], []);
});

test('リスナー: カードが多くても横にはみ出さない', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage();
  await seat(host, page, 'たろう', 30);
  assert.equal(await page.locator('#cards .card').count(), 30);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(overflow, 0);
  assert.deepEqual(errors, []);
});

test('ページに Content-Security-Policy が付いている', async () => {
  for (const path of ['/', '/host']) {
    const res = await fetch(server.http + path);
    assert.equal(res.status, 200, path);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/, path);
    assert.match(csp, /default-src 'self'/, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
  }
});

// ---- 主催者画面 ----

const DESKTOP = { width: 1280, height: 800 };

async function openHost(viewport = DESKTOP, { motion = false } = {}) {
  const h = await openPage('/host', { viewport, motion });
  await h.page.fill('#password', HOST_PASSWORD);
  await h.page.click('#login-btn');
  await h.page.locator('#panel').waitFor();
  return h;
}

async function ask(page, name, count) {
  await page.fill('#name', name);
  await page.fill('#count', String(count));
  await page.click('#request-btn');
  await page.locator('#status', { hasText: '許可を待っています' }).waitFor();
}

async function yes(page) {
  await page.locator('#dialog').waitFor();
  await page.click('#dialog-ok');
  await page.locator('#dialog').waitFor({ state: 'hidden' });
}

const reqRow = (page, name) => page.locator('#requests .req').filter({ has: page.locator('.req-name', { hasText: name }) });

test('主催者: 合言葉で入る。違えば入れず、入ったあとは再読み込みしても入ったまま', async () => {
  await fresh(server);
  const { page, errors } = await openPage('/host', { viewport: DESKTOP });
  await page.locator('#login').waitFor();
  assert.equal(await page.locator('#panel').isVisible(), false);
  await page.fill('#password', 'chigau');
  await page.click('#login-btn');
  await page.locator('#login-error', { hasText: '合言葉が違います' }).waitFor();
  assert.equal(await page.locator('#panel').isVisible(), false);

  await page.fill('#password', HOST_PASSWORD);
  await page.click('#login-btn');
  await page.locator('#panel').waitFor();
  assert.equal(await page.locator('#login').isVisible(), false);
  await page.reload();
  await page.locator('#panel').waitFor();

  await page.click('#logout');
  await page.locator('#login').waitFor();
  await page.reload();
  await page.locator('#login').waitFor();
  assert.equal(await page.locator('#panel').isVisible(), false);
  assert.deepEqual(errors, []);
});

for (const [label, viewport] of [['PC幅', DESKTOP], ['スマホ幅', PHONE]]) {
  test(`主催者(${label}): 受付から許可、番号の発表、ビンゴ、取り消しまで通しで遊ぶ`, async () => {
    const { c: ws } = await fresh(server);
    ws.send({ t: 'accepting', on: false });
    await ws.next('host');
    const host = await openHost(viewport);
    const taro = await openPage();
    const hanako = await openPage();
    await taro.page.locator('#status', { hasText: 'いまは受付していません' }).waitFor();

    // 受付開始
    const toggle = host.page.locator('#accepting-toggle');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    await toggle.click();
    await host.page.locator('#accepting-toggle[aria-pressed="true"]').waitFor();

    // 申請は届いた順に並ぶ
    await ask(taro.page, 'たろう', 3);
    await ask(hanako.page, 'はなこ', 1);
    await host.page.locator('#requests .req').nth(1).waitFor();
    assert.deepEqual(await host.page.locator('#requests .req .req-name').allTextContents(), ['たろう', 'はなこ']);
    assert.equal(await reqRow(host.page, 'たろう').locator('.req-count').textContent(), '3');
    assert.match(await host.page.locator('#totals').textContent(), /申請 2件/);

    // 枚数を変えて許可
    await reqRow(host.page, 'たろう').locator('.req-minus').click();
    assert.equal(await reqRow(host.page, 'たろう').locator('.req-count').textContent(), '2');
    await reqRow(host.page, 'たろう').locator('.approve').click();
    await taro.page.locator('#cards .card').nth(1).waitFor();
    assert.equal(await taro.page.locator('#cards .card').count(), 2);
    await reqRow(host.page, 'はなこ').locator('.approve').click();
    await hanako.page.locator('#cards .card').first().waitFor();
    await host.page.locator('#requests .req').first().waitFor({ state: 'detached' });
    await host.page.locator('#totals', { hasText: '参加 2人' }).waitFor();
    assert.match(await host.page.locator('#totals').textContent(), /カード 3枚/);
    assert.deepEqual(await host.page.locator('#participants .p-name').allTextContents(), ['たろう', 'はなこ']);

    // 盤面から番号を発表
    const row = (await readCard(taro.page, 1)).slice(0, 5);
    for (const n of row) await host.page.click(`#board .num[data-n="${n}"]`);
    await taro.page.locator('#cards .card[data-no="1"].bingo').waitFor();
    assert.deepEqual(await markedIndexes(taro.page, 1), [0, 1, 2, 3, 4, 12]);
    await host.page.locator('#host-winners li', { hasText: 'たろう' }).waitFor();
    assert.match(await host.page.locator('#host-drawn-count').textContent(), /5個目/);
    assert.equal(await host.page.locator('#board .num.called').count(), 5);
    assert.equal((await host.page.locator('#host-current').textContent()).trim(), String(row[4]));
    const taroRow = host.page.locator('#participants .participant').filter({ has: host.page.locator('.p-name', { hasText: 'たろう' }) });
    assert.match(await taroRow.locator('.p-status').textContent(), /ビンゴ/);
    await hanako.page.locator('#winners li', { hasText: 'たろう' }).waitFor();

    // 直前の番号を取り消す
    await host.page.click('#undo-btn');
    await yes(host.page);
    await host.page.locator('#host-winners li').first().waitFor({ state: 'detached' });
    await taro.page.locator('#cards .card[data-no="1"].reach').waitFor();
    assert.equal(await host.page.locator('#board .num.called').count(), 4);
    assert.equal(await taro.page.locator('#winners li').count(), 0);

    // 横にはみ出さない
    const overflow = await host.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0);
    assert.deepEqual([...host.errors, ...taro.errors, ...hanako.errors], []);
  });
}

test('主催者: ランダムに引くと、主催者とリスナーに同じ番号が出る', async () => {
  await fresh(server);
  const host = await openHost();
  const listener = await openPage();
  await listener.page.locator('#conn', { hasText: '接続中' }).waitFor();
  assert.doesNotMatch(await host.page.locator('#host-current').textContent(), /\d/);
  await host.page.click('#draw-btn');
  await host.page.locator('#board .num.called').waitFor();
  const n = Number((await host.page.locator('#host-current').textContent()).trim());
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 75, String(n));
  assert.equal(await host.page.locator('#board .num.called').getAttribute('data-n'), String(n));
  await listener.page.locator('#drawn-count', { hasText: '1個目' }).waitFor();
  assert.equal((await listener.page.locator('#current').textContent()).trim(), String(n));
  // 出た番号はもう押せない
  assert.equal(await host.page.locator(`#board .num[data-n="${n}"]`).isDisabled(), true);
  assert.deepEqual([...host.errors, ...listener.errors], []);
});

test('主催者: すべてリセットは確認を挟む', async () => {
  const { c: ws } = await fresh(server);
  const host = await openHost();
  const listener = await openPage();
  await seat(ws, listener.page, 'たろう', 2);

  await host.page.click('#reset-all');
  await host.page.locator('#dialog').waitFor();
  await host.page.click('#dialog-cancel');
  await sleep(400);
  assert.equal(await listener.page.locator('#cards .card').count(), 2);
  assert.equal(await host.page.locator('#participants .participant').count(), 1);

  await host.page.click('#reset-all');
  await yes(host.page);
  await listener.page.locator('#form').waitFor({ state: 'visible' });
  assert.equal(await listener.page.locator('#cards .card').count(), 0);
  await host.page.locator('#participants .participant').first().waitFor({ state: 'detached' });
  assert.deepEqual([...host.errors, ...listener.errors], []);
});

test('主催者: 次のゲームで番号だけ消え、カードは残る', async () => {
  const { c: ws } = await fresh(server);
  const host = await openHost();
  const listener = await openPage();
  await seat(ws, listener.page, 'たろう', 1);
  const before = await readCard(listener.page);
  await host.page.click(`#board .num[data-n="${before[0]}"]`);
  await listener.page.locator('#cards .card .cell.marked').nth(1).waitFor();

  await host.page.click('#new-round');
  await yes(host.page);
  await listener.page.locator('#drawn-count', { hasText: 'まだ番号は出ていません' }).waitFor();
  assert.deepEqual(await readCard(listener.page), before);
  assert.deepEqual(await markedIndexes(listener.page), [12]);
  await host.page.locator('#host-drawn-count', { hasText: 'まだ番号は出ていません' }).waitFor();
  assert.equal(await host.page.locator('#board .num.called').count(), 0);
  assert.doesNotMatch(await host.page.locator('#host-current').textContent(), /\d/);
  assert.equal(await host.page.locator('#participants .participant').count(), 1);
  assert.deepEqual([...host.errors, ...listener.errors], []);
});

test('主催者: 参加者のブロックと解除', async () => {
  const { c: ws } = await fresh(server);
  const host = await openHost();
  const listener = await openPage();
  await seat(ws, listener.page, 'あらし', 1);
  await host.page.locator('#participants .participant .block').click();
  await yes(host.page);
  await listener.page.locator('#status', { hasText: '申請できません' }).waitFor();
  assert.equal(await listener.page.locator('#cards .card').count(), 0);
  assert.equal(await listener.page.locator('#form').isVisible(), false);
  await host.page.locator('#blocked .blocked-row', { hasText: 'あらし' }).waitFor();
  assert.equal(await host.page.locator('#participants .participant').count(), 0);

  await host.page.locator('#blocked .blocked-row .unblock').click();
  await listener.page.locator('#form').waitFor({ state: 'visible' });
  await host.page.locator('#blocked .blocked-row').first().waitFor({ state: 'detached' });
  assert.deepEqual([...host.errors, ...listener.errors], []);
});

test('主催者: 申請の行から却下・ブロックできる', async () => {
  await fresh(server);
  const host = await openHost();
  const a = await openPage();
  const b = await openPage();
  await ask(a.page, 'みおくり', 2);
  await ask(b.page, 'あらし', 50);
  await host.page.locator('#requests .req').nth(1).waitFor();

  await reqRow(host.page, 'みおくり').locator('.reject').click();
  await a.page.locator('#status', { hasText: '今回は見送られました' }).waitFor();
  await reqRow(host.page, 'あらし').locator('.req-block').click();
  await yes(host.page);
  await b.page.locator('#status', { hasText: '申請できません' }).waitFor();
  await host.page.locator('#requests .req').first().waitFor({ state: 'detached' });
  await host.page.locator('#blocked .blocked-row', { hasText: 'あらし' }).waitFor();
  assert.deepEqual([...host.errors, ...a.errors, ...b.errors], []);
});

test('主催者: すべて許可', async () => {
  await fresh(server);
  const host = await openHost();
  const a = await openPage();
  const b = await openPage();
  assert.equal(await host.page.locator('#approve-all').isDisabled(), true);
  await ask(a.page, 'A', 2);
  await ask(b.page, 'B', 3);
  await host.page.locator('#requests .req').nth(1).waitFor();
  await host.page.click('#approve-all');
  await yes(host.page);
  await a.page.locator('#cards .card').nth(1).waitFor();
  await b.page.locator('#cards .card').nth(2).waitFor();
  assert.equal(await a.page.locator('#cards .card').count(), 2);
  assert.equal(await b.page.locator('#cards .card').count(), 3);
  await host.page.locator('#requests .req').first().waitFor({ state: 'detached' });
  assert.deepEqual([...host.errors, ...a.errors, ...b.errors], []);
});

test('名前に入れたHTMLは、どの画面でも文字として表示される', async () => {
  await fresh(server);
  const NAME = '<svg onload=a()>';
  const host = await openHost();
  const listener = await openPage();
  const dialogs = [];
  host.page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  listener.page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });

  await ask(listener.page, NAME, 1);
  await host.page.locator('#requests .req').waitFor();
  assert.equal(await host.page.locator('#requests .req .req-name').textContent(), NAME);
  await host.page.locator('#requests .req .approve').click();
  await listener.page.locator('#cards .card').waitFor();
  assert.match(await listener.page.locator('#summary').textContent(), /<svg onload=a\(\)>/);
  assert.equal(await host.page.locator('#participants .p-name').textContent(), NAME);

  // ビンゴ一覧にも出す
  for (const n of (await readCard(listener.page)).slice(0, 5)) await host.page.click(`#board .num[data-n="${n}"]`);
  await host.page.locator('#host-winners li').waitFor();
  await listener.page.locator('#winners li').waitFor();
  assert.match(await host.page.locator('#host-winners li').textContent(), /<svg onload=a\(\)>/);
  assert.match(await listener.page.locator('#winners li').textContent(), /<svg onload=a\(\)>/);

  // ブロックした人の一覧にも出す
  await host.page.locator('#participants .participant .block').click();
  await yes(host.page);
  await host.page.locator('#blocked .blocked-row').waitFor();
  assert.match(await host.page.locator('#blocked .blocked-row').textContent(), /<svg onload=a\(\)>/);

  assert.equal(await host.page.locator('main svg').count(), 0);
  assert.equal(await listener.page.locator('main svg').count(), 0);
  assert.deepEqual(dialogs, []);
  assert.deepEqual([...host.errors, ...listener.errors], []);
});

test('主催者: 反映の遅れを選べる。主催者画面にはすぐ出る', async () => {
  await fresh(server);
  const host = await openHost();
  const listener = await openPage();
  await listener.page.locator('#conn', { hasText: '接続中' }).waitFor();
  assert.equal(await host.page.inputValue('#delay-select'), '0');
  await host.page.selectOption('#delay-select', '5');
  await sleep(300);
  await host.page.reload();
  await host.page.locator('#panel').waitFor();
  assert.equal(await host.page.inputValue('#delay-select'), '5');

  await host.page.click('#board .num[data-n="8"]');
  await host.page.locator('#board .num.called').waitFor();
  assert.equal((await host.page.locator('#host-current').textContent()).trim(), '8');
  await sleep(1000);
  assert.doesNotMatch(await listener.page.locator('#current').textContent(), /\d/);
  await listener.page.locator('#drawn-count', { hasText: '1個目' }).waitFor({ timeout: 8000 });
  assert.deepEqual([...host.errors, ...listener.errors], []);
});

test('主催者: 2つの端末で開いても、片方の操作がもう片方に出る', async () => {
  await fresh(server);
  const one = await openHost();
  const two = await openHost(PHONE);
  const listener = await openPage();
  await one.page.click('#board .num[data-n="20"]');
  await two.page.locator('#board .num[data-n="20"].called').waitFor();
  await two.page.click('#accepting-toggle');
  await one.page.locator('#accepting-toggle[aria-pressed="false"]').waitFor();
  await two.page.click('#accepting-toggle');
  await one.page.locator('#accepting-toggle[aria-pressed="true"]').waitFor();
  await ask(listener.page, 'たろう', 1);
  await one.page.locator('#requests .req').waitFor();
  await two.page.locator('#requests .req').waitFor();
  await one.page.locator('#requests .req .approve').click();
  await two.page.locator('#requests .req').waitFor({ state: 'detached' });
  await two.page.locator('#participants .participant', { hasText: 'たろう' }).waitFor();
  assert.deepEqual([...one.errors, ...two.errors, ...listener.errors], []);
});

test('主催者: 接続が切れても、合言葉を入れ直さずに戻る', async () => {
  await fresh(server);
  const ctx = await browser.newContext({ viewport: DESKTOP, reducedMotion: 'reduce' });
  contexts.push(ctx);
  ctx.setDefaultTimeout(TIMEOUT);
  const page = await ctx.newPage();
  const open = new Set();
  await page.routeWebSocket(/\/ws$/, (ws) => { open.add({ ws, upstream: ws.connectToServer() }); });
  await page.goto(server.http + '/host');
  await page.fill('#password', HOST_PASSWORD);
  await page.click('#login-btn');
  await page.locator('#panel').waitFor();
  for (const c of open) { c.ws.close(); c.upstream.close(); }
  await page.locator('#host-conn', { hasText: '再接続中' }).waitFor();
  await page.locator('#host-conn', { hasText: '接続中' }).filter({ hasNotText: '再接続中' }).waitFor({ timeout: 12000 });
  await page.click('#board .num[data-n="3"]');
  await page.locator('#board .num[data-n="3"].called').waitFor();
  assert.equal(await page.locator('#login').isVisible(), false);
});

// ---- 見直しで見つかった点 ----

test('リスナー: 画面を開いたまま接続が黙って止まっても、気づいてつなぎ直す', async () => {
  const { c: host } = await fresh(server);
  const ctx = await browser.newContext({ viewport: PHONE, reducedMotion: 'reduce' });
  contexts.push(ctx);
  ctx.setDefaultTimeout(TIMEOUT);
  const page = await ctx.newPage();
  // 切断の合図もなく、サーバーからの通知だけが届かなくなった接続を真似る
  const conns = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const conn = { dead: false };
    conns.push(conn);
    const upstream = ws.connectToServer();
    upstream.onMessage((m) => { if (!conn.dead) ws.send(m); });
  });
  await page.goto(server.http + '/');
  await seat(host, page, 'たろう', 1);
  const row = (await readCard(page)).slice(0, 5);

  for (const conn of conns) conn.dead = true;
  await call(host, row[0]);
  // 画面の切り替えも再読み込みもしない。定期的な確認で気づき、取り直す。
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor({ timeout: 45000 });
  assert.deepEqual(await markedIndexes(page), [0, 12]);
  assert.ok(conns.length >= 2, 'つなぎ直しているはず');
});

test('主催者: 許可を二度押ししても、次の人まで許可しない', async () => {
  await fresh(server);
  const host = await openHost();
  const a = await openPage();
  const b = await openPage();
  await ask(a.page, 'A', 1);
  await ask(b.page, 'B', 50);
  await host.page.locator('#requests .req').nth(1).waitFor();

  const box = await reqRow(host.page, 'A').locator('.approve').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await host.page.mouse.click(x, y);
  await host.page.locator('#requests .req').nth(1).waitFor({ state: 'detached' });
  // A の行が消え、B の行が同じ場所に上がってきた直後の2回目
  await host.page.mouse.click(x, y);
  await sleep(500);
  assert.equal(await a.page.locator('#cards .card').count(), 1);
  assert.equal(await b.page.locator('#cards .card').count(), 0);
  assert.equal(await host.page.locator('#requests .req').count(), 1);

  // 少し待てば、ふつうに許可できる
  await sleep(500);
  await reqRow(host.page, 'B').locator('.approve').click();
  await b.page.locator('#cards .card').nth(49).waitFor();
  assert.deepEqual([...host.errors, ...a.errors, ...b.errors], []);
});

test('主催者: 却下の二度押しでも、次の人まで却下しない', async () => {
  await fresh(server);
  const host = await openHost();
  const a = await openPage();
  const b = await openPage();
  await ask(a.page, 'A', 1);
  await ask(b.page, 'B', 1);
  await host.page.locator('#requests .req').nth(1).waitFor();
  const box = await reqRow(host.page, 'A').locator('.reject').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await host.page.mouse.click(x, y);
  await host.page.locator('#requests .req').nth(1).waitFor({ state: 'detached' });
  await host.page.mouse.click(x, y);
  await sleep(500);
  await b.page.locator('#status', { hasText: '許可を待っています' }).waitFor();
  assert.equal(await host.page.locator('#requests .req').count(), 1);
});

test('リスナー: カードを持っていないブラウザでは、引き継ぎリンクは確認なしで開く', async () => {
  const { c: host } = await fresh(server);
  const ctx = await browser.newContext({ viewport: PHONE, reducedMotion: 'reduce' });
  contexts.push(ctx);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { page } = await openPage('/', { context: ctx });
  await seat(host, page, 'たろう', 2);
  const cards = [await readCard(page, 1), await readCard(page, 2)];
  await page.click('#copy-link');
  const link = await page.evaluate(() => navigator.clipboard.readText());

  // いちど開いただけで何も申請していないブラウザ(Safari で開き直した人など)
  const other = await openPage('/');
  await other.page.locator('#request-btn:not([disabled])').waitFor();
  await other.page.goto(link);
  await other.page.locator('#cards .card').nth(1).waitFor();
  assert.equal(await other.page.locator('#dialog').isVisible(), false);
  assert.deepEqual([await readCard(other.page, 1), await readCard(other.page, 2)], cards);
  assert.doesNotMatch(other.page.url(), /#k=/);
  // 開き直しても同じカード
  await other.page.goto(server.http + '/');
  await other.page.locator('#cards .card').nth(1).waitFor();
  assert.deepEqual(other.errors, []);
});

test('ビンゴの一覧は100枚までを表示し、その旨を添える', async () => {
  const { c: ws } = await fresh(server);
  const host = await openHost();
  const listener = await openPage();
  await listener.page.locator('#conn', { hasText: '接続中' }).waitFor();
  for (let i = 0; i < 75; i++) ws.send({ t: 'draw' });
  for (let i = 0; i < 75; i++) await ws.next('host');
  // 75個すべて出たあとのカードは、配った時点でビンゴ
  for (const name of ['A', 'B', 'C']) {
    const p = await joinPlayer(server);
    await grant(ws, p.c, name, 50);
  }
  await listener.page.locator('#winners li').nth(99).waitFor();
  assert.equal(await listener.page.locator('#winners li').count(), 100);
  await listener.page.locator('#winners-note', { hasText: '100' }).waitFor();
  await host.page.locator('#host-winners li').nth(99).waitFor();
  assert.equal(await host.page.locator('#host-winners li').count(), 100);
  await host.page.locator('#host-winners-note', { hasText: '100' }).waitFor();
  assert.match(await host.page.locator('#winner-stats').textContent(), /ビンゴ 150枚/);
  assert.deepEqual([...host.errors, ...listener.errors], []);
});

test('主催者: 締め出されても、保存した合言葉は消さず、理由を表示する', async () => {
  const s2 = await startServer();
  try {
    const ctx = await browser.newContext({ viewport: DESKTOP, reducedMotion: 'reduce' });
    contexts.push(ctx);
    ctx.setDefaultTimeout(TIMEOUT);
    const page = await ctx.newPage();
    const open = new Set();
    await page.routeWebSocket(/\/ws$/, (ws) => { open.add({ ws, upstream: ws.connectToServer() }); });
    await page.goto(s2.http + '/host');
    await page.fill('#password', HOST_PASSWORD);
    await page.click('#login-btn');
    await page.locator('#panel').waitFor();

    // 同じ接続元の別の人が、合言葉を5回まちがえる
    const other = await Client.open(s2.ws);
    for (let i = 0; i < 5; i++) {
      other.send({ t: 'auth', password: 'x' + i });
      await other.next('auth_fail');
    }
    // 主催者の接続が切れてつなぎ直すと、締め出しに当たる
    for (const c of open) { c.ws.close(); c.upstream.close(); }
    await page.locator('#login-error', { hasText: 'しばらく入れません' }).waitFor({ timeout: 12000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('bingo.v1.hostpw')), HOST_PASSWORD);
    // 合言葉が違うときとは別の文言
    assert.doesNotMatch(await page.locator('#login-error').textContent(), /合言葉が違います/);
  } finally {
    closeAll();
    await s2.stop();
  }
});

// ---- 合言葉の初回設定 ----

test('主催者: 合言葉が決まっていなければ、最初に開いた人がその場で決める', async () => {
  const s2 = await startServer({ vars: { HOST_PASSWORD: null } });
  try {
    const open = async () => {
      const ctx = await browser.newContext({ viewport: PHONE, reducedMotion: 'reduce' });
      contexts.push(ctx);
      ctx.setDefaultTimeout(TIMEOUT);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(s2.http + '/host');
      return { page, errors };
    };
    const first = await open();
    await first.page.locator('#setup').waitFor();
    assert.equal(await first.page.locator('#login').isVisible(), false);
    assert.equal(await first.page.locator('#panel').isVisible(), false);

    // 確認用と違う
    await first.page.fill('#new-password', 'watashi-no-aikotoba');
    await first.page.fill('#new-password2', 'chigau-aikotoba');
    await first.page.click('#setup-btn');
    await first.page.locator('#setup-error', { hasText: '同じ' }).waitFor();
    // 短すぎる
    await first.page.fill('#new-password', 'short');
    await first.page.fill('#new-password2', 'short');
    await first.page.click('#setup-btn');
    await first.page.locator('#setup-error', { hasText: '8文字' }).waitFor();
    assert.equal(await first.page.locator('#panel').isVisible(), false);

    await first.page.fill('#new-password', 'watashi-no-aikotoba');
    await first.page.fill('#new-password2', 'watashi-no-aikotoba');
    await first.page.click('#setup-btn');
    await first.page.locator('#panel').waitFor();
    assert.equal(await first.page.locator('#setup').isVisible(), false);
    // そのまま操作でき、開き直しても入ったまま
    await first.page.click('#accepting-toggle');
    await first.page.locator('#accepting-toggle[aria-pressed="true"]').waitFor();
    await first.page.reload();
    await first.page.locator('#panel').waitFor();

    // 別のブラウザでは、決める画面ではなく合言葉の入力になる
    const second = await open();
    await second.page.locator('#login').waitFor();
    assert.equal(await second.page.locator('#setup').isVisible(), false);
    await second.page.fill('#password', 'yokodori-no-aikotoba');
    await second.page.click('#login-btn');
    await second.page.locator('#login-error', { hasText: '合言葉が違います' }).waitFor();
    await second.page.fill('#password', 'watashi-no-aikotoba');
    await second.page.click('#login-btn');
    await second.page.locator('#panel').waitFor();
    assert.deepEqual([...first.errors, ...second.errors], []);
  } finally {
    closeAll();
    await s2.stop();
  }
});

test('主催者: 合言葉が決まっているサーバーでは、決める画面は出ない', async () => {
  await fresh(server);
  const { page, errors } = await openPage('/host', { viewport: DESKTOP });
  await page.locator('#login').waitFor();
  assert.equal(await page.locator('#setup').isVisible(), false);
  assert.deepEqual(errors, []);
});

// ---- 抽選の演出 ----

test('演出(リスナー): 番号が届くと抽選機が出て、終わってから穴が開く', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage('/', { motion: true });
  await seat(host, page, 'たろう', 1);
  const row = (await readCard(page)).slice(0, 5);
  assert.equal(await page.locator('#draw-show').isVisible(), false);

  await call(host, row[0]);
  await page.locator('#draw-show').waitFor({ state: 'visible' });
  // 演出の間は、まだ番号も穴も出ていない
  assert.deepEqual(await markedIndexes(page), [12]);
  assert.doesNotMatch(await page.locator('#current').textContent(), /\d/);
  assert.equal(await page.locator('#draw-show-ball').isVisible(), false);
  // 玉が出て、番号が見える
  await page.locator('#draw-show-ball').waitFor({ state: 'visible' });
  assert.equal((await page.locator('#draw-show-ball').textContent()).trim(), String(row[0]));
  // 演出が閉じると、穴が開いている
  await page.locator('#draw-show').waitFor({ state: 'hidden' });
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor();
  assert.deepEqual(await markedIndexes(page), [0, 12]);
  assert.equal((await page.locator('#current').textContent()).trim(), String(row[0]));
  assert.deepEqual(errors, []);
});

test('演出(リスナー): タップで飛ばせる', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage('/', { motion: true });
  await seat(host, page, 'たろう', 1);
  const row = (await readCard(page)).slice(0, 5);
  await call(host, row[0]);
  await page.locator('#draw-show').waitFor({ state: 'visible' });
  const started = Date.now();
  await page.locator('#draw-show').click();
  await page.locator('#draw-show').waitFor({ state: 'hidden' });
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor();
  assert.ok(Date.now() - started < 1500, '飛ばしたら、すぐに番号が出る');
  assert.deepEqual(await markedIndexes(page), [0, 12]);
  assert.deepEqual(errors, []);
});

test('演出(リスナー): 途中で取り消された番号は出さない', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage('/', { motion: true });
  await seat(host, page, 'たろう', 1);
  const row = (await readCard(page)).slice(0, 5);
  await call(host, row[0]);
  await page.locator('#draw-show').waitFor({ state: 'visible' });
  host.send({ t: 'undo' });
  await host.next('host');
  await page.locator('#draw-show').waitFor({ state: 'hidden' });
  await sleep(600);
  assert.deepEqual(await markedIndexes(page), [12]);
  assert.doesNotMatch(await page.locator('#current').textContent(), /\d/);
  // そのあとの番号は、ふつうに演出つきで出る
  await call(host, row[1]);
  await page.locator('#draw-show').waitFor({ state: 'visible' });
  await page.locator('#draw-show').waitFor({ state: 'hidden' });
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor();
  assert.deepEqual(await markedIndexes(page), [1, 12]);
  assert.deepEqual(errors, []);
});

test('演出(リスナー): 動きを減らす設定の端末では出さず、すぐ番号を出す', async () => {
  const { c: host } = await fresh(server);
  const { page, errors } = await openPage('/');
  await seat(host, page, 'たろう', 1);
  const row = (await readCard(page)).slice(0, 5);
  await call(host, row[0]);
  await page.locator('#cards .card[data-no="1"] .cell.marked').nth(1).waitFor({ timeout: 1500 });
  assert.equal(await page.locator('#draw-show').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('演出(主催者): ランダムに引くと抽選機が出る。盤面から押したときは出ない。スイッチで切れて、設定は残る', async () => {
  await fresh(server);
  const host = await openHost(DESKTOP, { motion: true });
  assert.equal(await host.page.locator('#fx-toggle').getAttribute('aria-pressed'), 'true');

  await host.page.click('#draw-btn');
  await host.page.locator('#draw-show').waitFor({ state: 'visible' });
  await host.page.locator('#draw-show-ball').waitFor({ state: 'visible' });
  const shown = (await host.page.locator('#draw-show-ball').textContent()).trim();
  assert.match(shown, /^\d+$/);
  await host.page.locator('#draw-show').waitFor({ state: 'hidden' });
  assert.equal((await host.page.locator('#host-current').textContent()).trim(), shown);
  assert.equal(await host.page.locator(`#board .num[data-n="${shown}"]`).getAttribute('class').then((c) => c.includes('called')), true);

  // 自分で引いた番号を盤面から押したときは、演出なしですぐ出る
  const manual = shown === '40' ? '41' : '40';
  await host.page.click(`#board .num[data-n="${manual}"]`);
  await host.page.locator(`#board .num[data-n="${manual}"].called`).waitFor();
  assert.equal(await host.page.locator('#draw-show').isVisible(), false);

  // 演出を切る
  await host.page.click('#fx-toggle');
  assert.equal(await host.page.locator('#fx-toggle').getAttribute('aria-pressed'), 'false');
  await host.page.click('#draw-btn');
  await host.page.locator('#host-drawn-count', { hasText: '3個目' }).waitFor();
  assert.equal(await host.page.locator('#draw-show').isVisible(), false);

  await host.page.reload();
  await host.page.locator('#panel').waitFor();
  assert.equal(await host.page.locator('#fx-toggle').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(host.errors, []);
});

test('演出(主催者): 音のスイッチを入れて引いても問題なく動き、設定は残る', async () => {
  await fresh(server);
  const host = await openHost(PHONE, { motion: true });
  assert.equal(await host.page.locator('#sound-toggle').getAttribute('aria-pressed'), 'false');
  await host.page.click('#sound-toggle');
  assert.equal(await host.page.locator('#sound-toggle').getAttribute('aria-pressed'), 'true');

  await host.page.click('#draw-btn');
  await host.page.locator('#draw-show').waitFor({ state: 'visible' });
  await host.page.locator('#draw-show').waitFor({ state: 'hidden' });
  await host.page.locator('#host-drawn-count', { hasText: '1個目' }).waitFor();
  // 途中で飛ばしても、音の後始末でエラーにならない
  await host.page.click('#draw-btn');
  await host.page.locator('#draw-show').waitFor({ state: 'visible' });
  await host.page.locator('#draw-show').click();
  await host.page.locator('#draw-show').waitFor({ state: 'hidden' });
  await host.page.locator('#host-drawn-count', { hasText: '2個目' }).waitFor();

  await host.page.reload();
  await host.page.locator('#panel').waitFor();
  assert.equal(await host.page.locator('#sound-toggle').getAttribute('aria-pressed'), 'true');
  const overflow = await host.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(overflow, 0);
  assert.deepEqual(host.errors, []);
});

// ---- 主催者に見せる、ビンゴへの近さ ----

test('主催者: 参加者はビンゴに近い順に並び、あといくつかと穴の数が出る', async () => {
  const { c: ws } = await fresh(server);
  const host = await openHost();
  const a = await joinPlayer(server);
  const b = await joinPlayer(server);
  await grant(ws, a.c, 'あや', 1);
  const yb = await grant(ws, b.c, 'べに', 1);
  const rowB = yb.cards[0].numbers.slice(0, 5);
  const person = (name) => host.page.locator('#participants .participant').filter({ has: host.page.locator('.p-name', { hasText: name }) });
  await person('べに').waitFor();

  // まだ番号が出ていないときは、全員「あと4つ」
  assert.match(await person('べに').locator('.p-near').textContent(), /あと4つ/);
  assert.match(await person('べに').locator('.p-detail').textContent(), /穴 0個/);

  // べにの1行目を4つ出す → リーチ。いちばん上に来る。
  for (const n of rowB.slice(0, 4)) await host.page.click(`#board .num[data-n="${n}"]`);
  await person('べに').locator('.p-near', { hasText: 'リーチ' }).waitFor();
  assert.match(await person('べに').locator('.p-near').textContent(), /あと1つ/);
  assert.match(await person('べに').locator('.p-detail').textContent(), /カード1/);
  assert.match(await person('べに').locator('.p-detail').textContent(), /穴 4個/);
  assert.deepEqual(await host.page.locator('#participants .p-name').allTextContents(), ['べに', 'あや']);
  assert.match(await host.page.locator('#people-title').textContent(), /ビンゴに近い順/);

  // べにがビンゴすると、まだビンゴしていない人が上に来る
  await host.page.click(`#board .num[data-n="${rowB[4]}"]`);
  await person('べに').locator('.chip-bingo').waitFor();
  assert.deepEqual(await host.page.locator('#participants .p-name').allTextContents(), ['あや', 'べに']);
  assert.equal(await person('べに').locator('.p-near').count(), 0);
  assert.match(await person('あや').locator('.p-near').textContent(), /あと\d+つ/);

  // リスナーの画面には、他の人の状況は出ない
  const listener = await openPage('/');
  await listener.page.locator('#conn', { hasText: '接続中' }).waitFor();
  assert.equal(await listener.page.locator('.p-near').count(), 0);
  assert.doesNotMatch(await listener.page.locator('main').textContent(), /あや/);
  assert.deepEqual([...host.errors, ...listener.errors], []);
});

// ---- リーチの人と待ち番号(全員に見せる) ----

test('リーチの人と待ち番号が、リスナー全員と主催者に見える', async () => {
  const { c: ws } = await fresh(server);
  const host = await openHost();
  const watcher = await openPage('/'); // カードを持っていない、見ているだけの人
  const a = await joinPlayer(server);
  const ya = await grant(ws, a.c, 'りいち', 1);
  const row = ya.cards[0].numbers.slice(0, 5);
  await watcher.page.locator('#conn', { hasText: '接続中' }).waitFor();
  assert.equal(await watcher.page.locator('#waiting-box').isVisible(), false);

  for (const n of row.slice(0, 4)) await host.page.click(`#board .num[data-n="${n}"]`);
  const item = watcher.page.locator('#waiting-list li', { hasText: 'りいち' });
  await item.waitFor();
  assert.match(await item.textContent(), new RegExp(`\\b${row[4]}\\b`));
  // 主催者画面にも、同じ一覧と、参加者の行の待ち番号が出る
  await host.page.locator('#host-waiting-list li', { hasText: 'りいち' }).waitFor();
  assert.match(await host.page.locator('#host-waiting-list li', { hasText: 'りいち' }).textContent(), new RegExp(`\\b${row[4]}\\b`));
  assert.match(await host.page.locator('#participants .participant .p-waits').first().textContent(), new RegExp(`\\b${row[4]}\\b`));

  // ビンゴすると、リーチの一覧から消える
  await host.page.click(`#board .num[data-n="${row[4]}"]`);
  await item.waitFor({ state: 'detached' });
  await watcher.page.locator('#winners li', { hasText: 'りいち' }).waitFor();
  assert.equal(await watcher.page.locator('#waiting-box').isVisible(), false);
  // 取り消すと戻る
  await host.page.click('#undo-btn');
  await yes(host.page);
  await item.waitFor();
  assert.deepEqual([...host.errors, ...watcher.errors], []);
});

test('リーチの一覧は、番号と同じく「反映の遅れ」のぶん遅れて出る', async () => {
  const { c: ws } = await fresh(server);
  const watcher = await openPage('/');
  const a = await joinPlayer(server);
  const ya = await grant(ws, a.c, 'りいち', 1);
  const row = ya.cards[0].numbers.slice(0, 5);
  await watcher.page.locator('#conn', { hasText: '接続中' }).waitFor();
  for (const n of row.slice(0, 3)) await call(ws, n);
  await watcher.page.locator('#drawn-count', { hasText: '3個目' }).waitFor();

  ws.send({ t: 'delay', sec: 3 });
  await ws.next('host');
  await call(ws, row[3]);
  await sleep(1200);
  // まだ4個目が見えていないので、リーチも出ていない
  assert.match(await watcher.page.locator('#drawn-count').textContent(), /3個目/);
  assert.equal(await watcher.page.locator('#waiting-list li').count(), 0);
  await watcher.page.locator('#waiting-list li', { hasText: 'りいち' }).waitFor({ timeout: 6000 });
  assert.match(await watcher.page.locator('#drawn-count').textContent(), /4個目/);

  // 待っている途中で開き直しても、先には出ない
  await call(ws, row[4]);
  await watcher.page.reload();
  await watcher.page.locator('#conn', { hasText: '接続中' }).waitFor();
  await sleep(500);
  assert.equal(await watcher.page.locator('#winners li').count(), 0);
  await watcher.page.locator('#winners li', { hasText: 'りいち' }).waitFor({ timeout: 6000 });
  assert.equal(await watcher.page.locator('#waiting-list li').count(), 0);
  assert.deepEqual(watcher.errors, []);
});

test('リーチの人の名前に入れたHTMLは、文字として表示される', async () => {
  const { c: ws } = await fresh(server);
  const NAME = '<svg onload=a()>';
  const host = await openHost();
  const watcher = await openPage('/');
  const a = await joinPlayer(server);
  const ya = await grant(ws, a.c, NAME, 1);
  for (const n of ya.cards[0].numbers.slice(0, 4)) await host.page.click(`#board .num[data-n="${n}"]`);
  await watcher.page.locator('#waiting-list li').waitFor();
  assert.match(await watcher.page.locator('#waiting-list li').textContent(), /<svg onload=a\(\)>/);
  await host.page.locator('#host-waiting-list li').waitFor();
  assert.match(await host.page.locator('#host-waiting-list li').textContent(), /<svg onload=a\(\)>/);
  assert.equal(await watcher.page.locator('main svg').count(), 0);
  assert.equal(await host.page.locator('main svg').count(), 0);
  assert.deepEqual([...host.errors, ...watcher.errors], []);
});
