# stock-analyzer

個別株・ファンド分析システム。構成は README.md を参照。

## カナデ(雅叙園東京)の席のみ予約 — reserve/

ユーザーが「11/20 19:00 2名」「カナデ 12/5 12時 3人 テラス」のように予約を頼んだら、
`reserve/tablecheck_reserve.js` を実行して TableCheck で予約する。詳細は `reserve/README.md`。

1. メッセージから日付・時刻・大人人数(・子供・幼児・店・ご要望)を読み取る。
   店の指定が無ければ `lounge`(KANADE LOUNGE)。「テラス」とあれば `--shop terrace`。
   読み取れない項目があれば実行前に聞く。
2. 予約者情報は環境変数 `TC_SEI TC_MEI TC_SEI_KANA TC_MEI_KANA TC_PHONE TC_EMAIL` から読まれる。
   設定が無いとスクリプトがエラーになるので、その場合はユーザーに聞いて `--sei` などで渡す。
   聞いた値をリポジトリ内のファイルに書かない。
3. 実行例: `node reserve/tablecheck_reserve.js --date 11/20 --time 19:00 --adults 2`
   - 初めての条件や不安があれば先に `--dry-run` を実行し `01_form_filled.png` を確認する。
   - 同じ依頼で二重に送信しない。実行前に直前の RESULT を確認する。
   - 終了コード 2 は満席・選択不可。`slots` の候補時刻を伝えて別の時刻を聞く。
   - 終了コード 3 は確定画面で止まった状態。`02_confirm_page.png` を見て原因を伝える。
4. 結果を日本語で報告し、`03_result.png`(dry-run なら `01_form_filled.png`)を SendUserFile で見せる。
   予約番号(`reservationNumber`)があれば伝える。`coverCharge: true` なら窓側確約プランで
   カバーチャージがかかることを伝える。
5. `reserve/out/` は個人情報を含むので commit しない。
