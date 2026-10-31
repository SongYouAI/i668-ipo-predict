/* =========================================================================
 * tools/backtest.js
 * 用 i668 真实历史样本（/api/ipo-stocks 中超购倍数 + 暗盘涨跌幅齐全者）
 * 验证 S2（中签后 → 暗盘）预测区间的命中率与点估计误差。
 *
 * 运行： node tools/backtest.js
 * 依赖： Node 18+（自带 fetch / crypto）
 *
 * ⚠️ v0.5.0 重写：**不再自己抄一份参数**。
 *    旧版把 OVER_BUCKETS 复制了一份（还是 v0.3 的对称 base/spread 口径），
 *    于是 core.js 改了模型、backtest 还在跑旧参数 —— 复跑出来的数字与 README
 *    对不上，等于用一份过期的证据给新模型背书。
 *    现在改为直接加载 content/core.js 并调用 P.predictS2，
 *    参数只有一处定义，永远同步。改模型后 `node tools/backtest.js` 即为最新真相。
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
  const i = base + p;
  const t = Math.floor(Date.now() / 1e3).toString();
  const s = sign(t, i, "", "");
  const res = await fetch("https://www.i668.vip" + base + p, {
    headers: {
      "X-Timestamp": t, "X-Sign": s,
      Referer: "https://www.i668.vip/stocks", Origin: "https://www.i668.vip",
    },
  });
  return res.json();
}

// —— 加载真实 content/core.js（不复制任何模型参数）——
function loadCore() {
  const src = fs.readFileSync(path.join(__dirname, "..", "content", "core.js"), "utf8");
  const sandbox = {
    console, TextEncoder, crypto: require("crypto").webcrypto, setTimeout, URL,
    window: {}, document: { createElement: () => ({}) },
    fetch: async () => { throw new TypeError("backtest 离线"); },
    chrome: {
      storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener() {} } },
      runtime: { getURL: (p) => p },
    },
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 顺序固定：extras（因子库）→ ahclose（A+H 基准价）→ core
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "data", "extras.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "data", "ahclose.js"), "utf8"), sandbox);
  vm.runInContext(src, sandbox);
  const P = sandbox.window.I668P;
  if (!P) throw new Error("core.js 加载后未导出 I668P");
  return P;
}

// A+H 溢价改用「招股截止日 A 股收盘价」（data/ahclose.js），与标定口径一致；
// 恒指取不到历史值，一律关闭（hsi = null 时代码不会叠加）
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

function bucketOf(o) {
  if (o < 15) return "<15";
  if (o < 100) return "15-100";
  if (o < 500) return "100-500";
  if (o < 1000) return "500-1k";
  if (o < 3000) return "1k-3k";
  if (o < 6000) return "3k-6k";
  return ">6k";
}
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const k = (s.length - 1) * 0.5, f = Math.floor(k);
  return s[f] + (s[Math.min(f + 1, s.length - 1)] - s[f]) * (k - f);
};

(async () => {
  const P = loadCore();
  const stocks = await apiGet("/ipo-stocks");
  buildCtx(stocks);
  const rows = stocks.filter(
    (x) => x.public_offer_subscription_multiple != null && x.dark_pool_change_pct != null
  );
  console.log("样本（超购 + 暗盘齐全）：", rows.length);
  console.log("参数来源：content/core.js 实时加载（OVER_BUCKETS 共 " + P.OVER_BUCKETS.length + " 档）\n");

  let hit = 0, n = 0, wSum = 0;
  const errs = [], byBucket = {};
  const RECENT = "2026-07-01";

  rows.forEach((s) => {
    const over = P.num(s.public_offer_subscription_multiple);
    const actual = P.num(s.dark_pool_change_pct);
    const r = P.predictS2(Object.assign({}, s, { ipo_price: P.num(s.ipo_price) }), CTX);
    if (!r || r.base == null) return;
    n++;
    const inRange = actual >= r.loPct && actual <= r.hiPct;
    if (inRange) hit++;
    errs.push(Math.abs(actual - r.base));
    wSum += r.hiPct - r.loPct;

    const b = bucketOf(over);
    const o = (byBucket[b] = byBucket[b] || { n: 0, hits: 0, err: [], act: [], recent: 0 });
    o.n++;
    if (inRange) o.hits++;
    o.err.push(Math.abs(actual - r.base));
    o.act.push(actual);
    if ((s.listing_date || "") >= RECENT) o.recent++;
  });

  console.log("【整体】");
  console.log("  区间命中率（实际落入预测区间）：", (hit / n * 100).toFixed(1) + "%  （名义 50%）");
  console.log("  点估计误差中位数：            ", med(errs).toFixed(1) + "pt");
  console.log("  平均区间宽度：                ", (wSum / n).toFixed(1) + "pt\n");

  console.log("【分超购档位】");
  console.log("  档位        n   命中率   误差中位   实际中位暗盘%   区间宽度");
  const BUCK_ORDER = ["<15", "15-100", "100-500", "500-1k", "1k-3k", "3k-6k", ">6k"];
  BUCK_ORDER.forEach((b) => {
    const d = byBucket[b];
    if (!d) return;
    const bk = P.overBucket(Number(b === "<15" ? 10 : b === "15-100" ? 50 : b === "100-500" ? 200 :
      b === "500-1k" ? 700 : b === "1k-3k" ? 2000 : b === "3k-6k" ? 4000 : 8000));
    const w = (bk.dLo + bk.dHi).toFixed(1);
    console.log(
      "  " + b.padEnd(9),
      String(d.n).padEnd(4),
      (d.hits / d.n * 100).toFixed(0).padStart(4) + "%",
      med(d.err).toFixed(1).padStart(8) + "pt",
      ((med(d.act) >= 0 ? "+" : "") + med(d.act).toFixed(1)).padStart(12),
      (w + "pt").padStart(10)
    );
  });

  // 单独看「当前环境」——老板真正关心的那一段
  const rec = rows.filter((s) => (s.listing_date || "") >= RECENT &&
    s.public_offer_subscription_multiple != null && s.dark_pool_change_pct != null);
  let rh = 0, rn = 0, re = [];
  rec.forEach((s) => {
    const r = P.predictS2(s, CTX);
    if (!r || r.base == null) return;
    const a = P.num(s.dark_pool_change_pct);
    rn++;
    if (a >= r.loPct && a <= r.hiPct) rh++;
    re.push(Math.abs(a - r.base));
  });
  console.log("\n【2026-07 之后（当前市场环境）】");
  console.log("  n =", rn, " 命中率 =", (rh / rn * 100).toFixed(1) + "%", " 误差中位 =", med(re).toFixed(1) + "pt");
  // ===== A+H 降级路径（空窗期的真实形态）=====
  // 上面的样本都「超购齐全」，走的是超购分档，A+H 根本没参与。
  // 空窗期（招股已截止、配售结果未公布）时超购为 null → 才走 A+H 线性模型。
  // 这里把超购置空来模拟那一刻，量化「用户在空窗期真正看到的数」到底准不准。
  const ahRows = rows.filter((s) => CTX.ah[s.a_share_code] != null && s.dark_pool_change_pct != null);
  let ahHit = 0, ahErr = [], ahW = 0, ahThin = 0;
  const ahDetail = [];
  ahRows.forEach((s) => {
    const sim = Object.assign({}, s, {
      public_offer_subscription_multiple: null,
      international_subscription_multiple: null,
    });
    const r = P.predictS2(sim, CTX);
    if (!r || r.base == null) return;
    const a = P.num(s.dark_pool_change_pct);
    const inr = a >= r.loPct && a <= r.hiPct;
    if (inr) ahHit++;
    ahErr.push(Math.abs(a - r.base));
    ahW += r.hiPct - r.loPct;
    ahDetail.push({ code: s.stock_code, prem: CTX.ah[s.a_share_code], a: a, lo: r.loPct, hi: r.hiPct, med: r.base, inr: inr });
  });
  console.log("\n【A+H 降级路径：模拟空窗期（超购置空）→ 暗盘】");
  console.log("  n =", ahDetail.length, " 命中率 =", (ahHit / ahDetail.length * 100).toFixed(1) + "%",
    " 误差中位 =", med(ahErr).toFixed(1) + "pt", " 平均宽度 =", (ahW / ahDetail.length).toFixed(1) + "pt");
  if (ahDetail.length) {
    const REC2 = "2026-07-01";
    const recD = ahDetail.filter((d) => (rows.find((x) => x.stock_code === d.code).listing_date || "") >= REC2);
    if (recD.length) {
      const rh = recD.filter((d) => d.inr).length;
      console.log("  其中 2026-07 后：n =", recD.length, " 命中 =", (rh / recD.length * 100).toFixed(1) + "%",
        " 实际中位 =", med(recD.map((d) => d.a)).toFixed(1) + "pt");
    }
    const hist = ahDetail.filter((d) => (rows.find((x) => x.stock_code === d.code).listing_date || "") < REC2);
    if (hist.length) {
      console.log("  其中 2026-07 前：n =", hist.length, " 命中 =",
        (hist.filter((d) => d.inr).length / hist.length * 100).toFixed(1) + "%",
        " 实际中位 =", med(hist.map((d) => d.a)).toFixed(1) + "pt");
    }
  }

  console.log("\n（说明：A+H 溢价取 data/ahclose.js 的招股截止日收盘价，与标定口径一致；恒指无历史值故未叠加；");
  console.log("  超购齐全的样本本来也不走 A+H 降级路径，不影响可比性。）");
})();
