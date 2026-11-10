from __future__ import annotations

from datetime import date

import pytest

from rakuten_receipts.models import Reservation
from rakuten_receipts.naming import (
    addressee_matches,
    receipt_filename,
    unique_path,
    validate_addressee,
)

R = Reservation("RY12345", "ホテル サンプル/東京", date(2025, 3, 15), date(2025, 3, 16), 12000, True)


def with_hotel(name: str) -> Reservation:
    return Reservation("RY12345", name, date(2025, 3, 15), date(2025, 3, 16), 12000, True)


def hotel_part(filename: str) -> str:
    assert filename.startswith("2025-03-15_") and filename.endswith("_RY12345.pdf")
    return filename[len("2025-03-15_"):-len("_RY12345.pdf")]


def test_filename_basic():
    assert receipt_filename(R) == "2025-03-15_ホテル_サンプル_東京_RY12345.pdf"


def test_filename_forbidden_chars():
    name = 'A/B\\C:D*E?F"G<H>I|J\tK'
    assert hotel_part(receipt_filename(with_hotel(name))) == "A_B_C_D_E_F_G_H_I_J_K"


def test_filename_fullwidth_space_and_runs():
    assert hotel_part(receipt_filename(with_hotel("ホテル　 　別館"))) == "ホテル_別館"


def test_filename_long_name_cut_to_60():
    assert hotel_part(receipt_filename(with_hotel("あ" * 80))) == "あ" * 60


def test_filename_no_date():
    res = Reservation("RY12345", "ホテルA", None, None, None, True)
    assert receipt_filename(res) == "日付不明_ホテルA_RY12345.pdf"


def test_filename_empty_hotel():
    assert hotel_part(receipt_filename(with_hotel("  / "))) == "施設名不明"


def test_unique_path(tmp_path):
    assert unique_path(tmp_path, "a.pdf") == tmp_path / "a.pdf"
    (tmp_path / "a.pdf").write_bytes(b"x")
    assert unique_path(tmp_path, "a.pdf") == tmp_path / "a_2.pdf"
    (tmp_path / "a_2.pdf").write_bytes(b"x")
    assert unique_path(tmp_path, "a.pdf") == tmp_path / "a_3.pdf"


def test_validate_ok():
    assert validate_addressee("株式会社サンプル") == []


def test_validate_50_chars_ok():
    assert validate_addressee("あ" * 50) == []


def test_validate_halfwidth_alnum_ok():
    assert validate_addressee("ABC Trading 123") == []


def test_validate_ignores_surrounding_spaces():
    assert validate_addressee("  " + "あ" * 50 + "　") == []


@pytest.mark.parametrize(
    "bad",
    ["", "   ", "あ" * 51, "ABC(株)", "サンプル!", "㈱サンプル", "髙橋商店", "山﨑商店", "サンプル♪", "〒サンプル", "サンプル①"],
)
def test_validate_rejects(bad):
    assert validate_addressee(bad) != []


def test_validate_message_names_the_bad_characters():
    (message,) = validate_addressee("㈱サンプル")
    assert "㈱" in message


def test_match_same_line():
    assert addressee_matches("宛名 株式会社サンプル 御中", "株式会社サンプル", "御中")


def test_match_separate_cells():
    assert addressee_matches("宛名:株式会社サンプル\n敬称:御中", "株式会社サンプル", "御中")


def test_match_ignores_spaces():
    assert addressee_matches("株式会社 サンプル　御中", "株式会社サンプル", "御中")


def test_mismatch_name():
    assert not addressee_matches("株式会社見本 御中", "株式会社サンプル", "御中")


def test_mismatch_title():
    assert not addressee_matches("株式会社サンプル 様", "株式会社サンプル", "御中")


def test_okyakusama_is_not_title():
    assert not addressee_matches("株式会社サンプル 御中 お客様へのご案内", "株式会社サンプル", "様")


def test_title_inside_name_does_not_count():
    # 宛名そのものに「様」が含まれていても、敬称が「様」だとはみなさない
    assert not addressee_matches("様々商事 御中", "様々商事", "様")


def test_match_sama():
    assert addressee_matches("山田太郎 様 お客様へのご案内", "山田太郎", "様")


# --- レビュー指摘: 宛名と敬称を別々の場所から拾わない ---

from rakuten_receipts.naming import confirm_excerpt  # noqa: E402


@pytest.mark.parametrize("text, name, title", [
    # 宛名は「御中」なのに、別の行(宿泊者)の「様」を敬称とみなしてはいけない
    ("宛名 株式会社サンプル 御中\n宿泊者 山田太郎 様", "株式会社サンプル", "様"),
    # 敬称の選び方の説明文に両方の敬称が出ている
    ("宛名 株式会社サンプル\n敬称は 様 か 御中 から選べます", "株式会社サンプル", "御中"),
    ("株式会社サンプル 同様", "株式会社サンプル", "様"),
    # 指定した宛名を含む、もっと長い宛名
    ("宛名 株式会社サンプルホールディングス 御中", "株式会社サンプル", "御中"),
    ("宛名 東京株式会社サンプル 御中", "株式会社サンプル", "御中"),
    ("山田太郎 様式", "山田太郎", "様"),
])
def test_addressee_mismatch_cases(text, name, title):
    assert not addressee_matches(text, name, title)


@pytest.mark.parametrize("text, name, title", [
    ("宛名\t株式会社サンプル\n敬称\t御中", "株式会社サンプル", "御中"),   # 表の innerText
    ("宛名:株式会社サンプル 敬称:御中", "株式会社サンプル", "御中"),
    ("株式会社サンプル御中", "株式会社サンプル", "御中"),
    ("宛名株式会社サンプル 御中", "株式会社サンプル", "御中"),
    ("株式会社サンプル 御中として発行します", "株式会社サンプル", "御中"),
    ("山田太郎様", "山田 太郎", "様"),
])
def test_addressee_match_layouts(text, name, title):
    assert addressee_matches(text, name, title)


def test_confirm_excerpt_shows_the_lines_on_the_page():
    text = "宛名の確認\n宛名 株式会社サンプルホールディングス\n敬称 御中\n\n発行する"
    excerpt = confirm_excerpt(text, "株式会社サンプル")
    assert "株式会社サンプルホールディングス" in excerpt  # 指定した宛名ではなく、画面に出ている文字
    assert "敬称 御中" in excerpt
    assert "発行する" not in excerpt


def test_confirm_excerpt_without_name_falls_back_to_page_text():
    excerpt = confirm_excerpt("宛名\n\n敬称 様", "株式会社サンプル")
    assert "敬称 様" in excerpt
