# カナデ(雅叙園東京)席のみ予約の自動化

TableCheck の予約ページを Playwright で操作し、KANADE LOUNGE / KANADE TERRACE の
「お席のみのご予約」プランを自動入力して送信する。

- KANADE TERRACE: https://www.tablecheck.com/ja/shops/gajoentokyo-kanadeterrace/reserve (既定)
- KANADE LOUNGE: https://www.tablecheck.com/ja/shops/gajoentokyo-kanadelounge/reserve (`--shop lounge`)

## 使い方

```bash
node reserve/tablecheck_reserve.js --date 11/20 --time 19:00 --adults 2
```

| オプション | 意味 |
|---|---|
| `--date` | 日付。`11/20` `11月20日` `2026-11-20` など。年を省略すると今日以降で最初のその月日 |
| `--time` | 時刻。`19:00` `19時` `19時半`。15分刻みの枠に一致する必要がある |
| `--adults` / `--children` / `--babies` | 大人(必須) / 子供12歳以下 / 幼児5歳以下 |
| `--shop terrace\|lounge` | 店。既定は terrace(KANADE TERRACE) |
| `--dry-run` | フォームを埋めるだけで送信しない。`01_form_filled.png` で確認できる |
| `--stop-at-confirm` | 確定画面まで進んで止まる(最終ボタンは押さない) |
| `--request "…"` | ご要望欄 |
| `--purpose` / `--visits` | 用途(誕生日, デート など) / ご利用回数(初来店 など) |
| `--marketing` | お店からのお知らせメールを受け取る(既定は受け取らない) |
| `--out DIR` | 画像とログの保存先。既定 `reserve/out/<日時>/` |

### 予約者情報

CLI 引数か環境変数で渡す(引数が優先)。GitHub には保存しない。

| 引数 | 環境変数 | 内容 |
|---|---|---|
| `--sei` / `--mei` | `TC_SEI` / `TC_MEI` | 姓 / 名(漢字) |
| `--sei-kana` / `--mei-kana` | `TC_SEI_KANA` / `TC_MEI_KANA` | せい / めい(ふりがな) |
| `--phone` | `TC_PHONE` | 携帯電話 |
| `--email` | `TC_EMAIL` | メールアドレス(予約確定メールが届く) |
| `--allergy` | `TC_ALLERGY` | アレルギーの回答。既定「なし」 |
| `--hilton` | `TC_HILTON` | ヒルトン・オナーズの回答。既定「会員ではない」。会員なら「ゴールド 123456789」の形式 |

### 終了コードと結果

標準出力の最終行が `RESULT {...}` の JSON。

| コード | status | 意味 |
|---|---|---|
| 0 | `submitted` | 送信完了。`03_result.png` と `reservationNumber` を確認 |
| 0 | `dry-run` / `confirm-page` | 各モードで正常に止まった |
| 2 | `unavailable` | その日時に空きがない、または席のみプランを選べない。選べる時間が `slots` に入る |
| 3 | `needs-manual-confirm` | 確定画面の最終ボタンを特定できず止まった。`02_confirm_page.png` を確認 |
| 1 | `error` | 入力エラーなど。`error.png` / `run.log` を確認 |

## 動作の流れ

1. 予約ページを開き「お店からのお知らせ」に同意、人数を選ぶ
2. 日付をカレンダー部品(Mobiscroll)の API で設定 → 空き時間枠が読み込まれる
3. 指定時刻の枠を選ぶ(無ければ終了コード 2)
4. 表示中のプランから「お席のみのご予約」を選ぶ。12/19〜1/5 は【窓側確約】プラン(カバーチャージあり)しか無いのでそれを選び、結果に `coverCharge: true` を付ける
5. お店からの質問に回答(アレルギー / ヒルトン・オナーズ / 注意事項への同意)
6. 予約者情報を入力、マイページ作成とお知らせメールはオフ
7. 「確定画面へ」→ 確定画面の最終ボタンを押す → 完了画面を保存

## 注意

- 自分の予約を自分のために取る用途に限る。空き監視のような高頻度アクセスはしない
- `reserve/out/` には氏名・電話番号入りの画像が残るので Git には入れない(.gitignore 済み)
- テスト: `node --test reserve/lib.test.js`
