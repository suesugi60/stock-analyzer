"""ブラウザの起動と、予約一覧タブの特定。"""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional, Sequence

from playwright.sync_api import BrowserContext, Error as PlaywrightError, Page, sync_playwright

from .models import Screen
from .site import detect_screen

# ログイン状態を持つ専用プロファイル。~/Documents は iCloud で同期されることがあるので避ける
PROFILE_DIR = Path.home() / "Library" / "Application Support" / "rakuten-receipts" / "profile"
START_URL = "https://travel.rakuten.co.jp/"

LAUNCH_ERROR = (
    "ブラウザを起動できませんでした。前回のブラウザが開いたままなら閉じてください。"
    "Chrome がない場合は `python -m playwright install chromium` を実行してください"
)


class BrowserLaunchError(Exception):
    """ブラウザを起動できなかった。"""


# 試すブラウザの順。"chrome" はインストール済みの Google Chrome、None は Playwright 同梱の Chromium
CHANNELS: Sequence[Optional[str]] = ("chrome", None)


@contextmanager
def open_session(profile_dir: Path = PROFILE_DIR, headless: bool = False,
                 channels: Sequence[Optional[str]] = CHANNELS) -> Iterator[BrowserContext]:
    """専用プロファイルでブラウザを開く。channels の順に試し、最初に起動できたものを使う。

    自動操作であることを隠すためのオプションは足さない。
    """
    profile_dir = Path(profile_dir)
    profile_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        context: Optional[BrowserContext] = None
        last_error = ""
        for channel in channels:
            options = dict(headless=headless, accept_downloads=True, locale="ja-JP")
            if channel is not None:
                options["channel"] = channel
            try:
                context = playwright.chromium.launch_persistent_context(str(profile_dir), **options)
                break
            except PlaywrightError as error:
                lines = str(error).strip().splitlines()
                last_error = lines[0] if lines else type(error).__name__
        if context is None:
            raise BrowserLaunchError(f"{LAUNCH_ERROR}({last_error})")
        try:
            yield context
        finally:
            try:
                context.close()
            except PlaywrightError:
                pass


def open_start_page(context: BrowserContext, url: str) -> Page:
    """最初のタブで url を開く。開けなくても落とさない(利用者が手で開けばよい)。"""
    page = context.pages[0] if context.pages else context.new_page()
    try:
        page.goto(url)
    except PlaywrightError:
        pass
    return page


def find_list_page(context: BrowserContext) -> Optional[Page]:
    """予約一覧を表示しているタブを、新しいタブから順に探す。"""
    for page in reversed(context.pages):
        try:
            if detect_screen(page) is Screen.LIST:
                return page
        except PlaywrightError:
            continue
    return None
