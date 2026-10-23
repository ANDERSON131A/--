#!/usr/bin/env bash
# DOM Sidecar 一鍵啟動(Git Bash / Windows)
# 開一個「獨立 console 視窗」執行 server:關掉 ZCode / 終端機也不受影響。
# 用法:./start.sh(或 bash start.sh)
set -e
cd "$(dirname "$0")"

# 讀取設定檔的埠(預設 8765)
PORT=$(node -p "require('./config.json').bridge.port" 2>/dev/null || echo 8765)
BASE="http://127.0.0.1:${PORT}"

# 0. 已在執行就不重複開(避免埠衝突)
if curl -s --max-time 2 "${BASE}/healthz" | grep -q '"ok":true'; then
  echo "server 已在執行(${BASE}),不重複啟動。"
  echo "要重啟請先關掉原本的 server console 視窗,再執行一次本腳本。"
  exit 0
fi

# 1. 環境檢查:node 存在?依賴只裝在本資料夾(./node_modules)
if ! command -v node >/dev/null 2>&1; then
  echo "錯誤:找不到 node。請先安裝 Node.js(或確認它在 PATH 中)。"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "首次執行:安裝依賴到 ./node_modules(不動系統)…"
  npm install
fi

# 2. 開獨立 console 視窗執行 server(cmd /k:node 結束後視窗保留,方便看錯誤)
WINPATH=$(cygpath -w "$PWD")
cmd //c start "DOM Sidecar Server (port ${PORT})" //D "${WINPATH}" cmd //k node server.js

# 3. 等一下確認真的起來了
for i in $(seq 1 10); do
  sleep 1
  if curl -s --max-time 1 "${BASE}/healthz" | grep -q '"ok":true'; then
    echo "server 已在新 console 視窗啟動:${BASE}"
    echo "  - 關閉該視窗或在視窗內按 Ctrl+C 即停止"
    echo "  - MCP 端點:${BASE}/mcp"
    exit 0
  fi
done

echo "警告:10 秒內未偵測到 server,請查看新開的 console 視窗裡的錯誤訊息。"
exit 1
