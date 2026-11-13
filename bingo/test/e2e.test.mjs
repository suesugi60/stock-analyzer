// 画面のテスト(Playwright)。node --test test/e2e.test.mjs で実行。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, closeAll, fresh } from './helpers.mjs';
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
async function openPage(path = '/', { viewport = PHONE, context } = {}) {
  const ctx = context ?? (await browser.newContext({ viewport }));
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
  const ctx = await browser.newContext({ viewport: PHONE });
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
  const ctx = await browser.newContext({ viewport: PHONE });
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
  const ctx = await browser.newContext({ viewport: PHONE });
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
  for (const path of ['/']) {
    const res = await fetch(server.http + path);
    assert.equal(res.status, 200, path);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/, path);
    assert.match(csp, /default-src 'self'/, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
  }
});
