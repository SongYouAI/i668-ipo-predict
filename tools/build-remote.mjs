#!/usr/bin/env node
/* 生成远程参数库 dist/latest.json（v0.6.0）
 *
 * 为什么要有这个脚本：插件的「数据」与「参数」需要能在不发新版本的前提下更新
 * （Chrome 商店外扩展不会自动更新，10 个用户里没人愿意反复解压覆盖）。
 * 本脚本从**单一数据源**抽取：data/extras.js + data/ahclose.js + core.js 里的参数，
 * 合成一份 JSON 推到 GitHub，运行时由 content/core.js 拉取覆盖。
 *
 * 用法：
 *   node tools/build-remote.mjs            # 生成 dist/latest.json
 *   node tools/build-remote.mjs --print    # 只打印摘要，不写文件
 *
 * ⚠️ Infinity 陷阱：JSON.stringify(Infinity) === "null"。
 *    OVER_BUCKETS / DARK_TO_OPEN 最后一档的 max 就是 Infinity，写进 JSON 自动变 null，
 *    运行时 applyRemote 会把它转回 Infinity —— 这里不做特殊处理，但生成后会断言检查。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function loadCore() {
  const sandbox = {
    console,
    TextEncoder,
    crypto: crypto.webcrypto,
    setTimeout,
    URL,
    window: {},
    document: { createElement: () => ({ style: {}, appendChild() {} }) },
    location: { href: "https://www.i668.vip/stocks", origin: "https://www.i668.vip" },
    fetch: () => Promise.reject(new Error("build 阶段不应发起网络请求")),
    chrome: undefined,
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("data/extras.js"), sandbox);
  vm.runInContext(read("data/ahclose.js"), sandbox);
  vm.runInContext(read("content/core.js"), sandbox);
  const P = sandbox.window.I668P;
  if (!P) throw new Error("core.js 加载后未导出 I668P");
  return P;
}

function main() {
  const printOnly = process.argv.includes("--print");
  const P = loadCore();
  const manifest = JSON.parse(read("manifest.json"));

  const stocks = P.EX && P.EX.stocks ? Object.keys(P.EX.stocks) : [];
  const ah = P.AH_CLOSE && P.AH_CLOSE.close ? Object.keys(P.AH_CLOSE.close) : [];
  if (!stocks.length) throw new Error("extras 为空，拒绝生成");
  if (!P.OVER_BUCKETS.length) throw new Error("OVER_BUCKETS 为空，拒绝生成");
  if (!P.DARK_TO_OPEN.length) throw new Error("DARK_TO_OPEN 为空，拒绝生成");

  // 版本号：manifest 版本 + 数据指纹前 8 位。数据一变，版本号就变，客户端据此判断是否刷新
  const raw = JSON.stringify({ e: P.EX, a: P.AH_CLOSE, o: P.OVER_BUCKETS, d: P.DARK_TO_OPEN, l: P.AH_LIN, f: P.FLAT, c: P.CS });
  const fp = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);

  const payload = {
    v: manifest.version + "+" + fp,
    appVersion: manifest.version,
    builtAt: new Date().toISOString(),
    note: "由 tools/build-remote.mjs 从 data/*.js 与 content/core.js 参数生成，请勿手改",
    params: {
      overBuckets: P.OVER_BUCKETS.map((b) => ({
        max: b.max === Infinity ? null : b.max,
        med: b.med, dLo: b.dLo, dHi: b.dHi, conf: b.conf, pb: b.pb,
        nh: b.nh, nr: b.nr,
      })),
      darkToOpen: P.DARK_TO_OPEN.map((b) => ({
        max: b.max === Infinity ? null : b.max,
        med: b.med, dLo: b.dLo, dHi: b.dHi, n: b.n,
      })),
      ahLin: { a: P.AH_LIN.a, b: P.AH_LIN.b, dLo: P.AH_LIN.dLo, dHi: P.AH_LIN.dHi, conf: P.AH_LIN.conf },
      flat: { med: P.FLAT.med, dLo: P.FLAT.dLo, dHi: P.FLAT.dHi, conf: P.FLAT.conf, pb: P.FLAT.pb },
      cs: { base: P.CS.base, k: P.CS.k, cap: P.CS.cap },
      fx: P.CFG.fxCNY2HKD,
    },
    data: { extras: P.EX, ahclose: P.AH_CLOSE },
  };

  // ---- 生成后自检：任何一项不达标就别写文件 ----
  const errs = [];
  const ob = payload.params.overBuckets;
  const dk = payload.params.darkToOpen;
  if (ob[ob.length - 1].max !== null) errs.push("overBuckets 末档 max 应为 null(Infinity)");
  if (dk[dk.length - 1].max !== null) errs.push("darkToOpen 末档 max 应为 null(Infinity)");
  for (let i = 1; i < ob.length - 1; i++) if (!(ob[i].max > ob[i - 1].max)) errs.push("overBuckets 未严格升序 @" + i);
  for (let i = 1; i < dk.length - 1; i++) if (!(dk[i].max > dk[i - 1].max)) errs.push("darkToOpen 未严格升序 @" + i);
  if (stocks.length < 20) errs.push("extras 股票数异常：" + stocks.length);

  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, "utf8");

  console.log("版本      :", payload.v);
  console.log("生成时间  :", payload.builtAt);
  console.log("extras    :", stocks.length, "只");
  console.log("ahclose   :", ah.length, "只");
  console.log("超购档    :", ob.length, "档（末档 max =", ob[ob.length - 1].max + "）");
  console.log("S3 偏移档 :", dk.length, "档（末档 max =", dk[dk.length - 1].max + "）");
  console.log("JSON 体积 :", (bytes / 1024).toFixed(1), "KB");
  if (errs.length) {
    console.error("\n✗ 自检未通过，未写文件：");
    errs.forEach((e) => console.error("  -", e));
    process.exit(1);
  }
  console.log("自检      : ✓ 通过");

  if (printOnly) return;
  const outDir = path.join(ROOT, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "latest.json");
  fs.writeFileSync(out, json, "utf8");
  console.log("已写出    :", path.relative(ROOT, out));

  // ---- 回读验证：确认能被 validRemote 接受（用真实校验函数，不靠猜） ----
  const back = JSON.parse(fs.readFileSync(out, "utf8"));
  if (!P.validRemote(back)) {
    console.error("✗ 回读校验失败：validRemote 不接受生成的文件");
    process.exit(1);
  }
  console.log("回读校验  : ✓ validRemote 接受");
}

main();
