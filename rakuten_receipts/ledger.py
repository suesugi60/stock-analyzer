"""台帳(receipts.csv)の読み書きと、発行対象の選び出し。"""
from __future__ import annotations

import csv
import os
import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .models import Reservation, Status

COLUMNS = ["予約番号", "施設名", "チェックイン", "チェックアウト", "金額", "状態", "ファイル名", "更新日時", "メモ"]

# 再実行しても発行の対象にしない状態
_SKIP = (Status.DONE, Status.EXCLUDED)
# 一覧を読み直しても変えない状態(処理の結果として付いたもの)
_STICKY = (Status.DONE, Status.REVIEW, Status.FAILED, Status.FAILED_AFTER_ISSUE)

_DATE = re.compile(r"^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*$")


@dataclass
class LedgerRow:
    reservation_id: str
    hotel_name: str
    checkin: Optional[date]
    checkout: Optional[date]
    amount: Optional[int]
    status: Status
    filename: str = ""
    updated_at: str = ""
    memo: str = ""


def _parse_date(text: str) -> Optional[date]:
    match = _DATE.match(text or "")
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _parse_amount(text: str) -> Optional[int]:
    digits = (text or "").replace(",", "").strip()
    return int(digits) if digits.isdigit() else None


def _parse_status(text: str) -> Status:
    try:
        return Status((text or "").strip())
    except ValueError:
        return Status.PENDING


class Ledger:
    """予約番号ごとに1行を持つ台帳。変更のたびにファイルへ書き出す。"""

    def __init__(self, path: Path, now: Callable[[], datetime] = datetime.now) -> None:
        self.path = Path(path)
        self._now = now
        self.rows: Dict[str, LedgerRow] = {}
        if self.path.exists():
            self._load()

    def _load(self) -> None:
        with open(self.path, encoding="utf-8-sig", newline="") as f:
            for record in csv.DictReader(f):
                reservation_id = (record.get("予約番号") or "").strip()
                if not reservation_id:
                    continue
                self.rows[reservation_id] = LedgerRow(
                    reservation_id=reservation_id,
                    hotel_name=record.get("施設名") or "",
                    checkin=_parse_date(record.get("チェックイン") or ""),
                    checkout=_parse_date(record.get("チェックアウト") or ""),
                    amount=_parse_amount(record.get("金額") or ""),
                    status=_parse_status(record.get("状態") or ""),
                    filename=record.get("ファイル名") or "",
                    updated_at=record.get("更新日時") or "",
                    memo=record.get("メモ") or "",
                )

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=COLUMNS)
            writer.writeheader()
            for row in self.rows.values():
                writer.writerow({
                    "予約番号": row.reservation_id,
                    "施設名": row.hotel_name,
                    "チェックイン": row.checkin.isoformat() if row.checkin else "",
                    "チェックアウト": row.checkout.isoformat() if row.checkout else "",
                    "金額": "" if row.amount is None else str(row.amount),
                    "状態": row.status.value,
                    "ファイル名": row.filename,
                    "更新日時": row.updated_at,
                    "メモ": row.memo,
                })
        os.replace(tmp, self.path)

    def _timestamp(self) -> str:
        return self._now().strftime("%Y-%m-%d %H:%M:%S")

    def sync(self, reservations: List[Reservation]) -> None:
        """一覧から読んだ予約を台帳に反映して保存する。処理済みの状態は変えない。"""
        for res in reservations:
            fresh = Status.PENDING if res.receipt_available else Status.EXCLUDED
            row = self.rows.get(res.reservation_id)
            if row is None:
                self.rows[res.reservation_id] = LedgerRow(
                    res.reservation_id, res.hotel_name, res.checkin, res.checkout,
                    res.amount, fresh, updated_at=self._timestamp())
                continue
            row.hotel_name = res.hotel_name
            row.checkin = res.checkin
            row.checkout = res.checkout
            row.amount = res.amount
            if row.status not in _STICKY and row.status is not fresh:
                row.status = fresh
                row.updated_at = self._timestamp()
        self.save()

    def mark(self, reservation_id: str, status: Status, filename: str = "", memo: str = "") -> None:
        """1件の結果を記録して保存する。filename が空なら既存のファイル名を残す。"""
        row = self.rows[reservation_id]
        row.status = status
        if filename:
            row.filename = filename
        row.memo = memo
        row.updated_at = self._timestamp()
        self.save()

    def targets(self, reservations: List[Reservation], date_from: Optional[date],
                date_to: Optional[date]) -> List[Reservation]:
        """発行の対象になる予約を、読み取った順のまま返す。"""
        ranged = date_from is not None or date_to is not None
        result: List[Reservation] = []
        for res in reservations:
            if not res.receipt_available:
                continue
            row = self.rows.get(res.reservation_id)
            if row is not None and row.status in _SKIP:
                continue
            if ranged:
                if res.checkin is None:
                    continue
                if date_from is not None and res.checkin < date_from:
                    continue
                if date_to is not None and res.checkin > date_to:
                    continue
            result.append(res)
        return result
