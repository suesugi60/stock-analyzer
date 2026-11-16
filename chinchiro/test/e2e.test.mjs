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

/** 起動時の voice/<役>.mp3|m4a の存在確認(HEAD)で出る 404 は想定内なので、ページエラーに数えない。 */
const isVoiceProbe = (m) => /\/voice\/[a-z0-9]+\.(mp3|m4a)$/.test(((m.location && m.location()) || {}).url || '');

async function newPage(ctx, path, viewport = { width: 390, height: 844 }) {
  const context = ctx || await browser.newContext({ viewport });
  context.setDefaultTimeout(T.timeout);
  // テストでは Firebase の設定を無効にする(本番の設定ファイルがあっても外に接続しない)
  await context.route('**/firebase-config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'window.FIREBASE_CONFIG = null;' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !isVoiceProbe(m)) errors.push(m.text()); });
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
async function createRoom(page, { name = '配信者', mode = 'points', unit = '10', drink = 'sip', start = null } = {}) {
  await page.locator('#screen-host-entry').waitFor({ state: 'visible', ...T });
  await page.locator('#host-name').fill(name);
  await page.click(`[data-mode="${mode}"]`);
  if (start) await page.click(`[data-start="${start}"]`);
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
  assert.deepEqual(room.settings, { mode: 'both', unit: 20, drinkUnit: 'half', hostName: '配信者', hostChar: 'momotaro', startPoints: 100 });
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

test('親機: 再読み込みすると同じ部屋に直接戻る', async () => {
  const { page, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(page);
  await page.reload();
  await page.locator('#screen-host').waitFor({ state: 'visible', ...T });
  assert.equal((await page.locator('#room-code').innerText()).trim(), code);
  await context.close();
});

// ---------- リスナー ----------
async function openListener(context, code, extra = '') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !isVoiceProbe(m)) errors.push(m.text()); });
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

async function injectPresence(host, code, n) {
  await host.evaluate(([c, k]) => {
    const db = JSON.parse(localStorage.getItem('chinchiro.mock.db'));
    db.rooms[c].presence = Object.fromEntries(Array.from({ length: k }, (_, i) => [`ghost${i}`, true]));
    localStorage.setItem('chinchiro.mock.db', JSON.stringify(db));
  }, [code, n]);
}

test('満員: 観戦が80人を超えたら(81人目から)満員表示。80人なら入れる', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  await injectPresence(host, code, 80);
  const ok = await openListener(context, code);
  await ok.page.locator('#screen-join').waitFor({ state: 'visible', ...T });
  await injectPresence(host, code, 81);
  const { page } = await openListener(context, code);
  await page.locator('#screen-full').waitFor({ state: 'visible', ...T });
  const room = await readRoom(host, code);
  assert.equal(Object.keys(room.presence).length, 81, '満員のときは自分の presence を書かない');
  await context.close();
});

// ---------- 対戦 ----------
// quick=1: 演出を一瞬で終える(流れのテスト用)
async function setupMatch(names = [['うさ', 'kappa']], opts = {}, hostExtra = '') {
  const { page: host, context, errors } = await newPage(null, 'index.html?mock=1&quick=1' + hostExtra, { width: 1280, height: 720 });
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

// ---------- 代わりに振る・復帰・ランキング・飲みモード・閉じる ----------
const FIX_PARENT_4ZORO_CHILD_6ME = '[0.5, 0.5, 0.5, 0.5, 0.3, 0.5, 0.1, 0.1, 0.9, 0.3]';   // 親 4ゾロ → 子 1,1,6(親の勝ち ×3)
const FIX_PARENT_2ME_CHILD_4ZORO = '[0.5, 0.7, 0.7, 0.2, 0.3, 0.5, 0.5, 0.5, 0.5, 0.3]';   // 親 5,5,2 → 子 4ゾロ(子の勝ち ×3)
const fixDice = (page, seqText) => page.evaluate((txt) => { const seq = JSON.parse(txt); Math.random = () => (seq.length ? seq.shift() : 0.5); }, seqText);

test('代わりに振る: 子が反応しないと親機にボタンが出て、押すと子の投げとして進む', async () => {
  const { host, context, code } = await setupMatch([['うさ', 'kappa']], {}, '&proxy=500');
  await fixDice(host, FIX_PARENT_4ZORO_CHILD_6ME);
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await host.locator('#roll-for-child').waitFor({ state: 'visible', ...T });
  await host.click('#roll-for-child');
  await host.locator('#next-match').waitFor({ state: 'visible', ...T });
  const room = await readRoom(host, code);
  assert.equal(room.state.phase, 'result');
  assert.deepEqual(room.state.match.child.throws[0].dice, [1, 1, 6]);
  assert.equal(room.state.result.winner, 'parent');
  await context.close();
});

test('親機が再読み込みしても続きから: 子の番の途中で reload → 同じ部屋・同じ phase で続行できる', async () => {
  const { host, context, code, kids } = await setupMatch();
  await fixDice(host, FIX_PARENT_4ZORO_CHILD_6ME);
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await kids[0].page.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await host.reload();
  await host.locator('#screen-host').waitFor({ state: 'visible', ...T });
  assert.equal((await host.locator('#room-code').innerText()).trim(), code);
  assert.ok((await host.locator('.arena .center .status').innerText()).includes('うさ さんの番'));
  assert.equal(await host.locator('#host-roll').evaluate((e) => e.hidden), true);
  await fixDice(host, '[0.5, 0.1, 0.1, 0.9, 0.3]');
  await kids[0].page.click('#listener-roll');
  await host.locator('#next-match').waitFor({ state: 'visible', ...T });
  assert.equal((await readRoom(host, code)).state.phase, 'result');
  await context.close();
});

test('リスナーが再読み込みしても自分の画面に戻る', async () => {
  const { context, kids } = await setupMatch();
  const kid = kids[0].page;
  await kid.reload();
  await kid.locator('#screen-listener').waitFor({ state: 'visible', ...T });
  assert.match(await kid.locator('#my-status').innerText(), /1 番目/);
  assert.ok((await kid.locator('#my-record').innerText()).includes('うさ'));
  await context.close();
});

test('ランキング: 点数順に並び、非表示の人は出ない', async () => {
  const { host, context, code, kids } = await setupMatch([['うさ', 'kappa'], ['かくれ', 'inu']]);
  await host.locator('#queue .queue-row').nth(1).locator('[data-act="hide"]').click();
  await host.locator('#queue .queue-row .qname').filter({ hasText: '？？？' }).waitFor({ state: 'attached', ...T });
  await fixDice(host, FIX_PARENT_2ME_CHILD_4ZORO);
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await kids[0].page.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kids[0].page.click('#listener-roll');
  await host.locator('#next-match').waitFor({ state: 'visible', ...T });
  const rows = await host.locator('#ranking .rank-row2').allInnerTexts();
  assert.equal(rows.length, 2, 'うさ と配信者だけ(非表示の人は出ない)');
  assert.ok(rows[0].includes('うさ') && rows[0].includes('130点'), rows[0]);
  assert.ok(rows[1].includes('配信者') && rows[1].includes('70点'), rows[1]);
  await context.close();
});

test('飲みモード: 結果に「1口 × 3」と出て累計が増える', async () => {
  const { host, context, code, kids } = await setupMatch([['うさ', 'kappa']], { mode: 'drink', drink: 'sip' });
  await fixDice(host, FIX_PARENT_2ME_CHILD_4ZORO);
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await kids[0].page.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kids[0].page.click('#listener-roll');
  await host.locator('#next-match').waitFor({ state: 'visible', ...T });
  assert.ok((await host.locator('.arena .center .drink').innerText()).includes('1口 × 3'));
  assert.ok((await host.locator('#host-record').innerText()).includes('飲んだ 1口 × 3'));
  assert.ok(!(await host.locator('#host-record').innerText()).includes('点'), '飲みモードでは点数を出さない');
  assert.ok((await kids[0].page.locator('.arena .center .drink').innerText()).includes('1口 × 3'));
  await context.close();
});

test('部屋を閉じるとリスナーに「終了しました」', async () => {
  const { host, context, kids } = await setupMatch();
  host.on('dialog', (d) => d.accept());
  await host.click('#close-room');
  await kids[0].page.locator('#screen-closed').waitFor({ state: 'visible', ...T });
  await host.locator('#screen-host-entry').waitFor({ state: 'visible', ...T });
  await context.close();
});

// ---------- 本番モードの配線 ----------
test('設定が無いまま本番モードで開くと、Firebase の準備手順への案内が出てページエラーにならない', async () => {
  const { page, context, errors } = await newPage(null, 'index.html');
  await page.locator('#screen-setup-needed').waitFor({ state: 'visible', ...T });
  assert.ok((await page.locator('#screen-setup-needed').innerText()).includes('firebase-config.js'));
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------- レビュー後の修正 ----------
test('荒らし対策: char にプロトタイプ名(__defineGetter__)を書かれても親機の描画が止まらない', async () => {
  const { host, context, errors, code, kids } = await setupMatch([['うさ', 'kappa']]);
  await kids[0].page.evaluate((c) => {
    const uid = sessionStorage.getItem('chinchiro.uid');
    const db = JSON.parse(localStorage.getItem('chinchiro.mock.db'));
    db.rooms[c].players[uid].char = '__defineGetter__';
    localStorage.setItem('chinchiro.mock.db', JSON.stringify(db));
    new BroadcastChannel('chinchiro-mock').postMessage({ type: 'change', tree: db });
  }, code);
  await host.waitForTimeout(400);
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  assert.equal(await host.locator('#queue .queue-row').count(), 0);
  assert.ok(!(await host.locator('#screen-host .arena').innerHTML()).includes('[object Object]'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('非表示にした人の名前は、手番や勝敗の表示にも出ない', async () => {
  const { host, context, code, kids } = await setupMatch([['ひみつ', 'kappa']]);
  await host.locator('#queue .queue-row').first().locator('[data-act="hide"]').click();
  await host.locator('#queue .queue-row .qname').filter({ hasText: '？？？' }).waitFor({ state: 'attached', ...T });
  await fixDice(host, FIX_PARENT_2ME_CHILD_4ZORO);
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await kids[0].page.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  let status = await host.locator('.arena .center .status').innerText();
  assert.ok(!status.includes('ひみつ') && status.includes('？？？'), status);
  await kids[0].page.click('#listener-roll');
  await host.locator('#next-match').waitFor({ state: 'visible', ...T });
  status = await host.locator('.arena .center .status').innerText();
  assert.ok(!status.includes('ひみつ') && status.includes('？？？'), status);
  assert.ok(!(await host.locator('#screen-host .arena').innerText()).includes('ひみつ'));
  await context.close();
});

test('対決スタートの二度押しでも、先頭の人との対戦が上書きされない', async () => {
  const { host, context, code, kids } = await setupMatch([['いちばん', 'kappa'], ['にばん', 'akaoni']]);
  const first = await kids[0].page.evaluate(() => sessionStorage.getItem('chinchiro.uid'));
  await host.evaluate(() => { const b = document.getElementById('start-match'); b.click(); b.click(); b.click(); });
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.waitForTimeout(500);
  const room = await readRoom(host, code);
  assert.equal(room.state.match.childUid, first);
  assert.equal(Object.keys(room.queue).length, 1, '2人目は列に残る');
  await context.close();
});

test('表示専用画面は音を出さない(親機は出す)', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  assert.equal(await host.locator('#stage-overlay').getAttribute('data-muted'), 'false');
  const stagePage = await context.newPage();
  await stagePage.goto(`${url}/index.html?mock=1&room=${code}&stage=1`);
  await stagePage.locator('#screen-stage').waitFor({ state: 'visible', ...T });
  assert.equal(await stagePage.locator('#stage-overlay').getAttribute('data-muted'), 'true');
  await context.close();
});

test('同じブラウザで親機を2つ開くと、2つ目は親機にならず案内が出る', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1&shareduid=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  const second = await context.newPage();
  await second.goto(`${url}/index.html?mock=1&shareduid=1`);
  await second.locator('#screen-host-busy').waitFor({ state: 'visible', ...T });
  assert.ok((await second.locator('#screen-host-busy').innerText()).includes(code));
  assert.equal(await host.locator('#screen-host').evaluate((e) => e.hidden), false, '1つ目はそのまま親機');
  await context.close();
});

test('音のロック解除: unlock() で AudioContext が作られる(iOS 対策)', async () => {
  const { page, context } = await newPage(null, 'index.html?mock=1');
  const r = await page.evaluate(() => { const s = ChinchiroAnim.createSounds(); const before = s.unlocked; s.unlock(); return [before, s.unlocked]; });
  assert.deepEqual(r, [false, true]);
  await context.close();
});

test('QR が描けないときは参加URLを大きく出す', async () => {
  const { page, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  await createRoom(page);
  assert.equal(await page.locator('#qr').evaluate((e) => e.hidden), true);
  assert.ok(await page.locator('#join-url.big').isVisible());
  await context.close();
});

// ---------- 先送りしていた小さな改善 ----------
test('結果が出ると紙吹雪が舞い、次の挑戦者で消える', async () => {
  const { host, context, code, kids } = await setupMatch();
  await fixDice(host, FIX_PARENT_2ME_CHILD_4ZORO);
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await kids[0].page.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kids[0].page.click('#listener-roll');
  await host.locator('#next-match').waitFor({ state: 'visible', ...T });
  await host.locator('#confetti:not([hidden])').waitFor({ state: 'attached', ...T });
  assert.ok((await host.locator('#confetti i').count()) > 10);
  await kids[0].page.locator('#confetti:not([hidden])').waitFor({ state: 'attached', ...T });
  await host.click('#next-match');
  await host.locator('#confetti[hidden]').waitFor({ state: 'attached', ...T });
  await context.close();
});

test('ランキング: 上位10人のほかに配信者が常に出る', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  await host.evaluate((c) => {
    const db = JSON.parse(localStorage.getItem('chinchiro.mock.db'));
    db.rooms[c].players = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}`, { name: `人${i}`, char: 'kappa', joinedAt: 1, online: true, points: 200 + i }]));
    localStorage.setItem('chinchiro.mock.db', JSON.stringify(db));
    new BroadcastChannel('chinchiro-mock').postMessage({ type: 'change', tree: db });
  }, code);
  await host.locator('#ranking .rank-row2').nth(10).waitFor({ state: 'attached', ...T });
  const rows = await host.locator('#ranking .rank-row2').allInnerTexts();
  assert.equal(rows.length, 11);
  assert.ok(rows[0].includes('人11'));
  assert.ok(rows[10].includes('配信者') && rows[10].includes('100点'), rows[10]);
  await context.close();
});

test('?room= が不正な形なら「部屋が見つかりません」', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?mock=1&room=../x');
  await page.locator('#screen-notfound').waitFor({ state: 'visible', ...T });
  assert.deepEqual(errors, []);
  await context.close();
});

test('リスナーのURLで接続に失敗したときは、設定の案内ではなく接続エラーを出す', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?room=ABCD');
  await page.locator('#screen-connect-failed').waitFor({ state: 'visible', ...T });
  assert.ok(!(await page.locator('#screen-connect-failed').innerText()).includes('firebase-config.js'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('壊れた出目の「?」は対戦中でも少しのあいだ表示される', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  const { page: kid } = await openListener(context, code);
  await kid.locator('#screen-join').waitFor({ state: 'visible', ...T });
  await kid.click('#join-watch');
  await kid.locator('#screen-listener').waitFor({ state: 'visible', ...T });
  await host.evaluate((c) => {
    const db = JSON.parse(localStorage.getItem('chinchiro.mock.db'));
    db.rooms[c].state.seq = 5;
    db.rooms[c].state.lastThrow = { by: 'parent', seq: 5, throw: { dice: [9, 0, 'x'], seed: 1, shonben: false, at: 1 } };
    localStorage.setItem('chinchiro.mock.db', JSON.stringify(db));
    new BroadcastChannel('chinchiro-mock').postMessage({ type: 'change', tree: db });
  }, code);
  await kid.locator('#stage .result-stamp[data-hand="invalid"]').waitFor({ state: 'visible', ...T });
  await kid.waitForTimeout(400);
  assert.equal(await kid.locator('#stage-overlay').evaluate((e) => e.hidden), false, '400ms 後もまだ表示されている');
  await kid.locator('#stage-overlay[hidden]').waitFor({ state: 'attached', ...T });
  await context.close();
});

test('リスナーが振ると、親機の返事が来るまで手の中で振る演出が出て、来なければ案内が出る', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  const { page: kid } = await openListener(context, code, '&waitms=600');
  await kid.locator('#screen-join').waitFor({ state: 'visible', ...T });
  await kid.locator('#join-name').fill('まつ');
  await kid.click('#join-challenge');
  await kid.locator('#screen-listener').waitFor({ state: 'visible', ...T });
  const uid = await kid.evaluate(() => sessionStorage.getItem('chinchiro.uid'));
  await host.close(); // 親機がいない
  await kid.evaluate(([c, u]) => {
    const db = JSON.parse(localStorage.getItem('chinchiro.mock.db'));
    db.rooms[c].state = { seq: 2, phase: 'child', match: { childUid: u, round: 1, parent: { throws: [{ dice: [2, 2, 5], seed: 1, shonben: false, hand: { type: 'me', value: 5, mult: 1, label: '5の目', lose: false, rank: 105 }, at: 1 }], hand: { type: 'me', value: 5, mult: 1, label: '5の目', lose: false, rank: 105 }, done: true }, child: { done: false } }, host: { points: 100, wins: 0, losses: 0, drinks: 0 } };
    delete db.rooms[c].queue;
    localStorage.setItem('chinchiro.mock.db', JSON.stringify(db));
    new BroadcastChannel('chinchiro-mock').postMessage({ type: 'change', tree: db });
  }, [code, uid]);
  await kid.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kid.click('#listener-roll');
  await kid.locator('#stage-overlay:not([hidden]) .hand.rattle').waitFor({ state: 'visible', ...T });
  assert.ok((await kid.locator('#stage .bubble').innerText()).includes('振っています'));
  await kid.locator('#my-status').filter({ hasText: '配信者の画面を待っています' }).waitFor({ state: 'visible', ...T });
  await kid.locator('#stage-overlay[hidden]').waitFor({ state: 'attached', ...T });
  await context.close();
});

test('countUp: 数字が最終値まで動く', async () => {
  const { page, context } = await newPage(null, 'index.html?mock=1');
  const r = await page.evaluate(async () => {
    const el = document.createElement('span'); document.body.appendChild(el);
    ChinchiroAnim.countUp(el, 100, 130, 300);
    const mid = el.textContent;
    await new Promise((r) => setTimeout(r, 600));
    return [mid, el.textContent];
  });
  assert.notEqual(r[0], '130');
  assert.equal(r[1], '130');
  await context.close();
});

test('描画: 内容が変わらない更新では対戦の場を作り直さない(勝者の跳ねが続く)', async () => {
  const { host, context, code, kids } = await setupMatch();
  await fixDice(host, FIX_PARENT_2ME_CHILD_4ZORO);
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await kids[0].page.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kids[0].page.click('#listener-roll');
  await host.locator('#next-match').waitFor({ state: 'visible', ...T });
  const handle = await host.locator('#screen-host .fighter.winner').elementHandle();
  await injectPresence(host, code, 3);
  await host.evaluate((c) => { const db = JSON.parse(localStorage.getItem('chinchiro.mock.db')); new BroadcastChannel('chinchiro-mock').postMessage({ type: 'change', tree: db }); }, code);
  await host.waitForTimeout(300);
  assert.equal(await handle.evaluate((e) => e.isConnected), true);
  await context.close();
});

// ---------- 音・先バレ防止・派手さ ----------
test('役が出たら声で読み上げる(読み上げ機能に渡す文言)', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.setDefaultTimeout(T.timeout);
  await context.addInitScript(() => { window.__spoken = []; window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); }; });
  const page = await context.newPage();
  await page.goto(`${url}/index.html?demo=1&dice=1,1,1&seed=3&skip=1`);
  await page.locator('#stage .result-stamp[data-hand="pinzoro"]').waitFor({ state: 'visible', ...T });
  await page.waitForTimeout(600);
  const spoken = await page.evaluate(() => window.__spoken);
  assert.ok(spoken.some((t) => t.includes('ピンゾロ')), JSON.stringify(spoken));
  await context.close();
});

test('サイコロが止まるまで、役・勝敗・点数は画面に出ない', async () => {
  // quick なし(本物の時間で動かす)
  const { page: host, context } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host);
  const { page: kid } = await openListener(context, code);
  await kid.locator('#join-name').fill('うさ');
  await kid.click('#join-challenge');
  await host.locator('#queue .queue-row').first().waitFor({ state: 'visible', ...T });
  await fixDice(host, FIX_PARENT_2ME_CHILD_4ZORO);
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await host.locator('#stage-overlay:not([hidden])').waitFor({ state: 'attached', ...T });
  // 親の投げの最中: 役はまだ出ない
  assert.equal(await host.locator('#screen-host .fighter.host .fhand').innerText(), '');
  assert.ok(!(await host.locator('#screen-host .arena .center .status').innerText()).includes('うさ さんの番'));
  await host.locator('#stage-overlay[hidden]').waitFor({ state: 'attached', timeout: 15000 });
  assert.ok((await host.locator('#screen-host .fighter.host .fhand').innerText()).includes('2の目'));
  // 子の投げの最中: 勝敗・点数はまだ出ない
  await kid.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kid.click('#listener-roll');
  await kid.locator('#stage-overlay:not([hidden]) .cube').first().waitFor({ state: 'visible', ...T });
  assert.ok(!(await kid.locator('#my-status').innerText()).includes('勝ち'));
  assert.ok((await kid.locator('#my-record').innerText()).includes('100'));
  assert.ok(!(await host.locator('#screen-host .arena .center').innerText()).includes('×3'));
  assert.ok((await host.locator('#ranking').innerText()).includes('100点'));
  assert.equal(await host.locator('#confetti').evaluate((e) => e.hidden), true);
  await kid.locator('#stage-overlay[hidden]').waitFor({ state: 'attached', timeout: 15000 });
  await kid.locator('#my-status').filter({ hasText: '勝ち' }).waitFor({ state: 'visible', ...T });
  assert.ok((await host.locator('#screen-host .arena .center').innerText()).includes('×3'));
  await host.locator('#confetti:not([hidden])').waitFor({ state: 'attached', ...T });
  await context.close();
});

test('派手さ: 着地のたびに砂煙が出て、最後の1個はズームする', async () => {
  const { page, context } = await newPage(null, 'index.html?demo=1&dice=2,2,5&seed=7');
  await page.locator('#stage .table.zoom').waitFor({ state: 'attached', timeout: 10000 });
  await page.locator('#stage .result-stamp[data-hand="me"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.ok((await page.locator('#stage .fx-layer .dust').count()) >= 6, '砂煙');
  await context.close();
});

test('音声ファイルがあればそれを再生し、無ければ読み上げに切り替える', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.setDefaultTimeout(T.timeout);
  await context.addInitScript(() => {
    window.__spoken = []; window.__played = [];
    window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); };
    window.Audio = class {
      constructor(src) { this.src = src; this.listeners = {}; }
      addEventListener(k, f) { this.listeners[k] = f; }
      play() { window.__played.push(this.src); return Promise.resolve(); }
    };
  });
  const page = await context.newPage();
  await page.goto(`${url}/index.html?mock=1`);
  const r = await page.evaluate(async () => {
    const s = ChinchiroAnim.createSounds({ voiceFiles: { pinzoro: 'voice/pinzoro.mp3' } });
    s.voice('ピンゾロ！', 'pinzoro');
    s.voice('シゴロ！', 'shigoro');
    await new Promise((r) => setTimeout(r, 50));
    return { played: window.__played, spoken: window.__spoken };
  });
  assert.deepEqual(r.played, ['voice/pinzoro.mp3']);
  assert.deepEqual(r.spoken, ['シゴロ！']);
  await context.close();
});

test('voice/ に音声ファイルがあれば起動時に見つけて、その役のコールに使う', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.setDefaultTimeout(T.timeout);
  await context.route('**/firebase-config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'window.FIREBASE_CONFIG = null;' }));
  await context.route('**/voice/shigoro.m4a', (route) => route.fulfill({ status: 200, contentType: 'audio/mp4', body: '' }));
  await context.addInitScript(() => {
    window.__spoken = []; window.__played = [];
    window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); };
    window.Audio = class {
      constructor() { this.src = ''; this.dataset = {}; }
      addEventListener() {}
      play() { window.__played.push(this.src); return Promise.resolve(); }
    };
  });
  const page = await context.newPage();
  await page.goto(`${url}/index.html?demo=1&dice=4,5,6&seed=7&skip=1`);
  await page.locator('#stage .result-stamp[data-hand="shigoro"]').waitFor({ state: 'visible', ...T });
  await page.waitForFunction(() => window.__played.includes('voice/shigoro.m4a'), null, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => window.__spoken), []);
  await context.close();
});

// ---------- 持ち点 ----------
test('持ち点: 300 を選んで部屋を作ると、親の成績・参加者・ランキングが 300 点から', async () => {
  const { page: host, context, errors } = await newPage(null, 'index.html?mock=1&quick=1', { width: 1280, height: 720 });
  await host.locator('#host-name').fill('親');
  await host.locator('#start-choices .choice[data-start="300"]').click();
  await host.locator('#create-room').click();
  await host.locator('#room-code').waitFor(T);
  assert.ok((await host.locator('#host-record').innerText()).includes('300点'));
  const code = (await host.locator('#room-code').innerText()).trim();
  assert.equal((await readRoom(host, code)).settings.startPoints, 300);
  const { page: kid } = await joinAs(context, code, 'たろう');
  await kid.locator('#my-record').waitFor(T);
  assert.ok((await kid.locator('#my-record').innerText()).includes('300点'));
  await host.locator('#queue .queue-row').first().waitFor(T);
  assert.ok((await host.locator('#queue').innerText()).includes('300点'));
  assert.ok((await host.locator('#ranking').innerText()).includes('300点'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('持ち点: 自由入力は 1〜99999 の整数だけ。空・0・負・小数・大きすぎは 100', async () => {
  for (const [typed, want] of [['777', '777点'], ['0', '100点'], ['-5', '100点'], ['12.5', '100点'], ['', '100点'], ['123456', '100点']]) {
    const { page: host, context } = await newPage(null, 'index.html?mock=1&quick=1');
    await host.locator('#start-choices .choice[data-start="custom"]').click();
    await host.locator('#start-custom').waitFor({ state: 'visible', ...T });
    await host.locator('#start-custom').fill(typed);
    await host.locator('#create-room').click();
    await host.locator('#room-code').waitFor(T);
    assert.ok((await host.locator('#host-record').innerText()).includes(want), `${typed} → ${want}`);
    await context.close();
  }
});

test('持ち点が未設定の古い部屋は 100 点として表示される', async () => {
  const { page: host, context, errors } = await newPage(null, 'index.html?mock=1&quick=1', { width: 1280, height: 720 });
  await host.locator('#start-choices .choice[data-start="1000"]').click();
  const code = await createRoom(host);
  assert.ok((await host.locator('#host-record').innerText()).includes('1000点'));
  // 旧バージョンの部屋の形にする(startPoints も log も host.points も無い)
  await host.evaluate((c) => {
    const db = JSON.parse(localStorage.getItem('chinchiro.mock.db'));
    delete db.rooms[c].settings.startPoints; delete db.rooms[c].state.log; delete db.rooms[c].state.host;
    localStorage.setItem('chinchiro.mock.db', JSON.stringify(db));
  }, code);
  await host.reload();
  await host.locator('#screen-host').waitFor({ state: 'visible', ...T });
  await host.locator('#host-record').waitFor(T);
  assert.ok((await host.locator('#host-record').innerText()).includes('100点'));
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------- ルール表・履歴 ----------
/** 出目を指定した Math.random の列(fixDice 用): 各投げ = [ションベン判定, 目×3, seed]。 */
const diceSeq = (...throws) => JSON.stringify(throws.flatMap((d) => [0.5, ...d.map((x) => (x - 0.5) / 6), 0.5]));

test('ルール表: 親機とスマホで開いて閉じられ、役・倍率・この部屋の持ち点が書いてある', async () => {
  const { host, kids, context, errors } = await setupMatch([['うさ', 'kappa']], { start: '300' });
  const kid = kids[0].page;
  await host.locator('#rules-btn').click();
  await host.locator('#rules:not([hidden])').waitFor(T);
  const text = await host.locator('#rules-body').innerText();
  for (const s of ['ピンゾロ', '×5', 'ヒフミ', '持ち点 300', '1戦 10点']) assert.ok(text.includes(s), s);
  await host.keyboard.press('Escape');
  await host.locator('#rules[hidden]').waitFor({ state: 'attached', ...T });
  await kid.locator('#rules-btn-l').click();
  await kid.locator('#rules:not([hidden])').waitFor(T);
  assert.ok((await kid.locator('#rules-body').innerText()).includes('シゴロ'));
  await kid.locator('#rules-close').click();
  await kid.locator('#rules[hidden]').waitFor({ state: 'attached', ...T });
  // 背景タップでも閉じる
  await kid.locator('#rules-btn-l').click();
  await kid.locator('#rules:not([hidden])').waitFor(T);
  await kid.locator('#rules').click({ position: { x: 5, y: 5 } });
  await kid.locator('#rules[hidden]').waitFor({ state: 'attached', ...T });
  assert.deepEqual(errors, []);
  await context.close();
});

test('ルール表: 参加画面(名前入力)からも開け、その部屋の設定(持ち点・単位)が出る', async () => {
  const { page: host, context } = await newPage(null, 'index.html?mock=1&quick=1', { width: 1280, height: 720 });
  const code = await createRoom(host, { start: '300', unit: '20' });
  const { page } = await openListener(context, code, '&quick=1');
  await page.locator('#screen-join').waitFor({ state: 'visible', ...T });
  await page.locator('#rules-link').click();
  await page.locator('#rules:not([hidden])').waitFor(T);
  const text = await page.locator('#rules-body').innerText();
  for (const t of ['ピンゾロ', '持ち点 300', '1戦 20点']) assert.ok(text.includes(t), t);
  await context.close();
});

test('履歴: 対戦中はアリーナに各側の投げが並び、決着すると両画面の「対戦の記録」に1行出る', async () => {
  const { host, kids, context, code, errors } = await setupMatch();
  const kid = kids[0].page;
  await fixDice(host, diceSeq([2, 4, 6], [4, 4, 6], [1, 2, 3]));
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await host.locator('.fighter.host .throws .throw').first().waitFor({ state: 'visible', ...T });
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await host.locator('.fighter.host .throws .throw').nth(1).waitFor({ state: 'visible', ...T });
  const th = await host.locator('.fighter.host .throws').innerText();
  assert.ok(th.includes('目なし') && th.includes('6の目'), th);
  assert.equal(await host.locator('.fighter.host .throws .mdice[data-n="4"]').count(), 3);
  assert.ok((await host.locator('#screen-host [data-ref="log"]').innerText()).includes('まだ対戦がありません'));
  await kid.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kid.click('#listener-roll');
  await host.locator('#screen-host [data-ref="log"] .log-row').first().waitFor({ state: 'visible', ...T });
  const row = await host.locator('#screen-host [data-ref="log"]').innerText();
  for (const s of ['#1', '6の目', 'うさ', 'ヒフミ', '親の勝ち', '×2', '+20点']) assert.ok(row.includes(s), s);
  await kid.locator('#screen-listener [data-ref="log"] .log-row.mine').waitFor({ state: 'visible', ...T });
  assert.ok((await kid.locator('.fighter.child .throws').innerText()).includes('ヒフミ'));
  assert.ok((await host.locator('#screen-host [data-ref="legend"]').innerText()).includes('ピンゾロ ×5'));
  assert.equal((await readRoom(host, code)).state.log.length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('履歴: 非表示にした人は記録でも？？？', async () => {
  const { host, kids, context } = await setupMatch();
  const kid = kids[0].page;
  await host.locator('#queue .queue-row').first().locator('[data-act="hide"]').click();
  await host.locator('#queue .queue-row .qname').filter({ hasText: '？？？' }).waitFor({ state: 'visible', ...T });
  await fixDice(host, diceSeq([1, 2, 3]));
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await host.locator('#screen-host [data-ref="log"] .log-row').first().waitFor({ state: 'visible', ...T });
  const row = await host.locator('#screen-host [data-ref="log"]').innerText();
  assert.ok(row.includes('？？？') && !row.includes('うさ'), row);
  assert.ok(row.includes('(振らず)') && row.includes('-20点'));
  await kid.locator('#screen-listener [data-ref="log"] .log-row').first().waitFor({ state: 'visible', ...T });
  await context.close();
});

// ---------- 音の確実化(AudioContext と Audio を差し替えて振る舞いを見る) ----------
const FAKE_AUDIO = () => {
  window.__resumes = 0; window.__started = 0; window.__allow = false; window.__played = []; window.__audios = [];
  const node = () => { const n = { connect() { return n; }, start() { window.__started++; }, stop() {}, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, buffer: null, type: '', Q: { value: 0 } }; return n; };
  window.AudioContext = class {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 48000; this.destination = {}; this._cbs = []; window.__ctx = this; }
    resume() { window.__resumes++; return new Promise((r) => { if (window.__allow) { this.state = 'running'; this._cbs.forEach((f) => f()); r(); } }); }
    addEventListener(k, f) { if (k === 'statechange') this._cbs.push(f); }
    createBuffer() { return { getChannelData() { return new Float32Array(16); } }; }
    createBufferSource() { return node(); } createOscillator() { return node(); } createGain() { return node(); } createBiquadFilter() { return node(); }
  };
  window.webkitAudioContext = window.AudioContext;
  window.Audio = class {
    constructor(src) { this.src = src || ''; this.paused = true; this.loop = false; this.dataset = {}; window.__audios.push(this); }
    addEventListener() {} setAttribute() {}
    play() { this.paused = false; window.__played.push({ src: this.src, loop: this.loop }); return Promise.resolve(); }
    pause() { this.paused = true; }
  };
};
const loopPlays = (page) => page.evaluate(() => window.__played.filter((p) => p.loop && String(p.src).startsWith('data:audio/wav')).length);

test('音: まだ触っていない(suspended)間は resume を試し、300ms 以内に running にならなければその音は捨てる', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(FAKE_AUDIO);
  const page = await context.newPage();
  await page.goto(`${url}/index.html?mock=1`);
  const r1 = await page.evaluate(async () => {
    const s = ChinchiroAnim.createSounds(); window.__s = s;
    s.clack();
    await new Promise((r) => setTimeout(r, 450));
    return { resumes: window.__resumes, started: window.__started, ready: s.ready };
  });
  assert.ok(r1.resumes >= 1, 'resume を試す');
  assert.equal(r1.started, 0, '鳴らせないときは捨てる');
  assert.equal(r1.ready, false);
  const r2 = await page.evaluate(async () => {
    window.__allow = true;
    window.__s.clack();
    await new Promise((r) => setTimeout(r, 100));
    return { started: window.__started, ready: window.__s.ready };
  });
  assert.ok(r2.started >= 1, '許可されたら鳴る');
  assert.equal(r2.ready, true);
  await context.close();
});

test('音: 親機は最初のタップで無音ループが回り、AudioContext が running になるとバッジが消える', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(FAKE_AUDIO);
  const { page: host } = await newPage(context, 'index.html?mock=1&quick=1');
  await createRoom(host);
  await host.locator('#audio-badge:not([hidden])').waitFor({ state: 'visible', ...T });
  assert.ok((await host.locator('#audio-badge').innerText()).includes('タップで音をオン'));
  await host.evaluate(() => { window.__allow = true; });
  await host.mouse.click(600, 600);
  await host.locator('#audio-badge[hidden]').waitFor({ state: 'attached', ...T });
  assert.ok((await loopPlays(host)) >= 1, '無音ループ');
  await context.close();
});

test('音: スマホは自分の対戦中だけ無音ループが回り、決着したら止まる', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(FAKE_AUDIO);
  const { page: host } = await newPage(context, 'index.html?mock=1&quick=1');
  const code = await createRoom(host);
  const { page: kid } = await joinAs(context, code, 'うさ');
  await kid.evaluate(() => { window.__allow = true; });
  await kid.mouse.click(200, 700);
  await kid.waitForTimeout(100);
  assert.equal(await loopPlays(kid), 0, '見ているだけの間は回さない');
  await host.locator('#queue .queue-row').first().waitFor({ state: 'visible', ...T });
  await fixDice(host, diceSeq([4, 4, 6], [1, 2, 3]));
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await kid.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kid.click('#listener-roll');
  await kid.locator('#screen-listener [data-ref="log"] .log-row').first().waitFor({ state: 'visible', ...T });
  assert.ok((await loopPlays(kid)) >= 1, '自分の対戦中に回る');
  assert.equal(await kid.evaluate(() => window.__audios.find((a) => a.loop).paused), false, '結果を見ている間はまだ回る');
  await host.click('#next-match');
  await kid.locator('#requeue').waitFor({ state: 'visible', ...T });
  assert.equal(await kid.evaluate(() => window.__audios.find((a) => a.loop).paused), true, '決着したら止まる');
  await context.close();
});

test('音: 表示専用(stage=1)にはバッジが出ず、ループも回らない', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(FAKE_AUDIO);
  const { page: host } = await newPage(context, 'index.html?mock=1&quick=1');
  const code = await createRoom(host);
  const stagePage = await context.newPage();
  await stagePage.goto(`${url}/index.html?mock=1&room=${code}&stage=1`);
  await stagePage.locator('#screen-stage').waitFor({ state: 'visible', ...T });
  await stagePage.evaluate(() => { window.__allow = true; });
  await stagePage.mouse.click(600, 600);
  await stagePage.waitForTimeout(100);
  assert.equal(await stagePage.locator('#audio-badge').evaluate((e) => e.hidden), true);
  assert.equal(await loopPlays(stagePage), 0);
  await context.close();
});

// ---------- リーチ演出 ----------
test('リーチ: 1,1,1 を reach=3 で投げると「ピンゾロリーチ」「激アツ」「あと 1 で ピンゾロ ×5」のカットインと暗転・ズームの後に、5秒以上溜めてピンゾロ', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?demo=1&dice=1,1,1&seed=7&reach=3');
  await page.locator('#stage .cutin').waitFor({ state: 'visible', timeout: 10000 });
  const t0 = Date.now();
  const cut = await page.locator('#stage .cutin').innerText();
  for (const t of ['激アツ', 'ピンゾロリーチ', 'ピンゾロ ×5']) assert.ok(cut.includes(t), cut);
  assert.equal(await page.locator('#stage .cutin .cdie[data-n="1"]').count(), 1, '何が出ればよいかサイコロで見せる');
  assert.ok(await page.locator('#stage .table.kind-pinzoro').count(), '役ごとの色');
  assert.equal(await page.locator('#stage .table.reach.zoom.reach-l3').count(), 1);
  assert.equal(await page.locator('#stage .cube.hold').count(), 1);
  assert.equal(await page.locator('#stage .result-stamp').innerText(), ''); // 溜め中は結果なし
  await page.locator('#stage .result-stamp[data-hand="pinzoro"]').waitFor({ state: 'visible', timeout: 12000 });
  assert.ok(Date.now() - t0 >= 4500, '強い役のリーチは長く溜める: ' + (Date.now() - t0));
  assert.equal(await page.locator('#stage .table.reach').count(), 0);
  assert.equal(await page.locator('#stage .cube.hold').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('リーチ: 1,2,3 を reach=2 で投げると「大ピンチ」「ヒフミ」の後にヒフミ', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?demo=1&dice=1,2,3&seed=7&reach=2');
  await page.locator('#stage .cutin').waitFor({ state: 'visible', timeout: 10000 });
  const cut = await page.locator('#stage .cutin').innerText();
  assert.ok(cut.includes('大ピンチ') && cut.includes('ヒフミ'), cut);
  assert.equal(await page.locator('#stage .cutin .cdie').count(), 1);
  assert.equal(await page.locator('#stage .table.reach.pinch').count(), 1);
  await page.locator('#stage .result-stamp[data-hand="hifumi"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('リーチ: 溜め中にタップすると即結果で、カットイン・暗転・溜めが残らない', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?demo=1&dice=1,1,1&seed=7&reach=3');
  await page.locator('#stage .cutin').waitFor({ state: 'visible', timeout: 10000 });
  // 激アツ中は画面が揺れている(要素が動き続ける)ので、座標でタップする
  const box = await page.locator('#stage').boundingBox();
  const t0 = Date.now();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('#stage .result-stamp[data-hand="pinzoro"]').waitFor({ state: 'visible', ...T });
  assert.ok(Date.now() - t0 < 1500, 'すぐ結果');
  assert.equal(await page.locator('#stage .cutin').count(), 0);
  assert.equal(await page.locator('#stage .table.reach').count(), 0);
  assert.equal(await page.locator('#stage .cube.hold').count(), 0);
  // 続けて別の投げを始めても、前のリーチの残骸がない(play を直接呼ぶ)
  await page.evaluate(() => { ChinchiroDemo.stage.play({ dice: [3, 3, 5], seed: 5, shonben: false, hand: { type: 'me', value: 5 } }, { remaining: 0, forceReach: 1 }); });
  await page.locator('#stage .cutin').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.locator('#stage .cutin').count(), 1);
  assert.equal(await page.locator('#stage .cube').count(), 3);
  await page.locator('#stage .result-stamp[data-hand="me"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('リーチ: quick=1 と reach=0 ではリーチなし(.cutin が出ない)', async () => {
  const a = await newPage(null, 'index.html?demo=1&dice=1,1,1&seed=7&quick=1');
  await a.page.locator('#stage .result-stamp[data-hand="pinzoro"]').waitFor({ state: 'visible', timeout: 2500 }); // quick なら一瞬で結果
  assert.equal(await a.page.locator('#stage .cutin').count(), 0);
  await a.context.close();
  const b = await newPage(null, 'index.html?demo=1&dice=1,1,1&seed=7&reach=0');
  await b.page.locator('#stage .table.zoom').waitFor({ state: 'attached', timeout: 10000 });
  await b.page.locator('#stage .result-stamp[data-hand="pinzoro"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await b.page.locator('#stage .cutin').count(), 0);
  assert.deepEqual(b.errors, []);
  await b.context.close();
});

// ---------- 結果の派手さ ----------
test('派手さ: ピンゾロは金の光線・集中線・画面全体の金フラッシュ・粒子 60 個以上', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?demo=1&dice=1,1,1&seed=7&reach=0');
  await page.locator('#stage .result-stamp[data-hand="pinzoro"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.ok(await page.locator('#stage .fx-layer .rays.gold').count(), '光線');
  assert.ok(await page.locator('#stage .fx-layer .impact').count(), '集中線');
  assert.ok(await page.locator('#stage.bigwin-gold').count(), '画面全体の金フラッシュ');
  assert.ok((await page.locator('#stage .fx-layer .particle').count()) >= 60, '粒子');
  assert.deepEqual(errors, []);
  await context.close();
});

test('派手さ: ゾロ目は虹の光線、シゴロは青の光線', async () => {
  const a = await newPage(null, 'index.html?demo=1&dice=6,6,6&seed=7&reach=0');
  await a.page.locator('#stage .result-stamp[data-hand="zoro"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.ok(await a.page.locator('#stage .fx-layer .rays.rainbow').count());
  assert.ok(await a.page.locator('#stage .fx-layer .impact').count());
  await a.context.close();
  const b = await newPage(null, 'index.html?demo=1&dice=4,5,6&seed=7&reach=0');
  await b.page.locator('#stage .result-stamp[data-hand="shigoro"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.ok(await b.page.locator('#stage .fx-layer .rays.blue').count());
  await b.context.close();
});

test('派手さ: 投げ込みで光の筋が走り、砂煙は 8 個以上。リーチが外れた目はしょんぼり表示', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?demo=1&dice=3,3,5&seed=5&reach=1');
  await page.locator('#stage .fx-layer .streak').waitFor({ state: 'attached', timeout: 10000 });
  await page.locator('#stage .result-stamp[data-hand="me"]').waitFor({ state: 'visible', timeout: 12000 });
  assert.ok((await page.locator('#stage .fx-layer .dust').count()) >= 8, '砂煙');
  assert.equal(await page.locator('#stage .result-stamp[data-fail="1"]').count(), 1, 'リーチ外れ');
  assert.deepEqual(errors, []);
  await context.close();
});

test('音: 操作の外の unlock では読み上げを解錠済みにせず、<audio> の解錠に失敗したら次の操作でやり直す', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    window.__spoken = []; window.__played = []; window.__reject = true;
    window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); };
    window.Audio = class {
      constructor(src) { this.src = src || ''; this.dataset = {}; this.paused = true; this.loop = false; }
      addEventListener() {} setAttribute() {} removeAttribute(k) { if (k === 'src') this.src = ''; } pause() { this.paused = true; }
      play() { window.__played.push(this.src); if (window.__reject) return Promise.reject(new Error('NotAllowedError')); this.paused = false; return Promise.resolve(); }
    };
  });
  const page = await context.newPage();
  await page.goto(`${url}/index.html?mock=1`);
  const r = await page.evaluate(async () => {
    const wait = () => new Promise((r) => setTimeout(r, 20));
    const s = ChinchiroAnim.createSounds();
    s.unlock(false); await wait();                       // タブ復帰など、操作の外(play は拒否される)
    const afterNonGesture = { spoken: window.__spoken.length };
    s.unlock(); await wait();                            // 操作の中。まだ拒否 → 次でやり直せるように戻す
    window.__reject = false;
    s.unlock(); await wait();                            // 許可された操作 → 解錠
    s.unlock(); await wait();                            // 解錠済み → 増えない
    return { afterNonGesture, spoken: window.__spoken, played: window.__played.filter((x) => String(x).startsWith('data:audio/wav')).length };
  });
  assert.equal(r.afterNonGesture.spoken, 0, '操作の外では読み上げを解錠しない');
  assert.deepEqual(r.spoken, [' '], '操作の中で一度だけ');
  assert.equal(r.played, 3, '拒否された分はやり直し、解錠できたら増えない');
  await context.close();
});

test('音: 溜め中に reset() すると鼓動・唸りのタイマーも止まる', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(FAKE_AUDIO);
  await context.addInitScript(() => { window.__allow = true; });
  const page = await context.newPage();
  await page.goto(`${url}/index.html?demo=1&dice=1,2,3&seed=7&reach=2`);
  await page.locator('#stage .cutin').waitFor({ state: 'visible', timeout: 10000 });
  const r = await page.evaluate(async () => {
    ChinchiroDemo.stage.reset();
    await new Promise((r) => setTimeout(r, 250));
    const before = window.__started;
    await new Promise((r) => setTimeout(r, 1500));
    return { before, after: window.__started };
  });
  assert.equal(r.after, r.before, '唸りが続いている');
  await context.close();
});

// ---------- 目なしは負けではない / ドアップ ----------
test('目なし: 3投で役なしなら目なしになり子の番へ。両方目なしは引き分け、片方だけなら負け', async () => {
  const { host, kids, context, code, errors } = await setupMatch();
  const kid = kids[0].page;
  await fixDice(host, diceSeq([2, 4, 6], [1, 3, 5], [2, 3, 5], [1, 3, 5], [2, 4, 6], [2, 3, 5], [4, 4, 6], [1, 3, 5], [2, 4, 6], [2, 3, 5]));
  await host.click('#start-match');
  for (let i = 0; i < 3; i++) {
    await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
    await host.click('#host-roll');
    await host.locator('.fighter.host .throws .throw').nth(i).waitFor({ state: 'visible', ...T });
  }
  assert.equal(await phaseOf(host, code), 'child', '親が目なしでも子の番になる');
  assert.ok((await host.locator('.fighter.host .fhand').innerText()).includes('目なし'));
  assert.ok((await host.locator('#screen-host .arena .status').innerText()).includes('1/3'));
  for (let i = 0; i < 3; i++) {
    await kid.locator('#listener-roll').waitFor({ state: 'visible', ...T });
    await kid.click('#listener-roll');
    await host.waitForTimeout(300);
  }
  await host.locator('#screen-host .arena .status').filter({ hasText: '引き分け' }).waitFor({ state: 'visible', ...T });
  assert.equal(await phaseOf(host, code), 'parent');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll'); // 6の目
  for (let i = 0; i < 3; i++) {
    await kid.locator('#listener-roll').waitFor({ state: 'visible', ...T });
    await kid.click('#listener-roll');
    await host.waitForTimeout(300);
  }
  await host.locator('#screen-host [data-ref="log"] .log-row').first().waitFor({ state: 'visible', ...T });
  const row = await host.locator('#screen-host [data-ref="log"]').innerText();
  for (const t of ['6の目', '目なし', '親の勝ち', '+10点']) assert.ok(row.includes(t), t);
  assert.deepEqual(errors, []);
  await context.close();
});

test('ドアップ: リーチの溜め中は最後の1個が 2.5 倍以上に寄り、集中線(スピードライン)と画面の揺れが付く', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?demo=1&dice=1,1,1&seed=7&reach=3');
  await page.locator('#stage .cutin').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(700); // ズームのトランジションが終わるまで
  const scale = await page.locator('#stage .table').evaluate((e) => { const m = getComputedStyle(e).transform.match(/matrix\(([^,]+),/); return m ? Number(m[1]) : 1; });
  assert.ok(scale >= 2.5, 'scale=' + scale);
  assert.ok(await page.locator('#stage .fx-layer .speedlines').count(), 'スピードライン');
  assert.ok(await page.locator('#stage.reaching.l3').count(), '画面の揺れ(l3)');
  await page.locator('#stage .result-stamp[data-hand="pinzoro"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.locator('#stage .fx-layer .speedlines').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------- 対決スタートの演出 ----------
test('対決スタート: 両者のキャラと名前が左右から出て「VS」が叩き込まれ、終わると親の番になる(全端末)', async () => {
  const { page: host, context, errors } = await newPage(null, 'index.html?mock=1', { width: 1280, height: 720 });
  const code = await createRoom(host, { name: 'おやま' });
  const { page: kid } = await joinAs(context, code, 'うさ', 'kappa');
  await host.locator('#queue .queue-row').first().waitFor({ state: 'visible', ...T });
  await host.click('#start-match');
  await host.locator('#stage-overlay:not([hidden]) .intro').waitFor({ state: 'visible', ...T });
  const text = await host.locator('#stage .intro').innerText();
  for (const t of ['おやま', 'うさ', 'VS', '対決スタート']) assert.ok(text.includes(t), text);
  assert.equal(await host.locator('#stage .intro .fighter-card').count(), 2);
  await kid.locator('#stage-overlay:not([hidden]) .intro').waitFor({ state: 'visible', ...T });
  await host.locator('#stage-overlay[hidden]').waitFor({ state: 'attached', timeout: 8000 });
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  assert.equal(await host.locator('#stage .intro').count(), 0, '終わったら消える');
  assert.deepEqual(errors, []);
  await context.close();
});

test('対決スタート: quick では一瞬で終わり、引き分けの再戦では出ない。デモ(intro=1)で確認できる', async () => {
  const { host, kids, context, code } = await setupMatch();
  const kid = kids[0].page;
  await fixDice(host, diceSeq([4, 4, 6], [6, 2, 2]));
  await host.click('#start-match');
  await host.locator('#host-roll').waitFor({ state: 'visible', ...T });
  await host.click('#host-roll');
  await kid.locator('#listener-roll').waitFor({ state: 'visible', ...T });
  await kid.click('#listener-roll');
  await host.locator('#screen-host .arena .status').filter({ hasText: '引き分け' }).waitFor({ state: 'visible', ...T });
  await host.waitForTimeout(300);
  assert.equal(await host.locator('#stage .intro').count(), 0, '再戦では出ない');
  assert.equal(await phaseOf(host, code), 'parent');
  await context.close();
  const d = await newPage(null, 'index.html?demo=1&intro=1');
  await d.page.locator('#stage .intro').waitFor({ state: 'visible', ...T });
  assert.ok((await d.page.locator('#stage .intro').innerText()).includes('VS'));
  await d.context.close();
});

test('音: 効果音の揺らぎは Math.random を使わない(出目の乱数を乱さない)', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(FAKE_AUDIO);
  await context.addInitScript(() => { window.__allow = true; });
  const page = await context.newPage();
  await page.goto(`${url}/index.html?mock=1`);
  const r = await page.evaluate(async () => {
    const s = ChinchiroAnim.createSounds();
    s.unlock();
    await new Promise((r) => setTimeout(r, 50));
    window.__rnd = 0; Math.random = () => { window.__rnd++; return 0.5; };
    s.clack(); s.rattle(120); s.whoosh(); s.boom(); s.hit();
    await new Promise((r) => setTimeout(r, 300));
    return { rnd: window.__rnd, started: window.__started };
  });
  assert.ok(r.started > 0, '音は鳴っている');
  assert.equal(r.rnd, 0, 'Math.random を呼ばない');
  await context.close();
});
