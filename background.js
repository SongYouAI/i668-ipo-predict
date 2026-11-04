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

/* =========================================================================
 * 实时孖展倍数（招股期热度）—— 2026-11-04 新增
 *
 * 为什么必须由 background 抓：content script 的 fetch 受页面 CORS 约束，
 * 读不了跨域的券商站点；background 的 fetch 带扩展 host_permissions，不受限制。
 *
 * ⚠️ 口径必须分清，界面不能混着显示：
 *   huasheng   → 華盛證券「預計孖展倍數」＝ 该券商融资认购(孖展)口径的超购倍数，
 *                招股期内实时跳变，是**最终公开发售超购倍数的下界**。
 *   tradesmart → 第三方（TradeSmart）按 AAStocks/華盛 校准估算的「市場預估超購倍數」，
 *                与上一条不是同一口径，只在主源取不到时兜底。
 *
 * 两个源都是**服务端渲染的 HTML**（非 JS 渲染），故纯 fetch + 正则即可解析，
 * 不需要执行页面脚本 —— 这也是选它们而不选 AAStocks/etnet 的原因（那两个是 SPA）。
 * ========================================================================= */
const MARGIN_SOURCES = [
  { src: "huasheng", url: "https://www.valuable.com.hk/ipo/hk/v2/ipo-hk-index" },
  { src: "huasheng", url: "https://www.vbkr.com/ipo/hk/v2/ipo-hk-index" },
  { src: "tradesmart", url: "https://lowrisktradesmart.org/zh-hk/tools/ipo-tracker" },
];

async function fetchHtml(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, {
      cache: "no-store", signal: ctl.signal, credentials: "omit",
      headers: { "Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-HK,zh;q=0.9" },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    return { ok: true, status: res.status, text: text };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// 華盛：表格每行一个新股，第 1 列是「02065.HK」，第 7 列是「<span class="col-blue">12.34倍</span>」
function parseMarginTable(html) {
  const out = {};
  const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  for (const tr of trs) {
    const tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tds.length < 7) continue;
    const codeM = tds[0].match(/(\d{5})\.HK/);
    if (!codeM) continue;
    const flat = tds[6].replace(/<[^>]+>/g, " ");
    const multM = flat.match(/([\d.]+)\s*倍/);
    if (!multM) continue;
    const m = parseFloat(multM[1]);
    if (!isFinite(m)) continue;
    const name = tds[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
      .replace(/最大\s*\d+\s*倍槓杆融資/, "").trim();
    out[codeM[1]] = { m: m, n: name };
  }
  return out;
}

// TradeSmart：Next.js SSR，数据在转义后的 flight JSON 里
//   \"symbol\":\"02065\", ... \"oversubscription_ratio\":0.352
function parseMarginTradeSmart(html) {
  const out = {};
  const re = /\\"symbol\\":\\"(\d{5})\\"[\s\S]{0,800}?\\"oversubscription_ratio\\":([\d.]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const v = parseFloat(m[2]);
    if (isFinite(v)) out[m[1]] = { m: v, n: "" };
  }
  return out;
}

async function fetchMargin() {
  const tried = [];
  for (const s of MARGIN_SOURCES) {
    const r = await fetchHtml(s.url);
    if (!r.ok) { tried.push({ src: s.src, url: s.url.slice(0, 70), err: r.err || ("HTTP " + r.status) }); continue; }
    const data = s.src === "tradesmart" ? parseMarginTradeSmart(r.text) : parseMarginTable(r.text);
    const keys = Object.keys(data);
    if (!keys.length) { tried.push({ src: s.src, url: s.url.slice(0, 70), err: "解析到 0 只新股" }); continue; }
    return { ok: true, src: s.src, url: s.url, ts: Date.now(), count: keys.length, data: data, tried: tried };
  }
  return { ok: false, err: "所有孖展源均失败", tried: tried };
}

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

  // 招股期实时孖展倍数（跨域抓券商公开页，background 才能绕开 CORS）
  if (msg.type === "i668p.margin") {
    fetchMargin()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, err: String((e && e.message) || e), tried: [] }));
    return true;
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
