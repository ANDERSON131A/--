// 端到端煙霧測試:模擬 Userscript(註冊/輪詢/上傳快照)與 MCP Client
// (initialize → tools/list → tools/call),驗證「參考資料」第 9 節的核心驗收項目。
// 執行:npm test(需先確認 127.0.0.1:18765 沒被占用)
"use strict";

import sb from "../server.js";

const PORT = 18765;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

// ---- 啟動測試用 server(隨機固定埠、測試 token)----
const cfg = sb.loadConfig();
cfg.bridge.port = PORT;
cfg.bridge.token = TOKEN;
cfg.bridge.capture_wait_seconds = 6;
cfg.security.allowed_domains = ["example.com", "localhost"];
const inst = sb.startServer(cfg);
await new Promise((r) => inst.server.on("listening", r));

const ing = (body, token = TOKEN) =>
  fetch(`${BASE}/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(typeof token === "string" ? { "X-Sidecar-Token": token } : {})
    },
    body: JSON.stringify(body)
  });

// ---- 模擬 Userscript 輪詢並回應採集命令 ----
async function simulateCapture(tabId, html, text = "範例文字") {
  const q = new URLSearchParams({ tab_id: tabId, document_id: "doc-x", visibility: "visible", dom_revision: "1" });
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${BASE}/poll?${q}`, { headers: { "X-Sidecar-Token": TOKEN } });
    const body = await r.json();
    const cmd = (body.commands || []).find((c) => c.action === "capture");
    if (cmd) {
      await ing({
        type: "snapshot",
        request_id: cmd.request_id,
        tab_id: tabId,
        document_id: "doc-x",
        url: "https://example.com/flights",
        title: "機票搜尋結果",
        dom_revision: 1,
        html,
        text,
        links: [{ text: "範例航空 A", href: "https://example.com/f1" }]
      });
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ---- 模擬 MCP Client ----
let sessionId = null;
let rpcId = 0;

async function mcp(method, params) {
  const id = ++rpcId;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE 或空回應 */ }
  return { status: res.status, json, text };
}

async function callTool(name, args = {}) {
  const r = await mcp("tools/call", { name, arguments: args });
  const result = r.json?.result;
  // isError 時 content 是人讀的錯誤訊息,不一定是 JSON
  let data = null;
  try { data = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : null; } catch { /* 非 JSON */ }
  return { isError: result?.isError === true, data, raw: result, rpcError: r.json?.error };
}

try {
  // ================================================== 1. 基礎與鑑權
  console.log("\n[1] 基礎連線與鑑權");
  let r = await fetch(`${BASE}/healthz`);
  check("GET /healthz 回 200", r.status === 200);

  r = await ing({ type: "register", tab_id: "t1", document_id: "d1", url: "https://example.com/" }, null);
  check("無 Token 的 /ingest 回 401", r.status === 401);

  r = await ing({ type: "register", tab_id: "t1", document_id: "d1", url: "https://evil.com/" });
  check("未授權網域回 403 domain_not_allowed", r.status === 403 && (await r.json()).error === "domain_not_allowed");

  r = await ing({ type: "register", tab_id: "t1", document_id: "d1", url: "https://example.com/flights", title: "機票搜尋" });
  check("授權網域 register 回 200", r.status === 200);

  r = await fetch(`${BASE}/poll?tab_id=t1`, { headers: { "X-Sidecar-Token": TOKEN } });
  check("GET /poll 心跳正常、無待辦命令", r.status === 200 && (await r.json()).commands.length === 0);

  // ================================================== 2. MCP 協定
  console.log("\n[2] MCP 協定握手");
  r = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" }
  });
  check("initialize 成功且取得 session id", r.status === 200 && !!sessionId && r.json?.result?.serverInfo?.name === "dom-sidecar");

  const nres = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  });
  check("notifications/initialized 回 202", nres.status === 202, `實際 ${nres.status}`);

  r = await mcp("tools/list");
  const toolNames = (r.json?.result?.tools || []).map((t) => t.name).sort();
  check(
    "tools/list 提供五個唯讀工具",
    JSON.stringify(toolNames) === JSON.stringify(["get_changes", "get_dom", "get_page_info", "get_text", "list_pages"]),
    toolNames.join(",")
  );

  // ================================================== 3. 端到端:get_dom 現場採集
  console.log("\n[3] 端到端:get_dom → 排採集命令 → Userscript 回傳快照");
  const html1 = "<html><body><main>NT$ 2,500</main><input type=\"password\" value=\"secret123\"></body></html>";
  const [domRes, captured] = await Promise.all([
    callTool("get_dom", { tab_id: "t1" }),
    simulateCapture("t1", html1, "航班 A NT$2,500\n航班 B NT$3,100")
  ]);
  check("Userscript 在時限內收到採集命令", captured);
  check("get_dom 回傳 live 快照", domRes.data?.freshness === "live" && !domRes.isError, JSON.stringify(domRes.data));
  check("快照含正確 HTML 與 revision", domRes.data?.html?.includes("NT$ 2,500") && domRes.data?.revision === 1);
  check("密碼欄位已被 redact", domRes.data?.html?.includes('value="secret123"') === false);

  // ================================================== 4. 其餘工具
  console.log("\n[4] get_text / get_changes / list_pages / get_page_info");
  let t = await callTool("get_text", { tab_id: "t1" });
  check("get_text 回傳可見文字", t.data?.text?.includes("航班 A NT$2,500"));

  t = await callTool("get_changes", { tab_id: "t1", since_revision: 0 });
  check("get_changes 回報 changed=true", t.data?.changed === true && t.data?.current_revision >= 1);

  t = await callTool("list_pages");
  check("list_pages 列出 1 個分頁", t.data?.count === 1 && t.data?.pages[0].tab_id === "t1");

  t = await callTool("get_page_info", { tab_id: "t1" });
  check("get_page_info 回傳 URL 與標題", t.data?.url === "https://example.com/flights" && t.data?.title === "機票搜尋結果");

  // ================================================== 5. 多分頁與錯誤處理
  console.log("\n[5] 多分頁、截斷與錯誤處理");
  await ing({ type: "register", tab_id: "t2", document_id: "d2", url: "https://example.com/hotels", title: "訂房" });

  t = await callTool("list_pages");
  check("list_pages 列出 2 個分頁(同域不互相覆蓋)", t.data?.count === 2);

  t = await callTool("get_dom", {});
  check("多分頁時省略 tab_id 會被要求指定", t.isError === true && /tab_id/.test(t.raw?.content?.[0]?.text || ""));

  t = await callTool("get_dom", { tab_id: "t2" });
  check("t2 從未有快照 → 明確回報 no_snapshot", t.isError === true && t.data?.note === "no_snapshot");

  t = await callTool("get_dom", { tab_id: "t1", max_bytes: 50 });
  check("max_bytes 截斷生效", t.data?.truncated === true && t.data.html.length <= 50);

  t = await callTool("nonexistent_tool");
  check("未知工具回傳錯誤", t.isError === true || t.rpcError != null);

  // 離線情境:把 t1 心跳拉老(直接改 store 再查)
  inst.store.pages.get("t1").last_seen = Date.now() - 120000;
  t = await callTool("get_page_info", { tab_id: "t1" });
  check("心跳過期後 freshness 變 offline(但仍有快照)", t.data?.freshness === "offline" && t.data?.has_snapshot === true);
} catch (e) {
  fail++;
  console.error("測試執行中斷:", e);
} finally {
  await new Promise((r) => inst.server.close(r));
}

console.log(`\n結果:${pass} 通過、${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
