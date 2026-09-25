"""投資信託の分析結果の表示(Streamlit)。app.py から呼ばれる。"""
from __future__ import annotations

from typing import Any

import altair as alt
import pandas as pd
import streamlit as st

from stock_analyzer.config import SHARED_MODE
from stock_analyzer.fund_analysis import fmt_oku, fmt_pct
from stock_analyzer.fund_report import build_fund_report_markdown, write_fund_report
from stock_analyzer.view import MUTED, _hover_layer, _items_table, _legend_top, _score_bars, _series_colors, badge, zebra_style


def _nav_chart(series: dict[str, Any], colors: list[str], has_dividends: bool) -> alt.LayerChart:
    df = pd.DataFrame({"日付": pd.to_datetime(series["dates"]), "基準価額": series["nav"], "分配金再投資": series["tr_index"]})
    names = ["基準価額", "分配金再投資"] if has_dividends else ["基準価額"]
    long = df.melt(id_vars=["日付"], value_vars=names, var_name="系列", value_name="値").dropna()
    lines = (
        alt.Chart(long)
        .mark_line(strokeWidth=1.8)
        .encode(
            x=alt.X("日付:T", title=None),
            y=alt.Y("値:Q", scale=alt.Scale(zero=False), title="円"),
            color=alt.Color("系列:N", scale=alt.Scale(domain=names, range=colors[: len(names)]), legend=_legend_top() if has_dividends else None),
        )
    )
    tooltip = [alt.Tooltip("日付:T")] + [alt.Tooltip(f"{n}:Q", format=",.0f") for n in names]
    selectors, rule = _hover_layer(df, tooltip)
    return alt.layer(lines, selectors, rule).properties(height=300, title="基準価額の推移(設定来)")


def _assets_chart(series: dict[str, Any], colors: list[str]) -> alt.LayerChart:
    df = pd.DataFrame({"日付": pd.to_datetime(series["dates"]), "純資産(億円)": [None if v is None else v / 100 for v in series["assets_million"]]}).dropna()
    area = alt.Chart(df).mark_area(color=colors[2], opacity=0.35, line={"color": colors[2], "strokeWidth": 1.5}).encode(
        x=alt.X("日付:T", title=None), y=alt.Y("純資産(億円):Q", title="億円", axis=alt.Axis(format="~s"))
    )
    selectors, rule = _hover_layer(df, [alt.Tooltip("日付:T"), alt.Tooltip("純資産(億円):Q", format=",.0f")])
    return alt.layer(area, selectors, rule).properties(height=180, title="純資産総額の推移(資金流入の目安)")


def render_fund_analysis(a: dict[str, Any], theme_type: str | None) -> None:
    colors = _series_colors(theme_type)
    r, m, s, v = a["attrs"], a["metrics"], a["score"], a["verdict"]
    title = a["name"] + (f"《{a['nickname']}》" if a.get("nickname") else "")
    st.subheader(f"🏦 {title}")
    st.caption(
        f"{r.get('company') or '-'} / {r.get('category') or '-'} / 設定日 {r.get('established') or '-'} / "
        f"決算 年{r.get('settle_per_year') or '?'}回 / 償還 {r.get('redemption') or '-'} / 基準日 {a['as_of']} / ISIN {a['isin']}"
    )
    c1, c2, c3, c4, c5, c6 = st.columns(6)
    c1.metric("基準価額", f"{a['nav']:,.0f}円", fmt_pct(a.get("change_pct"), 2, signed=True))
    c2.metric("総合スコア", f"{s['total']}/100")
    c3.metric("信託報酬(年率)", fmt_pct(r.get("trust_reward_pct"), 3))
    c4.metric("純資産", fmt_oku(r.get("net_assets_million")))
    c5.markdown("**楽天証券**")
    c5.markdown(
        badge("取扱あり", "good") if r.get("rakuten_available") else badge("取扱なし", "critical"),
        unsafe_allow_html=True,
    )
    c5.markdown(f"[楽天証券で見る]({r.get('rakuten_url')})")
    c6.markdown("**NISA**")
    nisa = []
    if r.get("nisa_tsumitate"):
        nisa.append(badge("つみたて投資枠", "good"))
    if r.get("nisa_growth"):
        nisa.append(badge("成長投資枠", "good"))
    c6.markdown(" ".join(nisa) if nisa else badge("対象外", "neutral"), unsafe_allow_html=True)

    st.markdown(f"**総合所見: {v['label']}**")
    st.markdown(f"**{v['summary']}**")
    for act in v["actions"]:
        st.markdown(f"- {act}")

    st.subheader("📊 スコア内訳")
    s1, s2 = st.columns([1, 1])
    with s1:
        st.altair_chart(_score_bars(s["categories"], colors[0]), use_container_width=True)
    with s2:
        with st.expander("採点の詳細", expanded=True):
            for cat in s["categories"]:
                st.markdown(f"**{cat['name']} {cat['points']}/{cat['max']}**")
                st.dataframe(_items_table(cat["items"]), use_container_width=True, hide_index=True)

    if m.get("available"):
        st.subheader("📈 基準価額・純資産の推移")
        has_div = bool(m.get("dividend_12m")) or any(abs(a_ - b_) > 0.5 for a_, b_ in zip(m["series"]["nav"], m["series"]["tr_index"]))
        st.altair_chart(_nav_chart(m["series"], colors, has_div), use_container_width=True)
        st.altair_chart(_assets_chart(m["series"], colors), use_container_width=True)

    st.subheader("🔍 期間別リターン・リスク")
    t1, t2 = st.columns(2)
    rows = []
    for key, label, years in (("6m", "6ヶ月", 0.5), ("1y", "1年", 1), ("3y", "3年", 3), ("5y", "5年", 5), ("10y", "10年", 10)):
        ret = (r.get("returns_pct") or {}).get(key)
        if ret is None:
            continue
        ann = ((1 + ret / 100) ** (1 / years) - 1) * 100 if years >= 1 and ret > -100 else None
        rk = (r.get("rank_return") or {}).get(key)
        sk = (r.get("rank_sharpe") or {}).get(key)
        rows.append(
            {
                "期間": label,
                "リターン(累積)": fmt_pct(ret, signed=True),
                "年率換算": fmt_pct(ann, signed=True) if ann is not None else "-",
                "同分類内順位": f"{rk[0]}位/{rk[1]}本" if rk else "N/A",
                "リスク(標準偏差)": fmt_pct((r.get("risk_pct") or {}).get(key)),
                "シャープレシオ": f"{(r.get('sharpe') or {}).get(key):.2f}" if (r.get("sharpe") or {}).get(key) is not None else "N/A",
                "シャープ順位": f"{sk[0]}位/{sk[1]}本" if sk else "N/A",
            }
        )
    with t1:
        st.caption("投信協会データ(同分類内順位は小さいほど良い)")
        st.dataframe(zebra_style(pd.DataFrame(rows)) if rows else pd.DataFrame(), use_container_width=True, hide_index=True)
    with t2:
        st.caption("基準価額履歴からの計算値(分配金再投資ベース)")
        if m.get("available"):
            rp, ann = m["returns_pct"], m["annualized_pct"]
            flow = r.get("flow_million") or {}
            calc = [
                {"指標": "期間リターン(1M/3M/6M/1Y)", "値": " / ".join(fmt_pct(rp.get(k), signed=True) for k in ("1M", "3M", "6M", "1Y"))},
                {"指標": "3年 / 5年(年率)", "値": f"{fmt_pct(ann.get('3Y'), signed=True)} / {fmt_pct(ann.get('5Y'), signed=True)}"},
                {"指標": "設定来(累積 / 年率)", "値": f"{fmt_pct(m.get('since_inception_pct'), signed=True)} / {fmt_pct(ann.get('since_inception'), signed=True)}(運用{m['years_running']:.1f}年)"},
                {"指標": "1年の変動率(年率標準偏差)", "値": fmt_pct(m.get("vol_1y_pct"))},
                {"指標": "シャープレシオ(1年)", "値": f"{m['sharpe_1y']:.2f}" if m.get("sharpe_1y") is not None else "N/A"},
                {"指標": "過去3年の最大下落率", "値": f"{fmt_pct(m.get('max_drawdown_3y_pct'))}(現在 高値比 {fmt_pct(m.get('current_drawdown_pct'))})"},
                {"指標": "純資産(1年前比)", "値": f"{fmt_oku(m.get('assets_million'))}({fmt_pct(m.get('assets_change_1y_pct'), signed=True)})"},
                {"指標": "資金流入(1ヶ月 / 3ヶ月 / 12ヶ月)", "値": f"{fmt_oku(flow.get('1m'))} / {fmt_oku(flow.get('3m'))} / {fmt_oku(flow.get('12m'))}"},
                {"指標": "分配金(直近12ヶ月)", "値": f"{m.get('dividend_12m', 0):,.0f}円(利回り {fmt_pct(m.get('dividend_yield_pct'), 2)})"},
            ]
            st.dataframe(zebra_style(pd.DataFrame(calc)), use_container_width=True, hide_index=True)
        else:
            st.caption("基準価額の履歴を取得できませんでした。")

    st.subheader("⚠️ リスク・要確認")
    if a["risk_flags"]:
        for flag in a["risk_flags"]:
            st.markdown(f"- {flag}")
    else:
        st.markdown("- 機械的に検出できる注意点はなし(投資対象の中身・為替ヘッジの有無は目論見書で確認)")
    links = [f"[楽天証券のファンドページ]({r.get('rakuten_url')})", f"[投信総合検索ライブラリー]({r.get('library_url')})"]
    if r.get("report_url"):
        links.append(f"[運用会社の月次レポート]({r['report_url']})")
    st.markdown(" ｜ ".join(links))

    st.subheader("📄 レポート")
    report_md = build_fund_report_markdown(a)
    b1, b2 = st.columns([1, 3])
    if SHARED_MODE:
        b1.download_button("Markdownをダウンロード", report_md, file_name=f"{a['isin']}_{a['as_of']}.md", mime="text/markdown", key="dl_fund_report")
    elif b1.button("Markdownで保存(銘柄分析/reports/)", key="save_fund_report"):
        path = write_fund_report(a)
        b2.success(f"保存しました: {path}")
    with st.expander("レポート全文を見る"):
        st.markdown(report_md)
    for note in a["data_notes"]:
        st.caption(f"・{note}")
