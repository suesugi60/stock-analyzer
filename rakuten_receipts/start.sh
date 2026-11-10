#!/bin/bash
# 楽天トラベル領収書ツールの起動スクリプト。
# 初回だけ必要なものをインストールし、質問に答えて進める「案内モード」を起動する。
#   使い方: rakuten_receipts/start.sh
set -e

# どこから実行されても、このスクリプトの1つ上(ツールを置いたフォルダ)へ移る
HERE="${BASH_SOURCE[0]%/*}"
[ "$HERE" = "${BASH_SOURCE[0]}" ] && HERE="."
cd "$HERE/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 が見つかりません。Python 3.9 以上をインストールしてから、もう一度実行してください。" >&2
  echo "(Mac では、ターミナルで xcode-select --install を実行するとインストールできます)" >&2
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  echo "Python 3.9 以上が必要です。新しい Python をインストールしてから、もう一度実行してください。" >&2
  echo "(Mac では、ターミナルで xcode-select --install を実行するとインストールできます)" >&2
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "初回の準備をしています(数分かかることがあります)…"
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import playwright, pypdf' >/dev/null 2>&1; then
  echo "必要なものをインストールしています…"
  .venv/bin/python -m pip install --quiet --disable-pip-version-check -r rakuten_receipts/requirements.txt
fi
# Mac に Google Chrome がなければ、代わりに使うブラウザを入れておく
if [ "$(uname)" = "Darwin" ] && [ ! -d "/Applications/Google Chrome.app" ] \
    && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
  echo "Google Chrome が見つからないので、代わりのブラウザを用意しています…"
  .venv/bin/python -m playwright install chromium
fi

exec .venv/bin/python -m rakuten_receipts guide "$@"
