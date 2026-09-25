#!/bin/bash
# Web公開版(Streamlit Community Cloud)用の公開リポジトリ suesugi60/stock-analyzer に、このフォルダの内容を同期する。
#   bash publish_public.sh            # 変更を commit & push
# 公開リポジトリのローカルクローンは Dropbox の外(~/stock-analyzer-public)に置く。
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/stock-analyzer-public"
REPO="git@github.com:suesugi60/stock-analyzer.git"
if [ ! -d "$DEST/.git" ]; then
  gh repo clone suesugi60/stock-analyzer "$DEST" || git clone "$REPO" "$DEST"
fi
rsync -a --delete \
  --exclude '.git' --exclude '__pycache__' --exclude '*.pyc' --exclude 'data/' \
  --exclude '.dashboard.*.log' --exclude 'install/' --exclude 'kabu' --exclude '.streamlit/secrets.toml' \
  "$SRC/" "$DEST/"
cd "$DEST"
git add -A
if git diff --cached --quiet; then
  echo "変更なし"
  exit 0
fi
git commit -q -m "sync from buzzraseya-brain: $(date '+%Y-%m-%d %H:%M')"
git push -q origin main
echo "公開リポジトリに push しました: https://github.com/suesugi60/stock-analyzer"
