from __future__ import annotations

import csv
import subprocess
import sys
from contextlib import contextmanager
from datetime import date

import pytest

from rakuten_receipts import browser, cli, runner
from rakuten_receipts.runner import Summary

from .conftest import FakeUI

NAME_TITLE = ["--name", "株式会社サンプル", "--title", "御中"]


class NoBrowser:
    """ブラウザを開かないはずの場面で渡す。呼ばれたら回数が残る。"""

    def __init__(self):
        self.calls = 0

    @contextmanager
    def __call__(self):
        self.calls += 1
        raise AssertionError("ブラウザを開いてはいけない場面で open_session が呼ばれた")
        yield  # pragma: no cover


class HeadlessSession:
    """本物のブラウザをヘッドレスで開き、BrowserContext を控えておく。"""

    def __init__(self, profile_dir):
        self.profile_dir = profile_dir
        self.context = None
        self.closed = False

    @contextmanager
    def __call__(self):
        try:
            with browser.open_session(self.profile_dir, headless=True) as context:
                self.context = context
                yield context
        finally:
            self.closed = True  # open_session を抜けた(ブラウザは閉じられた)


@pytest.fixture
def out(tmp_path):
    return tmp_path / "receipts-out"


@pytest.fixture
def run_cli(tmp_path, dummy_site, monkeypatch):
    """ダミーサイトに対して main を動かす。

    pages は Enter のたびに人が開くページ。None は何もしない。関数なら session を渡して呼ぶ。
    """
    monkeypatch.setattr(runner, "INTERVAL_SECONDS", (0.0, 0.0))
    monkeypatch.setattr(cli, "SITE_TIMEOUT_MS", 1500)

    def run(argv, answers=(), pages=("list_p1.html",), on_enter=None):
        session = HeadlessSession(tmp_path / "profile")

        def default_on_enter(count):
            target = pages[min(count - 1, len(pages) - 1)]
            if callable(target):
                target(session)
            elif target is not None:
                session.context.pages[0].goto(dummy_site + target)

        ui = FakeUI(list(answers), on_enter=on_enter or default_on_enter)
        code = cli.main(argv, open_session=session, ui=ui, start_url=dummy_site + "unknown.html")
        return code, ui, session

    return run


def receipts(out):
    """個別の領収書 PDF(まとめファイルを除く)。"""
    return [p for p in out.glob("*.pdf") if p.name != "領収書まとめ.pdf"]


def read_ledger(out):
    with open(out / "receipts.csv", encoding="utf-8-sig", newline="") as f:
        return {row["予約番号"]: row for row in csv.DictReader(f)}


# --- 引数(ブラウザを開かない) ---

@pytest.mark.parametrize("argv", [
    ["download", "--title", "御中"],                                   # 宛名なし
    ["download", "--name", "株式会社サンプル"],                        # 敬称なし
    ["download", "--name", "株式会社サンプル", "--title", "殿"],        # 敬称は 様 か 御中
    ["list", "--from", "2025/03/15"],                                  # 日付の書式
    ["list", "--from", "2025-02-30"],                                  # 暦にない日付
    ["download", *NAME_TITLE, "--limit", "0"],                         # 1以上
    ["download", *NAME_TITLE, "--limit", "abc"],
    [],                                                                # サブコマンドなし
])
def test_bad_arguments_exit_2(argv, out, capsys):
    no_browser = NoBrowser()
    assert cli.main(argv + (["--out", str(out)] if argv else []), open_session=no_browser, ui=FakeUI()) == 2
    assert no_browser.calls == 0


def test_from_after_to(out, capsys):
    no_browser = NoBrowser()
    code = cli.main(["list", "--from", "2025-04-01", "--to", "2025-03-01", "--out", str(out)],
                    open_session=no_browser, ui=FakeUI())
    assert code == 2 and no_browser.calls == 0
    assert "--from" in capsys.readouterr().err


def test_out_inside_repo_is_error(capsys):
    no_browser = NoBrowser()
    target = cli.REPO_ROOT / "rakuten_receipts" / "tmp-out"
    code = cli.main(["list", "--out", str(target)], open_session=no_browser, ui=FakeUI())
    assert code == 2 and no_browser.calls == 0
    assert not target.exists()
    assert "リポジトリ" in capsys.readouterr().err


def test_out_guard_works_without_git(tmp_path, monkeypatch, capsys):
    # 公開用の元フォルダ(.git なし)にツールを置いた場合も、その中には出力させない
    fake_root = tmp_path / "source-folder"
    (fake_root / "rakuten_receipts").mkdir(parents=True)
    monkeypatch.setattr(cli, "REPO_ROOT", fake_root)
    no_browser = NoBrowser()
    code = cli.main(["list", "--out", str(fake_root / "receipts")], open_session=no_browser, ui=FakeUI())
    assert code == 2 and no_browser.calls == 0
    assert not (fake_root / "receipts").exists()


def test_out_next_to_the_tool_folder_is_allowed(tmp_path, monkeypatch):
    fake_root = tmp_path / "source-folder"
    fake_root.mkdir()
    monkeypatch.setattr(cli, "REPO_ROOT", fake_root)
    problems = cli._check_args(cli.build_parser().parse_args(["list", "--out", str(tmp_path / "receipts")]))
    assert problems == []


def test_invalid_addressee_exits_before_browser(out, capsys):
    no_browser = NoBrowser()
    code = cli.main(["download", "--name", "㈱サンプル", "--title", "御中", "--out", str(out)],
                    open_session=no_browser, ui=FakeUI())
    assert code == 2 and no_browser.calls == 0
    assert "環境依存文字" in capsys.readouterr().err


def test_help_exits_0(capsys):
    assert cli.main(["--help"], open_session=NoBrowser(), ui=FakeUI()) == 0
    shown = capsys.readouterr().out
    assert "list" in shown and "download" in shown


def test_module_help():
    done = subprocess.run([sys.executable, "-m", "rakuten_receipts", "--help"],
                          cwd=str(cli.REPO_ROOT), capture_output=True, text=True, timeout=60)
    assert done.returncode == 0
    assert "list" in done.stdout and "download" in done.stdout


# --- 起動と一覧タブ ---

def test_browser_launch_error_is_exit_1(out, capsys):
    @contextmanager
    def broken():
        raise browser.BrowserLaunchError("ブラウザを起動できませんでした。テスト用の理由")
        yield  # pragma: no cover

    assert cli.main(["list", "--out", str(out)], open_session=broken, ui=FakeUI()) == 1
    err = capsys.readouterr().err
    assert "ブラウザを起動できませんでした" in err and "Traceback" not in err


def test_no_list_tab_reprompts_then_exit_1(run_cli, out):
    code, ui, _ = run_cli(["list", "--out", str(out)], pages=(None,))
    assert code == 1
    assert len(ui.enters) == cli.LIST_TAB_RETRIES == 3
    assert "予約一覧のタブが見つかりません" in ui.enters[1]
    assert list((out / "debug").glob("*.png")) and list((out / "debug").glob("*.html"))
    assert not (out / "receipts.csv").exists()
    # 見つからなかったときは、開いているタブをどう判定したかを伝える(貼り付ければ原因が分かる)
    assert any("unknown.html" in m and "判定: 不明" in m for m in ui.infos)


def test_list_tab_found_on_second_try(run_cli, out):
    code, ui, _ = run_cli(["list", "--out", str(out)], pages=(None, "list_p1.html"))
    assert code == 0 and len(ui.enters) == 2


def test_ctrl_c_is_exit_130(run_cli, out, capsys):
    def interrupt(count):
        raise KeyboardInterrupt()

    code, _, session = run_cli(["list", "--out", str(out)], on_enter=interrupt)
    assert code == 130
    assert session.closed  # ブラウザは閉じて終わる
    assert "Traceback" not in capsys.readouterr().err


def test_unexpected_error_is_exit_1_with_log(run_cli, out, monkeypatch, capsys):
    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(cli, "run_list", boom)
    code, ui, _ = run_cli(["list", "--out", str(out)])
    assert code == 1
    (log,) = (out / "debug").glob("*_error.txt")
    assert "RuntimeError: boom" in log.read_text(encoding="utf-8")
    assert "Traceback" not in capsys.readouterr().err
    assert any(str(log) in m for m in ui.infos)


# --- ダミーサイトでの通し(ヘッドレス) ---

def test_e2e_list(run_cli, out):
    assert not out.exists()
    code, ui, _ = run_cli(["list", "--out", str(out)])
    assert code == 0
    rows = read_ledger(out)
    assert list(rows) == ["RY001", "RY002", "RY003", "RY004", "RY005", "RY006"]
    assert rows["RY002"]["状態"] == "対象外" and rows["RY001"]["状態"] == "未取得"
    assert list(out.glob("*.pdf")) == []
    assert ui.confirms == []


def test_e2e_download(run_cli, out):
    code, ui, _ = run_cli(["download", "--out", str(out), *NAME_TITLE], answers=[True, True, True])
    assert code == 0
    assert sorted(p.name for p in receipts(out)) == [
        "2025-03-15_ホテルサンプル東京_RY001.pdf",
        "2025-03-22_ビジネスホテル架空大阪_RY003.pdf",
        "2025-04-01_リゾート見本沖縄_RY004.pdf",
    ]
    for pdf in receipts(out):
        assert pdf.read_bytes().startswith(b"%PDF-")
    rows = read_ledger(out)
    assert {rid: row["状態"] for rid, row in rows.items()} == {
        "RY001": "取得済み", "RY002": "対象外", "RY003": "取得済み",
        "RY004": "取得済み", "RY005": "要確認", "RY006": "要確認"}
    assert rows["RY004"]["メモ"] == "発行済みを再表示"
    assert rows["RY001"]["ファイル名"] == "2025-03-15_ホテルサンプル東京_RY001.pdf"
    debug_names = " ".join(p.name for p in (out / "debug").iterdir())
    assert "RY005" in debug_names and "RY006" in debug_names
    assert any("取得 3" in m and "要確認 2" in m for m in ui.infos)


def test_e2e_download_range(run_cli, out):
    code, _, _ = run_cli(["download", "--out", str(out), *NAME_TITLE,
                          "--from", "2025-03-15", "--to", "2025-03-31"], answers=[True, True, True])
    assert code == 0
    assert sorted(p.name[:10] for p in receipts(out)) == ["2025-03-15", "2025-03-22"]


def test_e2e_download_limit(run_cli, out):
    code, _, _ = run_cli(["download", "--out", str(out), *NAME_TITLE, "--limit", "1"], answers=[True, True])
    assert code == 0
    assert [p.name[:10] for p in receipts(out)] == ["2025-03-15"]


def test_e2e_download_declined_issues_nothing(run_cli, out):
    code, _, _ = run_cli(["download", "--out", str(out), *NAME_TITLE], answers=[False])
    assert code == 0
    assert list(out.glob("*.pdf")) == []
    assert read_ledger(out)["RY001"]["状態"] == "未取得"


def test_e2e_list_unreadable_saves_diagnostics(run_cli, out):
    code, _, _ = run_cli(["list", "--out", str(out)], pages=("list_empty.html",))
    assert code == 1
    assert list((out / "debug").glob("*list*.png"))
    assert not (out / "receipts.csv").exists()


def test_name_is_stripped(run_cli, out, monkeypatch):
    seen = {}

    def fake_download(site, ledger, opts, ui, **kwargs):
        seen["name"] = opts.name
        return Summary()

    monkeypatch.setattr(cli, "run_download", fake_download)
    code, _, _ = run_cli(["download", "--out", str(out), "--name", " 株式会社サンプル ", "--title", "御中"])
    assert code == 0 and seen["name"] == "株式会社サンプル"


def test_abort_is_exit_1(run_cli, out, monkeypatch):
    monkeypatch.setattr(cli, "run_download", lambda *a, **k: Summary(review=3, aborted=True))
    code, ui, _ = run_cli(["download", "--out", str(out), *NAME_TITLE])
    assert code == 1
    assert any("中止" in m for m in ui.infos)


def test_keep_browser_open_waits_for_enter(run_cli, out, monkeypatch):
    monkeypatch.setattr(cli, "run_download", lambda *a, **k: Summary(failed=1, keep_browser_open=True))
    seen = {}

    def at_second_enter(session):
        seen["browser_open"] = not session.closed and len(session.context.pages) >= 1

    code, ui, session = run_cli(["download", "--out", str(out), *NAME_TITLE],
                                pages=("list_p1.html", at_second_enter))
    assert len(ui.enters) == 2
    assert "ブラウザを開いたまま" in ui.enters[1]
    assert seen["browser_open"] is True  # 手で保存できるよう、Enter を押すまで閉じない
    assert session.closed


# --- 領収書まとめ.pdf ---

def page_widths(path):
    from pypdf import PdfReader

    return [int(page.mediabox.width) for page in PdfReader(str(path)).pages]


def test_e2e_download_writes_merged_pdf(run_cli, out):
    code, ui, _ = run_cli(["download", "--out", str(out), *NAME_TITLE], answers=[True, True, True])
    assert code == 0
    merged = out / "領収書まとめ.pdf"
    widths = page_widths(merged)
    assert len(widths) == 3          # RY001・RY003・RY004 の3件
    assert widths[1] == 333          # 2番目(3/22 の RY003)はダウンロードされた PDF
    assert any(str(merged) in m and "3 件" in m for m in ui.infos)
    # まとめファイルは台帳にも個別の領収書にも数えない
    assert sorted(p.name for p in out.glob("*.pdf") if p.name != "領収書まとめ.pdf") == [
        "2025-03-15_ホテルサンプル東京_RY001.pdf",
        "2025-03-22_ビジネスホテル架空大阪_RY003.pdf",
        "2025-04-01_リゾート見本沖縄_RY004.pdf",
    ]


def test_e2e_download_declined_writes_no_merged_pdf(run_cli, out):
    code, _, _ = run_cli(["download", "--out", str(out), *NAME_TITLE], answers=[False])
    assert code == 0
    assert not (out / "領収書まとめ.pdf").exists()


def test_e2e_second_download_rebuilds_merged_pdf(run_cli, out):
    run_cli(["download", "--out", str(out), *NAME_TITLE, "--limit", "1"], answers=[True, True])
    assert len(page_widths(out / "領収書まとめ.pdf")) == 1
    run_cli(["download", "--out", str(out), *NAME_TITLE], answers=[True, True, True])
    assert len(page_widths(out / "領収書まとめ.pdf")) == 3


def test_merge_failure_keeps_download_result(run_cli, out, monkeypatch):
    # まとめファイルを作れなくても、発行と保存の結果(終了コード・台帳)は変えない
    def broken(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(cli, "merge_receipts", broken)
    code, ui, _ = run_cli(["download", "--out", str(out), *NAME_TITLE, "--limit", "1"], answers=[True, True])
    assert code == 0
    assert read_ledger(out)["RY001"]["状態"] == "取得済み"
    assert any("まとめファイルを作れませんでした" in m for m in ui.infos)
    (log,) = (out / "debug").glob("*_error.txt")
    assert "disk full" in log.read_text(encoding="utf-8")


def test_merge_command_does_not_open_browser(run_cli, out, capsys):
    run_cli(["download", "--out", str(out), *NAME_TITLE], answers=[True, True, True])
    (out / "領収書まとめ.pdf").unlink()
    no_browser = NoBrowser()
    assert cli.main(["merge", "--out", str(out)], open_session=no_browser, ui=FakeUI()) == 0
    assert no_browser.calls == 0
    assert len(page_widths(out / "領収書まとめ.pdf")) == 3


def test_merge_command_reports_skipped(run_cli, out):
    run_cli(["download", "--out", str(out), *NAME_TITLE], answers=[True, True, True])
    (out / "2025-03-22_ビジネスホテル架空大阪_RY003.pdf").unlink()
    ui = FakeUI()
    assert cli.main(["merge", "--out", str(out)], open_session=NoBrowser(), ui=ui) == 0
    assert len(page_widths(out / "領収書まとめ.pdf")) == 2
    assert any("RY003" in m for m in ui.infos)


def test_merge_command_without_ledger_is_exit_1(out, capsys):
    ui = FakeUI()
    assert cli.main(["merge", "--out", str(out)], open_session=NoBrowser(), ui=ui) == 1
    assert not out.exists()  # 何も作らない
    assert "台帳" in capsys.readouterr().err


def test_merge_command_with_nothing_done(run_cli, out):
    run_cli(["list", "--out", str(out)])
    ui = FakeUI()
    assert cli.main(["merge", "--out", str(out)], open_session=NoBrowser(), ui=ui) == 0
    assert not (out / "領収書まとめ.pdf").exists()
    assert any("まとめる領収書がありません" in m for m in ui.infos)


def test_merge_command_rejects_date_range(out):
    # merge は台帳の取得済み全件が対象。期間の指定は受け付けない
    assert cli.main(["merge", "--out", str(out), "--from", "2025-01-01"],
                    open_session=NoBrowser(), ui=FakeUI()) == 2


# --- レビュー指摘: 読めない台帳では、ブラウザを開く前に止まる ---

def test_unreadable_ledger_stops_before_browser(out, capsys):
    out.mkdir(parents=True)
    broken = b"\xff\xfe\x00\x00 not a csv \x81"
    (out / "receipts.csv").write_bytes(broken)
    no_browser = NoBrowser()
    for argv in (["list"], ["download", *NAME_TITLE], ["merge"]):
        assert cli.main([*argv, "--out", str(out)], open_session=no_browser, ui=FakeUI()) == 1
    assert no_browser.calls == 0
    assert (out / "receipts.csv").read_bytes() == broken  # 上書きしていない
    err = capsys.readouterr().err
    assert "台帳を読めません" in err and "Traceback" not in err


# --- 入力を受け取れない端末(別のプログラムから実行された場合など) ---

def test_no_interactive_input_is_exit_1_with_message(run_cli, out, capsys):
    def no_stdin(count):
        raise EOFError()

    code, _, session = run_cli(["list", "--out", str(out)], on_enter=no_stdin)
    assert code == 1 and session.closed
    err = capsys.readouterr().err
    assert "入力を受け取れません" in err and "Traceback" not in err


def test_console_confirm_without_stdin_means_no(monkeypatch):
    def no_stdin(prompt=""):
        raise EOFError()

    monkeypatch.setattr("builtins.input", no_stdin)
    assert cli.ConsoleUI().confirm("発行しますか? [y/N]") is False  # 入力できないなら、発行しない


# --- 案内モード(guide): 質問に答えるだけで、一覧 → 発行 → まとめまで進む ---

@pytest.fixture
def run_guide(tmp_path, dummy_site, monkeypatch):
    monkeypatch.setattr(runner, "INTERVAL_SECONDS", (0.0, 0.0))
    monkeypatch.setattr(cli, "SITE_TIMEOUT_MS", 1500)
    monkeypatch.setattr(cli, "GUIDE_STABLE_SECONDS", 0.2)

    def run(out, texts, answers=(), start="goto_list_later.html"):
        session = HeadlessSession(tmp_path / "profile")
        ui = FakeUI(list(answers), texts=list(texts))
        opened = []
        code = cli.main(["guide", "--out", str(out)], open_session=session, ui=ui,
                        start_url=dummy_site + start, open_folder=opened.append)
        return code, ui, opened

    return run


def test_guide_runs_from_questions_to_merged_pdf(run_guide, out):
    # 宛名・敬称(2 = 御中)・期間(空 = 全件)に答え、あとは確認に y と答えるだけ
    code, ui, opened = run_guide(out, texts=["株式会社サンプル", "2", ""],
                                 answers=[True, True, True, True])
    assert code == 0
    assert sorted(p.name[:10] for p in receipts(out)) == ["2025-03-15", "2025-03-22", "2025-04-01"]
    assert len(page_widths(out / "領収書まとめ.pdf")) == 3
    assert ui.enters == []  # Enter を押しに戻らなくてよい
    assert ui.confirms[0] == runner.CONFIRM_START.format(n=5)
    assert opened == [out]  # 終わったら出力フォルダを開く
    assert read_ledger(out)["RY001"]["状態"] == "取得済み"


def test_guide_period_as_a_range(run_guide, out):
    code, _, _ = run_guide(out, texts=["株式会社サンプル", "御中", "2025-03-01 2025-03-31"],
                           answers=[True, True, True, True])
    assert code == 0
    assert sorted(p.name[:10] for p in receipts(out)) == ["2025-03-15", "2025-03-22"]


def test_guide_title_one_means_sama(run_guide, out, monkeypatch):
    seen = {}

    def fake_download(site, ledger, opts, ui, **kwargs):
        seen["opts"] = opts
        return Summary()

    monkeypatch.setattr(cli, "run_download", fake_download)
    code, _, opened = run_guide(out, texts=["山田太郎", "1", "2025"])
    assert code == 0
    opts = seen["opts"]
    assert (opts.name, opts.title, opts.confirm_start) == ("山田太郎", "様", True)
    assert (opts.date_from, opts.date_to) == (date(2025, 1, 1), date(2025, 12, 31))
    assert opened == []  # 何も保存していなければ、フォルダは開かない


def test_guide_asks_again_after_a_bad_answer(run_guide, out, monkeypatch):
    monkeypatch.setattr(cli, "run_download", lambda *a, **k: Summary())
    code, ui, _ = run_guide(out, texts=["㈱サンプル", "株式会社サンプル", "3", "2", "きのう", ""])
    assert code == 0
    shown = "\n".join(ui.infos)
    assert "環境依存文字" in shown          # 宛名のだめな理由を見せて、聞き直す
    assert len(ui.asks) == 6


def test_guide_gives_up_after_repeated_bad_answers(out, capsys):
    no_browser = NoBrowser()
    ui = FakeUI(texts=["㈱"] * cli.GUIDE_MAX_ASKS)
    assert cli.main(["guide", "--out", str(out)], open_session=no_browser, ui=ui) == 2
    assert no_browser.calls == 0


def test_guide_start_declined_issues_nothing(run_guide, out):
    code, _, opened = run_guide(out, texts=["株式会社サンプル", "2", ""], answers=[False])
    assert code == 0
    assert receipts(out) == [] and opened == []
    assert read_ledger(out)["RY001"]["状態"] == "未取得"


def test_guide_gives_up_when_the_list_never_appears(run_guide, out, monkeypatch):
    monkeypatch.setattr(cli, "GUIDE_WAIT_SECONDS", 1)
    code, ui, _ = run_guide(out, texts=["株式会社サンプル", "2", ""], start="unknown.html")
    assert code == 1
    assert list((out / "debug").glob("*.png"))
    assert any("予約一覧" in m for m in ui.infos)


def test_guide_tells_what_it_sees_while_waiting(run_guide, out, monkeypatch):
    # 一覧を認識できないまま待たせない。いまのページをどう判定しているかを伝える
    monkeypatch.setattr(cli, "GUIDE_WAIT_SECONDS", 2)
    monkeypatch.setattr(cli, "GUIDE_PROGRESS_SECONDS", 0.5)
    code, ui, _ = run_guide(out, texts=["株式会社サンプル", "2", ""], start="unknown.html")
    assert code == 1
    waiting = [m for m in ui.infos if "判定: 不明" in m and "unknown.html" in m]
    assert len(waiting) >= 2
    assert any("予約一覧を待っています" in m for m in ui.infos)


def test_guide_without_stdin_is_exit_1(out, capsys):
    no_browser = NoBrowser()
    ui = FakeUI(texts=[EOFError()])
    assert cli.main(["guide", "--out", str(out)], open_session=no_browser, ui=ui) == 1
    assert no_browser.calls == 0
    assert "入力を受け取れません" in capsys.readouterr().err


@pytest.mark.parametrize("text, expected", [
    ("", (None, None)),
    ("  ", (None, None)),
    ("2025", (date(2025, 1, 1), date(2025, 12, 31))),
    ("2025", (date(2025, 1, 1), date(2025, 12, 31))),          # 全角の数字
    ("2025-01-01 2025-03-31", (date(2025, 1, 1), date(2025, 3, 31))),
    ("2025-01-01〜2025-03-31", (date(2025, 1, 1), date(2025, 3, 31))),
    ("2025/1/1 2025/3/31", (date(2025, 1, 1), date(2025, 3, 31))),
])
def test_parse_period(text, expected):
    assert cli.parse_period(text) == expected


@pytest.mark.parametrize("text", ["きのう", "2025-13-01 2025-12-31", "2025-03-31 2025-01-01", "25", "2025-01-01"])
def test_parse_period_rejects(text):
    assert cli.parse_period(text) is None


# --- 起動スクリプト start.sh ---

START_SH = cli.REPO_ROOT / "rakuten_receipts" / "start.sh"
needs_venv = pytest.mark.skipif(not (cli.REPO_ROOT / ".venv" / "bin" / "python").exists(),
                                reason="リポジトリ直下の .venv が必要(なければ start.sh がインストールを始めてしまう)")


@needs_venv
def test_start_script_launches_the_guide_from_any_directory(tmp_path):
    import os

    assert os.access(START_SH, os.X_OK)
    env = dict(os.environ, RAKUTEN_RECEIPTS_NO_UPDATE="1")  # テスト中に作業用リポジトリを更新しない
    done = subprocess.run([str(START_SH), "--help"], cwd=str(tmp_path), capture_output=True, text=True,
                          timeout=120, env=env)
    assert done.returncode == 0, done.stderr
    assert "guide" in done.stdout and "--out" in done.stdout


def test_start_script_explains_when_python_is_missing(tmp_path):
    # python3 が見つからない Mac でも、何をすればよいかを日本語で伝える
    done = subprocess.run(["/bin/bash", str(START_SH)], cwd=str(tmp_path), capture_output=True, text=True,
                          timeout=60, env={"PATH": str(tmp_path), "HOME": str(tmp_path)})
    assert done.returncode == 1
    assert "python3" in done.stderr and "インストール" in done.stderr


def test_start_script_pulls_the_latest_version_first(tmp_path):
    # 直した版をプッシュしたら、利用者は同じ1行を実行し直すだけで最新になる
    import os
    import shutil

    def git(*args, cwd):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
                       cwd=str(cwd), check=True, capture_output=True)

    origin = tmp_path / "origin"
    (origin / "rakuten_receipts").mkdir(parents=True)
    shutil.copy(START_SH, origin / "rakuten_receipts" / "start.sh")
    git("init", "-q", "-b", "main", cwd=origin)
    git("add", "-A", cwd=origin)
    git("commit", "-q", "-m", "first", cwd=origin)
    clone = tmp_path / "clone"
    git("clone", "-q", str(origin), str(clone), cwd=tmp_path)
    (origin / "NEW_VERSION").write_text("2")
    git("add", "-A", cwd=origin)
    git("commit", "-q", "-m", "second", cwd=origin)

    # python3 を「古すぎる」ことにして、更新の直後で止める(インストールまで進ませない)
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "python3").write_text("#!/bin/sh\nexit 1\n")
    (fake_bin / "python3").chmod(0o755)
    env = {"PATH": f"{fake_bin}:{os.environ['PATH']}", "HOME": str(tmp_path)}
    done = subprocess.run(["/bin/bash", str(clone / "rakuten_receipts" / "start.sh")], cwd=str(tmp_path),
                          capture_output=True, text=True, timeout=60, env=env)
    assert done.returncode == 1 and "Python 3.9 以上" in done.stderr
    assert (clone / "NEW_VERSION").read_text() == "2"


def test_start_script_runs_when_update_is_impossible(tmp_path):
    # 更新できなくても(ネットにつながらない、git で入れていない)、いまある版で続ける
    import os
    import shutil

    tool = tmp_path / "tool" / "rakuten_receipts"
    tool.mkdir(parents=True)
    shutil.copy(START_SH, tool / "start.sh")
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "python3").write_text("#!/bin/sh\nexit 1\n")
    (fake_bin / "python3").chmod(0o755)
    env = {"PATH": f"{fake_bin}:{os.environ['PATH']}", "HOME": str(tmp_path)}
    done = subprocess.run(["/bin/bash", str(tool / "start.sh")], cwd=str(tmp_path),
                          capture_output=True, text=True, timeout=60, env=env)
    assert done.returncode == 1 and "Python 3.9 以上" in done.stderr  # 更新の段階では止まっていない


# --- ConsoleUI ---

@pytest.mark.parametrize("typed, expected", [("y", True), ("Y", True), ("yes", True), (" y ", True),
                                             ("", False), ("n", False), ("はい", False), ("yy", False)])
def test_console_confirm(monkeypatch, typed, expected):
    monkeypatch.setattr("builtins.input", lambda prompt="": typed)
    assert cli.ConsoleUI().confirm("続けますか? [y/N]") is expected
