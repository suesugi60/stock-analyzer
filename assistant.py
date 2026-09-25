"""分析結果について「このシステム内で聞ける」Q&Aアシスタント。

分析レポート(Markdown)を文脈として渡し、用語・スコアの根拠・リスクの意味などを
日本語で分かりやすく答える。回答の生成には次のどちらかを使う(自動判定):
1. Anthropic API(銘柄分析/config/secrets.yaml の anthropic_api_key、または環境変数 ANTHROPIC_API_KEY)
2. Claude Code CLI(`claude -p`、ログイン済みのサブスクリプションを使う。APIキー不要)
どちらも使えない時は設定方法を案内する。会話ログは 銘柄分析/質問ログ/ に残す。
"""
from __future__ import annotations

import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from stock_analyzer.config import BASE_DIR, SHARED_MODE, load_secrets, load_settings

QA_LOG_DIR = BASE_DIR / "質問ログ"
DEFAULT_MODEL = "claude-opus-5"

SYSTEM_PROMPT = """あなたは個人投資家向けの「銘柄分析アシスタント」です。ユーザーは日本在住の個人投資家で、
投資の専門用語に詳しくない場合があります。以下のルールで答えてください。

- 必ず日本語で、平易な言葉で、簡潔に答える(目安300〜500字。質問が深い場合は長くてよい)
- 提供された分析データ(Markdown)の数値を根拠として引用する(例:「PERは13.0倍で…」)
- 用語を聞かれたら、定義 → この銘柄での実際の値 → その見方、の順で説明する
- スコアの根拠を聞かれたら、該当項目の点数と閾値を示す
- データに無いことを聞かれたら「このデータには含まれていない」と明示し、一般論として答える
- 売買の指示(買え/売れ)はしない。判断材料と、自分で確認すべきポイントを示す
- 断定を避けつつも、曖昧にしすぎない。重要なリスクははっきり伝える
- 箇条書きと短い段落を使い、読みやすくする"""


def _api_key(override: str | None = None) -> str | None:
    key = override or load_secrets().get("anthropic_api_key") or os.environ.get("ANTHROPIC_API_KEY")
    if not key or str(key).startswith("YOUR_"):
        return None
    return str(key).strip()


def _claude_cli() -> str | None:
    for candidate in (shutil.which("claude"), str(Path.home() / ".local" / "bin" / "claude"), "/opt/homebrew/bin/claude"):
        if candidate and Path(candidate).exists():
            return candidate
    return None


def available_backend(api_key: str | None = None) -> str | None:
    """'api' / 'cli' / None。UIで「質問できる状態か」を出し分けるために使う。"""
    if _api_key(api_key):
        return "api"
    if _claude_cli() and not SHARED_MODE:
        return "cli"
    return None


def setup_hint() -> str:
    return (
        "質問機能を使うには次のどちらかの設定が必要です。\n"
        "1. **Anthropic APIキー**(従量課金): `~/Dropbox/buzzraseya/銘柄分析/config/secrets.yaml` に "
        "`anthropic_api_key: sk-ant-...` を書く(console.anthropic.com で発行)\n"
        "2. **Claude Code CLI**(サブスクリプション利用・追加費用なし): ターミナルで `claude login` を実行してログインしておく"
    )


def _build_messages(question: str, context_md: str, history: list[dict[str, str]]) -> list[dict[str, str]]:
    context_block = (
        "以下は、いま画面に表示している分析結果(Markdown)です。この内容を根拠に質問に答えてください。\n\n"
        f"<analysis>\n{context_md}\n</analysis>"
    )
    messages: list[dict[str, str]] = []
    for i, turn in enumerate(history[-8:]):
        content = turn["content"]
        if i == 0 and turn["role"] == "user":
            content = f"{context_block}\n\n質問: {content}"
        messages.append({"role": turn["role"], "content": content})
    first_question = not history
    messages.append({"role": "user", "content": f"{context_block}\n\n質問: {question}" if first_question else f"質問: {question}"})
    return messages


def _ask_api(question: str, context_md: str, history: list[dict[str, str]], model: str, api_key: str | None = None) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=_api_key(api_key))
    try:
        # サーバー側フォールバックを既定で有効化(安全分類で拒否された場合に別モデルで続行)
        with client.beta.messages.stream(
            model=model,
            max_tokens=8000,
            system=SYSTEM_PROMPT,
            messages=_build_messages(question, context_md, history),
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            message = stream.get_final_message()
    except anthropic.AuthenticationError:
        return "APIキーが無効です。secrets.yaml の anthropic_api_key を確認してください。"
    except anthropic.RateLimitError:
        return "APIのレート制限に達しました。少し待ってから再度質問してください。"
    except anthropic.APIStatusError as exc:
        return f"APIエラー({exc.status_code}): {exc.message}"
    except anthropic.APIConnectionError:
        return "ネットワークエラーでAPIに接続できませんでした。"
    if message.stop_reason == "refusal":
        return "この質問には回答できませんでした(安全上の理由で拒否されました)。"
    return "".join(block.text for block in message.content if block.type == "text").strip() or "(回答が空でした)"


def _ask_cli(question: str, context_md: str, history: list[dict[str, str]], model: str | None) -> str:
    cli = _claude_cli()
    transcript = "\n".join(
        f"{'質問' if t['role'] == 'user' else '回答'}: {t['content']}" for t in history[-6:]
    )
    prompt = (
        "以下は、いま画面に表示している分析結果(Markdown)です。この内容を根拠に質問に答えてください。\n\n"
        f"<analysis>\n{context_md}\n</analysis>\n\n"
        + (f"これまでのやり取り:\n{transcript}\n\n" if transcript else "")
        + f"質問: {question}"
    )
    cmd = [
        cli, "-p", prompt, "--output-format", "text",
        "--system-prompt", SYSTEM_PROMPT,
        "--disallowedTools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, env={**os.environ, "HOME": str(Path.home())})
    except subprocess.TimeoutExpired:
        return "回答の生成がタイムアウトしました(180秒)。もう一度試してください。"
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0 or not out:
        combined = f"{out}\n{err}".lower()
        if "authenticate" in combined or "oauth" in combined or "login" in combined:
            return "Claude Code CLI のログインが切れています。ターミナルで `claude login` を実行してから再度質問してください。"
        return f"Claude Code CLI でエラーが発生しました: {(err or out)[:300]}"
    return out


def _append_log(subject: str, question: str, answer: str, backend: str) -> None:
    try:
        QA_LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = QA_LOG_DIR / f"{datetime.now():%Y-%m}.md"
        with path.open("a", encoding="utf-8") as f:
            f.write(f"## {datetime.now():%Y-%m-%d %H:%M} {subject}({backend})\n\n**Q:** {question}\n\n{answer}\n\n---\n\n")
    except OSError:
        pass


def ask(
    question: str,
    context_md: str,
    history: list[dict[str, str]] | None = None,
    subject: str = "",
    api_key: str | None = None,
) -> dict[str, Any]:
    """質問に答える。戻り値: {"answer": str, "backend": "api"|"cli"|None}

    api_key を渡すと secrets.yaml や環境変数より優先する(Web公開版で利用者自身のキーを使う用)。
    """
    history = history or []
    settings = load_settings()
    model = settings.get("qa_model") or DEFAULT_MODEL
    preferred = settings.get("qa_backend") or "auto"
    backend = available_backend(api_key)
    if preferred == "cli" and _claude_cli() and not SHARED_MODE:
        backend = "cli"
    elif preferred == "api" and _api_key(api_key):
        backend = "api"
    if backend is None:
        return {"answer": setup_hint(), "backend": None}
    answer = _ask_api(question, context_md, history, model, api_key) if backend == "api" else _ask_cli(question, context_md, history, model)
    if not SHARED_MODE:
        _append_log(subject, question, answer, backend)
    return {"answer": answer, "backend": backend}
