"""投資信託(ファンド)のデータ取得: 投信総合検索ライブラリー(資産運用業協会)から検索・属性・基準価額履歴を取る。

- 検索/属性: FDST999900/fundDataSearch(JSON)。信託報酬・純資産・期間リターン・リスク・シャープレシオ・
  カテゴリ内順位・決算頻度・分配金・NISA対象・販売会社一覧(楽天証券の取扱有無)まで一度に取れる
- 履歴: FDST030000/csv-file-download(CSV)。設定来の基準価額・純資産総額・分配金
いずれも cached_with_retry でキャッシュし、アクセス頻度を抑える。
"""
from __future__ import annotations

import csv
import io
import json
import re
import unicodedata
from typing import Any

import requests

from stock_analyzer.cache import cached_with_retry

SEARCH_URL = "https://toushin-lib.fwg.ne.jp/FdsWeb/FDST999900/fundDataSearch"
CSV_URL = "https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download"
DETAIL_URL = "https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000"
RAKUTEN_URL = "https://www.rakuten-sec.co.jp/web/fund/detail/?ID={isin}"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://toushin-lib.fwg.ne.jp/FdsWeb/FDST999900",
}
_ARRAY_FIELDS = [
    "s_investAssetKindCd", "s_investArea3kindCd", "s_instCd", "s_fdsInstCd", "s_dcFundCD", "t_investArea10kindCd",
    "t_investAssetKindCd", "t_instCd", "t_fdsInstCd", "s_investArea10kindCd", "s_setlFqcy", "s_dividend1y",
    "s_totalNetAssets", "s_nowToRedemptionDate", "s_establishedDateToNow", "s_dcFundCD", "s_isinCd",
]
ISIN_RE = re.compile(r"^JP90C[0-9A-Z]{7}$")

# 資産運用業協会の商品分類コード(投資対象資産・地域)
ASSET_KIND = {"1": "株式", "2": "債券", "3": "不動産投信", "4": "その他資産", "5": "資産複合"}
AREA_KIND = {"1": "国内", "2": "海外", "3": "内外"}


def _f(value: Any) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    if x != x:  # NaN
        return None
    return x


def _nfkc(text: Any) -> str:
    return unicodedata.normalize("NFKC", str(text or "")).replace("　", " ").strip()


def _rank(text: Any) -> tuple[int, int] | None:
    m = re.match(r"^\s*(\d+)\s*/\s*(\d+)\s*$", str(text or ""))
    return (int(m.group(1)), int(m.group(2))) if m else None


def _post_search(keyword: str = "", isin: str | None = None, start: int = 0) -> dict[str, Any]:
    body: dict[str, Any] = {field: [] for field in _ARRAY_FIELDS}
    body.update({"t_keyword": keyword, "t_kensakuKbn": "1", "t_searchInfoFlag": "1", "startNo": start, "draw": 1, "searchBtnClickFlg": True})
    if isin:
        body["s_isinCd"] = [isin]
    resp = requests.post(SEARCH_URL, data=json.dumps(body), headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json().get("searchResultInfo") or {}


def normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    """検索APIの1行を、単位を揃えた扱いやすい辞書にする。"""
    sellers = [_nfkc(i.get("instName")) for i in (row.get("institutionInfo") or []) if i.get("instName")]
    rakuten = any("楽天証券" in s for s in sellers)
    dividends = []
    for d in row.get("dividendInfo") or []:
        if d.get("setlDate"):
            dividends.append({"date": str(d["setlDate"])[:10], "amount": _f(d.get("dividend")) or 0.0})
    settle_freq = _f(row.get("setlFqcy"))
    asset = ASSET_KIND.get(str(row.get("investAssetKindCd") or ""), "")
    area = AREA_KIND.get(str(row.get("investArea3kindCd") or ""), "")
    redemption = str(row.get("redemptionDate") or "")
    return {
        "kind": "fund",
        "isin": row.get("isinCd"),
        "assoc": row.get("associFundCd"),
        "name": _nfkc(row.get("fundNm") or row.get("fundStNm")),
        "nickname": _nfkc(row.get("fundNkNm")),
        "company": _nfkc(row.get("entrustCmpNm")),
        "category": " ".join(x for x in (area, asset) if x),
        "category_code": str(row.get("fundCategory") or ""),
        "as_of": str(row.get("standardDate") or "")[:10],
        "nav": _f(row.get("standardPrice")),
        "change": _f(row.get("stdCostPointFrmDayBfr")),
        "change_pct": _f(row.get("stdCostPointFrmDayBfrRt")),
        "net_assets_million": _f(row.get("totalNetAssets")),
        "trust_reward_pct": _f(row.get("trustReward")),
        "buy_fee_pct": _f(row.get("buyFee")),
        "established": str(row.get("establishedDate") or "")[:10],
        "months_running": _f(row.get("establishedDateToNow")),
        "redemption": "無期限" if redemption.startswith("9999") or not redemption else redemption[:10],
        "settle_per_year": int(settle_freq) if settle_freq else None,
        "settle_date": row.get("setlDate"),
        "dividend_1y": _f(row.get("dividend1y")),
        "dividend_last": _f(row.get("dividendLast")),
        "dividend_history": dividends,
        "nisa_tsumitate": str(row.get("nisaFlg")) == "1",
        "nisa_growth": str(row.get("nisaGrowthFlg")) == "1",
        "returns_pct": {k: _f(row.get(f"standardPriceRa{k}")) for k in ("6m", "1y", "3y", "5y", "10y")},
        "risk_pct": {k: (_f(row.get(f"riskRa{k}")) * 100 if _f(row.get(f"riskRa{k}")) is not None else None) for k in ("6m", "1y", "3y", "5y", "10y")},
        "sharpe": {k: _f(row.get(f"sharpRa{k}")) for k in ("6m", "1y", "3y", "5y", "10y")},
        "rank_return": {k: _rank(row.get(f"rankStandardPriceRa{k}")) for k in ("6m", "1y", "3y", "5y", "10y")},
        "rank_sharpe": {k: _rank(row.get(f"rankSharpRa{k}")) for k in ("6m", "1y", "3y", "5y", "10y")},
        "rank_risk": {k: _rank(row.get(f"rankRiskRa{k}")) for k in ("6m", "1y", "3y", "5y", "10y")},
        "flow_million": {
            "1m": _f(row.get("monthlyCancelCreateVal")),
            "3m": _f(row.get("monthlyCancelCreateVal3")),
            "6m": _f(row.get("monthlyCancelCreateVal6")),
            "12m": _f(row.get("monthlyCancelCreateVal12")),
        },
        "eval_discrepancy": str(row.get("evalDiscrepancyFlag")) == "1",
        "report_url": row.get("reportUrl"),
        "sellers_count": len(sellers),
        "rakuten_available": rakuten,
        "rakuten_url": RAKUTEN_URL.format(isin=row.get("isinCd")),
        "library_url": f"{DETAIL_URL}?isinCd={row.get('isinCd')}&associFundCd={row.get('associFundCd')}",
    }


@cached_with_retry(cache_key="fund_search_{0}", ttl_seconds=6 * 3600, retries=2)
def _search_cached(keyword: str) -> list[dict[str, Any]] | None:
    info = _post_search(keyword=keyword)
    rows = info.get("resultInfoMapList") or []
    return [normalize_row(r) for r in rows[:30]] or []


def search_funds(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """ファンド名(部分一致・スペース区切りでAND)で検索。ISINを渡した場合はその1件。"""
    q = _nfkc(query)
    if not q:
        return []
    if ISIN_RE.match(q.upper()):
        row = get_fund_row(q.upper())
        return [row] if row else []
    return (_search_cached(q) or [])[:limit]


@cached_with_retry(cache_key="fund_row_{0}", ttl_seconds=12 * 3600, retries=2)
def get_fund_row(isin: str) -> dict[str, Any] | None:
    info = _post_search(isin=isin)
    rows = info.get("resultInfoMapList") or []
    return normalize_row(rows[0]) if rows else None


@cached_with_retry(cache_key="fund_history_{0}", ttl_seconds=12 * 3600, retries=2)
def get_fund_history(isin: str, assoc: str) -> dict[str, Any] | None:
    """設定来の基準価額・純資産総額(百万円)・分配金をCSVから取る。"""
    resp = requests.get(CSV_URL, params={"isinCd": isin, "associFundCd": assoc}, headers={"User-Agent": HEADERS["User-Agent"]}, timeout=60)
    resp.raise_for_status()
    # 文字コードはUTF-8(BOM付き)とShift_JISが混在するため、ヘッダーが読めた方を採用する
    text = ""
    for encoding in ("utf-8-sig", "cp932"):
        try:
            candidate = resp.content.decode(encoding)
        except UnicodeDecodeError:
            continue
        if "基準価額" in candidate[:200]:
            text = candidate
            break
    if not text:
        return None
    reader = csv.reader(io.StringIO(text))
    next(reader, None)  # ヘッダー行
    dates, nav, assets, dividends = [], [], [], []
    for cols in reader:
        if len(cols) < 3 or not cols[0]:
            continue
        m = re.match(r"(\d{4})年(\d{2})月(\d{2})日", cols[0])
        if not m:
            continue
        date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
        price = _f(cols[1])
        if price is None:
            continue
        dates.append(date)
        nav.append(price)
        assets.append(_f(cols[2]))
        div = _f(cols[3]) if len(cols) > 3 else None
        if div:
            dividends.append({"date": date, "amount": div})
    if not dates:
        return None
    return {"dates": dates, "nav": nav, "net_assets_million": assets, "dividends": dividends}
