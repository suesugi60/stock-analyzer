from __future__ import annotations

import time
from datetime import date

import pytest

from rakuten_receipts.models import Reservation, Screen, UnexpectedScreen
from rakuten_receipts.site import Site


def open_site(context, page, dummy_site, tmp_path, start="list_p1.html", timeout_ms=3000):
    page.goto(dummy_site + start)
    site = Site(context, page, tmp_path / "debug", timeout_ms=timeout_ms)
    by_id = {r.reservation_id: r for r in site.read_reservations()}
    return site, by_id


def issue(site, reservation, path, name="株式会社サンプル", title="御中"):
    assert site.open_receipt(reservation) is Screen.ADDRESSEE_INPUT
    site.fill_addressee(name, title)
    assert site.go_to_confirm() is Screen.CONFIRM
    text = site.read_confirm_text()
    site.submit_issue()
    site.save_receipt(path)
    return text


def test_flow_print_page(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path)
    target = tmp_path / "out" / "a.pdf"  # 親フォルダはまだない
    text = issue(site, rs["RY001"], target)
    assert "株式会社サンプル" in text and "御中" in text
    assert target.read_bytes().startswith(b"%PDF-")
    assert target.stat().st_size > 1000  # 中身のある PDF
    assert site.detect_screen() is Screen.RECEIPT  # 操作対象は領収書のページ


def test_flow_popup_select_download(context, page, dummy_site, tmp_path, sample_pdf):
    site, rs = open_site(context, page, dummy_site, tmp_path)
    target = tmp_path / "b.pdf"
    text = issue(site, rs["RY003"], target)
    assert "株式会社サンプル" in text and "御中" in text
    assert target.read_bytes() == sample_pdf
    assert len(context.pages) == 2  # 新しいタブで進んだ


def test_title_sama_selected(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path)
    assert site.open_receipt(rs["RY001"]) is Screen.ADDRESSEE_INPUT
    site.fill_addressee("山田太郎", "様")
    assert site.go_to_confirm() is Screen.CONFIRM
    text = site.read_confirm_text()
    assert "山田太郎" in text and "様" in text and "御中" not in text


def test_title_selected_in_select(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path)
    assert site.open_receipt(rs["RY003"]) is Screen.ADDRESSEE_INPUT
    site.fill_addressee("山田太郎", "様")
    assert site.go_to_confirm() is Screen.CONFIRM
    text = site.read_confirm_text()
    assert "様" in text and "御中" not in text


def test_already_issued_opens_receipt(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path)
    assert rs["RY004"].page_index == 1
    assert site.open_receipt(rs["RY004"]) is Screen.RECEIPT
    target = tmp_path / "c.pdf"
    site.save_receipt(target)
    assert target.read_bytes().startswith(b"%PDF-")


def test_fix_screen(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path)
    assert site.open_receipt(rs["RY005"]) is Screen.ADDRESSEE_FIX


def test_unknown_screen(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path, timeout_ms=600)
    assert site.open_receipt(rs["RY006"]) is Screen.UNKNOWN


def test_save_receipt_refuses_non_receipt_page(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path, timeout_ms=600)
    site.open_receipt(rs["RY006"])
    with pytest.raises(UnexpectedScreen) as error:
        site.save_receipt(tmp_path / "x.pdf")
    assert error.value.step == "save_receipt"
    assert not (tmp_path / "x.pdf").exists()


def test_fill_verifies_title(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path, start="list_extra.html", timeout_ms=800)
    assert site.open_receipt(rs["RY201"]) is Screen.ADDRESSEE_INPUT
    with pytest.raises(UnexpectedScreen) as error:
        site.fill_addressee("株式会社サンプル", "御中")  # 「御中」が選べない画面
    assert error.value.step == "fill_addressee"


def test_click_without_any_change_raises(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path, start="list_extra.html", timeout_ms=800)
    with pytest.raises(UnexpectedScreen) as error:
        site.open_receipt(rs["RY202"])  # 押しても何も起きないボタン
    assert error.value.step == "open_receipt"


def test_missing_button_raises_quickly(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path, timeout_ms=500)
    assert site.open_receipt(rs["RY006"]) is Screen.UNKNOWN
    started = time.monotonic()
    with pytest.raises(UnexpectedScreen) as error:
        site.go_to_confirm()
    assert time.monotonic() - started < 3
    assert error.value.step == "go_to_confirm"


def test_submit_without_button_raises(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path, timeout_ms=500)
    site.open_receipt(rs["RY006"])
    with pytest.raises(UnexpectedScreen) as error:
        site.submit_issue()
    assert error.value.step == "submit_issue"


def test_open_receipt_returns_login(context, page, dummy_site, tmp_path):
    page.goto(dummy_site + "login.html")
    site = Site(context, page, tmp_path / "debug", timeout_ms=1000)
    some = Reservation("RY001", "ホテルサンプル東京", date(2025, 3, 15), None, 12000, True)
    assert site.open_receipt(some) is Screen.LOGIN


def test_open_receipt_missing_reservation(context, page, dummy_site, tmp_path):
    site, _ = open_site(context, page, dummy_site, tmp_path, timeout_ms=1000)
    ghost = Reservation("RY999", "どこにもない宿", date(2025, 3, 15), None, 1, True)
    with pytest.raises(UnexpectedScreen) as error:
        site.open_receipt(ghost)
    assert error.value.step == "open_receipt"


def test_open_receipt_does_not_match_longer_id(context, page, dummy_site, tmp_path):
    # RY00 は RY001 の先頭と同じだが、別の予約。取り違えない
    site, _ = open_site(context, page, dummy_site, tmp_path, timeout_ms=1000)
    with pytest.raises(UnexpectedScreen):
        site.open_receipt(Reservation("RY00", "x", None, None, None, True))


def test_save_diagnostics_writes_png_and_html(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path, timeout_ms=600)
    site.open_receipt(rs["RY006"])
    png = site.save_diagnostics("RY006/open:receipt")
    assert png is not None and png.parent == tmp_path / "debug"
    assert png.suffix == ".png" and png.read_bytes().startswith(b"\x89PNG")
    assert "RY006_open_receipt" in png.name
    html = png.with_suffix(".html")
    assert "メンテナンス" in html.read_text(encoding="utf-8")


def test_save_diagnostics_never_raises(context, page, dummy_site, tmp_path):
    site, _ = open_site(context, page, dummy_site, tmp_path)
    page.close()
    assert site.save_diagnostics("closed") is None


def test_close_flow_closes_popup_keeps_list(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path)
    site.open_receipt(rs["RY003"])
    assert len(context.pages) == 2
    site.close_flow()
    assert context.pages == [page]
    assert site.detect_screen() is not Screen.ADDRESSEE_INPUT  # 操作対象は一覧のタブに戻っている


def test_close_flow_without_flow_is_harmless(context, page, dummy_site, tmp_path):
    site, _ = open_site(context, page, dummy_site, tmp_path)
    site.close_flow()
    assert context.pages == [page]


def test_second_item_after_first(context, page, dummy_site, tmp_path, sample_pdf):
    site, rs = open_site(context, page, dummy_site, tmp_path)
    issue(site, rs["RY001"], tmp_path / "1.pdf")
    site.close_flow()
    issue(site, rs["RY003"], tmp_path / "3.pdf")
    site.close_flow()
    assert site.open_receipt(rs["RY004"]) is Screen.RECEIPT
    site.save_receipt(tmp_path / "4.pdf")
    site.close_flow()
    assert (tmp_path / "1.pdf").read_bytes().startswith(b"%PDF-")
    assert (tmp_path / "3.pdf").read_bytes() == sample_pdf
    assert (tmp_path / "4.pdf").read_bytes().startswith(b"%PDF-")
    assert (tmp_path / "4.pdf").read_bytes() != sample_pdf  # 前の件のダウンロードを使い回していない
    assert context.pages == [page]


FORM_HEAD = "<p>予約番号 RY1</p><a href='/form'>領収書発行</a>"
RADIOS = ("<label><input type='radio' name='k' value='様' checked>様</label>"
          "<label><input type='radio' name='k' value='御中'>御中</label>")


def open_form(context, page, tmp_path, form_html, timeout_ms=800):
    """一覧 → 入力画面(form_html)まで進めた Site を返す。"""
    html = "text/html; charset=utf-8"
    page.route("**/prefilled", lambda route: route.fulfill(content_type=html, body=FORM_HEAD))
    page.route("**/form", lambda route: route.fulfill(content_type=html, body=form_html))
    page.goto("http://dummy.invalid/prefilled")
    site = Site(context, page, tmp_path / "debug", timeout_ms=timeout_ms)
    (only,) = site.read_reservations()
    return site, site.open_receipt(only)


def test_prefilled_addressee_is_not_overwritten(context, page, tmp_path):
    # 宛名欄にすでに値が入っている画面は、修正画面かもしれない。上書きしない
    site, screen = open_form(context, page, tmp_path, (
        "<form action='/done'><label for='a'>宛名</label><input id='a' type='text' name='atena' value='前の値'>"
        + RADIOS + "<button>領収書の発行</button></form>"))
    assert screen is Screen.ADDRESSEE_INPUT
    with pytest.raises(UnexpectedScreen) as error:
        site.fill_addressee("株式会社サンプル", "御中")
    assert error.value.step == "fill_addressee" and "既に値" in error.value.detail
    assert page.locator("#a").input_value() == "前の値"


def test_fill_reads_back_what_the_page_kept(context, page, tmp_path):
    # 入力欄が文字数を切り詰めた。画面に残った値が指定と違うので、先へ進まない
    site, _ = open_form(context, page, tmp_path, (
        "<form action='/done'><label for='a'>宛名</label><input id='a' type='text' name='atena' maxlength='5'>"
        + RADIOS + "<button>領収書の発行</button></form>"))
    with pytest.raises(UnexpectedScreen) as error:
        site.fill_addressee("株式会社サンプル", "御中")
    assert error.value.step == "fill_addressee" and "反映" in error.value.detail


def test_two_radios_with_the_same_title_is_ambiguous(context, page, tmp_path):
    site, _ = open_form(context, page, tmp_path, (
        "<form action='/done'><label for='a'>宛名</label><input id='a' type='text' name='atena'>"
        + RADIOS + "<label><input type='radio' name='k2' value='御中'>御中</label>"
        "<button>領収書の発行</button></form>"))
    with pytest.raises(UnexpectedScreen) as error:
        site.fill_addressee("株式会社サンプル", "御中")
    assert error.value.step == "fill_addressee"


def test_two_text_inputs_without_label_is_ambiguous(context, page, tmp_path):
    page.route("**/list", lambda route: route.fulfill(content_type="text/html; charset=utf-8", body=(
        "<p>予約番号 RY1</p><a href='/form'>領収書発行</a>")))
    page.route("**/form", lambda route: route.fulfill(content_type="text/html; charset=utf-8", body=(
        "<input type='text' name='x'><input type='text' name='y'><button>領収書の発行</button>")))
    page.goto("http://dummy.invalid/list")
    site = Site(context, page, tmp_path / "debug", timeout_ms=500)
    (only,) = site.read_reservations()
    site.open_receipt(only)
    with pytest.raises(UnexpectedScreen) as error:
        site.fill_addressee("株式会社サンプル", "御中")
    assert error.value.step == "fill_addressee"


# --- レビュー指摘: 領収書が少し遅れて出る ---

def test_receipt_behind_an_interstitial_is_saved(context, page, dummy_site, tmp_path):
    # 「発行する」の後、「処理中」の画面をはさんで 0.8 秒後に領収書が出る
    site, rs = open_site(context, page, dummy_site, tmp_path, start="list_extra.html")
    target = tmp_path / "slow.pdf"
    issue(site, rs["RY203"], target)
    assert target.read_bytes().startswith(b"%PDF-")
    assert site.detect_screen() is Screen.RECEIPT


def test_receipt_drawn_late_is_recognised_on_open(context, page, dummy_site, tmp_path):
    # 発行済みの領収書。ページを開いて 0.8 秒後に中身が描かれる
    site, rs = open_site(context, page, dummy_site, tmp_path, start="list_extra.html")
    assert site.open_receipt(rs["RY204"]) is Screen.RECEIPT
    target = tmp_path / "late.pdf"
    site.save_receipt(target)
    assert target.read_bytes().startswith(b"%PDF-")


def test_unknown_screen_is_reported_after_waiting(context, page, dummy_site, tmp_path):
    # 最後まで分からない画面のままなら、待ったうえで UNKNOWN を返す(例外にはしない)
    site, rs = open_site(context, page, dummy_site, tmp_path, timeout_ms=600)
    started = time.monotonic()
    assert site.open_receipt(rs["RY006"]) is Screen.UNKNOWN
    assert 0.5 < time.monotonic() - started < 4


# --- レビュー指摘: PDF でないダウンロードを領収書として保存しない ---

def test_download_that_is_not_a_pdf_is_refused(context, page, dummy_site, tmp_path):
    site, rs = open_site(context, page, dummy_site, tmp_path, start="list_extra.html")
    assert site.open_receipt(rs["RY207"]) is Screen.ADDRESSEE_INPUT
    site.fill_addressee("株式会社サンプル", "御中")
    assert site.go_to_confirm() is Screen.CONFIRM
    site.submit_issue()  # エラーページの HTML が落ちてくる
    target = tmp_path / "bad.pdf"
    with pytest.raises(UnexpectedScreen) as error:
        site.save_receipt(target)
    assert error.value.step == "save_receipt" and "PDF" in error.value.detail
    assert not target.exists()


# --- 前の予約のダウンロードを、次の予約の領収書と取り違えない ---

def test_unsaved_download_does_not_leak_into_next_item(context, page, dummy_site, tmp_path, sample_pdf):
    site, rs = open_site(context, page, dummy_site, tmp_path)
    assert site.open_receipt(rs["RY003"]) is Screen.ADDRESSEE_INPUT
    site.fill_addressee("株式会社サンプル", "御中")
    site.go_to_confirm()
    site.submit_issue()  # ダウンロードが始まるが、保存せずに終える
    site.close_flow()
    assert site.open_receipt(rs["RY001"]) is Screen.ADDRESSEE_INPUT  # 前の件のダウンロードで RECEIPT 扱いにしない
    site.close_flow()
    assert site.open_receipt(rs["RY004"]) is Screen.RECEIPT
    target = tmp_path / "4.pdf"
    site.save_receipt(target)
    assert target.read_bytes() != sample_pdf and target.read_bytes().startswith(b"%PDF-")
