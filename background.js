/* =========================================================================
 * background.js — MV3 service worker（v0.6.0 新增）
 *
 * 这里承担两件 content script 做不到的事：
 *
 * ① **绕开 CORS**：content script 跑在网页上下文，fetch 受页面 CORS 约束
 *    （哪怕 manifest 写了 host_permissions）。background 的 fetch 带扩展权限，
 *    不受限制。以后若加 Gitee 源就能用（实测 Gitee raw 有 max-age=60 但没有
 *    Access-Control-Allow-Origin，页面里读不了，这里可以）。
 *
 * ② **绕开 jsDelivr 的 12 小时缓存**（本文件存在的主要理由）
 *    实测 2026-11-02：
 *      · jsDelivr 对分支引用返回 `cache-control: s-maxage=43200`（12 小时）
 *      · 调官方 purge API 返回 finished，但 3 分钟后 4 个节点**仍返回旧版本**
 *        → purge 不可依赖，改数据后用户可能要等半天才收到
 *    解法：先问 GitHub API 要最新 commit sha，再用 `@<sha>` 拼 jsDelivr 地址。
 *      jsDelivr 对 commit 引用是 immutable（永久缓存），而**每个新提交都是新 URL**，
 *      所以永远不会命中旧缓存 —— 缓存反而变成优点（同一版本加载极快）。
 *    实测 api.github.com 可用（HTTP 200 / 2.1s，本机直连不走代理）。
 *    未认证 60 次/小时/IP，而检查间隔是 6 小时，余量充足。
 *    若 API 不可用 → 退回 @main（可能滞后 12 小时，但总比没有强）。
 * ========================================================================= */
"use strict";

const FETCH_TIMEOUT = 15000;
const REPO = "SongYouAI/i668-ipo-predict";
const DATA_PATH = "dist/latest.json";
const CDN_HOSTS = ["testingcf", "gcore", "fastly", "cdn"];

async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctl.signal, credentials: "omit" });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    return { ok: true, status: res.status, text: text };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// 拿 main 分支最新 commit sha；拿不到返回 null（调用方退化为 @main）
async function latestSha() {
  const r = await fetchText("https://api.github.com/repos/" + REPO + "/commits/main");
  if (!r.ok || !r.text) return null;
  try {
    const j = JSON.parse(r.text);
    return typeof j.sha === "string" && j.sha.length >= 7 ? j.sha : null;
  } catch (e) { return null; }
}

// 生成候选地址：先 sha 版本（必然最新），再 @main（兜底），最后 raw（国内通常不通）
async function remoteUrls() {
  const sha = await latestSha();
  const urls = [];
  if (sha) {
    CDN_HOSTS.forEach((h) => {
      urls.push("https://" + h + ".jsdelivr.net/gh/" + REPO + "@" + sha + "/" + DATA_PATH);
    });
  }
  CDN_HOSTS.forEach((h) => {
    urls.push("https://" + h + ".jsdelivr.net/gh/" + REPO + "@main/" + DATA_PATH);
  });
  urls.push("https://raw.githubusercontent.com/" + REPO + "/main/" + DATA_PATH);
  return urls;
}

// 依次尝试，返回第一个拿到的文本
async function fetchFirst(urls) {
  const tried = [];
  for (const u of urls) {
    const r = await fetchText(u);
    if (r.ok && r.text) return { ok: true, url: u, text: r.text, tried: tried };
    tried.push({ url: u.slice(0, 90), status: r.status || 0, err: r.err || "" });
  }
  return { ok: false, tried: tried };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return undefined;

  // 取远程参数库：由本文件负责解析「最新 sha → CDN 地址」
  if (msg.type === "i668p.remote") {
    remoteUrls()
      .then((urls) => fetchFirst(urls))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, tried: [], err: String((e && e.message) || e) }));
    return true;   // 异步回复，通道保持打开
  }

  // 通用取文本（调试 / 将来扩展用）
  if (msg.type === "i668p.fetch") {
    fetchFirst(msg.urls || [])
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, tried: [], err: String((e && e.message) || e) }));
    return true;
  }

  return undefined;
});
