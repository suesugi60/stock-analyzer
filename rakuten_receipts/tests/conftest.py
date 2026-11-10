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
        self._go_counts: Dict[str, int] = {}

    def _script(self) -> dict:
        return self.scripts.get(self._current, {})

    def _maybe_raise(self, key: str) -> None:
        error = self._script().get(key)
        if error is not None:
            raise error

    def _hook(self, key: str) -> None:
        hook = self._script().get(key)
        if hook is not None:
            hook()

    def _per_call(self, key: str, default, counts: Dict[str, int]):
        """台本の値がリストなら、呼び出しごとに順に返す(最後の値を使い回す)。"""
        count = counts.get(self._current, 0)
        counts[self._current] = count + 1
        value = self._script().get(key, default)
        if isinstance(value, list):
            value = value[min(count, len(value) - 1)]
        return value

    def ops(self, name: str) -> List[str]:
        return [rid for op, rid in self.calls if op == name]

    def read_reservations(self) -> List[Reservation]:
        self.calls.append(("read", ""))
        return list(self.reservations)

    def open_receipt(self, reservation: Reservation) -> Screen:
        self._current = reservation.reservation_id
        self.calls.append(("open", self._current))
        self._maybe_raise("open_raises")
        return self._per_call("open", Screen.ADDRESSEE_INPUT, self._open_counts)

    def fill_addressee(self, name: str, title: str) -> None:
        self.calls.append(("fill", self._current))
        self._maybe_raise("fill_raises")
        self.filled.append((self._current, name, title))

    def go_to_confirm(self) -> Screen:
        self.calls.append(("go_confirm", self._current))
        self._hook("on_go")
        self._maybe_raise("go_raises")
        return self._per_call("confirm_screen", Screen.CONFIRM, self._go_counts)

    def read_confirm_text(self) -> str:
        self.calls.append(("read_confirm", self._current))
        return self._script().get("confirm_text", "宛名 株式会社サンプル 御中")

    def submit_issue(self) -> None:
        self.calls.append(("submit", self._current))
        self._hook("on_submit")
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

    def __init__(self, answers: Optional[List[bool]] = None, on_enter=None,
                 texts: Optional[List[str]] = None) -> None:
        self.answers = list(answers or [])
        self.texts = list(texts or [])  # ask(文字の入力)への答え
        self.asks: List[str] = []
        self.infos: List[str] = []
        self.confirms: List[str] = []
        self.enters: List[str] = []
        self.on_enter = on_enter  # wait_enter のたびに呼ぶ(人がブラウザを操作する代わり)。引数は何回目か

    def info(self, message: str) -> None:
        self.infos.append(message)

    def confirm(self, message: str) -> bool:
        self.confirms.append(message)
        assert self.answers, f"想定していない確認が出た: {message}"
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):  # 確認の最中に Ctrl+C を押した、など
            raise answer
        return answer

    def ask(self, message: str) -> str:
        self.asks.append(message)
        assert self.texts, f"想定していない質問が出た: {message}"
        answer = self.texts.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def wait_enter(self, message: str) -> None:
        self.enters.append(message)
        if self.on_enter is not None:
            self.on_enter(len(self.enters))


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


# --- ダミーサイトとブラウザ(画面のテスト用) ---

import functools
import http.server
import shutil
import threading

FIXTURES = Path(__file__).parent / "fixtures"


def _one_page_pdf() -> bytes:
    import io

    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=333, height=444)  # 結合後に見分けられるよう、珍しい大きさにする
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


SAMPLE_PDF = _one_page_pdf()  # ダミーサイトが「発行する」で落としてくる、本物の1ページ PDF


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args) -> None:  # テスト出力を汚さない
        pass


@pytest.fixture(scope="session")
def dummy_site(tmp_path_factory) -> str:
    """楽天の画面を模したダミーページを配るローカルサーバ。ベース URL(末尾 /)を返す。"""
    root = tmp_path_factory.mktemp("dummy_site")
    for source in FIXTURES.glob("*.html"):
        shutil.copy(source, root / source.name)
    (root / "sample.pdf").write_bytes(SAMPLE_PDF)
    handler = functools.partial(_QuietHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="module")
def browser():
    # モジュール単位にする。Playwright の同期 API は同じスレッドで二重に開始できないので、
    # open_session を使うテスト(test_browser / test_cli)と同時に生きていてはいけない。
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        instance = playwright.chromium.launch()
        yield instance
        instance.close()


@pytest.fixture
def context(browser):
    ctx = browser.new_context(accept_downloads=True, locale="ja-JP")
    yield ctx
    ctx.close()


@pytest.fixture
def page(context):
    return context.new_page()


@pytest.fixture(scope="session")
def sample_pdf() -> bytes:
    """ダミーサイトが「発行する」で落としてくる PDF の中身。"""
    return SAMPLE_PDF
