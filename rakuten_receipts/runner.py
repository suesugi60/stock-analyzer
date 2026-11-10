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
from typing import List, Optional

from .ledger import Ledger
from .models import Reservation, Screen, Status, UnexpectedScreen
from .naming import addressee_matches, receipt_filename, unique_path

MAX_CONSECUTIVE_FAILURES = 3
INTERVAL_SECONDS = (3.0, 6.0)

CONFIRM_FIRST = "ブラウザの確認画面を見て、この内容で発行しますか? [y/N]"
CONFIRM_REST = "PDF を開いて確認してください。残り {n} 件を続けますか? [y/N]"
RELOGIN = "ログイン画面に戻りました。ブラウザでログインし直してから Enter を押してください"
UNDATED_NOTICE = "日付不明のため対象外: {n} 件"
MEMO_REDISPLAY = "発行済みを再表示"
MEMO_MISMATCH = "確認画面の宛名が一致しない"
MEMO_FIX = "修正・再発行らしい画面のため未入力"
MEMO_UNEXPECTED = "想定外の画面: {step}"
MEMO_AFTER_ISSUE = "発行済みの可能性あり。手動で確認"
MEMO_LOGIN = "ログインし直しても一覧に戻れなかった"


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


@dataclass
class Summary:
    done: int = 0
    review: int = 0
    failed: int = 0
    aborted: bool = False  # 連続失敗で中止した
    stopped: bool = False  # 利用者が確認で y 以外を答えた
    keep_browser_open: bool = False  # 発行後に保存できなかったので、手で保存できるよう開いたままにする


class _StopRun(Exception):
    """利用者が確認で y 以外を答えた。台帳を変えずに実行を終える。"""


def format_table(reservations: List[Reservation], ledger: Ledger) -> str:
    lines = ["チェックイン | 施設名 | 予約番号 | 金額 | 状態"]
    for res in reservations:
        row = ledger.rows.get(res.reservation_id)
        lines.append(" | ".join([
            res.checkin.isoformat() if res.checkin else "日付不明",
            res.hotel_name,
            res.reservation_id,
            f"{res.amount:,}円" if res.amount is not None else "-",
            row.status.value if row else "-",
        ]))
    return "\n".join(lines)


def run_list(site, ledger: Ledger, opts: Options, ui) -> List[Reservation]:
    """予約一覧を読み、台帳に反映して表示する。サイト上の状態は変えない。"""
    reservations = site.read_reservations()
    if not reservations:
        raise ListUnreadable("予約一覧から予約を1件も読み取れませんでした")
    ledger.sync(reservations)
    ui.info(format_table(reservations, ledger))
    return reservations


def run_download(site, ledger: Ledger, opts: Options, ui,
                 sleep=time.sleep, uniform=random.uniform) -> Summary:
    """対象の予約を1件ずつ発行して PDF を保存する。"""
    reservations = run_list(site, ledger, opts, ui)
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

    human_confirmed = False
    consecutive_failures = 0

    for index, res in enumerate(targets):
        remaining = len(targets) - index - 1
        rid = res.reservation_id
        step = "open_receipt"
        submitting = False
        confirmed_here = False
        keep_open = False
        status: Optional[Status] = None
        memo = ""
        filename = ""
        try:
            try:
                screen = site.open_receipt(res)
                if screen is Screen.LOGIN:
                    ui.wait_enter(RELOGIN)
                    screen = site.open_receipt(res)

                if screen is Screen.LOGIN:
                    status, memo = Status.FAILED, MEMO_LOGIN
                elif screen is Screen.RECEIPT:
                    step = "save_receipt"
                    path = unique_path(opts.out_dir, receipt_filename(res))
                    site.save_receipt(path)
                    status, memo, filename = Status.DONE, MEMO_REDISPLAY, path.name
                elif screen is Screen.ADDRESSEE_FIX:
                    status, memo = Status.REVIEW, MEMO_FIX
                elif screen is Screen.ADDRESSEE_INPUT:
                    step = "fill_addressee"
                    site.fill_addressee(opts.name, opts.title)
                    step = "go_to_confirm"
                    if site.go_to_confirm() is not Screen.CONFIRM:
                        status, memo = Status.REVIEW, MEMO_UNEXPECTED.format(step=step)
                    else:
                        step = "read_confirm_text"
                        text = site.read_confirm_text()
                        if not addressee_matches(text, opts.name, opts.title):
                            status, memo = Status.REVIEW, MEMO_MISMATCH
                        else:
                            if not human_confirmed:
                                ui.info(f"確認画面の宛名: {opts.name} {opts.title}"
                                        f"({res.hotel_name} / 予約番号 {rid})")
                                if not ui.confirm(CONFIRM_FIRST):
                                    raise _StopRun()
                                human_confirmed = True
                                confirmed_here = True
                            step = "submit_issue"
                            submitting = True
                            site.submit_issue()
                            step = "save_receipt"
                            path = unique_path(opts.out_dir, receipt_filename(res))
                            site.save_receipt(path)
                            status, filename = Status.DONE, path.name
                else:
                    status, memo = Status.REVIEW, MEMO_UNEXPECTED.format(step=step)
            except _StopRun:
                summary.stopped = True
                return summary
            except UnexpectedScreen as error:
                if submitting:
                    status, memo, keep_open = Status.FAILED_AFTER_ISSUE, MEMO_AFTER_ISSUE, True
                else:
                    status, memo = Status.REVIEW, MEMO_UNEXPECTED.format(step=error.step)
            except Exception as error:  # noqa: BLE001 - 1件の失敗で全体を落とさない
                if submitting:
                    status, memo, keep_open = Status.FAILED_AFTER_ISSUE, MEMO_AFTER_ISSUE, True
                else:
                    status, memo = Status.FAILED, f"{type(error).__name__}: {error}"

            if status is not Status.DONE:
                site.save_diagnostics(f"{rid}_{step}")
            ledger.mark(rid, status, filename, memo)
        finally:
            if not keep_open:
                site.close_flow()

        if status is Status.DONE:
            summary.done += 1
            consecutive_failures = 0
            ui.info(f"保存しました: {opts.out_dir / filename}")
        else:
            if status is Status.REVIEW:
                summary.review += 1
            else:
                summary.failed += 1
            consecutive_failures += 1
            ui.info(f"{status.value}: 予約番号 {rid}({memo})")

        if keep_open:
            summary.keep_browser_open = True
            return summary
        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            summary.aborted = True
            return summary
        if remaining == 0:
            break
        if confirmed_here and status is Status.DONE:
            if not ui.confirm(CONFIRM_REST.format(n=remaining)):
                summary.stopped = True
                return summary
        sleep(uniform(*INTERVAL_SECONDS))

    return summary
