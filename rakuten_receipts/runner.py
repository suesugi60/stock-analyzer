"""list / download の進行と、安全策の判断。

画面の操作は site に任せ、ここでは「押してよいか」だけを決める。
迷ったら押さない(フェイルクローズ)。
"""
from __future__ import annotations

import random
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import List, Optional, Tuple

from .ledger import Ledger
from .models import Reservation, Screen, Status, UnexpectedScreen
from .naming import addressee_matches, confirm_excerpt, receipt_filename, unique_path

MAX_CONSECUTIVE_FAILURES = 3
INTERVAL_SECONDS = (3.0, 6.0)

CONFIRM_START = "この {n} 件の領収書を発行します。一覧はこれで合っていますか? [y/N]"
CONFIRM_INPUT = ("ブラウザの入力画面に宛名を入れました。宛名と敬称を確認してください。"
                 "この内容で次へ進みますか? [y/N]")
CONFIRM_FIRST = "ブラウザの確認画面を見て、この内容で発行しますか? [y/N]"
CONFIRM_REST = "PDF を開いて確認してください。残り {n} 件を続けますか? [y/N]"
CONFIRM_DIRECT = ("確認画面が出ないまま領収書が発行されました。保存した PDF を確認してください。"
                  "残り {n} 件も同じように進めますか? [y/N]")
RELOGIN = "ログイン画面に戻りました。ブラウザでログインし直してから Enter を押してください"
UNDATED_NOTICE = "日付不明のため対象外: {n} 件"
OUT_OF_RANGE_NOTICE = "期間外のため表示していない予約: {n} 件"
MEMO_REDISPLAY = "発行済みを再表示"
MEMO_MISMATCH = "確認画面の宛名が一致しない"
MEMO_FIX = "修正・再発行らしい画面のため未入力"
MEMO_UNEXPECTED = "想定外の画面: {step}"
MEMO_FORM_AGAIN = "「領収書の発行」の後に入力画面へ戻った(入力内容がはじかれた可能性)"
MEMO_LOGIN = "ログインし直しても一覧に戻れなかった"
MEMO_NO_CONFIRM = "確認画面なしで発行された"
# ここから下の3つは、状態「失敗(発行後)」と組で使う。発行済みかもしれないので、このツールは二度と入力しない
MEMO_IN_PROGRESS = "発行操作の途中で終了した可能性あり。発行済みかどうかを手動で確認"
MEMO_AFTER_ISSUE = "発行済みの可能性あり。手動で確認"
MEMO_AFTER_GO = "「領収書の発行」の後、確認画面にも領収書にもならなかった。発行済みかどうかを手動で確認"
MEMO_MAYBE_ISSUED = "以前の実行で発行済みの可能性あり。領収書が表示されなかったので何も入力していない。手動で確認"


class ListUnreadable(Exception):
    """予約一覧から1件も読み取れなかった。"""


@dataclass
class Options:
    out_dir: Path
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    name: str = ""
    title: str = ""
    limit: Optional[int] = None
    confirm_start: bool = False  # 発行を始める前に、対象の一覧がこれで合っているかを聞く(案内モード)


@dataclass
class Summary:
    done: int = 0
    review: int = 0
    failed: int = 0
    aborted: bool = False  # 連続失敗で中止した
    stopped: bool = False  # 利用者が確認で y 以外を答えた
    keep_browser_open: bool = False  # 発行されたかもしれないのに保存できていない。手で確かめられるよう開いたままにする


class _StopRun(Exception):
    """利用者が確認で y 以外を答えた。台帳を変えずに実行を終える。"""


@dataclass
class _Result:
    """1件の結果。台帳に書く内容と、その後の進め方。"""

    status: Status
    memo: str = ""
    filename: str = ""
    keep_open: bool = False  # 実行を止め、ブラウザを開いたままにする
    ask_rest: bool = False  # 人が確認して発行した件。残りを続けるか聞く
    ask_direct: bool = False  # 確認画面なしで発行された件。残りも同じように進めるか聞く
    expected: bool = False  # 前から分かっていた未解決(連続失敗に数えない)


def format_table(reservations: List[Reservation], ledger: Ledger) -> str:
    lines = ["チェックイン | 施設名 | 予約番号 | 金額 | 状態"]
    for res in reservations:
        row = ledger.rows.get(res.reservation_id)
        lines.append(" | ".join([
            res.checkin.isoformat() if res.checkin else "日付不明",
            res.hotel_name,
            res.reservation_id,
            f"{res.amount:,}円" if res.amount is not None else "-",
            (row.custom_status or row.status.value) if row else "-",
        ]))
    return "\n".join(lines)


def _in_range(res: Reservation, opts: Options) -> bool:
    if opts.date_from is None and opts.date_to is None:
        return True
    if res.checkin is None:
        return False
    if opts.date_from is not None and res.checkin < opts.date_from:
        return False
    return opts.date_to is None or res.checkin <= opts.date_to


def run_list(site, ledger: Ledger, opts: Options, ui) -> List[Reservation]:
    """予約一覧を読み、台帳に反映して表示する。サイト上の状態は変えない。

    台帳には読めた全件を入れ、表示は --from / --to の範囲だけにする。読めた全件を返す。
    """
    reservations = site.read_reservations()
    if not reservations:
        raise ListUnreadable("予約一覧から予約を1件も読み取れませんでした")
    ledger.sync(reservations)
    shown = [res for res in reservations if _in_range(res, opts)]
    ui.info(format_table(shown, ledger))
    if len(shown) < len(reservations):
        ui.info(OUT_OF_RANGE_NOTICE.format(n=len(reservations) - len(shown)))
    return reservations


class _Downloader:
    """1件ずつ発行する。「押してよいか」の判断と、台帳への先行記録を受け持つ。"""

    def __init__(self, site, ledger: Ledger, opts: Options, ui) -> None:
        self.site = site
        self.ledger = ledger
        self.opts = opts
        self.ui = ui
        self.input_checked = False  # 入力画面を人が確認した
        self.human_confirmed = False  # 確認画面を人が確認した
        self.direct_accepted = False  # 確認画面なしの発行を、人が続けてよいと答えた
        self.in_flight = False  # 発行につながりうるクリックの結果がまだ分からない
        self.step = ""

    def _begin_click(self, rid: str) -> None:
        """発行につながりうるクリックの前に、台帳へ「発行済みかもしれない」と先に書く。

        クリックの最中にプロセスが落ちても、次の実行でその予約に入力しないようにするため。
        書けなければ例外になり、クリックはしない。
        """
        self.ledger.mark(rid, Status.FAILED_AFTER_ISSUE, memo=MEMO_IN_PROGRESS)
        self.in_flight = True

    def _click_was_harmless(self, rid: str, prior: Tuple[Status, str, str]) -> None:
        """クリックの結果、発行されていないと分かった。台帳を元に戻す。"""
        status, filename, memo = prior
        self.ledger.mark(rid, status, filename, memo)
        self.in_flight = False

    def _save(self, res: Reservation) -> str:
        self.step = "save_receipt"
        path = unique_path(self.opts.out_dir, receipt_filename(res))
        self.site.save_receipt(path)
        self.in_flight = False
        return path.name

    def failure(self, prior_status: Status, status: Status, memo: str) -> _Result:
        """例外で終わった件の結果。発行済みかもしれないなら、必ずそう記録する。"""
        if self.in_flight:
            return _Result(Status.FAILED_AFTER_ISSUE, MEMO_AFTER_ISSUE, keep_open=True)
        if prior_status is Status.FAILED_AFTER_ISSUE:
            return _Result(Status.FAILED_AFTER_ISSUE, MEMO_MAYBE_ISSUED, expected=True)
        return _Result(status, memo)

    def process(self, res: Reservation, allow_relogin: bool = True) -> _Result:
        site, ui, opts = self.site, self.ui, self.opts
        rid = res.reservation_id
        row = self.ledger.rows[rid]
        prior = (row.status, row.filename, row.memo)
        maybe_issued = row.status is Status.FAILED_AFTER_ISSUE

        self.step = "open_receipt"
        screen = site.open_receipt(res)
        if screen is Screen.LOGIN:
            if allow_relogin:
                ui.wait_enter(RELOGIN)
                return self.process(res, allow_relogin=False)
            return self.failure(row.status, Status.FAILED, MEMO_LOGIN)
        if screen is Screen.RECEIPT:
            return _Result(Status.DONE, MEMO_REDISPLAY, self._save(res))
        if maybe_issued:
            # 以前の実行で発行されたかもしれない。入力画面が出ても、それは修正画面かもしれないので触らない
            return _Result(Status.FAILED_AFTER_ISSUE, MEMO_MAYBE_ISSUED, expected=True)
        if screen is Screen.ADDRESSEE_FIX:
            return _Result(Status.REVIEW, MEMO_FIX)
        if screen is not Screen.ADDRESSEE_INPUT:
            return _Result(Status.REVIEW, MEMO_UNEXPECTED.format(step=self.step))

        self.step = "fill_addressee"
        site.fill_addressee(opts.name, opts.title)
        if not self.input_checked:
            ui.info(f"入力した宛名: {opts.name} {opts.title}({res.hotel_name} / 予約番号 {rid})")
            if not ui.confirm(CONFIRM_INPUT):
                raise _StopRun()
            self.input_checked = True

        self.step = "go_to_confirm"
        self._begin_click(rid)
        screen = site.go_to_confirm()
        if screen is Screen.LOGIN:
            self._click_was_harmless(rid, prior)
            if allow_relogin:
                ui.wait_enter(RELOGIN)
                return self.process(res, allow_relogin=False)
            return _Result(Status.FAILED, MEMO_LOGIN)
        if screen is Screen.RECEIPT:
            return _Result(Status.DONE, MEMO_NO_CONFIRM, self._save(res), ask_direct=True)
        if screen in (Screen.ADDRESSEE_FIX, Screen.ADDRESSEE_INPUT):
            # 入力欄のある画面が出た。「発行する」は押していないので、発行されていない
            self._click_was_harmless(rid, prior)
            return _Result(Status.REVIEW, MEMO_FIX if screen is Screen.ADDRESSEE_FIX else MEMO_FORM_AGAIN)
        if screen is not Screen.CONFIRM:
            # 何が起きたか分からない。発行されたかもしれないので、ここで止まる
            return _Result(Status.FAILED_AFTER_ISSUE, MEMO_AFTER_GO, keep_open=True)
        self._click_was_harmless(rid, prior)  # 確認画面に着いた。まだ発行されていない

        self.step = "read_confirm_text"
        text = site.read_confirm_text()
        if not addressee_matches(text, opts.name, opts.title):
            return _Result(Status.REVIEW, MEMO_MISMATCH)
        confirmed_here = False
        if not self.human_confirmed:
            ui.info(f"確認画面の表示: {confirm_excerpt(text, opts.name)}({res.hotel_name} / 予約番号 {rid})")
            if not ui.confirm(CONFIRM_FIRST):
                raise _StopRun()
            self.human_confirmed = True
            confirmed_here = True

        self.step = "submit_issue"
        self._begin_click(rid)
        site.submit_issue()
        return _Result(Status.DONE, "", self._save(res), ask_rest=confirmed_here)


def run_download(site, ledger: Ledger, opts: Options, ui,
                 sleep=time.sleep, uniform=random.uniform) -> Summary:
    """対象の予約を1件ずつ発行して PDF を保存する。"""
    reservations = site.read_reservations()
    if not reservations:
        raise ListUnreadable("予約一覧から予約を1件も読み取れませんでした")
    ledger.sync(reservations)
    summary = Summary()

    ranged = opts.date_from is not None or opts.date_to is not None
    if ranged:
        undated = [r for r in ledger.targets(reservations, None, None) if r.checkin is None]
        if undated:
            ui.info(UNDATED_NOTICE.format(n=len(undated)))

    targets = ledger.targets(reservations, opts.date_from, opts.date_to)
    if opts.limit is not None:
        targets = targets[:opts.limit]
    if not targets:
        ui.info("発行の対象になる予約はありません")
        return summary

    ui.info(f"発行の対象: {len(targets)} 件 / 宛名: {opts.name} {opts.title}")
    ui.info(format_table(targets, ledger))
    if opts.confirm_start and not ui.confirm(CONFIRM_START.format(n=len(targets))):
        summary.stopped = True
        return summary

    worker = _Downloader(site, ledger, opts, ui)
    consecutive_failures = 0

    for index, res in enumerate(targets):
        remaining = len(targets) - index - 1
        rid = res.reservation_id
        prior_status = ledger.rows[rid].status
        worker.in_flight = False
        keep_open = False
        try:
            try:
                result = worker.process(res)
            except _StopRun:
                summary.stopped = True
                return summary
            except UnexpectedScreen as error:
                memo = MEMO_UNEXPECTED.format(step=error.step)
                if error.detail:
                    memo += f"({error.detail})"
                result = worker.failure(prior_status, Status.REVIEW, memo)
            except Exception as error:  # noqa: BLE001 - 1件の失敗で全体を落とさない
                result = worker.failure(prior_status, Status.FAILED, f"{type(error).__name__}: {error}")

            keep_open = result.keep_open
            if result.status is not Status.DONE:
                site.save_diagnostics(f"{rid}_{worker.step}")
            ledger.mark(rid, result.status, result.filename, result.memo)
        finally:
            if not keep_open:
                site.close_flow()

        if result.status is Status.DONE:
            summary.done += 1
            consecutive_failures = 0
            ui.info(f"保存しました: {opts.out_dir / result.filename}")
        else:
            if result.status is Status.REVIEW:
                summary.review += 1
            else:
                summary.failed += 1
            if not result.expected:
                consecutive_failures += 1
            ui.info(f"{result.status.value}: 予約番号 {rid}({result.memo})")

        if keep_open:
            summary.keep_browser_open = True
            return summary
        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            summary.aborted = True
            return summary
        if result.ask_direct and not worker.direct_accepted:
            ui.info("このサイトは、確認画面を出さずに領収書を発行しました(予約番号 " + rid + ")")
        if remaining == 0:
            break
        if result.ask_direct and not worker.direct_accepted:
            if not ui.confirm(CONFIRM_DIRECT.format(n=remaining)):
                summary.stopped = True
                return summary
            worker.direct_accepted = True
        elif result.ask_rest:
            if not ui.confirm(CONFIRM_REST.format(n=remaining)):
                summary.stopped = True
                return summary
        sleep(uniform(*INTERVAL_SECONDS))

    return summary
