// 画面のテスト(Playwright)。mock 同期(同じブラウザ内だけ)とローカル HTTP サーバーで動かす。
// 配信者のURLに n=17 を付けると、出る数字を 17 に決め打ちできる(mock のときだけ)。
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

async function newContext(viewport = { width: 1280, height: 900 }) {
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
  page.on('dialog', (d) => d.accept()); // 確認(ブロック・配り直し・部屋を閉じる)は「はい」
  await page.goto(`${url}/${path}`);
  return { page, errors };
}
const PHONE = { width: 390, height: 844 };
const S = { RED: 37, BLACK: 38, ODD: 39, EVEN: 40, LOW: 41, HIGH: 42, DOZEN: 43, COLUMN: 46 };
const visible = (page, id) => page.locator(`#${id}`).waitFor({ state: 'visible', ...T });

/** 配信者として部屋を作る。quick=1 で回る演出は一瞬。n を渡すと出る数字を決め打ち。 */
async function createRoom({ n = null, extra = '' } = {}) {
  const context = await newContext();
  const { page: host, errors } = await open(context, `index.html?mock=1&quick=1${n === null ? '' : `&n=${n}`}${extra}`);
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
  await page.locator('#betbar').waitFor({ state: 'visible', ...T });
  return { page, errors };
}
const chips = (page) => page.locator('#my-chips').innerText();
const waitChips = (page, text) => page.waitForFunction((t) => document.querySelector('#my-chips').textContent === t, text, T);
const waitStatus = (page, part) => page.waitForFunction((t) => document.querySelector('#my-status').textContent.includes(t), part, T);
const pick = (page, v) => page.click(`#chip-values [data-v="${v}"]`);
const tap = (page, spot) => page.click(`#my-table [data-spot="${spot}"]`);
/** 配信者のテーブルで、その場所の合計が value になるまで待つ(0 ならチップが消えるまで)。 */
const waitTotal = (host, spot, value) => host.waitForFunction(([s, v]) => {
  const c = document.querySelector(`#screen-host [data-ref="table"] [data-spot="${s}"] .chip.all`);
  return v === 0 ? !c : !!c && Number(c.dataset.v) === v;
}, [spot, value], T);
const spin = async (host) => { await host.click('#spin'); await host.locator('#screen-host [data-ref="result"] .disc.big').waitFor({ state: 'visible', ...T }); };
const rankRows = (page, screen = 'screen-host') => page.locator(`#${screen} [data-ref="ranking"] .member-row`).evaluateAll((els) => els.map((e) => `${e.querySelector('.qname').textContent}=${e.querySelector('.pts').textContent}`));

test('配信者: 部屋を作ると、部屋コード・URL・37 マスの盤・テーブルが出る。再読み込みしても同じ部屋に戻る', async () => {
  const { context, host, code, errors } = await createRoom({ extra: '&shareduid=1' });
  assert.ok((await host.locator('#screen-host [data-ref="url"]').innerText()).includes(`room=${code}`));
  assert.equal(await host.locator('#screen-host .wheel-rot .pocket').count(), 37);
  assert.equal(await host.locator('#screen-host [data-ref="table"] [data-spot]').count(), 49);
  assert.equal(await host.locator('#screen-host [data-ref="table"] [data-spot]:not([disabled])').count(), 0, '配信者はディーラーなので賭けない');
  assert.equal(await host.locator('#spin').innerText(), '💗 ベット締め切り → 回す');
  assert.ok((await host.locator('#screen-host [data-ref="status"]').innerText()).includes('第1ゲーム'));
  await host.reload();
  await visible(host, 'screen-host');
  assert.equal(await host.locator('#screen-host [data-ref="code"]').innerText(), code);
  assert.deepEqual(errors, []);
  await context.close();
});

test('賭ける: チップをえらんで場所をタップすると、自分のチップが減り、配信者のテーブルに合計が出る', async () => {
  const { context, host, code, errors } = await createRoom();
  const a = await joinAs(context, code, 'みゆ');
  const b = await joinAs(context, code, 'さくら');
  assert.equal(await chips(a.page), '1,000');
  await waitStatus(a.page, 'ベットしてね');
  await tap(a.page, 17);
  await tap(a.page, 17);          // 同じ場所に重ねる
  await pick(a.page, 100);
  await tap(a.page, S.BLACK);
  await waitChips(a.page, '880');
  await waitStatus(a.page, '120 チップを賭けています');
  assert.equal(await a.page.locator('#my-table [data-spot="17"] .chip.mine').innerText(), '20');
  await pick(b.page, 50);
  await tap(b.page, 17);
  await waitTotal(host, 17, 70);
  await waitTotal(host, S.BLACK, 100);
  assert.ok((await host.locator('#screen-host [data-ref="status"]').innerText()).includes('2人 / 合計 170'));
  assert.equal(await chips(a.page), '880');
  // ほかの人の賭けが届いても、テーブルのボタンは作り直されない(押している最中に消えない)
  assert.equal(await b.page.evaluate(() => { const el = document.querySelector('#my-table [data-spot="17"]'); el.dataset.keep = '1'; return true; }), true);
  await tap(a.page, 3);
  await waitTotal(host, 3, 100);
  await b.page.waitForFunction(() => !!document.querySelector('#my-table [data-spot="3"] .chip.all'), null, T);
  assert.equal(await b.page.locator('#my-table [data-spot="17"]').getAttribute('data-keep'), '1');
  // 相手の画面では、自分の分(ピンク)とほかの人の分(白)が分かれて見える
  await b.page.waitForFunction(() => { const c = document.querySelector('#my-table [data-spot="17"] .chip.all'); return !!c && c.dataset.v === '20'; }, null, T);
  assert.equal(await b.page.locator('#my-table [data-spot="17"] .chip.mine').innerText(), '50');
  // 受付中の順位は、置いた分も数える(置いただけで下がらない)
  assert.deepEqual(await rankRows(host), ['みゆ=1,000', 'さくら=1,000']);
  assert.equal(await chips(a.page), '780');
  assert.deepEqual(errors, []);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  await context.close();
});

test('回す: 17 が出ると、数字ぴったりは 36倍・黒は 2倍。はずれた人は減り、順位と配信者の収支が変わる', async () => {
  const { context, host, code, errors } = await createRoom({ n: 17 });
  const a = await joinAs(context, code, 'みゆ');
  const b = await joinAs(context, code, 'さくら');
  const c = await joinAs(context, code, 'れん');
  await tap(a.page, 17); await tap(a.page, 17);
  await pick(a.page, 100); await tap(a.page, S.BLACK);
  await pick(b.page, 50); await tap(b.page, S.RED); await tap(b.page, S.DOZEN);
  await waitTotal(host, S.BLACK, 100);
  await waitTotal(host, S.DOZEN, 50);
  await spin(host);
  assert.equal(await host.locator('#screen-host [data-ref="result"] .disc.big').innerText(), '17');
  assert.ok((await host.locator('#screen-host [data-ref="result"] .rdesc').innerText()).includes('黒・奇数・1〜18'));
  assert.equal(await host.locator('#screen-host .wheel-wrap').getAttribute('data-n'), '17');
  const winner = await host.locator('#screen-host [data-ref="result"] .winner').first().innerText();
  assert.ok(winner.includes('みゆ') && winner.includes('+800') && winner.includes('数字ぴったり'), winner);
  assert.equal(await host.locator('#screen-host [data-ref="result"] .winner').count(), 1);
  await waitStatus(a.page, '当たり! +800');
  await waitChips(a.page, '1,800');
  await waitStatus(b.page, 'ざんねん… −100');
  await waitChips(b.page, '900');
  await waitStatus(c.page, '今回は賭けていません');
  assert.equal(await chips(c.page), '1,000');
  assert.deepEqual(await rankRows(host), ['みゆ=1,800', 'れん=1,000', 'さくら=900']);
  assert.equal(await host.locator('#screen-host [data-ref="house"]').innerText(), '配信者(ディーラー)の収支 −700');
  // 当たった場所だけ光る
  const wins = await host.locator('#screen-host [data-ref="table"] .cell.win').evaluateAll((els) => els.map((e) => Number(e.dataset.spot)).sort((x, y) => x - y));
  assert.deepEqual(wins, [17, S.BLACK, S.ODD, S.LOW, S.DOZEN + 1, S.COLUMN + 1].sort((x, y) => x - y));
  // 結果が出ているあいだは賭けられない
  assert.equal(await a.page.locator('#my-table [data-spot]:not([disabled])').count(), 0);
  assert.equal(await a.page.locator('#betbar').isHidden(), true);
  assert.deepEqual(errors, []);
  for (const l of [a, b, c]) assert.deepEqual(l.errors, []);
  await context.close();
});

test('次のゲーム: テーブルが片づき、また賭けられる。出目の記録が残る', async () => {
  const { context, host, code, errors } = await createRoom({ n: 0 });
  const a = await joinAs(context, code, 'みゆ');
  await pick(a.page, 100); await tap(a.page, S.RED);
  await waitTotal(host, S.RED, 100);
  await spin(host);
  await waitStatus(a.page, 'ざんねん… −100'); // 0 が出たら赤もはずれ
  assert.equal(await host.locator('#spin').isHidden(), true);
  await host.click('#next');
  await host.waitForFunction(() => document.querySelector('#screen-host [data-ref="status"]').textContent.includes('第2ゲーム'), null, T);
  assert.equal(await host.locator('#screen-host [data-ref="table"] .chip').count(), 0);
  assert.equal(await host.locator('#screen-host [data-ref="result"]').isHidden(), true);
  assert.equal(await host.locator('#screen-host [data-ref="hist"] .disc').first().innerText(), '0');
  await a.page.locator('#betbar').waitFor({ state: 'visible', ...T });
  await waitStatus(a.page, 'ベットしてね');
  assert.equal(await chips(a.page), '900');
  await tap(a.page, 0);
  await waitTotal(host, 0, 100);
  await spin(host);
  await waitStatus(a.page, '当たり! +3,500'); // 0 に 100 → 36倍
  await waitChips(a.page, '4,400');
  assert.equal(await host.locator('#screen-host [data-ref="hist"] .disc').count(), 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(a.errors, []);
  await context.close();
});

test('取り消す: 置いたチップが全部もどる', async () => {
  const { context, host, code } = await createRoom();
  const a = await joinAs(context, code, 'みゆ');
  assert.equal(await a.page.locator('#clear-bets').isDisabled(), true);
  await pick(a.page, 50);
  await tap(a.page, 5); await tap(a.page, S.EVEN);
  await waitTotal(host, S.EVEN, 50);
  await waitChips(a.page, '900');
  await a.page.click('#clear-bets');
  await waitChips(a.page, '1,000');
  await waitTotal(host, 5, 0);
  await waitTotal(host, S.EVEN, 0);
  assert.equal(await a.page.locator('#my-table .chip').count(), 0);
  await waitStatus(a.page, 'ベットしてね');
  assert.deepEqual(a.errors, []);
  await context.close();
});

test('すばやく何度もタップしても、押した分がぜんぶ届く', async () => {
  const { context, host, code } = await createRoom();
  const a = await joinAs(context, code, 'みゆ');
  for (let i = 0; i < 12; i++) await a.page.locator(`#my-table [data-spot="${S.RED}"]`).click({ noWaitAfter: true });
  for (let i = 0; i < 5; i++) await a.page.locator('#my-table [data-spot="8"]').click({ noWaitAfter: true });
  await waitTotal(host, S.RED, 120);
  await waitTotal(host, 8, 50);
  await waitChips(a.page, '830');
  assert.equal(await a.page.locator(`#my-table [data-spot="${S.RED}"] .chip.mine`).innerText(), '120');
  assert.deepEqual(a.errors, []);
  await context.close();
});

test('チップが足りない: 持っている以上は置けない。尽きたら「おかわり」で 1,000 にもどり、回数が順位に出る', async () => {
  const { context, host, code, errors } = await createRoom({ n: 17 });
  const a = await joinAs(context, code, 'みゆ');
  await pick(a.page, 500);
  await tap(a.page, S.RED); await tap(a.page, S.RED);
  await waitChips(a.page, '0');
  // もう置けない(どのチップも選べない)
  assert.equal(await a.page.locator('#chip-values [data-v]:not([disabled])').count(), 0);
  assert.equal(await a.page.locator('#rebuy').isHidden(), true, 'テーブルに置いているあいだは、おかわりは出ない');
  await waitTotal(host, S.RED, 1000);
  await spin(host);                      // 17 は黒 → 全部なくなる
  await waitStatus(a.page, 'ざんねん… −1,000');
  await a.page.locator('#rebuy').waitFor({ state: 'visible', ...T });
  await a.page.click('#rebuy');
  await waitChips(a.page, '1,000');
  await a.page.locator('#rebuy').waitFor({ state: 'hidden', ...T });
  await host.waitForFunction(() => document.querySelector('#screen-host [data-ref="ranking"]').textContent.includes('おかわり×1'), null, T);
  assert.equal(await host.locator('#screen-host [data-ref="house"]').innerText(), '配信者(ディーラー)の収支 +1,000');
  // 次のゲームで、大きいチップが足りないときは小さいチップだけ選べる
  await host.click('#next');
  await a.page.locator('#betbar').waitFor({ state: 'visible', ...T });
  await pick(a.page, 500); await tap(a.page, S.BLACK);
  await waitChips(a.page, '500');
  await tap(a.page, S.BLACK);
  await waitChips(a.page, '0');
  assert.deepEqual(errors, []);
  assert.deepEqual(a.errors, []);
  await context.close();
});

test('演出: ふつうの速さで玉が転がり、止まるまで結果もチップも見せない。玉は出た数字のマスに収まる', async () => {
  const context = await newContext();
  const { page: host, errors } = await open(context, 'index.html?mock=1&n=32');
  await host.click('#create-room');
  await visible(host, 'screen-host');
  const code = await host.locator('#screen-host [data-ref="code"]').innerText();
  const { page: a, errors: aerr } = await open(context, `index.html?mock=1&room=${code}`, PHONE);
  await a.fill('#join-name', 'みゆ');
  await a.click('#join-enter');
  await a.locator('#betbar').waitFor({ state: 'visible', ...T });
  await pick(a, 100); await tap(a, 32);
  await waitTotal(host, 32, 100);
  await host.click('#spin');
  await host.locator('#screen-host .wheel-wrap.spinning').waitFor({ state: 'visible', ...T });
  await a.locator('#screen-listener .wheel-wrap.spinning').waitFor({ state: 'visible', ...T });
  assert.equal(await host.locator('#spin').innerText(), '回っています…');
  assert.equal(await host.locator('#spin').isDisabled(), true);
  assert.equal(await host.locator('#screen-host [data-ref="result"]').isHidden(), true, '止まるまで結果を見せない');
  assert.equal(await host.locator('#screen-host [data-ref="hist"] .disc').count(), 0, '止まるまで出目の記録にも出さない');
  assert.equal(await chips(a), '900', '止まるまでチップは増えない');
  await waitStatus(a, 'ノーモアベット');
  assert.equal(await a.locator('#my-table [data-spot]:not([disabled])').count(), 0, '回っているあいだは賭けられない');
  await host.locator('#screen-host [data-ref="result"] .disc.big').waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(await host.locator('#screen-host [data-ref="result"] .disc.big').innerText(), '32');
  // 玉の位置から、どのマスにいるかを計算し直す(盤の角度と玉の座標)
  const where = await host.evaluate(() => {
    const rot = document.querySelector('#screen-host .wheel-rot').style.transform;
    const wheel = Number(/rotate\(([-\d.]+)deg\)/.exec(rot)[1]);
    const [x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(document.querySelector('#screen-host .ball').getAttribute('transform')).slice(1).map(Number);
    const abs = (Math.atan2(x, -y) * 180) / Math.PI;
    return { n: RouletteLogic.numberAt(abs - wheel), r: Math.hypot(x, y) };
  });
  assert.equal(where.n, 32);
  assert.ok(Math.abs(where.r - 64) < 0.5, `玉はマスの中(半径 ${where.r})`);
  await waitStatus(a, '当たり! +3,500');
  await waitChips(a, '4,500');
  assert.equal(await host.locator('#screen-host .win-ring').count(), 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(aerr, []);
  await context.close();
});

test('配信者の画面が応えないと、「配信者の画面を待っています」と出る。もどれば賭けが届く', async () => {
  const { context, host, code } = await createRoom({ extra: '&shareduid=1' });
  const a = await joinAs(context, code, 'みゆ', '&waitms=300');
  await host.close(); // 配信者の画面が落ちた
  await tap(a.page, S.RED);
  await waitStatus(a.page, '配信者の画面を待っています');
  // 配信者がもどると、待っていた賭けが処理される
  const back = await open(context, 'index.html?mock=1&quick=1&shareduid=1');
  await visible(back.page, 'screen-host');
  await waitTotal(back.page, S.RED, 10);
  await waitStatus(a.page, '10 チップを賭けています');
  assert.deepEqual(a.errors, []);
  await context.close();
});

test('荒らし対策: 非表示にすると名前がどこでも ？？？ になり、ブロックすると入れなくなって賭けも片づく', async () => {
  const { context, host, code, errors } = await createRoom({ n: 17 });
  const a = await joinAs(context, code, 'わるいなまえ');
  const b = await joinAs(context, code, 'さくら');
  await pick(a.page, 100); await tap(a.page, 17);
  await waitTotal(host, 17, 100);
  await host.locator('#ranking .member-row', { hasText: 'わるいなまえ' }).locator('[data-act="hide"]').click();
  await host.waitForFunction(() => !document.querySelector('#screen-host').innerText.includes('わるいなまえ'), null, T);
  await b.page.waitForFunction(() => !document.querySelector('#screen-listener').innerText.includes('わるいなまえ'), null, T);
  await spin(host);
  assert.ok((await host.locator('#screen-host [data-ref="result"] .winner').first().innerText()).includes('？？？'));
  await host.click('#next');
  await a.page.locator('#betbar').waitFor({ state: 'visible', ...T });
  await tap(a.page, S.RED);
  await waitTotal(host, S.RED, 100);
  await host.locator('#ranking .member-row', { hasText: '？？？' }).locator('[data-act="ban"]').click();
  await visible(a.page, 'screen-banned');
  await waitTotal(host, S.RED, 0);
  await host.waitForFunction(() => document.querySelectorAll('#ranking .member-row').length === 1, null, T);
  await a.page.reload();
  await visible(a.page, 'screen-banned');
  assert.deepEqual(errors, []);
  assert.deepEqual(b.errors, []);
  await context.close();
});

test('名前に記号やタグを入れても、文字としてそのまま出る(画面を壊さない)', async () => {
  const { context, host, code, errors } = await createRoom({ n: 5 });
  const a = await joinAs(context, code, '<b>&"x\'</b>');
  await tap(a.page, 5);
  await waitTotal(host, 5, 10);
  assert.equal(await host.locator('#ranking .qname').first().innerText(), '<b>&"x\'</b>');
  assert.equal(await host.locator('#ranking .qname b').count(), 0);
  await spin(host);
  assert.ok((await host.locator('#screen-host [data-ref="result"] .wname').first().innerText()).includes('<b>&"x\'</b>'));
  assert.equal(await host.locator('#screen-host [data-ref="result"] .wname b').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(a.errors, []);
  await context.close();
});

test('見るだけ: 名前を入れずに見られて(賭けられない)、あとから参加もできる', async () => {
  const { context, host, code, errors } = await createRoom({ n: 3 });
  const { page, errors: lerrors } = await open(context, `index.html?mock=1&quick=1&room=${code}`, PHONE);
  await visible(page, 'screen-join');
  await page.click('#join-watch');
  await visible(page, 'screen-listener');
  assert.equal(await page.locator('#my-status').innerText(), '見ているだけ');
  assert.equal(await page.locator('#betbar').isHidden(), true);
  assert.equal(await page.locator('#my-chips-box').isHidden(), true);
  assert.equal(await page.locator('#my-table [data-spot]:not([disabled])').count(), 0);
  await spin(host);
  await page.locator('#screen-listener [data-ref="result"] .disc.big').waitFor({ state: 'visible', ...T });
  assert.equal(await page.locator('#screen-listener [data-ref="result"] .disc.big').innerText(), '3');
  assert.equal(await host.locator('#ranking .member-row').count(), 0);
  await page.click('#rejoin');
  await visible(page, 'screen-join');
  await page.fill('#join-name', 'あとから');
  await page.click('#join-enter');
  await visible(page, 'screen-listener');
  await host.waitForFunction(() => document.querySelectorAll('#ranking .member-row').length === 1, null, T);
  assert.equal(await chips(page), '1,000');
  assert.deepEqual(errors, []);
  assert.deepEqual(lerrors, []);
  await context.close();
});

test('途中から開いた人: 出ている結果がそのまま見える。再読み込みしてもチップはそのまま', async () => {
  const { context, host, code } = await createRoom({ n: 17 });
  const a = await joinAs(context, code, 'みゆ');
  await pick(a.page, 100); await tap(a.page, S.BLACK);
  await waitTotal(host, S.BLACK, 100);
  await spin(host);
  await waitChips(a.page, '1,100');
  const late = await open(context, `index.html?mock=1&quick=1&room=${code}`, PHONE);
  await late.page.fill('#join-name', 'おくれて');
  await late.page.click('#join-enter');
  await late.page.locator('#screen-listener [data-ref="result"] .disc.big').waitFor({ state: 'visible', ...T });
  assert.equal(await late.page.locator('#screen-listener [data-ref="result"] .disc.big').innerText(), '17');
  await a.page.reload();
  await visible(a.page, 'screen-listener');
  await waitChips(a.page, '1,100');
  await waitStatus(a.page, '当たり! +100');
  assert.deepEqual(a.errors, []);
  assert.deepEqual(late.errors, []);
  await context.close();
});

test('表示専用(stage=1): 操作ボタンが無く、盤・テーブル・結果・順位が配信者の画面と同じに出る', async () => {
  const { context, host, code } = await createRoom({ n: 9 });
  const a = await joinAs(context, code, 'みゆ');
  const { page: stage, errors } = await open(context, `index.html?mock=1&quick=1&room=${code}&stage=1`);
  await visible(stage, 'screen-stage');
  assert.equal(await stage.locator('#screen-stage button:not(.cell)').count(), 0);
  assert.equal(await stage.locator('#screen-stage .cell:not([disabled])').count(), 0);
  assert.equal(await stage.locator('#screen-stage [data-ref="code"]').innerText(), code);
  await tap(a.page, 9);
  await stage.waitForFunction(() => { const c = document.querySelector('#screen-stage [data-spot="9"] .chip.all'); return !!c && c.dataset.v === '10'; }, null, T);
  await spin(host);
  await stage.locator('#screen-stage [data-ref="result"] .disc.big').waitFor({ state: 'visible', ...T });
  assert.equal(await stage.locator('#screen-stage [data-ref="result"] .disc.big').innerText(), '9');
  assert.deepEqual(await rankRows(stage, 'screen-stage'), ['みゆ=1,350']);
  assert.equal(await stage.locator('#screen-stage .qacts').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('チップを配り直す: 全員 1,000 にもどり、配信者の収支も 0 にもどる', async () => {
  const { context, host, code, errors } = await createRoom({ n: 17 });
  const a = await joinAs(context, code, 'みゆ');
  await pick(a.page, 100); await tap(a.page, 17);
  await waitTotal(host, 17, 100);
  await spin(host);
  await waitChips(a.page, '4,500');
  await host.click('#reset-chips');
  await waitChips(a.page, '1,000');
  assert.equal(await host.locator('#screen-host [data-ref="house"]').innerText(), '配信者(ディーラー)の収支 ±0');
  assert.deepEqual(errors, []);
  await context.close();
});

test('部屋を閉じる: リスナーには「終了しました」と出て、配信者は入口に戻る', async () => {
  const { context, host, code, errors } = await createRoom({ extra: '&shareduid=1' });
  const a = await joinAs(context, code, 'たろう');
  await host.click('#close-room');
  await visible(host, 'screen-host-entry');
  await visible(a.page, 'screen-closed');
  assert.equal(await host.locator('#resume-banner').isHidden(), true);
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
  const { context, host, code } = await createRoom({ extra: '&shareduid=1' });
  const second = await open(context, 'index.html?mock=1&quick=1&shareduid=1');
  await visible(second.page, 'screen-host-busy');
  assert.equal(await second.page.locator('#busy-code').innerText(), code);
  await host.close();
  await context.close();
});

test('スマホの幅: 横にはみ出さず、テーブルのマスが押せる大きさで、チップの帯が画面の下に見えている', async () => {
  const { context, host, code } = await createRoom({ n: 17 });
  const a = await joinAs(context, code, 'みゆ');
  const over = await a.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 0, `横に ${over}px はみ出している`);
  const cell = await a.page.locator('#my-table [data-spot="17"]').boundingBox();
  assert.ok(cell.width >= 44 && cell.height >= 34, `マスの大きさ ${cell.width}×${cell.height}`);
  const bar = await a.page.locator('#betbar').boundingBox();
  assert.ok(bar.y + bar.height <= PHONE.height + 1 && bar.y > PHONE.height / 2, `チップの帯の位置 ${bar.y}`);
  const clear = await a.page.locator('#clear-bets').boundingBox();
  assert.ok(clear.height < 60, `「取り消す」が 1 行に収まる(高さ ${clear.height})`);
  // 配信者の画面をスマホで開いても、はみ出さない
  await host.setViewportSize(PHONE);
  await spin(host);
  const hostOver = await host.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(hostOver <= 0, `配信者の画面が横に ${hostOver}px はみ出している`);
  const url = await host.locator('#screen-host .urlbox').boundingBox();
  assert.ok(url.width > 250 && url.height < 90, `URL の欄: 幅 ${url.width} 高さ ${url.height}`);
  await context.close();
});
