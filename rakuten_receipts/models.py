"""領収書ツールで共有するデータ型。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import Enum
from typing import Optional


class Screen(Enum):
    """いま表示されている画面の種別。"""

    LOGIN = "login"
    LIST = "list"
    ADDRESSEE_INPUT = "addressee_input"
    ADDRESSEE_FIX = "addressee_fix"
    CONFIRM = "confirm"
    RECEIPT = "receipt"
    UNKNOWN = "unknown"


class Status(str, Enum):
    """台帳に記録する、予約ごとの状態。"""

    PENDING = "未取得"
    DONE = "取得済み"
    EXCLUDED = "対象外"
    REVIEW = "要確認"
    FAILED = "失敗"
    FAILED_AFTER_ISSUE = "失敗(発行後)"


@dataclass(frozen=True)
class Reservation:
    """予約一覧から読み取った1件の予約。"""

    reservation_id: str
    hotel_name: str
    checkin: Optional[date]
    checkout: Optional[date]
    amount: Optional[int]
    receipt_available: bool
    page_index: int = 0  # 一覧の何ページ目にあったか(0 始まり)


class UnexpectedScreen(Exception):
    """想定した画面・要素ではなかった。何も押さずに止まるために使う。"""

    def __init__(self, step: str, screen: Screen = Screen.UNKNOWN, detail: str = "") -> None:
        self.step = step
        self.screen = screen
        self.detail = detail
        message = f"{step}: 想定外の画面({screen.value})"
        if detail:
            message += f" {detail}"
        super().__init__(message)
