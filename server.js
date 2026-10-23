"use strict";

/*
 * DOM Sidecar MCP — Node.js 本機服務
 *
 * 同時扮演兩個角色(單一程序、兩條通道完全分離):
 *   1. HTTP Bridge:/ingest、/poll — 接收 Tampermonkey Userscript 上傳的
 *      Live DOM 快照,並把 Agent 的採集請求排給 Userscript(混合模式:
 *      平常只送狀態與版本號,Agent 要求時才送完整快照)。
 *   2. MCP Server:/mcp(Streamable HTTP)— 對 AI Agent 提供唯讀工具
 *      list_pages / get_page_info / get_dom / get_text / get_changes。
 *
 * 安全邊界(見 NOTES.md 第 7 節):
 *   - 只綁定 127.0.0.1;/ingest、/poll 以 X-Sidecar-Token 驗證
 *   - /mcp 啟用 DNS rebinding 防護(Host 檢查)
 *   - 網域白名單預設 deny(default_policy: deny,per-site 授權)
 *   - 沒有任何「控制瀏覽器」的工具;網頁內容一律視為不可信資料
 */

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = crypto;

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const SERVER_INFO = { name: "dom-sidecar", version: "0.1.0" };
const MAX_BODY_BYTES = 16 * 1024 * 1024; // 單次請求上限(含 2MB 快照 + 餘裕)

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function deepMerge(base, over) {
  if (over === undefined || over === null) return structuredClone(base);
  if (typeof base !== "object" || typeof over !== "object" || Array.isArray(base)) {
    return structuredClone(over);
  }
  const out = { ...structuredClone(base) };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

const DEFAULT_CONFIG = {
  bridge: {
    host: "127.0.0.1",
    port: 8765,
    token: "",
    heartbeat_seconds: 5,
    capture_wait_seconds: 8
  },
  storage: { engine: "memory", history_limit: 10, expired_seconds: 300 },
  observer: { max_text_chars: 100000, max_links: 500 },
  mcp: { endpoint: "/mcp", enable_json_response: true },
  security: {
    default_policy: "deny",
    allowed_domains: ["example.com", "localhost", "127.0.0.1"],
    redact_sensitive_fields: true
  }
};

function loadConfig(configPath) {
  const p = configPath || process.env.DOM_SIDECAR_CONFIG || path.join(__dirname, "config.json");
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    console.warn(`[sidecar] 找不到設定檔 ${p},使用預設值`);
  }
  return deepMerge(DEFAULT_CONFIG, file);
}

// ---------------------------------------------------------------------------
// 儲存(memory engine)
// ---------------------------------------------------------------------------

function newPage(tabId) {
  return {
    tab_id: tabId,
    document_id: null,
    url: null,
    title: null,
    visibility: "unknown",
    last_seen: 0,
    dom_revision: 0,
    registered_at: 0,
    snapshot: null, // {revision, document_id, captured_at, html, text, links, truncated}
    history: [], // 最近的歷史快照(不含最新)
    mutation_log: [], // [{revision, ts, mutations}]
    pending: new Map() // request_id -> {document_id_at_request, resolve, timer, created_at}
  };
}

function createStore(cfg) {
  const pages = new Map(); // tab_id -> page

  function getOrCreate(tabId) {
    if (!pages.has(tabId)) pages.set(tabId, newPage(tabId));
    return pages.get(tabId);
  }

  function freshnessOf(page) {
    const ageSec = (Date.now() - page.last_seen) / 1000;
    if (ageSec <= cfg.bridge.heartbeat_seconds * 3 + 2) return "live";
    if (ageSec <= 60) return "cached"; // 瀏覽器/分頁可能休眠,但短時間內仍活著
    return "offline";
  }

  function domainAllowed(hostname) {
    const list = cfg.security.allowed_domains || [];
    if (list.includes("*")) return true;
    return list.some((d) => hostname === d || hostname.endsWith("." + d));
  }

  function pushSnapshot(page, snap) {
    snap.html = redactHtml(snap.html || "");
    if (page.snapshot) {
      page.history.push(page.snapshot);
      const limit = cfg.storage.history_limit || 10;
      while (page.history.length > limit) page.history.shift();
    }
    page.snapshot = snap;
    if (snap.revision > page.dom_revision) page.dom_revision = snap.revision;
  }

  return { pages, getOrCreate, freshnessOf, domainAllowed, pushSnapshot };
}

// 縱深防禦:即使 Userscript 漏了清理,server 端也把 password 欄位的 value 屬性抹掉
function redactHtml(html) {
  return html.replace(
    /(<input\b[^>]*type=["']password["'][^>]*\bvalue=["'])([^"']*)(["'])/gi,
    "$1$3"
  );
}

function truncate(s, maxBytes) {
  if (!s || maxBytes === undefined || maxBytes === null) return { s, truncated: false };
  const max = Number(maxBytes) || 0;
  if (max <= 0 || Buffer.byteLength(s, "utf8") <= max) return { s, truncated: false };
  // 以位元組邊界裁切,避免切在 UTF-8 多位元組字元中間
  const buf = Buffer.from(s, "utf8").subarray(0, max);
  return { s: buf.toString("utf8"), truncated: true };
}

function pickPage(store, tabId) {
  if (tabId) {
    const p = store.pages.get(tabId);
    if (!p) throw new Error(`找不到分頁 ${tabId};先用 list_pages 查詢`);
    return p;
  }
  const all = [...store.pages.values()].sort((a, b) => b.last_seen - a.last_seen);
  if (all.length === 0) throw new Error("目前沒有任何已註冊的分頁;請在 Edge 開啟網站讓 Userscript 連上");
  if (all.length > 1) {
    throw new Error(
      `有多個分頁(${all.length}),請以 tab_id 指定:${all
        .slice(0, 5)
        .map((p) => `${p.tab_id}(${p.title || p.url})`)
        .join("、")}…`
    );
  }
  return all[0];
}

// 混合模式核心:請 Userscript 擷取完整快照,等待其回傳
function requestSnapshot(store, cfg, page, waitMs) {
  const freshnessAtRequest = store.freshnessOf(page);
  if (freshnessAtRequest !== "live") {
    return Promise.resolve({ snapshot: page.snapshot, freshness: freshnessAtRequest, note: "browser_not_live" });
  }
  const request_id = "req-" + randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      page.pending.delete(request_id);
      resolve({ snapshot: page.snapshot, freshness: "stale", note: "capture_timeout" });
    }, waitMs);
    page.pending.set(request_id, {
      document_id_at_request: page.document_id,
      created_at: Date.now(),
      resolve: (snap) => {
        clearTimeout(timer);
        resolve({ snapshot: snap, freshness: "live" });
      }
    });
  });
}

function drainPending(store, page) {
  const commands = [];
  const now = Date.now();
  for (const [requestId, p] of page.pending) {
    if (now - p.created_at > 30000) {
      page.pending.delete(requestId);
      continue;
    }
    commands.push({ request_id: requestId, action: "capture", document_id: p.document_id_at_request });
  }
  return commands;
}

function resolvePending(store, page, snap) {
  const entry = page.pending.get(snap.request_id);
  if (entry) page.pending.delete(snap.request_id);
  if (snap.document_id !== entry?.document_id_at_request && entry?.document_id_at_request) {
    snap = { ...snap, navigation_changed: true };
  }
  entry?.resolve(snap);
}

// ---------------------------------------------------------------------------
// HTTP Bridge(/ingest、/poll)+ /healthz
// ---------------------------------------------------------------------------

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function urlHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function handleIngest(store, cfg, body) {
  const type = body.type;
  const page = store.getOrCreate(body.tab_id || "tab-unknown");

  if (type === "register" || type === "status" || type === "heartbeat") {
    const host = urlHostname(body.url);
    if (!store.domainAllowed(host)) {
      return { status: 403, body: { error: "domain_not_allowed", host } };
    }
    if (type === "register" || page.document_id !== body.document_id) {
      if (type === "register") page.registered_at = Date.now();
      page.document_id = body.document_id || page.document_id;
    }
    page.url = body.url || page.url;
    page.title = body.title || page.title;
    page.visibility = body.visibility || page.visibility;
    page.last_seen = Date.now();
    if (typeof body.dom_revision === "number" && body.dom_revision > page.dom_revision) {
      page.dom_revision = body.dom_revision;
      page.mutation_log.push({ revision: body.dom_revision, ts: page.last_seen, mutations: body.mutations || 1 });
      if (page.mutation_log.length > 200) page.mutation_log.shift();
    }
    return { status: 200, body: { ok: true } };
  }

  if (type === "snapshot") {
    const host = urlHostname(body.url);
    if (!store.domainAllowed(host)) {
      return { status: 403, body: { error: "domain_not_allowed", host } };
    }
    const snap = {
      request_id: body.request_id,
      revision: body.dom_revision || page.dom_revision,
      document_id: body.document_id,
      captured_at: body.captured_at || Date.now(),
      url: body.url,
      title: body.title,
      html: body.html || "",
      text: (body.text || "").slice(0, cfg.observer.max_text_chars),
      links: (body.links || []).slice(0, cfg.observer.max_links)
    };
    store.pushSnapshot(page, snap);
    page.url = body.url || page.url;
    page.title = body.title || page.title;
    page.visibility = body.visibility || page.visibility;
    page.last_seen = Date.now();
    resolvePending(store, page, snap);
    return { status: 200, body: { ok: true, stored: true } };
  }

  return { status: 400, body: { error: "unknown_type", type } };
}

function handlePoll(store, cfg, query) {
  const page = store.pages.get(query.get("tab_id"));
  if (!page) return { status: 200, body: { ok: true, commands: [] } };
  page.last_seen = Date.now();
  const visibility = query.get("visibility");
  if (visibility) page.visibility = visibility;
  const rev = Number(query.get("dom_revision") || 0);
  if (rev > page.dom_revision) {
    page.dom_revision = rev;
    page.mutation_log.push({ revision: rev, ts: page.last_seen, mutations: 1 });
  }
  return { status: 200, body: { ok: true, commands: drainPending(store, page), server_time: Date.now() } };
}

// ---------------------------------------------------------------------------
// MCP Server(/mcp,Streamable HTTP,有 session 模式)
// ---------------------------------------------------------------------------

function registerTools(mcp, store, cfg) {
  const pageInfoView = (p) => ({
    tab_id: p.tab_id,
    document_id: p.document_id,
    url: p.url,
    title: p.title,
    visibility: p.visibility,
    dom_revision: p.dom_revision,
    freshness: store.freshnessOf(p),
    has_snapshot: !!p.snapshot,
    snapshot_revision: p.snapshot?.revision ?? null,
    snapshot_captured_at: p.snapshot?.captured_at ?? null,
    last_seen_age_s: Math.round((Date.now() - p.last_seen) / 1000)
  });

  const tabArg = { tab_id: z.string().optional().describe("目標分頁 ID(list_pages 取得);單一分頁時可省略") };

  mcp.registerTool(
    "list_pages",
    {
      title: "列出已觀察的分頁",
      description: "列出 Userscript 已註冊、本機服務觀察到的所有瀏覽器分頁與其新鮮度(live/cached/offline)。",
      inputSchema: {}
    },
    async () => {
      const list = [...store.pages.values()]
        .sort((a, b) => b.last_seen - a.last_seen)
        .map(pageInfoView);
      return textResult({ pages: list, count: list.length });
    }
  );

  mcp.registerTool(
    "get_page_info",
    { title: "取得單一分頁資訊", description: "取得指定(或最近活動)分頁的 URL、標題、版本號與新鮮度。", inputSchema: tabArg },
    async ({ tab_id }) => {
      const p = pickPage(store, tab_id);
      return textResult(pageInfoView(p));
    }
  );

  mcp.registerTool(
    "get_dom",
    {
      title: "取得分頁的 DOM 快照",
      description:
        "取得分頁目前的 Raw DOM 快照(序列化 HTML)。分頁在線時會要求 Userscript 現場採集並等待回傳;" +
        "離線時回傳最後保存的快照並標示 freshness。html 過大時以 max_bytes 截斷。",
      inputSchema: { ...tabArg, max_bytes: z.number().int().positive().optional().describe("回傳 HTML 的位元組上限,預設不截斷") }
    },
    async ({ tab_id, max_bytes }) => {
      const p = pickPage(store, tab_id);
      const { snapshot, freshness, note } = await requestSnapshot(store, cfg, p, cfg.bridge.capture_wait_seconds * 1000);
      if (!snapshot) {
        return textResult(
          {
            freshness: freshness || "offline",
            note: "no_snapshot",
            detail: note === "capture_timeout" ? "現場採集逾時,且此分頁從未上傳過快照" : "此分頁從未送出過快照"
          },
          true
        );
      }
      const { s: html, truncated } = truncate(snapshot.html, max_bytes);
      return textResult({
        freshness,
        note: note || undefined,
        navigation_changed: snapshot.navigation_changed || undefined,
        tab_id: p.tab_id,
        document_id: snapshot.document_id,
        revision: snapshot.revision,
        captured_at: snapshot.captured_at,
        url: snapshot.url,
        title: snapshot.title,
        html_bytes: Buffer.byteLength(snapshot.html, "utf8"),
        truncated,
        html
      });
    }
  );

  mcp.registerTool(
    "get_text",
    {
      title: "取得分頁的可見文字",
      description: "取得分頁目前渲染出的可見文字(innerText,語意快照)。分頁在線時現場採集,離線時回傳最後保存的內容。",
      inputSchema: tabArg
    },
    async ({ tab_id }) => {
      const p = pickPage(store, tab_id);
      const { snapshot, freshness, note } = await requestSnapshot(store, cfg, p, cfg.bridge.capture_wait_seconds * 1000);
      if (!snapshot) {
        return textResult(
          {
            freshness: freshness || "offline",
            note: "no_snapshot",
            detail: note === "capture_timeout" ? "現場採集逾時,且此分頁從未上傳過快照" : "此分頁從未送出過快照"
          },
          true
        );
      }
      const { s: text, truncated } = truncate(snapshot.text, cfg.observer.max_text_chars);
      return textResult({
        freshness,
        note: note || undefined,
        tab_id: p.tab_id,
        document_id: snapshot.document_id,
        revision: snapshot.revision,
        captured_at: snapshot.captured_at,
        url: snapshot.url,
        title: snapshot.title,
        truncated,
        text
      });
    }
  );

  mcp.registerTool(
    "get_changes",
    {
      title: "查詢 DOM 變更紀錄",
      description: "查詢指定分頁自某版本號之後的 DOM 變更摘要(第一版為變更次數與時間,完整 Event Sourcing 後置)。",
      inputSchema: { ...tabArg, since_revision: z.number().int().nonnegative().optional().describe("起始版本號;省略則回傳最近變更") }
    },
    async ({ tab_id, since_revision }) => {
      const p = pickPage(store, tab_id);
      const since = since_revision ?? Math.max(0, p.dom_revision - 10);
      const events = p.mutation_log.filter((e) => e.revision > since);
      return textResult({
        tab_id: p.tab_id,
        document_id: p.document_id,
        current_revision: p.dom_revision,
        since_revision: since,
        changed: p.dom_revision > since,
        event_count: events.length,
        events
      });
    }
  );
}

function textResult(obj, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError };
}

function createMcpSessions(cfg, store) {
  const sessions = new Map(); // sessionId -> {transport, server}

  const host = cfg.bridge.host;
  const port = cfg.bridge.port;
  const allowedHosts = [`${host}:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!host.includes(":")) allowedHosts.push(host, "localhost"); // 無埠形式保底

  async function handle(req, res, parsedBody) {
    if (req.method === "GET") {
      // JSON-response 模式不提供 server-initiated SSE 串流
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed (SSE GET stream not supported)" }));
      return;
    }

    if (req.method === "DELETE") {
      const sid = req.headers["mcp-session-id"];
      const session = sid && sessions.get(sid);
      if (session) {
        sessions.delete(sid);
        await session.transport.close();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const sid = req.headers["mcp-session-id"];
    if (sid && sessions.has(sid)) {
      await sessions.get(sid).transport.handleRequest(req, res, parsedBody);
      return;
    }

    // 新連線:建立 session( initialize 请求),或交給暫存 transport 回 400
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: cfg.mcp.enable_json_response !== false,
      enableDnsRebindingProtection: true,
      allowedHosts
    });
    const mcp = new McpServer(SERVER_INFO);
    registerTools(mcp, store, cfg);
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
    if (transport.sessionId) {
      sessions.set(transport.sessionId, { transport, server: mcp });
    } else {
      // 非 initialize 請求(缺 session id)→ SDK 已回 400,清掉暫存執行個體
      await transport.close().catch(() => {});
    }
  }

  return { handle, sessions };
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

function createApp(cfg, store) {
  const mcpSessions = createMcpSessions(cfg, store);

  async function handler(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    try {
      if (u.pathname === "/healthz") {
        return json(res, 200, { ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version, pages: store.pages.size });
      }

      if (u.pathname === "/ingest" && req.method === "POST") {
        const token = req.headers["x-sidecar-token"];
        if (!cfg.bridge.token || token !== cfg.bridge.token) {
          return json(res, 401, { error: "unauthorized", detail: "X-Sidecar-Token 不符或未設定" });
        }
        const body = JSON.parse((await readBody(req, res)).toString("utf8") || "{}");
        const out = handleIngest(store, cfg, body);
        return json(res, out.status, out.body);
      }

      if (u.pathname === "/poll" && req.method === "GET") {
        const token = req.headers["x-sidecar-token"];
        if (!cfg.bridge.token || token !== cfg.bridge.token) {
          return json(res, 401, { error: "unauthorized", detail: "X-Sidecar-Token 不符或未設定" });
        }
        return json(res, 200, handlePoll(store, cfg, u.searchParams).body);
      }

      if (u.pathname === cfg.mcp.endpoint) {
        let parsedBody;
        if (req.method === "POST") {
          const raw = await readBody(req, res);
          try {
            parsedBody = JSON.parse(raw.toString("utf8"));
          } catch {
            return json(res, 400, { error: "invalid_json" });
          }
        }
        await mcpSessions.handle(req, res, parsedBody);
        return;
      }

      return json(res, 404, { error: "not_found", path: u.pathname });
    } catch (e) {
      console.error("[sidecar] 處理請求失敗:", e);
      if (!res.headersSent) return json(res, 500, { error: "internal", detail: String(e && e.message) });
      res.end();
    }
  }

  return { handler, mcpSessions };
}

function startServer(cfg, configPath) {
  const store = createStore(cfg);
  const app = createApp(cfg, store);
  const server = http.createServer((req, res) => app.handler(req, res));

  server.listen(cfg.bridge.port, cfg.bridge.host, () => {
    const base = `http://${cfg.bridge.host}:${cfg.bridge.port}`;
    console.log(`[sidecar] DOM Sidecar MCP v${SERVER_INFO.version} 已啟動`);
    console.log(`[sidecar]   Bridge(Userscript):POST ${base}/ingest、GET ${base}/poll`);
    console.log(`[sidecar]   MCP(AI Agent)    :${base}${cfg.mcp.endpoint}`);
    console.log(`[sidecar]   允許網域          :${(cfg.security.allowed_domains || []).join(", ")}`);
    console.log(`[sidecar]   Token             :${cfg.bridge.token || "(未設定!Userscript 將無法連入)"}`);
    if (process.env.DOM_SIDECAR_CONFIG) {
      console.log(`[sidecar]   設定檔            :${configPath || process.env.DOM_SIDECAR_CONFIG}`);
    }
  });

  return { server, store, app, cfg };
}

module.exports = { loadConfig, createStore, createApp, startServer, redactHtml, truncate, SERVER_INFO };

if (require.main === module) {
  const configPath = process.argv[2];
  const cfg = loadConfig(configPath);
  const inst = startServer(cfg, configPath);
  const shutdown = () => {
    console.log("\n[sidecar] 關閉中…");
    inst.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
