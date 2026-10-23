// Userscript 模擬器測試:用 jsdom 提供真實 DOM/MutationObserver 環境,
// 把「真的」observer.user.js 跑起來(GM_* API 以 shim 模擬 Tampermonkey),
// 對真的 sidecar server 驗證註冊、監看、採集、redact、停用等行為。
// 執行:npm test(埠 18771)
"use strict";

import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sb from "../server.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 18771;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "sim-token";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 啟動被測 server(快速心跳/防抖,縮短測試時間)----
const cfg = sb.loadConfig();
cfg.bridge.port = PORT;
cfg.bridge.token = TOKEN;
cfg.bridge.capture_wait_seconds = 5;
cfg.security.allowed_domains = ["example.com"];
const inst = sb.startServer(cfg);
await new Promise((r) => inst.server.on("listening", r));

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
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function callTool(name, args = {}) {
  const r = await mcp("tools/call", { name, arguments: args });
  const result = r.json?.result;
  let data = null;
  try { data = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : null; } catch { /* 非 JSON */ }
  return { isError: result?.isError === true, data, raw: result };
}

// ---- Userscript 模擬環境 ----
const observerSrc = fs
  .readFileSync(path.join(ROOT, "observer.user.js"), "utf8")
  .replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, "");

function createPageEnv(url, html) {
  const vc = new VirtualConsole();
  vc.on("log", (...a) => console.log("  [page]", ...a));
  vc.on("warn", (...a) => console.log("  [page:warn]", ...a));
  vc.on("jsdomError", (e) => console.log("  [page:jsdomError]", e.message));

  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;

  // jsdom 缺口補齊(真瀏覽器都有)
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  Object.defineProperty(w.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
    configurable: true
  });

  // GM_* shim
  const tabStore = {};
  w.GM_getTab = (cb) => cb(tabStore);
  w.GM_saveTab = (t) => Object.assign(tabStore, t);
  const menu = {};
  w.GM_registerMenuCommand = (label, fn) => { menu[label] = fn; };
  w.GM_xmlhttpRequest = ({ method, url, headers, data, timeout, onload, onerror, ontimeout }) => {
    fetch(url, { method, headers, body: method === "POST" ? data : undefined, signal: AbortSignal.timeout(timeout || 10000) })
      .then(async (r) => onload && onload({ status: r.status, responseText: await r.text() }))
      .catch((e) => { if (ontimeout && e?.name === "TimeoutError") ontimeout(); else if (onerror) onerror(e); });
  };

  w.__SIDECAR_CONFIG__ = { BRIDGE: BASE, TOKEN, HEARTBEAT_MS: 150, DEBOUNCE_MS: 60 };
  w.eval(observerSrc);
  const env = { dom, w, tabStore, menu, warnings: [] };
  vc.on("warn", (...a) => env.warnings.push(a.join(" ")));
  return env;
}

try {
  // ================================================== 1. 註冊與分頁識別
  console.log("\n[1] 註冊與分頁識別");
  const env = createPageEnv(
    "https://example.com/flights",
    "<html><body><main id=main>NT$ 2,500</main><input type='password' value='TOP_SECRET'></body></html>"
  );
  await sleep(500);
  const tabId = env.tabStore.sidecar_id;
  const page = inst.store.pages.get(tabId);
  check("GM_getTab/GM_saveTab 產生分頁 ID", typeof tabId === "string" && tabId.startsWith("tab-"));
  check("Userscript 已向 server 註冊(url 正確)", !!page && page.url === "https://example.com/flights");
  check("freshness 為 live(心跳運作中)", page && inst.store.freshnessOf(page) === "live");

  // ================================================== 2. MutationObserver → status/revision
  console.log("\n[2] DOM 監看與 revision 前進");
  const rev0 = page.dom_revision;
  env.w.document.querySelector("main").insertAdjacentHTML("beforeend", '<div class="card">新航班 NT$ 1,988</div>');
  await sleep(500);
  check("DOM 變化後 revision 前進(status 已送出)", page.dom_revision > rev0, `rev ${rev0}→${page.dom_revision}`);

  // ================================================== 3. MCP get_dom 現場採集(端到端)
  console.log("\n[3] get_dom → /poll 命令 → 真實 observer 序列化上傳");
  await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sim", version: "0" } });
  const t = await callTool("get_dom", { tab_id: tabId });
  check("get_dom 取得 live 快照", t.data?.freshness === "live" && !t.isError, JSON.stringify(t.data)?.slice(0, 200));
  check("快照含原始內容與動態新增內容", t.data?.html?.includes("NT$ 2,500") && t.data?.html?.includes("新航班"));
  check("密碼欄位 value 已被 redact", t.data?.html?.includes("TOP_SECRET") === false);

  // ================================================== 4. get_text
  console.log("\n[4] get_text");
  const t2 = await callTool("get_text", { tab_id: tabId });
  check("get_text 回傳可見文字", t2.data?.text?.includes("NT$ 2,500") && t2.data?.text?.includes("新航班"));

  // ================================================== 5. 手動選單擷取 + 歷史
  console.log("\n[5] 手動選單擷取與快照歷史");
  env.w.document.querySelector("main").innerHTML = "<p>換頁後的內容 SIDECAAR-SPA</p>";
  await sleep(400);
  const histBefore = page.history.length;
  const menuFn = env.menu["立即擷取目前 DOM"];
  check("油猴選單命令已註冊", typeof menuFn === "function");
  menuFn();
  await sleep(300);
  check("手動擷取後最新快照為新內容", page.snapshot?.html?.includes("SIDECAAR-SPA"));
  check("舊快照被推入歷史", page.history.length === histBefore + 1 && page.history.at(-1)?.html?.includes("新航班"));

  // ================================================== 6. 多分頁
  console.log("\n[6] 多分頁不互相覆蓋");
  const env2 = createPageEnv("https://example.com/hotels", "<html><body><main>飯店頁 SIDECAAR-TAB2</main></body></html>");
  await sleep(500);
  const t3 = await callTool("list_pages");
  check("list_pages 列出兩個分頁", t3.data?.count === 2);
  const t4 = await callTool("get_dom", { tab_id: env2.tabStore.sidecar_id });
  check("分頁2 快照內容獨立", t4.data?.html?.includes("SIDECAAR-TAB2") && !t4.data?.html?.includes("SIDECAAR-SPA"));

  // ================================================== 7. 未授權網域停用
  console.log("\n[7] 未授權網域停用");
  const env3 = createPageEnv("https://not-allowed.org/secret", "<html><body>不該被觀察</body></html>");
  await sleep(500);
  check("未授權分頁沒有進入 store", ![...inst.store.pages.values()].some((p) => p.url?.includes("not-allowed.org")));
  check("observer 自我停用(白名單警告已觸發)", env3.warnings.some((s) => s.includes("白名單")));

  // ================================================== 8. 離線判定
  console.log("\n[8] 離線判定");
  inst.store.pages.get(tabId).last_seen = Date.now() - 120000;
  const t5 = await callTool("get_page_info", { tab_id: tabId });
  check("心跳停止後 freshness 變 offline、快照仍在", t5.data?.freshness === "offline" && t5.data?.has_snapshot === true);
} catch (e) {
  fail++;
  console.error("測試執行中斷:", e);
} finally {
  await new Promise((r) => inst.server.close(r));
}

console.log(`\n結果:${pass} 通過、${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
