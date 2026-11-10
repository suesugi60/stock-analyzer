from __future__ import annotations

import csv
from datetime import date, datetime

import pytest

from rakuten_receipts.ledger import COLUMNS, Ledger, LedgerError
from rakuten_receipts.models import Reservation, Status

FIXED_NOW = datetime(2026, 11, 10, 9, 30, 5)


def res(rid, checkin=date(2025, 3, 15), available=True, hotel="ホテルA", amount=12000):
    checkout = date.fromordinal(checkin.toordinal() + 1) if checkin else None
    return Reservation(rid, hotel, checkin, checkout, amount, available)


@pytest.fixture
def path(tmp_path):
    return tmp_path / "out" / "receipts.csv"


@pytest.fixture
def ledger(path):
    return Ledger(path, now=lambda: FIXED_NOW)


def test_new_ledger_does_not_create_file(path, ledger):
    assert ledger.rows == {}
    assert not path.exists()


def test_sync_new_rows(ledger):
    ledger.sync([res("RY1"), res("RY2", available=False)])
    assert ledger.rows["RY1"].status is Status.PENDING
    assert ledger.rows["RY2"].status is Status.EXCLUDED


def test_sync_keeps_done(ledger):
    ledger.sync([res("RY1")])
    ledger.mark("RY1", Status.DONE, "a.pdf")
    ledger.sync([res("RY1")])
    assert ledger.rows["RY1"].status is Status.DONE
    assert ledger.rows["RY1"].filename == "a.pdf"


@pytest.mark.parametrize("status", [Status.REVIEW, Status.FAILED, Status.FAILED_AFTER_ISSUE])
def test_sync_keeps_review_and_failed(ledger, status):
    ledger.sync([res("RY1")])
    ledger.mark("RY1", status, memo="メモ")
    ledger.sync([res("RY1")])
    assert ledger.rows["RY1"].status is status
    assert ledger.rows["RY1"].memo == "メモ"


def test_sync_excluded_becomes_pending_when_link_appears(ledger):
    ledger.sync([res("RY1", available=False)])
    ledger.sync([res("RY1", available=True)])
    assert ledger.rows["RY1"].status is Status.PENDING


def test_sync_pending_becomes_excluded_when_link_disappears(ledger):
    ledger.sync([res("RY1", available=True)])
    ledger.sync([res("RY1", available=False)])
    assert ledger.rows["RY1"].status is Status.EXCLUDED


def test_sync_keeps_rows_missing_from_fresh_read(ledger):
    ledger.sync([res("RY1"), res("RY2")])
    ledger.mark("RY1", Status.DONE, "a.pdf")
    ledger.sync([res("RY2")])
    assert list(ledger.rows) == ["RY1", "RY2"]
    assert ledger.rows["RY1"].status is Status.DONE


def test_sync_updates_hotel_dates_amount(ledger):
    ledger.sync([res("RY1", hotel="旧名", amount=None, checkin=None)])
    ledger.sync([res("RY1", hotel="新名", amount=9800, checkin=date(2025, 5, 1))])
    row = ledger.rows["RY1"]
    assert (row.hotel_name, row.amount, row.checkin, row.checkout) == (
        "新名", 9800, date(2025, 5, 1), date(2025, 5, 2))


def test_sync_saves_file(path, ledger):
    ledger.sync([res("RY1")])
    assert set(Ledger(path).rows) == {"RY1"}


def test_mark_saves_immediately(path, ledger):
    ledger.sync([res("RY1")])
    ledger.mark("RY1", Status.DONE, "a.pdf", "発行済みを再表示")
    row = Ledger(path).rows["RY1"]
    assert row.status is Status.DONE
    assert row.filename == "a.pdf"
    assert row.memo == "発行済みを再表示"
    assert row.updated_at == "2026-11-10 09:30:05"
    assert (row.hotel_name, row.checkin, row.checkout, row.amount) == (
        "ホテルA", date(2025, 3, 15), date(2025, 3, 16), 12000)


def test_mark_empty_filename_keeps_existing(ledger):
    ledger.sync([res("RY1")])
    ledger.mark("RY1", Status.DONE, "a.pdf")
    ledger.mark("RY1", Status.REVIEW, memo="あとで")
    assert ledger.rows["RY1"].filename == "a.pdf"
    assert ledger.rows["RY1"].status is Status.REVIEW


def test_mark_unknown_id_raises(ledger):
    with pytest.raises(KeyError):
        ledger.mark("NOPE", Status.DONE)


def test_file_is_bom_utf8_with_columns(path, ledger):
    ledger.sync([res("RY1")])
    raw = path.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    first_line = raw.decode("utf-8-sig").splitlines()[0]
    assert first_line.split(",") == COLUMNS
    assert COLUMNS == ["予約番号", "施設名", "チェックイン", "チェックアウト", "金額", "状態", "ファイル名", "更新日時", "メモ"]


def test_no_temp_file_left_behind(path, ledger):
    ledger.sync([res("RY1")])
    assert [p.name for p in path.parent.iterdir()] == ["receipts.csv"]


def test_targets_range_inclusive_and_status(ledger):
    rs = [
        res("D14", date(2025, 3, 14)), res("D15", date(2025, 3, 15)),
        res("D16", date(2025, 3, 16)), res("D17", date(2025, 3, 17)),
        res("DONE", date(2025, 3, 15)), res("EXCL", date(2025, 3, 15), available=False),
        res("REV", date(2025, 3, 15)), res("FAIL", date(2025, 3, 15)), res("AFTER", date(2025, 3, 15)),
    ]
    ledger.sync(rs)
    ledger.mark("DONE", Status.DONE, "x.pdf")
    ledger.mark("REV", Status.REVIEW)
    ledger.mark("FAIL", Status.FAILED)
    ledger.mark("AFTER", Status.FAILED_AFTER_ISSUE)
    got = [r.reservation_id for r in ledger.targets(rs, date(2025, 3, 15), date(2025, 3, 16))]
    assert got == ["D15", "D16", "REV", "FAIL", "AFTER"]


def test_targets_open_ended_range(ledger):
    rs = [res("A", date(2025, 3, 14)), res("B", date(2025, 3, 15)), res("C", date(2025, 3, 16))]
    ledger.sync(rs)
    assert [r.reservation_id for r in ledger.targets(rs, date(2025, 3, 15), None)] == ["B", "C"]
    assert [r.reservation_id for r in ledger.targets(rs, None, date(2025, 3, 15))] == ["A", "B"]


def test_targets_unknown_date(ledger):
    rs = [res("NODATE", None), res("DATED", date(2025, 3, 15))]
    ledger.sync(rs)
    assert [r.reservation_id for r in ledger.targets(rs, None, None)] == ["NODATE", "DATED"]
    assert [r.reservation_id for r in ledger.targets(rs, date(2025, 1, 1), None)] == ["DATED"]
    assert [r.reservation_id for r in ledger.targets(rs, None, date(2025, 12, 31))] == ["DATED"]


def test_targets_keeps_reading_order(ledger):
    rs = [res("C", date(2025, 3, 17)), res("A", date(2025, 3, 15)), res("B", date(2025, 3, 16))]
    ledger.sync(rs)
    assert [r.reservation_id for r in ledger.targets(rs, None, None)] == ["C", "A", "B"]


def test_load_tolerates_excel_resave(path):
    # Excel で開いて保存し直した想定: BOM なし、日付が 2025/3/15、金額に桁区切り、状態が空の行
    path.parent.mkdir(parents=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(COLUMNS)
        writer.writerow(["RY1", "ホテルA", "2025/3/15", "2025/3/16", "12,000", "", "", "", ""])
        writer.writerow(["RY2", "ホテルB", "2025/4/1", "", "", "取得済み", "b.pdf", "2026/11/10 9:30", ""])
        writer.writerow(["RY3", "ホテルC", "こわれた日付", "", "abc", "なぞの状態", "", "", ""])
    ledger = Ledger(path)
    assert ledger.rows["RY1"].checkin == date(2025, 3, 15)
    assert ledger.rows["RY1"].checkout == date(2025, 3, 16)
    assert ledger.rows["RY1"].amount == 12000
    assert ledger.rows["RY1"].status is Status.PENDING
    assert ledger.rows["RY2"].status is Status.DONE
    assert ledger.rows["RY2"].filename == "b.pdf"
    assert ledger.rows["RY3"].checkin is None
    assert ledger.rows["RY3"].amount is None
    assert ledger.rows["RY3"].custom_status == "なぞの状態"  # 知らない状態は書かれたまま残す


def test_load_skips_rows_without_id(path):
    path.parent.mkdir(parents=True)
    path.write_text(",".join(COLUMNS) + "\n,空行,,,,,,,\nRY1,ホテルA,2025-03-15,,,未取得,,,\n", encoding="utf-8-sig")
    assert list(Ledger(path).rows) == ["RY1"]


# --- レビュー指摘: 読めない台帳は上書きしない。手で書いた状態は尊重する ---

def write_rows(path, rows, encoding="utf-8-sig"):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding=encoding, newline="") as f:
        writer = csv.writer(f)
        writer.writerow(COLUMNS)
        writer.writerows(rows)


def test_load_shift_jis_resave(path):
    # 日本語版 Excel の「CSV」形式で保存し直すと Shift_JIS になる
    write_rows(path, [["RY1", "ホテルA", "2025/3/15", "", "12000", "取得済み", "a.pdf", "", ""]], encoding="cp932")
    ledger = Ledger(path)
    assert ledger.rows["RY1"].status is Status.DONE
    assert ledger.rows["RY1"].hotel_name == "ホテルA"


def test_unreadable_encoding_is_refused_and_file_untouched(path):
    path.parent.mkdir(parents=True)
    original = b"\xff\xfe\x00\x00 not a csv \x81"
    path.write_bytes(original)
    with pytest.raises(LedgerError) as error:
        Ledger(path)
    assert str(path) in str(error.value)
    assert path.read_bytes() == original


def test_missing_columns_is_refused_and_file_untouched(path):
    # 1行目が壊れていると全行を失う。読めたふりをして上書きしない
    path.parent.mkdir(parents=True)
    path.write_text("番号,宿,状態メモ\nRY1,ホテルA,取得済み\n", encoding="utf-8-sig")
    original = path.read_bytes()
    with pytest.raises(LedgerError):
        Ledger(path)
    assert path.read_bytes() == original


def test_empty_file_is_an_empty_ledger(path):
    path.parent.mkdir(parents=True)
    path.write_text("", encoding="utf-8")
    assert Ledger(path).rows == {}


def test_custom_status_is_kept_and_never_a_target(path):
    # 利用者が手で「手動で保存済み」などと書いた行は、発行の対象にしない
    write_rows(path, [["RY1", "ホテルA", "2025-03-15", "", "12000", "手動で保存済み", "", "", "自分で保存"]])
    ledger = Ledger(path, now=lambda: FIXED_NOW)
    fresh = [res("RY1"), res("RY2")]
    ledger.sync(fresh)
    assert [r.reservation_id for r in ledger.targets(fresh, None, None)] == ["RY2"]
    reloaded = Ledger(path)
    assert reloaded.rows["RY1"].custom_status == "手動で保存済み"
    assert reloaded.rows["RY1"].memo == "自分で保存"
    with open(path, encoding="utf-8-sig", newline="") as f:
        assert next(row for row in csv.DictReader(f) if row["予約番号"] == "RY1")["状態"] == "手動で保存済み"


def test_mark_replaces_custom_status(path):
    write_rows(path, [["RY1", "ホテルA", "2025-03-15", "", "12000", "あとで", "", "", ""]])
    ledger = Ledger(path)
    ledger.mark("RY1", Status.DONE, "a.pdf")
    assert Ledger(path).rows["RY1"].status is Status.DONE
    assert Ledger(path).rows["RY1"].custom_status == ""


def test_fullwidth_parentheses_status_is_still_failed_after_issue(path):
    # 「失敗(発行後)」のかっこを全角で書き直しても、「発行済みかもしれない」という記録を失わない
    write_rows(path, [["RY1", "ホテルA", "2025-03-15", "", "12000", "失敗\uff08発行後\uff09", "", "", ""]])
    ledger = Ledger(path)
    ledger.sync([res("RY1")])
    assert ledger.rows["RY1"].status is Status.FAILED_AFTER_ISSUE
    assert ledger.rows["RY1"].custom_status == ""
