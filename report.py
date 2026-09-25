"""個別株分析の結果をMarkdownレポートにして 銘柄分析/reports/ に書き出す。

ダッシュボード(app.py)と cli.py の両方から使う。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from stock_analyzer.analysis import (
    fmt_big,
    fmt_market_cap,
    fmt_money,
    fmt_num,
    fmt_pct,
    fmt_x,
)

from stock_analyzer.config import REPORT_DIR  # noqa: E402


def _pct_or_na(value: float | None, decimals: int = 1) -> str:
    return fmt_pct(value * 100, decimals) if value is not None else "N/A"


def _money(value: float | None, currency: str, decimals: int = 1) -> str:
    return fmt_money(value, currency, decimals)


def build_stock_report_markdown(a: dict[str, Any]) -> str:
    cur = a["currency"]
    t = a["technicals"]
    r = a["ratios"]
    fs, ts = a["fundamental_score"], a["trend_score"]
    prof = a["profile"]
    lines: list[str] = []

    lines.append(f"# 銘柄分析 {a['name']}({a['ticker']}) {a['as_of']}")
    lines.append("")
    lines.append(
        f"- 株価: {_money(a['price'], cur)}(前日比 {fmt_pct(a['change_pct'], signed=True)}) / "
        f"時価総額 {fmt_market_cap(prof.get('market_cap'), cur)} / {prof.get('exchange') or '-'} / "
        f"{prof.get('sector') or '-'}・{prof.get('industry') or '-'}"
    )
    lines.append(
        f"- ファンダメンタルスコア: **{fs['total']}/100** / トレンド強度: **{ts['total']}/100** / "
        f"タイミング: **{a['timing']['label']}**({t['trend_label']})"
    )
    lines.append(f"- 総合所見: **{a['verdict']['label']}**")
    lines.append("")

    lines.append("## 💬 所見")
    lines.append(a["verdict"]["summary"])
    for act in a["verdict"]["actions"]:
        lines.append(f"- {act}")
    lines.append("")

    lines.append(f"## 📊 ファンダメンタルスコア {fs['total']}/100")
    lines.append("| カテゴリ | 項目 | 値 | 点数 | 補足 |")
    lines.append("|---|---|---|---|---|")
    for cat in fs["categories"]:
        for i, item in enumerate(cat["items"]):
            head = f"**{cat['name']} {cat['points']}/{cat['max']}**" if i == 0 else ""
            lines.append(f"| {head} | {item['item']} | {item['value']} | {item['points']}/{item['max']} | {item['comment']} |")
    lines.append("")

    lines.append(f"## 📈 業績推移(単位: {'百万円' if cur == 'JPY' else '百万' + cur}、EPS/配当は{'円' if cur == 'JPY' else cur})")
    if a["financials"]:
        lines.append("| 決算期 | 売上高 | 前年比 | 営業利益 | 営業利益率 | 純利益 | EPS | 1株配当 | 自己資本比率 | 営業CF | FCF | 期末株価 | PER | PBR |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for row in a["financials"]:
            lines.append(
                "| " + " | ".join(
                    [
                        row["label"],
                        fmt_big(row["revenue"], cur).replace("百万円", "").replace(f"百万{cur}", ""),
                        fmt_pct(row["revenue_yoy_pct"], signed=True),
                        fmt_big(row["operating_income"], cur).replace("百万円", "").replace(f"百万{cur}", ""),
                        _pct_or_na(row["op_margin"]),
                        fmt_big(row["net_income"], cur).replace("百万円", "").replace(f"百万{cur}", ""),
                        fmt_num(row["eps"], 2),
                        fmt_num(row.get("dps"), 2) if row.get("dps") is not None else "-",
                        _pct_or_na(row["equity_ratio"]),
                        fmt_big(row["ocf"], cur).replace("百万円", "").replace(f"百万{cur}", ""),
                        fmt_big(row["fcf"], cur).replace("百万円", "").replace(f"百万{cur}", ""),
                        fmt_num(row.get("price_at_period_end"), 1),
                        fmt_x(row.get("per")),
                        fmt_x(row.get("pbr"), 2),
                    ]
                ) + " |"
            )
    else:
        lines.append("財務諸表データなし。")
    lines.append("")

    lines.append("## 🔍 現在の主要指標")
    per_hist, pbr_hist = r.get("per_hist") or [], r.get("pbr_hist") or []
    per_range = f"{min(per_hist):.1f}〜{max(per_hist):.1f}倍" if per_hist else "N/A"
    pbr_range = f"{min(pbr_hist):.2f}〜{max(pbr_hist):.2f}倍" if pbr_hist else "N/A"
    lines.append("| 指標 | 現在 | 参考 |")
    lines.append("|---|---|---|")
    lines.append(f"| PER(実績) | {fmt_x(r.get('per'))} | 過去期末レンジ {per_range}(現在は下から{fmt_num(r.get('per_percentile'), 0)}%位置) |")
    lines.append(f"| PER(予想) | {fmt_x(r.get('forward_per'))} | アナリスト予想ベース(無い銘柄も多い) |")
    lines.append(f"| PBR | {fmt_x(r.get('pbr'), 2)} | 過去期末レンジ {pbr_range} |")
    lines.append(f"| PSR | {fmt_x(r.get('psr'), 2)} | 時価総額/売上高 |")
    lines.append(f"| EV/EBITDA | {fmt_x(r.get('ev_ebitda'))} | 10倍以下が割安の目安 |")
    lines.append(f"| ROE | {_pct_or_na(r.get('roe'))} | 10%以上が合格ライン |")
    lines.append(f"| ROA | {_pct_or_na(r.get('roa'))} | 5%以上で優良 |")
    lines.append(f"| 営業利益率 | {_pct_or_na(r.get('op_margin'))} | 業種により大きく異なる |")
    lines.append(f"| 純利益率 | {_pct_or_na(r.get('net_margin'))} | |")
    lines.append(f"| 自己資本比率 | {_pct_or_na(r.get('equity_ratio'))} | 40%以上で安定 |")
    lines.append(f"| ネットキャッシュ | {fmt_big(r.get('net_cash'), cur)} | 現金−有利子負債(プラスなら実質無借金) |")
    lines.append(f"| 純有利子負債/EBITDA | {fmt_x(r.get('net_debt_to_ebitda'))} | 2倍以下が健全 |")
    lines.append(f"| 流動比率 | {fmt_x(r.get('current_ratio'), 2)} | 1倍以上が目安 |")
    lines.append(f"| 配当利回り | {_pct_or_na(r.get('dividend_yield'), 2)} | 直近12ヶ月の配当 {fmt_num(r.get('dps_ttm'), 2)} |")
    lines.append(f"| 配当性向 | {_pct_or_na(r.get('payout_ratio'), 0)} | 30〜60%がバランス圏 |")
    lines.append(f"| 連続増配 | {r.get('dps_streak_years') or 0}期 | 決算期ごとの1株配当ベース |")
    lines.append(f"| ベータ | {fmt_num(r.get('beta'), 2)} | 1で市場並みの値動き |")
    lines.append(f"| インサイダー保有比率 | {_pct_or_na(r.get('insiders_pct'), 0)} | 高いほど浮動株が少ない |")
    if r.get("target_mean_price"):
        lines.append(f"| アナリスト目標株価(平均) | {_money(r['target_mean_price'], cur)} | {fmt_num(r.get('analyst_count'), 0)}人 |")
    lines.append("")

    lines.append("## 💰 適正株価の参考レンジ(断定ではなく複数の物差し)")
    if a["fair_value"]:
        lines.append("| 方法 | 株価 | 現在値比 | 備考 |")
        lines.append("|---|---|---|---|")
        for ref in a["fair_value"]:
            lines.append(f"| {ref['method']} | {_money(ref['value'], cur)} | {fmt_pct(ref['upside_pct'], signed=True)} | {ref['note']} |")
    else:
        lines.append("赤字・無配などで算出できる物差しがありません。")
    lines.append("")

    lines.append(f"## 📉 テクニカル(トレンド強度 {ts['total']}/100・{t['trend_label']})")
    lines.append("| 指標 | 値 |")
    lines.append("|---|---|")
    lines.append(f"| 現在値 | {_money(t['price'], cur)}(前日比 {fmt_pct(t['change_pct'], signed=True)}) |")
    for n in ("5", "25", "75", "200"):
        lines.append(f"| {n}日移動平均 | {fmt_num(t['ma'].get(n), 1)}(乖離 {fmt_pct(t['ma_dist_pct'].get(n), signed=True)}) |")
    lines.append(f"| 移動平均の配列 | {t['ma_alignment']} |")
    cross = t.get("cross_25_75")
    if cross:
        lines.append(f"| 25日/75日クロス | {'ゴールデンクロス' if cross['type'] == 'golden' else 'デッドクロス'}({cross['days_ago']}日前) |")
    lines.append(f"| RSI(14) | {fmt_num(t.get('rsi14'), 1)} |")
    macd_cross = t.get("macd_cross")
    macd_text = f"MACD {fmt_num(t.get('macd'), 2)} / シグナル {fmt_num(t.get('macd_signal'), 2)} / ヒストグラム {fmt_num(t.get('macd_hist'), 2)}"
    if macd_cross:
        macd_text += f"({'ゴールデンクロス' if macd_cross['type'] == 'golden' else 'デッドクロス'} {macd_cross['days_ago']}日前)"
    lines.append(f"| MACD(12,26,9) | {macd_text} |")
    bb = t["bb"]
    lines.append(
        f"| ボリンジャーバンド(20,2σ) | 上限 {fmt_num(bb.get('upper'), 1)} / 中央 {fmt_num(bb.get('mid'), 1)} / 下限 {fmt_num(bb.get('lower'), 1)} / %B {fmt_num(bb.get('pct_b'), 2)} |"
    )
    lines.append(f"| ATR(14) | {fmt_num(t.get('atr14'), 1)}({fmt_pct(t.get('atr_pct'))}/日) |")
    lines.append(
        f"| 52週高値/安値 | {fmt_num(t.get('high_52w'), 1)} / {fmt_num(t.get('low_52w'), 1)}"
        f"(高値から {fmt_pct(t.get('dist_from_52w_high_pct'), signed=True)}、安値から {fmt_pct(t.get('dist_from_52w_low_pct'), signed=True)}) |"
    )
    rp, bench = t["returns_pct"], t.get("benchmark") or {}
    bench_rp = bench.get("returns_pct") or {}
    lines.append(
        "| 期間リターン | " + " / ".join(f"{k} {fmt_pct(rp.get(k), signed=True)}" for k in ("1M", "3M", "6M", "1Y")) + " |"
    )
    if bench_rp:
        lines.append(
            f"| {bench.get('ticker')}のリターン | " + " / ".join(f"{k} {fmt_pct(bench_rp.get(k), signed=True)}" for k in ("1M", "3M", "6M", "1Y"))
            + f"(3ヶ月相対強度 {fmt_pct(t.get('relative_strength_3m_pct'), signed=True)}) |"
        )
    v = t["volume"]
    lines.append(
        f"| 出来高 | 直近 {fmt_num(v.get('last'))} / 20日平均 {fmt_num(v.get('avg20'))} / 60日平均 {fmt_num(v.get('avg60'))}"
        f"(20日/60日 {fmt_x(v.get('ratio_20_60'), 2)}) |"
    )
    lines.append(f"| 支持線 / 抵抗線(直近120日の転換点) | {fmt_num(t.get('support'), 1)} / {fmt_num(t.get('resistance'), 1)} |")
    lines.append("")
    lines.append("| トレンド採点項目 | 値 | 点数 | 補足 |")
    lines.append("|---|---|---|---|")
    for item in ts["items"]:
        lines.append(f"| {item['item']} | {item['value']} | {item['points']}/{item['max']} | {item['comment']} |")
    lines.append("")
    lines.append(f"タイミング判定: **{a['timing']['label']}** — {a['timing']['reason']}")
    lines.append("")

    lines.append("## ⚠️ リスク・要手動確認")
    if a["risk_flags"]:
        for flag in a["risk_flags"]:
            lines.append(f"- {flag}")
    else:
        lines.append("- 機械的に検出できる注意点はなし(業績の中身・競合・経営陣は必ず手動確認)")
    lines.append("")

    if a.get("position"):
        p = a["position"]
        lines.append("## 📌 保有ポジション")
        lines.append(f"- 株数: {fmt_num(p.get('shares'), 2)} / 取得単価: {_money(p.get('avg_cost'), cur)}")
        lines.append(
            f"- 評価額: {_money(p.get('current_value'), cur, 0)} / 含み損益: {_money(p.get('unrealized_pnl'), cur, 0)}"
            f"({fmt_pct(p.get('unrealized_pnl_pct'), signed=True)})"
        )
        if p.get("stop_2atr"):
            lines.append(f"- ATRベースの損切り目安: {fmt_num(p['stop_2atr'], 1)}(現在値−2ATR)")
        lines.append("")

    if prof.get("summary"):
        lines.append("## 🏢 事業概要(Yahoo Finance、英語)")
        lines.append(prof["summary"])
        lines.append("")

    lines.append("## 📝 データ注記・免責")
    for note in a["data_notes"]:
        lines.append(f"- {note}")
    lines.append("- このレポートは判断材料の整理であり、売買の推奨ではありません。最終判断は利用者自身が行ってください。")
    return "\n".join(lines) + "\n"


def write_stock_report(a: dict[str, Any]) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / f"{a['ticker']}_{a['as_of']}.md"
    path.write_text(build_stock_report_markdown(a), encoding="utf-8")
    return path
