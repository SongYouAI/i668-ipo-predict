/* i668 插件 · 静态契约审计
   专治本项目反复踩的坑：① 定义了没导出 ② 调用了未导出 ③ 命名空间裸调用。
   用法：node /tmp/i668-audit.mjs <插件根目录> */
import fs from "fs";
import path from "path";

const ROOT = process.argv[2] || ".";
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/* ---------- 1. 提取 core.js 的对外导出 ---------- */
const core = read("content/core.js");
const retIdx = core.lastIndexOf("\n  return {");
const exported = new Set();
if (retIdx < 0) console.log("⚠️ 没找到 core.js 的 return 块");
else {
  const block = core.slice(retIdx, core.indexOf("})();", retIdx));
  // 匹配  key: value  /  key,  / get key() / set key(
  for (const m of block.matchAll(/(?:^|[,{\s])(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?::|[(,}]|\s*$)/gm)) {
    const k = m[1];
    if (!["return", "get", "set", "function", "true", "false", "null"].includes(k)) exported.add(k);
  }
}
console.log(`core.js 导出 ${exported.size} 个符号`);

/* ---------- 2. 扫描各文件对本命名空间的调用 ---------- */
// P.xxx 来自 core；LIST/DETAIL 等挂在 window.I668P 上
const FILES = ["content/list.js", "content/detail.js", "content/boot.js"];
const errors = [];
const warnings = [];

// 子模块是**运行时挂载**到 P 上的（P.list = {...} / P.detail = {...}），
// 它们不是 core 的导出，读取前都有守卫 `if (P.list)`。统计出来，避免误报。
const mountedReadonly = new Set();
for (const f of FILES) {
  for (const m of read(f).matchAll(/(?<![A-Za-z0-9_$])P\.([A-Za-z_$][\w$]*)\s*=/g)) mountedReadonly.add(m[1]);
}

for (const f of FILES) {
  const src = read(f);
// ⚠️ 必须加负向后视：I668P.list / MAP.id / WRAP.style 这类「变量末尾恰好是 P」
//    会被天真正则误判成 P.xxx 调用（上一版就误报了 8 条）
const ns = [...src.matchAll(/(?<![A-Za-z0-9_$])P\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
const used = new Set(ns);
  for (const name of used) {
    if (!exported.has(name) && !mountedReadonly.has(name)) {
      errors.push(`[致命] ${f}: 调用了 P.${name} —— core.js **没有导出**`);
    }
  }
}
if (mountedReadonly.size) console.log(`运行时挂载到 P 上的子模块（非 core 导出，属正常架构）：${[...mountedReadonly].join(", ")}`);

/* ---------- 3. 检查裸调用：应该是 P.xxx 却写成 xxx( ---------- */
// 取 core 导出的“函数型”符号，检查其它文件里是否出现未加命名空间的直接调用
const bareScanTargets = new Set([...exported]);
for (const f of FILES) {
  const src = read(f);
  for (const name of bareScanTargets) {
    // 排除 P.name / .name / 'name' / 注释里的 name / 对象键 name:
    const re = new RegExp(`(?<![.\\w$'"])${name}\\s*\\(`, "g");
    const hits = [...src.matchAll(re)];
    if (hits.length) {
      for (const h of hits) {
        const line = src.slice(0, h.index).split("\n").length;
        const lineTxt = src.split("\n")[line - 1] || "";
        // 跳过注释行与本文件的本地定义
        if (lineTxt.trim().startsWith("//") || lineTxt.trim().startsWith("*")) continue;
        if (lineTxt.includes(`function ${name}`)) continue;
        warnings.push(`[警告] ${f}:${line} 疑似裸调用 ${name}()  —— 应为 P.${name}()\n        ${lineTxt.trim().slice(0, 110)}`);
      }
    }
  }
}

/* ---------- 4. core.js 自身：return 里的 value 是否真的在同文件定义 ---------- */
const coreNames = new Set();
for (const m of core.matchAll(/(?:^|[^\w$.])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) coreNames.add(m[1]);
for (const m of core.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) coreNames.add(m[1]);
// 对象字面量里的 `key: function(){...}` 写法（如 isStoreReady）
for (const m of core.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function/gm)) coreNames.add(m[1]);
for (const m of core.matchAll(/^\s*(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/gm)) coreNames.add(m[1]);
const undefinedExport = [...exported].filter((k) => !coreNames.has(k));
if (undefinedExport.length) {
  errors.push(`[致命] core.js return 里引用了**未定义**的符号：${undefinedExport.join(", ")}`);
}

/* ---------- 5. 重复导出键 ---------- */
const retBlock = core.slice(retIdx, core.indexOf("})();", retIdx));
const keysArr = Array.from(retBlock.matchAll(/([A-Za-z_$][\w$]*)\s*:/g), (m) => m[1]);
const dup = keysArr.filter((k, i) => keysArr.indexOf(k) !== i);
if (dup.length) warnings.push(`[警告] core.js return 里**重复导出键**：${[...new Set(dup)].join(", ")}`);

/* ---------- 6. 输出 ---------- */
console.log("\n" + "=".repeat(60));
if (errors.length) {
  console.log(`❌ 发现 ${errors.length} 个致命问题：\n`);
  errors.forEach((e) => console.log("  " + e));
} else {
  console.log("✅ 无致命契约问题（所有 P.xxx 调用都能在 core.js 找到导出）");
}
if (warnings.length) {
  console.log(`\n⚠️  ${warnings.length} 条可疑：\n`);
  warnings.slice(0, 25).forEach((w) => console.log("  " + w));
} else {
  console.log("✅ 无裸调用 / 重复导出");
}
