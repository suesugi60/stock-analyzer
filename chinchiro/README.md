# チンチロ対決(リスナー参加型)

配信者(親)とリスナー(子)が、それぞれの端末からリアルタイムにつながってチンチロで対決するアプリ。
リスナーは自分のスマホで「振る」を押し、器にサイコロが飛び込む演出が全員の画面で同時に流れます。

公開URL(main に反映後): `https://suesugi60.github.io/stock-analyzer/chinchiro/`

> 飲めない人はソフトドリンクでOK。無理な飲酒は絶対にしないこと。

## 使い方

### 配信者(親機)

1. 上のURLを開き、名前・キャラ・「勝ち負けで動くもの」(点数 / 飲み / 両方)・単位を選んで「部屋を作る」。
2. 画面に **部屋コード(4文字)** と参加URL・QRコードが出るので、配信に映す。
3. リスナーが参加すると右の「順番待ち」に並ぶ。「対決スタート」で先頭の人と対決。
4. 親(あなた)が先に「🎲 振る」(3投以内で役を作る)。次にリスナーが自分のスマホで振る。
5. 結果が出たら「次の挑戦者」。同じ人と続けるなら「同じ人ともう一回」。
6. 順番待ちの各行で「飛ばす」「非表示(名前を？？？にする)」「ブロック(以後参加させない)」ができる。
7. リスナーが20秒反応しないと「代わりに振る」が出る。
8. 再読み込みしても同じ部屋に戻る。やめるときは「部屋を閉じる」。

配信に映す方法は2つ: 親機のブラウザ画面をそのまま映す。または OBS の「ブラウザソース」で
`...?room=コード&stage=1`(操作ボタンなしの表示専用)を開く。

### リスナー(スマホ)

1. QRかURLを開き、名前とキャラを決めて「挑戦する」(「見るだけ」も可)。
2. 「あなたは N 番目」と出る。自分の番になると画面が光り、「🎲 振る」が出る。
3. 振ると全員の画面に同じ演出が流れ、結果が出る。もう一度やるなら「もう一回並ぶ」。

### 演出の確認

`...?demo=1&dice=4,5,6&seed=7` で任意の出目の演出だけ見られる(`&shonben=1` でションベン)。
`...?mock=1` を付けると、Firebase なしで同じブラウザ内(別タブ)だけで同期して試せる(お試し専用。他の端末とはつながらない)。

## ルール

| 役 | 出目 | 倍率 |
|---|---|---|
| ピンゾロ | 1-1-1 | 5 |
| ゾロ目 | 2-2-2 〜 6-6-6(大きい数が強い) | 3 |
| シゴロ | 4-5-6 | 2 |
| 目 | 同じ数2つ + 別の数1つ(6が強く1が弱い) | 1 |
| 目なし | 3投しても役なし | 負け(1) |
| ヒフミ | 1-2-3 | 負け(2倍払う) |
| ションベン | 器から飛び出す(毎投3%) | 負け(1) |

- 親(配信者)が先に振り、役を確定してから子(リスナー)が振る。各3投まで。
- 親が負け役なら子は振らずに勝ち。同じ役は引き分けで、両者もう一度振る。
- 支払い倍率 = 勝った側の役の倍率と、負けた側の罰倍率(ヒフミ=2、それ以外=1)の大きい方。
- 点数: 全員100点から。1戦の単位(10/20/50)× 倍率を負けた側から勝った側へ。マイナスも可。
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

無料枠(Spark)は同時接続100・転送10GB/月。このアプリは観戦者が80人を超えると「満員」にして接続しない。

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
            ".validate": "newData.hasChildren(['joinedAt']) && newData.child('joinedAt').isNumber() && newData.child('joinedAt').val() >= now - 60000 && newData.child('joinedAt').val() <= now + 60000",
            "$other": { ".validate": false }
          }
        },
        "actions": {
          "$uid": {
            ".write": "auth != null && ($uid == auth.uid || data.parent().parent().child('hostUid').val() == auth.uid)",
            ".validate": "newData.child('type').val() == 'roll' && newData.child('at').isNumber()",
            "$other": { ".validate": "$other == 'type' || $other == 'at'" }
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
  anim.js                    器にサイコロを投げる演出と音
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

## 注意(このリポジトリの同期について)

`publish_public.sh` は Dropbox 側の元フォルダから `rsync --delete` でこのリポジトリへ同期します。
元フォルダにも `chinchiro/`(`firebase-config.js` を含む)と `docs/` をコピーしておかないと、次回の同期で消えます。
