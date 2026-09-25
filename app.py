"""個別株・投資信託 分析ダッシュボード(Streamlit)。

起動: ~/.buzzraseya-stock-analyzer-venv/bin/streamlit run app.py --server.port 8766
投資判断支援システム(investment_system, port 8765)とは独立して動く。

最上部の検索欄に 証券コード・社名・ティッカー・ファンド名 のどれを入れても Enter で即分析する
(株式は resolver.py、投資信託は funds.py で候補を探す)。URLに ?t=トヨタ のように付けても開ける。
分析結果の下では、分からない点をそのまま質問できる(assistant.py)。
"""
from __future__ import annotations

import os
import re
from concurrent.futures import ThreadPoolExecutor

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

import pandas as pd
import streamlit as st

# Web公開版(Streamlit Community Cloud)では Secrets からAPIキー等を環境変数に反映する
try:
    for _key in ("anthropic_api_key", "STOCK_ANALYZER_SHARED"):
        if _key in st.secrets:
            os.environ["ANTHROPIC_API_KEY" if _key == "anthropic_api_key" else _key] = str(st.secrets[_key])
except Exception:  # noqa: BLE001 - secrets.toml が無いローカル環境ではアクセス自体が例外になる
    pass

from stock_analyzer.analysis import analyze_stock, fmt_money, fmt_pct, fmt_x
from stock_analyzer.config import REPORT_DIR, SHARED_MODE, WATCHLIST_PATH, add_recent as _add_recent_file, load_recent as _load_recent_file, load_watchlist as _load_watchlist_file, save_watchlist as _save_watchlist_file
from stock_analyzer.fund_analysis import analyze_fund, fmt_oku
from stock_analyzer.fund_report import build_fund_report_markdown
from stock_analyzer.fund_view import render_fund_analysis
from stock_analyzer.funds import ISIN_RE, search_funds
from stock_analyzer.report import build_stock_report_markdown
from stock_analyzer.resolver import describe, resolve
from stock_analyzer.view import badge, render_analysis, render_qa, zebra_style

st.set_page_config(page_title="個別株・ファンド分析", page_icon="🔬", layout="wide")
_theme_type = st.context.theme.type if st.context.theme else None


# 共有モード(Web公開版)ではウォッチリスト・最近の履歴を利用者ごとにセッション内だけで持つ
def load_watchlist() -> list[dict]:
    if SHARED_MODE:
        return list(st.session_state.get("shared_watchlist", []))
    return _load_watchlist_file()


def save_watchlist(items: list[dict]) -> None:
    if SHARED_MODE:
        st.session_state["shared_watchlist"] = list(items)
    else:
        _save_watchlist_file(items)


def load_recent() -> list[dict]:
    if SHARED_MODE:
        return list(st.session_state.get("shared_recent", []))
    return _load_recent_file()


def add_recent(key: str, name: str | None, kind: str = "stock", **extra) -> None:
    if not SHARED_MODE:
        _add_recent_file(key, name, kind=kind, **extra)
        return
    items = [r for r in load_recent() if (r.get("kind", "stock"), r.get("key")) != (kind, key)]
    items.insert(0, {"kind": kind, "key": key, "name": name or key, **extra})
    st.session_state["shared_recent"] = items[:20]


watchlist = load_watchlist()
by_ticker = {w["ticker"]: w for w in watchlist if w.get("kind", "stock") == "stock"}
by_isin = {w["isin"]: w for w in watchlist if w.get("kind") == "fund" and w.get("isin")}

_CODE_LIKE = re.compile(r"^(\d{4}[0-9A-Z]?(\.T)?|[A-Z^][A-Z0-9.\-=]{0,9})$")


def _entry_label(w: dict) -> str:
    return f"{w.get('name') or w.get('ticker') or w.get('isin')}({w.get('ticker') or w.get('isin')})"


def _fund_label(c: dict) -> str:
    bits = [f"🏦 {c['name']}", "投信", c.get("company") or ""]
    if c.get("net_assets_million") is not None:
        bits.append(fmt_oku(c["net_assets_million"]))
    if c.get("trust_reward_pct") is not None:
        bits.append(f"信託報酬{c['trust_reward_pct']:.3f}%")
    bits.append("楽天○" if c.get("rakuten_available") else "楽天×")
    return "｜".join(b for b in bits if b)


# ------------------------------------------------------------
# 分析の実行(検索欄・候補・最近・ウォッチリストのどこから来ても同じ)
# ------------------------------------------------------------
def run_target(target: dict) -> None:
    if target.get("kind") == "fund":
        entry = by_isin.get(target["isin"]) or {}
        with st.spinner(f"{target.get('name') or target['isin']} を分析中..."):
            result = analyze_fund(target["isin"], target.get("assoc") or entry.get("assoc"), entry.get("name") or target.get("name"))
        if result is None:
            st.error(f"{target['isin']} のファンドデータを取得できませんでした。")
            return
        add_recent(result["isin"], result["name"], kind="fund", assoc=result.get("assoc"))
    else:
        ticker = target["ticker"].strip().upper()
        entry = by_ticker.get(ticker) or {}
        with st.spinner(f"{target.get('name') or ticker} を分析中(初回は数秒かかります)..."):
            result = analyze_stock(ticker, position=entry, display_name=entry.get("name") or target.get("name"))
        if result is None:
            st.error(f"{ticker} の株価データを取得できませんでした。ティッカーの綴りを確認してください。")
            return
        result["kind"] = "stock"
        add_recent(result["ticker"], result["name"], kind="stock")
    st.session_state["result"] = result
    st.session_state.pop("candidates", None)


def handle_query(query: str) -> None:
    query = query.strip()
    if not query:
        return
    upper = query.upper()
    if upper in by_ticker:
        run_target({"kind": "stock", "ticker": upper, "name": by_ticker[upper].get("name")})
        return
    if ISIN_RE.match(upper):
        run_target({"kind": "fund", "isin": upper})
        return
    code_like = bool(_CODE_LIKE.match(upper)) and not re.search(r"[ぁ-んァ-ン一-龥]", query)
    with st.spinner(f"「{query}」を検索中..."):
        if code_like:
            stocks, funds = resolve(query), []
        else:
            with ThreadPoolExecutor(max_workers=2) as pool:
                f_stocks = pool.submit(resolve, query)
                f_funds = pool.submit(search_funds, query, 8)
                stocks, funds = f_stocks.result(), f_funds.result()
    candidates = [{"kind": "stock", "ticker": c["ticker"], "name": c["name"], "label": describe(c)} for c in stocks]
    candidates += [{"kind": "fund", "isin": c["isin"], "assoc": c.get("assoc"), "name": c["name"], "label": _fund_label(c)} for c in funds]
    if len(candidates) == 1:
        run_target(candidates[0])
    elif candidates:
        st.session_state["candidates"] = candidates
    else:
        st.warning(f"「{query}」に該当する銘柄・ファンドが見つかりませんでした。日本株は4桁コード(例: 7203)、米国株はティッカー(例: AAPL)、投信はファンド名の一部で入力してください。")


def _pick_callback(widget_key: str, mapping_key: str) -> None:
    """pills(最近・ウォッチリスト・候補)で選んだら pending に積み、ウィジェット自体は未選択に戻す。"""
    label = st.session_state.get(widget_key)
    if label:
        st.session_state["pending"] = st.session_state[mapping_key][label]
        st.session_state[widget_key] = None


# ------------------------------------------------------------
# サイドバー: ウォッチリスト管理(株式・投信。保有株数・取得単価は任意)
# ------------------------------------------------------------
with st.sidebar:
    st.markdown("### 📋 ウォッチリスト")
    if not watchlist:
        st.caption("まだ銘柄がありません。分析結果の「ウォッチリストに追加」か、下のフォームから追加してください。")
    for w in watchlist:
        col_name, col_del = st.columns([4, 1])
        if w.get("kind") == "fund":
            col_name.markdown(f"🏦 **{w.get('name') or w['isin']}** `投信`")
            key = f"del_{w['isin']}"
        else:
            held = f"(保有{w['shares']:g}株)" if w.get("shares") else ""
            col_name.markdown(f"**{w.get('name') or w['ticker']}** `{w['ticker']}` {held}")
            key = f"del_{w['ticker']}"
        if col_del.button("✕", key=key, help="ウォッチリストから削除"):
            save_watchlist([x for x in watchlist if x is not w])
            st.rerun()
    st.markdown("**株式を追加**")
    with st.form("add_form", clear_on_submit=True):
        new_ticker = st.text_input("ティッカー", placeholder="7203.T / AAPL")
        new_name = st.text_input("名前(任意)")
        new_shares = st.number_input("保有株数(任意)", min_value=0.0, value=0.0, step=1.0)
        new_cost = st.number_input("取得単価(任意、その銘柄の通貨建て)", min_value=0.0, value=0.0, step=1.0)
        if st.form_submit_button("追加"):
            ticker = new_ticker.strip().upper()
            if not ticker:
                st.warning("ティッカーを入力してください。")
            elif ticker in by_ticker:
                st.warning("すでに登録されています。")
            else:
                entry: dict = {"ticker": ticker}
                if new_name.strip():
                    entry["name"] = new_name.strip()
                if new_shares > 0:
                    entry["shares"] = new_shares
                if new_cost > 0:
                    entry["avg_cost"] = new_cost
                save_watchlist(watchlist + [entry])
                st.rerun()
    if SHARED_MODE:
        st.caption("投信は分析結果の「ウォッチリストに追加」から登録できます。ウォッチリストはこのブラウザを閉じるまで保持されます。")
    else:
        st.caption(f"投信は分析結果の「ウォッチリストに追加」から登録できます。保存先: {WATCHLIST_PATH}")

# ------------------------------------------------------------
# 最上部: クイック検索(Enterで即分析)
# ------------------------------------------------------------
st.title("🔬 個別株・ファンド分析")
if SHARED_MODE:
    st.warning(
        "このアプリは個人が作成した分析ツールで、**投資助言・売買の推奨ではありません**。"
        "表示される点数・所見は外部データ(Yahoo Finance・JPX・投信総合検索ライブラリー等)に基づく機械的な参考値で、"
        "遅延や誤りを含むことがあります。投資判断はご自身の責任で行ってください。",
        icon="⚠️",
    )
with st.form("quick_search", border=False):
    qc1, qc2 = st.columns([5, 1])
    query = qc1.text_input(
        "銘柄コード・社名・ティッカー・ファンド名",
        placeholder="例: 7203 / トヨタ / アップル / AAPL / オルカン / 楽天 全米  →  Enter で即分析",
        label_visibility="collapsed",
    )
    submitted = qc2.form_submit_button("🔍 調べる", type="primary", use_container_width=True)

qp_query = st.query_params.get("t")
if qp_query and not st.session_state.get("qp_done"):
    st.session_state["qp_done"] = True
    st.session_state["pending"] = {"query": qp_query}

if submitted:
    handle_query(query)

pending = st.session_state.pop("pending", None)
if pending:
    if "query" in pending:
        handle_query(pending["query"])
    else:
        run_target(pending)

candidates = st.session_state.get("candidates")
if candidates:
    mapping = {c["label"]: c for c in candidates}
    st.session_state["cand_map"] = mapping
    st.pills("候補を選んでください(🏦は投資信託)", list(mapping.keys()), key="cand_pills", on_change=_pick_callback, args=("cand_pills", "cand_map"))

recent = load_recent()
if recent:
    mapping = {}
    for r in recent[:10]:
        key = r.get("key") or r.get("ticker")
        if r.get("kind") == "fund":
            mapping[f"🏦 {r['name']}"] = {"kind": "fund", "isin": key, "assoc": r.get("assoc"), "name": r["name"]}
        else:
            mapping[f"{r['name']}({key})"] = {"kind": "stock", "ticker": key, "name": r["name"]}
    st.session_state["recent_map"] = mapping
    st.pills("最近調べた銘柄", list(mapping.keys()), key="recent_pills", on_change=_pick_callback, args=("recent_pills", "recent_map"))
if watchlist:
    mapping = {}
    for w in watchlist:
        if w.get("kind") == "fund":
            mapping[f"🏦 {w.get('name') or w['isin']}"] = {"kind": "fund", "isin": w["isin"], "assoc": w.get("assoc"), "name": w.get("name")}
        else:
            mapping[_entry_label(w)] = {"kind": "stock", "ticker": w["ticker"], "name": w.get("name")}
    st.session_state["wl_map"] = mapping
    st.pills("ウォッチリスト", list(mapping.keys()), key="wl_pills", on_change=_pick_callback, args=("wl_pills", "wl_map"))

tab_labels = ["🔍 分析結果", "📋 ウォッチリスト一括スキャン"] + ([] if SHARED_MODE else ["📄 保存済みレポート"])
tabs = st.tabs(tab_labels)
tab_one, tab_scan = tabs[0], tabs[1]
tab_reports = tabs[2] if not SHARED_MODE else None

# ------------------------------------------------------------
# タブ1: 分析結果 + 質問
# ------------------------------------------------------------
with tab_one:
    result = st.session_state.get("result")
    if result and result.get("kind") == "fund":
        if result["isin"] not in by_isin:
            if st.button(f"➕ {result['name']} をウォッチリストに追加"):
                save_watchlist(watchlist + [{"kind": "fund", "isin": result["isin"], "assoc": result.get("assoc"), "name": result["name"]}])
                st.rerun()
        render_fund_analysis(result, _theme_type)
        render_qa(build_fund_report_markdown(result), result["isin"], result["name"])
    elif result:
        if result["ticker"] not in by_ticker:
            if st.button(f"➕ {result['name']} をウォッチリストに追加"):
                save_watchlist(watchlist + [{"ticker": result["ticker"], "name": result["name"]}])
                st.rerun()
        render_analysis(result, _theme_type)
        render_qa(build_stock_report_markdown(result), result["ticker"], f"{result['name']}({result['ticker']})")
    else:
        st.info("上の検索欄に 銘柄コード・社名・ティッカー・ファンド名 を入れて Enter を押すと、ここに分析結果が表示されます。")
        st.caption(
            "株式: Yahoo Financeの年次決算(最大5期)・配当履歴・5年日足から、財務(成長性・収益性・健全性・割安度・還元)と"
            "株価(移動平均・RSI・MACD・ボリンジャー・52週高安・出来高)を採点。"
            "投信: 投信総合検索ライブラリーのデータから、コスト・規模/資金流入・リターン・リスク効率・継続性を採点し、楽天証券での取扱有無も表示。"
            "いずれも機械的な参考値であり、売買の推奨ではありません。"
        )

# ------------------------------------------------------------
# タブ2: ウォッチリスト全銘柄の一覧比較
# ------------------------------------------------------------
with tab_scan:
    st.caption("ウォッチリストの全銘柄(株式・投信)を分析して一覧で比べます(初回は1銘柄あたり数秒、以降はキャッシュで高速)。")
    if st.button("一括スキャンを実行", type="primary", disabled=not watchlist):
        rows = []
        progress = st.progress(0.0)
        for i, w in enumerate(watchlist):
            if w.get("kind") == "fund":
                a = analyze_fund(w["isin"], w.get("assoc"), w.get("name"))
                if a:
                    r = a["attrs"]
                    rows.append(
                        {
                            "銘柄": f"🏦 {a['name']}",
                            "種別": "投信",
                            "価格": f"{a['nav']:,.0f}円",
                            "前日比": fmt_pct(a.get("change_pct"), 2, signed=True),
                            "スコア": a["score"]["total"],
                            "総合所見": a["verdict"]["label"],
                            "コスト/PER": fmt_pct(r.get("trust_reward_pct"), 3),
                            "純資産/PBR": fmt_oku(r.get("net_assets_million")),
                            "1年リターン": fmt_pct((r.get("returns_pct") or {}).get("1y"), signed=True),
                            "楽天証券": "○" if r.get("rakuten_available") else "×",
                        }
                    )
                else:
                    rows.append({"銘柄": w.get("name") or w["isin"], "種別": "投信", "総合所見": "データ取得失敗"})
            else:
                a = analyze_stock(w["ticker"], position=w, display_name=w.get("name"))
                if a:
                    t, r = a["technicals"], a["ratios"]
                    rows.append(
                        {
                            "銘柄": f"{a['name']}({a['ticker']})",
                            "種別": "株式",
                            "価格": fmt_money(a["price"], a["currency"]),
                            "前日比": fmt_pct(a["change_pct"], signed=True),
                            "スコア": "対象外" if a.get("is_fund") else f"{a['fundamental_score']['total']} / T{a['trend_score']['total']}",
                            "総合所見": a["verdict"]["label"],
                            "コスト/PER": fmt_x(r.get("per")),
                            "純資産/PBR": fmt_x(r.get("pbr"), 2),
                            "1年リターン": fmt_pct((t.get("returns_pct") or {}).get("1Y"), signed=True),
                            "楽天証券": "○",
                            "タイミング": a["timing"]["label"],
                            "含み損益": fmt_pct(a["position"]["unrealized_pnl_pct"], signed=True)
                            if a.get("position") and a["position"].get("unrealized_pnl_pct") is not None
                            else "",
                        }
                    )
                else:
                    rows.append({"銘柄": w["ticker"], "種別": "株式", "総合所見": "データ取得失敗"})
            progress.progress((i + 1) / len(watchlist))
        st.session_state["scan"] = rows
    rows = st.session_state.get("scan")
    if rows:
        st.dataframe(zebra_style(pd.DataFrame(rows)), use_container_width=True, hide_index=True)
        st.caption("株式のスコアは「ファンダ / Tトレンド強度」。詳しく見たい銘柄は上の「ウォッチリスト」から選ぶと分析結果タブに表示されます。")

# ------------------------------------------------------------
# タブ3: 保存済みレポート(オーナー環境のみ)
# ------------------------------------------------------------
if tab_reports is not None:
    with tab_reports:
        files = sorted(REPORT_DIR.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True) if REPORT_DIR.exists() else []
        if not files:
            st.caption("保存済みレポートはまだありません(分析結果の下の「Markdownで保存」から保存できます)。")
        for f in files[:50]:
            with st.expander(f.stem):
                st.markdown(f.read_text(encoding="utf-8"))

if SHARED_MODE:
    st.caption(
        "データ: Yahoo Finance / JPX 東証上場銘柄一覧 / Wikidata / 投信総合検索ライブラリー(資産運用業協会)。"
        "本アプリは投資助言ではなく、正確性・完全性を保証しません。"
    )
