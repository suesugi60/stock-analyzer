"""テスト用の偽物と fixture。"""
from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Dict, List, Optional

import pytest

from rakuten_receipts.ledger import Ledger
from rakuten_receipts.models import Reservation, Screen
from rakuten_receipts.runner import Options


class FakeSite:
    """runner が求める site の偽物。予約番号ごとの台本どおりに振る舞い、呼ばれた操作を記録する。"""

    def __init__(self, reservations: List[Reservation], scripts: Optional[Dict[str, dict]] = None) -> None:
        self.reservations = list(reservations)
        self.scripts = scripts or {}
        self.calls: List[tuple] = []
        self.filled: List[tuple] = []
        self.diag_labels: List[str] = []
        self.saved_paths: List[Path] = []
        self._current = ""
        self._open_counts: Dict[str, int] = {}

    def _script(self) -> dict:
        return self.scripts.get(self._current, {})

    def _maybe_raise(self, key: str) -> None:
        error = self._script().get(key)
        if error is not None:
            raise error

    def ops(self, name: str) -> List[str]:
        return [rid for op, rid in self.calls if op == name]

    def read_reservations(self) -> List[Reservation]:
        self.calls.append(("read", ""))
        return list(self.reservations)

    def open_receipt(self, reservation: Reservation) -> Screen:
        self._current = reservation.reservation_id
        self.calls.append(("open", self._current))
        count = self._open_counts.get(self._current, 0)
        self._open_counts[self._current] = count + 1
        value = self._script().get("open", Screen.ADDRESSEE_INPUT)
        if isinstance(value, list):
            value = value[min(count, len(value) - 1)]
        return value

    def fill_addressee(self, name: str, title: str) -> None:
        self.calls.append(("fill", self._current))
        self._maybe_raise("fill_raises")
        self.filled.append((self._current, name, title))

    def go_to_confirm(self) -> Screen:
        self.calls.append(("go_confirm", self._current))
        return self._script().get("confirm_screen", Screen.CONFIRM)

    def read_confirm_text(self) -> str:
        self.calls.append(("read_confirm", self._current))
        return self._script().get("confirm_text", "宛名 株式会社サンプル 御中")

    def submit_issue(self) -> None:
        self.calls.append(("submit", self._current))
        self._maybe_raise("submit_raises")

    def save_receipt(self, path: Path) -> None:
        self.calls.append(("save", self._current))
        self._maybe_raise("save_raises")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"%PDF-fake")
        self.saved_paths.append(path)

    def save_diagnostics(self, label: str) -> Optional[Path]:
        self.calls.append(("diag", self._current))
        self.diag_labels.append(label)
        return None

    def close_flow(self) -> None:
        self.calls.append(("close", self._current))


class FakeUI:
    """利用者の代わり。confirm には answers を先頭から順に返す。"""

    def __init__(self, answers: Optional[List[bool]] = None) -> None:
        self.answers = list(answers or [])
        self.infos: List[str] = []
        self.confirms: List[str] = []
        self.enters: List[str] = []

    def info(self, message: str) -> None:
        self.infos.append(message)

    def confirm(self, message: str) -> bool:
        self.confirms.append(message)
        assert self.answers, f"想定していない確認が出た: {message}"
        return self.answers.pop(0)

    def wait_enter(self, message: str) -> None:
        self.enters.append(message)


def make_reservations(count: int, hotel: str = "ホテルA") -> List[Reservation]:
    """RY001〜 を count 件。チェックインは 2025-03-15 から1日ずつ。"""
    start = date(2025, 3, 15).toordinal()
    return [
        Reservation(f"RY{i + 1:03d}", hotel, date.fromordinal(start + i), date.fromordinal(start + i + 1), 12000, True)
        for i in range(count)
    ]


@pytest.fixture
def reservations_factory():
    return make_reservations


@pytest.fixture
def make_site():
    return FakeSite


@pytest.fixture
def make_ui():
    return FakeUI


@pytest.fixture
def out_dir(tmp_path) -> Path:
    return tmp_path / "out"


@pytest.fixture
def ledger(out_dir) -> Ledger:
    return Ledger(out_dir / "receipts.csv")


@pytest.fixture
def opts(out_dir) -> Options:
    return Options(out_dir=out_dir, name="株式会社サンプル", title="御中")
