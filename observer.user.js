// ==UserScript==
// @name         DOM Sidecar Observer
// @namespace    local.sidecar
// @version      0.1.0
// @description  唯讀瀏覽器副駕駛觀察器:讀取 Live DOM 送到本機 Node.js MCP Server。不點擊、不導航、不注入操作 —— AI 只讀資料,瀏覽器由你控制。
// @author       dom-sidecar
// @match        *://*/*
// @run-at       document-idle
// @sandbox      DOM
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getTab
// @grant        GM_saveTab
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

/*
 * DOM Sidecar Observer(混合模式)
 *
 *  通訊全部由本腳本「主動」發起(Userscript 無法監聽本機埠):
 *   1. 載入後向本機服務註冊(register):tab_id + document_id + url + title
 *   2. MutationObserver 發現 DOM 變化 → debounce 後只送「狀態 + 版本號」(status)
 *   3. 每 HEARTBEAT_MS 輪詢一次 /poll(兼作心跳):有 capture 命令才序列化完整快照上傳
 *   4. 手動:油猴選單「立即擷取目前 DOM」可直接上傳一份快照
 *
 *  設定:
 *   - TOKEN 必須與 config.json 的 bridge.token 一致
 *   - 預設 match 所有網站(星號萬用);想排除敏感網站(網銀等)時,
 *     在 Tampermonkey 腳本設定加入使用者排除規則,或改回逐站 match 規則
 *   - 背景分頁的計時器會被瀏覽器節流,採集延遲可能變長,屬正常現象
 */

(() => {
  "use strict";

  // ------------------------------------------------------------------ 設定
  // 測試環境(模擬器/注入頁面)可預先定義 window.__SIDECAR_CONFIG__ 覆寫;
  // 正常 Tampermonkey 使用時不存在此變數,走預設值。
  const PAGE_CFG = (typeof window !== "undefined" && window.__SIDECAR_CONFIG__) || {};
  const BRIDGE = PAGE_CFG.BRIDGE || "http://127.0.0.1:8765";
  const TOKEN = PAGE_CFG.TOKEN || "dS-local-dev-7f31a8e2c4b9-CHANGE_ME"; // 與 config.json 的 bridge.token 相同
  const HEARTBEAT_MS = PAGE_CFG.HEARTBEAT_MS || 5000; // 與 config.json 的 bridge.heartbeat_seconds 相同
  const DEBOUNCE_MS = PAGE_CFG.DEBOUNCE_MS || 500; // 與 config.json 的 observer.debounce_ms 相同
  const MAX_HTML_BYTES = 2 * 1024 * 1024; // 與 observer.max_snapshot_bytes 相同
  const MAX_TEXT_CHARS = 100000;
  const MAX_LINKS = 500;

  // ------------------------------------------------------------------ 狀態
  let tabId = null;
  const documentId = "doc-" + Math.random().toString(36).slice(2, 10);
  let domRevision = 0;
  let pendingMutations = 0;
  let enabled = true;
  let warned = false;

  const log = (...a) => console.log("%c[Sidecar]", "color:#0d9488;font-weight:bold", ...a);
  const warn = (...a) => console.warn("%c[Sidecar]", "color:#d97706;font-weight:bold", ...a);

  // ----------------------------------------------------------- 本機通訊
  function bridge(method, path, data) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method,
        url: BRIDGE + path,
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": TOKEN },
        data: data === undefined ? undefined : JSON.stringify(data),
        timeout: 10000,
        onload: (r) => {
          let body = null;
          try { body = JSON.parse(r.responseText); } catch { /* 非 JSON 回應 */ }
          resolve({ status: r.status, body });
        },
        onerror: () => resolve({ status: 0, body: null }),
        ontimeout: () => resolve({ status: 0, body: null })
      });
    });
  }

  // --------------------------------------------------------- 分頁識別
  function initTabId() {
    return new Promise((resolve) => {
      GM_getTab((tab) => {
        if (!tab.sidecar_id) {
          tab.sidecar_id = "tab-" + Math.random().toString(36).slice(2, 8);
          GM_saveTab(tab); // 存活於此分頁整個生命週期(跨頁導航不變)
        }
        resolve(tab.sidecar_id);
      });
    });
  }

  // --------------------------------------------------------- 註冊與狀態
  function register() {
    return bridge("POST", "/ingest", {
      type: "register",
      tab_id: tabId,
      document_id: documentId,
      url: location.href,
      title: document.title,
      visibility: document.visibilityState,
      dom_revision: domRevision,
      ts: Date.now()
    }).then((r) => {
      if (r.status === 403) {
        enabled = false;
        if (!warned) {
          warned = true;
          warn(`網域 ${location.hostname} 不在 server 白名單,已停用。請把它加進 config.json 的 security.allowed_domains`);
        }
        return;
      }
      if (r.status === 0) {
        if (!warned) {
          warned = true;
          warn(`無法連上 ${BRIDGE}(請確認已執行 node server.js)`);
        }
        return;
      }
      log("已註冊", tabId, documentId, location.host);
    });
  }

  function sendStatus() {
    if (!enabled || pendingMutations === 0) return;
    const mutations = pendingMutations;
    pendingMutations = 0;
    domRevision += 1;
    bridge("POST", "/ingest", {
      type: "status",
      tab_id: tabId,
      document_id: documentId,
      url: location.href,
      title: document.title,
      visibility: document.visibilityState,
      dom_revision: domRevision,
      mutations,
      ts: Date.now()
    });
  }

  // --------------------------------------------------------- 快照採集
  function serializeSnapshot(requestId) {
    // 從 clone 序列化,不改动頁面本身;cloneNode 只帶屬性,輸入框「現值」
    // (DOM property)本來就不會進序列化結果,再主動抹除密碼欄位屬性以防萬一
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('input[type="password"]').forEach((el) => {
      el.removeAttribute("value");
      el.textContent = "";
    });
    clone.querySelectorAll("[data-sidecar-redact]").forEach((el) => {
      el.removeAttribute("value");
      el.textContent = "[REDACTED]";
    });

    let html = clone.outerHTML || "";
    if (utf8Length(html) > MAX_HTML_BYTES) {
      html = utf8Trim(html, MAX_HTML_BYTES);
    }

    let text = ((document.body && document.body.innerText) || "").slice(0, MAX_TEXT_CHARS);
    if (utf8Length(text) < 200) {
      // 背景分頁未排版時 innerText 可能近乎空,改從 clone 的 textContent 兜底
      const textClone = document.body ? document.body.cloneNode(true) : null;
      if (textClone) {
        textClone.querySelectorAll("script,style,noscript,template").forEach((el) => el.remove());
        const tc = (textClone.textContent || "").replace(/[ \t]+\n/g, "\n").trim();
        if (utf8Length(tc) > utf8Length(text)) text = tc.slice(0, MAX_TEXT_CHARS);
      }
    }
    const links = [...document.querySelectorAll("a[href]")]
      .slice(0, MAX_LINKS)
      .map((a) => ({ text: (a.innerText || "").trim().slice(0, 200), href: a.href }))
      .filter((l) => l.href);

    return {
      type: "snapshot",
      request_id: requestId || undefined,
      tab_id: tabId,
      document_id: documentId,
      url: location.href,
      title: document.title,
      visibility: document.visibilityState,
      dom_revision: domRevision,
      captured_at: Date.now(),
      html,
      text,
      links
    };
  }

  // 與 server 端相同的 UTF-8 位元組估算/裁切
  function utf8Length(s) {
    return new TextEncoder().encode(s).length;
  }
  function utf8Trim(s, maxBytes) {
    const bytes = new TextEncoder().encode(s).subarray(0, maxBytes);
    return new TextDecoder().decode(bytes);
  }

  function uploadSnapshot(requestId) {
    const snap = serializeSnapshot(requestId);
    return bridge("POST", "/ingest", snap).then((r) => {
      if (r.status === 200) log(`已上傳快照(${utf8Length(snap.html)} bytes HTML,rev ${snap.dom_revision})`);
      else warn("快照上傳失敗", r.status, r.body);
      return r;
    });
  }

  // --------------------------------------------------------- 輪詢(兼心跳)
  async function poll() {
    if (!enabled || !tabId) return;
    const q = new URLSearchParams({
      tab_id: tabId,
      document_id: documentId,
      visibility: document.visibilityState,
      dom_revision: String(domRevision),
      url: location.href,
      title: document.title
    });
    const r = await bridge("GET", "/poll?" + q.toString());
    if (r.status === 0) return; // 本機服務不在
    if (r.body && Array.isArray(r.body.commands)) {
      for (const cmd of r.body.commands) {
        if (cmd.action === "capture") {
          log("收到採集請求", cmd.request_id);
          await uploadSnapshot(cmd.request_id);
        }
      }
    }
  }

  // --------------------------------------------------------- DOM 監看
  function watchMutations() {
    let timer = null;
    const observer = new MutationObserver((records) => {
      pendingMutations += records.length;
      clearTimeout(timer);
      timer = setTimeout(sendStatus, DEBOUNCE_MS); // 只報「變了」,不序列化整頁
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // --------------------------------------------------------- 選單命令
  GM_registerMenuCommand("立即擷取目前 DOM", () => {
    if (!enabled) return warn("此網域未啟用(不在白名單)");
    uploadSnapshot();
  });
  GM_registerMenuCommand("顯示 Sidecar 狀態", () => {
    log("tab_id:", tabId, "| document_id:", documentId, "| revision:", domRevision, "| enabled:", enabled);
  });

  // --------------------------------------------------------- 啟動
  (async () => {
    tabId = await initTabId();
    await register();
    if (!enabled) return;
    watchMutations();
    poll();
    setInterval(poll, HEARTBEAT_MS);
    log("DOM Sidecar Observer 已啟動(唯讀模式)");
  })();
})();
