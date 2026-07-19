#!/bin/sh
# .env を読み込み、Asterisk OpenAI Realtime 音声応答アプリを起動
set -ue

# スクリプト基準で設定ファイルとエントリポイントを参照する
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE="$SCRIPT_DIR/.env"

# .env を読み込み
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

# 必須設定を検証
#: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"

exec node "$SCRIPT_DIR/index.js"
