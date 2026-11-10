"""楽天トラベルの画面を読む・押す。判断はしない(判断は runner の役目)。

セレクタと画面の文言はこのファイルだけに置く。ログイン後の実画面を見ないまま
公式ヘルプの文言を手がかりに書いているので、実画面と合わないところはここを直す。
"""
from __future__ import annotations

import functools
import re
import time
from datetime import date, datetime
from pathlib import Path
from typing import Dict, List, Optional, Set
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, Download, Error as PlaywrightError, Locator, Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from .models import Reservation, Screen, UnexpectedScreen
from .naming import NO_HOTEL

# --- 画面の文言 ---
TEXT_RECEIPT_LINK = "領収書発行"
TEXT_GO_CONFIRM = "領収書の発行"
TEXT_SUBMIT = "発行する"
TEXT_RESERVATION_ID = "予約番号"
FIX_MARKERS_ANYWHERE = ("再発行", "発行済")
# ボタン・リンク・見出しの文言に限って見る(注記の文中に出てくるだけでは目印にしない)。
# サイト共通のヘッダーやナビの中にあるものも見ない
FIX_MARKERS_IN_CONTROLS = ("修正", "変更", "訂正")
TEXT_RECEIPT_TITLE = "領収書"
INVOICE_NUMBER = re.compile(r"T\d{13}")  # 適格請求書発行事業者の登録番号。領収書には必ず載る
LOGIN_HOSTS = ("login.account.rakuten.com", "id.rakuten.co.jp")
CHECKIN_LABELS = ("チェックイン", "宿泊日", "宿泊期間", "利用日")
CHECKOUT_LABELS = ("チェックアウト",)
AMOUNT_LABELS = ("合計", "料金", "支払")
NEXT_PATTERN = re.compile(r"^\s*(次へ|次の\d*件|次ページ|次)\s*[>»›]*\s*$")

MAX_PAGES = 50
PAGE_CHANGE_WAIT_MS = 3000
ISSUE_TIMEOUT_MS = 30000  # 「発行する」を押してから領収書が出るまで待つ時間
PDF_MAGIC = b"%PDF-"
TEXT_ADDRESSEE_LABEL = "宛名"

_ID_PREFIX = TEXT_RESERVATION_ID + r"[\s::]*"
_ID = re.compile(_ID_PREFIX + r"([A-Za-z0-9\-]+)")
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
  // サイト共通のヘッダーやナビにあるものは、領収書の画面の中身とはみなさない
  const inChrome = (el) => !!el.closest('header, nav, footer, [role=search], [role=banner], [role=navigation]');
  const controls = Array.from(document.querySelectorAll(CONTROLS)).filter(visible);
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, legend')).filter(visible);
  const ownParts = controls.concat(headings).filter((el) => !inChrome(el));
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
    fixInControls: ownParts.some((c) => a.fixInControls.some((m) => textOf(c).includes(m))),
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


_JS_TAG_RECEIPT = "(a) => {" + _JS_HELPERS + """
  document.querySelectorAll('[data-rr-click]').forEach((el) => el.removeAttribute('data-rr-click'));
  const pattern = new RegExp(a.pattern);
  for (const block of findBlocks(a.idLabel)) {
    if (!pattern.test(block.innerText || '')) continue;
    const control = Array.from(block.querySelectorAll(CONTROLS))
      .find((c) => visible(c) && textOf(c).includes(a.receiptLink));
    if (!control) continue;
    control.setAttribute('data-rr-click', '1');
    return true;
  }
  return false;
}"""

_JS_TAG_CONTROL = "(a) => {" + _JS_HELPERS + """
  document.querySelectorAll('[data-rr-click]').forEach((el) => el.removeAttribute('data-rr-click'));
  const control = Array.from(document.querySelectorAll(CONTROLS)).find((c) => {
    if (!visible(c) || c.disabled) return false;
    return a.exact ? textOf(c) === a.text : textOf(c).includes(a.text);
  });
  if (!control) return false;
  control.setAttribute('data-rr-click', '1');
  return true;
}"""

_JS_SELECTED_OPTION = "(el) => (el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : '')"

_UNSAFE_LABEL = re.compile(r"[^\w\-]+")


def _as_unexpected(method):
    """要素が時間内に見つからない Playwright の TimeoutError を UnexpectedScreen に変える。"""

    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        try:
            return method(self, *args, **kwargs)
        except PlaywrightTimeoutError as error:
            raise UnexpectedScreen(method.__name__, detail=str(error).splitlines()[0]) from error

    return wrapper


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


def _screen_facts(page: Page) -> dict:
    """画面の判定に使う材料(何があるか・ないか)を、ページから取り出す。"""
    return evaluate_with_retry(page, _JS_FACTS, {
        "submit": TEXT_SUBMIT,
        "goConfirm": TEXT_GO_CONFIRM,
        "fixAnywhere": list(FIX_MARKERS_ANYWHERE),
        "fixInControls": list(FIX_MARKERS_IN_CONTROLS),
        "receiptTitle": TEXT_RECEIPT_TITLE,
        "invoice": INVOICE_NUMBER.pattern,
        "receiptLink": TEXT_RECEIPT_LINK,
        "reservationId": TEXT_RESERVATION_ID,
    })


def _classify(url: str, facts: Optional[dict]) -> Screen:
    """材料から画面の種別を決める。facts が None なら、URL だけで決められる範囲で決める。"""
    host = urlparse(url).hostname or ""
    if any(login_host in host for login_host in LOGIN_HOSTS):
        return Screen.LOGIN
    if facts is None:
        return Screen.UNKNOWN
    if facts["hasPassword"]:
        return Screen.LOGIN
    fix_markers = facts["fixAnywhere"] or facts["fixInControls"]
    if not facts["hasTextInput"] and facts["submitExact"]:
        # 「発行する」があっても、修正・再発行の目印がある画面では押さない
        return Screen.ADDRESSEE_FIX if fix_markers else Screen.CONFIRM
    if facts["hasTextInput"]:
        if fix_markers:
            return Screen.ADDRESSEE_FIX
        if facts["goConfirm"]:
            return Screen.ADDRESSEE_INPUT
        return Screen.UNKNOWN
    if facts["hasReceiptTitle"] and facts["hasInvoice"] and not facts["hasReceiptLink"]:
        return Screen.RECEIPT
    if facts["hasReservationId"]:
        return Screen.LIST
    return Screen.UNKNOWN


def detect_screen(page: Page) -> Screen:
    """いまの画面の種別を、表示されている文言から判定する。"""
    host = urlparse(page.url).hostname or ""
    if any(login_host in host for login_host in LOGIN_HOSTS):
        return Screen.LOGIN
    return _classify(page.url, _screen_facts(page))


SCREEN_NAMES = {
    Screen.LOGIN: "ログイン",
    Screen.LIST: "予約一覧",
    Screen.ADDRESSEE_INPUT: "宛名の入力",
    Screen.ADDRESSEE_FIX: "修正・再発行らしい画面",
    Screen.CONFIRM: "確認",
    Screen.RECEIPT: "領収書",
    Screen.UNKNOWN: "不明",
}


def describe_page(page: Page) -> str:
    """ページをどう判定したかを1行で説明する。うまく動かないときに、利用者がそのまま貼れるようにする。

    画面の本文や URL の ? 以降は出さない(氏名や予約番号を含みうるため)。出すのは、
    ページの場所(ホストとパス)と、判定の材料が「あり」か「なし」かだけ。
    """
    try:
        parsed = urlparse(page.url)
        where = f"{parsed.hostname or ''}{parsed.path}" or "(空のページ)"
        facts = _screen_facts(page)
        screen = _classify(page.url, facts)
    except Exception:  # noqa: BLE001 - 説明のための読み取りで、本体の処理を止めない
        return "(このタブは読み取れません)"

    def mark(key: str) -> str:
        return "あり" if facts[key] else "なし"

    return (f"{where} → 判定: {SCREEN_NAMES[screen]}("
            f"{TEXT_RESERVATION_ID}の文字: {mark('hasReservationId')}、"
            f"{TEXT_RECEIPT_LINK}: {mark('hasReceiptLink')}、"
            f"入力欄: {mark('hasTextInput')}、"
            f"パスワード欄: {mark('hasPassword')}、"
            f"{TEXT_GO_CONFIRM}: {mark('goConfirm')}、"
            f"{TEXT_SUBMIT}: {mark('submitExact')}、"
            f"修正・再発行の目印: {'あり' if facts['fixAnywhere'] or facts['fixInControls'] else 'なし'})")


def save_page_diagnostics(page: Page, debug_dir: Path, label: str) -> Optional[Path]:
    """page のスクリーンショットと HTML を debug_dir に残す。失敗しても例外にしない。"""
    try:
        debug_dir = Path(debug_dir)
        debug_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        base = debug_dir / f"{stamp}_{_UNSAFE_LABEL.sub('_', label)}"
        png = Path(str(base) + ".png")
        Path(str(base) + ".html").write_text(page.content(), encoding="utf-8")
        page.screenshot(path=str(png), full_page=True)
        return png
    except Exception:  # noqa: BLE001 - 診断の保存に失敗しても本体の処理は止めない
        return None


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
        self._download: Optional[Download] = None  # このフローの領収書として受け取ったダウンロード
        self._downloads: List[Download] = []  # このフローの間に始まったダウンロード
        self._popups: List[Page] = []  # このフローの間に開いたタブ
        for existing in context.pages:
            existing.on("download", self._on_download)
        context.on("page", self._on_page)

    def _on_download(self, download: Download) -> None:
        self._downloads.append(download)

    def _on_page(self, new_page: Page) -> None:
        self._popups.append(new_page)
        new_page.on("download", self._on_download)

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
            added = 0
            for block in blocks:
                reservation_id = block["reservation_id"]
                if reservation_id in found:
                    continue
                added += 1
                found[reservation_id] = Reservation(
                    reservation_id=reservation_id,
                    hotel_name=block["hotel"] or NO_HOTEL,
                    checkin=block["checkin"],
                    checkout=block["checkout"],
                    amount=block["amount"],
                    receipt_available=bool(block["hasReceipt"]),
                    page_index=index,
                )
            if index > 0 and added == 0:
                break
            if not self._go_next(page, {block["reservation_id"] for block in blocks}):
                break
        return list(found.values())

    # --- 領収書の発行操作 ---

    def _find_control(self, page: Page, text: str, exact: bool, step: str) -> Locator:
        """文言でボタンやリンクを探す。時間内に現れなければ UnexpectedScreen。"""
        deadline = time.monotonic() + self.timeout_ms / 1000
        while True:
            if evaluate_with_retry(page, _JS_TAG_CONTROL, {"text": text, "exact": exact}):
                return page.locator("[data-rr-click]").first
            if time.monotonic() >= deadline:
                raise UnexpectedScreen(step, detect_screen(page), f"「{text}」が見つからない")
            page.wait_for_timeout(100)

    def _flow_popups(self, since: int) -> List[Page]:
        """クリックの後に、操作中のページから開かれたタブ(利用者が自分で開いたタブは含めない)。"""
        opened = []
        for popup in self._popups[since:]:
            try:
                if not popup.is_closed() and popup.opener() is not None:
                    opened.append(popup)
            except PlaywrightError:
                continue
        return opened

    def _click_and_wait(self, target: Locator, timeout_ms: int, step: str,
                        want: Optional[Set[Screen]] = None) -> Screen:
        """クリックし、画面が落ち着くまで待って、その画面種別を返す。

        ダウンロードが始まったら領収書として受け取り RECEIPT を返す。新しいタブが開いたら、そちらを
        操作対象にする。「処理中」のような分からない画面のうちは待ち続け、want を指定されたら
        その画面になるまで待つ。時間切れのときは、そのときの画面種別を返す。
        何も変わらなかったときだけ UnexpectedScreen。
        """
        page = self._current()
        self._flow = page
        before = (page.url, detect_screen(page))
        downloads_before, popups_before = len(self._downloads), len(self._popups)
        target.click(timeout=self.timeout_ms)
        deadline = time.monotonic() + timeout_ms / 1000
        changed = False
        screen = before[1]
        while True:
            if len(self._downloads) > downloads_before:
                self._download = self._downloads[-1]
                return Screen.RECEIPT
            popups = self._flow_popups(popups_before)
            if popups and self._flow is not popups[-1]:
                self._flow = popups[-1]
                changed = True
            current = self._current()
            try:
                signature = (current.url, detect_screen(current))
            except PlaywrightError:
                signature = None  # 遷移の途中。次の周で読み直す
            if signature is not None:
                screen = signature[1]
                if current is not page or signature != before:
                    changed = True
                if changed and screen is not Screen.UNKNOWN and (want is None or screen in want):
                    return screen
            if time.monotonic() >= deadline:
                if not changed:
                    raise UnexpectedScreen(step, before[1], "クリックしても画面が変わらない")
                return screen
            self.list_page.wait_for_timeout(100)

    @_as_unexpected
    def open_receipt(self, reservation: Reservation) -> Screen:
        """一覧に戻り、その予約の「領収書発行」を押す。移った先の画面種別を返す。"""
        self.close_flow()
        page = self.list_page
        page.goto(self.list_url, wait_until="load", timeout=self.timeout_ms)
        screen = detect_screen(page)
        if screen is Screen.LOGIN:
            return screen
        for _ in range(reservation.page_index):
            ids = {block["reservation_id"] for block in self._read_blocks(page)}
            if not self._go_next(page, ids):
                raise UnexpectedScreen("open_receipt", screen, "一覧の次ページへ進めない")
        tagged = evaluate_with_retry(page, _JS_TAG_RECEIPT, {
            "idLabel": TEXT_RESERVATION_ID,
            "receiptLink": TEXT_RECEIPT_LINK,
            # この予約番号ちょうどに一致させる(RY00 が RY001 に当たらないように)
            "pattern": _ID_PREFIX + re.escape(reservation.reservation_id) + r"(?![A-Za-z0-9\-])",
        })
        if not tagged:
            raise UnexpectedScreen(
                "open_receipt", screen, f"予約番号 {reservation.reservation_id} の「{TEXT_RECEIPT_LINK}」が見つからない")
        return self._click_and_wait(page.locator("[data-rr-click]").first, self.timeout_ms, "open_receipt")

    def _addressee_field(self, page: Page) -> Locator:
        candidates = (
            page.get_by_label(re.compile(TEXT_ADDRESSEE_LABEL)),
            page.locator("input[type=text], input:not([type]), textarea"),
        )
        for candidate in candidates:
            shown = [candidate.nth(i) for i in range(candidate.count()) if candidate.nth(i).is_visible()]
            if len(shown) == 1:
                return shown[0]
        raise UnexpectedScreen("fill_addressee", detect_screen(page), "宛名の入力欄を1つに決められない")

    @_as_unexpected
    def fill_addressee(self, name: str, title: str) -> None:
        """宛名を入力し、敬称を選ぶ。入力後に画面の値を読み直して確かめる。"""
        page = self._current()
        field = self._addressee_field(page)
        if field.input_value(timeout=self.timeout_ms).strip():
            # 発行済みの宛名を直す画面かもしれない。修正は1回限りなので、上書きしない
            raise UnexpectedScreen("fill_addressee", detect_screen(page), "宛名欄に既に値が入っている(修正画面の可能性)")
        field.fill(name, timeout=self.timeout_ms)

        radio = page.get_by_role("radio", name=title, exact=True)
        select = page.locator("select").filter(
            has=page.locator("option", has_text=re.compile(rf"^\s*{re.escape(title)}\s*$")))
        radios, selects = radio.count(), select.count()
        if radios == 1:
            radio.first.check(timeout=self.timeout_ms)
            title_ok = radio.first.is_checked()
        elif radios == 0 and selects == 1:
            select.first.select_option(label=title, timeout=self.timeout_ms)
            title_ok = select.first.evaluate(_JS_SELECTED_OPTION) == title
        else:
            raise UnexpectedScreen("fill_addressee", detect_screen(page), f"敬称「{title}」の選択肢を1つに決められない")

        if field.input_value() != name or not title_ok:
            raise UnexpectedScreen("fill_addressee", detect_screen(page), "入力した宛名・敬称が画面に反映されていない")

    @_as_unexpected
    def go_to_confirm(self) -> Screen:
        """「領収書の発行」を押し、移った先の画面種別を返す。"""
        button = self._find_control(self._current(), TEXT_GO_CONFIRM, False, "go_to_confirm")
        return self._click_and_wait(button, self.timeout_ms, "go_to_confirm")

    @_as_unexpected
    def read_confirm_text(self) -> str:
        return self._current().inner_text("body", timeout=self.timeout_ms)

    @_as_unexpected
    def submit_issue(self) -> None:
        """「発行する」を押し、領収書(ページかダウンロード)が出るまで待つ。ここから先は取り消せない。"""
        button = self._find_control(self._current(), TEXT_SUBMIT, True, "submit_issue")
        self._click_and_wait(button, ISSUE_TIMEOUT_MS, "submit_issue", want={Screen.RECEIPT})

    @_as_unexpected
    def save_receipt(self, path: Path) -> None:
        """領収書を PDF として保存する。ダウンロードされたファイルか、表示中のページを使う。"""
        path = Path(path)
        if self._download is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._download.save_as(str(path))
            with open(path, "rb") as f:
                head = f.read(len(PDF_MAGIC))
            if head != PDF_MAGIC:
                path.unlink()
                raise UnexpectedScreen("save_receipt", detail="ダウンロードされたファイルが PDF ではない")
            return
        page = self._current()
        screen = detect_screen(page)
        if screen is not Screen.RECEIPT:
            raise UnexpectedScreen("save_receipt", screen, "領収書の画面ではない")
        path.parent.mkdir(parents=True, exist_ok=True)
        page.emulate_media(media="print")
        try:
            page.pdf(path=str(path), format="A4", print_background=True)
        finally:
            page.emulate_media(media="null")

    def save_diagnostics(self, label: str) -> Optional[Path]:
        """いまの画面のスクリーンショットと HTML を残す。失敗しても例外にしない。"""
        return save_page_diagnostics(self._current(), self.debug_dir, label)

    def close_flow(self) -> None:
        """発行操作を終える。この操作で開いたタブを閉じ、操作対象を一覧に戻す。"""
        popups = self._flow_popups(0)
        self._flow, self._download = None, None
        self._downloads, self._popups = [], []
        for popup in popups:
            if popup is self.list_page:
                continue
            try:
                popup.close()
            except PlaywrightError:
                pass
