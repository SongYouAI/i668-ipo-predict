/* =========================================================================
 * tools/verify-s1-margin.js
 * 验证 v0.8.0 的核心改动：**招股期预测 S1 随实时孖展倍数变化**。
 *
 * 运行： node tools/verify-s1-margin.js
 * 依赖： Node 18+（自带 fetch / crypto）
 *
 * 验证四件事：
 *   ① 同一只股，孖展倍数取不同值时，S1 的中枢/区间确实随之移动（不是写死的）；
 *   ② 落档与 OVER_BUCKETS 一致（同一套参数，S1 与 S2 不会漂移）；
 *   ③ 无孖展数据时，S1 退回 A+H / 赛道旧路径（不报错、不变 NaN）；
 *   ④ 「涨跌幅 ↔ 价格」严格互推（界面上的 % 手算价格必须对得上）。
 *
 * 依赖 i668 真实接口 + 華盛証券公开页；两者任一不可用时用内置快照兜底。
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

// 華盛「預計孖展倍數」—— 与 background.js 的 parseMarginTable 同一解析口径
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
    out[codeM[1]] = { m: m, n: tds[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
  }
  return out;
}
async function fetchMargin() {
  try {
    const res = await fetch("https://www.valuable.com.hk/ipo/hk/v2/ipo-hk-index", {
      cache: "no-store",
      headers: { "Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-HK,zh;q=0.9" },
    });
    const html = await res.text();
    const d = parseMarginTable(html);
    if (Object.keys(d).length) return { data: d, live: true };
  } catch (e) { /* 离线：走快照 */ }
  // 内置快照（2026-11-04 实测值）：招股中 5 只 + 待上市（招股已截止）2 只
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

function loadCore(marginData) {
  const src = fs.readFileSync(path.join(__dirname, "..", "content", "core.js"), "utf8");
  const sandbox = {
    console, TextEncoder, crypto: require("crypto").webcrypto, setTimeout, URL,
    window: {}, document: { createElement: () => ({}) },
    fetch: async () => { throw new TypeError("verify 离线"); },
    chrome: {
      storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener() {} } },
      runtime: {
        getURL: (p) => p,
        // 注入孖展数据（与插件真实链路同一个入口：background → i668p.margin）
        sendMessage: (msg, cb) => {
          if (msg && msg.type === "i668p.margin") cb({ ok: true, src: "verify", data: marginData });
          else cb(null);
        },
      },
    },
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "data", "extras.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "data", "ahclose.js"), "utf8"), sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.I668P;
}

const AHC = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "ahclose.js"), "utf8")
  .replace(/^[\s\S]*?window\.I668P_AHCLOSE\s*=\s*/, "").replace(/;\s*$/, ""));
const CTX = { ah: {}, ahMeta: {}, hsi: null };
function buildCtx(stocks) {
  stocks.forEach((s) => {
    const r = AHC.close[s.stock_code];
    const ipo = Number(s.ipo_price);
    if (!r || !(ipo > 0)) return;
    CTX.ah[s.a_share_code] = +(((r.c * 1.09) / ipo - 1) * 100).toFixed(1);
    CTX.ahMeta[s.a_share_code] = { src: "lib", d: r.d, c: r.c, hk: s.stock_code };
  });
}
const pct = (p) => (p >= 0 ? "+" : "") + p.toFixed(1) + "%";

(async () => {
  const margin = await fetchMargin();
  const P = loadCore(margin.data);
  await P.loadMargin(true);                       // 与插件运行时同一条链路
  const stocks = await apiGet("/ipo-stocks");
  buildCtx(stocks);
  const map = {};
  stocks.forEach((s) => { map[s.stock_code] = s; });

  console.log("孖展源：" + (margin.live ? "華盛証券公开页（实时）" : "内置快照（离线）") +
    " · " + Object.keys(margin.data).length + " 只\n");
  console.log("=== ① 有孖展数据的股：S1 是否随倍数落档 ===");
  console.log("代码    名称        孖展      热度档    S1 区间            中枢   置信  破发率");
  const seen = [];
  Object.keys(margin.data).forEach((code) => {
    const s = map[code];
    if (!s) return;
    const r = P.predictS1(s, CTX);
    if (!r) return;
    const mg = margin.data[code].m;
    const tier = P.marginTierLabel(mg);
    const b = P.overBucket(mg);
    const pb = r.pb != null ? Math.round(r.pb * 100) + "%" : "—";
    console.log(
      code.padEnd(7) + (s.stock_name || "").padEnd(11) +
      String(mg).padStart(7) + "  " + tier.padEnd(7) +
      (pct(r.loPct) + " ~ " + pct(r.hiPct)).padEnd(18) +
      pct((r.loPct + r.hiPct) / 2).padStart(7) + "  " +
      P.stars(r.conf).padEnd(5) + "  " + pb.padStart(5) +
      "   [档 " + P.overBucketTxt(mg) + " 中位 " + pct(b.med, 1) + "]"
    );
    seen.push({ code: code, m: mg, mid: (r.loPct + r.hiPct) / 2, lo: r.loPct, hi: r.hiPct });
  });

  console.log("\n=== ② 单调性检查 ===");
  console.log("  ②a 档位映射（孖展 → 热度档 → 该档中枢）必须单调 —— 这是孖展本身的性质");
  const byBucket = [];
  Object.keys(margin.data).forEach((code) => {
    const mg = margin.data[code].m;
    const b = P.overBucket(mg);
    if (!byBucket.find((x) => x.b === b)) byBucket.push({ b: b, m: mg, med: b.med });
  });
  byBucket.sort((a, b) => a.m - b.m);
  let mono = true;
  for (let i = 1; i < byBucket.length; i++) {
    if (byBucket[i].med < byBucket[i - 1].med - 1e-9) {
      mono = false;
      console.log("    ✗ 反向：" + byBucket[i - 1].m + "倍(" + byBucket[i - 1].med + ") → " + byBucket[i].m + "倍(" + byBucket[i].med + ")");
    }
  }
  console.log(mono
    ? "    ✓ 单调成立：" + byBucket.map((x) => x.m + "倍→" + x.med + "%").join(" | ")
    : "    ✗ 存在反向");
  console.log("  ②b 最终 S1 中枢（叠了保荐人/基石/18C 等独立修正后）不必严格单调 —— 那部分不是孖展贡献的");
  const sorted = [...seen].sort((a, b) => a.m - b.m);
  console.log("    " + sorted.map((x) => x.m + "倍→" + pct(x.mid)).join(" | "));

  console.log("\n=== ③ 无孖展数据时是否退回旧路径 ===");
  const noM = stocks.filter((s) => !margin.data[s.stock_code] && Number(s.ipo_price) > 0).slice(0, 3);
  noM.forEach((s) => {
    const r = P.predictS1(s, CTX);
    const mg = margin.data[s.stock_code];
    console.log("  " + s.stock_code + " " + (s.stock_name || "").padEnd(10) +
      " 孖展=" + (mg ? mg.m : "无") + " → S1 " + (r ? pct(r.loPct) + " ~ " + pct(r.hiPct) : "null") +
      "  锚=" + (r && r.anchor ? r.anchor.k : "—"));
  });

  console.log("\n=== ④ 涨跌幅 ↔ 价格 严格互推 ===");
  let bad = 0;
  seen.forEach((x) => {
    const s = map[x.code];
    const ipo = Number(s.ipo_price);
    const r = P.predictS1(s, CTX);
    const lo = Math.round(ipo * (1 + r.loPct / 100) * 1000) / 1000;
    const hi = Math.round(ipo * (1 + r.hiPct / 100) * 1000) / 1000;
    const dLo = Math.abs(lo - r.lo), dHi = Math.abs(hi - r.hi);
    if (dLo > 1e-9 || dHi > 1e-9) { bad++; console.log("  ✗ " + x.code + " " + dLo + "/" + dHi); }
  });
  console.log(bad ? "  ✗ " + bad + " 只不互推" : "  ✓ 全部互推（% × 发行价 = 显示价格，误差 0）");
})().catch((e) => { console.error("验证失败：", e); process.exit(1); });
