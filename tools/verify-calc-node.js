/* =========================================================================
 * tools/verify-calc-node.js —— 把浏览器内的 verify-calc.js 搬到 Node 里跑
 *
 * 为什么需要它：verify-calc.js 原本要在真机浏览器里注入执行（沙箱不能
 * --load-extension）。但 v0.8.0 改了 S1 的锚（改用实时孖展倍数），必须能
 * **带孖展数据**重跑同一套断言 —— 否则「S1 最后一个带区间端点的步骤 == 最终区间」
 * 这条回归守卫没人盯着。
 *
 * 运行： node tools/verify-calc-node.js
 * 依赖： Node 18+
 *
 * 做法：同一个 VM 里加载 extras/ahclose/core → 拉真实 i668 接口填 P.CACHE →
 *       用 background 同款解析抓華盛孖展并注入 → 原样执行 verify-calc.js 的源码。
 *       断言代码**不复制**，避免两份实现漂移。
 * ========================================================================= */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const SECRET = "6680fc61c8585cfca143366eea267b67617b7c2830c1c896cd952b276db117c9";
function sign(t, i, a, o) {
  return crypto.createHmac("sha256", SECRET).update(t + i + a + o + SECRET).digest("hex");
}
async function apiGet(p) {
  const base = "/api";
  const t = Math.floor(Date.now() / 1e3).toString();
  const res = await fetch("https://www.i668.vip" + base + p, {
    headers: {
      "X-Timestamp": t, "X-Sign": sign(t, base + p, "", ""),
      Referer: "https://www.i668.vip/stocks", Origin: "https://www.i668.vip",
    },
  });
  return res.json();
}
function parseMarginTable(html) {   // 与 background.js 同一解析口径
  const out = {};
  const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  for (const tr of trs) {
    const tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tds.length < 7) continue;
    const codeM = tds[0].match(/(\d{5})\.HK/);
    if (!codeM) continue;
    const multM = tds[6].replace(/<[^>]+>/g, " ").match(/([\d.]+)\s*倍/);
    if (!multM) continue;
    const m = parseFloat(multM[1]);
    if (isFinite(m)) out[codeM[1]] = { m: m, n: tds[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
  }
  return out;
}
async function fetchMargin() {
  try {
    const res = await fetch("https://www.valuable.com.hk/ipo/hk/v2/ipo-hk-index", {
      cache: "no-store",
      headers: { "Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-HK,zh;q=0.9" },
    });
    const d = parseMarginTable(await res.text());
    if (Object.keys(d).length) return { data: d, live: true };
  } catch (e) { /* 离线 */ }
  return {
    live: false,
    data: {
      "07672": { m: 2.52, n: "芯德半导体" }, "09917": { m: 1.38, n: "登临科技" },
      "02206": { m: 4.0, n: "新荷花" }, "02681": { m: 0.81, n: "宏芯宇" },
      "02065": { m: 0.22, n: "一微科技" }, "00054": { m: 1.91, n: "和美药业－Ｂ" },
      "09621": { m: 648.9, n: "远信储能" },
    },
  };
}

(async () => {
  const margin = await fetchMargin();
  const sandbox = {
    console, TextEncoder, crypto: require("crypto").webcrypto, setTimeout, clearTimeout, URL,
    window: {}, document: { createElement: () => ({}) },
    fetch: async () => { throw new TypeError("verify-calc-node 离线"); },
    chrome: {
      storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener() {} } },
      runtime: {
        getURL: (p) => p,
        sendMessage: (msg, cb) => {
          if (msg && msg.type === "i668p.margin") cb({ ok: true, src: "verify", data: margin.data });
          else cb(null);
        },
      },
    },
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const R = (p) => path.join(__dirname, "..", p);
  vm.runInContext(fs.readFileSync(R("data/extras.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(R("data/ahclose.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(R("content/core.js"), "utf8"), sandbox);
  const P = sandbox.window.I668P;

  // 填 P.CACHE（与 core.loadData 同一结构）
  const stocks = await apiGet("/ipo-stocks");
  const map = {};
  stocks.forEach((s) => { map[s.stock_code] = s; });
  const AHC = JSON.parse(fs.readFileSync(R("data/ahclose.js"), "utf8")
    .replace(/^[\s\S]*?window\.I668P_AHCLOSE\s*=\s*/, "").replace(/;\s*$/, ""));
  const ctx = { hsi: null, ah: {}, ahMeta: {} };
  stocks.forEach((s) => {
    const r = AHC.close[s.stock_code];
    const ipo = Number(s.ipo_price);
    if (!r || !(ipo > 0)) return;
    ctx.ah[s.a_share_code] = +(((r.c * 1.09) / ipo - 1) * 100).toFixed(1);
    ctx.ahMeta[s.a_share_code] = { src: "lib", d: r.d, c: r.c, hk: s.stock_code };
  });
  P.CACHE = { map: map, ctx: ctx };
  await P.loadMargin(true);     // 注入孖展（与插件运行时同一条链路）

  console.log("孖展源：" + (margin.live ? "華盛証券公开页（实时）" : "内置快照（离线）") +
    " · " + Object.keys(margin.data).length + " 只\n");
  // 原样执行 verify-calc.js（断言代码不复制）
  const out = vm.runInContext(fs.readFileSync(R("tools/verify-calc.js"), "utf8"), sandbox);
  console.log(out);
})().catch((e) => { console.error("验证失败：", e); process.exit(1); });
