"""取得済みの領収書を1つの PDF にまとめる。ブラウザには触らない。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import List, Optional

from pypdf import PdfWriter

from .ledger import Ledger, LedgerRow
from .models import Status
from .naming import NO_DATE

MERGED_NAME = "領収書まとめ.pdf"


@dataclass
class MergeResult:
    path: Optional[Path]  # 作ったファイル。1件もなければ None
    merged: int = 0  # 結合した領収書の数
    skipped: List[str] = field(default_factory=list)  # ファイルがない・読めないため飛ばした予約番号


def _sort_key(row: LedgerRow):
    # チェックイン日の古い順。日付不明は最後。同じ日は予約番号順
    return (row.checkin is None, row.checkin or date.max, row.reservation_id)


def _source(row: LedgerRow, out_dir: Path) -> Optional[Path]:
    """台帳の行が指す PDF。出力先の直下にある、まとめファイル以外のファイルだけを認める。"""
    name = row.filename
    if not name or name == MERGED_NAME or Path(name).name != name:
        return None
    path = out_dir / name
    return path if path.is_file() else None


def merge_receipts(ledger: Ledger, out_dir: Path) -> MergeResult:
    """台帳で「取得済み」の領収書を、チェックイン日順に結合して out_dir に書き出す。"""
    out_dir = Path(out_dir)
    rows = sorted((row for row in ledger.rows.values() if row.status is Status.DONE), key=_sort_key)
    result = MergeResult(path=None)
    writer = PdfWriter()
    for row in rows:
        source = _source(row, out_dir)
        if source is None:
            result.skipped.append(row.reservation_id)
            continue
        title = f"{row.checkin.isoformat() if row.checkin else NO_DATE} {row.hotel_name}"
        try:
            writer.append(str(source), outline_item=title)
        except Exception:  # noqa: BLE001 - 読めない PDF が1つあっても、全体は止めない
            result.skipped.append(row.reservation_id)
            continue
        result.merged += 1
    if result.merged == 0:
        return result

    target = out_dir / MERGED_NAME
    tmp = out_dir / (MERGED_NAME + ".tmp")
    with open(tmp, "wb") as f:
        writer.write(f)
    os.replace(tmp, target)
    result.path = target
    return result
