from __future__ import annotations

import pytest

from rakuten_receipts.browser import BrowserLaunchError, find_list_page, open_session, open_start_page


def test_open_session_opens_a_browser(tmp_path):
    with open_session(tmp_path / "profile", headless=True) as ctx:
        assert len(ctx.pages) >= 1


def test_open_session_falls_back_to_next_channel(tmp_path):
    # 1つ目(存在しない種類のブラウザ)で失敗しても、次の候補(同梱 Chromium)で開く
    with open_session(tmp_path / "profile", headless=True, channels=("no-such-browser", None)) as ctx:
        assert len(ctx.pages) >= 1


def test_open_session_creates_profile_dir(tmp_path):
    profile = tmp_path / "a" / "b" / "profile"
    with open_session(profile, headless=True):
        assert profile.is_dir()


def test_open_session_keeps_login_between_runs(tmp_path, dummy_site):
    # 専用プロファイルなので、前回の Cookie が次の起動でも残る(毎回ログインし直さなくてよい)
    profile = tmp_path / "profile"
    with open_session(profile, headless=True) as ctx:
        page = ctx.pages[0]
        page.goto(dummy_site + "unknown.html")
        page.evaluate("() => { document.cookie = 'session=abc; max-age=3600'; }")
    with open_session(profile, headless=True) as ctx:
        page = ctx.pages[0]
        page.goto(dummy_site + "unknown.html")
        assert "session=abc" in page.evaluate("() => document.cookie")


def test_no_browser_available_raises_launch_error(tmp_path):
    # どの候補も起動できない(Chrome も同梱 Chromium もない)状態を、存在しない種類だけを渡して再現する
    with pytest.raises(BrowserLaunchError) as error:
        with open_session(tmp_path / "profile", headless=True, channels=("no-such-browser",)):
            pass
    message = str(error.value)
    assert "ブラウザを起動できませんでした" in message
    assert "playwright install chromium" in message
    assert "\n" not in message  # 1行に収める(トレースや長い説明を出さない)


# 以下は open_session で開いたブラウザを使う(conftest の browser fixture とは同時に使えないため)

@pytest.fixture
def session(tmp_path):
    with open_session(tmp_path / "profile", headless=True) as ctx:
        yield ctx


def test_find_list_page_picks_list_tab(session, dummy_site):
    first = session.pages[0]
    first.goto(dummy_site + "unknown.html")
    second = session.new_page()
    second.goto(dummy_site + "list_p1.html")
    third = session.new_page()
    third.goto(dummy_site + "unknown.html")
    assert find_list_page(session) is second


def test_find_list_page_prefers_newest_list_tab(session, dummy_site):
    older = session.pages[0]
    older.goto(dummy_site + "list_p2.html")
    newer = session.new_page()
    newer.goto(dummy_site + "list_p1.html")
    assert find_list_page(session) is newer


def test_find_list_page_none(session, dummy_site):
    session.pages[0].goto(dummy_site + "unknown.html")
    assert find_list_page(session) is None


def test_open_start_page_ignores_unreachable_url(session):
    # 最初のページを開けなくても落ちない(利用者が手で開けばよい)
    page = open_start_page(session, "http://127.0.0.1:9/")
    assert page in session.pages


def test_open_start_page_opens_url(session, dummy_site):
    page = open_start_page(session, dummy_site + "unknown.html")
    assert page.url == dummy_site + "unknown.html"
