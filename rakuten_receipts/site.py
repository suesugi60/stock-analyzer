"""楽天トラベルの画面を読む・押す。判断はしない(判断は runner の役目)。

セレクタと画面の文言はこのファイルだけに置く。ログイン後の実画面を見ないまま
公式ヘルプの文言を手がかりに書いているので、実画面と合わないところはここを直す。
"""
from __future__ import annotations

import re
import time
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Set
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, Error as PlaywrightError, Page

from .models import Reservation, Screen
from .naming import NO_HOTEL

# --- 画面の文言 ---
TEXT_RECEIPT_LINK = "領収書発行"
TEXT_GO_CONFIRM = "領収書の発行"
TEXT_SUBMIT = "発行する"
TEXT_RESERVATION_ID = "予約番号"
FIX_MARKERS_ANYWHERE = ("再発行", "発行済")
FIX_MARKERS_IN_CONTROLS = ("修正",)  # ボタン・リンク・見出しの文言に限って見る
TEXT_RECEIPT_TITLE = "領収書"
INVOICE_NUMBER = re.compile(r"T\d{13}")  # 適格請求書発行事業者の登録番号。領収書には必ず載る
LOGIN_HOSTS = ("login.account.rakuten.com", "id.rakuten.co.jp")
CHECKIN_LABELS = ("チェックイン", "宿泊日", "宿泊期間", "利用日")
CHECKOUT_LABELS = ("チェックアウト",)
AMOUNT_LABELS = ("合計", "料金", "支払")
NEXT_PATTERN = re.compile(r"^\s*(次へ|次の\d*件|次ページ|次)\s*[>»›]*\s*$")

MAX_PAGES = 50
PAGE_CHANGE_WAIT_MS = 3000

_ID = re.compile(TEXT_RESERVATION_ID + r"[\s::]*([A-Za-z0-9\-]+)")
_DATE = re.compile(r"(\d{4})\s*[/年.\-]\s*(\d{1,2})\s*[/月.\-]\s*(\d{1,2})")
_RANGE_SEPARATOR = re.compile(r"\s*日?\s*(?:[((][^))]{1,3}[))])?\s*[〜~\-−–—]\s*")
_AMOUNT = re.compile(r"([\d,]+)\s*円")

# ページ内で使う共通の関数。visible は表示中か、textOf は表示上の文言。
_JS_HELPERS = """
const visible = (el) => {
  if (!el.getClientRects().length) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
};
const textOf = (el) => ((el.innerText || el.value || '') + '').replace(/\\s+/g, ' ').trim();
const CONTROLS = 'a, button, input[type=button], input[type=submit]';
const findBlocks = (idLabel) => {
  const count = (el) => (el.innerText || '').split(idLabel).length - 1;
  const blocks = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let block = node.parentElement;
    if (!block || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(block.tagName)) continue;
    if (!node.nodeValue.includes(idLabel) || count(block) !== 1) continue;
    while (block !== document.body && block.parentElement && count(block.parentElement) === 1) {
      block = block.parentElement;
    }
    if (!blocks.includes(block)) blocks.push(block);
  }
  return blocks;
};
"""

_JS_FACTS = "(a) => {" + _JS_HELPERS + """
  const body = document.body ? document.body.innerText : '';
  const controls = Array.from(document.querySelectorAll(CONTROLS)).filter(visible);
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, legend')).filter(visible);
  // サイト共通のヘッダーなどにある検索欄は、宛名の入力欄とはみなさない
  const inChrome = (el) => !!el.closest('header, nav, footer, [role=search], [role=banner], [role=navigation]');
  const textInputs = Array.from(document.querySelectorAll('input, textarea')).filter((el) => {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return (el.tagName === 'TEXTAREA' || type === 'text') && visible(el) && !el.disabled && !inChrome(el);
  });
  return {
    hasPassword: Array.from(document.querySelectorAll('input[type=password]')).some(visible),
    hasTextInput: textInputs.length > 0,
    submitExact: controls.some((c) => textOf(c) === a.submit),
    goConfirm: controls.some((c) => textOf(c).includes(a.goConfirm)),
    fixAnywhere: a.fixAnywhere.some((m) => body.includes(m)),
    fixInControls: controls.concat(headings).some((c) => a.fixInControls.some((m) => textOf(c).includes(m))),
    hasReceiptTitle: body.includes(a.receiptTitle),
    hasInvoice: new RegExp(a.invoice).test(body),
    hasReceiptLink: controls.some((c) => textOf(c).includes(a.receiptLink)),
    hasReservationId: body.includes(a.reservationId),
  };
}"""

_JS_BLOCKS = "(a) => {" + _JS_HELPERS + """
  return findBlocks(a.idLabel).map((block) => {
    const hotelLink = block.querySelector('a[href*="/HOTEL/"]');
    const heading = block.querySelector('h1, h2, h3, h4');
    const hotel = hotelLink ? textOf(hotelLink) : (heading ? textOf(heading) : '');
    const hasReceipt = Array.from(block.querySelectorAll(CONTROLS))
      .some((c) => visible(c) && textOf(c).includes(a.receiptLink));
    return {text: block.innerText || '', hotel, hasReceipt};
  });
}"""

_JS_TAG_NEXT = "(a) => {" + _JS_HELPERS + """
  document.querySelectorAll('[data-rr-next]').forEach((el) => el.removeAttribute('data-rr-next'));
  const pattern = new RegExp(a.pattern);
  const next = Array.from(document.querySelectorAll(CONTROLS)).find((c) =>
    visible(c) && !c.disabled && c.getAttribute('aria-disabled') !== 'true' && pattern.test(textOf(c)));
  if (!next) return false;
  next.setAttribute('data-rr-next', '1');
  return true;
}"""


NAVIGATION_RETRIES = 5


def evaluate_with_retry(page: Page, script: str, arg: object = None) -> object:
    """page.evaluate の代わり。読み取りの最中にページ遷移が起きたら、移った先で読み直す。"""
    for attempt in range(NAVIGATION_RETRIES):
        try:
            page.wait_for_load_state("domcontentloaded")
            return page.evaluate(script, arg)
        except PlaywrightError as error:
            message = str(error)
            if "Execution context was destroyed" not in message and "navigat" not in message:
                raise
            if attempt == NAVIGATION_RETRIES - 1:
                raise
    raise AssertionError("unreachable")


def _to_date(match: Optional[re.Match]) -> Optional[date]:
    if match is None:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _label_position(text: str, labels) -> Optional[int]:
    positions = [text.find(label) for label in labels if label in text]
    return min(positions) if positions else None


def parse_block_text(text: str) -> Dict[str, object]:
    """予約1件ぶんの表示テキストから、予約番号・日付・金額を取り出す。なければ None。"""
    id_match = _ID.search(text)

    start = _label_position(text, CHECKIN_LABELS)
    checkin_match = _DATE.search(text, start) if start is not None else None
    if checkin_match is None:
        checkin_match = _DATE.search(text)

    checkout_match = None
    start = _label_position(text, CHECKOUT_LABELS)
    if start is not None:
        checkout_match = _DATE.search(text, start)
    elif checkin_match is not None:
        separator = _RANGE_SEPARATOR.match(text, checkin_match.end())
        if separator is not None:
            checkout_match = _DATE.match(text, separator.end())

    start = _label_position(text, AMOUNT_LABELS)
    amount_match = _AMOUNT.search(text, start) if start is not None else None
    if amount_match is None:
        amount_match = _AMOUNT.search(text)
    amount: Optional[int] = None
    if amount_match is not None:
        digits = amount_match.group(1).replace(",", "")
        amount = int(digits) if digits else None

    return {
        "reservation_id": id_match.group(1) if id_match else None,
        "checkin": _to_date(checkin_match),
        "checkout": _to_date(checkout_match),
        "amount": amount,
    }


def detect_screen(page: Page) -> Screen:
    """いまの画面の種別を、表示されている文言から判定する。"""
    host = urlparse(page.url).hostname or ""
    if any(login_host in host for login_host in LOGIN_HOSTS):
        return Screen.LOGIN
    facts = evaluate_with_retry(page, _JS_FACTS, {
        "submit": TEXT_SUBMIT,
        "goConfirm": TEXT_GO_CONFIRM,
        "fixAnywhere": list(FIX_MARKERS_ANYWHERE),
        "fixInControls": list(FIX_MARKERS_IN_CONTROLS),
        "receiptTitle": TEXT_RECEIPT_TITLE,
        "invoice": INVOICE_NUMBER.pattern,
        "receiptLink": TEXT_RECEIPT_LINK,
        "reservationId": TEXT_RESERVATION_ID,
    })
    if facts["hasPassword"]:
        return Screen.LOGIN
    if not facts["hasTextInput"] and facts["submitExact"]:
        return Screen.CONFIRM
    if facts["hasTextInput"]:
        if facts["fixAnywhere"] or facts["fixInControls"]:
            return Screen.ADDRESSEE_FIX
        if facts["goConfirm"]:
            return Screen.ADDRESSEE_INPUT
        return Screen.UNKNOWN
    if facts["hasReceiptTitle"] and facts["hasInvoice"] and not facts["hasReceiptLink"]:
        return Screen.RECEIPT
    if facts["hasReservationId"]:
        return Screen.LIST
    return Screen.UNKNOWN


class Site:
    """予約一覧のタブを起点に、楽天トラベルの画面を操作する。"""

    def __init__(self, context: BrowserContext, list_page: Page, debug_dir: Path,
                 timeout_ms: int = 15000) -> None:
        self.context = context
        self.list_page = list_page
        self.list_url = list_page.url
        self.debug_dir = Path(debug_dir)
        self.timeout_ms = timeout_ms
        self._flow: Optional[Page] = None  # 発行操作中のページ(一覧と同じタブのこともある)

    def _current(self) -> Page:
        return self._flow if self._flow is not None else self.list_page

    def detect_screen(self) -> Screen:
        return detect_screen(self._current())

    # --- 予約一覧の読み取り ---

    def _read_blocks(self, page: Page) -> List[dict]:
        blocks = evaluate_with_retry(
            page, _JS_BLOCKS, {"idLabel": TEXT_RESERVATION_ID, "receiptLink": TEXT_RECEIPT_LINK})
        for block in blocks:
            block.update(parse_block_text(block["text"]))
        return [block for block in blocks if block["reservation_id"]]

    def _go_next(self, page: Page, current_ids: Set[str]) -> bool:
        """次のページへ進む。進めて、予約の顔ぶれが変わったら True。"""
        if not evaluate_with_retry(page, _JS_TAG_NEXT, {"pattern": NEXT_PATTERN.pattern}):
            return False
        page.locator("[data-rr-next]").first.click(timeout=self.timeout_ms)
        deadline = time.monotonic() + min(self.timeout_ms, PAGE_CHANGE_WAIT_MS) / 1000
        while True:
            page.wait_for_load_state("load")
            ids = {block["reservation_id"] for block in self._read_blocks(page)}
            if ids and ids != current_ids:
                return True
            if time.monotonic() >= deadline:
                return False
            page.wait_for_timeout(100)

    def read_reservations(self) -> List[Reservation]:
        """いま表示している一覧ページから、次ページをたどりながら全件を読む。"""
        page = self.list_page
        found: Dict[str, Reservation] = {}
        for index in range(MAX_PAGES):
            blocks = self._read_blocks(page)
            for block in blocks:
                reservation_id = block["reservation_id"]
                if reservation_id in found:
                    continue
                found[reservation_id] = Reservation(
                    reservation_id=reservation_id,
                    hotel_name=block["hotel"] or NO_HOTEL,
                    checkin=block["checkin"],
                    checkout=block["checkout"],
                    amount=block["amount"],
                    receipt_available=bool(block["hasReceipt"]),
                    page_index=index,
                )
            if not self._go_next(page, {block["reservation_id"] for block in blocks}):
                break
        return list(found.values())
