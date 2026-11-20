# チンチロ対決(リスナー参加型)

配信者(親)とリスナー(子)が、それぞれの端末からリアルタイムにつながってチンチロで対決するアプリ。
リスナーは自分のスマホで「振る」を押し、器にサイコロが飛び込む演出が全員の画面で同時に流れます。

公開URL(main に反映後): `https://suesugi60.github.io/stock-analyzer/chinchiro/`

> 飲めない人はソフトドリンクでOK。無理な飲酒は絶対にしないこと。

## 使い方

### 配信者(親機)

1. 上のURLを開き、名前・キャラ・「勝ち負けで動くもの」(点数 / 飲み / 両方)・持ち点(50 / 100 / 300 / 1000 / 自由)・単位を選んで「部屋を作る」。
2. 画面に **部屋コード(4文字)** と参加URL・QRコードが出るので、配信に映す。
3. リスナーが参加すると右の「順番待ち」に並ぶ。「対決スタート」で先頭の人と対決(両者のキャラが左右から登場して VS が叩き込まれる登場シーンが全員の画面に流れる。タップで飛ばせる)。
4. 親(あなた)が先に「🎲 振る」(3投以内。3投で役が出なければ「目なし」)。次にリスナーが自分のスマホで振る。
5. 結果が出たら「次の挑戦者」。同じ人と続けるなら「同じ人ともう一回」。
6. 順番待ちの各行で「飛ばす」「非表示(名前を？？？にする)」「ブロック(以後参加させない)」ができる。
7. リスナーが20秒反応しないと「代わりに振る」が出る。結果が出ると紙吹雪が舞い、点数は動いて見える。
8. 再読み込みしても同じ部屋に戻る。やめるときは「部屋を閉じる」。「点数リセット」で全員の点数を持ち点に戻し、勝敗と飲んだ数も 0 にできる(対戦中は押せない。対戦の記録は残る)。
9. 「📖 ルール」で役の強さ・倍率・この部屋の設定で動く点数と飲みの量が見られる(スマホにも同じボタン)。アリーナの下には役の順位が常に1行出る。
10. 対戦中はアリーナに親と子の 1〜3 投目の出目が並び、右の「対戦の記録」に直近 30 戦(相手・出目・役・勝敗・点の増減)が残る。スマホにも同じ記録が出て、自分の行は黄色になる。
11. **戦歴(誰と何勝何敗か)**: 対戦中はアリーナの真ん中に、その相手とのこれまでの成績(「これまで 配信者 の 2勝1敗」。初めてなら「はじめての対戦」)が出る。右の「戦歴」には、対戦した相手ごとに配信者から見た勝ち負けが、対戦の多い順に並ぶ(いまの相手は黄色)。非表示にした人は ？？？、ブロックした人は出ない。「点数リセット」で 0 に戻る。

配信に映す方法は2つ: 親機のブラウザ画面をそのまま映す。または OBS の「ブラウザソース」で
`...?room=コード&stage=1`(操作ボタンなしの表示専用)を開く。

### リスナー(スマホ)

1. QRかURLを開き、名前とキャラを決めて「挑戦する」(「見るだけ」も可)。
2. 「あなたは N 番目」と出る。自分の番になると画面が光り、「🎲 振る」が出る。
3. 振ると、親機の返事が来るまで手の中でサイコロを振る演出が出て(その間「カラカラ」と鳴り続ける)、そのあと全員の画面に同じ演出が流れる。
   配信者の画面が開いていないと「配信者の画面を待っています」と出る。もう一度やるなら「もう一回並ぶ」。

### リーチ演出(パチンコ風)

先に止まった 2 個で役の形が見えると、最後の 1 個が空中で止まり、画面がその 1 個にドアップで寄って「リーチ!」(強いほど大きく寄り、スーパー以上はスピードラインと画面の揺れが付く)。形は 4 つ:
同じ目が 2 つ = ゾロ目リーチ(1 が 2 つなら「ピンゾロリーチ」)、4・5・6 のうち 2 つ = シゴロリーチ、1・2・3 のうち 2 つ = ピンチ(ヒフミの危機)。

カットインには「ピンゾロリーチ!」のように狙える役と、「あと ⚀ が出れば ピンゾロ ×5」のように何が出ればよいかを出すので、ルールを知らない人にもわかる。
強さはノーマル / スーパー / 激アツ の 3 段階(ピンチは「ピンチ…」「大ピンチ!!」)。溜めはノーマル 1.4 秒・スーパー 2.4 秒・激アツ 5.5 秒で、狙える役が強いほど長い(ピンゾロ 1.5 倍、ゾロ目 1.25 倍。激アツのピンゾロリーチは約 8 秒)。パチンコの信頼度と同じで、
**強い役が出るときほど強い演出になりやすいが、確定ではない**(激アツでも外れる「ガセ」がある)。目安: 激アツが出るのは 20 投に 1 回くらい、激アツのときに強い役(ピンゾロ・ゾロ目・シゴロ)になるのはおよそ 6 割。
止まる順番は形が見える順と見えない順を混ぜているので、順番から結果は読めない。タップすればいつでも飛ばせる。

### 演出の順番(相手の番にならない)

全員の画面で同じ演出が流れるので、親機が自分の画面の演出を見終わるまで、リスナーの「振る」は出ない(「配信者の画面の演出中…」と出る)。リスナーの要求が先に届いても、親機は自分の演出が終わってから処理する。親機が落ちて演出の終わりが届かないときは 15 秒で振れるようになる。
スマホの「動きを減らす」(iPhone の視差効果を減らす)設定が入っていても、サイコロの演出は省略しない。
勝負が決まる投げ(決着・引き分け)も、振る → 投げ込み → 止まるまでの演出と音を最後まで流してから、結果シーンに移る。

### 音が出ないとき

- 鳴らせない間は画面の下に「🔇 タップで音をオン」が出る。どこかをタップすれば鳴る(ブラウザは一度触るまで音を出さない)。
- iPhone の消音スイッチ(マナーモード)が入っていても、親機と自分の対戦中のスマホは鳴るようにしてある(無音の音声を裏で流して「動画と同じ扱い」にする仕組み。その間は聴いていた音楽が止まる)。見ているだけの人のスマホでは止めないので、消音スイッチを切ってもらう。
- 電話などで音が途切れたら、画面に戻ったときと次のタップで自動的に再開する。
- 親機の「📖 ルール」の左のボタンが赤い「🔇 消音中」になっていたら、押して 🔊 に戻す(戻すと確認の音が鳴る。鳴らなければ、ブラウザのタブの「サイトをミュート」やパソコンの音量を確認)。消音は覚えないので、ページを開き直せば必ず音が出る状態で始まる。表示専用(`stage=1`)は二重に鳴らないよう常に無音。

### 演出の確認

`...?demo=1&intro=1` で対決スタートの登場シーン、`...?demo=1&dice=4,5,6&seed=7` で任意の出目の演出だけ見られる(`&shonben=1` でションベン、`&reach=3` でリーチの強さを 0〜3 に固定。例: `?demo=1&dice=1,1,1&reach=3` で激アツからピンゾロ)。
`...?mock=1` を付けると、Firebase なしで同じブラウザ内(別タブ)だけで同期して試せる(お試し専用。他の端末とはつながらない)。

## 役名のコール(声)

サイコロが止まると役名を声でコールします。

- 何も置かなければ端末の読み上げ機能を使い、入っている日本語の声からいちばん自然なものを自動で選びます(iPhone は設定 → アクセシビリティ → 読み上げコンテンツ → 声 → 日本語 で「拡張」や「プレミアム」の声をダウンロードすると一段と自然になります。Windows の Edge では「Nanami (Natural)」が選ばれます)。
- `voice/` フォルダに `pinzoro.mp3` や `me5.m4a` のような名前で音声ファイルを置くと、そちらを優先して再生します。自分の声で録れば配信者の声でコールされます。ファイル名の一覧と録り方は [voice/README.md](voice/README.md) を見てください。

## ルール

| 役 | 出目 | 倍率 |
|---|---|---|
| ピンゾロ | 1-1-1 | 5 |
| ゾロ目 | 2-2-2 〜 6-6-6(大きい数が強い) | 3 |
| シゴロ | 4-5-6 | 2 |
| 目 | 同じ数2つ + 別の数1つ(6が強く1が弱い) | 1 |
| 目なし | 3投しても役なし | いちばん弱い役(負け確定ではない。相手が役を作れば負け、相手も目なしなら引き分け) |
| ヒフミ | 1-2-3 | 負け(2倍払う) |
| ションベン | 器から飛び出す(毎投3%) | 負け(1) |

- 親(配信者)が先に振り、役を確定してから子(リスナー)が振る。各3投まで。3投で役が出なければ目なし(いちばん弱い役)で、相手の番に進む。
- 親が負け役なら子は振らずに勝ち。同じ役は引き分けで、両者もう一度振る。
- 支払い倍率 = 勝った側の役の倍率と、負けた側の罰倍率(ヒフミ=2、それ以外=1)の大きい方。
- 点数: 全員「持ち点」(部屋を作るときに決める。既定 100)から。1戦の単位(10/20/50)× 倍率を負けた側から勝った側へ。マイナスも可。
- 飲み: 負けた側が「飲む単位(1口/半分/1杯)× 倍率」を飲む。各自で飲む(アプリは数えるだけ)。

## Firebase の準備(最初に一度だけ・無料)

このアプリは Google の Firebase Realtime Database で端末同士を同期します。設定はこのファイルの手順で10分ほど。

1. https://console.firebase.google.com を開き「プロジェクトを追加」。名前は何でもよい。Google アナリティクスはオフでよい。
2. 左メニュー「構築」→「Authentication」→「始める」→ ログイン方法で **匿名** を有効にして保存。
3. 「構築」→「Realtime Database」→「データベースを作成」。ロケーションは `asia-southeast1`(シンガポール)、**ロックモード** で作成。
4. できたデータベースの「ルール」タブを開き、下の **セキュリティルール** を全部貼り付けて「公開」。
5. 「Authentication」→「Settings(設定)」→「承認済みドメイン」に `suesugi60.github.io` を追加。
6. 左上の歯車 →「プロジェクトの設定」→ 下の「マイアプリ」→ ウェブ(`</>`)→ 名前を付けて登録 → 表示される
   `const firebaseConfig = { ... }` の中身をコピーして、`chinchiro/firebase-config.js` に貼る
   (`firebase-config.example.js` が見本。この値は公開してよいもの)。`databaseURL` が含まれていることを確認する
   (無ければ Realtime Database のページ上部に出ている `https://....firebasedatabase.app` を `databaseURL` として足す)。
7. `main` に反映すると公開URLで動く。まず自分のスマホで `?room=コード` を開いて、親機と別端末で対決できるか確かめる。

無料枠(Spark)は同時接続100・転送10GB/月。このアプリは観戦者が80人を超えると(81人目から)「満員」にして接続しない。

### セキュリティルール

`chinchiro/firebase-rules.json` の中身をそのまま貼ります(下に同じものを載せています)。

```json
{
  "rules": {
    "rooms": {
      "$code": {
        ".read": true,
        ".write": "auth != null && !data.exists() && newData.child('hostUid').val() == auth.uid && newData.hasChildren(['hostUid', 'settings', 'state'])",
        "hostUid":   { ".write": "auth != null && !data.exists() && newData.val() == auth.uid", ".validate": "newData.isString()" },
        "createdAt": { ".write": "auth != null && !data.exists()", ".validate": "newData.isNumber()" },
        "settings":  { ".write": "auth != null && data.parent().child('hostUid').val() == auth.uid" },
        "state":     { ".write": "auth != null && data.parent().child('hostUid').val() == auth.uid" },
        "players": {
          "$uid": {
            "name":     { ".write": "auth != null && $uid == auth.uid", ".validate": "newData.isString() && newData.val().length >= 1 && newData.val().length <= 12" },
            "char":     { ".write": "auth != null && $uid == auth.uid", ".validate": "newData.isString() && newData.val().matches(/^(momotaro|kintaro|urashima|kaguya|issun|akaoni|aooni|inu|saru|kiji|kappa|binbo)$/)" },
            "joinedAt": { ".write": "auth != null && $uid == auth.uid", ".validate": "newData.isNumber()" },
            "online":   { ".write": "auth != null && $uid == auth.uid", ".validate": "newData.isBoolean()" },
            "points":   { ".write": "auth != null && data.parent().parent().parent().child('hostUid').val() == auth.uid", ".validate": "newData.isNumber()" },
            "wins":     { ".write": "auth != null && data.parent().parent().parent().child('hostUid').val() == auth.uid", ".validate": "newData.isNumber()" },
            "losses":   { ".write": "auth != null && data.parent().parent().parent().child('hostUid').val() == auth.uid", ".validate": "newData.isNumber()" },
            "drinks":   { ".write": "auth != null && data.parent().parent().parent().child('hostUid').val() == auth.uid", ".validate": "newData.isNumber()" },
            "hidden":   { ".write": "auth != null && data.parent().parent().parent().child('hostUid').val() == auth.uid", ".validate": "newData.isBoolean()" },
            "banned":   { ".write": "auth != null && data.parent().parent().parent().child('hostUid').val() == auth.uid", ".validate": "newData.isBoolean()" },
            "$other":   { ".validate": false }
          }
        },
        "presence": { "$uid": { ".write": "auth != null && $uid == auth.uid", ".validate": "newData.isBoolean()" } },
        "queue": {
          "$uid": {
            ".write": "auth != null && ($uid == auth.uid || data.parent().parent().child('hostUid').val() == auth.uid)",
            ".validate": "newData.hasChildren(['joinedAt'])",
            "joinedAt": { ".validate": "newData.isNumber() && newData.val() >= now - 60000 && newData.val() <= now + 60000" },
            "$other": { ".validate": false }
          }
        },
        "actions": {
          "$uid": {
            ".write": "auth != null && ($uid == auth.uid || data.parent().parent().child('hostUid').val() == auth.uid)",
            ".validate": "newData.hasChildren(['type', 'at'])",
            "type": { ".validate": "newData.val() == 'roll'" },
            "at": { ".validate": "newData.isNumber()" },
            "$other": { ".validate": false }
          }
        },
        "$other": { ".validate": false }
      }
    }
  }
}
```

意味: 部屋は「作る人の uid が hostUid」のときだけ新規作成できる。以後、出目・勝敗・点数(`state` と `players/*/points` など)は
その親機しか書けない。リスナーは自分の名前(1〜12文字)・キャラ(12体のどれか)・順番待ち(時刻はサーバー時刻の±60秒)・
「振る」要求・接続中フラグだけ書ける。それ以外のキーは拒否。

**確認のしかた(推奨)**: Realtime Database の「ルール」タブ右上の「ルール プレイグラウンド」で、
認証を「匿名 (uid 任意)」にして次を試す。
- `set /rooms/AB7K` に `{"hostUid":"<同じuid>","settings":{},"state":{"phase":"lobby"}}` → 許可
- 別の uid で `set /rooms/AB7K/state` → 拒否
- 自分の uid で `set /rooms/AB7K/players/<uid>/name` に 13文字 → 拒否、12文字 → 許可
- 自分の uid で `set /rooms/AB7K/players/<uid>/char` に `"dragon"` → 拒否、`"kappa"` → 許可

## ファイル構成

```
chinchiro/
  index.html                 画面の骨組み(役割で切り替え)
  style.css                  見た目(飲みスゴロクと同じトーン)+ 器・サイコロの演出
  logic.js                   役の判定・勝敗・支払い・対戦の状態遷移(純粋関数)
  art.js                     キャラ12体の絵(sugoroku と同じ)
  sync.js                    同期アダプタ(mock / firebase)
  anim.js                    器にサイコロを投げる演出(リーチ含む)と音・役名のコール(声)
  widgets.js                 ミニサイコロ・投げの履歴・順位・ルール表・対戦の記録の HTML
  voice/                     役名コールの音声ファイル置き場(任意。README 参照)
  app.js                     親機・リスナー・表示専用の画面
  firebase-config.js         Firebase の設定(利用者が貼る)
  firebase-config.example.js 見本
  firebase-rules.json        Realtime Database に貼るセキュリティルール
  test/                      node --test(ロジック・同期)と Playwright(画面)
```

## テスト

```bash
node --test chinchiro/test/logic.test.mjs chinchiro/test/sync.test.mjs
node --test chinchiro/test/e2e.test.mjs   # Playwright + Chromium が必要(mock 同期で動く)
```

JS/CSS を変えたら、公開する前に次を実行する(`index.html` の読み込みに付けた印 `?v=…` を中身に合わせて更新する。合っていないと画面のテストが失敗する)。

```bash
node chinchiro/test/stamp-version.mjs
```

印があるので、公開後にページを再読み込みすれば必ず新しい版になる(印が無いと、ブラウザが古いファイルを最長 10 分使い続けることがある)。

## 注意(このリポジトリの同期について)

`publish_public.sh` は Dropbox 側の元フォルダから `rsync --delete` でこのリポジトリへ同期します。
元フォルダにも `chinchiro/`(`firebase-config.js` を含む)と `docs/` をコピーしておかないと、次回の同期で消えます。
