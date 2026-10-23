# NOTES.md — 參考資料閱讀筆記

來源:`tmp參考資料 不入git/chatgpt_Edge MCP 機器人驗證原因_2026-10-23.json`
(ChatGPT 對話匯出,2026-10-23,共 30 則訊息。原始對話不入 git,本檔是濃縮筆記。)

## 1. 問題起點

使用者在 Edge 開啟 MCP 功能(有頭瀏覽器)後,網站仍跳出機器人驗證。

核心結論:**有頭瀏覽器(Headful)≠ 真人瀏覽器**。網站檢測不只看 headless,還看
WebDriver 標記、IP 信譽、操作頻率、JS 環境與瀏覽器指紋(JA3/JA4)、Cookie/登入狀態。
MCP 只是「AI 如何與瀏覽器溝通」的協定,無法證明操作者是真人。

## 2. 架構演進(對話中的決策路徑)

| 嘗試方向 | 結論 |
|---|---|
| AI 直接接管瀏覽器(Playwright/CDP) | 拒絕:仍會產生自動化訊號 |
| 螢幕擷取旁路(Copilot Vision 式) | 介入最低,但 AI 只能吃圖片 |
| mitmproxy / Burp 式本地 proxy 觀察封包 | 擱置:MITM 需裝 CA 憑證、TLS 指紋(JA3/JA4)反而可能更容易觸發驗證;且 API JSON 通常比 DOM 更有價值,但先不做 |
| 擴充功能 vs Userscript | 先用 **Userscript(Tampermonkey)做原型**,驗證後再包成 MV3 Extension |
| 讀取 Virtual DOM(React Fiber/Vue 內部) | **放棄**:需框架內部存取,非通用。只做真實 DOM |
| 只做 DOM、不碰封包 | **定案**:Live DOM + MutationObserver + MCP 已足夠作為第一版核心 |

最終命名:**DOM Sidecar MCP**(對話中亦稱 Live DOM Snapshot Collector / Raw DOM Snapshot)。

> 定義:在不控制瀏覽器操作的前提下,擷取瀏覽器記憶體中的真實 DOM,
> 序列化、補充必要動態狀態後,提供給 MCP Server 供 AI Agent 查詢。

## 3. 最終架構(只需 2 份主要程式)

```
AI Agent (MCP Client, 如 Claude Code/VS Code)
   ↑ MCP(Streamable HTTP, /mcp)
Node.js 本機服務(127.0.0.1:8765)= HTTP Bridge + MCP Server(同一份 server.js)
   ↑ HTTP POST(/ingest、/poll,GM_xmlhttpRequest + @connect 127.0.0.1)
Edge + Tampermonkey Userscript(observer.user.js):讀取 Live DOM
```

- **真人操作瀏覽器;AI 只讀資料,架構上禁止控制**(無 click/navigate/type/execute_js 工具)。
- Userscript **不能監聽本機 TCP**,所以通訊必須由 Userscript 主動發起:
  - 方案 A 持續上傳(簡單但浪費)/ 方案 B 輪詢指令(省流量)/ **方案 C 混合模式(推薦、採用)**:
    DOM 變化時只送「狀態 + 版本號」(dirty 標記),Agent 要求時才送完整快照。
- MCP 是 Client–Server 架構(上層另有 Host);官方傳輸:stdio 與 Streamable HTTP。
  Userscript 不自己實作 MCP,Node.js 負責包裝成標準 MCP Tools。
- 使用官方 `@modelcontextprotocol/sdk`(對話時點稱 SDK v2),不自刻 JSON-RPC。

## 4. 為什麼不持續上傳整份 DOM(效能思想實驗)

假設 2 MB DOM、每秒 5 次變更 → 每分鐘 600 MB 上傳,且 DOM 序列化在主執行緒,
會影響使用者瀏覽。分層策略:

| 觸發條件 | Userscript 動作 |
|---|---|
| 頁面載入完成 | 註冊頁面、記錄基本資訊 |
| DOM 變化 | 標記 dirty、記錄變更摘要(debounce 500ms) |
| Agent 呼叫 get_dom | 依需求擷取完整快照 |
| 分頁無活動 | 降低監測頻率 |
| DOM 過大 | 分區擷取、限制單次回傳量 |

關鍵:MutationObserver 只負責通知「變了」,不等于每次變化都重新序列化整頁。

## 5. 瀏覽器不是靜態資料庫(六個情境)

- A 靜態頁:`outerHTML` 即可,高度可行。
- B React/Vue 動態:只要提交到真實 DOM 就讀得到;快照需帶 revision + 時間戳。
- C 無限捲動/虛擬清單:DOM 只留附近 10 筆 → 需要 **DOM History** 累積曾出現的資料
  (記錄新增/移除節點;不能保證零遺漏)。第一版先不做完整 Event Sourcing。
- D 多分頁:URL 不夠用;用 `GM_getTab`/`GM_saveTab` 做 tab_id + 自訂 document_id
  (重載即重生成)。前景分頁判定不可靠 → 靠 tab_id + visibility + last_seen,不猜測。
- E 快速切頁:每個請求帶 request_id / tab_id / document_id / revision;
  不一致時明確回 `stale` / `navigation_changed`,不假裝是最新的。
- F 關閉瀏覽器:區分三種新鮮度 —— `live`(可即時採集)/ `cached`(只有最後保存的)/
  `offline`(連線失效)。

## 6. DOM 完整性邊界

`outerHTML` 不是瀏覽器狀態的完整序列化:
- 拿得到:文字/表格/連結/JS 動態元素/SVG、輸入框即時值(DOM property,需另存)。
- 拿不到:Canvas 繪製內容(Canvas 是 DOM 元素,畫的東西不是 DOM 子節點)、
  尚未渲染的 API JSON、封閉 Shadow DOM、CSS 偽元素內容;Open Shadow DOM 需遞迴遍歷。
- 因此資料分兩個產品:**Raw DOM Snapshot**(原始 HTML,不語意推測)與
  **Semantic Snapshot**(標題/正文/連結/表格等精簡版,省 token)。

## 7. 安全設計(唯讀 ≠ 安全)

| 風險 | 防護 |
|---|---|
| DOM 含私人資料/Token/帳號 | 網域白名單、敏感欄位排除(密碼/驗證碼)、MCP 授權 |
| 本機 API 被其他網頁/程序濫用 | 綁定 127.0.0.1、Token 驗證(X-Sidecar-Token)、Origin/Host 檢查(防 DNS rebinding) |
| Prompt Injection | 網站內容視為不可信資料(OWASP 對 MCP tool 回傳內容的建議),限制 Agent 權限 |

原則:**原始 DOM 可存本機,但預設不允許任意 Agent 無限制取得**;預設 deny、per-site 授權;
`allow_browser_control: false`。Chrome/Edge 的本機網路存取限制(LAN access permission)
需在實際版本上驗證 Tampermonkey 連 127.0.0.1 的行為。

## 8. 第一版規格(MVP)

```text
檔案:observer.user.js、server.js、package.json、config(設定檔)
bridge:host 127.0.0.1、port 8765、token 驗證、heartbeat 5s
storage:memory(第一版不用資料庫)、history_limit 10、過期 300s
observer:hybrid、capture on demand、MutationObserver、debounce 500ms、
         capture {raw_html, semantic_text, links}、forms/shadow_dom/iframes 先關
mcp:Streamable HTTP @ /mcp
tools:list_pages、get_page_info、get_dom、get_text、get_changes
      (get_dom 回傳 revision / captured_at / freshness;過大走分頁/區段查詢)
security:default deny、per-site、redact 敏感欄位、禁止控制瀏覽器
```

驗收清單(對話「九、用什麼測試證明可行」):
1. DOM 內容:一般/動態渲染的文字與表格能採集
2. 本機橋接:Userscript 經授權傳送到 Node.js
3. MCP 接入:標準 MCP Client 能呼叫 get_dom 並收到結果 ← 前三項證明架構成立
4. 動態更新:變更後 revision 前進,不是舊快照
5. 多分頁:兩個同網址分頁不互相覆蓋
6. 導航與離線:重載/切頁/關閉後正確回報 live/cached/offline
7. 資料安全:敏感表單、未授權網域不外流
8. 效能:大量變動不明顯卡頓、記憶體不無限累積

核心驗證流程(證明最關鍵假設):
Edge 開網站 → Userscript 讀 Live DOM → Node.js 收快照 → Agent 呼叫 MCP get_dom →
拿到正確 HTML 與狀態 —— 全程不接管瀏覽器、不攔封包、不用 WebDriver。

## 9. 使用者補充的環境硬約束

- 所有開發環境只能在專案資料夾內設置,**不可在系統安裝任何軟體**;
  依賴比照 npm 留在 `./`(node_modules)。
- 已存在系統工具:Node v22.2.0、npm 10.7.0、git 2.42 —— 直接使用,不安裝新東西。

## 10. 後續路線圖(對話提及、未實作)

- 擴充功能化(MV3 Extension)取代 Userscript,取得更完整分頁識別與權限控管
- Dual Observer(Network + DOM)與 Unified MCP 時間關聯(proxy 僅選配)
- DOM Event Sourcing / 框架 Adapter(React Fiber、Vue)—— 選配、後置
- Node.js 打包單一執行檔、開機自啟
- stdio 轉接層(給只支援 stdio 的 MCP Client)
