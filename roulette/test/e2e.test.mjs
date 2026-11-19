// 画面のテスト(Playwright)。mock 同期(同じブラウザ内だけ)とローカル HTTP サーバーで動かす。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { serve } from './helpers.mjs';
import { stamp } from './stamp-version.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const T = { timeout: 8000 };
let browser, srv, url;

before(async () => { browser = await chromium.launch(); srv = await serve(); url = srv.url; });
after(async () => { await browser?.close(); await srv?.close(); });

test('公開: index.html の JS/CSS の印(?v=)が中身と合っている(再読み込みで必ず新しい版になる)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(stamp(html) === html, 'JS/CSS を変えたら node roulette/test/stamp-version.mjs を実行して、index.html の印を更新する');
});

async function newContext(viewport = { width: 1200, height: 900 }) {
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(T.timeout);
  // テストでは Firebase の設定を無効にする(本番の設定ファイルがあっても外に接続しない)
  await context.route('**/firebase-config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'window.FIREBASE_CONFIG = null;' }));
  return context;
}
async function open(context, path, viewport) {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept()); // 確認(ブロック・見本・部屋を閉じる)は「はい」
  await page.goto(`${url}/${path}`);
  return { page, errors };
}
const PHONE = { width: 390, height: 844 };
const visible = (page, id) => page.locator(`#${id}`).waitFor({ state: 'visible', ...T });

/** 配信者として部屋を作る。quick=1 で回る演出は一瞬。 */
async function createRoom(extra = '') {
  const context = await newContext();
  const { page: host, errors } = await open(context, `index.html?mock=1&quick=1${extra}`);
  await visible(host, 'screen-host-entry');
  await host.click('#create-room');
  await visible(host, 'screen-host');
  const code = await host.locator('#screen-host [data-ref="code"]').innerText();
  assert.match(code, /^[A-Z2-9]{4}$/);
  return { context, host, code, errors };
}
/** リスナーとして入る(名前を入れて「参加する」)。 */
async function joinAs(context, code, name, extra = '') {
  const { page, errors } = await open(context, `index.html?mock=1&quick=1&room=${code}${extra}`, PHONE);
  await visible(page, 'screen-join');
  await page.fill('#join-name', name);
  await page.click('#join-enter');
  await visible(page, 'screen-listener');
  return { page, errors };
}
const resultText = (page, screen = 'screen-host') => page.locator(`#${screen} [data-ref="result"] .rbig`).innerText();
const waitResult = (page, screen = 'screen-host') => page.locator(`#${screen} [data-ref="result"] .rbig`).waitFor({ state: 'visible', ...T });
const labels = (page, screen = 'screen-host') => page.locator(`#${screen} .wheel-rot .lbl`).allTextContents();
const memberCount = (page, n) => page.waitForFunction((k) => document.querySelectorAll('#members .member-row').length === k, n, T);

test('配信者: 部屋を作ると、部屋コード・リスナー用URL・見本の盤が出る。再読み込みしても同じ部屋に戻る', async () => {
  const { context, host, code, errors } = await createRoom('&shareduid=1');
  assert.ok((await host.locator('#screen-host [data-ref="url"]').innerText()).includes(`room=${code}`));
  assert.deepEqual(await labels(host), ['大当たり', 'はずれ', '当たり', 'はずれ', '当たり', 'はずれ']);
  assert.equal(await host.locator('#items .item-row').count(), 6);
  assert.equal(await host.locator('#spin').innerText(), '💗 回す');
  await host.reload();
  await visible(host, 'screen-host');
  assert.equal(await host.locator('#screen-host [data-ref="code"]').innerText(), code);
  assert.deepEqual(errors, []);
  await context.close();
});

test('お題ルーレット: 回すと項目のどれかが結果に出て、記録に残る。「結果を閉じる」で消える', async () => {
  const { context, host, errors } = await createRoom();
  await host.click('#spin');
  await waitResult(host);
  const hit = await resultText(host);
  assert.ok(['大当たり', 'はずれ', '当たり'].includes(hit), hit);
  assert.equal(await host.locator('.wheel-rot .seg.win').count(), 1);
  assert.equal(await host.locator('#screen-host [data-ref="history"] .hist-row').count(), 1);
  assert.ok((await host.locator('#screen-host [data-ref="history"] .hist-row').first().innerText()).includes(hit));
  // 針が指している項目 = 結果(盤の角度から計算し直して確かめる)
  const same = await host.evaluate(() => {
    const segs = [...document.querySelectorAll('#items .item-row')].map((r) => ({ t: r.querySelector('.item-text').value, w: Number(r.querySelector('.wnum').textContent) }));
    const deg = Number(document.querySelector('.wheel-rot').dataset.deg);
    return RouletteLogic.indexAt(segs, deg) === Number(document.querySelector('.wheel-rot .seg.win').dataset.i);
  });
  assert.equal(same, true);
  await host.click('#dismiss');
  await host.locator('#screen-host [data-ref="result"]').waitFor({ state: 'hidden', ...T });
  assert.equal(await host.locator('.wheel-rot .seg.win').count(), 0);
  // もう一度回せる
  await host.click('#spin');
  await waitResult(host);
  assert.equal(await host.locator('#screen-host [data-ref="history"] .hist-row').count(), 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test('演出: ふつうの速さでも最後まで回り、針の指す項目が結果になる。回っている間は「回す」を押せない', async () => {
  const context = await newContext();
  const { page: host, errors } = await open(context, 'index.html?mock=1');
  await host.click('#create-room');
  await visible(host, 'screen-host');
  await host.click('#spin');
  await host.locator('.wheel-wrap.spinning').waitFor({ state: 'visible', ...T });
  assert.equal(await host.locator('#spin').isDisabled(), true);
  assert.equal(await host.locator('#spin').innerText(), '回っています…');
  assert.equal(await host.locator('#screen-host [data-ref="result"]').isHidden(), true, '止まるまで結果を見せない');
  assert.equal(await host.locator('#screen-host [data-ref="history"] .hist-row').count(), 0, '止まるまで記録にも出さない');
  await host.locator('#screen-host [data-ref="result"] .rbig').waitFor({ state: 'visible', timeout: 12000 });
  const ok = await host.evaluate(() => {
    const segs = [...document.querySelectorAll('#items .item-row')].map((r) => ({ t: r.querySelector('.item-text').value, w: Number(r.querySelector('.wnum').textContent) }));
    const deg = Number(document.querySelector('.wheel-rot').dataset.deg);
    const i = RouletteLogic.indexAt(segs, deg);
    return { same: i === Number(document.querySelector('.wheel-rot .seg.win').dataset.i), label: segs[i].t, turns: deg / 360 };
  });
  assert.equal(ok.same, true);
  assert.equal(ok.label, await resultText(host));
  assert.ok(ok.turns >= 5, `5 周以上回る(${ok.turns})`);
  assert.equal(await host.locator('#spin').isDisabled(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('中身の編集: 書きかえ・足す・消す・当たりやすさが盤に出て、リスナーの盤にも届く', async () => {
  const { context, host, code, errors } = await createRoom();
  const { page: listener, errors: lerrors } = await joinAs(context, code, 'たろう');
  await host.locator('#items .item-text').first().fill('ジャックポット');
  await host.waitForFunction(() => [...document.querySelectorAll('#screen-host .wheel-rot .lbl')].some((e) => e.textContent === 'ジャックポット'), null, T);
  await listener.waitForFunction(() => [...document.querySelectorAll('#screen-listener .wheel-rot .lbl')].some((e) => e.textContent === 'ジャックポット'), null, T);
  // 足す(空のままでは盤に出ない → 打つと出る)
  await host.click('#add-item');
  assert.equal(await host.locator('#items .item-row').count(), 7);
  assert.equal((await labels(host)).length, 6);
  await host.locator('#items .item-text').last().fill('おまけ');
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 7, null, T);
  // 消す
  await host.locator('#items .item-row').nth(1).locator('[data-act="del"]').click();
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 6, null, T);
  await listener.waitForFunction(() => document.querySelectorAll('#screen-listener .wheel-rot .lbl').length === 6, null, T);
  assert.deepEqual(await labels(listener, 'screen-listener'), ['ジャックポット', '当たり', 'はずれ', '当たり', 'はずれ', 'おまけ']);
  // 当たりやすさ: 1 → 3 にすると広くなる(数字が変わり、再読み込みしても残る)
  const row = host.locator('#items .item-row').first();
  await row.locator('[data-act="plus"]').click();
  await row.locator('[data-act="plus"]').click();
  assert.equal(await row.locator('.wnum').innerText(), '3');
  await host.waitForFunction(() => {
    const d = document.querySelector('#screen-host .wheel-rot .seg[data-i="0"]').getAttribute('d');
    return d !== null && !d.includes('L96 0A96 96 0 0 1 29.67'); // 最初の扇形が広がった
  }, null, T);
  // 見本と入れ替える
  await host.click('[data-preset="yesno"]');
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 4, null, T);
  assert.deepEqual(await labels(host), ['はい', 'いいえ', 'はい', 'いいえ']);
  assert.equal(await host.locator('#drink-note').isHidden(), true);
  await host.click('[data-preset="nomi"]');
  await host.locator('#drink-note').waitFor({ state: 'visible', ...T });
  assert.deepEqual(errors, []);
  assert.deepEqual(lerrors, []);
  await context.close();
});

test('中身の編集: 項目が 2 つ未満だと回せず、理由が出る', async () => {
  const { context, host, errors } = await createRoom();
  for (let i = 0; i < 5; i++) await host.locator('#items .item-row').first().locator('[data-act="del"]').click();
  await host.waitForFunction(() => document.querySelector('#spin').disabled, null, T);
  assert.equal(await host.locator('#spin-hint').innerText(), '項目を2つ以上入れると回せます');
  assert.deepEqual(errors, []);
  await context.close();
});

test('「当たった項目は消していく」: 回すたびに当たった項目が盤から消える', async () => {
  const { context, host, errors } = await createRoom();
  await host.click('[data-preset="number"]');
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 6, null, T);
  await host.check('#opt-remove-hit');
  await host.click('#spin');
  await waitResult(host);
  const hit = await resultText(host);
  await host.waitForFunction(() => document.querySelectorAll('#items .item-row').length === 5, null, T);
  const left = await host.locator('#items .item-text').evaluateAll((els) => els.map((e) => e.value));
  assert.ok(!left.includes(hit), `${hit} が消えている`);
  await host.click('#dismiss');
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 5, null, T);
  assert.deepEqual(errors, []);
  await context.close();
});

test('リスナー抽選: 参加した人の名前が盤に並び、当たった人の画面に「当たり」が出て、次の抽選から外れる', async () => {
  const { context, host, code, errors } = await createRoom();
  const names = ['たろう', 'はなこ', 'じろう'];
  const ls = [];
  for (const n of names) ls.push(await joinAs(context, code, n));
  await memberCount(host, 3);
  await host.click('[data-kind="names"]');
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 3, null, T);
  assert.deepEqual(await labels(host), names);
  assert.ok((await host.locator('#screen-host [data-ref="status"]').innerText()).includes('対象 3人'));
  await host.click('#spin');
  await waitResult(host);
  const winner = (await resultText(host)).replace(/\s*さん$/, '');
  assert.ok(names.includes(winner), winner);
  for (const [i, l] of ls.entries()) {
    await waitResult(l.page, 'screen-listener');
    const mine = await l.page.locator('#my-status').innerText();
    if (names[i] === winner) assert.ok(mine.includes('当たり'), mine);
    else assert.ok(mine.includes('抽選に参加中'), mine);
  }
  // 当選済みの印が付き、次の抽選の対象は 2 人
  assert.equal(await host.locator('#members .tag.won').count(), 1);
  await host.click('#dismiss');
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 2, null, T);
  assert.ok(!(await labels(host)).includes(winner));
  await host.click('#spin');
  await waitResult(host);
  const second = (await resultText(host)).replace(/\s*さん$/, '');
  assert.notEqual(second, winner);
  // 残り 1 人では回せない
  await host.click('#dismiss');
  await host.waitForFunction(() => document.querySelector('#spin').disabled, null, T);
  assert.equal(await host.locator('#spin-hint').innerText(), '抽選の対象が2人以上になると回せます');
  // 「当選済みを元に戻す」で全員が対象に戻る
  await host.click('#reset-won');
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 3, null, T);
  assert.deepEqual(errors, []);
  for (const l of ls) assert.deepEqual(l.errors, []);
  await context.close();
});

test('回してもらう: 指名されたリスナーのスマホにだけ「回す!」が出て、押すとみんなの盤が回る', async () => {
  const { context, host, code, errors } = await createRoom();
  const a = await joinAs(context, code, 'たろう');
  const b = await joinAs(context, code, 'はなこ');
  await memberCount(host, 2);
  assert.equal(await a.page.locator('#listener-spin').isHidden(), true);
  await host.locator('#members .member-row', { hasText: 'たろう' }).locator('[data-act="turn"]').click();
  await a.page.locator('#listener-spin').waitFor({ state: 'visible', ...T });
  assert.ok((await a.page.locator('#my-status').innerText()).includes('あなたの番'));
  assert.equal(await b.page.locator('#listener-spin').isHidden(), true);
  assert.equal(await host.locator('#spin').innerText(), '代わりに回す');
  assert.ok((await host.locator('#screen-host [data-ref="status"]').innerText()).includes('たろう'));
  // 取り消すとボタンが消える → もう一度指名
  await host.click('#cancel-turn');
  await a.page.locator('#listener-spin').waitFor({ state: 'hidden', ...T });
  await host.locator('#members .member-row', { hasText: 'たろう' }).locator('[data-act="turn"]').click();
  await a.page.locator('#listener-spin').waitFor({ state: 'visible', ...T });
  await a.page.click('#listener-spin');
  await waitResult(host);
  await waitResult(a.page, 'screen-listener');
  await waitResult(b.page, 'screen-listener');
  assert.equal(await resultText(a.page, 'screen-listener'), await resultText(host));
  assert.equal(await resultText(b.page, 'screen-listener'), await resultText(host));
  assert.ok((await host.locator('#screen-host [data-ref="result"] .rsub').innerText()).includes('たろう さんが回しました'));
  assert.ok((await host.locator('#screen-host [data-ref="history"] .hist-row').first().innerText()).includes('たろう さんが回した'));
  // 回したら指名は終わり
  await a.page.locator('#listener-spin').waitFor({ state: 'hidden', ...T });
  assert.equal(await host.locator('#spin').innerText(), '💗 回す');
  assert.deepEqual(errors, []);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  await context.close();
});

test('回してもらう: 配信者が「代わりに回す」と指名は終わる。抽選で当たった人にそのままお題を回してもらえる', async () => {
  const { context, host, code, errors } = await createRoom();
  const a = await joinAs(context, code, 'たろう');
  const b = await joinAs(context, code, 'はなこ');
  await memberCount(host, 2);
  await host.locator('#members .member-row', { hasText: 'はなこ' }).locator('[data-act="turn"]').click();
  await b.page.locator('#listener-spin').waitFor({ state: 'visible', ...T });
  await host.click('#spin'); // 代わりに回す
  await waitResult(host);
  await b.page.locator('#listener-spin').waitFor({ state: 'hidden', ...T });
  assert.equal(await host.locator('#screen-host [data-ref="result"] .rsub').count(), 0, '配信者が回したときは「◯◯ さんが回しました」を出さない');
  // 抽選 → 当たった人にお題を回してもらう
  await host.click('[data-kind="names"]');
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 2, null, T);
  await host.click('#spin');
  await waitResult(host);
  const winner = (await resultText(host)).replace(/\s*さん$/, '');
  await host.click('#winner-spin');
  const w = winner === 'たろう' ? a : b;
  await w.page.locator('#listener-spin').waitFor({ state: 'visible', ...T });
  await host.waitForFunction(() => document.querySelector('[data-kind="items"]').getAttribute('aria-pressed') === 'true', null, T);
  await w.page.click('#listener-spin');
  await waitResult(host);
  assert.ok((await host.locator('#screen-host [data-ref="result"] .rsub').innerText()).includes(`${winner} さんが回しました`));
  assert.deepEqual(errors, []);
  await context.close();
});

test('回してもらう: 配信者の画面が応えないと「配信者の画面を待っています」と出る', async () => {
  const { context, host, code } = await createRoom();
  const a = await joinAs(context, code, 'たろう', '&waitms=300');
  await memberCount(host, 1);
  await host.locator('#members [data-act="turn"]').click();
  await a.page.locator('#listener-spin').waitFor({ state: 'visible', ...T });
  await host.close(); // 配信者の画面が落ちた
  await a.page.click('#listener-spin');
  await a.page.waitForFunction(() => document.querySelector('#my-sub').textContent.includes('配信者の画面を待っています'), null, T);
  assert.equal(await a.page.locator('#listener-spin').isDisabled(), false, 'もう一度押せる');
  await context.close();
});

test('荒らし対策: 非表示にすると名前がどこでも ？？？ になり、外す・ブロックができる', async () => {
  const { context, host, code, errors } = await createRoom();
  const a = await joinAs(context, code, 'わるいなまえ');
  const b = await joinAs(context, code, 'はなこ');
  await memberCount(host, 2);
  await host.click('[data-kind="names"]');
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 2, null, T);
  await host.locator('#members .member-row', { hasText: 'わるいなまえ' }).locator('[data-act="hide"]').click();
  await host.waitForFunction(() => !document.querySelector('#screen-host').innerText.includes('わるいなまえ'), null, T);
  assert.deepEqual(await labels(host), ['？？？', 'はなこ']);
  await b.page.waitForFunction(() => !document.querySelector('#screen-listener').innerText.includes('わるいなまえ'), null, T);
  // 外す → 本人は「参加していません」。もう一度参加できる
  await host.locator('#members .member-row', { hasText: '？？？' }).locator('[data-act="kick"]').click();
  await memberCount(host, 1);
  await a.page.waitForFunction(() => document.querySelector('#my-status').textContent === '参加していません', null, T);
  await a.page.click('#rejoin');
  await memberCount(host, 2);
  // ブロック → 本人は「参加できません」。再読み込みしても入れない
  await host.locator('#members .member-row', { hasText: '？？？' }).locator('[data-act="ban"]').click();
  await memberCount(host, 1);
  await visible(a.page, 'screen-banned');
  await a.page.reload();
  await visible(a.page, 'screen-banned');
  assert.deepEqual(await labels(host), ['はなこ']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('名前に記号やタグを入れても、文字としてそのまま出る(画面を壊さない)', async () => {
  const { context, host, code, errors } = await createRoom();
  const a = await joinAs(context, code, '<b>&"x\'</b>');
  await joinAs(context, code, 'はなこ');
  await memberCount(host, 2);
  await host.click('[data-kind="names"]');
  await host.waitForFunction(() => document.querySelectorAll('#screen-host .wheel-rot .lbl').length === 2, null, T);
  assert.equal((await labels(host))[0], '<b>&"x\'</b>');
  assert.equal(await host.locator('#members .member-row .qname b').count(), 0);
  await host.locator('#items .item-text').first().fill('<img src=x onerror=alert(1)>');
  await host.click('[data-kind="items"]');
  await host.waitForFunction(() => [...document.querySelectorAll('#screen-host .wheel-rot .lbl')].some((e) => e.textContent.startsWith('<img')), null, T);
  assert.equal(await host.locator('#screen-host img').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(a.errors, []);
  await context.close();
});

test('見るだけ: 名前を入れずに見られて、あとから参加もできる', async () => {
  const { context, host, code, errors } = await createRoom();
  const { page, errors: lerrors } = await open(context, `index.html?mock=1&quick=1&room=${code}`, PHONE);
  await visible(page, 'screen-join');
  await page.click('#join-watch');
  await visible(page, 'screen-listener');
  assert.equal(await page.locator('#my-status').innerText(), '見ているだけ');
  assert.equal((await labels(page, 'screen-listener')).length, 6);
  await host.click('#spin');
  await waitResult(page, 'screen-listener');
  assert.equal(await resultText(page, 'screen-listener'), await resultText(host));
  assert.equal(await host.locator('#members .member-row').count(), 0);
  await page.click('#rejoin');
  await visible(page, 'screen-join');
  await page.fill('#join-name', 'あとから');
  await page.click('#join-enter');
  await visible(page, 'screen-listener');
  await memberCount(host, 1);
  assert.equal(await page.locator('#my-status').innerText(), '参加中');
  // 参加をやめる
  await page.click('#leave');
  await memberCount(host, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(lerrors, []);
  await context.close();
});

test('途中から開いた人: 出ている結果がそのまま見える。再読み込みしても参加したまま', async () => {
  const { context, host, code } = await createRoom();
  await host.click('#spin');
  await waitResult(host);
  const hit = await resultText(host);
  const a = await joinAs(context, code, 'おくれて');
  await waitResult(a.page, 'screen-listener');
  assert.equal(await resultText(a.page, 'screen-listener'), hit);
  await a.page.reload();
  await visible(a.page, 'screen-listener');
  assert.equal(await a.page.locator('#my-status').innerText(), '参加中');
  assert.deepEqual(a.errors, []);
  await context.close();
});

test('表示専用(stage=1): ボタンが無く、盤・結果・参加者が配信者の画面と同じに出る', async () => {
  const { context, host, code } = await createRoom();
  await joinAs(context, code, 'たろう');
  const { page: stage, errors } = await open(context, `index.html?mock=1&quick=1&room=${code}&stage=1`);
  await visible(stage, 'screen-stage');
  assert.equal(await stage.locator('#screen-stage button').count(), 0);
  assert.equal(await stage.locator('#screen-stage input').count(), 0);
  assert.equal(await stage.locator('#screen-stage [data-ref="code"]').innerText(), code);
  await stage.waitForFunction(() => document.querySelectorAll('#screen-stage [data-ref="members"] .member-row').length === 1, null, T);
  assert.equal(await stage.locator('#screen-stage .qacts').count(), 0);
  await host.click('#spin');
  await waitResult(stage, 'screen-stage');
  assert.equal(await resultText(stage, 'screen-stage'), await resultText(host));
  assert.deepEqual(errors, []);
  await context.close();
});

test('部屋を閉じる: リスナーには「終了しました」と出て、配信者は入口に戻る', async () => {
  const { context, host, code, errors } = await createRoom('&shareduid=1');
  const a = await joinAs(context, code, 'たろう');
  await host.click('#close-room');
  await visible(host, 'screen-host-entry');
  await visible(a.page, 'screen-closed');
  assert.equal(await host.locator('#resume-banner').isHidden(), true);
  // 閉じた部屋のURLを開いても入れない
  const late = await open(context, `index.html?mock=1&room=${code}`, PHONE);
  await visible(late.page, 'screen-closed');
  assert.deepEqual(errors, []);
  await context.close();
});

test('入口: 部屋コードを入れて入れる。無い部屋・おかしなコードは「見つかりません」', async () => {
  const { context, code } = await createRoom();
  const { page, errors } = await open(context, 'index.html?mock=1', PHONE);
  await visible(page, 'screen-host-entry');
  await page.fill('#enter-code-input', code.toLowerCase());
  await page.click('#enter-code button');
  await visible(page, 'screen-join');
  assert.equal(await page.locator('#join-code').innerText(), code);
  const none = await open(context, 'index.html?mock=1&room=ZZZZ', PHONE);
  await visible(none.page, 'screen-notfound');
  const bad = await open(context, 'index.html?mock=1&room=<x>', PHONE);
  await visible(bad.page, 'screen-notfound');
  assert.deepEqual(errors, []);
  await context.close();
});

test('配信者の画面は 1 タブだけ: 同じ部屋を 2 つ目のタブで開くと案内が出る', async () => {
  const { context, host, code } = await createRoom('&shareduid=1');
  const second = await open(context, 'index.html?mock=1&quick=1&shareduid=1');
  await visible(second.page, 'screen-host-busy');
  assert.equal(await second.page.locator('#busy-code').innerText(), code);
  await host.close();
  await context.close();
});

test('スマホの幅でも、配信者の画面が横にはみ出さない', async () => {
  const context = await newContext(PHONE);
  const { page: host, errors } = await open(context, 'index.html?mock=1&quick=1');
  await host.click('#create-room');
  await visible(host, 'screen-host');
  await host.click('#spin');
  await waitResult(host);
  const over = await host.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 0, `横に ${over}px はみ出している`);
  // リスナー用URLが細い柱につぶれない(1 文字ずつ縦に並ばない)
  const box = await host.locator('#screen-host .urlbox').boundingBox();
  assert.ok(box.width > 250 && box.height < 90, `URL の欄: 幅 ${box.width} 高さ ${box.height}`);
  const wheel = await host.locator('#screen-host .wheel-wrap').boundingBox();
  assert.ok(wheel.width > 280, `盤の幅 ${wheel.width}`);
  assert.deepEqual(errors, []);
  await context.close();
});
