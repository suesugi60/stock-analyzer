from __future__ import annotations

from datetime import date

import pytest

from rakuten_receipts import runner
from rakuten_receipts.models import Reservation, Screen, Status, UnexpectedScreen
from rakuten_receipts.runner import ListUnreadable, Summary, run_download, run_list


class Sleeps(list):
    def __call__(self, seconds):
        self.append(seconds)


def status(ledger, rid):
    return ledger.rows[rid].status


def download(site, ledger, opts, ui):
    sleeps = Sleeps()
    summary = run_download(site, ledger, opts, ui, sleep=sleeps)
    return summary, sleeps


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


# --- download: 人による確認 ---

def test_first_confirm_no_means_no_submit(make_site, make_ui, ledger, opts, reservations_factory):
    site, ui = make_site(reservations_factory(2)), make_ui([False])
    summary, sleeps = download(site, ledger, opts, ui)
    assert site.ops("submit") == []
    assert summary.stopped and summary.done == 0
    assert status(ledger, "RY001") is Status.PENDING
    assert site.ops("open") == ["RY001"]
    assert ui.confirms == [runner.CONFIRM_FIRST]
    assert sleeps == []


def test_happy_path_two_items(make_site, make_ui, ledger, opts, out_dir, reservations_factory):
    site, ui = make_site(reservations_factory(2)), make_ui([True, True])
    summary, sleeps = download(site, ledger, opts, ui)
    assert summary == Summary(done=2)
    assert status(ledger, "RY001") is Status.DONE and status(ledger, "RY002") is Status.DONE
    assert sorted(p.name for p in out_dir.glob("*.pdf")) == [
        "2025-03-15_ホテルA_RY001.pdf", "2025-03-16_ホテルA_RY002.pdf"]
    assert ledger.rows["RY001"].filename == "2025-03-15_ホテルA_RY001.pdf"
    assert site.filled == [("RY001", "株式会社サンプル", "御中"), ("RY002", "株式会社サンプル", "御中")]
    assert len(sleeps) == 1 and 3.0 <= sleeps[0] <= 6.0
    assert ui.confirms == [runner.CONFIRM_FIRST, runner.CONFIRM_REST.format(n=1)]
    assert any("株式会社サンプル" in m and "御中" in m for m in ui.infos)


def test_second_confirm_no_stops_after_first(make_site, make_ui, ledger, opts, reservations_factory):
    site, ui = make_site(reservations_factory(2)), make_ui([True, False])
    summary, sleeps = download(site, ledger, opts, ui)
    assert summary.done == 1 and summary.stopped
    assert site.ops("open") == ["RY001"]
    assert status(ledger, "RY002") is Status.PENDING
    assert sleeps == []


def test_single_target_asks_once(make_site, make_ui, ledger, opts, reservations_factory):
    site, ui = make_site(reservations_factory(1)), make_ui([True])
    summary, _ = download(site, ledger, opts, ui)
    assert summary == Summary(done=1)
    assert ui.confirms == [runner.CONFIRM_FIRST]


def test_human_confirm_on_first_item_reaching_confirm(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(2), {"RY001": {"open": Screen.ADDRESSEE_FIX}})
    ui = make_ui([True])
    summary, _ = download(site, ledger, opts, ui)
    assert status(ledger, "RY001") is Status.REVIEW and status(ledger, "RY002") is Status.DONE
    # 確認は RY002 の確認画面まで進んでから出る
    assert site.calls.index(("read_confirm", "RY002")) < site.calls.index(("submit", "RY002"))
    assert ui.confirms == [runner.CONFIRM_FIRST]
    assert summary == Summary(done=1, review=1)


# --- download: フェイルクローズ ---

def test_confirm_text_mismatch_is_review(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"confirm_text": "株式会社見本 御中"}})
    summary, _ = download(site, ledger, opts, make_ui())
    assert site.ops("submit") == []
    assert status(ledger, "RY001") is Status.REVIEW
    assert ledger.rows["RY001"].memo == runner.MEMO_MISMATCH
    assert summary == Summary(review=1)


def test_confirm_screen_not_reached_is_review(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"confirm_screen": Screen.UNKNOWN}})
    download(site, ledger, opts, make_ui())
    assert site.ops("read_confirm") == [] and site.ops("submit") == []
    assert status(ledger, "RY001") is Status.REVIEW


def test_fix_screen_is_review_without_fill(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"open": Screen.ADDRESSEE_FIX}})
    download(site, ledger, opts, make_ui())
    assert site.ops("fill") == [] and site.ops("submit") == []
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
    summary, _ = download(site, ledger, opts, make_ui([True, True]))
    assert summary == Summary(done=1, review=4)
    assert site.ops("open") == ["RY001", "RY002", "RY003", "RY004", "RY005"]


# --- download: 例外 ---

def test_save_failure_after_submit(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(2), {"RY001": {"save_raises": RuntimeError("disk full")}})
    ui = make_ui([True])
    summary, sleeps = download(site, ledger, opts, ui)
    assert status(ledger, "RY001") is Status.FAILED_AFTER_ISSUE
    assert ledger.rows["RY001"].memo == runner.MEMO_AFTER_ISSUE
    assert summary == Summary(failed=1, keep_browser_open=True)
    assert site.ops("open") == ["RY001"]
    assert site.ops("diag") == ["RY001"]
    assert site.ops("close") == []  # 手で保存できるよう、開いたままにする
    assert sleeps == []


def test_submit_exception_is_failed_after_issue(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(2), {"RY001": {"submit_raises": RuntimeError("timeout")}})
    summary, _ = download(site, ledger, opts, make_ui([True]))
    assert status(ledger, "RY001") is Status.FAILED_AFTER_ISSUE
    assert summary.keep_browser_open and site.ops("open") == ["RY001"]


def test_unexpected_screen_after_submit_is_failed_after_issue(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"save_raises": UnexpectedScreen("save_receipt")}})
    download(site, ledger, opts, make_ui([True]))
    assert status(ledger, "RY001") is Status.FAILED_AFTER_ISSUE


def test_exception_before_submit_is_failed(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(2), {"RY001": {"fill_raises": RuntimeError("boom")}})
    summary, _ = download(site, ledger, opts, make_ui([True]))
    assert status(ledger, "RY001") is Status.FAILED
    assert "RY001" not in site.ops("submit")
    assert site.ops("diag") == ["RY001"]
    assert status(ledger, "RY002") is Status.DONE  # 発行前の失敗なら次へ進む
    assert summary == Summary(done=1, failed=1)


def test_unexpected_screen_before_submit_is_review(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"fill_raises": UnexpectedScreen("fill_addressee")}})
    download(site, ledger, opts, make_ui())
    assert status(ledger, "RY001") is Status.REVIEW
    assert "fill_addressee" in ledger.rows["RY001"].memo
    assert site.ops("submit") == []


def test_keyboard_interrupt_leaves_row_unchanged(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"submit_raises": KeyboardInterrupt()}})
    with pytest.raises(KeyboardInterrupt):
        run_download(site, ledger, opts, make_ui([True]), sleep=Sleeps())
    assert status(ledger, "RY001") is Status.PENDING


# --- download: ログイン切れ ---

def test_login_screen_prompts_and_retries_once(make_site, make_ui, ledger, opts, reservations_factory):
    site = make_site(reservations_factory(1), {"RY001": {"open": [Screen.LOGIN, Screen.ADDRESSEE_INPUT]}})
    ui = make_ui([True])
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


# --- download: 対象の絞り込み ---

def test_limit_counts_review_items(make_site, make_ui, ledger, opts, reservations_factory):
    opts.limit = 2
    site = make_site(reservations_factory(3), {"RY001": {"open": Screen.UNKNOWN}})
    summary, _ = download(site, ledger, opts, make_ui([True]))
    assert site.ops("open") == ["RY001", "RY002"]
    assert summary == Summary(done=1, review=1)
    assert status(ledger, "RY003") is Status.PENDING


def test_range_filter_and_undated_notice(make_site, make_ui, ledger, opts):
    rs = [Reservation("RY001", "ホテルA", date(2025, 3, 15), None, 12000, True),
          Reservation("RY002", "ホテルB", None, None, None, True),
          Reservation("RY003", "ホテルC", date(2024, 12, 31), None, 5000, True)]
    opts.date_from = date(2025, 1, 1)
    site, ui = make_site(rs), make_ui([True])
    download(site, ledger, opts, ui)
    assert site.ops("open") == ["RY001"]
    assert any("日付不明のため対象外: 1 件" in m for m in ui.infos)


def test_no_undated_notice_without_range(make_site, make_ui, ledger, opts):
    rs = [Reservation("RY002", "ホテルB", None, None, None, True)]
    site, ui = make_site(rs), make_ui([True])
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
    download(make_site(rs), ledger, opts, make_ui([True, False]))  # 1件目だけ取得して止める
    site = make_site(rs)
    download(site, ledger, opts, make_ui([True]))
    assert site.ops("open") == ["RY002"]


def test_close_flow_called_for_every_item(make_site, make_ui, ledger, opts, reservations_factory):
    scripts = {"RY002": {"open": Screen.UNKNOWN}, "RY003": {"open": Screen.RECEIPT}}
    site = make_site(reservations_factory(3), scripts)
    download(site, ledger, opts, make_ui([True, True]))
    assert site.ops("close") == ["RY001", "RY002", "RY003"]
