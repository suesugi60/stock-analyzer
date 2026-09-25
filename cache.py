"""yfinance取得の共通レイヤー: ディスクキャッシュ + リトライ。

Yahoo Financeは非公式ソースでレート制限(429)やタイムアウトが起きるため、
- TTL付きキャッシュ(同じ日の再実行はキャッシュから返す)
- 失敗時の指数バックオフリトライ
- 全滅した場合は例外を投げず、期限切れでも古いキャッシュがあればそれを返す
という設計にしている。キャッシュは 銘柄分析/cache/ に1キー1ファイルのJSONで置く。
"""
from __future__ import annotations

import functools
import json
import time
from pathlib import Path
from typing import Any, Callable

from stock_analyzer.config import CACHE_DIR


def _cache_path(key: str) -> Path:
    safe_key = key.replace("/", "_").replace(" ", "_")
    return CACHE_DIR / f"{safe_key}.json"


def _read_cache(key: str, ttl_seconds: int) -> Any:
    path = _cache_path(key)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if time.time() - payload.get("_cached_at", 0) > ttl_seconds:
        return None
    return payload.get("value")


def _write_cache(key: str, value: Any) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_path(key).write_text(json.dumps({"_cached_at": time.time(), "value": value}, ensure_ascii=False))
    except OSError:
        pass


def cached_with_retry(cache_key: str, ttl_seconds: int = 6 * 3600, retries: int = 3, backoff_seconds: float = 2.0):
    """関数の戻り値(JSON化可能なもの)をキャッシュしつつ、失敗時はリトライする。"""

    def decorator(func: Callable[..., Any]):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            key = cache_key.format(*args, **kwargs) if "{" in cache_key else cache_key
            fresh = _read_cache(key, ttl_seconds)
            if fresh is not None:
                return fresh
            last_error = None
            for attempt in range(retries):
                try:
                    result = func(*args, **kwargs)
                    if result is not None:
                        _write_cache(key, result)
                        return result
                except Exception as exc:  # noqa: BLE001 - 意図的に広く捕捉してフォールバックする
                    last_error = exc
                    time.sleep(backoff_seconds * (2**attempt))
            stale = _read_cache(key, ttl_seconds=10**9)
            if stale is not None:
                return stale
            if last_error is not None:
                print(f"[warn] {func.__name__}({key}) 取得失敗、値なし: {last_error}")
            return None

        return wrapper

    return decorator
