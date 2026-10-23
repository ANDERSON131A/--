// 模擬網站:給 Userscript 模擬器與真實瀏覽器上機測試用的「假機票網站」。
// - /                      動態頁:價格每 2 秒自動變動、「更新價格」按鈕重排卡片、含密碼欄位
// - /static                靜態頁
// - /__sidecar__/gm-shim.js    GM_* API 網頁版 shim(讓 observer.user.js 直接在頁面內跑)
// - /__sidecar__/observer.js   observer.user.js 去除 metadata 後的原碼
// 啟動:node test/mock-site.mjs [埠](預設 18770);BRIDGE/TOKEN 讀自 config.json
"use strict";

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const PORT = Number(process.argv[2]) || 18770;
const BRIDGE = `http://${cfg.bridge.host}:${cfg.bridge.port}`;

// ---- 模擬頁面 ---------------------------------------------------------------

function page(title, marker, body) {
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <h1>${title}</h1>
  <main id="main">${body}</main>
  <!-- E2E marker: ${marker} -->
  <form>
    <input type="text" name="user" value="demo_user">
    <input type="password" name="pw" value="TOP_SECRET_PW">
  </form>
  <script src="/__sidecar__/gm-shim.js"></script>
  <script>window.__SIDECAR_CONFIG__ = ${JSON.stringify({ BRIDGE, TOKEN: cfg.bridge.token })};</script>
  <script src="/__sidecar__/observer.js"></script>
</body></html>`;
}

const FLIGHT_PAGE = () => page("機票搜尋結果(模擬)", "MOCK_FLIGHT_E2E", `
  <p id="route">重慶 → 高雄,2027-01-18</p>
  <button id="btn-update" type="button">更新價格</button>
  <ul id="flights">
    <li class="card" id="f1">範例航空 A 08:30→15:20 轉機1 <b class="price">NT$ 2,500</b></li>
    <li class="card" id="f2">範例航空 B 13:10→20:40 轉機1 <b class="price">NT$ 3,100</b></li>
  </ul>
  <a href="/static">查看說明</a>
  <script>
    // 自動小變動:讓 MutationObserver / revision 持續前進(模擬動態網站)
    let tick = 0;
    setInterval(() => {
      tick++;
      const el = document.querySelector("#route small") || document.createElement("small");
      el.textContent = " 報價更新 #" + tick;
      el.id = "tick";
      document.querySelector("#route").appendChild(el);
    }, 2000);
    // 「更新價格」:大幅重排卡片(給上機測試用按鈕)
    document.getElementById("btn-update").addEventListener("click", () => {
      const ul = document.getElementById("flights");
      ul.innerHTML = "";
      ["範例航空 C 09:00→16:30 直飛 <b class='price'>NT$ 4,200</b>",
       "範例航空 D 11:20→18:45 轉機2 <b class='price'>NT$ 2,900</b>"].forEach((t, i) => {
        const li = document.createElement("li");
        li.className = "card"; li.id = "n" + i; li.innerHTML = t; ul.appendChild(li);
      });
    });
  </script>`);

const STATIC_PAGE = () => page("說明頁(靜態)", "MOCK_STATIC_E2E", `<p>這是靜態頁面,內容不會變。</p>`);

// ---- GM_* shim(僅測試用:把 userscript 的環境搬到普通網頁) ------------------

const GM_SHIM = `// GM_* shim for in-page testing only(模擬 Tampermonkey API)
(() => {
  window.GM_xmlhttpRequest = ({ method, url, headers, data, timeout, onload, onerror, ontimeout }) => {
    const ctrl = (timeout && typeof AbortSignal !== "undefined" && AbortSignal.timeout)
      ? { signal: AbortSignal.timeout(timeout) } : {};
    fetch(url, { method, headers, body: method === "POST" ? data : undefined, ...ctrl })
      .then(async (r) => onload && onload({ status: r.status, responseText: await r.text() }))
      .catch((e) => { if (ontimeout && e && e.name === "TimeoutError") ontimeout(); else if (onerror) onerror(e); });
  };
  const tabStore = JSON.parse(sessionStorage.getItem("__sidecar_tab") || "{}");
  window.GM_getTab = (cb) => cb(tabStore);
  window.GM_saveTab = (t) => { Object.assign(tabStore, t); sessionStorage.setItem("__sidecar_tab", JSON.stringify(tabStore)); };
  window.__sidecarMenu = window.__sidecarMenu || {};
  window.GM_registerMenuCommand = (label, fn) => { window.__sidecarMenu[label] = fn; };
})();`;

// observer.user.js 原碼:去掉 ==UserScript== metadata 區塊
function observerSource() {
  const src = fs.readFileSync(path.join(ROOT, "observer.user.js"), "utf8");
  return src.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, "");
}

// ---- HTTP server ------------------------------------------------------------

http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, body, type = "text/html; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };
  if (u.pathname === "/") return send(200, FLIGHT_PAGE());
  if (u.pathname === "/static") return send(200, STATIC_PAGE());
  if (u.pathname === "/__sidecar__/gm-shim.js") return send(200, GM_SHIM, "text/javascript; charset=utf-8");
  if (u.pathname === "/__sidecar__/observer.js") return send(200, observerSource(), "text/javascript; charset=utf-8");
  send(404, "not found");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-site] 模擬網站已啟動:http://127.0.0.1:${PORT}/(BRIDGE=${BRIDGE})`);
});
