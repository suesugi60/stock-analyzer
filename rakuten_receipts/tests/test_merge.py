from __future__ import annotations

from datetime import date

import pytest
from pypdf import PdfReader, PdfWriter

from rakuten_receipts.ledger import Ledger
from rakuten_receipts.merge import MERGED_NAME, MergeResult, merge_receipts
from rakuten_receipts.models import Reservation, Status


def make_pdf(path, width, pages=1):
    """幅 width のページを持つ PDF。結合後の並びを幅で確かめるために使う。"""
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=width, height=300)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        writer.write(f)


def widths(path):
    return [int(page.mediabox.width) for page in PdfReader(str(path)).pages]


@pytest.fixture
def out(tmp_path):
    return tmp_path / "out"


@pytest.fixture
def ledger(out):
    return Ledger(out / "receipts.csv")


def add(ledger, out, rid, checkin, width, hotel="ホテルA", status=Status.DONE, pages=1, write=True):
    """台帳に1件足し、status が取得済みなら幅 width の PDF を置く。"""
    ledger.sync([Reservation(rid, hotel, checkin, None, 1000, True)])
    filename = f"{rid}.pdf"
    if write:
        make_pdf(out / filename, width, pages)
    ledger.mark(rid, status, filename)


def test_merges_done_rows_in_checkin_order(ledger, out):
    add(ledger, out, "RY001", date(2025, 3, 20), 120)
    add(ledger, out, "RY002", date(2025, 3, 15), 115)
    add(ledger, out, "RY003", None, 199)
    result = merge_receipts(ledger, out)
    assert result == MergeResult(path=out / "領収書まとめ.pdf", merged=3, skipped=[])
    assert MERGED_NAME == "領収書まとめ.pdf"
    assert widths(result.path) == [115, 120, 199]  # 3/15 → 3/20 → 日付不明


def test_same_checkin_orders_by_reservation_id(ledger, out):
    add(ledger, out, "RY009", date(2025, 3, 15), 109)
    add(ledger, out, "RY002", date(2025, 3, 15), 102)
    assert widths(merge_receipts(ledger, out).path) == [102, 109]


def test_multi_page_receipt_keeps_all_pages(ledger, out):
    add(ledger, out, "RY001", date(2025, 3, 15), 101, pages=2)
    add(ledger, out, "RY002", date(2025, 3, 16), 102)
    result = merge_receipts(ledger, out)
    assert widths(result.path) == [101, 101, 102]
    assert result.merged == 2  # 数えるのはページではなく領収書


@pytest.mark.parametrize("status", [Status.PENDING, Status.REVIEW, Status.EXCLUDED,
                                    Status.FAILED, Status.FAILED_AFTER_ISSUE])
def test_only_done_rows_are_merged(ledger, out, status):
    add(ledger, out, "RY001", date(2025, 3, 15), 101)
    add(ledger, out, "RY002", date(2025, 3, 16), 102, status=status)
    result = merge_receipts(ledger, out)
    assert widths(result.path) == [101]
    assert result.skipped == []


def test_missing_file_is_skipped_and_reported(ledger, out):
    add(ledger, out, "RY001", date(2025, 3, 15), 101)
    add(ledger, out, "RY002", date(2025, 3, 16), 102, write=False)  # ファイルを消した・動かした
    add(ledger, out, "RY003", date(2025, 3, 17), 103)
    result = merge_receipts(ledger, out)
    assert result.skipped == ["RY002"] and result.merged == 2
    assert widths(result.path) == [101, 103]


def test_corrupt_pdf_is_skipped_and_reported(ledger, out):
    add(ledger, out, "RY001", date(2025, 3, 15), 101)
    add(ledger, out, "RY002", date(2025, 3, 16), 102)
    (out / "RY002.pdf").write_bytes(b"this is not a pdf")
    result = merge_receipts(ledger, out)
    assert result.skipped == ["RY002"] and result.merged == 1
    assert widths(result.path) == [101]


def test_nothing_to_merge_writes_nothing(ledger, out):
    add(ledger, out, "RY001", date(2025, 3, 15), 101, status=Status.PENDING)
    assert merge_receipts(ledger, out) == MergeResult(path=None, merged=0, skipped=[])
    assert not (out / MERGED_NAME).exists()


def test_all_missing_writes_nothing(ledger, out):
    add(ledger, out, "RY001", date(2025, 3, 15), 101, write=False)
    result = merge_receipts(ledger, out)
    assert result == MergeResult(path=None, merged=0, skipped=["RY001"])
    assert not (out / MERGED_NAME).exists()


def test_nothing_to_merge_keeps_previous_file(ledger, out):
    out.mkdir(parents=True)
    (out / MERGED_NAME).write_bytes(b"previous")
    merge_receipts(ledger, out)
    assert (out / MERGED_NAME).read_bytes() == b"previous"


def test_rerun_replaces_previous_merged_file(ledger, out):
    add(ledger, out, "RY001", date(2025, 3, 15), 101)
    merge_receipts(ledger, out)
    add(ledger, out, "RY002", date(2025, 3, 10), 102)
    result = merge_receipts(ledger, out)
    assert widths(result.path) == [102, 101]
    assert sorted(p.name for p in out.iterdir()) == sorted(
        ["RY001.pdf", "RY002.pdf", "receipts.csv", "領収書まとめ.pdf"])  # 一時ファイルが残っていない


def test_outline_has_one_entry_per_receipt(ledger, out):
    add(ledger, out, "RY001", date(2025, 3, 20), 120, hotel="旅館みほん京都")
    add(ledger, out, "RY002", date(2025, 3, 15), 115, hotel="ホテルサンプル東京", pages=2)
    add(ledger, out, "RY003", None, 199, hotel="日付のない宿")
    reader = PdfReader(str(merge_receipts(ledger, out).path))
    assert [item.title for item in reader.outline] == [
        "2025-03-15 ホテルサンプル東京", "2025-03-20 旅館みほん京都", "日付不明 日付のない宿"]


def test_merged_file_itself_is_never_a_source(ledger, out):
    # 台帳のファイル名がまとめファイルと同じになっていても、自分自身は取り込まない
    add(ledger, out, "RY001", date(2025, 3, 15), 101)
    merge_receipts(ledger, out)
    ledger.sync([Reservation("RY002", "ホテルB", date(2025, 3, 16), None, 1, True)])
    ledger.mark("RY002", Status.DONE, MERGED_NAME)
    result = merge_receipts(ledger, out)
    assert widths(result.path) == [101]
    assert result.skipped == ["RY002"]


def test_filename_outside_out_dir_is_not_read(ledger, out, tmp_path):
    # 台帳を書き換えられても、出力先の外のファイルは読まない
    make_pdf(tmp_path / "elsewhere.pdf", 150)
    add(ledger, out, "RY001", date(2025, 3, 15), 101)
    ledger.sync([Reservation("RY002", "ホテルB", date(2025, 3, 16), None, 1, True)])
    ledger.mark("RY002", Status.DONE, "../elsewhere.pdf")
    result = merge_receipts(ledger, out)
    assert widths(result.path) == [101]
    assert result.skipped == ["RY002"]
