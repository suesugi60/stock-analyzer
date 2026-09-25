"""個別株のファンダメンタル分析・テクニカル分析エンジン。

yfinanceから取得した年次の財務三表(最大5期)・配当履歴・5年分の日足をもとに、
- ファンダメンタルスコア(成長性・収益性・財務健全性・割安度・株主還元、各20点=100点)
- テクニカル指標(移動平均・RSI・MACD・ボリンジャーバンド・ATR・52週高安・出来高・
  支持/抵抗線)と、トレンド強度スコア(0〜100点)・売買タイミング区分
- 両者を掛け合わせた総合所見、適正株価の参考レンジ、自動判定できないリスク項目
を返す。「売買の推奨」ではなく「判断材料の整理」に徹し、最終判断は利用者が行う前提。
閾値は 銘柄分析/config/settings.yaml で上書きできる(キーは DEFAULTS と同じ)。
"""
from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from statistics import median
from typing import Any

import numpy as np
import pandas as pd

from stock_analyzer import fetchers
from stock_analyzer.config import load_settings

DEFAULTS: dict[str, Any] = {
    "history_period": "5y",           # 日足の取得期間(過去PER/PBRの算出にも使う)
    "fair_per_default": 15.0,         # 過去PERが取れない時の適正PER目安
    "target_dividend_yield": 0.03,    # 「配当利回りが○%になる株価」の目安
    "cross_lookback_days": 20,        # ゴールデン/デッドクロスを「直近」とみなす日数
    "min_daily_turnover_jpy": 100_000_000,  # 売買代金がこれ未満なら流動性リスクを警告
    "swing_lookback_days": 120,       # 支持線・抵抗線を探す期間
    "chart_days": 250,                # ダッシュボードのチャートに渡す日数
}

FUNDAMENTAL_CATEGORY_MAX = 20


def get_settings(overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = dict(DEFAULTS)
    cfg.update(load_settings())
    if overrides:
        cfg.update(overrides)
    return cfg


# ------------------------------------------------------------
# 数値ユーティリティ(None安全)
# ------------------------------------------------------------
def _f(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    return x


def _first(*values: Any) -> float | None:
    for v in values:
        x = _f(v)
        if x is not None:
            return x
    return None


def _div(a: Any, b: Any) -> float | None:
    a, b = _f(a), _f(b)
    if a is None or b is None or b == 0:
        return None
    return a / b


def _growth_pct(current: Any, previous: Any) -> float | None:
    """前年比(%)。前年がゼロ以下(赤字など)の場合は意味を持たないのでNone。"""
    current, previous = _f(current), _f(previous)
    if current is None or previous is None or previous <= 0:
        return None
    return (current / previous - 1) * 100


def _cagr_pct(values: list[Any]) -> tuple[float | None, int]:
    """年率成長率(%)と対象年数。最初と最後の有効値から算出。どちらかがゼロ以下なら算出不可。"""
    points = [(i, _f(v)) for i, v in enumerate(values)]
    points = [(i, v) for i, v in points if v is not None]
    if len(points) < 2:
        return None, 0
    (i0, v0), (i1, v1) = points[0], points[-1]
    years = i1 - i0
    if years <= 0 or v0 <= 0 or v1 <= 0:
        return None, years
    return ((v1 / v0) ** (1 / years) - 1) * 100, years


def _tier_ge(value: float | None, tiers: list[tuple[float, int]]) -> int:
    """値が閾値以上なら得点(閾値は高い順に並べる)。"""
    if value is None:
        return 0
    for threshold, points in tiers:
        if value >= threshold:
            return points
    return 0


def _tier_le(value: float | None, tiers: list[tuple[float, int]]) -> int:
    """値が閾値以下なら得点(閾値は低い順に並べる)。"""
    if value is None:
        return 0
    for threshold, points in tiers:
        if value <= threshold:
            return points
    return 0


def fmt_pct(value: float | None, decimals: int = 1, signed: bool = False) -> str:
    if value is None:
        return "N/A"
    return f"{value:+.{decimals}f}%" if signed else f"{value:.{decimals}f}%"


def fmt_x(value: float | None, decimals: int = 1) -> str:
    return "N/A" if value is None else f"{value:.{decimals}f}倍"


def fmt_num(value: float | None, decimals: int = 0, suffix: str = "") -> str:
    return "N/A" if value is None else f"{value:,.{decimals}f}{suffix}"


def fmt_money(value: float | None, currency: str, decimals: int = 0) -> str:
    """株価など生の通貨額。JPYは円、それ以外は通貨コードを付ける。"""
    if value is None:
        return "N/A"
    if currency == "JPY":
        return f"{value:,.{decimals}f}円"
    return f"{value:,.{max(decimals, 2)}f} {currency}"


def fmt_big(value: float | None, currency: str) -> str:
    """財務諸表の金額を百万単位で表示(JPYは百万円、USD等は百万ドル相当)。"""
    if value is None:
        return "N/A"
    unit = "百万円" if currency == "JPY" else f"百万{currency}"
    return f"{value / 1e6:,.0f}{unit}"


def fmt_market_cap(value: float | None, currency: str) -> str:
    if value is None:
        return "N/A"
    if currency == "JPY":
        return f"{value / 1e8:,.0f}億円"
    return f"{value / 1e9:,.1f}B {currency}"


def _item(name: str, value_text: str, points: int, max_points: int, comment: str = "") -> dict[str, Any]:
    return {"item": name, "value": value_text, "points": points, "max": max_points, "comment": comment}


def _category(name: str, items: list[dict[str, Any]], max_points: int) -> dict[str, Any]:
    return {"name": name, "points": sum(i["points"] for i in items), "max": max_points, "items": items}


# ------------------------------------------------------------
# ファンダメンタル: 財務テーブル
# ------------------------------------------------------------
def build_financial_table(statements: dict[str, Any]) -> list[dict[str, Any]]:
    """年次の財務諸表を決算期ごとの1行(派生指標込み)に整形する(古い期→新しい期)。"""
    periods = statements.get("periods") or []
    inc = statements.get("income") or {}
    bal = statements.get("balance") or {}
    cf = statements.get("cashflow") or {}

    def g(section: dict[str, list], key: str, i: int) -> float | None:
        values = section.get(key)
        if not values or i >= len(values):
            return None
        return _f(values[i])

    rows: list[dict[str, Any]] = []
    for i, p in enumerate(periods):
        revenue = g(inc, "revenue", i)
        op = g(inc, "operating_income", i)
        ni = g(inc, "net_income", i)
        eps = _first(g(inc, "eps_diluted", i), g(inc, "eps_basic", i))
        equity = g(bal, "equity", i)
        assets = g(bal, "total_assets", i)
        debt = g(bal, "total_debt", i)
        cash = _first(g(bal, "cash_and_st_investments", i), g(bal, "cash", i))
        shares = _first(g(bal, "shares_outstanding", i), g(inc, "shares_diluted", i))
        ocf = g(cf, "operating_cf", i)
        fcf = g(cf, "free_cf", i)
        capex = g(cf, "capex", i)
        if fcf is None and ocf is not None and capex is not None:
            fcf = ocf + capex  # yfinanceの設備投資は負値で入る
        ts = pd.Timestamp(p)
        rows.append(
            {
                "period_end": p,
                "label": f"{ts.year}年{ts.month}月期",
                "revenue": revenue,
                "gross_profit": g(inc, "gross_profit", i),
                "operating_income": op,
                "net_income": ni,
                "ebitda": g(inc, "ebitda", i),
                "unusual_items": g(inc, "unusual_items", i),
                "eps": eps,
                "op_margin": _div(op, revenue),
                "net_margin": _div(ni, revenue),
                "equity": equity,
                "total_assets": assets,
                "equity_ratio": _div(equity, assets),
                "total_debt": debt,
                "cash": cash,
                "net_cash": (cash - debt) if cash is not None and debt is not None else None,
                "current_ratio": _div(g(bal, "current_assets", i), g(bal, "current_liabilities", i)),
                "goodwill_and_intangibles": g(bal, "goodwill_and_intangibles", i),
                "retained_earnings": g(bal, "retained_earnings", i),
                "shares": shares,
                "bps": _div(equity, shares),
                "roe": _div(ni, equity),
                "roa": _div(ni, assets),
                "ocf": ocf,
                "fcf": fcf,
                "capex": capex,
                "dividends_paid": g(cf, "dividends_paid", i),
                "buybacks": g(cf, "buybacks", i),
                "revenue_yoy_pct": None,
                "operating_income_yoy_pct": None,
                "net_income_yoy_pct": None,
                "eps_yoy_pct": None,
            }
        )
    for i in range(1, len(rows)):
        for key in ("revenue", "operating_income", "net_income", "eps"):
            rows[i][f"{key}_yoy_pct"] = _growth_pct(rows[i][key], rows[i - 1][key])
    return rows


def add_dividends_per_period(rows: list[dict[str, Any]], dividends: list[dict[str, Any]]) -> None:
    """配当履歴(権利落ち日ベース)を決算期ごとの1株配当(DPS)に集計する。

    3月決算の日本株は期末配当の権利落ちが3月末(決算期末の数日前)になるため、
    期末+3日までを当期に含める。配当履歴自体が無い銘柄は無配としてNone。
    """
    if not rows:
        return
    ends = [pd.Timestamp(r["period_end"]) for r in rows]
    has_dividends = bool(dividends)
    parsed = [(pd.Timestamp(d["date"]), _f(d["amount"]) or 0.0) for d in dividends]
    for i, row in enumerate(rows):
        end = ends[i] + pd.Timedelta(days=3)
        start = (ends[i - 1] + pd.Timedelta(days=3)) if i > 0 else (ends[i] - pd.DateOffset(years=1) + pd.Timedelta(days=3))
        total = sum(amount for date, amount in parsed if start < date <= end)
        row["dps"] = total if has_dividends else None
        eps = row.get("eps")
        row["payout_ratio"] = (row["dps"] / eps) if row.get("dps") and eps and eps > 0 else None


def dividends_last_12m(dividends: list[dict[str, Any]], as_of: str) -> float | None:
    if not dividends:
        return None
    end = pd.Timestamp(as_of)
    start = end - pd.DateOffset(years=1)
    return sum((_f(d["amount"]) or 0.0) for d in dividends if start < pd.Timestamp(d["date"]) <= end)


def add_historical_valuation(rows: list[dict[str, Any]], ohlcv: dict[str, Any]) -> None:
    """各決算期末時点の株価からPER・PBR・配当利回りを求め、現在値を過去レンジと比べられるようにする。"""
    dates = pd.to_datetime(pd.Series(ohlcv["dates"]))
    closes = pd.to_numeric(pd.Series(ohlcv["close"]), errors="coerce")
    valid = closes.notna()
    dates = dates[valid].reset_index(drop=True)
    closes = closes[valid].reset_index(drop=True)
    for row in rows:
        end = pd.Timestamp(row["period_end"])
        idx = int(dates.searchsorted(end, side="right")) - 1
        price = None
        if idx >= 0 and (end - dates.iloc[idx]).days <= 10:
            price = float(closes.iloc[idx])
        row["price_at_period_end"] = price
        eps, bps, dps = row.get("eps"), row.get("bps"), row.get("dps")
        row["per"] = price / eps if price and eps and eps > 0 else None
        row["pbr"] = price / bps if price and bps and bps > 0 else None
        row["dividend_yield"] = dps / price if price and dps else None


def _dividend_yield_fraction(profile: dict[str, Any], price: float | None, dps_ttm: float | None) -> float | None:
    """配当利回り(小数)。実際の配当履歴から計算した値を最優先し、無ければyfinanceのinfoを使う。

    yfinanceの dividendYield はバージョンにより%表記(4.66)と小数表記(0.0466)が混在する
    ため、小数表記で安定している trailingAnnualDividendYield を優先する。
    """
    if dps_ttm is not None and price:
        return dps_ttm / price
    y = _f(profile.get("trailingAnnualDividendYield"))
    if y is not None:
        return y
    dy = _f(profile.get("dividendYield"))
    if dy is not None:
        return dy / 100
    return None


def build_current_ratios(
    profile: dict[str, Any], rows: list[dict[str, Any]], price: float | None, dps_ttm: float | None
) -> dict[str, Any]:
    latest = rows[-1] if rows else {}
    eps = _first(profile.get("trailingEps"), latest.get("eps"))
    per = _f(profile.get("trailingPE"))
    if per is None and eps and eps > 0 and price:
        per = price / eps
    bps = _first(profile.get("bookValue"), latest.get("bps"))
    pbr = _f(profile.get("priceToBook"))
    if pbr is None and bps and bps > 0 and price:
        pbr = price / bps
    roe = _first(profile.get("returnOnEquity"), latest.get("roe"))
    roa = _first(profile.get("returnOnAssets"), latest.get("roa"))
    op_margin = _first(latest.get("op_margin"), profile.get("operatingMargins"))
    net_margin = _first(latest.get("net_margin"), profile.get("profitMargins"))
    equity_ratio = latest.get("equity_ratio")
    net_cash = latest.get("net_cash")
    if net_cash is None:
        cash, debt = _f(profile.get("totalCash")), _f(profile.get("totalDebt"))
        net_cash = (cash - debt) if cash is not None and debt is not None else None
    ebitda = latest.get("ebitda")
    net_debt_to_ebitda = None
    if net_cash is not None and ebitda and ebitda > 0:
        net_debt_to_ebitda = max(-net_cash, 0.0) / ebitda
    current_ratio = _first(profile.get("currentRatio"), latest.get("current_ratio"))
    ocf = _first(latest.get("ocf"), profile.get("operatingCashflow"))
    fcf = _first(latest.get("fcf"), profile.get("freeCashflow"))
    dividend_yield = _dividend_yield_fraction(profile, price, dps_ttm)
    payout = _f(profile.get("payoutRatio"))
    if payout is None and dps_ttm and eps and eps > 0:
        payout = dps_ttm / eps
    if dps_ttm == 0:
        payout = 0.0

    per_hist = [r["per"] for r in rows if r.get("per")]
    pbr_hist = [r["pbr"] for r in rows if r.get("pbr")]
    per_percentile = None
    if per is not None and per > 0 and len(per_hist) >= 3:
        per_percentile = sum(1 for h in per_hist if h <= per) / len(per_hist) * 100
    pbr_percentile = None
    if pbr is not None and len(pbr_hist) >= 3:
        pbr_percentile = sum(1 for h in pbr_hist if h <= pbr) / len(pbr_hist) * 100

    dps_streak = 0
    dps_list = [r.get("dps") for r in rows]
    for i in range(len(dps_list) - 1, 0, -1):
        a, b = dps_list[i], dps_list[i - 1]
        if a is not None and b is not None and a > b:
            dps_streak += 1
        else:
            break

    return {
        "eps": eps,
        "bps": bps,
        "per": per,
        "forward_per": _f(profile.get("forwardPE")),
        "pbr": pbr,
        "psr": _f(profile.get("priceToSalesTrailing12Months")),
        "ev_ebitda": _f(profile.get("enterpriseToEbitda")),
        "roe": roe,
        "roa": roa,
        "op_margin": op_margin,
        "net_margin": net_margin,
        "equity_ratio": equity_ratio,
        "net_cash": net_cash,
        "net_debt_to_ebitda": net_debt_to_ebitda,
        "current_ratio": current_ratio,
        "ocf": ocf,
        "fcf": fcf,
        "net_income": latest.get("net_income"),
        "dps_ttm": dps_ttm,
        "dividend_yield": dividend_yield,
        "payout_ratio": payout,
        "dps_streak_years": dps_streak,
        "per_hist": per_hist,
        "pbr_hist": pbr_hist,
        "per_percentile": per_percentile,
        "pbr_percentile": pbr_percentile,
        "beta": _f(profile.get("beta")),
        "market_cap": _f(profile.get("marketCap")),
        "insiders_pct": _f(profile.get("heldPercentInsiders")),
        "institutions_pct": _f(profile.get("heldPercentInstitutions")),
        "target_mean_price": _f(profile.get("targetMeanPrice")),
        "analyst_count": _f(profile.get("numberOfAnalystOpinions")),
    }


# ------------------------------------------------------------
# ファンダメンタル: スコアリング(各カテゴリ20点、計100点)
# ------------------------------------------------------------
def score_fundamentals(rows: list[dict[str, Any]], ratios: dict[str, Any]) -> dict[str, Any]:
    latest = rows[-1] if rows else {}
    categories: list[dict[str, Any]] = []

    # --- 成長性 ---
    rev_cagr, rev_years = _cagr_pct([r["revenue"] for r in rows])
    op_cagr, op_years = _cagr_pct([r["operating_income"] for r in rows])
    rev_yoy = latest.get("revenue_yoy_pct")
    op_yoy = latest.get("operating_income_yoy_pct")
    up_count = sum(1 for v in (rev_yoy, op_yoy) if v is not None and v > 0)
    growth_tiers = [(15, 8), (8, 6), (3, 4), (0, 2)]
    categories.append(
        _category(
            "成長性",
            [
                _item(f"売上高CAGR({rev_years}年)", fmt_pct(rev_cagr, signed=True), _tier_ge(rev_cagr, growth_tiers), 8,
                      "年率15%以上で満点、3%未満は横ばい扱い"),
                _item(f"営業利益CAGR({op_years}年)", fmt_pct(op_cagr, signed=True), _tier_ge(op_cagr, growth_tiers), 8,
                      "始点か終点が赤字なら算出不可(0点)"),
                _item("直近期の増収・営業増益", f"売上{fmt_pct(rev_yoy, signed=True)} / 営業利益{fmt_pct(op_yoy, signed=True)}",
                      {2: 4, 1: 2, 0: 0}[up_count], 4, "両方プラスで満点"),
            ],
            FUNDAMENTAL_CATEGORY_MAX,
        )
    )

    # --- 収益性 ---
    roe_pct = ratios["roe"] * 100 if ratios.get("roe") is not None else None
    opm_pct = ratios["op_margin"] * 100 if ratios.get("op_margin") is not None else None
    ocf, ni = ratios.get("ocf"), ratios.get("net_income")
    if ocf is not None and ocf > 0 and ni is not None and ocf >= ni:
        cf_points, cf_text = 5, "営業CF>純利益(利益の質が高い)"
    elif ocf is not None and ocf > 0:
        cf_points, cf_text = 2, "営業CFはプラスだが純利益を下回る"
    elif ocf is not None:
        cf_points, cf_text = 0, "営業CFがマイナス"
    else:
        cf_points, cf_text = 0, "営業CFデータなし"
    categories.append(
        _category(
            "収益性",
            [
                _item("ROE(自己資本利益率)", fmt_pct(roe_pct), _tier_ge(roe_pct, [(20, 8), (15, 6), (10, 4), (5, 2)]), 8,
                      "20%以上で満点、10%が一般的な合格ライン"),
                _item("営業利益率", fmt_pct(opm_pct), _tier_ge(opm_pct, [(20, 7), (10, 5), (5, 3), (0, 1)]), 7,
                      "20%以上で満点(業種差が大きいので同業比較も必要)"),
                _item("利益の質(営業CF vs 純利益)", cf_text, cf_points, 5, "営業CFが純利益を上回ると会計上の利益が現金で裏付けられている"),
            ],
            FUNDAMENTAL_CATEGORY_MAX,
        )
    )

    # --- 財務健全性 ---
    eq_ratio_pct = ratios["equity_ratio"] * 100 if ratios.get("equity_ratio") is not None else None
    net_cash = ratios.get("net_cash")
    nd_ebitda = ratios.get("net_debt_to_ebitda")
    if net_cash is not None and net_cash > 0:
        debt_points, debt_text = 6, "ネットキャッシュ(現金>有利子負債)"
    elif nd_ebitda is not None and nd_ebitda < 2:
        debt_points, debt_text = 4, f"純有利子負債/EBITDA {nd_ebitda:.1f}倍(軽い)"
    elif nd_ebitda is not None and nd_ebitda < 4:
        debt_points, debt_text = 2, f"純有利子負債/EBITDA {nd_ebitda:.1f}倍(やや重い)"
    elif net_cash is not None or nd_ebitda is not None:
        debt_points, debt_text = 0, "純有利子負債がEBITDAの4倍超、または赤字で返済能力が測れない"
    else:
        debt_points, debt_text = 0, "負債データなし"
    fcf = ratios.get("fcf")
    categories.append(
        _category(
            "財務健全性",
            [
                _item("自己資本比率", fmt_pct(eq_ratio_pct), _tier_ge(eq_ratio_pct, [(60, 8), (40, 6), (25, 4), (10, 2)]), 8,
                      "40%以上で安定、金融・リース業は低くても正常"),
                _item("有利子負債の重さ", debt_text, debt_points, 6, ""),
                _item("流動比率", fmt_x(ratios.get("current_ratio"), 2), _tier_ge(ratios.get("current_ratio"), [(1.5, 3), (1.0, 2)]), 3,
                      "1倍未満は短期の支払能力に注意(人材派遣など業種特性で低い場合もある)"),
                _item("フリーCF", "プラス" if fcf is not None and fcf > 0 else ("マイナス" if fcf is not None else "N/A"),
                      3 if fcf is not None and fcf > 0 else 0, 3, "設備投資後に現金が残っているか"),
            ],
            FUNDAMENTAL_CATEGORY_MAX,
        )
    )

    # --- 割安度 ---
    per, pbr = ratios.get("per"), ratios.get("pbr")
    per_points = _tier_le(per, [(10, 8), (15, 6), (20, 4), (30, 2)]) if per is not None and per > 0 else 0
    per_pct = ratios.get("per_percentile")
    if per_pct is None:
        hist_points, hist_text = 0, "過去PERのデータ不足(3期未満)または赤字"
    elif per_pct <= 25:
        hist_points, hist_text = 6, f"過去{len(ratios['per_hist'])}期のPERレンジの下位25%(割安圏)"
    elif per_pct <= 50:
        hist_points, hist_text = 3, "過去PERレンジの中央値以下"
    else:
        hist_points, hist_text = 0, "過去PERレンジの中央値より上(過去比では割高)"
    categories.append(
        _category(
            "割安度",
            [
                _item("PER(実績)", fmt_x(per) if per is None or per > 0 else "赤字(算出不可)", per_points, 8,
                      "10倍以下で満点、15倍が市場平均的な目安"),
                _item("PBR", fmt_x(pbr, 2), _tier_le(pbr, [(1.0, 6), (1.5, 4), (3.0, 2)]), 6,
                      "1倍割れは解散価値以下(東証も1倍割れ企業に改善要請)"),
                _item("過去PERとの比較", hist_text, hist_points, 6, ""),
            ],
            FUNDAMENTAL_CATEGORY_MAX,
        )
    )

    # --- 株主還元 ---
    dy_pct = ratios["dividend_yield"] * 100 if ratios.get("dividend_yield") is not None else None
    payout = ratios.get("payout_ratio")
    dps_ttm = ratios.get("dps_ttm")
    if not dps_ttm:
        payout_points, payout_text = 0, "無配(または配当データなし)"
    elif payout is None:
        payout_points, payout_text = 2, "赤字のため配当性向は算出不可(配当は継続中)"
    elif 0.3 <= payout <= 0.6:
        payout_points, payout_text = 6, f"配当性向{payout * 100:.0f}%(還元と成長投資のバランス圏)"
    elif payout < 0.3:
        payout_points, payout_text = 4, f"配当性向{payout * 100:.0f}%(増配余力あり)"
    elif payout <= 1.0:
        payout_points, payout_text = 2, f"配当性向{payout * 100:.0f}%(やや高め、減配リスクに注意)"
    else:
        payout_points, payout_text = 0, f"配当性向{payout * 100:.0f}%(利益以上に配当=タコ足配当)"
    streak = ratios.get("dps_streak_years") or 0
    streak_points = 6 if streak >= 3 else (3 if streak >= 1 else 0)
    categories.append(
        _category(
            "株主還元",
            [
                _item("配当利回り", fmt_pct(dy_pct, 2), _tier_ge(dy_pct, [(4, 8), (3, 6), (2, 4), (1, 2)]), 8, "4%以上で満点"),
                _item("配当性向", payout_text, payout_points, 6, ""),
                _item("連続増配", f"{streak}期連続" if streak else "増配なし(または無配/データ不足)", streak_points, 6,
                      "3期以上の連続増配で満点(決算期ごとの1株配当ベース)"),
            ],
            FUNDAMENTAL_CATEGORY_MAX,
        )
    )

    total = sum(c["points"] for c in categories)
    return {"total": total, "max": 100, "categories": categories}


def fair_value_reference(
    rows: list[dict[str, Any]], ratios: dict[str, Any], price: float | None, cfg: dict[str, Any]
) -> list[dict[str, Any]]:
    """適正株価の「参考値」。複数の単純な物差しを並べるだけで、理論株価の断定ではない。"""
    refs: list[dict[str, Any]] = []

    def add(method: str, value: float | None, note: str) -> None:
        if value is None or value <= 0:
            return
        upside = (value / price - 1) * 100 if price else None
        refs.append({"method": method, "value": value, "upside_pct": upside, "note": note})

    eps, bps, dps = ratios.get("eps"), ratios.get("bps"), ratios.get("dps_ttm")
    per_hist, pbr_hist = ratios.get("per_hist") or [], ratios.get("pbr_hist") or []
    if eps and eps > 0:
        if len(per_hist) >= 3:
            med = median(per_hist)
            add("過去PER中央値 × EPS", eps * med, f"過去{len(per_hist)}期の期末PER中央値{med:.1f}倍")
        add(f"PER{cfg['fair_per_default']:.0f}倍 × EPS", eps * cfg["fair_per_default"], "市場平均的な水準の目安")
    if bps and bps > 0 and len(pbr_hist) >= 3:
        med = median(pbr_hist)
        add("過去PBR中央値 × BPS", bps * med, f"過去{len(pbr_hist)}期の期末PBR中央値{med:.2f}倍")
    if dps and dps > 0:
        y = cfg["target_dividend_yield"]
        add(f"配当利回り{y * 100:.0f}%となる株価", dps / y, "配当から見た下値目安(減配されない前提)")
    return refs


# ------------------------------------------------------------
# テクニカル
# ------------------------------------------------------------
def _rsi_wilder(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - 100 / (1 + rs)
    rsi = rsi.where(avg_loss != 0, 100.0)
    return rsi


def _recent_cross(fast: pd.Series, slow: pd.Series, lookback: int) -> dict[str, Any] | None:
    diff = (fast - slow).dropna()
    if len(diff) < lookback + 2:
        return None
    sign = np.sign(diff.values)
    last = sign[-1]
    if last == 0:
        return None
    for k in range(2, lookback + 2):
        if sign[-k] != last and sign[-k] != 0:
            return {"type": "golden" if last > 0 else "dead", "days_ago": k - 1}
    return None


def _swing_levels(df: pd.DataFrame, price: float, lookback: int, window: int = 5) -> tuple[float | None, float | None]:
    """直近lookback日の局所高値/安値から、現在値の下の支持線・上の抵抗線を返す。"""
    sub = df.tail(lookback).reset_index(drop=True)
    highs, lows = sub["high"].values, sub["low"].values
    supports, resistances = [], []
    for i in range(window, len(sub) - window):
        if highs[i] == np.nanmax(highs[i - window : i + window + 1]):
            resistances.append(float(highs[i]))
        if lows[i] == np.nanmin(lows[i - window : i + window + 1]):
            supports.append(float(lows[i]))
    support = max([s for s in supports if s < price], default=None)
    resistance = min([r for r in resistances if r > price], default=None)
    return support, resistance


def _return_pct(closes: np.ndarray, n: int) -> float | None:
    if len(closes) <= n or closes[-n - 1] <= 0:
        return None
    return (closes[-1] / closes[-n - 1] - 1) * 100


def _series_list(s: pd.Series, decimals: int = 4) -> list[float | None]:
    return [None if (v is None or (isinstance(v, float) and math.isnan(v))) else round(float(v), decimals) for v in s.tolist()]


def compute_technicals(ohlcv: dict[str, Any], benchmark: dict[str, Any] | None, cfg: dict[str, Any]) -> dict[str, Any] | None:
    df = pd.DataFrame(
        {
            "date": pd.to_datetime(ohlcv["dates"]),
            "open": pd.to_numeric(pd.Series(ohlcv["open"]), errors="coerce"),
            "high": pd.to_numeric(pd.Series(ohlcv["high"]), errors="coerce"),
            "low": pd.to_numeric(pd.Series(ohlcv["low"]), errors="coerce"),
            "close": pd.to_numeric(pd.Series(ohlcv["close"]), errors="coerce"),
            "volume": pd.to_numeric(pd.Series(ohlcv["volume"]), errors="coerce"),
        }
    )
    df = df.dropna(subset=["close"]).reset_index(drop=True)
    if len(df) < 30:
        return None
    df["high"] = df["high"].fillna(df["close"])
    df["low"] = df["low"].fillna(df["close"])
    close = df["close"]
    for n in (5, 25, 75, 200):
        df[f"ma{n}"] = close.rolling(n).mean()
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    df["macd"] = ema12 - ema26
    df["macd_signal"] = df["macd"].ewm(span=9, adjust=False).mean()
    df["macd_hist"] = df["macd"] - df["macd_signal"]
    df["rsi"] = _rsi_wilder(close, 14)
    mid = close.rolling(20).mean()
    std = close.rolling(20).std(ddof=0)
    df["bb_mid"] = mid
    df["bb_upper"] = mid + 2 * std
    df["bb_lower"] = mid - 2 * std
    prev_close = close.shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / 14, adjust=False).mean()

    last = df.iloc[-1]
    prev = df.iloc[-2]
    price = float(last["close"])
    prev_price = float(prev["close"])
    ma = {str(n): _f(last[f"ma{n}"]) for n in (5, 25, 75, 200)}
    ma_dist_pct = {k: ((price / v - 1) * 100 if v else None) for k, v in ma.items()}
    ma25, ma75, ma200 = ma["25"], ma["75"], ma["200"]

    if ma25 and ma75 and ma200:
        if ma25 > ma75 > ma200:
            alignment = "上昇配列(25日>75日>200日、パーフェクトオーダー)"
        elif ma25 < ma75 < ma200:
            alignment = "下降配列(25日<75日<200日)"
        else:
            alignment = "混在(トレンド転換期またはレンジ)"
    elif ma25 and ma75:
        alignment = ("25日>75日" if ma25 > ma75 else "25日<75日") + "(200日線はデータ不足)"
    else:
        alignment = "データ不足"

    if ma25 and ma75 and ma200:
        if price > ma200 and ma25 > ma75:
            trend = "上昇トレンド"
        elif price < ma200 and ma25 < ma75:
            trend = "下降トレンド"
        else:
            trend = "レンジ・転換期"
    elif ma25 and ma75:
        trend = "上昇トレンド" if (price > ma75 and ma25 > ma75) else ("下降トレンド" if (price < ma75 and ma25 < ma75) else "レンジ・転換期")
    else:
        trend = "データ不足"

    ma200_slope = None
    if len(df) > 221 and _f(df["ma200"].iloc[-21]):
        ma200_slope = _growth_pct(ma200, df["ma200"].iloc[-21])

    lookback = int(cfg["cross_lookback_days"])
    closes = close.values
    window_52w = df.tail(252)
    high_52w = float(window_52w["high"].max())
    low_52w = float(window_52w["low"].min())
    pos_52w = (price - low_52w) / (high_52w - low_52w) * 100 if high_52w > low_52w else None

    bench_returns = None
    bench_ticker = None
    if benchmark and benchmark.get("close"):
        b_closes = pd.to_numeric(pd.Series(benchmark["close"]), errors="coerce").dropna().values
        bench_returns = {k: _return_pct(b_closes, n) for k, n in (("1M", 21), ("3M", 63), ("6M", 126), ("1Y", 252))}
        bench_ticker = benchmark.get("ticker")
    returns = {k: _return_pct(closes, n) for k, n in (("1M", 21), ("3M", 63), ("6M", 126), ("1Y", 252))}
    rs_3m = None
    if returns["3M"] is not None and bench_returns and bench_returns.get("3M") is not None:
        rs_3m = returns["3M"] - bench_returns["3M"]

    vol = df["volume"]
    avg20 = _f(vol.tail(20).mean())
    avg60 = _f(vol.tail(60).mean())
    last_vol = _f(vol.iloc[-1])
    atr = _f(last["atr"])
    support, resistance = _swing_levels(df, price, int(cfg["swing_lookback_days"]))
    hist_prev5 = _f(df["macd_hist"].iloc[-6]) if len(df) > 6 else None

    chart = df.tail(int(cfg["chart_days"]))
    series = {
        "dates": [d.strftime("%Y-%m-%d") for d in chart["date"]],
        "open": _series_list(chart["open"]),
        "high": _series_list(chart["high"]),
        "low": _series_list(chart["low"]),
        "close": _series_list(chart["close"]),
        "volume": _series_list(chart["volume"], 0),
        "ma25": _series_list(chart["ma25"]),
        "ma75": _series_list(chart["ma75"]),
        "ma200": _series_list(chart["ma200"]),
        "bb_upper": _series_list(chart["bb_upper"]),
        "bb_lower": _series_list(chart["bb_lower"]),
        "rsi": _series_list(chart["rsi"], 2),
        "macd": _series_list(chart["macd"]),
        "macd_signal": _series_list(chart["macd_signal"]),
        "macd_hist": _series_list(chart["macd_hist"]),
    }

    return {
        "as_of": last["date"].strftime("%Y-%m-%d"),
        "price": price,
        "prev_close": prev_price,
        "change_pct": (price / prev_price - 1) * 100 if prev_price else None,
        "rows_available": int(len(df)),
        "ma": ma,
        "ma_dist_pct": ma_dist_pct,
        "ma_alignment": alignment,
        "ma200_slope_pct": ma200_slope,
        "trend_label": trend,
        "cross_25_75": _recent_cross(df["ma25"], df["ma75"], lookback),
        "rsi14": _f(last["rsi"]),
        "macd": _f(last["macd"]),
        "macd_signal": _f(last["macd_signal"]),
        "macd_hist": _f(last["macd_hist"]),
        "macd_hist_prev5": hist_prev5,
        "macd_cross": _recent_cross(df["macd"], df["macd_signal"], lookback),
        "bb": {
            "upper": _f(last["bb_upper"]),
            "mid": _f(last["bb_mid"]),
            "lower": _f(last["bb_lower"]),
            "pct_b": _div(price - _f(last["bb_lower"]) if _f(last["bb_lower"]) is not None else None,
                          (_f(last["bb_upper"]) - _f(last["bb_lower"])) if _f(last["bb_upper"]) is not None else None),
            "bandwidth_pct": _div((_f(last["bb_upper"]) - _f(last["bb_lower"])) if _f(last["bb_upper"]) is not None else None, _f(last["bb_mid"])),
        },
        "atr14": atr,
        "atr_pct": (atr / price * 100) if atr and price else None,
        "high_52w": high_52w,
        "low_52w": low_52w,
        "pos_52w_pct": pos_52w,
        "dist_from_52w_high_pct": (price / high_52w - 1) * 100 if high_52w else None,
        "dist_from_52w_low_pct": (price / low_52w - 1) * 100 if low_52w else None,
        "returns_pct": returns,
        "benchmark": {"ticker": bench_ticker, "returns_pct": bench_returns},
        "relative_strength_3m_pct": rs_3m,
        "volume": {
            "last": last_vol,
            "avg20": avg20,
            "avg60": avg60,
            "ratio_20_60": _div(avg20, avg60),
            "ratio_last_20": _div(last_vol, avg20),
        },
        "support": support,
        "resistance": resistance,
        "series": series,
    }


def score_trend(tech: dict[str, Any]) -> dict[str, Any]:
    """トレンドフォロー視点の「株価の強さ」を0〜100点で採点する(高いほど上昇トレンドが強い)。"""
    items: list[dict[str, Any]] = []
    price = tech["price"]
    ma = tech["ma"]
    ma25, ma75, ma200 = ma.get("25"), ma.get("75"), ma.get("200")

    def above(label: str, value: float | None, pts: int) -> dict[str, Any]:
        if value is None:
            return _item(label, "データ不足", 0, pts, "")
        ok = price > value
        return _item(label, f"{'上' if ok else '下'}({(price / value - 1) * 100:+.1f}%)", pts if ok else 0, pts, "")

    items.append(above("終値 vs 200日線", ma200, 10))
    items.append(above("終値 vs 75日線", ma75, 5))
    items.append(above("終値 vs 25日線", ma25, 5))
    if ma25 and ma75 and ma200 and ma25 > ma75 > ma200:
        items.append(_item("移動平均の配列", "上昇配列(25>75>200)", 10, 10, "パーフェクトオーダー"))
    elif ma25 and ma75 and ma25 > ma75:
        items.append(_item("移動平均の配列", "25日>75日(200日は未達/不足)", 5, 10, ""))
    else:
        items.append(_item("移動平均の配列", tech["ma_alignment"], 0, 10, ""))
    slope = tech.get("ma200_slope_pct")
    items.append(_item("200日線の向き(20日前比)", fmt_pct(slope, signed=True) if slope is not None else "データ不足",
                       5 if slope is not None and slope > 0 else 0, 5, "長期トレンドの方向"))

    macd, sig, hist, hist_prev = tech.get("macd"), tech.get("macd_signal"), tech.get("macd_hist"), tech.get("macd_hist_prev5")
    macd_ok = macd is not None and sig is not None and macd > sig
    items.append(_item("MACD vs シグナル", "MACD>シグナル(強気)" if macd_ok else "MACD<シグナル(弱気)", 10 if macd_ok else 0, 10, ""))
    hist_up = hist is not None and hist_prev is not None and hist > hist_prev
    items.append(_item("MACDヒストグラム(5日前比)", "改善" if hist_up else "悪化/横ばい", 5 if hist_up else 0, 5, "勢いの変化"))

    d52 = tech.get("dist_from_52w_high_pct")
    if d52 is None:
        p52 = 0
    elif d52 >= -5:
        p52 = 15
    elif d52 >= -15:
        p52 = 10
    elif d52 >= -30:
        p52 = 5
    else:
        p52 = 0
    items.append(_item("52週高値からの距離", fmt_pct(d52, signed=True), p52, 15, "高値圏ほど高得点(ブレイクアウト期待)"))

    rs = tech.get("relative_strength_3m_pct")
    bench = tech.get("benchmark", {}).get("ticker") or "指数"
    rs_pts = 15 if rs is not None and rs >= 10 else (8 if rs is not None and rs > 0 else 0)
    items.append(_item(f"相対強度(3ヶ月、対{bench})", fmt_pct(rs, signed=True), rs_pts, 15, "指数を上回っているか"))

    rsi = tech.get("rsi14")
    if rsi is None:
        rsi_pts = 0
    elif 50 <= rsi <= 70:
        rsi_pts = 10
    elif 40 <= rsi < 50:
        rsi_pts = 5
    elif 30 <= rsi < 40:
        rsi_pts = 2
    else:
        rsi_pts = 0
    items.append(_item("RSI(14)", fmt_num(rsi, 1), rsi_pts, 10, "50〜70が健全な上昇、70超は過熱、30未満は売られすぎ"))

    v = tech.get("volume", {})
    r2060 = v.get("ratio_20_60")
    ret1m = tech.get("returns_pct", {}).get("1M")
    if r2060 is not None and r2060 >= 1.2 and ret1m is not None and ret1m > 0:
        vol_pts, vol_text = 10, f"出来高増加(20日平均/60日平均 {r2060:.2f}倍)+株価上昇"
    elif r2060 is not None and r2060 >= 1.0:
        vol_pts, vol_text = 5, f"出来高は平常〜やや増加({r2060:.2f}倍)"
    else:
        vol_pts, vol_text = 0, f"出来高減少({r2060:.2f}倍)" if r2060 is not None else "データ不足"
    items.append(_item("出来高トレンド", vol_text, vol_pts, 10, "上昇に出来高が伴っているか"))

    return {"total": sum(i["points"] for i in items), "max": 100, "items": items}


def classify_timing(tech: dict[str, Any]) -> dict[str, Any]:
    """逆張り視点のタイミング区分。トレンド強度スコアとは別軸で「今買いやすい位置か」を見る。"""
    rsi = tech.get("rsi14")
    pct_b = tech.get("bb", {}).get("pct_b")
    price = tech["price"]
    ma25, ma75 = tech["ma"].get("25"), tech["ma"].get("75")
    if (rsi is not None and rsi <= 30) or (pct_b is not None and pct_b <= 0):
        return {
            "label": "売られすぎ",
            "level": "warning",
            "reason": f"RSI {fmt_num(rsi, 1)}・ボリンジャー%B {fmt_num(pct_b, 2)}。短期的な反発余地はあるが、下降トレンド中なら『落ちるナイフ』の可能性",
        }
    if (rsi is not None and rsi >= 70) or (pct_b is not None and pct_b >= 1):
        return {
            "label": "過熱",
            "level": "serious",
            "reason": f"RSI {fmt_num(rsi, 1)}・ボリンジャー%B {fmt_num(pct_b, 2)}。新規の追いかけ買いは高値掴みになりやすい",
        }
    if tech["trend_label"] == "上昇トレンド" and ma25 and ma75 and ma75 <= price < ma25:
        return {
            "label": "押し目",
            "level": "good",
            "reason": f"上昇トレンド中で25日線({ma25:,.1f})を割り75日線({ma75:,.1f})の上で推移。トレンド内の調整局面",
        }
    return {"label": "中立", "level": "neutral", "reason": f"RSI {fmt_num(rsi, 1)}・%B {fmt_num(pct_b, 2)}。過熱でも売られすぎでもない"}


# ------------------------------------------------------------
# 総合所見・リスク
# ------------------------------------------------------------
def combine_verdict(
    fscore: dict[str, Any],
    tscore: dict[str, Any],
    timing: dict[str, Any],
    tech: dict[str, Any],
    is_fund: bool = False,
) -> dict[str, Any]:
    f, t, tm = fscore["total"], tscore["total"], timing["label"]
    price, atr = tech["price"], tech.get("atr14")
    ma25, ma75 = tech["ma"].get("25"), tech["ma"].get("75")
    stop_text = f"{price - 2 * atr:,.1f}(現在値−2ATR)" if atr else "N/A"
    support_text = f"{tech['support']:,.1f}" if tech.get("support") else "N/A"
    resistance_text = f"{tech['resistance']:,.1f}" if tech.get("resistance") else "N/A"
    actions: list[str] = []

    if is_fund:
        # ETF・投資信託は財務諸表が無いのでテクニカルだけで所見を出す
        if tm == "過熱":
            label, level = "△ ETF: 過熱(押し目待ち)", "warning"
        elif t >= 60:
            label, level = "○ ETF: 上昇トレンド(テクニカルのみ評価)", "good"
        elif t < 40:
            label, level = "△ ETF: トレンドが弱い", "serious"
        else:
            label, level = "○ ETF: 中立", "neutral"
        summary = f"ETF・投資信託は財務諸表が無いためファンダメンタルスコアは対象外。トレンド{t}点・タイミング『{tm}』。{timing['reason']}"
        actions += [
            f"買うなら25日線({fmt_num(ma25, 1)})付近の押し目、または抵抗線 {resistance_text} のブレイクを待つ",
            f"損切り目安: {stop_text}",
        ]
    elif f >= 70 and t >= 60 and tm in ("押し目", "中立"):
        label, level = "◎ 有望(好業績 × 上昇トレンド)", "good"
        summary = f"ファンダ{f}点・トレンド{t}点。業績と株価の両方が強く、押し目での分割買いを検討しやすい局面。"
        actions += [
            f"25日線({fmt_num(ma25, 1)})〜75日線({fmt_num(ma75, 1)})への押しで分割買いを検討",
            f"損切り目安: {stop_text}、直近の支持線 {support_text}",
            f"上値の目安: 直近の抵抗線 {resistance_text}(ここを出来高を伴って抜ければ続伸期待)",
        ]
    elif f >= 70 and tm == "過熱":
        label, level = "△ 良い会社だが株価は過熱", "warning"
        summary = f"ファンダ{f}点と内容は良いが、{timing['reason']}"
        actions += [
            f"追いかけ買いは避け、25日線({fmt_num(ma25, 1)})付近までの調整を待つ",
            "既に保有中なら利確ではなく『追加買いを見送る』判断が基本(トレンドは強い)",
        ]
    elif f >= 70 and t < 40:
        label, level = "○ 業績は良いが株価は弱い(逆張り候補)", "warning"
        summary = f"ファンダ{f}点に対しトレンド{t}点。市場に評価されていない、または業績以外の懸念材料がある可能性。"
        actions += [
            "『なぜ株価が弱いか』(業績以外の悪材料・需給・市況)を手動で確認する",
            f"買うなら下げ止まりの確認後: 25日線({fmt_num(ma25, 1)})回復・MACDゴールデンクロス・出来高増",
            f"支持線 {support_text} 割れなら見送り",
        ]
    elif f >= 55 and tm == "売られすぎ":
        label, level = "○ 反発狙いの候補(売られすぎ)", "warning"
        summary = f"ファンダ{f}点で内容は悪くなく、{timing['reason']}"
        actions += [
            "反発狙いは小ロット・短期目線で。反発せず支持線を割るなら撤退",
            f"損切り目安: {stop_text}",
        ]
    elif f < 40 and t >= 60:
        label, level = "△ 株価は強いが業績が伴わない(期待先行)", "serious"
        summary = f"トレンド{t}点に対しファンダ{f}点。テーマ性や将来期待で買われている可能性があり、失望時の下落が大きくなりやすい。"
        actions += [
            "短期のトレンドフォロー限定・ロットを絞る。中長期の保有前提では買わない",
            f"損切り目安: {stop_text}(必ず事前に決める)",
        ]
    elif f < 40 and t < 40:
        label, level = "× 見送り(業績・株価ともに弱い)", "critical"
        summary = f"ファンダ{f}点・トレンド{t}点。現時点で買う理由が見当たらない。"
        actions += ["監視対象から外すか、業績回復(増収増益への転換)を待つ"]
    else:
        label, level = "○ 中立(決め手不足・監視継続)", "neutral"
        summary = f"ファンダ{f}点・トレンド{t}点・タイミング『{tm}』。強い買い材料も売り材料も無い。"
        actions += [
            f"買うなら押し目({fmt_num(ma25, 1)}付近)か、抵抗線 {resistance_text} のブレイクを待つ",
            f"損切り目安: {stop_text}",
        ]

    return {"label": label, "level": level, "summary": summary, "actions": actions}


def risk_flags(
    profile: dict[str, Any],
    rows: list[dict[str, Any]],
    tech: dict[str, Any],
    ratios: dict[str, Any],
    is_jp: bool,
    cfg: dict[str, Any],
) -> list[str]:
    flags: list[str] = []
    latest = rows[-1] if rows else {}
    if (profile.get("quoteType") or "").upper() in ("ETF", "MUTUALFUND", "INDEX"):
        return ["ETF・投資信託のため財務指標の評価は対象外(構成銘柄の集中度・信託報酬・乖離率は手動確認)"]
    if len(rows) < 3:
        flags.append(f"財務データが{len(rows)}期分しかなく、成長性・過去PERの評価は信頼度が低い")
    ni = latest.get("net_income")
    if ni is not None and ni < 0:
        flags.append("直近期は最終赤字。PER・配当性向・ROEは意味を持たないので売上成長とCFで見る")
    unusual = latest.get("unusual_items")
    if unusual and ni and abs(unusual) >= 0.2 * abs(ni):
        flags.append(f"特別損益({fmt_big(unusual, profile.get('currency') or 'JPY')})が純利益の20%以上。一過性要因で利益が歪んでいる可能性")
    gw, eq = latest.get("goodwill_and_intangibles"), latest.get("equity")
    if gw and eq and eq > 0 and gw / eq >= 0.5:
        flags.append(f"のれん・無形資産が自己資本の{gw / eq * 100:.0f}%。M&A由来なら減損リスクに注意")
    avg_vol, price = _f(profile.get("averageVolume")), tech["price"]
    if is_jp and avg_vol and price and avg_vol * price < cfg["min_daily_turnover_jpy"]:
        flags.append(f"平均売買代金が約{avg_vol * price / 1e8:.1f}億円/日と少なく、流動性リスク(売りたい時に売れない・値が飛ぶ)あり")
    ins = ratios.get("insiders_pct")
    if ins is not None and ins >= 0.5:
        flags.append(f"大株主(インサイダー)保有比率{ins * 100:.0f}%。浮動株が少なく値動きが荒くなりやすい")
    beta = ratios.get("beta")
    if beta is not None and beta >= 2:
        flags.append(f"ベータ{beta:.1f}: 市場全体の値動きに対して2倍以上振れる高リスク銘柄")
    atr_pct = tech.get("atr_pct")
    if atr_pct is not None and atr_pct >= 4:
        flags.append(f"日々の値動きが大きい(ATR {atr_pct:.1f}%/日)。ロットを抑える")
    sector = profile.get("sector") or ""
    if sector in ("Financial Services", "Real Estate"):
        flags.append("金融・不動産業は自己資本比率・PBR・流動比率の一般的な目安が当てはまりにくい(スコアは割り引いて見る)")
    if ratios.get("forward_per") is None and ratios.get("analyst_count") is None:
        flags.append("予想PER・アナリスト目標株価のデータなし(小型株に多い)。会社予想は決算短信で手動確認を")
    if tech.get("trend_label") == "下降トレンド":
        flags.append("下降トレンド中。割安指標だけで買うと『バリュートラップ』になりやすい")
    return flags


def position_context(position: dict[str, Any] | None, tech: dict[str, Any]) -> dict[str, Any] | None:
    """watchlist.yaml の shares / avg_cost(取得単価、その銘柄の通貨建て)から評価額・含み損益・損切り目安を出す。"""
    if not position:
        return None
    shares = _f(position.get("shares"))
    avg_cost = _f(position.get("avg_cost"))
    if not shares:
        return None
    price, atr = tech["price"], tech.get("atr14")
    return {
        "shares": shares,
        "avg_cost": avg_cost,
        "current_value": price * shares,
        "unrealized_pnl": ((price - avg_cost) * shares) if avg_cost else None,
        "unrealized_pnl_pct": ((price / avg_cost - 1) * 100) if avg_cost else None,
        "stop_2atr": (price - 2 * atr) if atr else None,
    }


# ------------------------------------------------------------
# エントリポイント
# ------------------------------------------------------------
def analyze_stock(
    ticker: str,
    position: dict[str, Any] | None = None,
    display_name: str | None = None,
    settings: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """1銘柄を分析して辞書で返す。株価データが取れない場合はNone。

    position: watchlist.yaml の要素(shares / avg_cost があれば保有ポジションとして評価)。
    """
    cfg = get_settings(settings)
    ticker = ticker.strip().upper()
    is_jp = ticker.endswith(".T")

    bench_ticker = "^N225" if is_jp else "^GSPC"
    # 4種類の取得は互いに独立なので並列に走らせる(初回の体感待ち時間を短縮)
    with ThreadPoolExecutor(max_workers=4) as pool:
        f_ohlcv = pool.submit(fetchers.get_yf_ohlcv, ticker, cfg["history_period"])
        f_profile = pool.submit(fetchers.get_stock_profile, ticker)
        f_statements = pool.submit(fetchers.get_stock_statements, ticker)
        f_bench = pool.submit(fetchers.get_yf_ohlcv, bench_ticker, "2y")  # 1年リターン算出に252日+1本必要
        ohlcv = f_ohlcv.result()
        profile = f_profile.result() or {}
        statements = f_statements.result() or {"periods": [], "income": {}, "balance": {}, "cashflow": {}, "dividends": []}
        benchmark = f_bench.result()
    if not ohlcv or len([c for c in ohlcv["close"] if c is not None]) < 30:
        return None
    if benchmark:
        benchmark = {**benchmark, "ticker": "日経平均" if is_jp else "S&P500"}

    tech = compute_technicals(ohlcv, benchmark, cfg)
    if tech is None:
        return None
    price = tech["price"]

    rows = build_financial_table(statements)
    dividends = statements.get("dividends") or []
    add_dividends_per_period(rows, dividends)
    add_historical_valuation(rows, ohlcv)
    dps_ttm = dividends_last_12m(dividends, tech["as_of"])
    ratios = build_current_ratios(profile, rows, price, dps_ttm)
    is_fund = (profile.get("quoteType") or "").upper() in ("ETF", "MUTUALFUND", "INDEX")
    fscore = score_fundamentals(rows, ratios)
    fscore["applicable"] = not is_fund
    fair = [] if is_fund else fair_value_reference(rows, ratios, price, cfg)
    tscore = score_trend(tech)
    timing = classify_timing(tech)
    verdict = combine_verdict(fscore, tscore, timing, tech, is_fund)
    flags = risk_flags(profile, rows, tech, ratios, is_jp, cfg)
    currency = profile.get("currency") or ("JPY" if is_jp else "USD")

    notes = [
        f"株価データ: Yahoo Finance {tech['as_of']}終値ベース(5年日足)",
        "財務データ: Yahoo Finance掲載の年次決算(最大5期)。四半期の最新決算は反映されないため、直近の決算短信は手動確認を推奨",
        "スコアは業種を問わず同じ物差しで採点した機械的な参考値。同業他社比較・ビジネスモデルの評価は含まない",
    ]
    if is_fund:
        notes.append("ETF・投資信託のため財務諸表なし(ファンダメンタルスコアは対象外)")
    elif rows:
        notes.append(f"最新の財務データ: {rows[-1]['label']}")
    else:
        notes.append("財務諸表データなし(ファンダメンタルスコアは0点になる)")

    return {
        "ticker": ticker,
        "name": display_name or profile.get("longName") or profile.get("shortName") or ticker,
        "currency": currency,
        "is_jp": is_jp,
        "is_fund": is_fund,
        "as_of": tech["as_of"],
        "price": price,
        "prev_close": tech["prev_close"],
        "change_pct": tech["change_pct"],
        "profile": {
            "sector": profile.get("sector"),
            "industry": profile.get("industry"),
            "exchange": profile.get("exchange"),
            "market_cap": ratios.get("market_cap"),
            "employees": _f(profile.get("fullTimeEmployees")),
            "website": profile.get("website"),
            "summary": profile.get("longBusinessSummary"),
        },
        "financials": rows,
        "ratios": ratios,
        "fundamental_score": fscore,
        "fair_value": fair,
        "technicals": tech,
        "trend_score": tscore,
        "timing": timing,
        "verdict": verdict,
        "risk_flags": flags,
        "position": position_context(position, tech),
        "data_notes": notes,
    }


def one_line_summary(a: dict[str, Any]) -> str:
    return (
        f"{a['name']}({a['ticker']}) {fmt_money(a['price'], a['currency'])} "
        f"| ファンダ{a['fundamental_score']['total']}点 / トレンド{a['trend_score']['total']}点 "
        f"/ {a['timing']['label']} | {a['verdict']['label']}"
    )
