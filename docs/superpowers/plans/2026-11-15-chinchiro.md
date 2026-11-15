# リスナー対決チンチロ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 配信者(親)とリスナー(子)が、それぞれの端末からリアルタイムに同期してチンチロで対決できる Web ページを `chinchiro/` に作る。

**Architecture:** ゲームの真実は親機のブラウザが決め、Firebase Realtime Database の `rooms/{CODE}` に書く。リスナーは自分の `players/queue/actions` だけ書き、親機がそれを処理する。純粋ロジック(役判定・状態遷移)、同期アダプタ(mock / firebase)、サイコロ演出、表示層をファイルで分け、ビルドなしで GitHub Pages から配信する。

**Tech Stack:** 素の HTML/CSS/JS(ES2022)、Firebase JS SDK v11(モジュール版を gstatic の CDN から動的 import)、Web Animations API、WebAudio、Playwright(画面テスト)、`node --test`(ロジック)。

**Spec:** `docs/superpowers/specs/2026-11-15-chinchiro-design.md`

## Global Constraints

- 置き場は `chinchiro/`。ビルド工程なし。GitHub Pages(`https://suesugi60.github.io/stock-analyzer/chinchiro/`)でそのまま動く。
- 見た目は `sugoroku/index.html` と同じトーン(空色 `#4fb8ff`、紺 `#2b2d5c`、クリーム `#fff8e7`、黄 `#ffd93d`、丸ゴシック、太い縁取り、ずらし影)。キャラ12体の絵は `sugoroku/index.html` の `SugorokuArt` ブロックを**そのまま複製**する。
- 出目はリスナーの端末では決めない。`state` を書けるのは親機(`hostUid`)だけ。
- この開発環境からは Firebase に接続できない。すべてのテストは `?mock=1`(モック同期)で行う。Firebase 本番は利用者の環境で確認する。
- 役と倍率、支払い倍率、3投制限、引き分け再戦、ションベン 3% は設計書の「ルール」の値をそのまま使う。
- 無料枠の安全装置: 観戦者(列に並んでいない `?room=` 閲覧者)が 80 人を超えたら「満員です。配信画面で見てね」を出して接続しない。
- 文言は日本語。名前は 12 文字以内、HTML はエスケープして表示する。
- 設計書の「制約」にある「単一の index.html」は、保守のため複数ファイル(下記)に分ける。設計書にその旨を追記する(Task 9)。

## Review Focus

1. **「振る」の二度押し・連打**: リスナーが連打しても1投だけ処理される(Task 7 のテスト `連打しても1投だけ`)。
2. **手番でない人の「振る」要求**: 無視して削除される。親機の状態は変わらない(Task 7 のテスト `手番でない人の要求は捨てる`)。
3. **親機の再読み込み**: 対戦の途中で親機を再読み込みしても同じ部屋・同じ状態に戻り、続きができる(Task 8 のテスト `親機が再読み込みしても続きから`)。
4. **名前に HTML 記号**: `<b>x</b>` のような名前がそのまま文字として出る(Task 6 のテスト `名前の HTML はエスケープ`)。
5. **壊れたデータ**: `state.lastThrow.throw.dice` が不正(範囲外・欠損)でも画面が固まらず、演出を飛ばして次に進める(Task 4 のテスト `不正な出目でも落ちない`)。

---

## ファイル構成

```
chinchiro/
  index.html                 マークアップ。style.css と各 JS を読む。role に応じて画面を切替
  style.css                  見た目(sugoroku と同じトーン)+ 器・サイコロ・演出の CSS
  logic.js                   純粋ロジック。globalThis.ChinchiroLogic。CJS でも export
  art.js                     SugorokuArt の複製(キャラ12体・アイコン)
  sync.js                    同期アダプタ createBackend(): mock / firebase
  anim.js                    サイコロ演出 createDiceStage() と音 createSounds()
  app.js                     表示層。役割判定、親機ループ、リスナー画面、表示専用画面
  firebase-config.js         利用者の設定(初期値は空の雛形)
  firebase-config.example.js 雛形
  README.md                  遊び方と Firebase の準備手順
  test/
    helpers.mjs              ロジック読込、固定シード乱数、ローカル HTTP サーバー起動
    logic.test.mjs           役判定・判定・支払い・状態遷移
    sync.test.mjs            mock 同期(Node の BroadcastChannel で2端末を模す)
    e2e.test.mjs             Playwright(mock 同期、親機+リスナーの2ページ)
```

`logic.js` の末尾は次の形で、ブラウザでは `globalThis.ChinchiroLogic`、Node では `require` で読める:

```js
const ChinchiroLogic = (() => { /* ... */ return { ... }; })();
if (typeof module !== 'undefined') module.exports = ChinchiroLogic;
```

`sync.js`・`anim.js` も同様に `globalThis.ChinchiroSync` / `globalThis.ChinchiroAnim` を置き、`sync.js` は CJS export もする(Node でテストするため)。

---

### Task 1: 役の判定・勝敗・支払い(logic.js)

**Files:**
- Create: `chinchiro/logic.js`
- Create: `chinchiro/test/helpers.mjs`
- Create: `chinchiro/test/logic.test.mjs`

**Interfaces:**
- Produces(後のタスクが使う):
  - `evaluate(dice: number[3]) → Hand | null`(役なしは `null`)
  - `Hand = { type: 'pinzoro'|'zoro'|'shigoro'|'me'|'hifumi'|'shonben'|'none', value: number, mult: number, label: string, lose: boolean, rank: number }`
  - `SHONBEN: Hand`、`NONE: Hand`(定数)
  - `penaltyMult(hand) → 2 | 1`(ヒフミだけ 2)
  - `judge(parentHand: Hand, childHand: Hand|null) → { winner: 'parent'|'child'|'draw', mult: number }`
  - `resultDeltas(result, settings) → { parent: Delta, child: Delta }`、`Delta = { points, drinks, wins, losses }`(飲みは「口数などの個数」= `mult`。単位の文言は `DRINK_UNITS[settings.drinkUnit].label`)
  - `DRINK_UNITS = { sip: {label:'1口'}, half: {label:'半分'}, glass: {label:'1杯'} }`、`POINT_UNITS = [10, 20, 50]`
  - `rollDice(rng) → { dice: number[3], seed: number, shonben: boolean }`(`rng()` は [0,1)。ションベンは `rng() < 0.03`。`seed` は `Math.floor(rng() * 2**31)`)

- [ ] **Step 1: ヘルパーを書く**

`chinchiro/test/helpers.mjs`: `loadLogic()`(`createRequire` で `../logic.js` を require)、`seeded(seed)`(mulberry32。`sugoroku/test/helpers.mjs` と同じ実装)。

- [ ] **Step 2: 役判定の失敗するテストを書く**

```js
test('役判定: 全パターン', () => {
  const L = loadLogic();
  assert.deepEqual(pick(L.evaluate([1,1,1])), { type:'pinzoro', value:1, mult:5, lose:false, label:'ピンゾロ' });
  assert.deepEqual(pick(L.evaluate([5,5,5])), { type:'zoro', value:5, mult:3, lose:false, label:'5ゾロ' });
  assert.deepEqual(pick(L.evaluate([6,4,5])), { type:'shigoro', value:0, mult:2, lose:false, label:'シゴロ' });
  assert.deepEqual(pick(L.evaluate([3,1,2])), { type:'hifumi', value:0, mult:1, lose:true, label:'ヒフミ' });
  assert.deepEqual(pick(L.evaluate([2,6,2])), { type:'me', value:6, mult:1, lose:false, label:'6の目' });
  assert.deepEqual(pick(L.evaluate([4,4,1])), { type:'me', value:1, mult:1, lose:false, label:'1の目' });
  assert.equal(L.evaluate([1,3,5]), null);
  assert.equal(L.evaluate([2,4,6]), null);
  assert.throws(() => L.evaluate([0,1,2]));
  assert.throws(() => L.evaluate([1,2]));
});
test('役の強さ: ピンゾロ > 6ゾロ > 2ゾロ > シゴロ > 6の目 > 1の目', () => { /* rank の大小を assert */ });
test('judge: 同じ役は引き分け、親の負け役は子の不戦勝、倍率は勝者の倍率と敗者の罰倍率の大きい方', () => {
  // 親ゾロ目(3) vs 子目なし → parent, mult 3
  // 親目5 vs 子ヒフミ → parent, mult 2
  // 子ピンゾロ vs 親目3 → child, mult 5
  // 親ヒフミ, 子 null → child, mult 2 / 親ションベン, 子 null → child, mult 1 / 親目なし → child, mult 1
  // 親目5 vs 子目5 → draw / 親シゴロ vs 子シゴロ → draw
});
test('resultDeltas: 点数は単位×倍率を移し、飲みは倍率ぶんの個数', () => {
  // settings {mode:'both', unit:10, drinkUnit:'sip'}, result {winner:'child', mult:3}
  // → parent {points:-30, drinks:3, wins:0, losses:1}, child {points:+30, drinks:0, wins:1, losses:0}
  // mode 'points' なら drinks 0、mode 'drink' なら points 0、draw なら全部 0
});
test('rollDice: 1〜6 が3つ、seed は整数、ションベンは rng<0.03 のとき', () => { /* seeded で決定的に */ });
```

- [ ] **Step 3: 失敗を確認** — Run: `node --test chinchiro/test/logic.test.mjs` → `Cannot find module` で失敗。

- [ ] **Step 4: `chinchiro/logic.js` に上記 Interfaces の関数を実装**

`rank`: ピンゾロ 1000、ゾロ目 900+n、シゴロ 800、目 100+x、目なし 0、ションベン -1、ヒフミ -2。`judge` は `lose` を先に見てから `rank` 比較。

- [ ] **Step 5: 合格を確認** — Run: `node --test chinchiro/test/logic.test.mjs` → pass。

- [ ] **Step 6: Commit** — `git add chinchiro && git commit -m "チンチロ: 役の判定・勝敗・支払いのロジック"`

---

### Task 2: 部屋の状態遷移(logic.js の reducer)

**Files:**
- Modify: `chinchiro/logic.js`
- Modify: `chinchiro/test/logic.test.mjs`

**Interfaces:**
- Produces:
  - `createState() → State`(`{ seq:0, phase:'lobby', match:null, result:null, host:{points:100,wins:0,losses:0,drinks:0}, lastThrow:null }`)
  - `startMatch(state, childUid) → State`(phase `'parent'`、`match = { childUid, round:1, parent:{throws:[],hand:null,done:false}, child:{throws:[],hand:null,done:false} }`)
  - `applyThrow(state, by: 'parent'|'child', roll: {dice,seed,shonben}, settings) → { state, result: Result|null }`
    - 投げた側の `throws` に `Throw = { ...roll, hand, at }` を追加。`hand` は `shonben ? SHONBEN : evaluate(dice)`、3投目で役なしなら `NONE`。役が決まれば `done=true`。
    - 親が `done` かつ負け役 → `result`(子は振らない)。親が `done` で勝ち役 → phase `'child'`。
    - 子が `done` → `judge`。`draw` なら `round+1`、両者の throws を空にして phase `'parent'`。それ以外は phase `'result'`、`state.result = Result`、`state.host` に `resultDeltas` の `parent` を加算。
    - `lastThrow = { by, seq: state.seq+1, throw }`、`seq` を +1。
    - `Result = { winner, mult, parentHand, childHand, deltas: { parent: Delta, child: Delta }, childUid }`
  - `nextMatch(state) → State`(phase `'lobby'`、`match=null`、`result=null`)
  - `canThrow(state, by) → boolean`(phase と `done` から)
  - 状態は変更せず新しいオブジェクトを返す(`structuredClone`)。

- [ ] **Step 1: 失敗するテストを書く**

```js
test('startMatch → 親の番', ...);
test('親が1投目で役 → 子の番。親が3投役なし → 目なしで子の不戦勝(result)', ...);
test('親ヒフミは1投で終了して子の不戦勝、倍率2', ...);
test('子が役を作ると判定。引き分けなら round+1 で親の番に戻り throws が空', ...);
test('結果で host の points/wins/losses/drinks が動く(settings both/unit 10/sip)', ...);
test('canThrow: 親の番は parent だけ、子の番は child だけ、result では誰も振れない', ...);
test('applyThrow は元の state を変えず、seq が1ずつ増える', ...);
test('nextMatch で lobby に戻り match/result が null', ...);
```

- [ ] **Step 2: 失敗を確認** — `node --test chinchiro/test/logic.test.mjs`。

- [ ] **Step 3: 実装** — 上記 Interfaces どおり `logic.js` に追加し export。

- [ ] **Step 4: 合格を確認** — 同コマンドで全件 pass。

- [ ] **Step 5: Commit** — `git commit -m "チンチロ: 対戦の状態遷移"`

---

### Task 3: 同期アダプタ(sync.js: mock と firebase)

**Files:**
- Create: `chinchiro/sync.js`
- Create: `chinchiro/test/sync.test.mjs`
- Create: `chinchiro/firebase-config.example.js`、`chinchiro/firebase-config.js`(雛形: `window.FIREBASE_CONFIG = null;`)

**Interfaces:**
- Produces:
  - `createBackend(opts) → Promise<Backend>`。`opts = { kind:'mock'|'firebase', config?, storage?, channel?, uid? }`
    - mock: `storage` は `getItem/setItem` を持つもの(既定 `localStorage`)、`channel` は `postMessage/onmessage` を持つもの(既定 `new BroadcastChannel('chinchiro-mock')`)。uid は `opts.uid` → `sessionStorage['chinchiro.uid']` → 新規(`'u_' + 乱数`)。
    - firebase: `config` が無ければ `throw new Error('FIREBASE_CONFIG がありません')`。`import()` で `firebase-app.js`/`firebase-auth.js`/`firebase-database.js`(v11、`https://www.gstatic.com/firebasejs/11.0.0/`)を読み、`signInAnonymously` 後に解決。
  - `Backend = { uid, get(path) → Promise<any>, set(path, v), update(path, obj), remove(path), watch(path, cb(value)) → unsubscribe, onDisconnectRemove(path), onDisconnectSet(path, v), now() → number }`
    - `path` は `'rooms/AB7K/state'` のようなスラッシュ区切り。`update` は1階層のマージ(Firebase の `update` と同じ。キーに `/` を含めれば深い更新)。
    - mock の `watch` は登録直後に現在値で1回呼び、以後 `storage` の変更を `channel` 経由で受けたら再読込して値が変わったときだけ呼ぶ。`onDisconnect*` は `pagehide` で実行(Node では no-op)。
  - `roomCode(rng) → string`(4文字、`ABCDEFGHJKMNPQRSTUVWXYZ23456789` から)

- [ ] **Step 1: 失敗するテストを書く(Node の `BroadcastChannel` で2端末を模す)**

```js
test('mock: set した値を別の端末の watch が受け取る', async () => {
  const ch = 'chinchiro-test-' + Date.now();
  const store = new Map(); const storage = { getItem:k=>store.get(k)??null, setItem:(k,v)=>store.set(k,v) };
  const a = await createBackend({ kind:'mock', storage, channel:new BroadcastChannel(ch), uid:'host' });
  const b = await createBackend({ kind:'mock', storage, channel:new BroadcastChannel(ch), uid:'kid' });
  const seen = []; b.watch('rooms/T1/state', v => seen.push(v));
  await a.set('rooms/T1/state', { phase:'lobby' });
  await a.update('rooms/T1/state', { phase:'parent', 'match/round': 1 });
  await waitFor(() => seen.length >= 3);
  assert.deepEqual(seen, [null, { phase:'lobby' }, { phase:'parent', match:{ round:1 } }]);
  assert.equal(await b.get('rooms/T1/state/phase'), 'parent');
  await a.remove('rooms/T1/state'); assert.equal(await b.get('rooms/T1/state'), null);
});
test('mock: 同じ値を set しても watch は呼ばれない', ...);
test('roomCode: 4文字で紛らわしい文字(0,O,1,I,L)を含まない', ...);
test('firebase: config が無ければ分かるエラー', async () => { await assert.rejects(createBackend({kind:'firebase'}), /FIREBASE_CONFIG/); });
```

- [ ] **Step 2: 失敗を確認** — `node --test chinchiro/test/sync.test.mjs`。

- [ ] **Step 3: `sync.js` を実装**(mock は JSON ツリーを `storage['chinchiro.mock.db']` に保持。firebase は `ref(db, path)` に `set/update/remove/onValue/onDisconnect` をそのまま対応付け)

- [ ] **Step 4: 合格を確認**。

- [ ] **Step 5: Commit** — `git commit -m "チンチロ: 同期アダプタ(mock / firebase)"`

---

### Task 4: 絵・器・サイコロの演出(art.js, anim.js, style.css, index.html の演出部分)

**Files:**
- Create: `chinchiro/art.js`(`sugoroku/index.html` の `SugorokuArt` ブロックを複製。`ICON_ART` は不要なら削ってよい)
- Create: `chinchiro/anim.js`
- Create: `chinchiro/style.css`、`chinchiro/index.html`(この時点では `?demo=1` の演出デモだけ動く)
- Create: `chinchiro/test/e2e.test.mjs`(ローカル HTTP サーバー起動のヘルパーは `test/helpers.mjs` に `serve(dir) → { url, close }`)

**Interfaces:**
- Produces:
  - `createSounds() → { clack(vol), rattle(ms), chime(kind:'gold'|'rainbow'|'blue'), thud(), thunder(), roll(), setMuted(b), muted }`(WebAudio で合成。`AudioContext` が無ければ全部 no-op)
  - `createDiceStage(root: HTMLElement, sounds) → Stage`
  - `Stage.play(throwObj: {dice, seed, shonben, hand}, opts: {thrower: {name, char, color}, remaining: number, reduced?: boolean}) → Promise<void>`(構え→投げ込み→跳ねる→止まる→役の演出、まで。演出中にタップで `skip()`)
  - `Stage.skip()`、`Stage.reset()`
  - 演出の乱数は `mulberry32(throwObj.seed)` だけを使う(全端末で同じ映像)。
  - 役の演出の文言: ピンゾロ `ピンゾロ!!`、ゾロ目 `${n}ゾロ!`、シゴロ `シゴロ!`、目 `${x}の目`、目なし `目なし… あと${remaining}投`(remaining 0 なら `目なし…`)、ヒフミ `ヒフミ…`、ションベン `ションベン!`。
  - `#stage .result-stamp` にその文言、`data-hand` にその type。
  - `index.html?demo=1&dice=4,5,6&seed=7` でデモ再生(開発・テスト・スクリーンショット用)。

- [ ] **Step 1: 失敗する画面テストを書く**

```js
test('デモ: 4,5,6 を投げると3つの立体サイコロが出てシゴロの演出になる', async () => {
  await page.goto(`${url}/index.html?demo=1&dice=4,5,6&seed=7`);
  await page.locator('#stage .cube').nth(2).waitFor({ state:'visible' });
  assert.equal(await page.locator('#stage .cube').count(), 3);
  await page.locator('#stage .result-stamp[data-hand="shigoro"]').waitFor({ timeout: 8000 });
  assert.equal(await page.locator('#stage .result-stamp').innerText(), 'シゴロ!');
  // 止まった面が 4,5,6 (data-face)
});
test('デモ: ションベンは1つ器の外へ出て「ションベン!」', ...);
test('デモ: タップで演出を飛ばせる(2秒以内に結果)', ...);
test('不正な出目でも落ちない: dice=9,0,x → 演出を飛ばして「?」を表示、ページエラーなし', ...);
```

- [ ] **Step 2: 失敗を確認** — `node --test chinchiro/test/e2e.test.mjs`。

- [ ] **Step 3: 実装**(設計書「サイコロの演出(こだわり)」の 1〜5 を順に。立方体は `sugoroku/index.html` の `.cube` CSS と `FINAL_ROT` を流用し、3個に拡張。器は `sugoroku` の `.bowl-back/.bowl-front` を拡張して横長に。着地位置は seed から器の内側の楕円上に3点、互いに 70px 以上離す。最後の1個のスローモーションは `Animation.playbackRate = 0.4`。)

- [ ] **Step 4: 合格を確認**、スクリーンショット(`/tmp/.../scratchpad/shots/`)で目視。

- [ ] **Step 5: Commit** — `git commit -m "チンチロ: 器とサイコロの演出"`

---

### Task 5: 親機の画面(入口・ロビー・QR・表示専用)

**Files:**
- Create: `chinchiro/app.js`
- Modify: `chinchiro/index.html`、`chinchiro/style.css`
- Modify: `chinchiro/test/e2e.test.mjs`

**Interfaces:**
- Consumes: `ChinchiroLogic.createState/roomCode`、`ChinchiroSync.createBackend`、`SugorokuArt.CHAR_ART`
- Produces(画面の id。後のテストが使う):
  - 役割判定: `?room=CODE` 無し → 親機入口 `#screen-host-entry`。`?room=CODE` → リスナー。`&stage=1` → 表示専用 `#screen-stage`。`?mock=1` で mock 同期。
  - 親機入口: `#host-name`、`.player-avatar`(キャラ選択は sugoroku と同じ選択画面 `#screen-pick`)、`[data-mode="points|drink|both"]`、`[data-unit="10|20|50"]`、`[data-drink="sip|half|glass"]`、`#create-room`、`#resume-room`(localStorage に前回の部屋があるとき)
  - 親機本体 `#screen-host`: `#room-code`、`#join-url`、`#qr`(描けなければ `hidden`)、`#queue`(`.queue-row[data-uid]` に `.skip/.hide/.ban` ボタン)、`#start-match`、`#host-roll`、`#roll-for-child`、`#next-match`、`#rematch`、`#host-record`、`#ranking`、`#mute`、`#close-room`
  - 表示専用 `#screen-stage`: 親機本体と同じ構成でボタン無し。
  - 部屋データ: `rooms/{CODE}` に `hostUid, createdAt, settings, state=createState()` を書く。`localStorage['chinchiro.host'] = { code, uid }`。

- [ ] **Step 1: 失敗するテストを書く**

```js
test('親機: 名前とモードを選んで部屋を作ると、4文字のコードと参加URLが出る', ...);  // #room-code が /^[A-Z2-9]{4}$/、#join-url が ?room=CODE を含む
test('表示専用: ?room=CODE&stage=1 を開くと同じ部屋の状態が見え、ボタンが無い', ...);
test('親機: 再読み込みすると「前回の部屋を続ける」で同じコードに戻る', ...);
```

- [ ] **Step 2: 失敗を確認**。
- [ ] **Step 3: 実装**(QR は `https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js` を `<script defer>` で読み、`window.QRCode` が無ければ `#qr` を `hidden`)。
- [ ] **Step 4: 合格を確認**、親機画面のスクリーンショット(1280×720)を目視。
- [ ] **Step 5: Commit** — `git commit -m "チンチロ: 親機の入口とロビー、表示専用画面"`

---

### Task 6: リスナーの参加と順番待ち

**Files:**
- Modify: `chinchiro/app.js`、`chinchiro/index.html`、`chinchiro/style.css`、`chinchiro/test/e2e.test.mjs`

**Interfaces:**
- Produces:
  - リスナー参加 `#screen-join`: `#join-name`、`.player-avatar`(選択画面)、`#join-challenge`、`#join-watch`
  - リスナー本体 `#screen-listener`: `#my-status`(「あなたは N 番目」「あなたの番!」「見るだけ」)、`#my-record`、`#listener-roll`(手番のときだけ表示)、`#requeue`、`#leave`
  - 書き込み: `players/{uid} = { name, char, joinedAt, online:true }`(`points` などは書かない)、`queue/{uid} = { joinedAt }`、`presence/{uid} = true`。`onDisconnect` で `online=false` と `presence` 削除。
  - 親機の `#queue` は `queue` を `joinedAt` 順に並べ、`players` の名前・キャラ・点数・`online` を表示。`hidden` の人は名前を `？？？`、`banned` の人は列に出さない。
  - 満員: `presence` の数が 80 以上で自分が `queue` にいない閲覧者は `#screen-full` を表示し `presence` を書かない。

- [ ] **Step 1: 失敗するテストを書く**(親機ページ + リスナーページの2ページ。`context.newPage()` を2つ。mock 同期は同一 context 内で共有される)

```js
test('リスナー: 名前とキャラを入れて挑戦すると、親機の順番待ちに出る', ...);
test('名前の HTML はエスケープ: <b>x</b> が文字のまま出る', ...);
test('親機の「ブロック」で列から消え、本人は「参加できません」になる。「非表示」で名前が？？？になる', ...);
test('満員: presence が 80 ある部屋を見るだけで開くと満員表示', ...);  // mock の storage に presence を80件 set しておく
```

- [ ] **Step 2〜5**: 失敗確認 → 実装 → 合格確認 → `git commit -m "チンチロ: リスナーの参加・順番待ち・荒らし対策・満員"`

---

### Task 7: 対戦の流れ(親が振る → 子が振る → 結果 → 次へ)

**Files:**
- Modify: `chinchiro/app.js`、`chinchiro/index.html`、`chinchiro/style.css`、`chinchiro/test/e2e.test.mjs`

**Interfaces:**
- Consumes: `applyThrow/startMatch/nextMatch/canThrow/rollDice/resultDeltas`、`Stage.play`
- Produces:
  - 親機ループ: `#start-match` → `startMatch(state, 先頭uid)` を書き、`queue/{uid}` を消す。`#host-roll` → `rollDice` → `applyThrow(state,'parent',...)` を書く。`watch('rooms/CODE/actions')` で手番の子の `{type:'roll'}` を受けたら `applyThrow(state,'child',...)` を書き `actions/{uid}` を消す(手番でない人の要求は消すだけ)。`result` が出たら `players/{childUid}` に `deltas.child` を加算して書く(points の初期値は 100 とみなす)。`#next-match` → `nextMatch`。`#rematch` → 同じ子で `startMatch`。
  - 子の端末: `#listener-roll` は `canThrow(state,'child')` かつ自分が `match.childUid` のときだけ出す。押したら `actions/{uid} = { type:'roll', at }` を書き、`lastThrow` が来るまでボタンを無効化(連打防止)。
  - 演出: 全端末が `state.lastThrow.seq` の増加を見て `Stage.play(lastThrow.throw, …)` を1回だけ再生(再生済み seq を覚える)。再生中に次の seq が来たらスキップして最新を再生。
  - 結果画面 `#result`: 勝者・役・`×mult`・点数の増減・飲む量(`${name}さん: ${unit} × ${mult} = …`)・紙吹雪。

- [ ] **Step 1: 失敗するテストを書く**

```js
test('対戦: 親が振り、子が振ると両画面に同じ出目と結果が出て点数が動く', async () => {
  // 親機で部屋作成、リスナー参加、#start-match
  // 親機: #host-roll を押す(演出はタップで飛ばす)。親の役が決まるまで繰り返す(最大3回)
  // 親が負け役なら結果へ。そうでなければリスナー画面に #listener-roll が出る → 押す → 役が決まるまで最大3回
  // 両画面の #result .winner / .mult が同じ。points モードで host/record と players の点数の差が unit×mult
});
test('連打しても1投だけ: #listener-roll を5回連続クリックしても throws が1つ増えるだけ', ...);
test('手番でない人の要求は捨てる: 列の2人目が actions に roll を書いても state.seq が変わらず actions が消える', ...);
test('引き分けなら「もう一度!」と出て親の番に戻る', ...);  // mock の Math.random を固定して同じ目にする(page.evaluate で上書き)
test('次の挑戦者で列の次の人と対戦', ...);
```

- [ ] **Step 2〜5**: 失敗確認 → 実装 → 合格確認(親機・リスナー両方のスクリーンショットも) → `git commit -m "チンチロ: 対戦の流れ"`

---

### Task 8: 代わりに振る・復帰・ランキング・飲みモードの表示

**Files:**
- Modify: `chinchiro/app.js`、`chinchiro/index.html`、`chinchiro/style.css`、`chinchiro/test/e2e.test.mjs`

**Interfaces:**
- Produces:
  - `#roll-for-child`: 子の番になって 20 秒(定数 `PROXY_ROLL_MS = 20000`。テストでは `?proxy=1000` で短縮)たつと親機に出る。押すと親機が子の投げとして `applyThrow(state,'child',…)`。
  - 親機の再読み込み: `localStorage['chinchiro.host']` と `backend.uid === hostUid` なら `#screen-host` に直接戻り、`state` を購読して続きから。
  - リスナーの再読み込み: `players/{uid}` が既にあれば `#screen-listener` に直接戻る。
  - `#ranking`: points モード時、`players` を点数の高い順に 10 人 + 配信者。`hidden` は除外。
  - 飲みモード: 結果に `飲む: ${label} × ${mult}`、`#host-record` と `#my-record` に飲んだ累計。
  - `#close-room`: `state.phase='closed'`。リスナーには「終了しました」。

- [ ] **Step 1: 失敗するテストを書く**

```js
test('代わりに振る: 子が反応しないと親機にボタンが出て、押すと子の投げとして進む', ...);  // ?proxy=500
test('親機が再読み込みしても続きから: 子の番の途中で reload → 同じ部屋・同じ phase', ...);
test('リスナーが再読み込みしても自分の画面に戻る', ...);
test('ランキング: 点数順に並び、非表示の人は出ない', ...);
test('飲みモード: 結果に「1口 × 3」と出て累計が増える', ...);
test('部屋を閉じるとリスナーに「終了しました」', ...);
```

- [ ] **Step 2〜5**: 失敗確認 → 実装 → 合格確認 → `git commit -m "チンチロ: 代わりに振る・復帰・ランキング・飲みモード"`

---

### Task 9: Firebase 本番の配線・README・設計書の追記

**Files:**
- Modify: `chinchiro/app.js`(`?mock=1` でなければ `createBackend({kind:'firebase', config: window.FIREBASE_CONFIG})`。`config` が無い/失敗なら `#screen-setup-needed` に README の手順への案内)
- Create: `chinchiro/README.md`
- Modify: `docs/superpowers/specs/2026-11-15-chinchiro-design.md`(「制約」の単一ファイル記述をファイル構成に合わせて修正)
- Modify: `sugoroku/README.md` は変更なし。`chinchiro/README.md` に `publish_public.sh` の注意(元フォルダへ `chinchiro/` もコピー)を書く。

- [ ] **Step 1: 失敗するテストを書く**

```js
test('設定が無いまま本番モードで開くと、Firebase の準備手順への案内が出てページエラーにならない', async () => {
  await page.goto(`${url}/index.html`);  // mock 無し、FIREBASE_CONFIG = null
  await page.locator('#screen-setup-needed').waitFor({ state:'visible' });
  assert.deepEqual(errors, []);
});
```

- [ ] **Step 2: 失敗を確認**。
- [ ] **Step 3: 実装 + README**(README: 遊び方、親機/リスナー/表示専用のURL、ルール表、Firebase の準備手順1〜6と**セキュリティルールの全文**、無料枠の注意、`publish_public.sh` の注意)。
- [ ] **Step 4: 合格を確認**。全テスト: `node --test chinchiro/test/logic.test.mjs chinchiro/test/sync.test.mjs && node --test chinchiro/test/e2e.test.mjs`。`sugoroku` のテストも壊れていないこと。
- [ ] **Step 5: Commit & push** — `git commit -m "チンチロ: Firebase の配線と README"` → `git push -u origin claude/upbeat-wright-eub76a`

---

## 完了後

- 利用者に mock 版のスクリーンショットと、Firebase の準備手順(README)を案内する。設定値(`firebaseConfig`)をもらったら `chinchiro/firebase-config.js` に書いて反映(PR → マージ → Pages)。
- 本番で親機とリスナー(別端末)の疎通を利用者に確認してもらう。
