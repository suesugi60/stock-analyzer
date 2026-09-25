"""yfinanceからのデータ取得(日足OHLCV・企業プロファイル・年次財務三表・配当履歴)。

すべて cached_with_retry でラップし、失敗時は前回キャッシュか None を返す。
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf

from stock_analyzer.cache import cached_with_retry


def _clean_number(value: Any) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    if np.isnan(x) or np.isinf(x):
        return None
    return x


@cached_with_retry(cache_key="yf_ohlcv3_{0}_{1}", ttl_seconds=6 * 3600)
def get_yf_ohlcv(ticker: str, period: str) -> dict[str, Any] | None:
    """日足の四本値・出来高をJSON化可能な形式で返す。periodは必ず位置引数で渡す(キャッシュキー用)。

    auto_adjust=False で取得する: Yahooの生データは株式分割は調整済み・配当落ちは未調整なので、
    実際の株価水準のままPERや支持線を見られる(auto_adjust=True だと配当落ち分だけ過去の株価が
    低く表示されてしまう)。
    """
    hist = yf.Ticker(ticker).history(period=period, interval="1d", auto_adjust=False)
    if hist is None or hist.empty:
        return None
    return {
        "dates": [d.strftime("%Y-%m-%d") for d in hist.index],
        "open": [_clean_number(v) for v in hist["Open"].tolist()],
        "high": [_clean_number(v) for v in hist["High"].tolist()],
        "low": [_clean_number(v) for v in hist["Low"].tolist()],
        "close": [_clean_number(v) for v in hist["Close"].tolist()],
        "volume": [_clean_number(v) for v in hist["Volume"].tolist()],
    }


_PROFILE_KEYS = [
    "shortName", "longName", "currency", "exchange", "quoteType", "sector", "industry",
    "marketCap", "enterpriseValue", "currentPrice", "previousClose",
    "trailingPE", "forwardPE", "priceToBook", "priceToSalesTrailing12Months", "enterpriseToEbitda",
    "returnOnEquity", "returnOnAssets", "profitMargins", "operatingMargins",
    "revenueGrowth", "earningsGrowth", "earningsQuarterlyGrowth",
    "debtToEquity", "currentRatio", "totalCash", "totalDebt", "freeCashflow", "operatingCashflow",
    "totalRevenue", "netIncomeToCommon", "bookValue", "trailingEps", "forwardEps",
    "dividendYield", "trailingAnnualDividendYield", "dividendRate", "trailingAnnualDividendRate",
    "payoutRatio", "lastDividendValue", "exDividendDate",
    "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "fiftyDayAverage", "twoHundredDayAverage",
    "averageVolume", "averageVolume10days", "beta", "sharesOutstanding", "floatShares",
    "heldPercentInsiders", "heldPercentInstitutions",
    "targetMeanPrice", "targetHighPrice", "targetLowPrice", "recommendationKey", "numberOfAnalystOpinions",
    "fullTimeEmployees", "website", "longBusinessSummary",
]


@cached_with_retry(cache_key="yf_profile_{0}", ttl_seconds=24 * 3600)
def get_stock_profile(ticker: str) -> dict[str, Any] | None:
    """企業概要と現在のバリュエーション指標(yfinanceのinfo)を必要なキーだけ返す。"""
    info = yf.Ticker(ticker).info
    if not info or len(info) < 5:
        return None
    out: dict[str, Any] = {}
    for key in _PROFILE_KEYS:
        value = info.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = _clean_number(value)
        else:
            out[key] = value
    if out.get("longBusinessSummary"):
        out["longBusinessSummary"] = str(out["longBusinessSummary"])[:600]
    return out


# yfinanceの財務諸表の行名 -> 内部キー。無い行はNoneになる。
_INCOME_ROWS = {
    "revenue": "Total Revenue",
    "gross_profit": "Gross Profit",
    "operating_income": "Operating Income",
    "pretax_income": "Pretax Income",
    "net_income": "Net Income",
    "eps_diluted": "Diluted EPS",
    "eps_basic": "Basic EPS",
    "ebitda": "EBITDA",
    "interest_expense": "Interest Expense",
    "unusual_items": "Total Unusual Items",
    "shares_diluted": "Diluted Average Shares",
}
_BALANCE_ROWS = {
    "total_assets": "Total Assets",
    "equity": "Stockholders Equity",
    "total_debt": "Total Debt",
    "cash": "Cash And Cash Equivalents",
    "cash_and_st_investments": "Cash Cash Equivalents And Short Term Investments",
    "current_assets": "Current Assets",
    "current_liabilities": "Current Liabilities",
    "retained_earnings": "Retained Earnings",
    "shares_outstanding": "Ordinary Shares Number",
    "goodwill_and_intangibles": "Goodwill And Other Intangible Assets",
    "net_debt": "Net Debt",
}
_CASHFLOW_ROWS = {
    "operating_cf": "Operating Cash Flow",
    "investing_cf": "Investing Cash Flow",
    "financing_cf": "Financing Cash Flow",
    "free_cf": "Free Cash Flow",
    "capex": "Capital Expenditure",
    "dividends_paid": "Cash Dividends Paid",
    "buybacks": "Repurchase Of Capital Stock",
    "depreciation": "Depreciation And Amortization",
}


def _period_columns(df: pd.DataFrame | None) -> dict[str, Any]:
    """列(決算期のTimestamp) -> 'YYYY-MM-DD' の対応表。TTM等の非日付列は無視する。"""
    if df is None or df.empty:
        return {}
    return {col.strftime("%Y-%m-%d"): col for col in df.columns if isinstance(col, pd.Timestamp)}


def _extract_rows(df: pd.DataFrame | None, mapping: dict[str, str], periods: list[str]) -> dict[str, list]:
    cols = _period_columns(df)
    out: dict[str, list] = {}
    for key, label in mapping.items():
        values = []
        for p in periods:
            value = None
            if df is not None and label in df.index and p in cols:
                try:
                    value = _clean_number(df.at[label, cols[p]])
                except (KeyError, TypeError, ValueError):
                    value = None
            values.append(value)
        out[key] = values
    return out


@cached_with_retry(cache_key="yf_statements_{0}", ttl_seconds=24 * 3600)
def get_stock_statements(ticker: str) -> dict[str, Any] | None:
    """年次の損益計算書・貸借対照表・キャッシュフロー(最大5期)と配当履歴を返す。

    ETF等で財務諸表が無い銘柄は periods が空の辞書を返す(Noneではない)。
    """
    tk = yf.Ticker(ticker)
    fin = tk.financials
    bs = tk.balance_sheet
    cf = tk.cashflow
    periods = sorted(set(_period_columns(fin)) | set(_period_columns(bs)) | set(_period_columns(cf)))

    dividends: list[dict[str, Any]] = []
    try:
        div = tk.dividends
        if div is not None and not div.empty:
            for ts, amount in div.items():
                value = _clean_number(amount)
                if value:
                    dividends.append({"date": ts.strftime("%Y-%m-%d"), "amount": value})
    except Exception:  # noqa: BLE001 - 配当履歴は補助情報なので失敗しても本体は返す
        pass

    return {
        "periods": periods,
        "income": _extract_rows(fin, _INCOME_ROWS, periods),
        "balance": _extract_rows(bs, _BALANCE_ROWS, periods),
        "cashflow": _extract_rows(cf, _CASHFLOW_ROWS, periods),
        "dividends": dividends,
    }
