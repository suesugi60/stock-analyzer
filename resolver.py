"""入力(証券コード・ティッカー・社名)を Yahoo Finance のティッカーに解決する。

「調べたい銘柄をすぐ調べる」ための入口。次の順で候補を作る:
1. 4桁コード(7203 / 130A)や .T 付き → そのまま日本株ティッカー(社名はJPXの上場銘柄一覧から補完)
2. 英字ティッカーらしき入力(AAPL / BRK-B) → Yahoo検索で実在確認しつつ候補化
3. 社名(トヨタ / 任天堂 / アップル / エヌビディア / Toyota / Apple)
   → JPX上場銘柄一覧の部分一致 + Wikidata由来の米国企業リスト(日本語名・別名・英語名) + Yahoo検索

JPXの一覧(約4,000銘柄、7日)と米国企業リスト(約4,000社、30日)は 銘柄分析/cache/ にキャッシュし、
取得できない時はYahoo検索だけで動く。
"""
from __future__ import annotations

import functools
import io
import re
import unicodedata
from typing import Any

import pandas as pd
import requests

from stock_analyzer.cache import cached_with_retry

JPX_LIST_PAGE = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"}

_JP_CODE = re.compile(r"^\d{4}[0-9A-Z]?$")
_JP_TICKER = re.compile(r"^\d{4}[0-9A-Z]?\.T$")
_US_TICKER = re.compile(r"^[A-Z^][A-Z0-9.\-=]{0,9}$")


def _norm(text: str) -> str:
    """全角/半角・大文字小文字・空白・記号ゆれを吸収した比較用文字列。"""
    text = unicodedata.normalize("NFKC", str(text or "")).casefold()
    for ch in (" ", "　", "・", "、", "･", "(", ")", "（", "）", "株式会社", "(株)"):
        text = text.replace(ch, "")
    return text


@cached_with_retry(cache_key="jpx_listed", ttl_seconds=7 * 24 * 3600, retries=2)
def _fetch_jpx_list() -> list[dict[str, Any]] | None:
    """JPX「東証上場銘柄一覧」のExcelを取得して銘柄の辞書リストにする(リンク先は毎回ページから探す)。"""
    page = requests.get(JPX_LIST_PAGE, headers=UA, timeout=30)
    page.raise_for_status()
    links = re.findall(r'href="([^"]+data_j\.xlsx?)"', page.text)
    if not links:
        return None
    url = links[0] if links[0].startswith("http") else "https://www.jpx.co.jp" + links[0]
    resp = requests.get(url, headers=UA, timeout=60)
    resp.raise_for_status()
    engine = "openpyxl" if url.endswith("xlsx") else "xlrd"
    df = pd.read_excel(io.BytesIO(resp.content), engine=engine)

    def col(*keys: str) -> str | None:
        for c in df.columns:
            if any(k in str(c) for k in keys):
                return c
        return None

    c_code, c_name = col("コード"), col("銘柄名")
    c_market, c_s33, c_s17, c_size = col("市場"), col("33業種区分"), col("17業種区分"), col("規模区分")
    if not c_code or not c_name:
        return None
    items = []
    for _, row in df.iterrows():
        code = str(row[c_code]).strip()
        if not _JP_CODE.match(code):
            continue
        market = str(row[c_market]) if c_market else ""
        # ETF・REIT・投信なども一覧に含まれるが、名前検索の対象としてはそのまま残す
        items.append(
            {
                "code": code,
                "ticker": f"{code}.T",
                "name": str(row[c_name]).strip(),
                "market": market.replace("（内国株式）", "").replace("(内国株式)", ""),
                "sector33": str(row[c_s33]) if c_s33 and str(row[c_s33]) != "-" else "",
                "sector17": str(row[c_s17]) if c_s17 and str(row[c_s17]) != "-" else "",
                "size": str(row[c_size]) if c_size and str(row[c_size]) != "-" else "",
            }
        )
    return items or None


@functools.lru_cache(maxsize=1)
def jpx_list() -> list[dict[str, Any]]:
    return _fetch_jpx_list() or []


@functools.lru_cache(maxsize=1)
def _jpx_by_code() -> dict[str, dict[str, Any]]:
    return {item["code"]: item for item in jpx_list()}


def jpx_lookup(code_or_ticker: str) -> dict[str, Any] | None:
    code = code_or_ticker.upper().replace(".T", "")
    return _jpx_by_code().get(code)


WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
_US_QUERY = """
SELECT ?item ?ticker ?exchange ?en ?ja (GROUP_CONCAT(DISTINCT ?alt; separator="|") AS ?alts) WHERE {
  VALUES ?exchange { wd:Q82059 wd:Q13677 }
  ?item p:P414 ?st . ?st ps:P414 ?exchange . ?st pq:P249 ?ticker .
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en)="en") }
  OPTIONAL { ?item rdfs:label ?ja FILTER(LANG(?ja)="ja") }
  OPTIONAL { ?item skos:altLabel ?alt FILTER(LANG(?alt)="ja") }
} GROUP BY ?item ?ticker ?exchange ?en ?ja
"""
_US_SYMBOL = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")


@cached_with_retry(cache_key="wikidata_us_listed", ttl_seconds=30 * 24 * 3600, retries=1)
def _fetch_us_list() -> list[dict[str, Any]] | None:
    """Wikidataから NYSE / NASDAQ 上場企業のティッカー・英語名・日本語名・日本語別名を取得する。

    「アップル」「エヌビディア」「グーグル」のようなカタカナ名で米国株を探すための辞書。
    約4,000件・日本語名ありは約半分(主要企業はほぼ網羅)。30日キャッシュ。
    """
    resp = requests.get(
        WIKIDATA_SPARQL,
        params={"query": _US_QUERY, "format": "json"},
        headers={"User-Agent": "buzzraseya-stock-analyzer/1.0 (personal use)"},
        timeout=120,
    )
    resp.raise_for_status()
    rows = resp.json()["results"]["bindings"]
    by_ticker: dict[str, dict[str, Any]] = {}
    for row in rows:
        symbol = row["ticker"]["value"].strip().upper()
        if not _US_SYMBOL.match(symbol):
            continue
        ticker = symbol.replace(".", "-")  # BRK.B -> BRK-B (Yahoo形式)
        en = row.get("en", {}).get("value", "")
        ja = re.sub(r"\s*\(.*?\)$", "", row.get("ja", {}).get("value", "")).strip()  # 「ネットフリックス (企業)」→「ネットフリックス」
        aliases = [a for a in row.get("alts", {}).get("value", "").split("|") if a]
        exchange = "NASDAQ" if row["exchange"]["value"].endswith("Q82059") else "NYSE"
        item = by_ticker.setdefault(ticker, {"ticker": ticker, "name_en": en, "name_ja": ja, "aliases": [], "exchange": exchange})
        if not item["name_en"] and en:
            item["name_en"] = en
        if not item["name_ja"] and ja:
            item["name_ja"] = ja
        for alias in aliases + ([en] if en else []) + ([ja] if ja else []):
            if alias and alias not in item["aliases"]:
                item["aliases"].append(alias)
    return list(by_ticker.values()) or None


@functools.lru_cache(maxsize=1)
def us_list() -> list[dict[str, Any]]:
    return _fetch_us_list() or []


def _us_display_name(item: dict[str, Any]) -> str:
    if item["name_ja"] and item["name_en"] and item["name_ja"] != item["name_en"]:
        return f"{item['name_ja']}({item['name_en']})"
    return item["name_ja"] or item["name_en"] or item["ticker"]


_COMPANY_SUFFIXES = ("ホールディングス", "ホールディング", "グループ", "hd", "株式会社", "inc.", "inc", "corporation", "corp.", "corp",
                     "co.,ltd.", "co.,ltd", "co.ltd", "ltd.", "ltd", "company", "group", "plc")


def _norm_company(name: str) -> str:
    """比較用に「グループ」「ホールディングス」「Inc.」などの接尾辞を落とす(ソニー→ソニーグループ を完全一致扱いに)。"""
    n = _norm(name)
    changed = True
    while changed:
        changed = False
        for suffix in _COMPANY_SUFFIXES:
            if len(n) > len(suffix) and n.endswith(suffix):
                n = n[: -len(suffix)].rstrip(".,・ ")
                changed = True
    return n


def _match_tier(key: str, names: list[str]) -> int | None:
    """0=完全一致, 1=前方一致, 2=部分一致(3文字以上), None=不一致。"""
    if not key:
        return None
    if any(n == key for n in names):
        return 0
    if any(n.startswith(key) for n in names):
        return 1
    if len(key) >= 3 and any(key in n for n in names):
        return 2
    return None


def _search_us_list(key: str, max_results: int) -> list[dict[str, Any]]:
    """正規化した検索語で米国企業リストの英語名・日本語名・別名を 完全一致→前方一致→部分一致 の順に探す。"""
    hits = []
    for item in us_list():
        tier = _match_tier(key, [_norm(n) for n in item["aliases"]] + [_norm_company(n) for n in item["aliases"]])
        if tier is not None:
            hits.append((tier, item))
    hits.sort(key=lambda x: x[0])
    return [
        _candidate(i["ticker"], _us_display_name(i), i["exchange"], "wikidata", {"tier": tier})
        for tier, i in hits[:max_results]
    ]


def _candidate(ticker: str, name: str, exchange: str = "", source: str = "direct", extra: dict | None = None) -> dict[str, Any]:
    return {"ticker": ticker, "name": name, "exchange": exchange, "source": source, **(extra or {})}


def _yahoo_search(query: str, limit: int) -> list[dict[str, Any]]:
    try:
        import yfinance as yf

        quotes = yf.Search(query, max_results=limit).quotes or []
    except Exception:  # noqa: BLE001 - 検索は補助機能なので失敗しても空で返す
        return []
    out = []
    for q in quotes:
        symbol = q.get("symbol")
        if not symbol or q.get("quoteType") not in ("EQUITY", "ETF"):
            continue
        name = q.get("longname") or q.get("shortname") or symbol
        jpx = jpx_lookup(symbol) if symbol.endswith(".T") else None
        out.append(_candidate(symbol, jpx["name"] if jpx else name, q.get("exchange") or "", "yahoo", {"sector33": jpx["sector33"] if jpx else "", "market": jpx["market"] if jpx else ""}))
    return out


def resolve(query: str, max_results: int = 8) -> list[dict[str, Any]]:
    """入力を候補ティッカーの一覧に解決する。1件なら即分析、複数なら選択、0件なら見つからず。"""
    raw = unicodedata.normalize("NFKC", (query or "").strip())
    if not raw:
        return []
    upper = raw.upper()
    key = _norm(raw)

    # 1. 日本株の証券コード / .T 付きティッカー
    if _JP_CODE.match(upper) or _JP_TICKER.match(upper):
        code = upper.replace(".T", "")
        jpx = jpx_lookup(code)
        if jpx:
            return [_candidate(jpx["ticker"], jpx["name"], "JPX", "jpx", {"sector33": jpx["sector33"], "market": jpx["market"]})]
        return [_candidate(f"{code}.T", f"{code}.T", "JPX", "direct")]

    results: list[dict[str, Any]] = []
    seen: set[str] = set()

    def push(items: list[dict[str, Any]]) -> None:
        for c in items:
            if c["ticker"] not in seen and len(results) < max_results:
                results.append(c)
                seen.add(c["ticker"])

    # 2. 英字ティッカーらしき入力: Yahoo検索でシンボル完全一致なら即決(AAPL / BRK-B)
    if _US_TICKER.match(upper) and not re.search(r"[ぁ-んァ-ン一-龥]", raw):
        found = _yahoo_search(upper, max_results)
        exact = [c for c in found if c["ticker"].upper() == upper]
        if exact:
            return exact
        # 社名を英字で打った可能性(APPLE / Toyota): 米国企業リスト → Yahoo検索の順で候補化
        push(_search_us_list(key, max_results))
        push(found)
        if not results:
            return [_candidate(upper, upper, "", "direct")]
        return results

    # 3. 社名検索: JPX一覧(日本語)と米国企業リスト(日本語名・別名・英語名)を 完全一致→前方一致→部分一致 で
    #    まとめて順位付けし、足りなければ Yahoo検索(英語名)で補う
    hits = []  # (一致の強さ, 東証なら0/米国なら1, 候補) の順に並べる(同点なら東証上場を優先)
    for item in jpx_list():
        tier = _match_tier(key, [_norm(item["name"]), _norm_company(item["name"])])
        if tier is not None:
            hits.append((tier, 0, _candidate(item["ticker"], item["name"], "JPX", "jpx", {"sector33": item["sector33"], "market": item["market"]})))
    for c in _search_us_list(key, max_results * 2):
        hits.append((c.pop("tier", 2), 1, c))
    hits.sort(key=lambda x: (x[0], x[1]))
    push([c for _, _, c in hits])
    if len(results) < max_results:
        push(_yahoo_search(raw, max_results))
    return results


def describe(candidate: dict[str, Any]) -> str:
    """候補の表示用ラベル: 社名(ティッカー) 市場・業種"""
    bits = [f"{candidate['name']}({candidate['ticker']})"]
    extra = " ".join(x for x in (candidate.get("market"), candidate.get("sector33")) if x)
    if extra:
        bits.append(extra)
    elif candidate.get("exchange"):
        bits.append(candidate["exchange"])
    return " ".join(bits)
