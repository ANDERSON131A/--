# DOM Sidecar MCP — 唯讀瀏覽器副駕駛

你照常操作 Edge,AI 透過獨立通道「閱讀」你正在瀏覽的網頁 —— 不接管瀏覽器、
不攔截封包、不用 WebDriver/CDP,從架構上就不提供任何控制瀏覽器的工具。

```
AI Agent(MCP Client,如 Claude Code / VS Code)
   ↑  MCP Streamable HTTP:POST /mcp
Node.js 本機服務(server.js)= HTTP Bridge + MCP Server
   ↑  HTTP:POST /ingest、GET /poll(GM_xmlhttpRequest + token)
Edge + Tampermonkey:observer.user.js 讀取 Live DOM
```

設計依據見 [NOTES.md](NOTES.md)(參考對話的完整閱讀筆記:可行性分析、
通訊模式取捨、瀏覽器非靜態資料庫的六個情境、安全邊界)。

## 組成(只有兩份主要程式)

| 檔案 | 角色 |
|---|---|
| `observer.user.js` | Tampermonkey Userscript:註冊分頁、MutationObserver 監看(只報「變了」)、輪詢 /poll 領取採集命令、上傳快照 |
| `server.js` | Node.js 本機服務:接收/儲存快照(記憶體)+ 提供 5 個唯讀 MCP 工具 |
| `config.json` | 設定(對應 NOTES.md 第 8 節的 YAML 規格,改用 JSON 免依賴) |
| `test/smoke.mjs` | 端到端煙霧測試(模擬 Userscript 與 MCP Client,22 項檢查) |

**混合模式**:平常只送狀態與版本號(debounce 500ms);Agent 呼叫 `get_dom` 時
才經 /poll 派發採集命令、現場序列化完整快照,避免持續上傳整份 DOM。

## MCP 工具(全部唯讀)

| 工具 | 說明 |
|---|---|
| `list_pages` | 列出已註冊分頁與新鮮度(live / cached / offline) |
| `get_page_info` | 單一分頁的 URL、標題、revision、freshness |
| `get_dom` | Raw DOM 快照(序列化 HTML);在線時現場採集,支援 `max_bytes` 截斷 |
| `get_text` | 可見文字(innerText,語意快照,省 token) |
| `get_changes` | 自某 revision 後的變更摘要(第一版為次數/時間;Event Sourcing 後置) |

快照帶 `revision` / `captured_at` / `freshness`;採集逾時或導航切換時明確回報
`capture_timeout` / `navigation_changed`,不假裝資料是最新的。

## 啟動

```bash
npm install   # 依賴只裝在 ./node_modules(環境規則:不在系統安裝任何軟體)
npm start     # 啟動 127.0.0.1:8765,Bridge + MCP 同一程序
npm test      # 端到端煙霧測試 + Userscript 模擬器測試(共 38 項,用 18765/18771 埠)
```

## 測試架構(三層)

| 層 | 檔案 | 驗什麼 |
|---|---|---|
| 1. 協定煙霧測試 | `test/smoke.mjs` | 模擬 Userscript 與 MCP Client 的 HTTP 行為:鑑權、白名單、MCP 握手、get_dom round-trip、多分頁、redact、截斷、離線 |
| 2. Userscript 模擬器 | `test/simulator.mjs` | jsdom 跑「真的」`observer.user.js`(GM_* 以 shim 模擬):註冊、MutationObserver → revision、採集命令、手動選單、歷史、未授權網域停用 |
| 3. 上機測試 | `test/mock-site.mjs` + `test/e2e-check.mjs` | 真實瀏覽器:模擬網站注入 GM shim + observer,點擊/導航後以 MCP 驗收快照 |

上機測試流程:

```bash
npm start                    # 視窗 1:sidecar(8765)
npm run mock                 # 視窗 2:模擬網站(18770)
# 視窗 3:用瀏覽器開 http://127.0.0.1:18770/(observer 由頁面注入),等 6 秒
node test/e2e-check.mjs --contains "MOCK_FLIGHT_E2E" --not-contains "TOP_SECRET_PW"
# 點擊「更新價格」後:
node test/e2e-check.mjs --contains "範例航空 C" --not-contains "範例航空 A" --min-revision 1
```

接上瀏覽器:

1. Edge 安裝 Tampermonkey,新增腳本,貼上 `observer.user.js` 全文。
   預設 `@match *://*/*` 觀察所有網站;想排除網銀等敏感站,在 Tampermonkey
   的使用者排除規則加入即可。
2. 確認腳本內的 `TOKEN` 與 `config.json` 的 `bridge.token` 一致
   (白名單已停用:`allowed_domains: ["*"]`,由 `@match`/排除規則把關)。
3. AI 端的 MCP 設定指向 `http://127.0.0.1:8765/mcp`(Streamable HTTP)。
   本工作區已內建 `.zcode/config.json` 連線設定與 `.agents/skills/dom-sidecar`
   skill —— ZCode 開啟本專案即自動接上,agent 看到「看我目前的頁面」類請求會
   自動使用;其他 MCP client 手動加入即可。

## 安全設計(唯讀 ≠ 安全)

- `/ingest`、`/poll` 只綁 127.0.0.1,以 `X-Sidecar-Token` 驗證
- `/mcp` 啟用 Host 檢查(防 DNS rebinding);MCP 工具預設無寫入能力
- 網域白名單預設 deny、per-site 授權;未授權分頁直接不收
- 密碼欄位雙重 redact(Userscript 抹除 + Server 端兜底);表單現值預設不採集
- 網頁內容一律視為**不可信資料**(Prompt Injection 風險,見 NOTES.md 第 7 節)

## 已知限制(第一版)

- Canvas 繪製內容、封閉 Shadow DOM、CSS 偽元素、未渲染的 API JSON 讀不到
- 虛擬捲動清單只保留 Observer 恰好看到的節點(DOM History 完整版後置)
- 背景分頁計時器被瀏覽器節流,採集延遲可能變長
- 只支援 Streamable HTTP 的 MCP Client;stdio client 需要再加轉接層
- 未知網站仍可能出 CAPTCHA —— 本專案降低的是「自動化訊號」,不是 IP/帳號風控
