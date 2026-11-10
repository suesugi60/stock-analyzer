from __future__ import annotations

from datetime import date

import pytest

from rakuten_receipts import runner
from rakuten_receipts.ledger import Ledger
from rakuten_receipts.models import Reservation, Screen, Status, UnexpectedScreen
from rakuten_receipts.runner import ListUnreadable, Summary, run_download, run_list

# 通常の流れで最初の1件に出る確認: 入力画面(INPUT)→ 確認画面(FIRST)→ 残りを続けるか(REST)
INPUT, FIRST = runner.CONFIRM_INPUT, runner.CONFIRM_FIRST


def rest(n):
    return runner.CONFIRM_REST.format(n=n)


class Sleeps(list):
    def __call__(self, seconds):
        self.append(seconds)


def status(ledger, rid):
    return ledger.rows[rid].status


def on_disk(ledger, rid):
    """台帳ファイルに実際に書かれている状態(プロセスが落ちても残るもの)。"""
    return Ledger(ledger.path).rows[rid].status


def download(site, ledger, opts, ui):
    sleeps = Sleeps()
    summary = run_download(site, ledger, opts, ui, sleep=sleeps)
    return summary, sleeps


def mark_maybe_issued(ledger, reservations, rid="RY001"):
    ledger.sync(reservations)
    ledger.mark(rid, Status.FAILED_AFTER_ISSUE, memo="前回の実行")


# --- list ---

def test_list_syncs_and_returns(make_site, make_ui, ledger, opts):
    rs = [Reservation("RY001", "ホテルA", date(2025, 3, 15), None, 12000, True),
          Reservation("RY002", "ホテルB", date(2025, 3, 20), None, 8000, False)]
    ui = make_ui()
    assert run_list(make_site(rs), ledger, opts, ui) == rs
    assert status(ledger, "RY001") is Status.PENDING
    assert status(ledger, "RY002") is Status.EXCLUDED
    shown = "\n".join(ui.infos)
    assert "RY001" in shown and "ホテルB" in shown and "対象外" in shown


def test_list_zero_raises_and_leaves_ledger(make_site, make_ui, ledger, opts):
    with pytest.raises(ListUnreadable):
        run_list(make_site([]), ledger, opts, make_ui())
    assert not ledger.path.exists()


def test_list_shows_only_the_requested_range(make_site, make_ui, ledger, opts):
    rs = [Reservation("RY001", "一月の宿", date(2025, 1, 10), None, 1, True),
          Reservation("RY002", "三月の宿", date(2025, 3, 15), None, 1, True),
          Reservation("RY003", "日付のない宿", None, None, 1, True)]
    opts.date_from, opts.date_to = date(2025, 3, 1), date(2025, 3, 31)
    ui = make_ui()
    assert run_list(make_site(rs), ledger, opts, ui) == rs  # 読んだ全件を返し、台帳にも全件入れる
    assert set(ledger.rows) == {"RY001", "RY002", "RY003"}
    shown = "\n".join(ui.infos)
    assert "三月の宿" in shown
    assert "一月の宿" not in shown and "日付のない宿" not in shown
    assert "期間外" in shown and "2 件" in shown


# --- download: 人による確認 ---

def test_input_check_no_means_nothing_clicked(make_site, make_ui, ledger, opts, reservations_factory):
    site, ui = make_site(reservations_factory(2)), make_ui([False])
    summary, sleeps = download(site, ledger, opts, ui)
    assert site.ops("go_confirm") == [] and site.ops("submit") == []
    assert summary == Summary(stopped=True)
    assert on_disk(ledger, "RY001") is Status.PENDING
    assert ui.confirms == [INPUT]
    assert sleeps == []


def test_first_confirm_no_means_no_submit(make_site, make_ui, ledger, opts, reservations_factory):
    site, ui = make_site(reservations_factory(2)), make_ui([True, False])
    summary, sleeps = download(site, ledger, opts, ui)
    assert site.ops("submit") == []
    assert summary == Summary(stopped=True)
    assert on_disk(ledger, "RY001") is Status.PENDING  # 発行していないので、元の状態のまま
    assert site.ops("open") == ["RY001"]
    assert ui.confirms == [INPUT, FIRST]
    assert sleeps == []


def test_happy_path_two_items(make_site, make_ui, ledger, opts, out_dir, reservations_factory):
    site, ui = make_site(reservations_factory(2)), make_ui([True, True, True])
    summary, sleeps = download(site, ledger, opts, ui)
    assert summary == Summary(done=2)
    assert on_disk(ledger, "RY001") is Status.DONE and on_disk(ledger, "RY002") is Status.DONE
    assert sorted(p.name for p in out_dir.glob("*.pdf")) == [
        "2025-03-15_ホテルA_RY001.pdf", "2025-03-16_ホテルA_RY002.pdf"]
    assert ledger.rows["RY001"].filename == "2025-03-15_ホテルA_RY001.pdf"
    assert ledger.rows["RY001"].memo == ""
    assert site.filled == [("RY001", "株式会社サンプル", "御中"), ("RY002", "株式会社サンプル", "御中")]
    assert len(sleeps) == 1 and 3.0 <= sleeps[0] <= 6.0
    assert ui.confirms == [INPUT, FIRST, rest(1)]
    assert any("株式会社サンプル" in m and "御中" in m for m in ui.infos)


def test_second_confirm_no_stops_after_first(make_site, make_ui, ledger, opts, reservations_factory):
    site, ui = make_site(reservations_factory(2)), make_ui([True, True, False])
    summary, sleeps = download(site, ledger, opts, ui)
    assert summary == Summary(done=1, stopped=True)
    assert site.ops("open") == ["RY001"]
    assert status(ledger, "RY002") is Status.PENDING
    assert sleeps == []


def test_single_target_asks_once(make_site, make_ui, ledger, opts, reservations_factory):
    site, ui = make_site(reservations_factory(1)), make_ui([True, True])
    summary, _ = download(site, ledger, opts, ui)
    assert summary == Summary(done=1)
    assert ui.confirms == [INPUT, FIRST]


def test_human_confirm_on_first_item_reaching_confirm(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(2), {"RY001": {"open": Screen.ADDRESSEE_FIX}})
    ui = make_ui([True, True])
    summary, _ = download(site, ledger, opts, ui)
    assert status(ledger, "RY001") is Status.REVIEW and status(ledger, "RY002") is Status.DONE
    # 確認は RY002 で出る。入力画面の確認は「領収書の発行」を押す前、確認画面の確認は「発行する」を押す前
    assert site.calls.index(("fill", "RY002")) < site.calls.index(("go_confirm", "RY002"))
    assert site.calls.index(("read_confirm", "RY002")) < site.calls.index(("submit", "RY002"))
    assert ui.confirms == [INPUT, FIRST]
    assert summary == Summary(done=1, review=1)


def test_human_check_shows_what_the_page_says(make_site, make_ui, ledger, opts, reservations_factory):
    # 指定した宛名を復唱するのではなく、確認画面から読み取った文字を見せる
    text = "宛名の確認\n宛名 株式会社サンプル\n敬称 御中\n但し書き 宿泊代として\n発行する"
    site = make_site(reservations_factory(1), {"RY001": {"confirm_text": text}})
    ui = make_ui([True, True])
    download(site, ledger, opts, ui)
    shown = [m for m in ui.infos if "確認画面" in m]
    assert shown and "宛名 株式会社サンプル" in shown[-1] and "敬称 御中" in shown[-1]


# --- download: フェイルクローズ ---

def test_confirm_text_mismatch_is_review(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"confirm_text": "宛名 株式会社見本 御中"}})
    ui = make_ui([True])
    summary, _ = download(site, ledger, opts, ui)
    assert site.ops("submit") == []
    assert on_disk(ledger, "RY001") is Status.REVIEW
    assert ledger.rows["RY001"].memo == runner.MEMO_MISMATCH
    assert ui.confirms == [INPUT]  # 一致しないので、発行の確認までは進まない
    assert summary == Summary(review=1)


@pytest.mark.parametrize("screen", [Screen.ADDRESSEE_FIX, Screen.ADDRESSEE_INPUT])
def test_form_after_go_to_confirm_is_review(make_site, make_ui, ledger, opts, reservations_factory, screen):
    # 「領収書の発行」の後に入力欄のある画面が出た。「発行する」は押していないので未発行
    site = make_site(reservations_factory(2), {"RY001": {"confirm_screen": screen}})
    summary, _ = download(site, ledger, opts, make_ui([True, True]))
    assert "RY001" not in site.ops("read_confirm") and "RY001" not in site.ops("submit")
    assert on_disk(ledger, "RY001") is Status.REVIEW
    assert on_disk(ledger, "RY002") is Status.DONE  # 次の予約へ進む


@pytest.mark.parametrize("screen", [Screen.UNKNOWN, Screen.LIST])
def test_unknown_screen_after_go_to_confirm_is_maybe_issued(make_site, make_ui, ledger, opts,
                                                             reservations_factory, screen):
    # 「領収書の発行」の後、確認画面にも領収書にもならなかった。発行されたかどうか分からないので止まる
    site = make_site(reservations_factory(2), {"RY001": {"confirm_screen": screen}})
    summary, sleeps = download(site, ledger, opts, make_ui([True]))
    assert site.ops("read_confirm") == [] and site.ops("submit") == []
    assert on_disk(ledger, "RY001") is Status.FAILED_AFTER_ISSUE
    assert ledger.rows["RY001"].memo == runner.MEMO_AFTER_GO
    assert summary == Summary(failed=1, keep_browser_open=True)
    assert site.ops("open") == ["RY001"] and site.ops("close") == []
    assert site.ops("diag") == ["RY001"]


def test_fix_screen_is_review_without_fill(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"open": Screen.ADDRESSEE_FIX}})
    download(site, ledger, opts, make_ui())
    assert site.ops("fill") == [] and site.ops("go_confirm") == [] and site.ops("submit") == []
    assert status(ledger, "RY001") is Status.REVIEW
    assert ledger.rows["RY001"].memo == runner.MEMO_FIX


@pytest.mark.parametrize("screen", [Screen.UNKNOWN, Screen.LIST, Screen.CONFIRM])
def test_unknown_screen_is_review_with_diagnostics(make_site, make_ui, ledger, opts, reservations_factory, screen):
    site = make_site(reservations_factory(1), {"RY001": {"open": screen}})
    download(site, ledger, opts, make_ui())
    assert site.ops("fill") == [] and site.ops("submit") == [] and site.ops("save") == []
    assert status(ledger, "RY001") is Status.REVIEW
    assert site.ops("diag") == ["RY001"]
    assert "RY001" in site.diag_labels[0]


def test_already_issued_saved_with_memo(make_site, make_ui, ledger, opts, out_dir, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"open": Screen.RECEIPT}})
    ui = make_ui()
    summary, _ = download(site, ledger, opts, ui)
    assert site.ops("fill") == [] and site.ops("submit") == []
    assert site.ops("save") == ["RY001"]
    assert status(ledger, "RY001") is Status.DONE
    assert ledger.rows["RY001"].memo == runner.MEMO_REDISPLAY == "発行済みを再表示"
    assert ui.confirms == []
    assert (out_dir / "2025-03-15_ホテルA_RY001.pdf").exists()
    assert summary == Summary(done=1)


def test_existing_pdf_is_not_overwritten(make_site, make_ui, ledger, opts, out_dir, reservations_factory):
    out_dir.mkdir(parents=True)
    (out_dir / "2025-03-15_ホテルA_RY001.pdf").write_bytes(b"old")
    site = make_site(reservations_factory(1), {"RY001": {"open": Screen.RECEIPT}})
    download(site, ledger, opts, make_ui())
    assert (out_dir / "2025-03-15_ホテルA_RY001.pdf").read_bytes() == b"old"
    assert ledger.rows["RY001"].filename == "2025-03-15_ホテルA_RY001_2.pdf"


def test_three_consecutive_failures_abort(make_site, make_ui, ledger, opts, reservations_factory):
    scripts = {f"RY00{i}": {"open": Screen.UNKNOWN} for i in range(1, 5)}
    site = make_site(reservations_factory(4), scripts)
    summary, sleeps = download(site, ledger, opts, make_ui())
    assert summary == Summary(review=3, aborted=True)
    assert site.ops("open") == ["RY001", "RY002", "RY003"]
    assert status(ledger, "RY004") is Status.PENDING
    assert len(sleeps) == 2


def test_failure_counter_resets_on_success(make_site, make_ui, ledger, opts, reservations_factory):
    scripts = {rid: {"open": Screen.UNKNOWN} for rid in ("RY001", "RY002", "RY004", "RY005")}
    site = make_site(reservations_factory(5), scripts)
    summary, _ = download(site, ledger, opts, make_ui([True, True, True]))
    assert summary == Summary(done=1, review=4)
    assert site.ops("open") == ["RY001", "RY002", "RY003", "RY004", "RY005"]


# --- download: サイトが確認画面を出さずに発行する場合 ---

def test_direct_issue_is_saved_and_asks_before_continuing(make_site, make_ui, ledger, opts, reservations_factory):
    scripts = {rid: {"confirm_screen": Screen.RECEIPT} for rid in ("RY001", "RY002", "RY003")}
    site = make_site(reservations_factory(3), scripts)
    ui = make_ui([True, True])
    summary, _ = download(site, ledger, opts, ui)
    assert summary == Summary(done=3)
    assert site.ops("save") == ["RY001", "RY002", "RY003"] and site.ops("submit") == []
    assert ledger.rows["RY001"].memo == runner.MEMO_NO_CONFIRM
    # 1件目は入力画面で確認し、発行された後にも続けるかを聞く。以降は聞かない
    assert ui.confirms == [INPUT, runner.CONFIRM_DIRECT.format(n=2)]


def test_direct_issue_declined_stops(make_site, make_ui, ledger, opts, reservations_factory):
    scripts = {rid: {"confirm_screen": Screen.RECEIPT} for rid in ("RY001", "RY002")}
    site = make_site(reservations_factory(2), scripts)
    summary, _ = download(site, ledger, opts, make_ui([True, False]))
    assert summary == Summary(done=1, stopped=True)
    assert site.ops("open") == ["RY001"]
    assert on_disk(ledger, "RY001") is Status.DONE and on_disk(ledger, "RY002") is Status.PENDING


def test_direct_issue_single_target_does_not_ask_to_continue(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"confirm_screen": Screen.RECEIPT}})
    ui = make_ui([True])
    summary, _ = download(site, ledger, opts, ui)
    assert summary == Summary(done=1) and ui.confirms == [INPUT]


def test_direct_issue_save_failure_is_maybe_issued(make_site, make_ui, ledger, opts, reservations_factory):
    scripts = {"RY001": {"confirm_screen": Screen.RECEIPT, "save_raises": RuntimeError("disk full")}}
    site = make_site(reservations_factory(2), scripts)
    summary, _ = download(site, ledger, opts, make_ui([True]))
    assert on_disk(ledger, "RY001") is Status.FAILED_AFTER_ISSUE
    assert summary == Summary(failed=1, keep_browser_open=True)


# --- download: 発行済みかもしれない予約には、二度と入力しない ---

def test_rerun_of_maybe_issued_row_never_types(make_site, make_ui, ledger, opts, reservations_factory):
    rs = reservations_factory(1)
    mark_maybe_issued(ledger, rs)
    site, ui = make_site(rs), make_ui()  # サイトは入力画面を出す(修正画面かもしれない)
    summary, _ = download(site, ledger, opts, ui)
    assert site.ops("open") == ["RY001"]
    assert site.ops("fill") == [] and site.ops("go_confirm") == [] and site.ops("submit") == []
    assert on_disk(ledger, "RY001") is Status.FAILED_AFTER_ISSUE  # 要確認に下げない(次の実行でも入力させない)
    assert ledger.rows["RY001"].memo == runner.MEMO_MAYBE_ISSUED
    assert ui.confirms == []
    assert summary == Summary(failed=1)


def test_rerun_of_maybe_issued_row_saves_when_receipt_is_shown(make_site, make_ui, ledger, opts,
                                                               reservations_factory):
    rs = reservations_factory(1)
    mark_maybe_issued(ledger, rs)
    site = make_site(rs, {"RY001": {"open": Screen.RECEIPT}})
    summary, _ = download(site, ledger, opts, make_ui())
    assert on_disk(ledger, "RY001") is Status.DONE
    assert site.ops("fill") == [] and site.ops("save") == ["RY001"]
    assert summary == Summary(done=1)


@pytest.mark.parametrize("script", [
    {"open": Screen.ADDRESSEE_FIX},
    {"open": Screen.UNKNOWN},
    {"open": [Screen.LOGIN, Screen.LOGIN]},
    {"open_raises": UnexpectedScreen("open_receipt")},
    {"open_raises": RuntimeError("boom")},
])
def test_rerun_of_maybe_issued_row_is_never_downgraded(make_site, make_ui, ledger, opts,
                                                       reservations_factory, script):
    rs = reservations_factory(1)
    mark_maybe_issued(ledger, rs)
    site = make_site(rs, {"RY001": script})
    download(site, ledger, opts, make_ui())
    assert on_disk(ledger, "RY001") is Status.FAILED_AFTER_ISSUE
    assert site.ops("fill") == [] and site.ops("submit") == []


def test_maybe_issued_row_does_not_stop_other_items(make_site, make_ui, ledger, opts, reservations_factory):
    rs = reservations_factory(2)
    mark_maybe_issued(ledger, rs, "RY001")
    site = make_site(rs)
    summary, _ = download(site, ledger, opts, make_ui([True, True]))
    assert on_disk(ledger, "RY002") is Status.DONE
    assert summary == Summary(done=1, failed=1)


# --- download: 発行につながるクリックの前に、台帳へ先に書く ---

def test_ledger_says_maybe_issued_while_clicks_are_in_flight(make_site, make_ui, ledger, opts,
                                                            reservations_factory):
    seen = {}
    scripts = {"RY001": {
        "on_go": lambda: seen.__setitem__("go", on_disk(ledger, "RY001")),
        "on_submit": lambda: seen.__setitem__("submit", on_disk(ledger, "RY001")),
    }}
    site = make_site(reservations_factory(1), scripts)
    download(site, ledger, opts, make_ui([True, True]))
    # クリックの瞬間にプロセスが落ちても、「発行済みかもしれない」が台帳に残る
    assert seen == {"go": Status.FAILED_AFTER_ISSUE, "submit": Status.FAILED_AFTER_ISSUE}
    assert on_disk(ledger, "RY001") is Status.DONE


@pytest.mark.parametrize("key", ["go_raises", "submit_raises", "save_raises"])
def test_ctrl_c_during_issue_leaves_maybe_issued(make_site, make_ui, ledger, opts, reservations_factory, key):
    site = make_site(reservations_factory(1), {"RY001": {key: KeyboardInterrupt()}})
    with pytest.raises(KeyboardInterrupt):
        run_download(site, ledger, opts, make_ui([True, True]), sleep=Sleeps())
    assert on_disk(ledger, "RY001") is Status.FAILED_AFTER_ISSUE


def test_ctrl_c_before_any_click_leaves_row_unchanged(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"fill_raises": KeyboardInterrupt()}})
    with pytest.raises(KeyboardInterrupt):
        run_download(site, ledger, opts, make_ui(), sleep=Sleeps())
    assert on_disk(ledger, "RY001") is Status.PENDING


@pytest.mark.parametrize("answers", [[KeyboardInterrupt()], [True, KeyboardInterrupt()]])
def test_ctrl_c_at_a_prompt_leaves_row_unchanged(make_site, make_ui, ledger, opts, reservations_factory, answers):
    # 確認の入力中に Ctrl+C。まだ「発行する」を押していないので、未取得のまま(次回ふつうにやり直せる)
    site = make_site(reservations_factory(1))
    with pytest.raises(KeyboardInterrupt):
        run_download(site, ledger, opts, make_ui(answers), sleep=Sleeps())
    assert on_disk(ledger, "RY001") is Status.PENDING
    assert site.ops("submit") == []


def test_no_click_when_the_ledger_cannot_be_written(make_site, make_ui, ledger, opts, reservations_factory,
                                                    monkeypatch):
    # 「発行済みかもしれない」を書けないなら、発行につながるクリックをしない
    real_mark = ledger.mark

    def failing_mark(rid, status, *args, **kwargs):
        if status is Status.FAILED_AFTER_ISSUE:
            raise OSError("disk full")
        return real_mark(rid, status, *args, **kwargs)

    monkeypatch.setattr(ledger, "mark", failing_mark)
    site = make_site(reservations_factory(1))
    download(site, ledger, opts, make_ui([True]))
    assert site.ops("go_confirm") == [] and site.ops("submit") == []
    assert on_disk(ledger, "RY001") is Status.FAILED


# --- download: 例外 ---

def test_save_failure_after_submit(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(2), {"RY001": {"save_raises": RuntimeError("disk full")}})
    ui = make_ui([True, True])
    summary, sleeps = download(site, ledger, opts, ui)
    assert on_disk(ledger, "RY001") is Status.FAILED_AFTER_ISSUE
    assert ledger.rows["RY001"].memo == runner.MEMO_AFTER_ISSUE
    assert summary == Summary(failed=1, keep_browser_open=True)
    assert site.ops("open") == ["RY001"]
    assert site.ops("diag") == ["RY001"]
    assert site.ops("close") == []  # 手で保存できるよう、開いたままにする
    assert sleeps == []


@pytest.mark.parametrize("key", ["go_raises", "submit_raises"])
def test_exception_during_issue_click_is_maybe_issued(make_site, make_ui, ledger, opts, reservations_factory, key):
    site = make_site(reservations_factory(2), {"RY001": {key: RuntimeError("timeout")}})
    summary, _ = download(site, ledger, opts, make_ui([True, True]))
    assert on_disk(ledger, "RY001") is Status.FAILED_AFTER_ISSUE
    assert summary.keep_browser_open and site.ops("open") == ["RY001"]


def test_unexpected_screen_after_submit_is_maybe_issued(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"save_raises": UnexpectedScreen("save_receipt")}})
    download(site, ledger, opts, make_ui([True, True]))
    assert on_disk(ledger, "RY001") is Status.FAILED_AFTER_ISSUE


def test_exception_before_any_click_is_failed(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(2), {"RY001": {"fill_raises": RuntimeError("boom")}})
    summary, _ = download(site, ledger, opts, make_ui([True, True]))
    assert on_disk(ledger, "RY001") is Status.FAILED
    assert "RY001" not in site.ops("go_confirm") and "RY001" not in site.ops("submit")
    assert site.ops("diag") == ["RY001"]
    assert on_disk(ledger, "RY002") is Status.DONE  # 発行前の失敗なら次へ進む
    assert summary == Summary(done=1, failed=1)


def test_unexpected_screen_before_any_click_is_review(make_site, make_ui, ledger, opts, reservations_factory):
    error = UnexpectedScreen("fill_addressee", detail="宛名欄に既に値が入っている")
    site = make_site(reservations_factory(1), {"RY001": {"fill_raises": error}})
    download(site, ledger, opts, make_ui())
    assert on_disk(ledger, "RY001") is Status.REVIEW
    memo = ledger.rows["RY001"].memo
    assert "fill_addressee" in memo and "宛名欄に既に値が入っている" in memo  # 原因が台帳で分かる
    assert site.ops("go_confirm") == [] and site.ops("submit") == []


# --- download: ログイン切れ ---

def test_login_screen_prompts_and_retries_once(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"open": [Screen.LOGIN, Screen.ADDRESSEE_INPUT]}})
    ui = make_ui([True, True])
    summary, _ = download(site, ledger, opts, ui)
    assert ui.enters == [runner.RELOGIN]
    assert site.ops("open") == ["RY001", "RY001"]
    assert summary == Summary(done=1)


def test_login_twice_is_failed(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"open": [Screen.LOGIN, Screen.LOGIN]}})
    ui = make_ui()
    summary, _ = download(site, ledger, opts, ui)
    assert status(ledger, "RY001") is Status.FAILED
    assert site.ops("fill") == [] and len(ui.enters) == 1
    assert summary == Summary(failed=1)


def test_login_at_go_to_confirm_retries_once(make_site, make_ui, ledger, opts, reservations_factory):
    # 「領収書の発行」を押したらログイン画面に戻された。何も発行されていないので、ログインし直してやり直す
    site = make_site(reservations_factory(1), {"RY001": {"confirm_screen": [Screen.LOGIN, Screen.CONFIRM]}})
    ui = make_ui([True, True])
    summary, _ = download(site, ledger, opts, ui)
    assert ui.enters == [runner.RELOGIN]
    assert site.ops("open") == ["RY001", "RY001"]
    assert ui.confirms == [INPUT, FIRST]  # 入力画面の確認は1回だけ
    assert on_disk(ledger, "RY001") is Status.DONE
    assert summary == Summary(done=1)


def test_login_twice_at_go_to_confirm_is_failed_not_maybe_issued(make_site, make_ui, ledger, opts,
                                                                 reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"confirm_screen": [Screen.LOGIN, Screen.LOGIN]}})
    summary, _ = download(site, ledger, opts, make_ui([True]))
    assert on_disk(ledger, "RY001") is Status.FAILED
    assert site.ops("submit") == []
    assert summary == Summary(failed=1)


# --- download: 対象の絞り込み ---

def test_limit_counts_review_items(make_site, make_ui, ledger, opts, reservations_factory):
    opts.limit = 2
    site = make_site(reservations_factory(3), {"RY001": {"open": Screen.UNKNOWN}})
    summary, _ = download(site, ledger, opts, make_ui([True, True]))
    assert site.ops("open") == ["RY001", "RY002"]
    assert summary == Summary(done=1, review=1)
    assert status(ledger, "RY003") is Status.PENDING


def test_range_filter_and_undated_notice(make_site, make_ui, ledger, opts):
    rs = [Reservation("RY001", "ホテルA", date(2025, 3, 15), None, 12000, True),
          Reservation("RY002", "ホテルB", None, None, None, True),
          Reservation("RY003", "ホテルC", date(2024, 12, 31), None, 5000, True)]
    opts.date_from = date(2025, 1, 1)
    site, ui = make_site(rs), make_ui([True, True])
    download(site, ledger, opts, ui)
    assert site.ops("open") == ["RY001"]
    assert any("日付不明のため対象外: 1 件" in m for m in ui.infos)


def test_no_undated_notice_without_range(make_site, make_ui, ledger, opts):
    rs = [Reservation("RY002", "ホテルB", None, None, None, True)]
    site, ui = make_site(rs), make_ui([True, True])
    download(site, ledger, opts, ui)
    assert site.ops("open") == ["RY002"]
    assert not any("日付不明のため対象外" in m for m in ui.infos)


def test_no_targets_returns_empty_summary(make_site, make_ui, ledger, opts, reservations_factory):
    rs = reservations_factory(2)
    ledger.sync(rs)
    ledger.mark("RY001", Status.DONE, "a.pdf")
    ledger.mark("RY002", Status.DONE, "b.pdf")
    site, ui = make_site(rs), make_ui()
    summary, _ = download(site, ledger, opts, ui)
    assert summary == Summary()
    assert ui.confirms == [] and site.ops("open") == []


def test_done_items_are_skipped_on_rerun(make_site, make_ui, ledger, opts, reservations_factory):
    rs = reservations_factory(2)
    download(make_site(rs), ledger, opts, make_ui([True, True, False]))  # 1件目だけ取得して止める
    site = make_site(rs)
    download(site, ledger, opts, make_ui([True, True]))
    assert site.ops("open") == ["RY002"]


def test_close_flow_called_for_every_item(make_site, make_ui, ledger, opts, reservations_factory):
    scripts = {"RY002": {"open": Screen.UNKNOWN}, "RY003": {"open": Screen.RECEIPT}}
    site = make_site(reservations_factory(3), scripts)
    download(site, ledger, opts, make_ui([True, True, True]))
    assert site.ops("close") == ["RY001", "RY002", "RY003"]
