# 楽天トラベル領収書一括ダウンロード Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 楽天トラベルの過去の国内宿泊予約の領収書を、同じ宛名でまとめて発行して PDF 保存するコマンドラインツールを `rakuten_receipts/` に作る。

**Architecture:** ブラウザに触らない部品(`naming`・`ledger`・`runner`)と、楽天の画面に触る部品(`site`・`browser`)を分ける。安全策の判断はすべて `runner` に置き、偽の `site` を差し込んでテストする。`site` は楽天の画面を模したダミー HTML に対して Playwright でテストする。

**Tech Stack:** Python 3.9 以上、Playwright for Python(同期 API)、pytest。

**Spec:** `docs/superpowers/specs/2026-11-10-rakuten-receipts-design.md`

## Global Constraints

- **Python 3.9 で動く書き方にする。** 全モジュールの先頭に `from __future__ import annotations` を置き、型は `typing.Optional` / `List` / `Dict` を使う。`match` 文、`dataclass(slots=True)`、`zip(strict=)` は使わない。
- **ルートの `requirements.txt` は変更しない**(Streamlit Community Cloud のデプロイに使われている)。
- **セレクタと画面の文言は `site.py` だけに置く。** `runner.py` と `cli.py` は Playwright を import しない。
- **迷ったら押さない(フェイルクローズ)。** 想定外の画面では何も入力・クリックせず「要確認」にする。
- **宛名の修正機能は使わない。** `ADDRESSEE_FIX` と判定した画面では `fill_addressee` を呼ばない。
- **検出回避はしない。** User-Agent の変更、`AutomationControlled` の無効化、stealth 系ライブラリは入れない。
- **アクセスは1件ずつ。** 各件の間は 3〜6 秒空ける。並列処理はしない。
- **テストは本物の楽天に接続しない。** 画面のテストは `tests/fixtures/` のダミーページだけを使う。
- **ダミーページとテストデータに実在の個人情報を入れない。** 宛名は「株式会社サンプル」、予約番号は `RY001`〜、施設名は架空のものにする。
- **出力はリポジトリの外。** 既定の出力先は `~/Documents/rakuten-receipts/`、プロファイルは `~/Library/Application Support/rakuten-receipts/profile`。
- **利用者向けの文言(メッセージ・README・docstring)は日本語。** コミットメッセージも既存の履歴に合わせて日本語にする。
- **この実行環境でのテスト環境**: リポジトリのルートで次を実行する。ブラウザは Playwright 1.63.0 用がプリインストール済みなので、版を固定する(`playwright install` は実行しない)。

  ```bash
  python3 -m venv .venv
  .venv/bin/pip install "playwright==1.63.0" pytest vermin
  ```

  テストは `.venv/bin/python -m pytest rakuten_receipts/tests -q` で実行する。

## Review Focus

設計書が直接は触れていないが、使う人が踏みそうな状況。各行のテストは担当タスクに入れてある。

1. **Enter を押したのに予約一覧のタブがない**(ログインしただけ、別のページを見ている)→ 落ちずにもう一度案内して待つ。3回だめなら診断ファイルを残して終了コード 1。(Task 6)
2. **一覧の「次へ」が最後のページでも残っている・同じページに戻る** → 無限に回らず、読めた分で終わる。(Task 4)
3. **台帳を Excel で開いて保存し直した**(BOM なし、日付が `2025/3/15`、状態が空)→ 読み込めて、取得済みの行は取得済みのまま。(Task 2)
4. **チェックイン日を読み取れなかった予約があるのに `--from` / `--to` を指定した** → 黙って落とさず、「日付不明のため対象外: N 件」と表示する。(Task 3)
5. **ブラウザを起動できない**(Chrome が未インストール、前回のブラウザが開いたままでプロファイルが使用中)→ 例外のトレースではなく、対処を書いた1行のメッセージと終了コード 1。(Task 6)

既知の限界(テストでは防げない): 宛名の照合は確認画面の本文に対する部分一致なので、指定した宛名を含むもっと長い宛名も一致とみなす。`fill_addressee` が入力直後に欄の値を検証することと、最初の1件を人が目で確認することで補う。

---

## File Structure

| ファイル | 責任 |
|---|---|
| `rakuten_receipts/__init__.py` | パッケージの説明だけ |
| `rakuten_receipts/__main__.py` | `python -m rakuten_receipts` の入口。`cli.main()` を呼ぶだけ |
| `rakuten_receipts/models.py` | `Screen`・`Status`・`Reservation`・`UnexpectedScreen` |
| `rakuten_receipts/naming.py` | ファイル名の生成、宛名の検証と照合(純粋な関数) |
| `rakuten_receipts/ledger.py` | `receipts.csv` の読み書きと対象の選び出し |
| `rakuten_receipts/runner.py` | `list` / `download` の進行と安全策の判断 |
| `rakuten_receipts/site.py` | 楽天の画面を読む・押す。判断はしない |
| `rakuten_receipts/browser.py` | Chrome の起動、予約一覧タブの特定 |
| `rakuten_receipts/cli.py` | 引数の解釈、入力確認、全体の組み立て |
| `rakuten_receipts/pytest.ini` | テスト設定 |
| `rakuten_receipts/requirements.txt` / `requirements-dev.txt` | 依存 |
| `rakuten_receipts/README.md` | セットアップ、使い方、注意点 |
| `rakuten_receipts/tests/conftest.py` | `FakeSite`・`FakeUI`、ダミーサイトのサーバ、ブラウザの fixture |
| `rakuten_receipts/tests/fixtures/*.html` | 楽天の画面を模したダミーページ |
| `rakuten_receipts/tests/test_*.py` | 各部品のテスト |
| `.gitignore`(変更) | `.venv/` と `.pytest_cache/` を追加 |

設計書は `site.py` の操作を関数として挙げているが、`runner` に偽物を差し込みやすいよう `Site` クラスのメソッドとして実装する。

---

### Task 1: 骨組み・データ型・`naming`

**Files:**
- Create: `rakuten_receipts/__init__.py`, `rakuten_receipts/pytest.ini`, `rakuten_receipts/requirements.txt`, `rakuten_receipts/requirements-dev.txt`, `rakuten_receipts/models.py`, `rakuten_receipts/naming.py`
- Modify: `.gitignore`
- Test: `rakuten_receipts/tests/test_naming.py`

**Interfaces:**
- Consumes: なし
- Produces:

  ```python
  # models.py
  class Screen(Enum):      # LOGIN, LIST, ADDRESSEE_INPUT, ADDRESSEE_FIX, CONFIRM, RECEIPT, UNKNOWN
  class Status(str, Enum): # PENDING="未取得", DONE="取得済み", EXCLUDED="対象外", REVIEW="要確認",
                           # FAILED="失敗", FAILED_AFTER_ISSUE="失敗(発行後)"
  @dataclass(frozen=True)
  class Reservation:
      reservation_id: str
      hotel_name: str
      checkin: Optional[date]
      checkout: Optional[date]
      amount: Optional[int]
      receipt_available: bool
      page_index: int = 0          # 一覧の何ページ目にあったか(0 始まり)
  class UnexpectedScreen(Exception):
      def __init__(self, step: str, screen: Screen = Screen.UNKNOWN, detail: str = ""): ...
      # 属性 step / screen / detail を持つ

  # naming.py
  TITLES = ("様", "御中")
  def receipt_filename(res: Reservation) -> str
  def unique_path(directory: Path, filename: str) -> Path
  def validate_addressee(name: str) -> List[str]   # 問題点の日本語メッセージ。空リストなら問題なし
  def addressee_matches(confirm_text: str, name: str, title: str) -> bool
  ```

- [ ] **Step 1: 環境と設定ファイルを作る**

  Global Constraints の手順で `.venv` を作る。次のファイルを作る。

  `rakuten_receipts/pytest.ini`(ルートに `__init__.py` があるため、importlib モードにしてルートを import パスに足す):

  ```ini
  [pytest]
  addopts = --import-mode=importlib
  pythonpath = ..
  testpaths = tests
  ```

  `rakuten_receipts/requirements.txt` は `playwright>=1.49` の1行。`requirements-dev.txt` は `-r requirements.txt` と `pytest>=8`。
  `rakuten_receipts/__init__.py` は docstring だけ。`.gitignore` に `.venv/` と `.pytest_cache/` を足す。

- [ ] **Step 2: 失敗するテストを書く**(`tests/test_naming.py`)

  ```python
  R = Reservation("RY12345", "ホテル サンプル/東京", date(2025, 3, 15), date(2025, 3, 16), 12000, True)

  def test_filename_basic():
      assert receipt_filename(R) == "2025-03-15_ホテル_サンプル_東京_RY12345.pdf"
  def test_filename_forbidden_chars():      # 施設名 'A/B\\C:D*E?F"G<H>I|J\tK' → 施設名部分が "A_B_C_D_E_F_G_H_I_J_K"
  def test_filename_long_name_cut_to_60():  # 施設名 "あ"*80 → 施設名部分が "あ"*60
  def test_filename_no_date():              # checkin=None → "日付不明_" で始まる
  def test_filename_empty_hotel():          # 施設名 "  / " → 施設名部分が "施設名不明"
  def test_unique_path(tmp_path):           # なし→a.pdf、a.pdf あり→a_2.pdf、a_2.pdf もあり→a_3.pdf

  def test_validate_ok():                   assert validate_addressee("株式会社サンプル") == []
  def test_validate_50_chars_ok():          assert validate_addressee("あ" * 50) == []
  def test_validate_halfwidth_alnum_ok():   assert validate_addressee("ABC Trading 123") == []
  @pytest.mark.parametrize("bad", ["", "   ", "あ" * 51, "ABC(株)", "サンプル!", "㈱サンプル", "髙橋商店", "山﨑商店", "サンプル♪", "〒サンプル", "サンプル①"])
  def test_validate_rejects(bad):           assert validate_addressee(bad) != []

  def test_match_same_line():      assert addressee_matches("宛名 株式会社サンプル 御中", "株式会社サンプル", "御中")
  def test_match_separate_cells(): assert addressee_matches("宛名:株式会社サンプル\n敬称:御中", "株式会社サンプル", "御中")
  def test_match_ignores_spaces(): assert addressee_matches("株式会社 サンプル 御中", "株式会社サンプル", "御中")
  def test_mismatch_name():        assert not addressee_matches("株式会社見本 御中", "株式会社サンプル", "御中")
  def test_mismatch_title():       assert not addressee_matches("株式会社サンプル 様", "株式会社サンプル", "御中")
  def test_okyakusama_is_not_title():
      assert not addressee_matches("株式会社サンプル 御中 お客様へのご案内", "株式会社サンプル", "様")
  ```

- [ ] **Step 3: 失敗を確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_naming.py -q`
  Expected: `ModuleNotFoundError: No module named 'rakuten_receipts.models'` で収集エラー

- [ ] **Step 4: `models.py` と `naming.py` を実装する**

  - `receipt_filename`: `{チェックイン日 ISO 形式 または "日付不明"}_{施設名}_{予約番号}.pdf`。施設名と予約番号は NFC 正規化し、`/ \ : * ? " < > |`・制御文字・空白の並び(全角空白を含む)を `_` に置き換え、連続する `_` を1つにまとめ、前後の `_` と `.` を取り、施設名は60文字で切る。空になったら「施設名不明」。
  - `validate_addressee`: 前後の空白を除いて判定する。拒否するのは、空、50文字超、ASCII 記号(`string.punctuation`)、環境依存文字・特殊記号(`㈱㈲㈹髙﨑♪〒` と、U+2150–218F、U+2460–24FF、U+3200–33FF、U+F900–FAFF の範囲)。半角英数字と半角空白は許可する。
  - `addressee_matches`: 両方から空白をすべて除いたうえで、本文に宛名が含まれ、かつ本文から `お客様`・`皆様`・`様式` を除いた残りに敬称が含まれるとき真。

- [ ] **Step 5: 通ることを確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_naming.py -q`
  Expected: 全件 PASS

- [ ] **Step 6: コミット**

  ```bash
  git add .gitignore rakuten_receipts
  git commit -m "領収書ツール: 骨組みとファイル名・宛名検証を追加"
  ```

---

### Task 2: `ledger`(台帳)

**Files:**
- Create: `rakuten_receipts/ledger.py`
- Test: `rakuten_receipts/tests/test_ledger.py`

**Interfaces:**
- Consumes: `Reservation`、`Status`(Task 1)
- Produces:

  ```python
  COLUMNS = ["予約番号", "施設名", "チェックイン", "チェックアウト", "金額", "状態", "ファイル名", "更新日時", "メモ"]
  @dataclass
  class LedgerRow:
      reservation_id: str; hotel_name: str; checkin: Optional[date]; checkout: Optional[date]
      amount: Optional[int]; status: Status; filename: str = ""; updated_at: str = ""; memo: str = ""
  class Ledger:
      def __init__(self, path: Path, now: Callable[[], datetime] = datetime.now)  # ファイルがあれば読む
      rows: Dict[str, LedgerRow]                                                  # 予約番号 → 行(追加順)
      def sync(self, reservations: List[Reservation]) -> None                     # 反映して保存
      def mark(self, reservation_id: str, status: Status, filename: str = "", memo: str = "") -> None  # 更新して保存
      def targets(self, reservations: List[Reservation], date_from: Optional[date], date_to: Optional[date]) -> List[Reservation]
  ```

- [ ] **Step 1: 失敗するテストを書く**

  ```python
  def test_sync_new_rows():            # receipt_available=True → 未取得、False → 対象外
  def test_sync_keeps_done():          # mark(DONE, "a.pdf") の後に sync → 取得済みのまま、ファイル名も残る
  def test_sync_keeps_review_and_failed()
  def test_sync_excluded_becomes_pending_when_link_appears()
  def test_sync_pending_becomes_excluded_when_link_disappears()
  def test_sync_keeps_rows_missing_from_fresh_read()
  def test_sync_updates_hotel_dates_amount()
  def test_mark_saves_immediately():   # 別の Ledger(path) で読み直すと 状態・ファイル名・メモ・更新日時 が入っている
  def test_mark_empty_filename_keeps_existing()
  def test_mark_unknown_id_raises():   # KeyError
  def test_file_is_bom_utf8_with_columns():
      assert path.read_bytes().startswith(b"\xef\xbb\xbf")
      # 1行目が COLUMNS と一致
  def test_targets_range_inclusive_and_status():
      # from=3/15, to=3/16: 3/15 と 3/16 は含む、3/14 と 3/17 は含まない
      # 取得済み・対象外は含まない。要確認・失敗・失敗(発行後)・未取得は含む
  def test_targets_unknown_date():     # checkin=None は、期間指定なしなら含む、from か to があれば含まない
  def test_targets_keeps_reading_order()
  def test_load_tolerates_excel_resave():
      # BOM なし、日付 "2025/3/15"、状態が空の行と "取得済み" の行を持つ CSV を直接書く
      # → 読み込める。checkin == date(2025, 3, 15)。空の状態は未取得、"取得済み" は取得済み
  ```

- [ ] **Step 2: 失敗を確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_ledger.py -q`
  Expected: `No module named 'rakuten_receipts.ledger'` で収集エラー

- [ ] **Step 3: `ledger.py` を実装する**

  - 保存は `utf-8-sig`、`csv.DictWriter`。一時ファイルに書いてから `os.replace` で置き換える。親フォルダがなければ作る。
  - 日付は `YYYY-MM-DD` で書く。読むときは `YYYY-MM-DD` と `YYYY/M/D` を受け付け、読めなければ `None`。
  - 更新日時は `YYYY-MM-DD HH:MM:SS`。状態の文字列が `Status` のどれでもなければ未取得として扱う。
  - `sync` の規則: 新規は「未取得」か「対象外」。既存行は施設名・日付・金額を新しい値にする。状態は、取得済み・要確認・失敗・失敗(発行後)なら変えない。対象外でリンクが現れたら未取得、未取得でリンクが消えたら対象外。今回読めなかった行は触らない。
  - `mark` は `filename` が空文字なら既存のファイル名を残す。

- [ ] **Step 4: 通ることを確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_ledger.py -q`
  Expected: 全件 PASS

- [ ] **Step 5: コミット**

  ```bash
  git add rakuten_receipts
  git commit -m "領収書ツール: 台帳(receipts.csv)を追加"
  ```

---

### Task 3: `runner`(進行と安全策)

**Files:**
- Create: `rakuten_receipts/runner.py`, `rakuten_receipts/tests/conftest.py`
- Test: `rakuten_receipts/tests/test_runner.py`

**Interfaces:**
- Consumes: `Ledger`(Task 2)、`receipt_filename` / `unique_path` / `addressee_matches`(Task 1)
- Produces:

  ```python
  MAX_CONSECUTIVE_FAILURES = 3
  INTERVAL_SECONDS = (3.0, 6.0)
  class ListUnreadable(Exception)
  @dataclass
  class Options:
      out_dir: Path; date_from: Optional[date] = None; date_to: Optional[date] = None
      name: str = ""; title: str = ""; limit: Optional[int] = None
  @dataclass
  class Summary:
      done: int = 0; review: int = 0; failed: int = 0
      aborted: bool = False            # 連続失敗で中止した
      stopped: bool = False            # 利用者が確認で y 以外を答えた
      keep_browser_open: bool = False  # 発行後に保存できなかったので、手で保存できるよう開いたままにする
  def format_table(reservations: List[Reservation], ledger: Ledger) -> str
  def run_list(site, ledger: Ledger, opts: Options, ui) -> List[Reservation]
  def run_download(site, ledger: Ledger, opts: Options, ui, sleep=time.sleep, uniform=random.uniform) -> Summary
  ```

  `site` に求めるメソッド(Task 4・5 の `Site` が実装する。`runner` は Playwright を import しない):

  ```python
  read_reservations() -> List[Reservation]
  open_receipt(reservation: Reservation) -> Screen   # 「領収書発行」を押し、移った先の画面種別を返す
  fill_addressee(name: str, title: str) -> None
  go_to_confirm() -> Screen                          # 「領収書の発行」を押し、移った先の画面種別を返す
  read_confirm_text() -> str
  submit_issue() -> None                             # 「発行する」を押す
  save_receipt(path: Path) -> None
  save_diagnostics(label: str) -> Optional[Path]
  close_flow() -> None
  ```

  `ui` に求めるメソッド: `info(message: str) -> None`、`confirm(message: str) -> bool`、`wait_enter(message: str) -> None`。

- [ ] **Step 1: `conftest.py` に偽物を用意する**

  - `FakeSite(reservations, scripts)`: `scripts` は予約番号 → 挙動の辞書。キーは `open`(`Screen`、またはリストで呼び出しごとの値)、`confirm_screen`(既定 `CONFIRM`)、`confirm_text`(既定は「株式会社サンプル 御中」)、`submit_raises`、`save_raises`、`fill_raises`。呼ばれた操作を `calls`(例 `("open", "RY001")`)に記録し、`save_receipt` は `path` に `b"%PDF-fake"` を書く。
  - `FakeUI(answers)`: `confirm` は `answers` を先頭から順に返し、足りなければ `AssertionError`。`infos`・`confirms`・`enters` に受け取った文言を記録する。
  - fixture `make_site`、`make_ui`、`ledger`(`tmp_path/"out"/"receipts.csv"`)、`opts`(`out_dir=tmp_path/"out"`、`name="株式会社サンプル"`、`title="御中"`)として渡す。

- [ ] **Step 2: 失敗するテストを書く**

  `run_download` の `sleep` には記録用の関数を渡す。予約は `RY001`〜、すべて `receipt_available=True`、チェックイン 2025-03-15 から1日ずつ。

  ```python
  def test_list_syncs_and_returns():               # ledger に全件入り、ui.info に予約番号が出る
  def test_list_zero_raises_and_leaves_ledger():   # ListUnreadable。receipts.csv は作られない

  def test_first_confirm_no_means_no_submit():     # answers=[False] → calls に "submit" なし、stopped、台帳は未取得のまま
  def test_happy_path_two_items():
      # answers=[True, True] → done == 2、2件とも取得済み
      # out_dir に "2025-03-15_…_RY001.pdf" と "2025-03-16_…_RY002.pdf"
      # sleep は1回だけ呼ばれ、引数は 3.0 以上 6.0 以下。ui.confirm は2回
  def test_second_confirm_no_stops_after_first():  # answers=[True, False] → done == 1、RY002 は open されない
  def test_single_target_asks_once():              # 対象1件、answers=[True] → confirm は1回
  def test_confirm_text_mismatch_is_review():      # confirm_text="株式会社見本 御中" → submit なし、要確認
  def test_confirm_screen_not_reached_is_review():  # confirm_screen=UNKNOWN → read_confirm/submit なし、要確認
  def test_fix_screen_is_review_without_fill():    # open=ADDRESSEE_FIX → fill なし、要確認
  def test_unknown_screen_is_review_with_diagnostics():  # open=UNKNOWN → 要確認、save_diagnostics が呼ばれる
  def test_already_issued_saved_with_memo():
      # open=RECEIPT → fill/submit なしで save、取得済み、メモ == "発行済みを再表示"、ui.confirm は呼ばれない
  def test_human_confirm_on_first_item_reaching_confirm():
      # RY001 は ADDRESSEE_FIX、RY002 は通常 → 最初の confirm は RY002 の確認画面で出る
  def test_three_consecutive_failures_abort():     # 4件とも UNKNOWN → aborted、RY004 は open されない、review == 3
  def test_failure_counter_resets_on_success():    # UNKNOWN, UNKNOWN, 通常, UNKNOWN, UNKNOWN → aborted でない
  def test_save_failure_after_submit():
      # RY001 の save_raises → 状態 "失敗(発行後)"、keep_browser_open、RY002 は open されない、診断が保存される
  def test_submit_exception_is_failed_after_issue():  # submit_raises=RuntimeError → 状態 "失敗(発行後)"、keep_browser_open
  def test_exception_before_submit_is_failed():    # fill_raises=RuntimeError → 状態 "失敗"、submit なし
  def test_login_screen_prompts_and_retries_once(): # open=[LOGIN, ADDRESSEE_INPUT] → wait_enter 1回、その後は通常どおり
  def test_login_twice_is_failed():                # open=[LOGIN, LOGIN] → 状態 "失敗"、fill なし
  def test_limit_counts_review_items():            # limit=2、[UNKNOWN, 通常, 通常] → open は2件だけ
  def test_range_filter_and_undated_notice():
      # date_from 指定、checkin=None の予約が1件 → その予約は open されず、ui.info に "日付不明のため対象外: 1 件"
  def test_no_targets_returns_empty_summary():     # 全件取得済み → confirm なし、Summary() と等しい
  def test_keyboard_interrupt_leaves_row_unchanged():  # submit_raises=KeyboardInterrupt → 伝播し、台帳は未取得のまま
  def test_close_flow_called_for_every_item()
  ```

- [ ] **Step 3: 失敗を確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_runner.py -q`
  Expected: `No module named 'rakuten_receipts.runner'` で収集エラー

- [ ] **Step 4: `runner.py` を実装する**

  文言は定数にする(設計書の文面どおり):

  ```python
  CONFIRM_FIRST = "ブラウザの確認画面を見て、この内容で発行しますか? [y/N]"
  CONFIRM_REST = "PDF を開いて確認してください。残り {n} 件を続けますか? [y/N]"
  RELOGIN = "ログイン画面に戻りました。ブラウザでログインし直してから Enter を押してください"
  UNDATED_NOTICE = "日付不明のため対象外: {n} 件"
  MEMO_REDISPLAY = "発行済みを再表示"
  MEMO_MISMATCH = "確認画面の宛名が一致しない"
  MEMO_FIX = "修正・再発行らしい画面のため未入力"
  MEMO_UNEXPECTED = "想定外の画面: {step}"
  MEMO_AFTER_ISSUE = "発行済みの可能性あり。手動で確認"
  ```

  `run_list`: `site.read_reservations()` が空なら `ListUnreadable`(台帳には触らない)。それ以外は `ledger.sync` して `ui.info(format_table(...))`。`format_table` は チェックイン・施設名・予約番号・金額・状態 を ` | ` 区切りで1行ずつ。

  `run_download` の1件ごとの判断(この順で評価する):

  1. `open_receipt` が `LOGIN` → `ui.wait_enter(RELOGIN)` して1回だけやり直す。再び `LOGIN` なら「失敗」。
  2. `RECEIPT` → そのまま `save_receipt`。「取得済み」、メモ `MEMO_REDISPLAY`。
  3. `ADDRESSEE_FIX` → 何もせず「要確認」、メモ `MEMO_FIX`。
  4. `ADDRESSEE_INPUT` → `fill_addressee` → `go_to_confirm` が `CONFIRM` でなければ「要確認」 → `read_confirm_text` を `addressee_matches` で照合し、不一致なら「要確認」(メモ `MEMO_MISMATCH`)。
     一致したら、今回の実行でまだ人の確認をしていなければ、読み取った宛名を `ui.info` で示して `ui.confirm(CONFIRM_FIRST)`。偽なら台帳を変えずに `stopped=True` で終わる。
     → `submit_issue` → `save_receipt` → 「取得済み」。人の確認をした件で、かつ残りがあれば `ui.confirm(CONFIRM_REST)`。偽なら `stopped=True` で終わる。
  5. それ以外の画面 → 「要確認」、メモ `MEMO_UNEXPECTED`。
  6. 例外: `UnexpectedScreen` は「要確認」、その他の `Exception` は「失敗」。ただし `submit_issue` を呼び始めた後(その呼び出し自体が例外になった場合を含む)なら、どちらも「失敗(発行後)」(メモ `MEMO_AFTER_ISSUE`)とし、`keep_browser_open=True` にして実行を終える。保存できない発行を重ねないため、何件目であっても止める。`KeyboardInterrupt` は捕まえない。
  7. 「要確認」「失敗」「失敗(発行後)」にしたときは必ず `save_diagnostics(予約番号と段階名)` を呼ぶ。
  8. どの結果でも最後に `close_flow()`(`keep_browser_open` にしたときを除く)。
  9. 取得済みで連続失敗の数を 0 に戻す。それ以外は 1 増やし、`MAX_CONSECUTIVE_FAILURES` に達したら `aborted=True` で終わる。
  10. 次の件があるときだけ `sleep(uniform(*INTERVAL_SECONDS))`。

  保存先は `unique_path(opts.out_dir, receipt_filename(res))`。期間指定があり、チェックイン日が `None` で領収書発行が可能な予約が1件以上あれば、開始前に `UNDATED_NOTICE` を出す。

- [ ] **Step 5: 通ることを確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_runner.py -q`
  Expected: 全件 PASS

- [ ] **Step 6: コミット**

  ```bash
  git add rakuten_receipts
  git commit -m "領収書ツール: list / download の進行と安全策を追加"
  ```

---

### Task 4: ダミーページと `site` の読み取り

**Files:**
- Create: `rakuten_receipts/site.py`, `rakuten_receipts/tests/fixtures/*.html`
- Modify: `rakuten_receipts/tests/conftest.py`
- Test: `rakuten_receipts/tests/test_site_read.py`

**Interfaces:**
- Consumes: `Screen`・`Reservation`・`UnexpectedScreen`(Task 1)
- Produces:

  ```python
  MAX_PAGES = 50
  def detect_screen(page: Page) -> Screen
  def parse_block_text(text: str) -> Dict[str, object]  # キー: reservation_id, checkin, checkout, amount(なければ None)
  class Site:
      def __init__(self, context: BrowserContext, list_page: Page, debug_dir: Path, timeout_ms: int = 15000)
      # list_url として list_page.url を覚える
      def detect_screen(self) -> Screen       # 今の操作対象(発行操作中のページ、なければ一覧ページ)を判定
      def read_reservations(self) -> List[Reservation]
  ```

  conftest の fixture(Task 5・6 も使う): `dummy_site`(ダミーサイトのベース URL、末尾 `/`)、`context`(ヘッドレスの `BrowserContext`、`accept_downloads=True`)、`page`。

- [ ] **Step 1: ダミーページを作る**(`tests/fixtures/`)

  状態は持たず、値はクエリ文字列で渡してページ内の小さなスクリプトで表示する。

  | ファイル | 内容 |
  |---|---|
  | `list_p1.html` | 予約3件。`RY001`(オンライン決済、「領収書発行」リンク → `receipt_input.html?id=RY001`)、`RY002`(現地決済、リンクなし)、`RY003`(「領収書発行」が `target="_blank"` で `receipt_input_select.html?id=RY003&mode=download`)。「次へ」→ `list_p2.html` |
  | `list_p2.html` | `RY004`(→ `receipt.html?id=RY004`、発行済み)、`RY005`(→ `receipt_fix.html`)、`RY006`(→ `unknown.html`)。`RY004` のまとまりをもう1つ重複して置く。「次回使えるクーポン」という無関係なリンクを置く。「次へ」はない |
  | `list_loop.html` | 予約1件(`RY101`)。「次へ」が自分自身を指す |
  | `list_empty.html` | 「予約番号で検索」という文言だけがあり、予約番号の値を持つまとまりがない |
  | `receipt_input.html` | 宛名のテキスト入力(`<label>宛名</label>` 付き)、敬称のラジオ(様 / 御中)、「領収書の発行」ボタン(GET で `receipt_confirm.html` へ)。注記「宛名の修正は1回限りです」を本文に含む |
  | `receipt_input_select.html` | 同上だが敬称は `<select>` |
  | `receipt_input_broken.html` | 同上だが「御中」のラジオが `disabled` |
  | `receipt_confirm.html` | クエリの宛名と敬称を表示。「発行する」ボタン。`mode=download` のときは `sample.pdf` を `download` 属性付きリンクで落とす。それ以外は `receipt.html` へ |
  | `receipt.html` | 見出し「領収書」、宛名、金額、「楽天グループ株式会社」「登録番号 T1234567890123」 |
  | `receipt_fix.html` | 宛名のテキスト入力、「修正する」ボタン、本文に「発行済」 |
  | `unknown.html` | 「ただいまメンテナンス中です」だけ |
  | `login.html` | ユーザIDとパスワード(`type="password"`)の入力欄 |

  各予約のまとまりは、施設ページへのリンク(`href="/HOTEL/1/"`、架空の施設名)、「予約番号」、チェックイン・チェックアウト日、合計金額を含む。`RY001` は「ホテルサンプル東京」、2025年3月15日〜16日、12,000円。チェックイン日は `RY002` が 3月20日、`RY003` が 3月22日、`RY004` が 4月1日、`RY005` が 4月5日、`RY006` が 4月10日(いずれも 2025年)。`list_p2.html` は書式を変え、`RY004` は「宿泊日 2025/04/01〜2025/04/02」と「予約日 2025/01/10」を含める。

  conftest に、fixtures を一時フォルダへ複写し、最小の PDF(`b"%PDF-1.4\n%dummy\n"` で始まるバイト列)を `sample.pdf` として書き、`http.server` を `127.0.0.1` の空きポートで別スレッドに立てる `dummy_site` を足す。ブラウザはセッション単位、`context` はテスト単位。

- [ ] **Step 2: 失敗するテストを書く**

  ```python
  def test_parse_labeled():
      d = parse_block_text("予約番号:RY12345 チェックイン 2025年3月15日 チェックアウト 2025年3月16日 合計 12,000円")
      assert d == {"reservation_id": "RY12345", "checkin": date(2025, 3, 15), "checkout": date(2025, 3, 16), "amount": 12000}
  def test_parse_range_ignores_booking_date():
      d = parse_block_text("予約日 2025/01/10 予約番号 RY7 宿泊日 2025/03/15〜2025/03/16 料金 8,500円")
      assert (d["checkin"], d["checkout"], d["amount"]) == (date(2025, 3, 15), date(2025, 3, 16), 8500)
  def test_parse_missing_fields():   # "予約番号 RY9" → 日付と金額は None
  def test_parse_invalid_date():     # "チェックイン 2025/13/45" → checkin は None(例外にしない)

  @pytest.mark.parametrize("path, expected", [
      ("list_p1.html", Screen.LIST), ("receipt_input.html", Screen.ADDRESSEE_INPUT),
      ("receipt_input_select.html", Screen.ADDRESSEE_INPUT),
      ("receipt_confirm.html?atena=株式会社サンプル&keisho=御中", Screen.CONFIRM),
      ("receipt.html?id=RY004", Screen.RECEIPT), ("receipt_fix.html", Screen.ADDRESSEE_FIX),
      ("unknown.html", Screen.UNKNOWN), ("login.html", Screen.LOGIN)])
  def test_detect_screen(page, dummy_site, path, expected)
  # receipt_input.html は注記に「修正」を含むが ADDRESSEE_INPUT と判定される(上の表で確認)

  def test_reads_two_pages():
      # 6件、順に RY001〜RY006。RY002 だけ receipt_available=False
      # RY001: hotel_name="ホテルサンプル東京", checkin=date(2025,3,15), checkout=date(2025,3,16), amount=12000, page_index=0
      # RY004: page_index=1, checkin=date(2025,4,1)(予約日 1/10 を拾わない)
  def test_duplicate_ids_deduped():          # RY004 は1件だけ
  def test_unrelated_next_text_not_followed(): # 「次回使えるクーポン」をたどらない(2ページで終わる)
  def test_next_link_loop_stops():           # list_loop.html → 5秒以内に返り、RY101 の1件
  def test_no_reservations_returns_empty():  # unknown.html → []
  def test_block_without_id_skipped():       # list_empty.html → []
  def test_list_page_with_receipt_links_is_list():  # list_p1.html は「領収書」を含むが LIST(RECEIPT と誤判定しない)
  ```

- [ ] **Step 3: 失敗を確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_site_read.py -q`
  Expected: `No module named 'rakuten_receipts.site'` で収集エラー

- [ ] **Step 4: `site.py` の読み取りを実装する**

  文言はモジュール先頭の定数にまとめる:

  ```python
  TEXT_RECEIPT_LINK = "領収書発行"
  TEXT_GO_CONFIRM = "領収書の発行"
  TEXT_SUBMIT = "発行する"
  TEXT_RESERVATION_ID = "予約番号"
  FIX_MARKERS_ANYWHERE = ("再発行", "発行済")
  FIX_MARKERS_IN_CONTROLS = ("修正",)            # ボタン・リンク・見出しの文言に限って見る
  TEXT_RECEIPT_TITLE = "領収書"
  INVOICE_NUMBER = re.compile(r"T\d{13}")        # 適格請求書発行事業者の登録番号。領収書には必ず載る
  LOGIN_HOSTS = ("login.account.rakuten.com", "id.rakuten.co.jp")
  CHECKIN_LABELS = ("チェックイン", "宿泊日", "宿泊期間", "利用日")
  CHECKOUT_LABELS = ("チェックアウト",)
  AMOUNT_LABELS = ("合計", "料金", "支払")
  NEXT_PATTERN = re.compile(r"^\s*(次へ|次の\d*件|次ページ|次)\s*[>»›]*\s*$")
  ```

  `detect_screen(page)` はこの順で判定する:

  1. URL のホストが `LOGIN_HOSTS` のどれかを含む、または表示中の `input[type=password]` がある → `LOGIN`
  2. 表示中のテキスト入力欄がなく、文言がちょうど `TEXT_SUBMIT` のボタンかリンクがある → `CONFIRM`
  3. 表示中のテキスト入力欄がある場合: 本文に `FIX_MARKERS_ANYWHERE` がある、またはボタン・リンク・見出しに `FIX_MARKERS_IN_CONTROLS` がある → `ADDRESSEE_FIX`。そうでなく `TEXT_GO_CONFIRM` のボタンがある → `ADDRESSEE_INPUT`。どちらでもない → `UNKNOWN`
  4. 本文に `TEXT_RECEIPT_TITLE` があり、`INVOICE_NUMBER` に合う文字列があり、`TEXT_RECEIPT_LINK` を含むリンクやボタンがない → `RECEIPT`。
     エラーページを領収書として保存しないよう、登録番号を必須にする。
  5. 本文に `TEXT_RESERVATION_ID` がある → `LIST`
  6. それ以外 → `UNKNOWN`

  `read_reservations`: 各ページで、`TEXT_RESERVATION_ID` を自分のテキストに持つ要素ごとに、「予約番号」をちょうど1つ含む最も外側の祖先を予約のまとまりとする(`page.evaluate` で取り出す)。まとまりごとに、テキスト全体、施設名の候補(`href` に `/HOTEL/` を含む最初のリンクの文言、なければ最初の見出し)、`TEXT_RECEIPT_LINK` を含む `a` / `button` / `input` の有無を返し、Python 側で `parse_block_text` と合わせて `Reservation` にする。施設名の候補がなければ「施設名不明」。予約番号を取り出せないまとまりは捨てる。
  予約番号で重複を除く(先に読んだほうを残す)。次ページは `NEXT_PATTERN` に合う表示中の `a` / `button` の最初の1つをクリックする。なければ終わり。クリック後に読めた予約番号の集合が前のページと同じなら終わり。`MAX_PAGES` で打ち切る。

  `parse_block_text`: 予約番号は `予約番号[\s::]*([A-Za-z0-9\-]+)`。日付は `(\d{4})[/年.\-](\d{1,2})[/月.\-](\d{1,2})`。チェックインは `CHECKIN_LABELS` の直後に最初に現れる日付(ラベルがなければ本文の最初の日付)。チェックアウトは `CHECKOUT_LABELS` の直後の日付、なければチェックインの直後に `〜` `~` `-` `−` を挟んで続く日付。金額は `AMOUNT_LABELS` の後に最初に現れる `([\d,]+)\s*円`(ラベルがなければ最初の `円`)。暦にない日付は `None`。

- [ ] **Step 5: 通ることを確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_site_read.py -q`
  Expected: 全件 PASS

- [ ] **Step 6: コミット**

  ```bash
  git add rakuten_receipts
  git commit -m "領収書ツール: ダミーページと予約一覧の読み取りを追加"
  ```

---

### Task 5: `site` の発行操作

**Files:**
- Modify: `rakuten_receipts/site.py`
- Create: `rakuten_receipts/tests/fixtures/list_extra.html`
- Test: `rakuten_receipts/tests/test_site_flow.py`

**Interfaces:**
- Consumes: Task 4 の `Site`・`detect_screen`・ダミーページ・fixture
- Produces(`Site` に追加。Task 3 の `runner` が求めるメソッドと同じ形):

  ```python
  ISSUE_TIMEOUT_MS = 30000
  def open_receipt(self, reservation: Reservation) -> Screen
  def fill_addressee(self, name: str, title: str) -> None
  def go_to_confirm(self) -> Screen
  def read_confirm_text(self) -> str
  def submit_issue(self) -> None
  def save_receipt(self, path: Path) -> None
  def save_diagnostics(self, label: str) -> Optional[Path]
  def close_flow(self) -> None
  ```

- [ ] **Step 1: 失敗するテストを書く**

  各テストは `dummy_site + "list_p1.html"` を開いた `page` で `Site(context, page, tmp_path / "debug", timeout_ms=3000)` を作り、`read_reservations()` の結果から予約を選ぶ。

  ```python
  def test_flow_print_page():
      # RY001: open_receipt → ADDRESSEE_INPUT。fill_addressee("株式会社サンプル", "御中")
      # go_to_confirm() == CONFIRM。read_confirm_text() に "株式会社サンプル" と "御中"
      # submit_issue(); save_receipt(p) → p.read_bytes().startswith(b"%PDF-")
  def test_flow_popup_select_download():
      # RY003(新しいタブ、敬称は select、PDF ダウンロード)→ 保存したバイト列が sample.pdf と一致
  def test_title_sama_selected():               # RY001 を "様" で → read_confirm_text() に "様"、"御中" は含まない
  def test_already_issued_opens_receipt():      # RY004(2ページ目)→ RECEIPT。save_receipt → PDF
  def test_fix_screen():                        # RY005 → ADDRESSEE_FIX
  def test_unknown_screen():                    # RY006 → UNKNOWN
  def test_fill_verifies_title():
      # receipt_input_broken.html を操作対象にして fill_addressee(..., "御中") → UnexpectedScreen(step == "fill_addressee")
  def test_missing_button_raises_quickly():     # unknown.html で go_to_confirm() → timeout_ms=500 で UnexpectedScreen
  def test_open_receipt_returns_login():        # list_url が login.html を指す Site → open_receipt は LOGIN を返す
  def test_open_receipt_missing_reservation():  # 一覧にない予約番号 → UnexpectedScreen(step == "open_receipt")
  def test_save_diagnostics_writes_png_and_html():  # debug_dir に .png と .html。html に「メンテナンス」
  def test_save_diagnostics_never_raises():     # ページを閉じた後に呼んでも None を返すだけ
  def test_close_flow_closes_popup_keeps_list(): # RY003 の後 close_flow → context.pages は一覧ページだけ
  def test_second_item_after_first():           # RY001 を最後まで → close_flow → RY003 を最後まで、が続けて通る
  ```

  `test_fill_verifies_title` 用に `tests/fixtures/list_extra.html` を足す。予約は `RY201` の1件で、「領収書発行」が `receipt_input_broken.html` を指す。これを一覧として `Site` を作り、`open_receipt` で入力画面まで進めてから `fill_addressee` を呼ぶ。`list_p2.html` には足さない(通しテストの件数と連続失敗の数が変わるため)。
  `test_missing_button_raises_quickly` は `timeout_ms=500` の `Site` で `RY006` を `open_receipt` し(`unknown.html` に移る)、そこで `go_to_confirm()` を呼ぶ。

- [ ] **Step 2: 失敗を確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_site_flow.py -q`
  Expected: `AttributeError: 'Site' object has no attribute 'open_receipt'` などで FAIL

- [ ] **Step 3: 発行操作を実装する**

  - **クリックして落ち着くのを待つ共通処理**: クリックの前にダウンロードと新しいタブの発生を監視し、クリック後、(a) ダウンロードが始まった、(b) 新しいタブが開いて読み込みが済んだ、(c) 今のタブの画面種別が変わった、のどれかまで待つ。新しいタブが開いたらそれを操作対象にする。ダウンロードは保持しておく。`open_receipt`・`go_to_confirm`・`submit_issue` がこれを使う。待ち時間は `submit_issue` だけ `ISSUE_TIMEOUT_MS`、ほかは `timeout_ms`。
  - `open_receipt`: 一覧ページを `list_url` に戻す。`detect_screen` が `LOGIN` ならそれを返す。`page_index` 回だけ次ページへ進み、予約番号を含むまとまりの中の `TEXT_RECEIPT_LINK` を共通処理でクリックし、移った先の `detect_screen` を返す。ダウンロードが直接始まった場合は `RECEIPT` を返す。まとまりが見つからなければ `UnexpectedScreen("open_receipt")`。
  - `fill_addressee`: 宛名の欄は、ラベルに「宛名」を含む表示中の入力欄がちょうど1つならそれ、なければ表示中のテキスト入力欄がちょうど1つならそれ。決まらなければ `UnexpectedScreen("fill_addressee")`。敬称は、文言が一致するラジオを選ぶ。ラジオがなければ `select` の該当する選択肢を選ぶ。**入力後に、欄の値が `name` と等しいこと、敬称が選ばれていることを読み直して確かめ、違えば `UnexpectedScreen("fill_addressee")`。**
  - `go_to_confirm`: `TEXT_GO_CONFIRM` のボタンを共通処理でクリックし、`detect_screen` を返す。
  - `read_confirm_text`: 操作対象ページの `body` の `inner_text`。
  - `submit_issue`: 文言がちょうど `TEXT_SUBMIT` のボタンかリンクを共通処理でクリックする。
  - `save_receipt`: 保持しているダウンロードがあれば `save_as(path)`。なければ操作対象ページが `RECEIPT` であることを確かめ(違えば `UnexpectedScreen("save_receipt")`)、`emulate_media(media="print")` のうえ `page.pdf(path=..., format="A4", print_background=True)`。親フォルダがなければ作る。
  - `save_diagnostics`: `debug_dir/{YYYYmmdd-HHMMSS}_{label}.png`(ページ全体)と `.html` を書き、`.png` のパスを返す。`label` はファイル名に使えない文字を `_` にする。どんな例外も握りつぶして `None` を返す。
  - `close_flow`: 操作対象が一覧ページと別のタブなら閉じる。保持しているダウンロードと操作対象を捨てる。
  - 要素が時間内に見つからない Playwright の `TimeoutError` は、どのメソッドでも `UnexpectedScreen(メソッド名)` に変えて送出する。

- [ ] **Step 4: 通ることを確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_site_flow.py rakuten_receipts/tests/test_site_read.py -q`
  Expected: 全件 PASS

- [ ] **Step 5: コミット**

  ```bash
  git add rakuten_receipts
  git commit -m "領収書ツール: 領収書の発行操作と PDF 保存を追加"
  ```

---

### Task 6: `browser`・`cli`・README

**Files:**
- Create: `rakuten_receipts/browser.py`, `rakuten_receipts/cli.py`, `rakuten_receipts/__main__.py`, `rakuten_receipts/README.md`
- Test: `rakuten_receipts/tests/test_browser.py`, `rakuten_receipts/tests/test_cli.py`

**Interfaces:**
- Consumes: `Site`・`detect_screen`(Task 4・5)、`run_list`・`run_download`・`Options`・`Summary`・`ListUnreadable`(Task 3)、`Ledger`(Task 2)、`validate_addressee`・`TITLES`(Task 1)
- Produces:

  ```python
  # browser.py
  PROFILE_DIR = Path.home() / "Library" / "Application Support" / "rakuten-receipts" / "profile"
  START_URL = "https://travel.rakuten.co.jp/"
  class BrowserLaunchError(Exception)
  @contextmanager
  def open_session(profile_dir: Path = PROFILE_DIR, headless: bool = False) -> Iterator[BrowserContext]
  def find_list_page(context: BrowserContext) -> Optional[Page]

  # cli.py
  REPO_ROOT = Path(__file__).resolve().parent.parent
  DEFAULT_OUT = Path.home() / "Documents" / "rakuten-receipts"
  LIST_TAB_RETRIES = 3
  class ConsoleUI                       # info / confirm / wait_enter を print と input で実装
  def build_parser() -> argparse.ArgumentParser
  def main(argv: Optional[List[str]] = None, *, open_session=browser.open_session, ui=None, start_url: str = browser.START_URL) -> int
  ```

- [ ] **Step 1: 失敗するテストを書く**

  `test_browser.py`:

  ```python
  def test_open_session_falls_back_to_bundled_chromium(tmp_path):
      # この環境に Google Chrome はないので、同梱 Chromium への切り替えを通る
      with open_session(tmp_path / "profile", headless=True) as ctx:
          assert len(ctx.pages) >= 1
  def test_open_session_creates_profile_dir(tmp_path)
  def test_find_list_page_picks_list_tab():   # unknown.html と list_p1.html の2タブ → list_p1 のタブ
  def test_find_list_page_none():             # unknown.html だけ → None
  ```

  `test_cli.py` の前提:

  - ブラウザを開かないはずのテストでは、`open_session` に呼ばれた回数を数える偽物を渡す。
  - ダミーサイトを使うテストでは、`browser.open_session(tmp_path / "profile", headless=True)` を呼び、得た `BrowserContext` を控えておく包みを渡す。`start_url` は `dummy_site + "unknown.html"`。
  - `ui` は conftest の `FakeUI` を拡張し、`wait_enter` のたびにコールバックを呼べるようにする。コールバックは控えた `BrowserContext` の最初のタブを `dummy_site + "list_p1.html"` へ移動させる(人がログインして一覧を開く操作の代わり)。
  - 待ち時間をなくすため、通しテストでは `monkeypatch.setattr(runner, "INTERVAL_SECONDS", (0.0, 0.0))` とする。

  ```python
  # 引数(ブラウザを開かない。終了コード 2)
  def test_download_requires_name_and_title()
  def test_title_must_be_sama_or_onchu()
  def test_bad_date_format()
  def test_from_after_to()
  def test_limit_must_be_positive()
  def test_out_inside_repo_is_error():        # --out が REPO_ROOT/"x" → 2、open_session は呼ばれない
  def test_invalid_addressee_exits_before_browser():  # --name "㈱サンプル" → 2、open_session は呼ばれない、理由が出力される
  def test_name_is_stripped():                # --name " 株式会社サンプル " → 前後の空白なしで使われる

  # 起動と一覧タブ
  def test_browser_launch_error_is_exit_1():  # open_session が BrowserLaunchError("...") → 1、文言が出力され、トレースは出ない
  def test_no_list_tab_reprompts_then_exit_1():
      # 最後まで unknown.html のまま → wait_enter は LIST_TAB_RETRIES 回、戻り値 1、out/debug に診断ファイル
  def test_list_tab_found_on_second_try():    # 1回目の Enter では unknown.html、2回目の前に list_p1.html へ移動 → 0

  # ダミーサイトでの通し(ヘッドレス)
  def test_e2e_list():
      # main(["list", "--out", str(out)], ...) == 0。out は自動で作られる。receipts.csv に6行
  def test_e2e_download():
      # main(["download", "--out", str(out), "--name", "株式会社サンプル", "--title", "御中"], ...)、answers=[True, True]
      # → 0。PDF は RY001・RY003・RY004 の3つ。台帳は RY002 対象外、RY005・RY006 要確認、RY004 のメモ "発行済みを再表示"
      # out/debug に RY005 と RY006 の診断ファイル
  def test_e2e_download_range():              # --from 2025-03-15 --to 2025-03-31 → PDF は RY001 と RY003 だけ
  def test_e2e_list_unreadable_saves_diagnostics():
      # Enter のコールバックで list_empty.html を開く(LIST と判定されるが予約は0件)
      # → 1。out/debug に診断ファイル、receipts.csv は作られない
  def test_abort_is_exit_1(monkeypatch):
      # monkeypatch.setattr(cli, "run_download", lambda *a, **k: Summary(aborted=True)) → 1
  def test_keep_browser_open_waits_for_enter(monkeypatch):
      # run_download が Summary(keep_browser_open=True) を返す → セッションを閉じる前に wait_enter がもう1回呼ばれる
  def test_ctrl_c_is_exit_130():              # ui.wait_enter が KeyboardInterrupt → 130
  def test_module_help():                     # subprocess で `python -m rakuten_receipts --help` → 終了コード 0、"list" と "download" を含む
  ```

- [ ] **Step 2: 失敗を確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests/test_browser.py rakuten_receipts/tests/test_cli.py -q`
  Expected: `No module named 'rakuten_receipts.browser'` で収集エラー

- [ ] **Step 3: `browser.py` を実装する**

  - `open_session`: プロファイルのフォルダを作り、`launch_persistent_context(profile_dir, channel="chrome", headless=headless, accept_downloads=True, locale="ja-JP")`。Playwright の `Error` で失敗したら `channel` なしでもう一度試す。それも失敗したら `BrowserLaunchError`。文言は「ブラウザを起動できませんでした。前回のブラウザが開いたままなら閉じてください。Chrome がない場合は `python -m playwright install chromium` を実行してください」に元のエラーの1行目を添える。終了時にコンテキストを閉じる。起動オプションはこれ以外に足さない。
  - `find_list_page`: 新しいタブから順に `site.detect_screen` が `LIST` を返す最初のタブ。なければ `None`。

- [ ] **Step 4: `cli.py` と `__main__.py` を実装する**

  - サブコマンド `list` と `download`。共通の引数は `--from`・`--to`(`YYYY-MM-DD`)と `--out`(既定 `DEFAULT_OUT`)。`download` は `--name`(必須)、`--title`(必須、`choices=TITLES`)、`--limit`(1以上の整数)。
  - ブラウザを開く前の検査(違反は理由を出して 2 を返す): `--from` が `--to` より後、`--out` が `REPO_ROOT` と同じかその配下(`resolve()` して比べる)、`validate_addressee(name.strip())` が空でない。
  - 流れ: 出力先を作る → `open_session()` → 最初のタブで `start_url` を開く → `ui.wait_enter("ログインして、予約確認の国内宿泊で過去の予約一覧を表示したら Enter を押してください")` → `find_list_page`。見つからなければ「予約一覧のタブが見つかりません」と案内して待ち直す(合計 `LIST_TAB_RETRIES` 回)。最後まで見つからなければ、開いている全タブのスクリーンショットと HTML を `out/debug/` に保存して 1。
  - 見つかったら `Site(context, list_page, out / "debug")` と `Ledger(out / "receipts.csv")` を作り、`run_list` か `run_download` を呼ぶ。`ListUnreadable` になったら `site.save_diagnostics("list")` を呼んでから 1 を返す。
  - `download` の後は 取得・要確認・失敗 の件数と台帳の場所を出す。`Summary.keep_browser_open` なら、セッションを閉じる前に `ui.wait_enter("ブラウザを開いたままにしています。領収書を手で保存したら Enter を押してください")`。
  - 終了コード: 正常 0(要確認があっても 0)、`ListUnreadable`・`BrowserLaunchError`・`Summary.aborted` は 1、引数の誤りは 2、`KeyboardInterrupt` は 130。1 と 130 では1行のメッセージだけを出し、トレースは出さない。
  - `ConsoleUI.confirm` は入力が `y` / `Y` / `yes` のときだけ真。
  - `__main__.py` は `sys.exit(main())` だけ。

- [ ] **Step 5: 通ることを確認する**

  Run: `.venv/bin/python -m pytest rakuten_receipts/tests -q`
  Expected: 全タスクのテストが全件 PASS

- [ ] **Step 6: Python 3.9 で動く書き方かを確かめる**

  Run: `.venv/bin/vermin -t=3.9- --no-tips rakuten_receipts/*.py`
  Expected: `Minimum required versions:` が 3.9 以下で、`Target versions not met` が出ない

- [ ] **Step 7: `README.md` を書く**

  日本語で、次の節をこの順に置く。

  1. **これは何か**: 2〜3文。対象は国内宿泊のオンラインカード決済だけであること。
  2. **注意**: 宛名の修正は1回限りであること。楽天の規約が自動操作を禁じているかは確認できておらず、利用は自己判断であること。ログイン後の実画面では未検証で、初回は調整が要る見込みであること。
  3. **セットアップ**(Mac): Python 3.9 以上。`python3 -m venv .venv`、`.venv/bin/pip install -r rakuten_receipts/requirements.txt`。Google Chrome がなければ `.venv/bin/python -m playwright install chromium`。コマンドは1つずつ別のコードブロックにする。
  4. **使い方**: 設計書の「利用者の Mac での確認」の3段階(`list` → `download --limit 1` → 残り)。引数の表。
  5. **保存されるもの**: PDF の名前、`receipts.csv` の列と状態の意味、ログイン状態の保存先。
  6. **うまく動かないとき**: `debug/` の診断ファイルの見方。個人情報が含まれるので、公開リポジトリにコミットしないこと、人に見せる前に中身を確認すること。
  7. **配布上の注意**: `publish_public.sh` が `rsync --delete` で同期するので、元フォルダにも `rakuten_receipts/` と `docs/` を置くこと。
  8. **テスト**: `.venv/bin/pip install -r rakuten_receipts/requirements-dev.txt` と `.venv/bin/python -m pytest rakuten_receipts/tests -q`。テストはダミーページに対するもので、本物の楽天には接続しないこと。

- [ ] **Step 8: コミットしてプッシュ**

  ```bash
  git add rakuten_receipts
  git commit -m "領収書ツール: ブラウザ起動・コマンドライン・README を追加"
  git push -u origin claude/dazzling-edison-ltz6j5
  ```

---

## 実装後に利用者が行うこと(この計画の範囲外)

テストが保証するのは「想定した画面構成に対して正しく動くこと」まで。本物の画面での確認は、利用者が Mac で README の3段階を実行して行う。`list` が実画面と合わなければ、`debug/` の診断ファイルをもとに `site.py` の定数と読み取り方を直す。
