#!/usr/bin/env node
// DOM Sidecar MCP 呼叫器:處理 initialize 握手 + 工具呼叫,JSON 輸出。
// 用法:node sidecar-call.mjs <tool> [--tab <tab_id>] [--max-bytes N] [--since-revision N]
// 工具:list_pages | get_page_info | get_dom | get_text | get_changes
"use strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const BASE = `http://${cfg.bridge.host}:${cfg.bridge.port}`;

const TOOL = process.argv[2];
const VALID = ["list_pages", "get_page_info", "get_dom", "get_text", "get_changes"];
if (!TOOL || !VALID.includes(TOOL)) {
  console.error(`用法: sidecar-call.mjs <${VALID.join("|")}> [--tab <tab_id>] [--max-bytes N] [--since-revision N]`);
  process.exit(2);
}

const args = {};
const rest = process.argv.slice(3);
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--tab") args.tab_id = rest[++i];
  else if (rest[i] === "--max-bytes") args.max_bytes = Number(rest[++i]);
  else if (rest[i] === "--since-revision") args.since_revision = Number(rest[++i]);
}

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

(async () => {
  const init = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sidecar-cli", version: "0.1.0" }
  });
  if (!sessionId || !init) {
    console.error(`無法連上 ${BASE}/mcp —— server 沒跑?在專案根目錄執行:npm start(背景)`);
    process.exit(1);
  }
  await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  });

  const result = await mcp("tools/call", { name: TOOL, arguments: args });
  const text = result?.content?.[0]?.text;
  if (result?.isError) {
    console.error(text);
    process.exit(1);
  }
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
  catch { console.log(text); }
})().catch((e) => {
  console.error("呼叫失敗:", e.message);
  process.exit(1);
});
