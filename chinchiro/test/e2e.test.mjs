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

// ---------- 対戦 ----------
// quick=1: 演出を一瞬で終える(流れのテスト用)
async function setupMatch(names = [['うさ', 'kappa']], opts = {}) {
  const { page: host, context, errors } = await newPage(null, 'index.html?mock=1&quick=1', { width: 1280, height: 720 });
  const code = await createRoom(host, opts);
  const kids = [];
  for (const [n, c] of names) {
    const { page, errors: e } = await openListener(context, code, '&quick=1');
    await page.locator('#screen-join').waitFor({ state: 'visible', ...T });
    await page.locator('#join-name').fill(n);
    if (c) { await page.locator('#join-avatar').click(); await page.click(`#screen-pick .pick[data-char="${c}"]`); }
    await page.click('#join-challenge');
    await page.locator('#screen-listener').waitFor({ state: 'visible', ...T });
    kids.push({ page, errors: e });
  }
  await host.locator('#queue .queue-row').nth(names.length - 1).waitFor({ state: 'visible', ...T });
  return { host, context, errors, code, kids };
}
const phaseOf = async (page, code) => (await readRoom(page, code)).state.phase;

/** 親が振る → 子が振る を、結果が出るまで繰り返す(引き分けも続ける)。 */
async function playUntilResult(host, kid, code) {
  for (let guard = 0; guard < 30; guard++) {
    const phase = await phaseOf(host, code);
    if (phase === 'result') return;
    if (phase === 'parent') { await host.locator('#host-roll').waitFor({ state: 'visible', ...T }); await host.click('#host-roll'); }
    else if (phase === 'child') { await kid.locator('#listener-roll').waitFor({ state: 'visible', ...T }); await kid.click('#listener-roll'); }
    else throw new Error('想定外の phase: ' + phase);
    await host.waitForTimeout(400);
  }
  throw new Error('結果が出ません');
}

test('対戦: 親が振り、子が振ると両画面に同じ出目と結果が出て点数が動く', async () => {
  const { host, context, errors, code, kids } = await setupMatch();
  const kid = kids[0].page;
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  assert.equal(await phaseOf(host, code), 'parent');
  assert.equal(await host.locator('#queue .queue-row').count(), 0, '対戦中の人は列から外れる');
  await kid.locator('#my-status').filter({ hasText: '親が振っています' }).waitFor({ state: 'visible', ...T });
  await playUntilResult(host, kid, code);
  const room = await readRoom(host, code);
  const res = room.state.result;
  assert.ok(res && res.winner !== 'draw');
  assert.ok(res.mult >= 1);
  const me = Object.values(room.players)[0];
  assert.equal(room.state.host.points + me.points, 200, '点数は親と子の間で移る');
  assert.equal(Math.abs(me.points - 100), 10 * res.mult);
  assert.equal(me.wins + me.losses, 1);
  await host.locator('#next-match').waitFor({ state: 'visible', ...T });
  const hostVs = await host.locator('.arena .center .vs').innerText();
  const kidVs = await kid.locator('.arena .center .vs').innerText();
  assert.equal(hostVs, kidVs);
  assert.equal(hostVs, `×${res.mult}`);
  assert.ok((await kid.locator('#my-status').innerText()).includes(res.winner === 'child' ? '勝ち' : '負け'));
  assert.deepEqual(errors.concat(kids[0].errors), []);
  await context.close();
});

test('両画面に器の場面が出て、止まった出目が同じ', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  const { page: kid } = await openListener(context, code);
  await kid.locator('#join-name').fill('うさ');
  await kid.click('#join-challenge');
  await host.locator('#queue .queue-row').first().waitFor({ state: 'visible', ...T });
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await host.locator('#stage-overlay').waitFor({ state: 'visible', ...T });
  await kid.locator('#stage-overlay').waitFor({ state: 'visible', ...T });
  await host.locator('#stage').click({ position: { x: 10, y: 10 } });
  await kid.locator('#stage').click({ position: { x: 10, y: 10 } });
  const faces = async (p) => (await p.locator('#stage .cube').evaluateAll((els) => els.map((e) => e.dataset.face))).join(',');
  await host.locator('#stage .cube[data-face]').nth(2).waitFor({ state: 'attached', ...T });
  await kid.locator('#stage .cube[data-face]').nth(2).waitFor({ state: 'attached', ...T });
  assert.equal(await faces(host), await faces(kid));
  const stamp = (p) => p.locator('#stage .result-stamp').evaluate((e) => e.textContent);
  assert.equal(await stamp(host), await stamp(kid));
  assert.notEqual(await stamp(host), '');
  const dice = (await readRoom(host, code)).state.lastThrow.throw.dice.join(',');
  assert.equal(await faces(host), dice);
  await context.close();
});

test('連打しても1投だけ', async () => {
  const { host, context, code, kids } = await setupMatch();
  const kid = kids[0].page;
  // 出目を固定: 親 4,4,4(4ゾロ) → 子 1,1,6(6の目)で親の勝ち
  await host.evaluate(() => { const seq = [0.5, 0.5, 0.5, 0.5, 0.3, 0.5, 0.1, 0.1, 0.9, 0.3]; Math.random = () => (seq.length ? seq.shift() : 0.5); });
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await kid.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kid.evaluate(() => { const b = document.getElementById('listener-roll'); for (let i = 0; i < 5; i++) b.click(); });
  await kid.waitForTimeout(900);
  const room = await readRoom(host, code);
  assert.equal(room.state.phase, 'result');
  assert.equal(room.state.match.child.throws.length, 1);
  assert.deepEqual(room.state.match.child.throws[0].dice, [1, 1, 6]);
  await context.close();
});

test('手番でない人の要求は捨てる', async () => {
  const { host, context, code, kids } = await setupMatch([['うさ', 'kappa'], ['たろ', 'akaoni']]);
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  const before = await readRoom(host, code);
  // 2人目(手番でない)が actions に直接 roll を書く(mock の通信をまねる)
  await kids[1].page.evaluate((c) => {
    const uid = sessionStorage.getItem('chinchiro.uid');
    const db = JSON.parse(localStorage.getItem('chinchiro.mock.db'));
    db.rooms[c].actions = { [uid]: { type: 'roll', at: Date.now() } };
    localStorage.setItem('chinchiro.mock.db', JSON.stringify(db));
    new BroadcastChannel('chinchiro-mock').postMessage({ type: 'change', tree: db });
  }, code);
  await host.waitForTimeout(600);
  const after = await readRoom(host, code);
  assert.equal(after.state.seq, before.state.seq, 'state は変わらない');
  assert.equal(after.actions, undefined, '要求は消される');
  await context.close();
});

test('引き分けなら「もう一度!」と出て親の番に戻る', async () => {
  const { host, context, code, kids } = await setupMatch();
  const kid = kids[0].page;
  await host.evaluate(() => { Math.random = () => 0.5; }); // 出目は毎回 4,4,4(4ゾロ)
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await kid.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kid.click('#listener-roll');
  await host.locator('.arena .center .status').filter({ hasText: 'もう一度' }).waitFor({ state: 'visible', ...T });
  const room = await readRoom(host, code);
  assert.equal(room.state.phase, 'parent');
  assert.equal(room.state.match.round, 2);
  assert.equal(room.state.match.parent.throws, undefined, '同期先は空配列を保存しない(読み戻し時に補う)');
  await context.close();
});

test('次の挑戦者で列の次の人と対戦', async () => {
  const { host, context, code, kids } = await setupMatch([['うさ', 'kappa'], ['たろ', 'akaoni']]);
  await host.click('#start-match');
  await playUntilResult(host, kids[0].page, code);
  await host.locator('#next-match').waitFor({ state: 'visible', ...T });
  await host.click('#next-match');
  await host.locator('#start-match').waitFor({ state: 'visible', ...T });
  await host.click('#start-match');
  await host.locator('.fighter.child .fname').filter({ hasText: 'たろ' }).waitFor({ state: 'visible', ...T });
  assert.equal((await readRoom(host, code)).state.match.childUid, await kids[1].page.evaluate(() => sessionStorage.getItem('chinchiro.uid')));
  await kids[1].page.locator('#my-status').filter({ hasText: '親が振っています' }).waitFor({ state: 'visible', ...T });
  await kids[0].page.locator('#requeue').waitFor({ state: 'visible', ...T });
  await context.close();
});
