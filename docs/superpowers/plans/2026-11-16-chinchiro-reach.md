# チンチロ第2弾(音・リーチ・ルール表・履歴・持ち点)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 音を確実に鳴らし、パチンコ風のリーチ演出と派手な結果演出を入れ、ルール表・出目の履歴・持ち点設定を追加する。

**Architecture:** 既存の素の JS 構成を保つ。純粋ロジック(`logic.js`: 持ち点・対戦記録)と純粋な HTML 組み立て(新規 `widgets.js`: ミニサイコロ・投げの履歴・順位・ルール表・記録)は Node でテストし、演出(`anim.js`: `reachPlan` 純粋関数 + `play()` の段取り + 音)と画面の配線(`app.js`, `index.html`, `style.css`)は Playwright で確かめる。保存は親機だけが書く `state` の中(`state.log`)に入れ、Firebase のルールは変えない。

**Tech Stack:** vanilla HTML/CSS/JS、Web Animations API、Web Audio、`node --test`、Playwright(`createRequire('playwright')`、`chinchiro/test/helpers.mjs` の `serve()`)。

**Spec:** `docs/superpowers/specs/2026-11-16-chinchiro-reach-design.md`

## Global Constraints

- ビルドなし。`index.html` の `<script>` 読み込み順: firebase-config → art → logic → sync → anim → widgets(新規)→ app。
- 演出の乱数は `throwObj.seed` から `mulberry32` で作る。リーチの乱数は別系統 `mulberry32((seed ^ 0x9e3779b9) >>> 0)` にして、既存の軌道の乱数(と既存テストの映像)を変えない。
- Firebase のルール(`firebase-rules.json`)は変更しない。新しい保存先は `state.log`(最大 30 件、新しい順)と `settings.startPoints` のみ。
- 持ち点: 選択肢 `50 / 100 / 300 / 1000 / 自由(1〜99999)`。既存の部屋(`startPoints` なし)は 100。
- リーチの溜め時間: L1 900ms、L2 1800ms、L3 2800ms(最後の 400ms は無音・暗転)。激アツの頻度は 5% 前後。`quick` と `prefers-reduced-motion` ではリーチなし。
- `?demo=1` のときだけ `&reach=0..3` でレベルを固定できる。
- 表示専用(`stage=1`)は従来どおり無音で、🔇 バッジを出さない。
- 既存テスト(`anim/logic/sync` 28、e2e 45、sugoroku 41)を落とさない。e2e は `.table.zoom` と `.fx-layer .dust`(6 個以上)に依存している。
- コミットは `git -c user.name="suesugi60" -c user.email="s.uesugi60@users.noreply.github.com" commit` で行い、末尾に Co-Authored-By と Claude-Session の行を付ける(会話内の指示どおり)。

## Review Focus

1. 旧バージョンで作られた部屋(`settings.startPoints` と `state.log` が無い)を開いても 100 点・空の記録として落ちずに表示される → Task 1 の `normalizeState` テストと Task 3 の「startPoints なし」テスト。
2. 「非表示」にしたリスナーの名前は、投げの履歴・対戦の記録でも `？？？` になる → Task 4 のテスト。
3. リーチの溜め中に次の投げが届いて `skip()` された後、カットイン・暗転・鼓動が残らず次の投げがきれいに始まる → Task 7 の「スキップ後に残骸なし」テスト。
4. 音: AudioContext が suspended のまま(まだ一度も触っていない)で鳴らそうとしても例外にならず、300ms 以内に running にならなければその音は捨てる(あとでまとめて鳴らない) → Task 5 のテスト。
5. 持ち点の自由入力が空・0・負・小数・10 万以上・文字のとき 100 にする(1〜99999 の整数だけ採用) → Task 3 のテスト。

---

### Task 1: ロジック — 持ち点と対戦の記録(`state.log`)

**Files:**
- Modify: `chinchiro/logic.js`(`createState`, `normalizeState`, `applyThrow`, `finish`, exports)
- Test: `chinchiro/test/logic.test.mjs`

**Interfaces:**
- Produces:
  - `START_POINTS = [50, 100, 300, 1000]`, `DEFAULT_START_POINTS = 100`, `LOG_MAX = 30`
  - `startPoints(settings) → number`(`settings.startPoints` が 1〜99999 の整数ならそれ、それ以外は 100)
  - `createState(start = DEFAULT_START_POINTS)` → `host.points = start`, `log: []`
  - `normalizeState(state)` → `log` を配列(最大 30)に補う。`host.points` は無いときだけ 100
  - `applyThrow(state, by, roll, settings, now = Date.now(), meta = {})` — `meta.childName`(文字列)を記録に使う
  - 記録 1 件: `{ n, at, uid, name, round, p: { dice, hand: {type, value, label} }, c: { dice, hand } | null, w: 'parent'|'child', m, pt, dr }`。`pt` は親から見た点の増減、`dr` は負けた側が飲む回数、`n` は通算(直前の `log[0].n + 1`、無ければ 1)。`p.dice`/`c.dice` は各側の最後の投げ。子が振っていなければ `c: null`。

- [ ] **Step 1: 失敗するテストを書く**(`logic.test.mjs` に追加)

```js
test('持ち点: startPoints は 1〜99999 の整数だけ採用、それ以外は 100', () => {
  assert.equal(L.startPoints({ startPoints: 300 }), 300);
  for (const v of [undefined, 0, -5, 1.5, 100000, '300', null]) assert.equal(L.startPoints({ startPoints: v }), 100, String(v));
  assert.equal(L.createState(300).host.points, 300);
  assert.deepEqual(L.createState().log, []);
  assert.deepEqual(L.normalizeState({ seq: 1, phase: 'lobby' }).log, []);
});
test('記録: 結果が出ると state.log の先頭に1件入り、30件で切れる', () => {
  const settings = { mode: 'points', unit: 10 };
  let st = L.startMatch(L.createState(), 'u1');
  st = L.applyThrow(st, 'parent', { dice: [4, 4, 6], seed: 1 }, settings, 1000).state;
  const { state, result } = L.applyThrow(st, 'child', { dice: [1, 2, 3], seed: 2 }, settings, 2000, { childName: 'たろう' });
  assert.equal(result.winner, 'parent');
  const e = state.log[0];
  assert.equal(state.log.length, 1);
  assert.deepEqual({ n: e.n, at: e.at, uid: e.uid, name: e.name, round: e.round, w: e.w, m: e.m, pt: e.pt, dr: e.dr }, { n: 1, at: 2000, uid: 'u1', name: 'たろう', round: 1, w: 'parent', m: 2, pt: 20, dr: 0 });
  assert.deepEqual(e.p, { dice: [4, 4, 6], hand: { type: 'me', value: 6, label: '6の目' } });
  assert.deepEqual(e.c, { dice: [1, 2, 3], hand: { type: 'hifumi', value: 0, label: 'ヒフミ' } });
  // 親がヒフミで即決着 → c は null、n は 2
  let s2 = L.startMatch(L.nextMatch(state), 'u2');
  s2 = L.applyThrow(s2, 'parent', { dice: [1, 2, 3], seed: 3 }, settings, 3000, { childName: 'はなこ' }).state;
  assert.equal(s2.log[0].n, 2); assert.equal(s2.log[0].c, null); assert.equal(s2.log[0].w, 'child'); assert.equal(s2.log[0].pt, -20);
  assert.equal(s2.log[1].n, 1);
  // 30 件で切れる
  let s3 = s2;
  for (let i = 0; i < 40; i++) { s3 = L.startMatch(L.nextMatch(s3), 'u3'); s3 = L.applyThrow(s3, 'parent', { dice: [1, 2, 3], seed: i }, settings, 4000 + i).state; }
  assert.equal(s3.log.length, L.LOG_MAX); assert.equal(L.LOG_MAX, 30); assert.equal(s3.log[0].n, 42);
  // 飲みモードでは dr に負けた側の飲む回数
  let s4 = L.startMatch(L.createState(), 'u1');
  s4 = L.applyThrow(s4, 'parent', { dice: [1, 2, 3], seed: 1 }, { mode: 'drink', drinkUnit: 'sip' }, 1).state;
  assert.equal(s4.log[0].dr, 2);
});
```

- [ ] **Step 2: 落ちることを確認** — `node --test chinchiro/test/logic.test.mjs` → `startPoints is not a function` などで 2 本 FAIL
- [ ] **Step 3: 実装** — `logic.js` に定数と `startPoints()`、`createState(start)`、`normalizeState` の `log` 補完、`applyThrow(..., meta)` → `finish(s, settings, meta, now)` で記録を先頭に追加し `slice(0, LOG_MAX)`。`hand` は `{ type, value, label }` だけ入れる。exports に `START_POINTS, DEFAULT_START_POINTS, LOG_MAX, startPoints` を追加
- [ ] **Step 4: 通ることを確認** — `node --test chinchiro/test/logic.test.mjs chinchiro/test/sync.test.mjs chinchiro/test/anim.test.mjs` → 全 PASS
- [ ] **Step 5: コミット** — `git add chinchiro/logic.js chinchiro/test/logic.test.mjs` / `chinchiro: 持ち点と対戦の記録(state.log)をロジックに追加`

### Task 2: `widgets.js` — ミニサイコロ・投げの履歴・順位・ルール表・記録の HTML

**Files:**
- Create: `chinchiro/widgets.js`(`ChinchiroWidgets`。ブラウザは global、Node は `module.exports`。`PIPS` は `ChinchiroAnim.PIPS`、Node では `require('./anim.js').PIPS`。ロジック定数は `ChinchiroLogic` / `require('./logic.js')`)
- Create: `chinchiro/test/widgets.test.mjs`
- Modify: `chinchiro/index.html`(`<script src="widgets.js">` を anim.js の後に)
- Modify: `chinchiro/style.css`(`.mdice`, `.throws`, `.legend`, `.rules`, `.log-row`)

**Interfaces:**
- Produces(すべて HTML 文字列を返す純粋関数。名前は内部で必ずエスケープ):
  - `esc(s)`
  - `diceHtml(dice)` → `<span class="mdice" data-n="4">…</span>` × 3(`PIPS` の配置で `<i>` を置く)。不正な出目は `?`
  - `throwsHtml(throws)` → `<div class="throws">` に `[dice + 役名]` を投げた順。役なしの投げは `目なし`、`hand.lose` の役はそのラベル。空なら `''`
  - `legendHtml()` → `ピンゾロ ×5 ＞ ゾロ目 ×3 ＞ シゴロ ×2 ＞ 目 ×1 ＞ 目なし ＞ ヒフミ ×2払い`(倍率は `evaluate` と `penaltyMult` から取る)
  - `rulesHtml(settings)` → 見出し `ルール`、役の表(ピンゾロ 1-1-1 ×5 / ゾロ目 ×3 / シゴロ 4-5-6 ×2 / 目 ×1 / 目なし 負け / ヒフミ 負け・2倍払う / ションベン 負け)、進め方の 3 行、`この部屋: 持ち点 N ・ 1戦 U点 × 倍率 ・ 飲みは X × 倍率`(モードに応じて点か飲みか両方)、例の 1 行(`例: 親がシゴロ(×2)で勝ち → 子は 2U点払う` / 飲みなら `X × 2 飲む`)
  - `logHtml(log, { meUid, players, settings })` → `.log-row`(自分の行は `.mine`、名前は `players[uid].hidden` なら `？？？`)。1 行 = `#n` + `親 dice 役名` + `vs 名前 dice 役名`(子なしは `(振らず)`)+ `→ 親の勝ち / 名前の勝ち ×m` + 点(`+20点` / `-10点`。親から見た値)と飲み(`🍺×2`。drink/both のとき)。空なら `<div class="empty-note">まだ対戦がありません</div>`

- [ ] **Step 1: 失敗するテストを書く**(`widgets.test.mjs` 新規。`createRequire` で `require('../widgets.js')`)

```js
test('diceHtml: 3つのミニサイコロ。4 の目は <i> が4つ', () => {
  const h = W.diceHtml([4, 5, 6]);
  assert.equal((h.match(/class="mdice"/g) || []).length, 3);
  assert.ok(/data-n="4">(<i[^>]*><\/i>){4}<\/span>/.test(h));
  assert.ok(W.diceHtml([9, 0, 'x']).includes('?'));
});
test('throwsHtml: 投げた順に出目と役名', () => {
  const h = W.throwsHtml([{ dice: [2, 4, 6], hand: null }, { dice: [3, 3, 5], hand: { type: 'me', value: 5, label: '5の目' } }]);
  assert.ok(h.indexOf('目なし') < h.indexOf('5の目'));
  assert.equal(W.throwsHtml([]), '');
});
test('legendHtml / rulesHtml: 倍率と部屋の設定が入る', () => {
  assert.ok(W.legendHtml().includes('ピンゾロ ×5'));
  const h = W.rulesHtml({ mode: 'both', unit: 20, drinkUnit: 'half', startPoints: 300 });
  for (const s of ['ルール', 'ピンゾロ', '×5', 'シゴロ', '×2', 'ヒフミ', '2倍', '持ち点 300', '1戦 20点', '半分', '40点']) assert.ok(h.includes(s), s);
  assert.ok(!W.rulesHtml({ mode: 'drink', drinkUnit: 'sip' }).includes('持ち点'));
});
test('logHtml: 自分の行に mine、非表示の人は？？？、点は親から見た符号', () => {
  const log = [
    { n: 2, uid: 'u2', name: '<b>x</b>', round: 1, p: { dice: [1, 2, 3], hand: { type: 'hifumi', value: 0, label: 'ヒフミ' } }, c: null, w: 'child', m: 2, pt: -20, dr: 2 },
    { n: 1, uid: 'u1', name: 'たろう', round: 1, p: { dice: [4, 4, 6], hand: { type: 'me', value: 6, label: '6の目' } }, c: { dice: [2, 2, 5], hand: { type: 'me', value: 5, label: '5の目' } }, w: 'parent', m: 1, pt: 10, dr: 0 },
  ];
  const h = W.logHtml(log, { meUid: 'u1', players: { u2: { hidden: true } }, settings: { mode: 'both', drinkUnit: 'sip' } });
  assert.equal((h.match(/class="log-row/g) || []).length, 2);
  assert.ok(h.includes('log-row mine'));
  assert.ok(h.includes('？？？') && !h.includes('<b>x</b>'));
  for (const s of ['#2', '(振らず)', '-20点', '🍺×2', '#1', 'たろう', '+10点', '親の勝ち']) assert.ok(h.includes(s), s);
  assert.ok(W.logHtml([], {}).includes('まだ対戦がありません'));
});
```

- [ ] **Step 2: 落ちることを確認** — `node --test chinchiro/test/widgets.test.mjs` → `Cannot find module` で FAIL
- [ ] **Step 3: 実装** — `widgets.js` を作る(上の Interfaces どおり)。`index.html` に script を追加。CSS: `.mdice`(18px の 3×3 グリッド、紺の 2px 枠、白地、`i` は 4px の丸)、`.throws`(横並び・折り返し、1 投を白い小さな札に)、`.legend`(1 行・小さめ・中央)、`.rules table`(行間広め、1 列目はサイコロ)、`.log-row`(細い区切り線、`.mine` は黄色の背景)
- [ ] **Step 4: 通ることを確認** — `node --test chinchiro/test/widgets.test.mjs` → PASS
- [ ] **Step 5: コミット** — `chinchiro: widgets.js(ミニサイコロ・履歴・順位・ルール表・記録の HTML)`

### Task 3: 持ち点の設定(部屋を作る画面)と表示の置き換え

**Files:**
- Modify: `chinchiro/index.html`(host-entry に「持ち点」の `choices` と自由入力)
- Modify: `chinchiro/app.js`(`setup.startPoints`、`renderEntry`、`enterHostEntry` の復元、`createRoom`、`?? 100` の置き換え 5 か所: 親の成績・順番待ち・ランキング・スマホの成績・結果の点数更新、`MODE_LABEL` の hint)
- Test: `chinchiro/test/e2e.test.mjs`

**Interfaces:**
- Consumes: Task 1 の `L.START_POINTS`, `L.startPoints(settings)`, `L.createState(start)`
- Produces: `settings.startPoints`(number)。`index.html` の要素 `#start-choices`(`.choice[data-start="50|100|300|1000|custom"]`)、`#start-custom`(`type="number"`、custom のときだけ表示)。`app.js` の `const startPts = (settings) => L.startPoints(settings)`

- [ ] **Step 1: 失敗するテストを書く**

```js
test('持ち点: 300 を選んで部屋を作ると、親の成績・参加者・ランキングが 300 点から', async () => {
  const { page: host, context, errors } = await newPage(null, 'index.html?mock=1&quick=1');
  await host.locator('#host-name').fill('親');
  await host.locator('#start-choices .choice[data-start="300"]').click();
  await host.locator('#create-room').click();
  await host.locator('#room-code').waitFor(T);
  assert.ok((await host.locator('#host-record').innerText()).includes('300点'));
  const code = await host.locator('#room-code').innerText();
  const kid = await joinAs(context, code, 'たろう');
  await kid.locator('#my-record').waitFor(T);
  assert.ok((await kid.locator('#my-record').innerText()).includes('300点'));
  assert.ok((await host.locator('#queue').innerText()).includes('300点'));
  assert.ok((await host.locator('#ranking').innerText()).includes('300点'));
  assert.deepEqual(errors, []);
  await context.close();
});
test('持ち点: 自由入力は 1〜99999 の整数だけ。空や 0 や文字なら 100', async () => {
  for (const [typed, want] of [['777', '777点'], ['0', '100点'], ['abc', '100点'], ['', '100点'], ['123456', '100点']]) {
    const { page: host, context } = await newPage(null, 'index.html?mock=1&quick=1');
    await host.locator('#start-choices .choice[data-start="custom"]').click();
    await host.locator('#start-custom').waitFor({ state: 'visible', ...T });
    await host.locator('#start-custom').fill(typed);
    await host.locator('#create-room').click();
    await host.locator('#room-code').waitFor(T);
    assert.ok((await host.locator('#host-record').innerText()).includes(want), typed);
    await context.close();
  }
});
test('持ち点が未設定の古い部屋は 100 点として表示される', async () => { /* mock backend に startPoints 無しの settings と log 無しの state を直接書いて(readRoom の逆、helpers の writeRoom か page.evaluate)、親機を開いて 100点 と「まだ対戦がありません」が出ることを確認 */ });
```
(3 本目は `helpers.mjs` に `writeRoom(page, code, patch)` が無ければ `page.evaluate` で mock の `localStorage` を書く。既存の `readRoom` の実装を見て同じ鍵を使う)

- [ ] **Step 2: 落ちることを確認** — `node --test --test-name-pattern="持ち点" chinchiro/test/e2e.test.mjs` → FAIL(`#start-choices` が無い)
- [ ] **Step 3: 実装** — `index.html` に `<h2>持ち点(点数モード)</h2><div class="choices four" id="start-choices"></div><input id="start-custom" class="player-name" type="number" inputmode="numeric" min="1" max="99999" placeholder="持ち点を入力(1〜99999)" hidden>`。`app.js`: `setup.startPoints = 100`(`'custom'` も可)、`renderEntry` で `START_POINTS` + `{ value: 'custom', label: '自由', hint: '好きな点' }` を描き、custom のとき `#start-custom` を表示。`createRoom` で `const sp = setup.startPoints === 'custom' ? L.startPoints({ startPoints: Number($('start-custom').value) }) : setup.startPoints` を `settings.startPoints` と `L.createState(sp)` に使う。`KEY_SETUP` の復元で `startPoints` も戻す(custom のときは入力値も `setup.customStart` に保存)。`MODE_LABEL.points.hint` は `renderEntry` で `持ち点${表示用の値}から` に差し替える。`?? 100` を `?? startPts(settings)` に置き換える(5 か所)。CSS `.choices.four { grid-template-columns: repeat(5, 1fr) }`(自由を含めて 5 つ。スマホでは 2 段でよい: `@media (max-width: 480px) { repeat(3, 1fr) }`)
- [ ] **Step 4: 通ることを確認** — `node --test --test-name-pattern="持ち点|ランキング|対戦:" chinchiro/test/e2e.test.mjs` → PASS
- [ ] **Step 5: コミット** — `chinchiro: 持ち点を部屋を作るときに設定できるように`

### Task 4: 画面の配線 — 投げの履歴・順位の1行・対戦の記録・ルール表

**Files:**
- Modify: `chinchiro/index.html`(親機: ヘッダーに `#rules-btn`、アリーナ下に `<div class="legend" data-ref="legend">`、右側に `<section class="panel box" data-ref="log-box"><h3>対戦の記録</h3><div data-ref="log"></div></section>`。スマホ: `#rules-btn-l`、`.legend`、同じ記録パネル(`data-ref` で)。参加画面: `<a href="#" id="rules-link">ルールを見る</a>`。共通: `<div id="rules" class="overlay" hidden><div class="rules panel"><div id="rules-body"></div><button id="rules-close" class="btn btn-primary">閉じる</button></div></div>`)
- Modify: `chinchiro/app.js`(`fighterHtml` に `throwsHtml` 引数を足して `.fhand` の後に差し込む、`renderBoard` で `legend`(一度だけ)と `log`(内容が変わったときだけ `innerHTML`)、`renderListener` 用に `listenerView.refs` でも同じ、`hostThrowAndSettle` で `meta.childName` を渡す、`openRules()/closeRules()` とイベント(ボタン・背景タップ・Esc))
- Modify: `chinchiro/style.css`(`.rules` は `max-width: 520px; max-height: 85vh; overflow: auto`)
- Test: `chinchiro/test/e2e.test.mjs`

**Interfaces:**
- Consumes: Task 2 の `ChinchiroWidgets.{throwsHtml, legendHtml, rulesHtml, logHtml}`、Task 1 の `meta.childName`
- Produces: 要素 `#rules`, `#rules-body`, `#rules-btn`(親機), `#rules-btn-l`(スマホ), `#rules-link`(参加), `[data-ref="log"]`, `[data-ref="legend"]`, `.fighter .throws`

- [ ] **Step 1: 失敗するテストを書く**

```js
test('ルール表: 親機とスマホで開いて閉じられ、役・倍率・この部屋の持ち点が書いてある', async () => {
  const { host, kid, context } = await setupMatch({ startPoints: 300 }); // 既存 helper に設定を渡せなければ createRoom 後に手で
  await host.locator('#rules-btn').click();
  await host.locator('#rules:not([hidden])').waitFor(T);
  const text = await host.locator('#rules-body').innerText();
  for (const s of ['ピンゾロ', '×5', 'ヒフミ', '持ち点 300']) assert.ok(text.includes(s), s);
  await host.keyboard.press('Escape');
  await host.locator('#rules[hidden]').waitFor({ state: 'attached', ...T });
  await kid.locator('#rules-btn-l').click();
  await kid.locator('#rules:not([hidden])').waitFor(T);
  await kid.locator('#rules-close').click();
  await kid.locator('#rules[hidden]').waitFor({ state: 'attached', ...T });
  await context.close();
});
test('履歴: 対戦中はアリーナに各側の投げが並び、決着すると両画面の「対戦の記録」に1行出る', async () => {
  const { host, kid, context } = await setupMatch();
  await fixDice(host, [[2, 4, 6], [4, 4, 6]]); // 親: 目なし → 6の目
  await host.locator('#host-roll').click(); await host.locator('#host-roll').click();
  await host.locator('.fighter.host .throws').waitFor(T);
  const th = await host.locator('.fighter.host .throws').innerText();
  assert.ok(th.includes('目なし') && th.includes('6の目'));
  await fixDice(host, [[1, 2, 3]]);
  await kid.locator('#listener-roll').click();
  await host.locator('[data-ref="log"] .log-row').first().waitFor(T);
  const row = await host.locator('[data-ref="log"]').innerText();
  for (const s of ['#1', '6の目', 'ヒフミ', '親の勝ち', '+20点']) assert.ok(row.includes(s), s);
  await kid.locator('[data-ref="log"] .log-row.mine').waitFor(T);
  assert.ok((await host.locator('[data-ref="legend"]').innerText()).includes('ピンゾロ ×5'));
  await context.close();
});
test('履歴: 非表示にした人は記録でも？？？', async () => { /* setupMatch → 親機で「非表示」→ 決着 → [data-ref="log"] に ？？？ が出て名前が出ない */ });
```

- [ ] **Step 2: 落ちることを確認** — `node --test --test-name-pattern="ルール表|履歴" chinchiro/test/e2e.test.mjs` → FAIL
- [ ] **Step 3: 実装** — 上の Files のとおり。`fighterHtml(cls, char, color, name, sub, handText, handSub, turn, extraCls, throwsHtml = '')`。記録は `r.log.dataset.last` 比較で差分更新。ルール表の設定は `room ? room.settings : { mode: setup.mode, unit: setup.unit, drinkUnit: setup.drinkUnit, startPoints: ... }`。表示専用(`enterStage` のクローン)はボタンが消えるので記録・順位だけ映る
- [ ] **Step 4: 通ることを確認** — `node --test chinchiro/test/e2e.test.mjs` → 全 PASS(既存の「非表示」「描画: 作り直さない」も含む)
- [ ] **Step 5: コミット** — `chinchiro: 投げの履歴・対戦の記録・順位の1行・ルール表を画面に`

### Task 5: 音を確実に鳴らす

**Files:**
- Modify: `chinchiro/anim.js`(`createSounds`: `ensure()`, `ready`, `onReadyChange`, `unlock()` の拡張、`SILENT_LOOP`)
- Modify: `chinchiro/app.js`(`document` の `pointerdown` / `keydown` / `touchend` / `visibilitychange` → `sounds.unlock()`、`#audio-badge` の表示切り替え)
- Modify: `chinchiro/index.html`(`<div id="audio-badge" class="audio-badge" hidden>🔇 タップで音をオン</div>`)、`style.css`(`.audio-badge`: 画面下中央に固定、黄色、紺の枠)
- Test: `chinchiro/test/e2e.test.mjs`

**Interfaces:**
- Produces(`createSounds()` の戻り値に追加):
  - `get ready` → `!!ctx && ctx.state === 'running'`
  - `onReadyChange(cb)` → `ctx` の `statechange` と `unlock()` の後に `cb(ready)`
  - `unlock()` → (既存の AudioContext 作成・`resume()`)+ `keepAlive` が true なら無音ループ `<audio loop playsinline>`(`SILENT_LOOP` = 0.5 秒の無音 WAV data URI。1 つだけ作り、`paused` なら `play()` し直す)+ 読み上げの初回解錠(`volume 0` の空白を 1 回 `speak`)
  - `setKeepAlive(bool)` → true: 次の `unlock()`(とすぐ 1 回)でループを回す。false: ループを `pause()`。親機は `enterHost` で true、スマホは `renderListener` で `inMatch` の値、表示専用は常に false
  - 内部 `ensure(fn)`: `ctx.state === 'running'` ならすぐ `fn(ctx)`、違えば `resume()` を呼び 300ms 以内に解決したら `fn(ctx)`、間に合わなければ捨てる。`noise/tone/lowNoise/sweep` はすべてこれを通す

- [ ] **Step 1: 失敗するテストを書く**(`AudioContext` と `Audio` を差し替える。`addInitScript` で `window.AudioContext = class { constructor(){ this.state='suspended'; this.currentTime=0; this.sampleRate=48000; window.__ctx=this; } resume(){ window.__resumes=(window.__resumes||0)+1; return new Promise(r=>{ if(window.__allow){ this.state='running'; r(); } }); } createBuffer(){ return { getChannelData(){ return new Float32Array(10); } }; } createBufferSource(){ return window.__node(); } createOscillator(){ return window.__node(); } createGain(){ return window.__node(); } createBiquadFilter(){ return window.__node(); } addEventListener(k,f){ this.cb=f; } get destination(){ return {}; } }` 、`window.__node = () => ({ connect(){ return this; }, start(){ window.__started=(window.__started||0)+1; }, stop(){}, gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){}, value:0 }, frequency:{ setValueAtTime(){}, exponentialRampToValueAtTime(){}, value:0 }, buffer:null, type:'', Q:{value:0} })`。`Audio` は Task 1 の voice テストと同じ形に `loop`/`paused` を足す)

```js
test('音: まだ触っていない(suspended)間は resume を試し、300ms 以内に running にならなければその音は捨てる', async () => {
  // __allow=false のまま sounds.clack() → __resumes >= 1, 400ms 待っても __started === 0
  // __allow=true にして sounds.clack() → __started >= 1
});
test('音: 親機は最初のタップで無音ループが再生され、AudioContext が running になり、バッジが消える', async () => {
  // 親機(mock)で部屋を作った直後: #audio-badge が見える(suspended)。__allow=true で body をタップ → __played に data:audio/wav が1件(loop=true)、#audio-badge[hidden]
});
test('音: スマホは自分の対戦中だけ無音ループが回り、決着したら止まる', async () => {
  // setupMatch → 子のページ: 対戦開始前はループ要素なし(__played に data:audio/wav が無い)→ 自分の番で「振る」をタップ → ループ play → 決着後 renderListener で paused=true
});
test('音: 表示専用(stage=1)にはバッジが出ず、ループも回らない', async () => { /* enterStage 後 #audio-badge[hidden]、__played に data:audio/wav なし */ });
```

- [ ] **Step 2: 落ちることを確認** — `node --test --test-name-pattern="^音:" chinchiro/test/e2e.test.mjs` → FAIL
- [ ] **Step 3: 実装** — Interfaces のとおり。`app.js`: `function updateAudioBadge() { $('audio-badge').hidden = sounds.muted || sounds.ready || !(role === 'host' || role === 'listener'); }` を `sounds.onReadyChange`、`renderMute`、`enterHost/enterListener` から呼ぶ。`visibilitychange` で `document.visibilityState === 'visible'` なら `sounds.unlock()`
- [ ] **Step 4: 通ることを確認** — `node --test chinchiro/test/e2e.test.mjs` → 全 PASS(既存の「音のロック解除」「表示専用画面は音を出さない」も)
- [ ] **Step 5: コミット** — `chinchiro: 音を確実に(無音ループで消音スイッチ対策、操作のたびに再開、鳴らせない間はバッジ)`

### Task 6: `reachPlan` — 最後の1個とリーチのレベル(純粋関数)

**Files:**
- Modify: `chinchiro/anim.js`(`reachPlan`, `REACH_WEIGHTS`, `REACH_HOLD_MS` を export)
- Test: `chinchiro/test/anim.test.mjs`

**Interfaces:**
- Produces:
  - `REACH_WEIGHTS = { pinzoro: [0, 5, 25, 70], zoro: [0, 20, 45, 35], shigoro: [0, 25, 45, 30], me: [70, 22, 6, 2], noneShigoro: [75, 18, 5, 2], hifumi: [10, 30, 60, 0], nonePinch: [80, 15, 5, 0] }`(L0..L3 の重み)
  - `REACH_HOLD_MS = { 1: 900, 2: 1800, 3: 2800 }`
  - `reachPlan(dice, shonben, seed, force) → { lastIdx: 0|1|2, kind: 'pinzoro'|'zoro'|'shigoro'|'pinch'|null, level: 0..3, pinch: boolean }`。`shonben` か不正な出目なら `{ lastIdx: 2, kind: null, level: 0, pinch: false }`。乱数は `mulberry32((seed ^ 0x9e3779b9) >>> 0)` で、順に (1) 順番の表裏 `rnd() < 0.5`、(2) `lastIdx` の候補からの選択 `floor(rnd()*k)`、(3) レベル `rnd()` を引く(常に 3 回引く)。
  - 順番: 3 つ同じ・4-5-6・1-2-3 → `lastIdx` は 3 つから選ぶ。2 つ同じ + 1 つ違う → 表なら違う 1 つが最後、裏なら違う 1 つが先(ペアのどちらを最後にするかを選ぶ)。バラバラ → 表なら多数派(4〜6 側か 1〜3 側の 2 つ)が先で残りが最後、裏なら多数派の 1 つが最後(2 つから選ぶ)。
  - `kind` は先に止まる 2 個だけから: 同じ目 → `'zoro'`(1 なら `'pinzoro'`)、両方 4〜6 で違う → `'shigoro'`、両方 1〜3 で違う → `'pinch'`、それ以外 → `null`(レベル 0)。
  - レベルの重みは結果(`evaluate` 相当)で選ぶ: ピンゾロ/ゾロ目/シゴロ/ヒフミはその行、目は `me`、役なしは `kind === 'pinch' ? nonePinch : noneShigoro`。`kind === 'pinch'` ならレベルは最大 2。`force` が 0〜3 の整数なら `kind` が null でもレベルをそれにする(デモ用。null のときの cutin 文言は「リーチ!」)

- [ ] **Step 1: 失敗するテストを書く**

```js
test('reachPlan: 最後の1個の選び方と見える形', () => {
  const plans = (dice) => Array.from({ length: 400 }, (_, s) => A.reachPlan(dice, false, s));
  // 2つ同じ+1つ違う: 違う1つが最後のとき(ゾロ目リーチ)と、先のときがどちらもある
  const me = plans([3, 3, 5]);
  assert.ok(me.some((p) => p.lastIdx === 2 && p.kind === 'zoro'));
  assert.ok(me.some((p) => p.lastIdx !== 2 && p.kind === null)); // 5・3 が先 → 形なし
  assert.ok(me.every((p) => p.lastIdx === 2 ? p.kind === 'zoro' : p.kind === null));
  const me2 = plans([4, 4, 5]);
  assert.ok(me2.some((p) => p.lastIdx !== 2 && p.kind === 'shigoro')); // 5・4 が先 → シゴロリーチ → 外れて5の目
  assert.ok(plans([1, 4, 1]).some((p) => p.kind === 'pinzoro'));
  // バラバラ: 多数派が先(シゴロリーチ / ピンチ)のときと、混ざった2つが先(形なし)のときがある
  const none = plans([4, 2, 6]);
  assert.ok(none.some((p) => p.lastIdx === 1 && p.kind === 'shigoro'));
  assert.ok(none.some((p) => p.lastIdx !== 1 && p.kind === null));
  const none2 = plans([5, 1, 2]);
  assert.ok(none2.some((p) => p.lastIdx === 0 && p.kind === 'pinch' && p.pinch));
  assert.ok(none2.every((p) => p.level <= 2));
  assert.deepEqual(A.reachPlan([2, 3, 5], true, 1), { lastIdx: 2, kind: null, level: 0, pinch: false }); // ションベン
  assert.ok(plans([4, 5, 6]).every((p) => p.kind === 'shigoro'));
  assert.ok(plans([1, 2, 3]).every((p) => p.kind === 'pinch' && p.level <= 2));
  assert.ok(plans([6, 6, 6]).every((p) => p.kind === 'zoro'));
  assert.ok(plans([1, 1, 1]).every((p) => p.kind === 'pinzoro'));
  assert.deepEqual(A.reachPlan([6, 6, 6], false, 42), A.reachPlan([6, 6, 6], false, 42)); // 同じ seed なら同じ
  assert.equal(A.reachPlan([2, 4, 6], false, 1, 3).level, 3);     // 強制
  assert.ok(plans([2, 4, 6]).every((p) => p.kind !== null || p.level === 0)); // 形なしならレベル0
});
test('reachPlan: レベルの分布(信頼度)', () => {
  const dist = (dice) => { const c = [0, 0, 0, 0]; for (let s = 0; s < 3000; s++) c[A.reachPlan(dice, false, s).level]++; return c.map((x) => x / 3000); };
  const pz = dist([1, 1, 1]); assert.ok(pz[3] > 0.6 && pz[0] === 0);
  const me = dist([3, 3, 5]); assert.ok(me[0] > 0.75 && me[3] < 0.05); // 半分は形なし(L0)なので L0 が多い
  const hf = dist([1, 2, 3]); assert.equal(hf[3], 0); assert.ok(hf[2] > 0.5);
  const sg = dist([4, 5, 6]); assert.ok(sg[0] === 0 && sg[3] > 0.2);
  assert.deepEqual(A.REACH_HOLD_MS, { 1: 900, 2: 1800, 3: 2800 });
});
```

- [ ] **Step 2: 落ちることを確認** — `node --test chinchiro/test/anim.test.mjs` → FAIL
- [ ] **Step 3: 実装** — `anim.js` の「声」の節の後に「リーチ」の節を作る。結果のクラスは `evaluate` 相当を自前で判定(`validDice` → 3 つ同じ / 4-5-6 / 1-2-3 / 2 つ同じ / バラバラ)。順番と `kind` と重みは Interfaces のとおり(`kind` は先に止まる 2 個から計算する関数 `visibleKind(a, b)` に分ける)
- [ ] **Step 4: 通ることを確認** — `node --test chinchiro/test/anim.test.mjs` → PASS
- [ ] **Step 5: コミット** — `chinchiro: reachPlan(最後の1個とリーチの強さを seed から決める)`

### Task 7: 器の場面にリーチを入れる

**Files:**
- Modify: `chinchiro/anim.js`(`play()`、`skip()`、`reset()`、`createSounds` に `heartbeat(level) → { stop }`, `siren()`, `drone() → { stop }`, `hit()`)
- Modify: `chinchiro/style.css`(`.table.reach`、`.reach-l1/.reach-l2/.reach-l3`、`.table.pinch`、`.table.dark2`、`.table.hit`、`.cube.hold`、`.spot`、`.cutin`、`.lamps`、`.stripes`、`.bolt`)
- Modify: `chinchiro/app.js`(`DEMO` のとき `opts.forceReach = Number(params.get('reach'))`)
- Test: `chinchiro/test/e2e.test.mjs`

**Interfaces:**
- Consumes: Task 6 の `reachPlan`, `REACH_HOLD_MS`; Task 5 の `ensure`
- Produces: `play(throwObj, opts)` の `opts.forceReach`(0〜3)。DOM: `.table.reach.zoom.reach-l{level}[.pinch]`、`.fx-layer .cutin`(文字: L1 `リーチ!` / L2 `スーパーリーチ!!` / L3 `激アツ!!!` / ピンチ L1 `ピンチ…` / L2 `大ピンチ!!`。`kind === 'pinzoro'` なら先頭に `ピンゾロ`)、`.cube.hold`(溜め中の最後の1個)。溜め中は `root.classList` に `reaching`

- [ ] **Step 1: 失敗するテストを書く**

```js
test('リーチ: 1,1,1 を reach=3 で投げると「激アツ」のカットインと暗転・ズームの後にピンゾロ', async () => {
  const { page, context, errors } = await newPage(null, 'index.html?demo=1&dice=1,1,1&seed=7&reach=3');
  await page.locator('#stage .fx-layer .cutin').waitFor({ state: 'visible', timeout: 10000 });
  assert.ok((await page.locator('#stage .cutin').innerText()).includes('激アツ'));
  assert.ok(await page.locator('#stage .table.reach.zoom.reach-l3').count());
  assert.equal(await page.locator('#stage .cube.hold').count(), 1);
  assert.equal(await page.locator('#stage .result-stamp').innerText(), ''); // 溜め中は結果なし
  await page.locator('#stage .result-stamp[data-hand="pinzoro"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.locator('#stage .table.reach').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
test('リーチ: 1,2,3 を reach=2 で投げると「大ピンチ」の後にヒフミ', async () => { /* .cutin に 大ピンチ, .table.pinch, その後 data-hand="hifumi" */ });
test('リーチ: 溜め中にタップすると即結果で、カットイン・暗転・溜めが残らない', async () => {
  // reach=3 で .cutin を待ってから #stage をクリック → 1 秒以内に data-hand="pinzoro"、.cutin 0 個、.table.reach 0 個、.cube.hold 0 個
  // つづけて同じページで別の投げ(page.evaluate で stage.play を直接呼べないので demo を再読み込み)でも最初からきれいに始まる
});
test('リーチ: quick=1 と reach=0 ではリーチなし(.cutin が出ない)', async () => { /* dice=1,1,1&quick=1 → stamp まで .cutin 0 個。dice=1,1,1&reach=0 も同様で .table.zoom は付く */ });
```

- [ ] **Step 2: 落ちることを確認** — `node --test --test-name-pattern="リーチ" chinchiro/test/e2e.test.mjs` → FAIL
- [ ] **Step 3: 実装(`play()`)** — `const plan = reachPlan(dice, throwObj.shonben, throwObj.seed, opts.forceReach)`; `decider = outIdx < 0 ? plan.lastIdx : -1`; 投げる順は decider 以外を先に(遅延 0 / 90ms)、decider は 180ms。着地の「カッ」と砂煙のタイマーは、decider については溜め・減速の後の実時間で組み直す(`scheduleBounces(path, fromOff, rate, baseMs)`: `off > fromOff` の着地点を `baseMs + (off - fromOff) * D / rate` に)。
  - level 0: 従来どおり `delay + D*0.76` で `playbackRate = 0.5`、`zoom` を付ける(CSS の `.zoom` は `scale(1.08)` に弱める)。
  - level ≥ 1: `delay + D*0.58`(≈1.05 秒)で decider の 3 つのアニメを `pause()`、`cube.classList.add('hold')`、`table` に `reach zoom reach-l{level}`(+ `pinch`)、`--spot-x/--spot-y` に軌道の 0.58 の点。2 個目の着地(先に投げる 2 個のうち遅い方の `delay + D*0.86` ≈ 1.38 秒)で `cutin` を `fx` に追加し `sounds.heartbeat(level)`(ピンチは `drone()`)。溜め `HOLD` はそこから数える。L3 は `HOLD-400` で `dark2` を付け音を止める。`HOLD` 経過で `play()`、`playbackRate = 0.6`、`hold` を外す。着地(off 0.86)の実時間で `hit()`: 9 本の `pause()` → 120ms → `play()`、`table.hit`、`fxFlash('white', 200)`、`fxShake(true)`、`sounds.hit()`。
  - `await Promise.all(finished)` の後に `reach/zoom/dark2/hit` を外す(`pinch` で負けた場合の `dark` は `showResult` が付ける)。
- [ ] **Step 4: 実装(`skip()`/`reset()`)** — `run.stops`(鼓動などの stopper)を全部 `stop()`、`fx` の `.cutin/.lamps/.stripes/.bolt/.spot` を消す、`table` の `reach zoom reach-l* pinch dark2 hit` を外す、`cube.hold` を外す、paused のアニメは `play()` してから `finish()`。`reset()` は `el.table.className = 'table'` のままで足りるか確認(`root.classList.remove('reaching')` を追加)
- [ ] **Step 5: 実装(音)** — `heartbeat(level)`: 1 拍 = `tone(60, 0.25, 0.9, 'sine') + lowNoise(0.08, 0.6)`。L1 は 0/450ms、L2 は 0/350/700/1050ms、L3 は 0/500/900/1250/1550/1800/2000/2150ms + 1600ms で `siren()`(`sweep(200, 1800, 1.2, 0.35)`)。`drone()`: `tone(55, 1.2, 0.3, 'sawtooth')` を 0.6 秒ごとに繰り返す。すべて `{ stop() }` を返す(タイマーを消す)。`hit()`: `clack(1.6)` + `lowNoise(0.25, 1)`
- [ ] **Step 6: 実装(CSS)** — `.table.reach` はビネット(`::after` に `radial-gradient(circle at var(--spot-x) var(--spot-y), transparent 70px, rgba(0,0,0,.75) 180px)`)、`.table.reach.zoom { transform: scale(1.3) translate(…最後の1個へ寄る…) }`(`--spot-x/--spot-y` から `calc`)、`.cutin`(中央・巨大・縁取り、`cutin-in .3s` で横から滑り込み)、`.reach-l2 .lamps`(左右に点滅する丸いランプ 4 つ)、`.reach-l3 .stripes`(上下に赤黒の斜めストライプがスクロール)、`.reach-l3 .bolt`(稲妻の SVG を 2 本、ちらつき)、`.table.pinch` は赤黒、`.dark2 { filter: brightness(.15) }`、`.cube.hold .cube-tilt { animation: hold-spin 1.6s linear infinite }`、`.table.hit { filter: brightness(1.6) }`
- [ ] **Step 7: 通ることを確認** — `node --test chinchiro/test/e2e.test.mjs` → 全 PASS(既存「派手さ: …最後の1個はズームする」「タップで演出を飛ばせる(2秒以内)」「サイコロが止まるまで…出ない」を含む。2 秒以内のテストはタップが溜め中でも通ること)
- [ ] **Step 8: コミット** — `chinchiro: リーチ演出(溜め・ズーム・カットイン・鼓動・ヒットストップ)`

### Task 8: 結果と通常の投げをもっと派手に

**Files:**
- Modify: `chinchiro/anim.js`(`showResult` の強化、`fxRays(kind)`, `fxImpact()`, `fxStreak()`, 砂煙の個数、`sounds.sad()`)
- Modify: `chinchiro/style.css`(`.rays`, `.impact`, `.streak`, `.stage.bigwin-gold::before`, `.result-stamp` の 2 段階ポップ `stamp-pop2`, `.result-stamp[data-fail="1"]`)
- Test: `chinchiro/test/e2e.test.mjs`

**Interfaces:**
- Consumes: Task 7 の `plan`(`showResult(throwObj, opts, dies, rnd, skipped, plan)` に渡す)
- Produces: DOM `.fx-layer .rays.gold|.rainbow|.blue`、`.fx-layer .impact`、`.fx-layer .streak`、`.stage.bigwin-gold`(ピンゾロのとき 900ms)、`.result-stamp[data-fail="1"]`(リーチが外れた目・目なし)

- [ ] **Step 1: 失敗するテストを書く**

```js
test('派手さ: ピンゾロは金の光線・集中線・画面全体の金フラッシュ・粒子 60 個以上', async () => {
  const { page, context } = await newPage(null, 'index.html?demo=1&dice=1,1,1&seed=7&reach=0');
  await page.locator('#stage .result-stamp[data-hand="pinzoro"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.ok(await page.locator('#stage .fx-layer .rays.gold').count());
  assert.ok(await page.locator('#stage .fx-layer .impact').count());
  assert.ok(await page.locator('#stage.bigwin-gold').count());
  assert.ok((await page.locator('#stage .fx-layer .particle').count()) >= 60);
  await context.close();
});
test('派手さ: 投げ込みで光の筋が走り、砂煙は 8 個以上。リーチが外れた目はしょんぼり表示', async () => {
  // dice=3,3,5&seed=5&reach=1 → .streak が付く、stamp 後に .dust >= 8、.result-stamp[data-fail="1"]
});
```

- [ ] **Step 2: 落ちることを確認** → FAIL
- [ ] **Step 3: 実装** — `showResult`: pinzoro = `fxRays('gold') + fxImpact() + fxFlash('gold',1100) ×2(350ms 差) + fxParticles(rnd, 60, 金系, true) + root.classList.add('bigwin-gold')(900ms で外す)+ boom + chime('gold') を 2 回(400ms 差)`。zoro = `fxRays('rainbow') + fxImpact() + particles 36`。shigoro = `fxRays('blue') + particles 24`。`plan.level >= 1 && (key === 'me' || key === 'none')` のとき `sounds.sad()`(`sweep(400, 150, 0.6, 0.3)`)と `el.stamp.dataset.fail = '1'`(灰色)。`play()` の投げ込み時に `fxStreak()`(器の上を左から右へ光る帯、500ms)。`fxDust` の個数を 6/4 → 8/5。`.rays` は `conic-gradient` の放射を `rays-spin 2s linear` で回す 1.6 秒。`.impact` は `repeating-conic-gradient` の集中線(中央は透明)0.6 秒
- [ ] **Step 4: 通ることを確認** — `node --test chinchiro/test/e2e.test.mjs` → 全 PASS
- [ ] **Step 5: コミット** — `chinchiro: 結果と投げ込みの演出を強化(光線・集中線・金フラッシュ・光の筋)`

### Task 9: 仕上げ — README・CSS の残骸・全テスト・公開

**Files:**
- Modify: `chinchiro/README.md`(使い方に「ルール」ボタン・履歴・持ち点、リーチの説明(信頼度の目安)、音が出ないときの対処、デモの `reach=` パラメータ)
- Modify: `chinchiro/style.css`(`.overlay` の直後にある孤立した 3 行の断片 `overflow: hidden; animation: bounce-in …` / `background: #fff; …` / `transform: translateX(-50%) rotate(45deg); }` を削除)

- [ ] **Step 1: README を更新**(上の内容。ルールの表は既存のまま)
- [ ] **Step 2: CSS の断片を削除し、`node --test chinchiro/test/e2e.test.mjs` で崩れないことを確認**
- [ ] **Step 3: 全スイート** — `node --test chinchiro/test/anim.test.mjs chinchiro/test/logic.test.mjs chinchiro/test/sync.test.mjs chinchiro/test/widgets.test.mjs` → 全 PASS、`node --test chinchiro/test/e2e.test.mjs` → 全 PASS、`node --test sugoroku/test/*.mjs` → 41 PASS
- [ ] **Step 4: コミット** — `chinchiro: README とスタイルの仕上げ`
- [ ] **Step 5: 最後のチェック(会話内で決めた進め方)** — 別の担当(サブエージェント)にブランチ全体のレビューを頼み、指摘を直してから PR → マージ → Pages のビルド成功を確認(`actions_list` で `pages build and deployment` の最新 run が success)
