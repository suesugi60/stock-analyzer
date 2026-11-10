"""ファイル名の生成と、宛名の検証・照合。ブラウザには触らない。"""
from __future__ import annotations

import re
import string
import unicodedata
from pathlib import Path
from typing import List

from .models import Reservation

TITLES = ("様", "御中")
MAX_HOTEL_LEN = 60
MAX_ADDRESSEE_LEN = 50
NO_DATE = "日付不明"
NO_HOTEL = "施設名不明"

# 敬称「様」と紛らわしい、画面の決まり文句
TITLE_NOISE = ("お客様", "皆様", "様式")

_FORBIDDEN = re.compile(r'[/\\:*?"<>|\x00-\x1f\x7f\s]+')
_UNDERSCORES = re.compile(r"_+")
_WHITESPACE = re.compile(r"\s+")

# 楽天トラベルが宛名に使えないとしている文字(環境依存文字・特殊記号)
_SPECIAL_CHARS = set("㈱㈲㈹髙﨑♪〒")
_SPECIAL_RANGES = (
    (0x2150, 0x218F),  # ローマ数字など
    (0x2460, 0x24FF),  # 囲み英数字
    (0x3200, 0x33FF),  # 囲み CJK 文字・組文字
    (0xF900, 0xFAFF),  # CJK 互換漢字
)


def _safe_part(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = _FORBIDDEN.sub("_", text)
    text = _UNDERSCORES.sub("_", text)
    return text.strip("_.")


def receipt_filename(res: Reservation) -> str:
    """領収書 PDF のファイル名。例: 2025-03-15_ホテル名_予約番号.pdf"""
    day = res.checkin.isoformat() if res.checkin else NO_DATE
    hotel = _safe_part(res.hotel_name)[:MAX_HOTEL_LEN].strip("_.") or NO_HOTEL
    reservation_id = _safe_part(res.reservation_id)
    return f"{day}_{hotel}_{reservation_id}.pdf"


def unique_path(directory: Path, filename: str) -> Path:
    """directory の中で、既存のファイルと重ならないパスを返す(上書きしない)。"""
    candidate = directory / filename
    stem, suffix = candidate.stem, candidate.suffix
    number = 2
    while candidate.exists():
        candidate = directory / f"{stem}_{number}{suffix}"
        number += 1
    return candidate


def _is_special(char: str) -> bool:
    if char in _SPECIAL_CHARS:
        return True
    code = ord(char)
    return any(low <= code <= high for low, high in _SPECIAL_RANGES)


def validate_addressee(name: str) -> List[str]:
    """宛名の問題点を日本語で返す。空リストなら問題なし。"""
    name = name.strip()
    if not name:
        return ["宛名が空です"]
    errors: List[str] = []
    if len(name) > MAX_ADDRESSEE_LEN:
        errors.append(f"宛名は{MAX_ADDRESSEE_LEN}文字までです(現在 {len(name)} 文字)")
    symbols = sorted({c for c in name if c in string.punctuation})
    if symbols:
        errors.append("半角記号は使えません: " + " ".join(symbols))
    special = sorted({c for c in name if _is_special(c)})
    if special:
        errors.append("環境依存文字・特殊記号は使えません: " + " ".join(special))
    return errors


def _squash(text: str) -> str:
    return _WHITESPACE.sub("", text)


def addressee_matches(confirm_text: str, name: str, title: str) -> bool:
    """確認画面の本文に、指定した宛名と敬称が出ているか(空白の違いは無視)。"""
    text = _squash(confirm_text)
    name = _squash(name)
    title = _squash(title)
    if not name or not title or name not in text:
        return False
    rest = text.replace(name, "")
    for noise in TITLE_NOISE:
        rest = rest.replace(noise, "")
    return title in rest
