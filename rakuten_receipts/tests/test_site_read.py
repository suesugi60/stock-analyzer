from __future__ import annotations

import time
from datetime import date

import pytest

from rakuten_receipts.models import Screen
from rakuten_receipts.site import Site, detect_screen, parse_block_text


# --- parse_block_text(ブラウザ不要) ---

def test_parse_labeled():
    d = parse_block_text("予約番号:RY12345 チェックイン 2025年3月15日 チェックアウト 2025年3月16日 合計 12,000円")
    assert d == {"reservation_id": "RY12345", "checkin": date(2025, 3, 15),
                 "checkout": date(2025, 3, 16), "amount": 12000}


def test_parse_range_ignores_booking_date():
    d = parse_block_text("予約日 2025/01/10 予約番号 RY7 宿泊日 2025/03/15〜2025/03/16 料金 8,500円")
    assert (d["checkin"], d["checkout"], d["amount"]) == (date(2025, 3, 15), date(2025, 3, 16), 8500)


def test_parse_range_with_kanji_dates_and_weekday():
    d = parse_block_text("予約番号 RY8 宿泊期間 2025年3月15日(土)〜2025年3月17日(月)")
    assert (d["checkin"], d["checkout"]) == (date(2025, 3, 15), date(2025, 3, 17))


def test_parse_without_labels_uses_first_date_and_amount():
    d = parse_block_text("予約番号 RY5\n2025/06/01 泊 9,000円 税 900円")
    assert (d["checkin"], d["checkout"], d["amount"]) == (date(2025, 6, 1), None, 9000)


def test_parse_multiline_inner_text():
    d = parse_block_text("ホテルサンプル東京\n\n予約番号:RY001\n\nチェックイン 2025年3月15日 チェックアウト 2025年3月16日\n\n決済方法 オンラインカード決済 合計 12,000円\n\n領収書発行")
    assert d == {"reservation_id": "RY001", "checkin": date(2025, 3, 15),
                 "checkout": date(2025, 3, 16), "amount": 12000}


def test_parse_missing_fields():
    assert parse_block_text("予約番号 RY9") == {
        "reservation_id": "RY9", "checkin": None, "checkout": None, "amount": None}


def test_parse_no_id():
    assert parse_block_text("予約番号で検索")["reservation_id"] is None


def test_parse_invalid_date():
    assert parse_block_text("予約番号 RY9 チェックイン 2025/13/45")["checkin"] is None


# --- detect_screen ---

@pytest.mark.parametrize("path, expected", [
    ("list_p1.html", Screen.LIST),
    ("list_p2.html", Screen.LIST),
    ("list_empty.html", Screen.LIST),
    ("receipt_input.html", Screen.ADDRESSEE_INPUT),  # 注記に「修正」を含むが、修正画面とはみなさない
    ("receipt_input_select.html", Screen.ADDRESSEE_INPUT),
    ("receipt_confirm.html?atena=株式会社サンプル&keisho=御中", Screen.CONFIRM),
    ("receipt_confirm.html?atena=株式会社サンプル&keisho=御中&mode=download", Screen.CONFIRM),
    ("receipt.html?id=RY004", Screen.RECEIPT),
    ("receipt_fix.html", Screen.ADDRESSEE_FIX),
    ("unknown.html", Screen.UNKNOWN),
    ("login.html", Screen.LOGIN),
])
def test_detect_screen(page, dummy_site, path, expected):
    page.goto(dummy_site + path)
    assert detect_screen(page) is expected


def test_page_without_invoice_number_is_not_receipt(page):
    # 「領収書」とあっても登録番号がなければ領収書とみなさない(エラーページを保存しないため)
    page.set_content("<h1>領収書</h1><p>領収書を表示できません。楽天グループ株式会社</p>")
    assert detect_screen(page) is Screen.UNKNOWN


def test_text_input_with_submit_button_is_not_confirm(page):
    # 入力欄がある画面では「発行する」があっても確認画面とみなさない
    page.set_content("<input type='text' value='以前の宛名'><button>発行する</button>")
    assert detect_screen(page) is not Screen.CONFIRM


def test_site_header_search_box_is_ignored(page):
    page.set_content("<header><input type='text' placeholder='検索'></header>"
                     "<p>宛名 株式会社サンプル 御中</p><button>発行する</button>")
    assert detect_screen(page) is Screen.CONFIRM


def test_login_host_is_login(page):
    page.route("**/*", lambda route: route.fulfill(body="<p>予約番号 RY1</p>", content_type="text/html"))
    page.goto("https://login.account.rakuten.com/sso/authorize")
    assert detect_screen(page) is Screen.LOGIN


# --- read_reservations ---

def make_site(context, page, tmp_path, timeout_ms=1000):
    return Site(context, page, tmp_path / "debug", timeout_ms=timeout_ms)


def test_reads_two_pages(context, page, dummy_site, tmp_path):
    page.goto(dummy_site + "list_p1.html")
    rs = make_site(context, page, tmp_path).read_reservations()
    assert [r.reservation_id for r in rs] == ["RY001", "RY002", "RY003", "RY004", "RY005", "RY006"]
    assert [r.receipt_available for r in rs] == [True, False, True, True, True, True]
    assert [r.page_index for r in rs] == [0, 0, 0, 1, 1, 1]
    first = rs[0]
    assert (first.hotel_name, first.checkin, first.checkout, first.amount) == (
        "ホテルサンプル東京", date(2025, 3, 15), date(2025, 3, 16), 12000)
    fourth = rs[3]
    assert (fourth.hotel_name, fourth.checkin, fourth.checkout, fourth.amount) == (
        "リゾート見本沖縄", date(2025, 4, 1), date(2025, 4, 2), 32000)  # 予約日 1/10 を拾わない
    assert [r.checkin for r in rs] == [date(2025, 3, 15), date(2025, 3, 20), date(2025, 3, 22),
                                       date(2025, 4, 1), date(2025, 4, 5), date(2025, 4, 10)]


def test_duplicate_ids_deduped(context, page, dummy_site, tmp_path):
    page.goto(dummy_site + "list_p2.html")
    rs = make_site(context, page, tmp_path).read_reservations()
    assert [r.reservation_id for r in rs] == ["RY004", "RY005", "RY006"]


def test_unrelated_next_text_not_followed(context, page, dummy_site, tmp_path):
    page.goto(dummy_site + "list_p2.html")
    make_site(context, page, tmp_path).read_reservations()
    assert page.url.endswith("list_p2.html")  # 「次回使えるクーポン」をたどっていない


def test_next_link_loop_stops(context, page, dummy_site, tmp_path):
    page.goto(dummy_site + "list_loop.html")
    started = time.monotonic()
    rs = make_site(context, page, tmp_path).read_reservations()
    assert time.monotonic() - started < 5
    assert [r.reservation_id for r in rs] == ["RY101"]
    assert rs[0].hotel_name == "ホテルサンプル福岡" and rs[0].receipt_available


def test_no_reservations_returns_empty(context, page, dummy_site, tmp_path):
    page.goto(dummy_site + "unknown.html")
    assert make_site(context, page, tmp_path).read_reservations() == []


def test_block_without_id_skipped(context, page, dummy_site, tmp_path):
    page.goto(dummy_site + "list_empty.html")
    assert make_site(context, page, tmp_path).read_reservations() == []


def test_hotel_name_falls_back_to_heading_then_unknown(context, page, tmp_path):
    page.set_content(
        "<div><h3>見出しの宿</h3><p>予約番号 RY1 チェックイン 2025/05/01</p></div>"
        "<div><p>予約番号 RY2 チェックイン 2025/05/02</p></div>")
    rs = make_site(context, page, tmp_path).read_reservations()
    assert [(r.reservation_id, r.hotel_name) for r in rs] == [("RY1", "見出しの宿"), ("RY2", "施設名不明")]


def test_site_detect_screen_uses_list_page(context, page, dummy_site, tmp_path):
    page.goto(dummy_site + "list_p1.html")
    assert make_site(context, page, tmp_path).detect_screen() is Screen.LIST


# --- ページ遷移の最中に読んでも落ちない ---

def test_evaluate_survives_navigation(page, dummy_site):
    from rakuten_receipts.site import evaluate_with_retry

    # 50ms 後に別ページへ移るページで、300ms かかる読み取りを始める → 途中で遷移が起きる
    page.goto(dummy_site + "unknown.html")
    page.evaluate("(url) => { setTimeout(() => { location.href = url; }, 50); }", dummy_site + "list_empty.html")
    text = evaluate_with_retry(
        page, "() => new Promise((resolve) => setTimeout(() => resolve(document.body.innerText), 300))")
    assert "予約番号で検索" in text


def test_evaluate_reraises_other_errors(page):
    from playwright.sync_api import Error
    from rakuten_receipts.site import evaluate_with_retry

    with pytest.raises(Error):
        evaluate_with_retry(page, "() => { throw new Error('boom'); }")
