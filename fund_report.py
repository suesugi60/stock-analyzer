"""投資信託の分析結果をMarkdownレポートにして 銘柄分析/reports/ に書き出す。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from stock_analyzer.config import REPORT_DIR
from stock_analyzer.fund_analysis import fmt_oku, fmt_pct, rakuten_yesno


def _rank_text(rank: tuple[int, int] | None) -> str:
    return f"{rank[0]}位/{rank[1]}本" if rank else "N/A"


def build_fund_report_markdown(a: dict[str, Any]) -> str:
    r, m, s, v = a["attrs"], a["metrics"], a["score"], a["verdict"]
    lines: list[str] = []
    lines.append(f"# ファンド分析 {a['name']}({a['isin']}) {a['as_of']}")
    lines.append("")
    lines.append(
        f"- 基準価額: {a['nav']:,.0f}円(前日比 {fmt_pct(a.get('change_pct'), 2, signed=True)}) / 純資産 {fmt_oku(r.get('net_assets_million'))} / "
        f"{r.get('company') or '-'} / {r.get('category') or '-'}"
    )
    lines.append(f"- 信託報酬: {fmt_pct(r.get('trust_reward_pct'), 3)}(年率・税抜) / 設定日 {r.get('established') or '-'} / 決算 年{r.get('settle_per_year') or '?'}回 / 償還 {r.get('redemption') or '-'}")
    general, ifa = rakuten_yesno(r)
    lines.append(
        f"- 楽天証券の取扱: 一般コース **{general}** ／ IFA専用 **{ifa}**(販売会社{r.get('sellers_count') or 0}社) / "
        f"NISA: {'つみたて投資枠○' if r.get('nisa_tsumitate') else 'つみたて投資枠×'}・{'成長投資枠○' if r.get('nisa_growth') else '成長投資枠×'}"
    )
    lines.append(f"- 総合スコア: **{s['total']}/100** / 総合所見: **{v['label']}**")
    lines.append("")
    lines.append("## 💬 所見")
    lines.append(v["summary"])
    for act in v["actions"]:
        lines.append(f"- {act}")
    lines.append("")
    lines.append(f"## 📊 スコア内訳 {s['total']}/100")
    lines.append("| カテゴリ | 項目 | 値 | 点数 | 補足 |")
    lines.append("|---|---|---|---|---|")
    for cat in s["categories"]:
        for i, item in enumerate(cat["items"]):
            head = f"**{cat['name']} {cat['points']}/{cat['max']}**" if i == 0 else ""
            lines.append(f"| {head} | {item['item']} | {item['value']} | {item['points']}/{item['max']} | {item['comment']} |")
    lines.append("")
    lines.append("## 📈 期間別リターン・リスク(投信協会データ、リターンは累積%)")
    lines.append("| 期間 | リターン | 年率換算 | 同分類内順位 | リスク(標準偏差) | シャープレシオ | シャープ順位 |")
    lines.append("|---|---|---|---|---|---|---|")
    for key, label, years in (("6m", "6ヶ月", 0.5), ("1y", "1年", 1), ("3y", "3年", 3), ("5y", "5年", 5), ("10y", "10年", 10)):
        ret = (r.get("returns_pct") or {}).get(key)
        if ret is None:
            continue
        ann = ((1 + ret / 100) ** (1 / years) - 1) * 100 if years >= 1 and ret > -100 else None
        lines.append(
            f"| {label} | {fmt_pct(ret, signed=True)} | {fmt_pct(ann, signed=True) if ann is not None else '-'} | {_rank_text((r.get('rank_return') or {}).get(key))} | "
            f"{fmt_pct((r.get('risk_pct') or {}).get(key))} | {((r.get('sharpe') or {}).get(key) or 0):.2f} | {_rank_text((r.get('rank_sharpe') or {}).get(key))} |"
        )
    lines.append("")
    if m.get("available"):
        lines.append("## 🧮 基準価額履歴からの計算値(分配金再投資ベース)")
        rp = m["returns_pct"]
        lines.append("| 指標 | 値 |")
        lines.append("|---|---|")
        lines.append("| 期間リターン(1M/3M/6M/1Y) | " + " / ".join(fmt_pct(rp.get(k), signed=True) for k in ("1M", "3M", "6M", "1Y")) + " |")
        lines.append(f"| 3年 / 5年(年率) | {fmt_pct(m['annualized_pct'].get('3Y'), signed=True)} / {fmt_pct(m['annualized_pct'].get('5Y'), signed=True)} |")
        lines.append(f"| 設定来 | 累積 {fmt_pct(m.get('since_inception_pct'), signed=True)}(年率 {fmt_pct(m['annualized_pct'].get('since_inception'), signed=True)}、運用{m['years_running']:.1f}年) |")
        lines.append(f"| 1年の変動率(年率標準偏差) | {fmt_pct(m.get('vol_1y_pct'))} |")
        lines.append(f"| シャープレシオ(1年、無リスク金利0) | {m['sharpe_1y']:.2f} |" if m.get("sharpe_1y") is not None else "| シャープレシオ(1年) | N/A |")
        lines.append(f"| 過去3年の最大下落率 | {fmt_pct(m.get('max_drawdown_3y_pct'))}(現在は高値から {fmt_pct(m.get('current_drawdown_pct'))}) |")
        lines.append(f"| 純資産(1年前比) | {fmt_oku(m.get('assets_million'))}({fmt_pct(m.get('assets_change_1y_pct'), signed=True)}) |")
        flow = (r.get("flow_million") or {})
        lines.append(f"| 資金流入(設定−解約) | 1ヶ月 {fmt_oku(flow.get('1m'))} / 3ヶ月 {fmt_oku(flow.get('3m'))} / 12ヶ月 {fmt_oku(flow.get('12m'))} |")
        lines.append(f"| 分配金(直近12ヶ月) | {m.get('dividend_12m', 0):,.0f}円(利回り {fmt_pct(m.get('dividend_yield_pct'), 2)}) |")
        lines.append("")
    lines.append("## ⚠️ リスク・要確認")
    if a["risk_flags"]:
        for flag in a["risk_flags"]:
            lines.append(f"- {flag}")
    else:
        lines.append("- 機械的に検出できる注意点はなし(投資対象の中身・為替ヘッジの有無は目論見書で確認)")
    lines.append("")
    lines.append("## 🔗 リンク")
    lines.append(f"- 楽天証券: {r.get('rakuten_url')}")
    lines.append(f"- 投信総合検索ライブラリー: {r.get('library_url')}")
    if r.get("report_url"):
        lines.append(f"- 運用会社の月次レポート: {r['report_url']}")
    lines.append("")
    lines.append("## 📝 データ注記・免責")
    for note in a["data_notes"]:
        lines.append(f"- {note}")
    lines.append("- このレポートは判断材料の整理であり、売買の推奨ではありません。最終判断は利用者自身が行ってください。")
    return "\n".join(lines) + "\n"


def write_fund_report(a: dict[str, Any]) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / f"{a['isin']}_{a['as_of']}.md"
    path.write_text(build_fund_report_markdown(a), encoding="utf-8")
    return path
