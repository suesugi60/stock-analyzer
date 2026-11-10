"""コマンドライン。引数の解釈、入力確認、全体の組み立て。"""
from __future__ import annotations

import argparse
import sys
import traceback
from datetime import date, datetime
from pathlib import Path
from typing import List, Optional

from . import browser
from .ledger import Ledger, LedgerError
from .merge import MergeResult, merge_receipts
from .naming import TITLES, validate_addressee
from .runner import ListUnreadable, Options, Summary, run_download, run_list
from .site import Site, save_page_diagnostics

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = Path.home() / "Documents" / "rakuten-receipts"
LIST_TAB_RETRIES = 3
SITE_TIMEOUT_MS = 15000  # 画面の切り替わりや要素が現れるのを待つ時間

PROMPT_OPEN_LIST = "ログインして、予約確認の国内宿泊で過去の予約一覧を表示したら Enter を押してください"
PROMPT_LIST_NOT_FOUND = ("予約一覧のタブが見つかりません。"
                         "予約確認の国内宿泊で過去の予約一覧を表示してから、もう一度 Enter を押してください")
PROMPT_KEEP_OPEN = ("ブラウザを開いたままにしています。領収書が発行されているかを確かめ、"
                    "必要なら手で保存してから Enter を押してください")
NO_INPUT = "入力を受け取れません。Enter や y を入力できるターミナルで実行してください"


class ConsoleUI:
    """ターミナルでの表示と入力。"""

    def info(self, message: str) -> None:
        print(message)

    def confirm(self, message: str) -> bool:
        try:
            return input(message + " ").strip().lower() in ("y", "yes")
        except EOFError:
            return False  # 入力を受け取れないなら、発行しない

    def wait_enter(self, message: str) -> None:
        input(message + " ")


def _date_arg(text: str) -> date:
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        raise argparse.ArgumentTypeError(f"日付は YYYY-MM-DD の形式で指定してください: {text}")


def _positive_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"1以上の整数で指定してください: {text}")
    if value < 1:
        raise argparse.ArgumentTypeError(f"1以上の整数で指定してください: {text}")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rakuten_receipts",
        description="楽天トラベルの過去の国内宿泊予約の領収書を、同じ宛名でまとめて発行して PDF で保存します。")
    commands = parser.add_subparsers(dest="command", required=True)

    out_only = argparse.ArgumentParser(add_help=False)
    out_only.add_argument("--out", type=Path, default=DEFAULT_OUT,
                          help=f"出力先のフォルダ(既定: {DEFAULT_OUT})")

    common = argparse.ArgumentParser(add_help=False, parents=[out_only])
    common.add_argument("--from", dest="date_from", type=_date_arg, metavar="YYYY-MM-DD",
                        help="この日以降にチェックインした予約に絞る")
    common.add_argument("--to", dest="date_to", type=_date_arg, metavar="YYYY-MM-DD",
                        help="この日までにチェックインした予約に絞る")

    commands.add_parser("list", parents=[common],
                        help="予約の一覧を出すだけ。何も発行しない")
    download = commands.add_parser("download", parents=[common],
                                   help="領収書を発行して PDF で保存する")
    download.add_argument("--name", required=True, help="領収書の宛名(全件に同じものを使う)")
    download.add_argument("--title", required=True, choices=TITLES, help="敬称")
    download.add_argument("--limit", type=_positive_int, metavar="N", help="今回処理する最大件数")
    commands.add_parser("merge", parents=[out_only],
                        help="取得済みの領収書を1つの PDF にまとめ直す。ブラウザは開かない")
    return parser


def _inside_repo(path: Path) -> bool:
    """path が、このツールを置いているフォルダ(リポジトリ、または公開用の元フォルダ)の中か。

    .git の有無では判断しない。公開用の元フォルダには .git がなく、そこから公開リポジトリへ
    丸ごと同期されるため。
    """
    resolved = path.expanduser().resolve()
    root = REPO_ROOT.resolve()
    return resolved == root or root in resolved.parents


def _check_args(args: argparse.Namespace) -> List[str]:
    problems: List[str] = []
    date_from, date_to = getattr(args, "date_from", None), getattr(args, "date_to", None)
    if date_from and date_to and date_from > date_to:
        problems.append("--from は --to と同じか、それより前の日付にしてください")
    if _inside_repo(args.out):
        problems.append("--out は、このツールを置いたフォルダ(リポジトリ)の外を指定してください"
                        f"(領収書を公開リポジトリに置かないため): {args.out}")
    if args.command == "download":
        problems.extend(validate_addressee(args.name))
    return problems


def _summary_line(summary: Summary) -> str:
    line = f"取得 {summary.done} 件 / 要確認 {summary.review} 件 / 失敗 {summary.failed} 件"
    if summary.aborted:
        line += "(要確認・失敗が続いたため中止しました)"
    elif summary.stopped:
        line += "(確認で中断しました)"
    return line


def _report_merge(result: MergeResult, ui, mention_empty: bool) -> None:
    if result.path is not None:
        ui.info(f"まとめファイル: {result.path}({result.merged} 件)")
    elif mention_empty:
        ui.info("まとめる領収書がありません(取得済みの領収書がまだありません)")
    if result.skipped:
        ui.info("ファイルが見つからない・読めないため、まとめに入れなかった予約: " + ", ".join(result.skipped))


def _run_merge(out: Path, ui) -> int:
    """台帳にある取得済みの領収書を、ブラウザを開かずに1つの PDF にまとめ直す。"""
    ledger_path = out / "receipts.csv"
    if not ledger_path.exists():
        print(f"台帳が見つかりません: {ledger_path}。先に list か download を実行してください", file=sys.stderr)
        return 1
    try:
        ledger = Ledger(ledger_path)
    except LedgerError as error:
        print(str(error), file=sys.stderr)
        return 1
    _report_merge(merge_receipts(ledger, out), ui, mention_empty=True)
    return 0


def _write_error_log(debug_dir: Path) -> Path:
    debug_dir.mkdir(parents=True, exist_ok=True)
    log = debug_dir / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}_error.txt"
    log.write_text(traceback.format_exc(), encoding="utf-8")
    return log


def _run(command: str, opts: Options, ledger: Ledger, ui, open_session, start_url: str) -> int:
    out = opts.out_dir
    debug_dir = out / "debug"
    out.mkdir(parents=True, exist_ok=True)
    with open_session() as context:
        browser.open_start_page(context, start_url)

        list_page = None
        for attempt in range(LIST_TAB_RETRIES):
            ui.wait_enter(PROMPT_OPEN_LIST if attempt == 0 else PROMPT_LIST_NOT_FOUND)
            list_page = browser.find_list_page(context)
            if list_page is not None:
                break
        if list_page is None:
            for index, page in enumerate(context.pages):
                save_page_diagnostics(page, debug_dir, f"no_list_tab_{index}")
            ui.info(f"予約一覧のタブが見つからなかったため終了します。画面の記録: {debug_dir}")
            return 1

        site = Site(context, list_page, debug_dir, timeout_ms=SITE_TIMEOUT_MS)
        try:
            if command == "list":
                run_list(site, ledger, opts, ui)
                ui.info(f"台帳: {ledger.path}")
                return 0
            summary = run_download(site, ledger, opts, ui)
        except ListUnreadable as error:
            site.save_diagnostics("list")
            ui.info(f"{error}。画面の記録: {debug_dir}")
            return 1
        except Exception:  # noqa: BLE001 - トレースは画面に出さず、ファイルに残す
            site.save_diagnostics("error")
            log = _write_error_log(debug_dir)
            ui.info(f"想定外のエラーで終了します。詳細: {log}")
            return 1

        ui.info(_summary_line(summary))
        ui.info(f"台帳: {ledger.path}")
        try:
            _report_merge(merge_receipts(ledger, out), ui, mention_empty=False)
        except Exception:  # noqa: BLE001 - まとめに失敗しても、発行と保存の結果は変えない
            log = _write_error_log(debug_dir)
            ui.info(f"まとめファイルを作れませんでした。個別の PDF は保存済みです。詳細: {log}")
        if summary.keep_browser_open:
            ui.wait_enter(PROMPT_KEEP_OPEN)
        return 1 if summary.aborted else 0


def main(argv: Optional[List[str]] = None, *, open_session=browser.open_session, ui=None,
         start_url: str = browser.START_URL) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_:
        return int(exit_.code or 0)

    if args.command == "download":
        args.name = args.name.strip()
    problems = _check_args(args)
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return 2

    ui = ui or ConsoleUI()
    out = args.out.expanduser()
    if args.command == "merge":
        return _run_merge(out, ui)

    opts = Options(out_dir=out, date_from=args.date_from, date_to=args.date_to,
                   name=getattr(args, "name", ""), title=getattr(args, "title", ""),
                   limit=getattr(args, "limit", None))
    try:
        # 台帳はブラウザを開く前に読む。読めなければ、何も上書きせずに止まる
        ledger = Ledger(out / "receipts.csv")
    except LedgerError as error:
        print(str(error), file=sys.stderr)
        return 1
    try:
        return _run(args.command, opts, ledger, ui, open_session, start_url)
    except KeyboardInterrupt:
        print("中断しました", file=sys.stderr)
        return 130
    except EOFError:
        print(NO_INPUT, file=sys.stderr)
        return 1
    except browser.BrowserLaunchError as error:
        print(str(error), file=sys.stderr)
        return 1
