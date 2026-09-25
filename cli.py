"""個別株・投資信託の分析をコマンドラインから実行する(kabu ランチャー経由でも同じ)。

  cli.py 7059.T 7974.T          # ティッカー指定
  cli.py トヨタ                 # 社名で検索。候補が1件なら即分析、複数なら候補を表示して終了
  cli.py アップル AAPL          # 米国株はカタカナ名・英語名・ティッカーのどれでも
  cli.py オルカン               # 投資信託もファンド名で検索(🏦印)。ISIN(JP90C000H1T1)でも可
  cli.py --search ソニー        # 候補だけ表示
  cli.py --watchlist            # 銘柄分析/config/watchlist.yaml の全銘柄
  cli.py 7203 --ask "PERは高い？"  # 分析したうえで質問に答える(要 APIキー or claude login)
  オプション: --no-save(レポートを書き出さず要約だけ表示)

レポートは ~/Dropbox/buzzraseya/銘柄分析/reports/ に保存される。
"""
import argparse
import re
import sys
import types
from pathlib import Path

# パッケージ名で import できるようにする。scripts/stock_analyzer/ のように親ディレクトリに置かれている
# 場合は親を sys.path に足し、公開リポジトリのようにこのフォルダ自体がリポジトリ直下の場合は
# フォルダ名に関係なく "stock_analyzer" という名前で読めるよう別名を登録する。
_HERE = Path(__file__).resolve().parent
if _HERE.name == "stock_analyzer":
    sys.path.insert(0, str(_HERE.parent))
elif "stock_analyzer" not in sys.modules:
    _pkg = types.ModuleType("stock_analyzer")
    _pkg.__path__ = [str(_HERE)]  # type: ignore[attr-defined]
    sys.modules["stock_analyzer"] = _pkg

from stock_analyzer.analysis import analyze_stock, one_line_summary  # noqa: E402
from stock_analyzer.config import add_recent, load_watchlist  # noqa: E402
from stock_analyzer.fund_analysis import analyze_fund, fmt_oku, fund_one_line  # noqa: E402
from stock_analyzer.fund_report import build_fund_report_markdown, write_fund_report  # noqa: E402
from stock_analyzer.funds import ISIN_RE, search_funds  # noqa: E402
from stock_analyzer.report import build_stock_report_markdown, write_stock_report  # noqa: E402
from stock_analyzer.resolver import describe, resolve  # noqa: E402

_CODE_LIKE = re.compile(r"^(\d{4}[0-9A-Z]?(\.T)?|[A-Z^][A-Z0-9.\-=]{0,9})$")


def find_targets(query: str, watchlist: dict, search_only: bool) -> list[dict]:
    upper = query.upper()
    if upper in watchlist:
        return [{"kind": "stock", "ticker": upper, "name": watchlist[upper].get("name")}]
    if ISIN_RE.match(upper):
        return [{"kind": "fund", "isin": upper}]
    code_like = bool(_CODE_LIKE.match(upper)) and not re.search(r"[ぁ-んァ-ン一-龥]", query)
    stocks = resolve(query)
    funds = [] if code_like else search_funds(query, 8)
    candidates = [{"kind": "stock", "ticker": c["ticker"], "name": c["name"], "label": describe(c)} for c in stocks]
    candidates += [
        {"kind": "fund", "isin": c["isin"], "assoc": c.get("assoc"), "name": c["name"],
         "label": f"🏦 {c['name']} 投信 {c.get('company') or ''} {fmt_oku(c.get('net_assets_million'))} 信託報酬{c.get('trust_reward_pct') or 0:.3f}% 楽天{'○' if c.get('rakuten_available') else '×'}"}
        for c in funds
    ]
    if search_only or len(candidates) != 1:
        print(f"「{query}」の候補: {len(candidates)}件")
        for c in candidates:
            print(f"  {(c.get('ticker') or c.get('isin')):<14} {c['label']}")
        if not candidates:
            print("  見つかりませんでした。日本株は4桁コード(例: 7203)、米国株はティッカー(例: AAPL)、投信はファンド名の一部で指定してください。")
        return []
    return candidates


def main() -> int:
    parser = argparse.ArgumentParser(description="個別株・投資信託のファンダメンタル・テクニカル分析")
    parser.add_argument("queries", nargs="*", help="ティッカー・証券コード・社名・ファンド名・ISIN")
    parser.add_argument("--watchlist", action="store_true", help="watchlist.yaml の全銘柄を分析")
    parser.add_argument("--search", action="store_true", help="候補の表示だけ行う(分析しない)")
    parser.add_argument("--no-save", action="store_true", help="レポートを保存しない")
    parser.add_argument("--ask", metavar="質問", help="分析結果を文脈にして質問に答える")
    args = parser.parse_args()

    entries = load_watchlist()
    watch_stocks = {w["ticker"]: w for w in entries if w.get("kind", "stock") == "stock"}
    watch_funds = {w["isin"]: w for w in entries if w.get("kind") == "fund"}
    targets: list[dict] = []
    for query in args.queries:
        if query.strip():
            targets += find_targets(query.strip(), watch_stocks, args.search)
    if args.watchlist:
        done = {(t["kind"], t.get("ticker") or t.get("isin")) for t in targets}
        for w in entries:
            key = ("fund", w.get("isin")) if w.get("kind") == "fund" else ("stock", w.get("ticker"))
            if key not in done:
                targets.append({"kind": "fund", "isin": w["isin"], "assoc": w.get("assoc"), "name": w.get("name")} if w.get("kind") == "fund" else {"kind": "stock", "ticker": w["ticker"], "name": w.get("name")})
    if args.search:
        return 0
    if not targets:
        if not args.queries:
            parser.print_help()
        return 1

    failed = 0
    for target in targets:
        if target["kind"] == "fund":
            entry = watch_funds.get(target["isin"]) or {}
            result = analyze_fund(target["isin"], target.get("assoc") or entry.get("assoc"), entry.get("name") or target.get("name"))
            if result is None:
                print(f"[skip] {target['isin']}: ファンドデータを取得できませんでした")
                failed += 1
                continue
            print(fund_one_line(result))
            add_recent(result["isin"], result["name"], kind="fund", assoc=result.get("assoc"))
            context = build_fund_report_markdown(result)
            if not args.no_save:
                print(f"  -> {write_fund_report(result)}")
            subject = result["name"]
        else:
            entry = watch_stocks.get(target["ticker"]) or {}
            result = analyze_stock(target["ticker"], position=entry, display_name=entry.get("name") or target.get("name"))
            if result is None:
                print(f"[skip] {target['ticker']}: 株価データを取得できませんでした")
                failed += 1
                continue
            print(one_line_summary(result))
            add_recent(result["ticker"], result["name"], kind="stock")
            context = build_stock_report_markdown(result)
            if not args.no_save:
                print(f"  -> {write_stock_report(result)}")
            subject = f"{result['name']}({result['ticker']})"
        if args.ask:
            from stock_analyzer.assistant import ask

            answer = ask(args.ask, context, subject=subject)
            print(f"\n💬 Q: {args.ask}\n{answer['answer']}\n")
    return 1 if failed and failed == len(targets) else 0


if __name__ == "__main__":
    sys.exit(main())
