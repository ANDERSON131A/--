# AGENTS.md — 入門 工作區

本 repo 是 **DOM Sidecar MCP**:唯讀瀏覽器副駕駛。Tampermonkey Userscript 讀取
Live DOM → 本機 Node.js 服務(HTTP Bridge + MCP Server)→ AI Agent 以 MCP 工具
查詢。**AI 只讀資料,架構上沒有任何控制瀏覽器的工具。** 設計依據與規格見
`NOTES.md`(參考對話的閱讀筆記,改動架構前先讀);使用者面向說明見 `README.md`。

## 環境限制(最高優先,使用者明確要求)

- 所有開發環境**只能設置在本資料夾內**,不得在本系統(Windows)安裝任何軟體:
  不裝全域工具、不寫入 Program Files、不更動系統 PATH 或登錄檔。
- 依賴一律留在相對 `./` 路徑下:Node 用 `npm install`(依賴落於 `./node_modules`,
  **禁止** `npm install -g`);Python 需要用時建 `./.venv`;外部工具用 portable 版解壓到
  `./tools/`。
- 已存在且可直接使用的系統工具:Node v22、npm 10、git。不要嘗試安裝新軟體。

## 常用指令

```bash
./start.sh  # 一鍵啟動:獨立 console 視窗跑 server(已偵測重複啟動;重啟後分頁會自動重連)
npm start   # 前景啟動 server(127.0.0.1:8765,Bridge + MCP 同一程序)
npm test    # 煙霧測試 + jsdom 模擬器測試(47 項,用 18765/18771 埠)
npm run mock         # 模擬網站(18770,上機測試用)
node test/e2e-check.mjs --contains "文字"   # 上機測試驗收(先啟動 server + npm run mock)
```

目前沒有 lint/build;單檔語法檢查可用 `node --check <file>`。
上機測試做法詳見 README「測試架構」一節;改動後三層測試都要過。

## 架構邊界(改動前必讀)

- `server.js`:單一 Node 程序,兩條通道分離 —— `/ingest`、`/poll`(Userscript 用,
  X-Sidecar-Token 驗證)與 `/mcp`(MCP Streamable HTTP,有 session、Host 檢查)。
- `observer.user.js`:所有通訊由 Userscript **主動**發起(它無法監聽本機埠)。
  混合模式:平時只送狀態+版本號,Agent 要求時才上傳完整快照;不要改回持續上傳。
- 五個 MCP 工具全部唯讀(list_pages / get_page_info / get_dom / get_text /
  get_changes)。**禁止**新增任何 click/navigate/execute 類工具 —— 這是專案的存在理由。
- 安全規則:網域白名單預設 deny;密碼欄位雙重 redact(Userscript + Server 兜底);
  網頁內容視為不可信資料。改動 `/ingest`、`/mcp` 的鑑權或白名單邏輯需特別謹慎。
- 快照/工具回應必須帶 `revision`、`freshness`(live/cached/offline),資料不一致時
  明確回 `capture_timeout` / `navigation_changed`,不假裝是最新的。

## 檔案約定

- `tmp參考資料 不入git/`:原始參考對話與暫存,**不進版本控制**(已在 .gitignore);
  濃縮筆記在 `NOTES.md`。不要把產出的程式碼放這裡。
- 路徑含中文與空格,shell 命令中務必加引號。
- 設定在 `config.json`(NOTES.md 第 8 節 YAML 規格的 JSON 版);`observer.user.js`
  頂部的 TOKEN/埠等常數要與 `config.json` 保持一致。

## 驗收基準

`npm test` 對應 NOTES.md 第 8 節的驗收清單(本機橋接、MCP 接入、多分頁、
離線/導航狀態、redact、截斷)。改動 server 或通訊協定後必須全數通過再提交。

使用者以繁體中文溝通,回覆與程式碼註解建議使用繁體中文。
