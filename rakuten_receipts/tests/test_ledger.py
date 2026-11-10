from __future__ import annotations

import csv
from datetime import date, datetime

import pytest

from rakuten_receipts.ledger import COLUMNS, Ledger
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
    assert ledger.rows["RY3"].status is Status.PENDING


def test_load_skips_rows_without_id(path):
    path.parent.mkdir(parents=True)
    path.write_text(",".join(COLUMNS) + "\n,空行,,,,,,,\nRY1,ホテルA,2025-03-15,,,未取得,,,\n", encoding="utf-8-sig")
    assert list(Ledger(path).rows) == ["RY1"]
