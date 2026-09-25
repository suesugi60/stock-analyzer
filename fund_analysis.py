"""投資信託の分析エンジン: コスト・規模/資金流入・リターン・リスク効率・継続性を採点し、総合所見を出す。

データは funds.py(投信総合検索ライブラリー)。株式の analysis.py と同じく「判断材料の整理」に徹し、
売買の推奨はしない。楽天証券での取扱有無は販売会社一覧から判定する。
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from stock_analyzer.funds import get_fund_history, get_fund_row

TRADING_DAYS = 245


def _f(value: Any) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(x) or math.isinf(x)) else x


def fmt_pct(value: float | None, decimals: int = 1, signed: bool = False) -> str:
    if value is None:
        return "N/A"
    return f"{value:+.{decimals}f}%" if signed else f"{value:.{decimals}f}%"


def fmt_oku(million: float | None) -> str:
    """百万円 → 億円/兆円表示。"""
    if million is None:
        return "N/A"
    if abs(million) >= 1_000_000:
        return f"{million / 1_000_000:,.2f}兆円"
    return f"{million / 100:,.0f}億円"


def _item(name: str, value: str, points: int, max_points: int, comment: str = "") -> dict[str, Any]:
    return {"item": name, "value": value, "points": points, "max": max_points, "comment": comment}


def _category(name: str, items: list[dict[str, Any]], max_points: int) -> dict[str, Any]:
    return {"name": name, "points": min(sum(i["points"] for i in items), max_points), "max": max_points, "items": items}


def _tier_ge(value: float | None, tiers: list[tuple[float, int]]) -> int:
    if value is None:
        return 0
    for threshold, points in tiers:
        if value >= threshold:
            return points
    return 0


def _tier_le(value: float | None, tiers: list[tuple[float, int]]) -> int:
    if value is None:
        return 0
    for threshold, points in tiers:
        if value <= threshold:
            return points
    return 0


def _annualize(cum_pct: float | None, years: float) -> float | None:
    if cum_pct is None or years <= 0 or cum_pct <= -100:
        return None
    return ((1 + cum_pct / 100) ** (1 / years) - 1) * 100


def _rank_pct(rank: tuple[int, int] | None) -> float | None:
    """順位 → 上位何%か(小さいほど良い)。"""
    if not rank or rank[1] <= 0:
        return None
    return rank[0] / rank[1] * 100


# ------------------------------------------------------------
# 基準価額履歴からの計算
# ------------------------------------------------------------
def compute_fund_metrics(hist: dict[str, Any] | None) -> dict[str, Any]:
    if not hist or len(hist.get("nav") or []) < 20:
        return {"available": False}
    df = pd.DataFrame({"date": pd.to_datetime(hist["dates"]), "nav": hist["nav"], "assets": hist["net_assets_million"]})
    df["nav"] = pd.to_numeric(df["nav"], errors="coerce")
    df["assets"] = pd.to_numeric(df["assets"], errors="coerce")
    df = df.dropna(subset=["nav"]).drop_duplicates("date").sort_values("date").reset_index(drop=True)
    div_map = {pd.Timestamp(d["date"]): float(d["amount"]) for d in hist.get("dividends") or []}
    # 分配金再投資ベースの指数(トータルリターン): TR_t = TR_{t-1} × (nav_t + div_t) / nav_{t-1}
    tr = [1.0]
    navs = df["nav"].values
    dates = df["date"].values
    for i in range(1, len(df)):
        div = div_map.get(pd.Timestamp(dates[i]), 0.0)
        tr.append(tr[-1] * (navs[i] + div) / navs[i - 1] if navs[i - 1] else tr[-1])
    df["tr"] = tr
    last_date = df["date"].iloc[-1]
    last_tr = df["tr"].iloc[-1]

    def ret_since(offset: pd.DateOffset) -> float | None:
        target = last_date - offset
        idx = df["date"].searchsorted(target, side="right") - 1
        if idx < 0 or (target - df["date"].iloc[0]).days < -7:
            return None
        base = df["tr"].iloc[idx]
        return (last_tr / base - 1) * 100 if base else None

    returns = {
        "1M": ret_since(pd.DateOffset(months=1)),
        "3M": ret_since(pd.DateOffset(months=3)),
        "6M": ret_since(pd.DateOffset(months=6)),
        "1Y": ret_since(pd.DateOffset(years=1)),
        "3Y": ret_since(pd.DateOffset(years=3)),
        "5Y": ret_since(pd.DateOffset(years=5)),
        "10Y": ret_since(pd.DateOffset(years=10)),
    }
    years_running = (last_date - df["date"].iloc[0]).days / 365.25
    since_inception = (last_tr - 1) * 100
    annualized = {
        "3Y": _annualize(returns["3Y"], 3),
        "5Y": _annualize(returns["5Y"], 5),
        "10Y": _annualize(returns["10Y"], 10),
        "since_inception": _annualize(since_inception, years_running) if years_running >= 1 else None,
    }
    one_year = df[df["date"] > last_date - pd.DateOffset(years=1)]
    daily = np.log(one_year["tr"]).diff().dropna()
    vol_1y = float(daily.std(ddof=1) * math.sqrt(TRADING_DAYS) * 100) if len(daily) > 30 else None
    sharpe_1y = (returns["1Y"] / vol_1y) if returns["1Y"] is not None and vol_1y else None
    three_years = df[df["date"] > last_date - pd.DateOffset(years=3)]
    running_max = three_years["tr"].cummax()
    dd = (three_years["tr"] / running_max - 1) * 100
    max_dd_3y = float(dd.min()) if len(dd) else None
    # 直近1年の最大下落からの回復状況
    current_dd = float((last_tr / df["tr"].cummax().iloc[-1] - 1) * 100)

    assets_now = _f(df["assets"].iloc[-1])
    idx_1y = df["date"].searchsorted(last_date - pd.DateOffset(years=1), side="right") - 1
    assets_1y = _f(df["assets"].iloc[idx_1y]) if idx_1y >= 0 else None
    assets_change_1y_pct = ((assets_now / assets_1y - 1) * 100) if assets_now and assets_1y else None
    # 推定純流入(百万円): Δ純資産 − 価格変動による増減、直近12ヶ月
    flow_12m = None
    if len(one_year) > 2 and one_year["assets"].notna().all():
        a = one_year["assets"].values
        n = one_year["nav"].values
        flow_12m = float(sum(a[i] - a[i - 1] * (n[i] / n[i - 1]) for i in range(1, len(a)) if n[i - 1]))

    div_12m = sum(v for d, v in div_map.items() if d > last_date - pd.DateOffset(years=1))
    nav_now = float(df["nav"].iloc[-1])
    chart = df if len(df) <= 1600 else df.iloc[:: max(1, len(df) // 1600)]
    return {
        "available": True,
        "as_of": last_date.strftime("%Y-%m-%d"),
        "nav": nav_now,
        "returns_pct": returns,
        "annualized_pct": annualized,
        "since_inception_pct": since_inception,
        "years_running": years_running,
        "vol_1y_pct": vol_1y,
        "sharpe_1y": sharpe_1y,
        "max_drawdown_3y_pct": max_dd_3y,
        "current_drawdown_pct": current_dd,
        "assets_million": assets_now,
        "assets_change_1y_pct": assets_change_1y_pct,
        "flow_12m_million_est": flow_12m,
        "dividend_12m": div_12m,
        "dividend_yield_pct": (div_12m / nav_now * 100) if nav_now else None,
        "series": {
            "dates": [d.strftime("%Y-%m-%d") for d in chart["date"]],
            "nav": [round(float(v), 2) for v in chart["nav"]],
            "tr_index": [round(float(v) * navs[0], 2) for v in chart["tr"]],  # 設定時の基準価額を起点にした再投資ベース
            "assets_million": [None if pd.isna(v) else round(float(v), 1) for v in chart["assets"]],
        },
    }


# ------------------------------------------------------------
# 採点・所見
# ------------------------------------------------------------
def score_fund(row: dict[str, Any], m: dict[str, Any]) -> dict[str, Any]:
    cats: list[dict[str, Any]] = []

    # --- コスト(25) ---
    cost = row.get("trust_reward_pct")
    buy_fee = row.get("buy_fee_pct") or 0
    cost_points = _tier_le(cost, [(0.1, 25), (0.2, 22), (0.5, 16), (1.0, 8), (1.5, 4)])
    items = [_item("信託報酬(年率・税抜)", fmt_pct(cost, 3), cost_points, 25, "0.1%以下で満点。1%超は長期の複利を大きく削る")]
    if buy_fee > 0:
        items.append(_item("購入時手数料", fmt_pct(buy_fee, 2), -3, 0, "ノーロード(0%)が望ましい"))
    cats.append(_category("コスト", items, 25))

    # --- 規模・資金流入(20) ---
    assets = row.get("net_assets_million") or m.get("assets_million")
    size_points = _tier_ge(assets, [(1_000_000, 10), (100_000, 9), (10_000, 7), (3_000, 4), (1_000, 2)])
    flow = (row.get("flow_million") or {}).get("12m")
    flow_source = "投信協会(設定−解約)"
    if flow is None:
        flow = m.get("flow_12m_million_est")
        flow_source = "推定(純資産変化−価格要因)"
    if flow is not None and assets:
        flow_ratio = flow / assets * 100
        flow_points = 10 if flow_ratio >= 10 else (6 if flow > 0 else (3 if flow_ratio >= -5 else 0))
        flow_text = f"{fmt_oku(flow)}({flow_ratio:+.0f}% of 純資産、{flow_source})"
    else:
        flow_points, flow_text = 0, "N/A"
    cats.append(
        _category(
            "規模・資金流入",
            [
                _item("純資産総額", fmt_oku(assets), size_points, 10, "100億円以上で安定、30億円未満は繰上償還リスク"),
                _item("直近12ヶ月の資金流入", flow_text, flow_points, 10, "流入が続くファンドは運用が安定しやすい"),
            ],
            20,
        )
    )

    # --- リターン(25) ---
    r3 = (row.get("returns_pct") or {}).get("3y")
    r1 = (row.get("returns_pct") or {}).get("1y")
    if r3 is None and m.get("returns_pct"):
        r3 = m["returns_pct"].get("3Y")
    if r1 is None and m.get("returns_pct"):
        r1 = m["returns_pct"].get("1Y")
    ann3 = _annualize(r3, 3)
    ret_tiers = [(15, 15), (10, 12), (7, 9), (4, 6), (0, 3)]
    if ann3 is not None:
        ret_item = _item("3年リターン(年率換算)", f"{fmt_pct(ann3, signed=True)}(累積{fmt_pct(r3, signed=True)})", _tier_ge(ann3, ret_tiers), 15, "年率15%以上で満点")
    else:
        ret_item = _item("1年リターン(3年実績なし)", fmt_pct(r1, signed=True), min(_tier_ge(r1, ret_tiers), 8), 15, "運用3年未満のため1年で代用(上限8点)")
    rank = (row.get("rank_return") or {}).get("3y") or (row.get("rank_return") or {}).get("1y")
    rank_key = "3y" if (row.get("rank_return") or {}).get("3y") else "1y"
    rp = _rank_pct(rank)
    rank_points = 10 if rp is not None and rp <= 25 else (6 if rp is not None and rp <= 50 else (3 if rp is not None and rp <= 75 else 0))
    if rank_key == "1y":
        rank_points = min(rank_points, 6)
    cats.append(
        _category(
            "リターン",
            [
                ret_item,
                _item(f"同分類内の順位({rank_key})", f"{rank[0]}位/{rank[1]}本(上位{rp:.0f}%)" if rank else "N/A", rank_points, 10, "同じ分類のファンドの中で上位25%なら満点"),
            ],
            25,
        )
    )

    # --- リスク効率(20) ---
    sh3 = (row.get("sharpe") or {}).get("3y")
    sh1 = (row.get("sharpe") or {}).get("1y") if (row.get("sharpe") or {}).get("1y") is not None else m.get("sharpe_1y")
    sharpe_tiers = [(1.0, 20), (0.7, 15), (0.4, 10), (0.0, 5)]
    if sh3 is not None:
        sh_item = _item("シャープレシオ(3年)", f"{sh3:.2f}", _tier_ge(sh3, sharpe_tiers), 20, "1.0以上で優秀(リスク1単位あたりのリターン)")
    else:
        sh_item = _item("シャープレシオ(1年・3年実績なし)", f"{sh1:.2f}" if sh1 is not None else "N/A", min(_tier_ge(sh1, sharpe_tiers), 15), 20, "運用3年未満のため1年で代用(上限15点)")
    cats.append(_category("リスク効率", [sh_item], 20))

    # --- 継続性・安全性(10) ---
    years = m.get("years_running") or ((row.get("months_running") or 0) / 12)
    settle = row.get("settle_per_year")
    items = [
        _item("運用年数", f"{years:.1f}年", 4 if years >= 5 else (3 if years >= 3 else (1 if years >= 1 else 0)), 4, "3年以上で実績が評価可能"),
        _item("償還日", row.get("redemption") or "N/A", 2 if row.get("redemption") == "無期限" else 0, 2, "無期限が望ましい"),
        _item("決算頻度", f"年{settle}回" if settle else "N/A", 2 if settle and settle < 12 else (0 if settle else 1), 2, "毎月分配型は複利効果が弱くタコ足分配の懸念"),
        _item("繰上償還リスク", "低い(純資産30億円以上)" if assets and assets >= 3000 else "注意(純資産30億円未満)", 2 if assets and assets >= 3000 else 0, 2, ""),
    ]
    cats.append(_category("継続性・安全性", items, 10))

    total = max(0, min(100, sum(c["points"] for c in cats)))
    return {"total": total, "max": 100, "categories": cats}


def fund_verdict(row: dict[str, Any], m: dict[str, Any], score: dict[str, Any]) -> dict[str, Any]:
    total = score["total"]
    cost = row.get("trust_reward_pct")
    rank3 = (row.get("rank_return") or {}).get("3y")
    rp = _rank_pct(rank3)
    cost_text = f"信託報酬{fmt_pct(cost, 3)}" if cost is not None else "信託報酬N/A"
    rank_text = f"同分類{rank3[1]}本中{rank3[0]}位(上位{rp:.0f}%)" if rank3 else "順位データなし"
    actions: list[str] = []
    if total >= 75:
        label, level = "◎ 優良(低コスト × 実績良好)", "good"
        summary = f"総合{total}点。{cost_text}・3年リターンは{rank_text}。長期積立の中核候補になり得る内容。"
        actions += ["同じ指数・同じ投資対象のファンドと信託報酬・純資産を比べ、より安いものが無いか確認", "積立なら相場の上下に関係なく定額で継続(タイミングを計らない)"]
    elif total >= 60:
        label, level = "○ 良好", "good"
        summary = f"総合{total}点。{cost_text}・3年リターンは{rank_text}。大きな欠点は無いが、コストか実績のどちらかに改善余地。"
        actions += ["点数の低いカテゴリ(コスト/リターン/資金流入)を確認し、同分類の上位ファンドと比較"]
    elif total >= 45:
        label, level = "△ 平均的(より良い選択肢がないか比較)", "warning"
        summary = f"総合{total}点。{cost_text}・3年リターンは{rank_text}。同分類の中で特に優れている点が見つけにくい。"
        actions += ["同分類で信託報酬が低く純資産が大きいファンドを候補に加えて比較", "このファンドでなければならない理由(投資対象・分配方針)があるか整理"]
    else:
        label, level = "× 見送り検討(コストか実績に難あり)", "critical"
        summary = f"総合{total}点。{cost_text}・3年リターンは{rank_text}。長期保有のコストや実績面で不利。"
        actions += ["高コスト・資金流出・小規模のいずれに該当するかリスク欄で確認", "同じ投資対象のインデックスファンドで代替できないか検討"]
    if row.get("rakuten_available") is False:
        actions.append("楽天証券では取扱いがないため、購入するなら他社口座が必要")
    if row.get("nisa_tsumitate"):
        actions.append("つみたて投資枠の対象。非課税で積み立てられる")
    elif row.get("nisa_growth"):
        actions.append("NISA成長投資枠の対象(つみたて投資枠は対象外)")
    return {"label": label, "level": level, "summary": summary, "actions": actions}


def fund_risk_flags(row: dict[str, Any], m: dict[str, Any]) -> list[str]:
    flags: list[str] = []
    assets = row.get("net_assets_million") or m.get("assets_million")
    if assets is not None and assets < 1000:
        flags.append(f"純資産{fmt_oku(assets)}と小さく、繰上償還(強制終了)リスクがある")
    elif assets is not None and assets < 3000:
        flags.append(f"純資産{fmt_oku(assets)}。30億円未満は繰上償還の目安に近い")
    years = m.get("years_running") or ((row.get("months_running") or 0) / 12)
    if years < 3:
        flags.append(f"運用{years:.1f}年と実績が短く、3年・5年の評価ができない")
    cost = row.get("trust_reward_pct")
    if cost is not None and cost >= 1.5:
        flags.append(f"信託報酬{cost:.2f}%は高コスト。20年保有なら元本の約{cost * 20:.0f}%が手数料で消える計算")
    elif cost is not None and cost >= 1.0:
        flags.append(f"信託報酬{cost:.2f}%はインデックスファンドの5〜10倍。それに見合う実績があるか要確認")
    if (row.get("buy_fee_pct") or 0) > 0:
        flags.append(f"購入時手数料の上限{row['buy_fee_pct']:.2f}%(販売会社によって異なる。楽天証券はノーロードが多い)")
    settle = row.get("settle_per_year")
    dy = m.get("dividend_yield_pct")
    if settle and settle >= 12:
        flags.append("毎月分配型。分配金は運用益ではなく元本の払い戻し(特別分配金)になることがある")
        r1 = (m.get("returns_pct") or {}).get("1Y")
        if dy and r1 is not None and dy > max(r1, 0):
            flags.append(f"分配金利回り{dy:.1f}%が1年トータルリターン{fmt_pct(r1, signed=True)}を上回っており、元本取り崩しの可能性")
    flow = (row.get("flow_million") or {}).get("12m")
    if flow is not None and flow < 0:
        flags.append(f"直近12ヶ月は資金流出({fmt_oku(flow)})。解約が続くと運用効率が落ちる")
    vol = (row.get("risk_pct") or {}).get("1y") or m.get("vol_1y_pct")
    if vol is not None and vol >= 25:
        flags.append(f"1年の価格変動(標準偏差)が{vol:.0f}%と大きい。下落局面で3〜5割下がる覚悟が必要")
    dd = m.get("max_drawdown_3y_pct")
    if dd is not None and dd <= -30:
        flags.append(f"過去3年の最大下落率{dd:.0f}%。同程度の下落が再び起こり得る")
    if row.get("eval_discrepancy"):
        flags.append("投信協会が「基準価額と時価の評価乖離」を注意喚起中")
    if row.get("rakuten_available") is False:
        flags.append("楽天証券では取扱いなし(販売会社一覧に楽天証券が無い)")
    return flags


def analyze_fund(isin: str, assoc: str | None = None, display_name: str | None = None) -> dict[str, Any] | None:
    row = get_fund_row(isin.strip().upper())
    if not row:
        return None
    assoc = assoc or row.get("assoc")
    hist = get_fund_history(row["isin"], assoc) if assoc else None
    m = compute_fund_metrics(hist)
    score = score_fund(row, m)
    verdict = fund_verdict(row, m, score)
    flags = fund_risk_flags(row, m)
    notes = [
        "データ: 投信総合検索ライブラリー(資産運用業協会)。属性・期間リターン・順位は同ライブラリー、"
        "計算値(トータルリターン・変動率・最大下落率)は設定来の基準価額と分配金から算出",
        "スコアは投資対象を問わず同じ物差しで採点した機械的な参考値。売買の推奨ではない",
        f"基準日: {row.get('as_of') or m.get('as_of')}",
    ]
    if not m.get("available"):
        notes.append("基準価額の履歴が取得できなかったため、計算値は表示されない")
    return {
        "kind": "fund",
        "isin": row["isin"],
        "assoc": assoc,
        "name": display_name or row["name"],
        "nickname": row.get("nickname"),
        "company": row.get("company"),
        "category": row.get("category"),
        "as_of": row.get("as_of") or m.get("as_of"),
        "nav": row.get("nav") or m.get("nav"),
        "change": row.get("change"),
        "change_pct": row.get("change_pct"),
        "attrs": row,
        "metrics": m,
        "score": score,
        "verdict": verdict,
        "risk_flags": flags,
        "data_notes": notes,
    }


def fund_one_line(a: dict[str, Any]) -> str:
    r = a["attrs"].get("rakuten_available")
    return (
        f"{a['name']}({a['isin']}) 基準価額{a['nav']:,.0f}円 | 総合{a['score']['total']}点 "
        f"| 信託報酬{fmt_pct(a['attrs'].get('trust_reward_pct'), 3)} | 楽天証券{'○' if r else '×'} | {a['verdict']['label']}"
    )
