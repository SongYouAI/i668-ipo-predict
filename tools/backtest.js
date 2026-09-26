/* =========================================================================
 * tools/backtest.js
 * 用 i668 真实历史样本（/api/ipo-stocks 中超购倍数 + 暗盘涨跌幅齐全者）
 * 验证 S2（中签后→暗盘）预测区间的命中率与方向准确率。
 *
 * 运行： node tools/backtest.js
 * 依赖： Node 18+（自带 fetch / crypto）
 * 说明： 与 content/core.js 中的预测逻辑保持一致（去除实时行情修正，
 *        因为历史样本无当时行情），用于证明模型校准有依据。
 * ========================================================================= */
const crypto = require("crypto");

const SECRET = "6680fc61c8585cfca143366eea267b67617b7c2830c1c896cd952b276db117c9";

function sign(t, i, a, o) {
  return crypto.createHmac("sha256", SECRET).update(t + i + a + o + SECRET).digest("hex");
}
async function apiGet(path) {
  const base = "/api";
  const i = base + path;
  const t = Math.floor(Date.now() / 1e3).toString();
  const s = sign(t, i, "", "");
  const res = await fetch("https://www.i668.vip" + base + path, {
    headers: { "X-Timestamp": t, "X-Sign": s, "Referer": "https://www.i668.vip/stocks", "Origin": "https://www.i668.vip" },
  });
  return res.json();
}

// —— 与 content/core.js 同步的校准映射 ——
const OVER_BUCKETS = [
  { max: 15, base: -3, spread: 14 },
  { max: 100, base: 1, spread:14 },
  { max: 500, base: 3, spread: 22 },
  { max: 1000, base: 21, spread: 18 },
  { max: 3000, base: 71, spread: 25 },
  { max: 6000, base: 56, spread: 30 },
  { max: Infinity, base: 130, spread: 35 },
];
function overBucket(o) { for (const b of OVER_BUCKETS) if (o < b.max) return b; return OVER_BUCKETS[OVER_BUCKETS.length - 1]; }
function sectorAdj(s) {
  const n = s.stock_name || "";
  const ch = s.listing_chapter || "";
  let a = 0;
  if (/科技|电子|半导体|芯片|智能|机器人|自动化|数控|精密|光电|芯|光伏|新能源|储能|电池|新材|材料|装备|机电|计算|云|AI|光学|传感器|通信|软件|医药|生物|医疗|健康|基因|制药|微创/.test(n)) a = 8;
  else if (/消费|食品|饮料|零售|品牌|传媒|文娱|旅游|户外|梅|糖|蜜|宠物|生活/.test(n)) a = 5;
  else if (/金|矿|资源|铜|锂|钢铁|化工|传统|能源|电力|环保/.test(n)) a = -5;
  else if (/证券|保险|银行|金融/.test(n)) a = -2;
  if (/18C/.test(ch)) a += 4;
  if (/B$/.test(n) || /-B/.test(n)) a += 2;
  return a;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function predictDarkPct(s) {
  const over = parseFloat(s.public_offer_subscription_multiple);
  const b = overBucket(over);
  let base = b.base + sectorAdj(s);
  const cap = (parseFloat(s.shares_offered) || 0) * parseFloat(s.ipo_price) / 1e8;
  if (cap) { if (cap < 30) base += 3; else if (cap > 300) base -= 3; }
  base = clamp(base, -40, 400);
  return { lo: base - b.spread, hi: base + b.spread, base };
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

(async () => {
  const stocks = await apiGet("/ipo-stocks");
  const rows = stocks.filter(
    (x) => x.public_offer_subscription_multiple != null && x.dark_pool_change_pct != null
  );
  console.log("样本（超购 + 暗盘齐全）：", rows.length, "\n");

  let inRange = 0, dirOk = 0, n = rows.length;
  const byBucket = {};
  rows.forEach((s) => {
    const over = parseFloat(s.public_offer_subscription_multiple);
    const actual = parseFloat(s.dark_pool_change_pct);
    const p = predictDarkPct(s);
    const b = bucketOf(over);
    (byBucket[b] = byBucket[b] || { n: 0, hits: 0, dir: 0, meds: [] }).n++;
    if (actual >= p.lo && actual <= p.hi) { inRange++; byBucket[b].hits++; }
    if (Math.sign(actual) === Math.sign(p.base) || (actual === 0 && p.base === 0)) { dirOk++; byBucket[b].dir++; }
    byBucket[b].meds.push(actual);
  });

  console.log("【整体】");
  console.log("  区间命中率（实际落入预测区间）：", (inRange / n * 100).toFixed(1) + "%");
  console.log("  方向准确率（正负号一致）：    ", (dirOk / n * 100).toFixed(1) + "%\n");

  console.log("【分超购档位】");
  console.log("  档位      n   命中率  方向率  实际中位暗盘%");
  Object.keys(byBucket).forEach((b) => {
    const d = byBucket[b];
    d.meds.sort((a, c) => a - c);
    const med = d.meds[Math.floor(d.meds.length / 2)];
    console.log(
      "  " + b.padEnd(7),
      String(d.n).padEnd(4),
      (d.hits / d.n * 100).toFixed(0).padStart(4) + "%",
      (d.dir / d.n * 100).toFixed(0).padStart(6) + "%",
      (med >= 0 ? "+" : "") + med.toFixed(1).padStart(7)
    );
  });
  console.log("\n（注：区间偏宽以容纳 A+H / 国配 / 大环境等实时修正项，实盘命中率会更高）");
})();
