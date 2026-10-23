// 上機測試驗收:以 MCP Client 身分連到 sidecar server,對真實瀏覽器採集的快照做斷言。
// 用法:
//   node test/e2e-check.mjs --contains "文字" [--not-contains "文字"] [--min-revision N] [--tab-substr "18770"]
// 退出碼:0 = 全部斷言通過;1 = 有失敗或找不到分頁。
"use strict";

const cfg = JSON.parse(await import("node:fs").then((m) => m.readFileSync(new URL("../config.json", import.meta.url), "utf8")));
const BASE = `http://${cfg.bridge.host}:${cfg.bridge.port}`;

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const CONTAINS = arg("--contains", null);
const NOT_CONTAINS = arg("--not-contains", null);
const MIN_REVISION = Number(arg("--min-revision", "0"));
const TAB_SUBSTR = arg("--tab-substr", ":18770");

let fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name} ${cond ? "" : extra}`);
  if (!cond) fail++;
};

// ---- MCP Client(最小實作)----
let sessionId = null;
let rpcId = 0;
async function mcp(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) })
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  return (await res.json())?.result;
}
async function callTool(name, args2 = {}) {
  const result = await mcp("tools/call", { name, arguments: args2 });
  let data = null;
  try { data = JSON.parse(result?.content?.[0]?.text); } catch { /* 錯誤訊息非 JSON */ }
  return { isError: result?.isError === true, data, text: result?.content?.[0]?.text };
}

// MCP 握手(有 session 模式必須先 initialize)
const init = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-check", version: "0.0.0" } }
  })
});
sessionId = init.headers.get("mcp-session-id");
if (!sessionId) {
  console.error("[e2e-check] MCP initialize 失敗(HTTP " + init.status + "),server 沒在跑或埠不對");
  process.exit(1);
}
await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
});

const list = await callTool("list_pages");
const pages = list?.data?.pages || [];
console.log(`[e2e-check] 已註冊分頁:${pages.map((p) => `${p.tab_id} ${p.url} (${p.freshness})`).join(" | ") || "(無)"}`);
const page = pages.find((p) => (p.url || "").includes(TAB_SUBSTR));
check("找到模擬網站的分頁", !!page);
if (!page) process.exit(1);

check("freshness = live", page.freshness === "live", `實際 ${page.freshness}`);
check(`revision ≥ ${MIN_REVISION}`, page.dom_revision >= MIN_REVISION, `實際 ${page.dom_revision}`);

const dom = await callTool("get_dom", { tab_id: page.tab_id });
check("get_dom 取得 live 快照", dom.data?.freshness === "live" && !dom.isError, `實際 ${dom.data?.freshness}`);
if (CONTAINS) check(`HTML 含「${CONTAINS}」`, (dom.data?.html || "").includes(CONTAINS));
if (NOT_CONTAINS) check(`HTML 不含「${NOT_CONTAINS}」(redact 生效)`, !(dom.data?.html || "").includes(NOT_CONTAINS));

const text = await callTool("get_text", { tab_id: page.tab_id });
check("get_text 有內容", (text.data?.text || "").length > 0);

const ch = await callTool("get_changes", { tab_id: page.tab_id, since_revision: 0 });
check("get_changes 回報已變更", ch.data?.changed === true && ch.data?.current_revision >= MIN_REVISION);

console.log(fail === 0 ? "[e2e-check] 全部通過" : `[e2e-check] ${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
