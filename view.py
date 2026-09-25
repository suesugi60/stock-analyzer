"""分析結果の表示(Altairチャート・表・バッジ)。app.py から呼ばれる。

計算は analysis.py、Markdown出力は report.py に任せ、ここは描画だけを担当する。
"""
from __future__ import annotations

from typing import Any

import altair as alt
import pandas as pd
import streamlit as st

from stock_analyzer.analysis import (
    fmt_market_cap,
    fmt_money,
    fmt_num,
    fmt_pct,
    fmt_x,
)
from stock_analyzer.config import SHARED_MODE
from stock_analyzer.report import build_stock_report_markdown, write_stock_report

# 系列色(固定順で割り当て、状態色とは分ける)
SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]
SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500"]
MUTED = "#898781"


def _series_colors(theme_type: str) -> list[str]:
    return SERIES_DARK if theme_type == "dark" else SERIES_LIGHT


def _pct(value: float | None, decimals: int = 1) -> str:
    return fmt_pct(value * 100, decimals) if value is not None else "N/A"


def _legend_top() -> alt.Legend:
    return alt.Legend(orient="top", title=None)


def _hover_layer(df: pd.DataFrame, tooltip: list[alt.Tooltip]) -> tuple[alt.Chart, alt.Chart]:
    """日付に最も近い点で縦線+ツールチップを出すホバー層。"""
    nearest = alt.selection_point(nearest=True, on="mouseover", fields=["日付"], empty=False)
    selectors = alt.Chart(df).mark_point().encode(x="日付:T", opacity=alt.value(0)).add_params(nearest)
    rule = alt.Chart(df).mark_rule(color=MUTED, strokeWidth=1).encode(x="日付:T", tooltip=tooltip).transform_filter(nearest)
    return selectors, rule


def _price_chart(series: dict[str, Any], colors: list[str], support: float | None, resistance: float | None) -> alt.LayerChart:
    df = pd.DataFrame(
        {
            "日付": pd.to_datetime(series["dates"]),
            "終値": series["close"],
            "25日線": series["ma25"],
            "75日線": series["ma75"],
            "200日線": series["ma200"],
            "BB上限": series["bb_upper"],
            "BB下限": series["bb_lower"],
        }
    )
    names = ["終値", "25日線", "75日線", "200日線"]
    band = (
        alt.Chart(df.dropna(subset=["BB上限", "BB下限"]))
        .mark_area(opacity=0.12, color=colors[0])
        .encode(x=alt.X("日付:T", title=None), y=alt.Y("BB下限:Q", scale=alt.Scale(zero=False), title=None), y2="BB上限:Q")
    )
    long = df.melt(id_vars=["日付"], value_vars=names, var_name="系列", value_name="値").dropna()
    lines = (
        alt.Chart(long)
        .mark_line()
        .encode(
            x=alt.X("日付:T", title=None),
            y=alt.Y("値:Q", scale=alt.Scale(zero=False), title=None),
            color=alt.Color("系列:N", scale=alt.Scale(domain=names, range=colors[:4]), legend=_legend_top()),
            strokeWidth=alt.condition("datum['系列'] === '終値'", alt.value(2.2), alt.value(1.3)),
        )
    )
    tooltip = [alt.Tooltip("日付:T")] + [alt.Tooltip(f"{n}:Q", format=",.1f") for n in names + ["BB上限", "BB下限"]]
    selectors, rule = _hover_layer(df, tooltip)
    layers = [band, lines, selectors, rule]
    for level, label in ((support, "支持線"), (resistance, "抵抗線")):
        if level:
            ref = pd.DataFrame({"値": [level], "ラベル": [f"{label} {level:,.1f}"]})
            layers.append(alt.Chart(ref).mark_rule(strokeDash=[5, 4], color=MUTED).encode(y="値:Q"))
            layers.append(
                alt.Chart(ref).mark_text(align="left", dx=4, dy=-6, color=MUTED, fontSize=11).encode(
                    y="値:Q", text="ラベル:N", x=alt.value(0)
                )
            )
    return alt.layer(*layers).properties(height=340, title="株価・移動平均・ボリンジャーバンド(直近250営業日)")


def _volume_chart(series: dict[str, Any]) -> alt.Chart:
    df = pd.DataFrame({"日付": pd.to_datetime(series["dates"]), "出来高": series["volume"]}).dropna()
    return (
        alt.Chart(df)
        .mark_bar(color=MUTED, opacity=0.7, cornerRadiusEnd=2)
        .encode(
            x=alt.X("日付:T", title=None),
            y=alt.Y("出来高:Q", title=None, axis=alt.Axis(format="~s")),
            tooltip=[alt.Tooltip("日付:T"), alt.Tooltip("出来高:Q", format=",.0f")],
        )
        .properties(height=90, title="出来高")
    )


def _rsi_chart(series: dict[str, Any], colors: list[str]) -> alt.LayerChart:
    df = pd.DataFrame({"日付": pd.to_datetime(series["dates"]), "RSI": series["rsi"]}).dropna()
    line = alt.Chart(df).mark_line(color=colors[0], strokeWidth=1.6).encode(
        x=alt.X("日付:T", title=None), y=alt.Y("RSI:Q", scale=alt.Scale(domain=[0, 100]), title=None)
    )
    refs = alt.Chart(pd.DataFrame({"y": [30, 70]})).mark_rule(strokeDash=[4, 4], color=MUTED).encode(y="y:Q")
    selectors, rule = _hover_layer(df, [alt.Tooltip("日付:T"), alt.Tooltip("RSI:Q", format=".1f")])
    return alt.layer(refs, line, selectors, rule).properties(height=120, title="RSI(14) — 70超は過熱・30未満は売られすぎ")


def _macd_chart(series: dict[str, Any], colors: list[str]) -> alt.LayerChart:
    df = pd.DataFrame(
        {
            "日付": pd.to_datetime(series["dates"]),
            "MACD": series["macd"],
            "シグナル": series["macd_signal"],
            "ヒストグラム": series["macd_hist"],
        }
    ).dropna()
    hist = alt.Chart(df).mark_bar(color=MUTED, opacity=0.6).encode(x=alt.X("日付:T", title=None), y=alt.Y("ヒストグラム:Q", title=None))
    long = df.melt(id_vars=["日付"], value_vars=["MACD", "シグナル"], var_name="系列", value_name="値")
    lines = alt.Chart(long).mark_line(strokeWidth=1.6).encode(
        x="日付:T",
        y=alt.Y("値:Q", title=None),
        color=alt.Color("系列:N", scale=alt.Scale(domain=["MACD", "シグナル"], range=colors[:2]), legend=_legend_top()),
    )
    tooltip = [alt.Tooltip("日付:T")] + [alt.Tooltip(f"{n}:Q", format=",.2f") for n in ("MACD", "シグナル", "ヒストグラム")]
    selectors, rule = _hover_layer(df, tooltip)
    return alt.layer(hist, lines, selectors, rule).properties(height=140, title="MACD(12,26,9)")


def _grouped_bars(rows: list[dict[str, Any]], fields: dict[str, str], colors: list[str], title: str, divisor: float, unit: str) -> alt.Chart:
    records = []
    for row in rows:
        for label, key in fields.items():
            value = row.get(key)
            if value is not None:
                records.append({"決算期": row["label"], "系列": label, "値": value / divisor})
    df = pd.DataFrame(records)
    if df.empty:
        return alt.Chart(pd.DataFrame({"x": []})).mark_point()
    names = list(fields.keys())
    return (
        alt.Chart(df)
        .mark_bar(cornerRadiusEnd=3)
        .encode(
            x=alt.X("決算期:N", title=None, sort=None),
            xOffset=alt.XOffset("系列:N", sort=names),
            y=alt.Y("値:Q", title=unit),
            color=alt.Color("系列:N", scale=alt.Scale(domain=names, range=colors[: len(names)]), legend=_legend_top()),
            tooltip=[alt.Tooltip("決算期:N"), alt.Tooltip("系列:N"), alt.Tooltip("値:Q", format=",.1f")],
        )
        .properties(height=220, title=title)
    )


def _single_bars(rows: list[dict[str, Any]], key: str, color: str, title: str, fmt: str = ",.2f") -> alt.Chart:
    df = pd.DataFrame([{"決算期": r["label"], "値": r.get(key)} for r in rows]).dropna()
    if df.empty:
        return alt.Chart(pd.DataFrame({"x": []})).mark_point()
    return (
        alt.Chart(df)
        .mark_bar(color=color, cornerRadiusEnd=3, size=26)
        .encode(
            x=alt.X("決算期:N", title=None, sort=None),
            y=alt.Y("値:Q", title=None),
            tooltip=[alt.Tooltip("決算期:N"), alt.Tooltip("値:Q", format=fmt)],
        )
        .properties(height=200, title=title)
    )


def _ratio_lines(rows: list[dict[str, Any]], colors: list[str]) -> alt.Chart:
    records = []
    for row in rows:
        for label, key in (("営業利益率", "op_margin"), ("自己資本比率", "equity_ratio"), ("ROE", "roe")):
            if row.get(key) is not None:
                records.append({"決算期": row["label"], "系列": label, "値": row[key] * 100})
    df = pd.DataFrame(records)
    if df.empty:
        return alt.Chart(pd.DataFrame({"x": []})).mark_point()
    names = ["営業利益率", "自己資本比率", "ROE"]
    return (
        alt.Chart(df)
        .mark_line(point=alt.OverlayMarkDef(size=60), strokeWidth=2)
        .encode(
            x=alt.X("決算期:N", title=None, sort=None),
            y=alt.Y("値:Q", title="%"),
            color=alt.Color("系列:N", scale=alt.Scale(domain=names, range=colors[:3]), legend=_legend_top()),
            tooltip=[alt.Tooltip("決算期:N"), alt.Tooltip("系列:N"), alt.Tooltip("値:Q", format=".1f")],
        )
        .properties(height=200, title="利益率・自己資本比率・ROE(%)")
    )


def _score_bars(categories: list[dict[str, Any]], color: str) -> alt.LayerChart:
    df = pd.DataFrame(
        [{"カテゴリ": c["name"], "点数": c["points"], "満点": c["max"], "表示": f"{c['points']}/{c['max']}"} for c in categories]
    )
    base = alt.Chart(df).encode(y=alt.Y("カテゴリ:N", sort=None, title=None))
    bg = base.mark_bar(color=MUTED, opacity=0.18, size=18, cornerRadiusEnd=4).encode(x=alt.X("満点:Q", title=None, axis=None))
    fg = base.mark_bar(color=color, size=18, cornerRadiusEnd=4).encode(x="点数:Q", tooltip=[alt.Tooltip("カテゴリ:N"), alt.Tooltip("表示:N")])
    text = base.mark_text(align="left", dx=6, color=MUTED, fontSize=12).encode(x="満点:Q", text="表示:N")
    return alt.layer(bg, fg, text).properties(height=34 * len(df) + 10)


def _items_table(items: list[dict[str, Any]]) -> pd.DataFrame:
    return pd.DataFrame(
        [{"項目": i["item"], "値": i["value"], "点数": f"{i['points']}/{i['max']}", "補足": i["comment"]} for i in items]
    )


STATUS_COLORS = {"good": "#0ca30c", "warning": "#fab219", "serious": "#ec835a", "critical": "#d03b3b"}


def badge(text: str, level: str) -> str:
    color = STATUS_COLORS.get(level, MUTED)
    return (
        f'<span style="background-color:{color};color:#fff;padding:2px 10px;border-radius:12px;'
        f'font-size:0.85em;font-weight:600;display:inline-block">{text}</span>'
    )


def zebra_style(df: pd.DataFrame):
    """テーブルの行を一行おきに薄い背景色にして視認性を上げる。"""
    return df.style.apply(
        lambda row: ["background-color: rgba(128,128,128,0.07)" if row.name % 2 else "" for _ in row], axis=1
    )


def render_analysis(a: dict[str, Any], theme_type: str | None) -> None:
    """analyze_stock() の結果を1画面に描画する。"""
    colors = _series_colors(theme_type)
    cur, t, r, prof = a["currency"], a["technicals"], a["ratios"], a["profile"]
    fs, ts, timing, verdict = a["fundamental_score"], a["trend_score"], a["timing"], a["verdict"]

    # ---- ヘッダー ----
    st.subheader(f"{a['name']}({a['ticker']})")
    st.caption(
        f"{prof.get('exchange') or '-'} / {prof.get('sector') or '-'}・{prof.get('industry') or '-'} / "
        f"時価総額 {fmt_market_cap(prof.get('market_cap'), cur)} / 株価データ {a['as_of']} 時点"
    )
    m1, m2, m3, m4, m5 = st.columns(5)
    m1.metric("株価", fmt_money(a["price"], cur), fmt_pct(a["change_pct"], signed=True))
    m2.metric("ファンダメンタル", "対象外" if a.get("is_fund") else f"{fs['total']}/100")
    m3.metric("トレンド強度", f"{ts['total']}/100", t["trend_label"], delta_color="off")
    m4.markdown("**タイミング**")
    m4.markdown(badge(timing["label"], timing["level"]), unsafe_allow_html=True)
    m5.markdown("**総合所見**")
    m5.markdown(badge(verdict["label"], verdict["level"]), unsafe_allow_html=True)

    st.markdown(f"**{verdict['summary']}**")
    for act in verdict["actions"]:
        st.markdown(f"- {act}")
    st.caption(f"タイミング判定の根拠: {timing['reason']}")

    # ---- スコア内訳 ----
    st.subheader("📊 スコア内訳")
    s1, s2 = st.columns(2)
    with s1:
        st.markdown(f"**ファンダメンタル {fs['total']}/100**" + ("(ETF・投信は対象外)" if a.get("is_fund") else ""))
        st.altair_chart(_score_bars(fs["categories"], colors[0]), use_container_width=True)
        with st.expander("採点の詳細(ファンダメンタル)"):
            for cat in fs["categories"]:
                st.markdown(f"**{cat['name']} {cat['points']}/{cat['max']}**")
                st.dataframe(_items_table(cat["items"]), use_container_width=True, hide_index=True)
    with s2:
        st.markdown(f"**トレンド強度 {ts['total']}/100**(高いほど上昇トレンドが強い)")
        st.progress(min(max(ts["total"], 0), 100) / 100)
        with st.expander("採点の詳細(テクニカル)", expanded=True):
            st.dataframe(_items_table(ts["items"]), use_container_width=True, hide_index=True)

    # ---- 業績推移 ----
    rows = a["financials"]
    if rows and not a.get("is_fund"):
        unit = "百万円" if cur == "JPY" else f"百万{cur}"
        st.subheader("📈 業績推移(年次決算)")
        g1, g2 = st.columns(2)
        g1.altair_chart(
            _grouped_bars(rows, {"売上高": "revenue", "営業利益": "operating_income", "純利益": "net_income"}, colors, f"売上高・営業利益・純利益({unit})", 1e6, unit),
            use_container_width=True,
        )
        g2.altair_chart(
            _grouped_bars(rows, {"営業CF": "ocf", "フリーCF": "fcf"}, colors, f"営業キャッシュフロー・フリーCF({unit})", 1e6, unit),
            use_container_width=True,
        )
        g3, g4, g5 = st.columns(3)
        g3.altair_chart(_single_bars(rows, "eps", colors[0], f"1株利益 EPS({'円' if cur == 'JPY' else cur})"), use_container_width=True)
        g4.altair_chart(_single_bars(rows, "dps", colors[1], f"1株配当 DPS({'円' if cur == 'JPY' else cur})"), use_container_width=True)
        g5.altair_chart(_ratio_lines(rows, colors), use_container_width=True)
        with st.expander("財務データを表で見る"):
            table = pd.DataFrame(
                [
                    {
                        "決算期": row["label"],
                        f"売上高({unit})": row["revenue"] / 1e6 if row.get("revenue") is not None else None,
                        "前年比": row.get("revenue_yoy_pct"),
                        f"営業利益({unit})": row["operating_income"] / 1e6 if row.get("operating_income") is not None else None,
                        "営業利益率": row["op_margin"] * 100 if row.get("op_margin") is not None else None,
                        f"純利益({unit})": row["net_income"] / 1e6 if row.get("net_income") is not None else None,
                        "EPS": row.get("eps"),
                        "1株配当": row.get("dps"),
                        "自己資本比率": row["equity_ratio"] * 100 if row.get("equity_ratio") is not None else None,
                        f"営業CF({unit})": row["ocf"] / 1e6 if row.get("ocf") is not None else None,
                        f"FCF({unit})": row["fcf"] / 1e6 if row.get("fcf") is not None else None,
                        "期末株価": row.get("price_at_period_end"),
                        "期末PER": row.get("per"),
                        "期末PBR": row.get("pbr"),
                    }
                    for row in rows
                ]
            )
            st.dataframe(
                zebra_style(table),
                use_container_width=True,
                hide_index=True,
                column_config={
                    "前年比": st.column_config.NumberColumn(format="%+.1f%%"),
                    "営業利益率": st.column_config.NumberColumn(format="%.1f%%"),
                    "自己資本比率": st.column_config.NumberColumn(format="%.1f%%"),
                    "期末PER": st.column_config.NumberColumn(format="%.1f倍"),
                    "期末PBR": st.column_config.NumberColumn(format="%.2f倍"),
                },
            )

    # ---- 主要指標・適正株価 ----
    if not a.get("is_fund"):
        st.subheader("🔍 現在の主要指標と適正株価の参考")
        k1, k2 = st.columns([3, 2])
        per_hist, pbr_hist = r.get("per_hist") or [], r.get("pbr_hist") or []
        indicators = pd.DataFrame(
            [
                {"指標": "PER(実績)", "値": fmt_x(r.get("per")), "参考": f"過去期末 {min(per_hist):.1f}〜{max(per_hist):.1f}倍" if per_hist else "過去データなし"},
                {"指標": "PER(予想)", "値": fmt_x(r.get("forward_per")), "参考": "アナリスト予想(無い銘柄も多い)"},
                {"指標": "PBR", "値": fmt_x(r.get("pbr"), 2), "参考": f"過去期末 {min(pbr_hist):.2f}〜{max(pbr_hist):.2f}倍" if pbr_hist else "過去データなし"},
                {"指標": "EV/EBITDA", "値": fmt_x(r.get("ev_ebitda")), "参考": "10倍以下が割安の目安"},
                {"指標": "PSR", "値": fmt_x(r.get("psr"), 2), "参考": "時価総額/売上高"},
                {"指標": "ROE", "値": _pct(r.get("roe")), "参考": "10%以上が合格ライン"},
                {"指標": "ROA", "値": _pct(r.get("roa")), "参考": "5%以上で優良"},
                {"指標": "営業利益率", "値": _pct(r.get("op_margin")), "参考": "業種差が大きい"},
                {"指標": "自己資本比率", "値": _pct(r.get("equity_ratio")), "参考": "40%以上で安定"},
                {"指標": "ネットキャッシュ", "値": fmt_market_cap(r.get("net_cash"), cur) if r.get("net_cash") is not None else "N/A", "参考": "現金−有利子負債"},
                {"指標": "純有利子負債/EBITDA", "値": fmt_x(r.get("net_debt_to_ebitda")), "参考": "2倍以下が健全"},
                {"指標": "流動比率", "値": fmt_x(r.get("current_ratio"), 2), "参考": "1倍以上が目安"},
                {"指標": "配当利回り", "値": _pct(r.get("dividend_yield"), 2), "参考": f"直近12ヶ月配当 {fmt_num(r.get('dps_ttm'), 2)}"},
                {"指標": "配当性向", "値": _pct(r.get("payout_ratio"), 0), "参考": "30〜60%がバランス圏"},
                {"指標": "連続増配", "値": f"{r.get('dps_streak_years') or 0}期", "参考": "決算期ごとのDPSベース"},
                {"指標": "ベータ", "値": fmt_num(r.get("beta"), 2), "参考": "1で市場並みの値動き"},
                {"指標": "インサイダー保有比率", "値": _pct(r.get("insiders_pct"), 0), "参考": "高いほど浮動株が少ない"},
            ]
        )
        k1.dataframe(zebra_style(indicators), use_container_width=True, hide_index=True, height=640)
        with k2:
            st.markdown("**適正株価の参考レンジ**(複数の単純な物差し。断定ではない)")
            if a["fair_value"]:
                fair = pd.DataFrame(
                    [{"方法": f["method"], "株価": fmt_money(f["value"], cur), "現在値比": fmt_pct(f["upside_pct"], signed=True), "備考": f["note"]} for f in a["fair_value"]]
                )
                st.dataframe(fair, use_container_width=True, hide_index=True)
            else:
                st.caption("赤字・無配などで算出できる物差しがありません。")
            if r.get("target_mean_price"):
                st.caption(f"アナリスト目標株価(平均): {fmt_money(r['target_mean_price'], cur)}({fmt_num(r.get('analyst_count'), 0)}人)")

    # ---- テクニカル ----
    st.subheader(f"📉 テクニカル({t['trend_label']}・{t['ma_alignment']})")
    series = t["series"]
    st.altair_chart(_price_chart(series, colors, t.get("support"), t.get("resistance")), use_container_width=True)
    st.altair_chart(_volume_chart(series), use_container_width=True)
    r1, r2 = st.columns(2)
    r1.altair_chart(_rsi_chart(series, colors), use_container_width=True)
    r2.altair_chart(_macd_chart(series, colors), use_container_width=True)

    cross = t.get("cross_25_75")
    macd_cross = t.get("macd_cross")
    rp, bench = t["returns_pct"], t.get("benchmark") or {}
    bench_rp = bench.get("returns_pct") or {}
    tech_rows = [
        {"指標": "現在値", "値": f"{fmt_money(t['price'], cur)}(前日比 {fmt_pct(t['change_pct'], signed=True)})"},
        {"指標": "移動平均(5/25/75/200日)", "値": " / ".join(f"{fmt_num(t['ma'].get(n), 1)}({fmt_pct(t['ma_dist_pct'].get(n), signed=True)})" for n in ("5", "25", "75", "200"))},
        {"指標": "25日/75日クロス", "値": (f"{'ゴールデンクロス' if cross['type'] == 'golden' else 'デッドクロス'}({cross['days_ago']}日前)" if cross else "直近20日以内になし")},
        {"指標": "RSI(14)", "値": fmt_num(t.get("rsi14"), 1)},
        {"指標": "MACD / シグナル", "値": f"{fmt_num(t.get('macd'), 2)} / {fmt_num(t.get('macd_signal'), 2)}" + (f"({'ゴールデンクロス' if macd_cross['type'] == 'golden' else 'デッドクロス'} {macd_cross['days_ago']}日前)" if macd_cross else "")},
        {"指標": "ボリンジャー%B(0=下限・1=上限)", "値": fmt_num(t["bb"].get("pct_b"), 2)},
        {"指標": "ATR(14)", "値": f"{fmt_num(t.get('atr14'), 1)}({fmt_pct(t.get('atr_pct'))}/日)"},
        {"指標": "52週高値 / 安値", "値": f"{fmt_num(t.get('high_52w'), 1)} / {fmt_num(t.get('low_52w'), 1)}(高値から {fmt_pct(t.get('dist_from_52w_high_pct'), signed=True)})"},
        {"指標": "期間リターン(1M/3M/6M/1Y)", "値": " / ".join(fmt_pct(rp.get(k), signed=True) for k in ("1M", "3M", "6M", "1Y"))},
        {"指標": f"{bench.get('ticker') or '指数'}(同期間)", "値": " / ".join(fmt_pct(bench_rp.get(k), signed=True) for k in ("1M", "3M", "6M", "1Y")) + f"(3M相対強度 {fmt_pct(t.get('relative_strength_3m_pct'), signed=True)})"},
        {"指標": "出来高(直近 / 20日平均 / 60日平均)", "値": f"{fmt_num(t['volume'].get('last'))} / {fmt_num(t['volume'].get('avg20'))} / {fmt_num(t['volume'].get('avg60'))}"},
        {"指標": "支持線 / 抵抗線(直近120日の転換点)", "値": f"{fmt_num(t.get('support'), 1)} / {fmt_num(t.get('resistance'), 1)}"},
    ]
    st.dataframe(zebra_style(pd.DataFrame(tech_rows)), use_container_width=True, hide_index=True)

    # ---- リスク・ポジション ----
    st.subheader("⚠️ リスク・要手動確認")
    if a["risk_flags"]:
        for flag in a["risk_flags"]:
            st.markdown(f"- {flag}")
    else:
        st.markdown("- 機械的に検出できる注意点はなし(業績の中身・競合・経営陣は必ず手動確認)")

    if a.get("position"):
        p = a["position"]
        st.subheader("📌 保有ポジション")
        p1, p2, p3, p4 = st.columns(4)
        p1.metric("株数", fmt_num(p.get("shares"), 2))
        p2.metric("取得単価", fmt_money(p.get("avg_cost"), cur, 1) if p.get("avg_cost") else "N/A")
        p3.metric(
            "含み損益",
            fmt_money(p.get("unrealized_pnl"), cur, 0) if p.get("unrealized_pnl") is not None else "N/A",
            fmt_pct(p.get("unrealized_pnl_pct"), signed=True) if p.get("unrealized_pnl_pct") is not None else None,
        )
        p4.metric("損切り目安(現在値−2ATR)", fmt_num(p.get("stop_2atr"), 1))

    # ---- レポート保存 ----
    st.subheader("📄 レポート")
    report_md = build_stock_report_markdown(a)
    b1, b2 = st.columns([1, 3])
    if SHARED_MODE:
        b1.download_button("Markdownをダウンロード", report_md, file_name=f"{a['ticker']}_{a['as_of']}.md", mime="text/markdown")
    elif b1.button("Markdownで保存(銘柄分析/reports/)"):
        path = write_stock_report(a)
        b2.success(f"保存しました: {path}")
    with st.expander("レポート全文を見る"):
        st.markdown(report_md)
    for note in a["data_notes"]:
        st.caption(f"・{note}")


# ------------------------------------------------------------
# Q&A: 分析結果について、このシステム内で質問できる
# ------------------------------------------------------------
QUICK_QUESTIONS = ["スコアの根拠を教えて", "一番のリスクは？", "初心者向けに3行で要約して", "買うならどんな条件を確認すべき？"]


def _quick_question_callback(widget_key: str, pending_key: str) -> None:
    value = st.session_state.get(widget_key)
    if value:
        st.session_state[pending_key] = value
        st.session_state[widget_key] = None


def render_qa(context_md: str, subject_key: str, subject_name: str) -> None:
    """分析結果(Markdown)を文脈にした質問欄。会話は銘柄ごとにセッション内で保持し、ログはファイルに残す。"""
    from stock_analyzer.assistant import ask, available_backend, setup_hint

    st.subheader("💬 この銘柄について質問する")
    user_key = st.session_state.get("user_api_key") or None
    backend = available_backend(user_key)
    if backend is None:
        if SHARED_MODE:
            st.caption("質問機能を使うには Anthropic のAPIキーが必要です(このブラウザのセッション内でのみ使い、保存しません)。")
            typed_key = st.text_input("Anthropic APIキー(sk-ant-...)", type="password", key="user_api_key_input")
            if typed_key:
                st.session_state["user_api_key"] = typed_key.strip()
                st.rerun()
        else:
            st.info(setup_hint())
        return
    st.caption(
        "用語の意味・スコアの根拠・リスクの見方など、分からない点をそのまま聞けます"
        + ("(Anthropic APIで回答)。" if SHARED_MODE else f"({'Anthropic API' if backend == 'api' else 'Claude Code CLI'}で回答。ログは 銘柄分析/質問ログ/ に保存)。")
    )
    key = f"qa_{subject_key}"
    history: list[dict[str, str]] = st.session_state.setdefault(key, [])
    for turn in history:
        with st.chat_message("user" if turn["role"] == "user" else "assistant"):
            st.markdown(turn["content"])
    st.pills("よくある質問", QUICK_QUESTIONS, key=f"{key}_quick", on_change=_quick_question_callback, args=(f"{key}_quick", f"{key}_pending"))
    typed = st.chat_input("質問を入力(例: PBRって何？ / 財務健全性が低いのはなぜ？ / この信託報酬は高い？)", key=f"{key}_input")
    question = typed or st.session_state.pop(f"{key}_pending", None)
    if not question:
        return
    with st.chat_message("user"):
        st.markdown(question)
    with st.chat_message("assistant"):
        with st.spinner("分析データを読んで回答を作成中(10〜60秒)..."):
            result = ask(question, context_md, history, subject=subject_name, api_key=user_key)
        st.markdown(result["answer"])
    history.append({"role": "user", "content": question})
    history.append({"role": "assistant", "content": result["answer"]})
