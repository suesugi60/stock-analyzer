"""コマンドライン。引数の解釈、入力確認、全体の組み立て。"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import traceback
import unicodedata
from datetime import date, datetime
from pathlib import Path
from typing import Callable, List, Optional, Tuple

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

# --- 案内モード(guide) ---
GUIDE_WAIT_SECONDS = 600  # 予約一覧が表示されるのを待つ時間
GUIDE_STABLE_SECONDS = 2.0  # 一覧が表示されてから、読み始めるまで落ち着くのを待つ時間
GUIDE_MAX_ASKS = 5  # 同じ質問を聞き直す回数の上限
GUIDE_INTRO = ("楽天トラベルの領収書を、同じ宛名でまとめて発行して保存します。\n"
               "いくつか質問に答えてください。発行の前には必ず確認が入ります。")
ASK_NAME = "領収書の宛名を入力してください(全件に同じ宛名を使います。例: 株式会社サンプル):"
ASK_TITLE = "敬称を選んでください。1: 様 / 2: 御中 :"
ASK_PERIOD = ("対象の期間(チェックイン日)を指定できます。全件なら何も入力せず Enter。\n"
              "1年分なら 2025、期間なら 2025-01-01 2025-03-31 のように入力してください:")
PROMPT_AUTO = ("ブラウザが開きます。ログインして、予約確認の「国内宿泊」で過去の予約一覧の1ページ目を表示してください。\n"
               "表示されると自動で先へ進みます(最長 {minutes} 分待ちます)。")
_PERIOD_DATE = re.compile(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})")
_PERIOD_SEPARATORS = re.compile(r"[\s〜~,、]+")


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

    def ask(self, message: str) -> str:
        return input(message + " ")


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
    commands.add_parser("guide", parents=[out_only],
                        help="質問に答えるだけで、一覧の表示から発行・まとめまで進める(start.sh が使う)")
    return parser


class _GiveUp(Exception):
    """同じ質問に、決めた回数だけ聞き直しても答えを読み取れなかった。"""


def parse_period(text: str) -> Optional[Tuple[Optional[date], Optional[date]]]:
    """期間の入力を (開始日, 終了日) にする。空なら (None, None)。読み取れなければ None。"""
    text = unicodedata.normalize("NFKC", text).strip()
    if not text:
        return None, None
    if re.fullmatch(r"\d{4}", text):
        return date(int(text), 1, 1), date(int(text), 12, 31)
    matches = list(_PERIOD_DATE.finditer(text))
    if len(matches) != 2 or _PERIOD_SEPARATORS.sub("", _PERIOD_DATE.sub("", text)):
        return None
    try:
        first, second = (date(int(m.group(1)), int(m.group(2)), int(m.group(3))) for m in matches)
    except ValueError:
        return None
    return (first, second) if first <= second else None


def _ask(ui, question: str, parse: Callable[[str], Tuple[bool, object, List[str]]]):
    """質問し、読み取れるまで聞き直す。parse は (読み取れたか, 値, 伝える文言) を返す。"""
    for _ in range(GUIDE_MAX_ASKS):
        ok, value, problems = parse(ui.ask(question))
        if ok:
            return value
        for problem in problems:
            ui.info(problem)
    raise _GiveUp()


def _parse_name(answer: str):
    name = answer.strip()
    problems = validate_addressee(name)
    return not problems, name, problems


def _parse_title(answer: str):
    choice = unicodedata.normalize("NFKC", answer).strip()
    title = {"1": TITLES[0], "2": TITLES[1], TITLES[0]: TITLES[0], TITLES[1]: TITLES[1]}.get(choice)
    return title is not None, title, ["1 か 2 を入力してください"]


def _parse_period_answer(answer: str):
    period = parse_period(answer)
    return period is not None, period, [
        "期間を読み取れませんでした。例: 2025 / 2025-01-01 2025-03-31 / 全件なら何も入力せず Enter"]


def _ask_guide_options(ui, out: Path) -> Options:
    ui.info(GUIDE_INTRO)
    name = _ask(ui, ASK_NAME, _parse_name)
    title = _ask(ui, ASK_TITLE, _parse_title)
    date_from, date_to = _ask(ui, ASK_PERIOD, _parse_period_answer)
    return Options(out_dir=out, date_from=date_from, date_to=date_to, name=name, title=title,
                   confirm_start=True)


def _open_folder(path: Path) -> None:
    """出力フォルダを Finder で開く(Mac だけ)。開けなくても困らないので、失敗は無視する。"""
    if sys.platform != "darwin":
        return
    try:
        subprocess.run(["open", str(path)], check=False)
    except OSError:
        pass


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


def _run(command: str, opts: Options, ledger: Ledger, ui, open_session, start_url: str,
         open_folder: Callable[[Path], None]) -> int:
    out = opts.out_dir
    debug_dir = out / "debug"
    out.mkdir(parents=True, exist_ok=True)
    guided = command == "guide"
    with open_session() as context:
        browser.open_start_page(context, start_url)

        list_page = None
        if guided:
            # 案内モード: Enter を待たず、予約一覧が表示されたら先へ進む
            ui.info(PROMPT_AUTO.format(minutes=max(1, int(GUIDE_WAIT_SECONDS // 60))))
            list_page = browser.wait_for_list_page(context, GUIDE_WAIT_SECONDS, GUIDE_STABLE_SECONDS)
        else:
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
        merged = None
        try:
            result = merge_receipts(ledger, out)
            merged = result.path
            _report_merge(result, ui, mention_empty=False)
        except Exception:  # noqa: BLE001 - まとめに失敗しても、発行と保存の結果は変えない
            log = _write_error_log(debug_dir)
            ui.info(f"まとめファイルを作れませんでした。個別の PDF は保存済みです。詳細: {log}")
        if summary.keep_browser_open:
            ui.wait_enter(PROMPT_KEEP_OPEN)
        if guided and (merged is not None or summary.done):
            open_folder(out)
        return 1 if summary.aborted else 0


def main(argv: Optional[List[str]] = None, *, open_session=browser.open_session, ui=None,
         start_url: str = browser.START_URL, open_folder: Callable[[Path], None] = _open_folder) -> int:
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

    try:
        # 台帳はブラウザを開く前に読む。読めなければ、何も上書きせずに止まる
        ledger = Ledger(out / "receipts.csv")
    except LedgerError as error:
        print(str(error), file=sys.stderr)
        return 1

    if args.command == "guide":
        try:
            opts = _ask_guide_options(ui, out)
        except _GiveUp:
            print("入力を読み取れなかったため終了します。もう一度実行してください", file=sys.stderr)
            return 2
        except EOFError:
            print(NO_INPUT, file=sys.stderr)
            return 1
    else:
        opts = Options(out_dir=out, date_from=args.date_from, date_to=args.date_to,
                       name=getattr(args, "name", ""), title=getattr(args, "title", ""),
                       limit=getattr(args, "limit", None))
    try:
        return _run(args.command, opts, ledger, ui, open_session, start_url, open_folder)
    except KeyboardInterrupt:
        print("中断しました", file=sys.stderr)
        return 130
    except EOFError:
        print(NO_INPUT, file=sys.stderr)
        return 1
    except browser.BrowserLaunchError as error:
        print(str(error), file=sys.stderr)
        return 1
