"""パス設定と、ウォッチリスト(watchlist.yaml)・閾値設定(settings.yaml)の読み書き。

オーナーのMacでは実データ・レポート・キャッシュを ~/Dropbox/buzzraseya/銘柄分析/ に置く
(GitHubには同期されない)。それ以外の環境(Streamlit Community Cloud など、Web公開版)では
自動的に「共有モード」になり、パッケージ隣の data/ をキャッシュ置き場にしつつ、
ウォッチリスト・最近の履歴・質問ログはファイルに残さない(利用者ごとにセッション内で保持)。
環境変数 STOCK_ANALYZER_DATA_DIR / STOCK_ANALYZER_SHARED=1 で明示的に切り替えることもできる。
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

_OWNER_BASE = Path.home() / "Dropbox" / "buzzraseya" / "銘柄分析"
if os.environ.get("STOCK_ANALYZER_DATA_DIR"):
    BASE_DIR = Path(os.environ["STOCK_ANALYZER_DATA_DIR"]).expanduser()
elif _OWNER_BASE.parent.exists():
    BASE_DIR = _OWNER_BASE
else:
    BASE_DIR = Path(__file__).resolve().parent / "data"
SHARED_MODE = os.environ.get("STOCK_ANALYZER_SHARED") == "1" or not _OWNER_BASE.parent.exists()
CONFIG_DIR = BASE_DIR / "config"
REPORT_DIR = BASE_DIR / "reports"
CACHE_DIR = BASE_DIR / "cache"
WATCHLIST_PATH = CONFIG_DIR / "watchlist.yaml"
SETTINGS_PATH = CONFIG_DIR / "settings.yaml"
RECENT_PATH = CONFIG_DIR / "recent.json"
SECRETS_PATH = CONFIG_DIR / "secrets.yaml"


def ensure_dirs() -> None:
    for d in (CONFIG_DIR, REPORT_DIR, CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)


def load_watchlist() -> list[dict[str, Any]]:
    """watchlist.yaml の銘柄一覧。各要素: ticker(必須)・name・note・shares・avg_cost(任意)。"""
    if not WATCHLIST_PATH.exists():
        return []
    with WATCHLIST_PATH.open(encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    items = data.get("watchlist") or []
    cleaned = []
    for item in items:
        if not item or not item.get("ticker"):
            continue
        item = dict(item)
        item["ticker"] = str(item["ticker"]).strip().upper()
        cleaned.append(item)
    return cleaned


def save_watchlist(items: list[dict[str, Any]]) -> None:
    ensure_dirs()
    with WATCHLIST_PATH.open("w", encoding="utf-8") as f:
        yaml.safe_dump({"watchlist": items}, f, allow_unicode=True, sort_keys=False)


def load_settings() -> dict[str, Any]:
    """settings.yaml の閾値上書き(無ければ空)。キーは analysis.DEFAULTS と同じ。"""
    if not SETTINGS_PATH.exists():
        return {}
    with SETTINGS_PATH.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_recent() -> list[dict[str, Any]]:
    """最近調べた銘柄(新しい順)。ダッシュボードのワンクリック再表示用。"""
    if not RECENT_PATH.exists():
        return []
    try:
        return json.loads(RECENT_PATH.read_text(encoding="utf-8")) or []
    except (json.JSONDecodeError, OSError):
        return []


def add_recent(key: str, name: str | None, kind: str = "stock", limit: int = 20, **extra: Any) -> None:
    """最近調べた銘柄に追加(同じ銘柄は先頭に移動)。key は株式ならティッカー、投信ならISIN。"""
    ensure_dirs()
    items = []
    for r in load_recent():
        r_key = r.get("key") or r.get("ticker")
        if (r.get("kind", "stock"), r_key) != (kind, key):
            items.append(r)
    items.insert(0, {"kind": kind, "key": key, "name": name or key, "at": datetime.now().strftime("%Y-%m-%d %H:%M"), **extra})
    RECENT_PATH.write_text(json.dumps(items[:limit], ensure_ascii=False, indent=1), encoding="utf-8")


def load_secrets() -> dict[str, Any]:
    """secrets.yaml(APIキー等。GitHubには同期されない)。無ければ空。"""
    if not SECRETS_PATH.exists():
        return {}
    with SECRETS_PATH.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}
