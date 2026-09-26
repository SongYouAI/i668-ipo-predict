/* =========================================================================
 * 港股打新预测 · i668 增强  —  引擎层（core.js）
 *
 * 最先加载，向 window.I668P 暴露：常量 / 存储 / 站点 API / 腾讯行情 /
 * 阶段引擎 / **可解释预测模型** / 因子目录 / 通用小工具。
 * list.js（列表页三列）与 detail.js（详情页「预测工坊」）共用本层，
 * 避免模型出现两份实现而悄悄漂移。
 *
 * v0.4.0 架构（2026-09-25）：
 *  ① 单文件 predict.js 拆为 core / list / detail / boot 四层，职责分离。
 *  ② 预测模型改造为**可解释**：每个阶段返回 steps[]（逐项说明 + 增量 + 理由），
 *     供列表页悬浮摘要与详情页「计算过程」表展示。数值结果与 v0.3.0 完全一致
 *     （本次只加"说明"，不改口径）。
 *  ③ 新增存储层：个股覆盖（ov，手动改价）+ 全局因子（factors，二期启用）。
 *     有 chrome.storage 用 chrome.storage，无则降级 localStorage
 *     （便于不加载扩展时做真页注入自测）。
 *  ④ 修正 v0.3.0 遗留笔误：S1 的 A+H 锚下沿保护 `-0.05` 应为 `-5`（百分点）。
 * ========================================================================= */
window.I668P = (function () {
  "use strict";

  /* ===================== 常量 ===================== */
  // 站点 API 签名密钥（站点前端硬编码常量，公开可查）
  const SECRET = "6680fc61c8585cfca143366eea267b67617b7c2830c1c896cd952b276db117c9";

  const MIN_COL_W = 130;      // 预测列宽下限：实测内容最宽 126px（如「1009.495–1030.503」）
  const MAX_COL_W = 200;      // 预测列宽上限：超宽屏时不把列拉得离谱
  const DARK_END = 18.5;      // 暗盘约 16:15–18:30，18:30 后视为「已结束」（HKT）
  const WIDE_CLASS = "i668p-wide";   // 放开站点 .app 960px 宽度锁的触发类（由 JS 添加）

  const COLS = [
    { key: "s1", title: "招股期预测", sub: "S1" },
    { key: "s2", title: "中签后预测", sub: "S2" },
    { key: "s3", title: "暗盘后预测", sub: "S3" },
  ];
  const STAGE_ORDER = { S1: 1, S2: 2, S3: 3, LISTED: 4 };
  const KEY_ORDER = { s1: 1, s2: 2, s3: 3 };
  const STAGE_NAME = { S1: "招股期 S1", S2: "中签后 S2", S3: "暗盘后 S3", LISTED: "已上市", UNKNOWN: "日期缺失" };
  const KEY_LABEL = { s1: "招股期预测", s2: "中签后预测", s3: "暗盘后预测" };
  const KEY_BASIS = {
    s1: "方向性区间（相对发行价）",
    s2: "目标：暗盘收盘价（相对发行价）",
    s3: "目标：上市首日开盘价（相对发行价）",
  };

  const CFG = { fxCNY2HKD: 1.09, liveMarket: true, simulateDate: "" };

  let CACHE = { map: {}, ctx: { hsi: null, ah: {} } };
  let LAST = { t: 0, data: null };
  const ERRS = [];
  const LISTENERS = [];

  /* ===================== 小工具 ===================== */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
  function fmt(v, d) { return (+v).toFixed(d == null ? 3 : d); }
  function pctTxt(p, d) { return (p >= 0 ? "+" : "") + (+p).toFixed(d == null ? 2 : d) + "%"; }
  function stars(c) { let s = ""; for (let i = 0; i < 3; i++) s += i < c ? "\u2605" : "\u2606"; return s; }
  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // 异常收集（同类只报一次，防刷屏）——否则一处出错会被上层 catch 静默吞掉，
  // 界面表现为"整表空白但状态条说成功"，即最忌讳的"插件在撒谎"。
  function warnOnce(tag, e) {
    const msg = tag + " \u2192 " + ((e && e.message) || e);
    if (ERRS.indexOf(msg) >= 0) return;
    ERRS.push(msg);
    console.warn("[i668p]", msg);
    try { window.__i668pErrs = ERRS.slice(); } catch (_) {}
  }
  function on(fn) { LISTENERS.push(fn); }
  function emit(ev) {
    LISTENERS.forEach((f) => { try { f(ev); } catch (e) { warnOnce("emit", e); } });
  }

  /* ===================== 存储层 ===================== */
  // chrome.storage 优先（扩展环境）；缺失时降级 localStorage（真页注入自测）
  const OV_KEY = "i668p.ov";        // 个股覆盖：{ code: { s1:{...}, s2:{...} } }
  const FT_KEY = "i668p.factors";   // 全局因子（二期启用）
  const OV = {};                    // 内存镜像（列表页与详情页共用同一份）
  const FACTORS = {};
  let STORE_READY = false;

  function hasChrome() {
    try { return typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.local; }
    catch (e) { return false; }
  }
  function storeGet(keys, cb) {
    const ks = Array.isArray(keys) ? keys : [keys];
    if (hasChrome()) {
      try { chrome.storage.local.get(ks, (r) => cb(r || {})); return; } catch (e) { /* fallthrough */ }
    }
    const out = {};
    ks.forEach((k) => {
      try { const v = localStorage.getItem(k); if (v != null) out[k] = JSON.parse(v); } catch (e) {}
    });
    cb(out);
  }
  function storeSet(obj, cb) {
    if (hasChrome()) {
      try { chrome.storage.local.set(obj, () => cb && cb()); return; } catch (e) { /* fallthrough */ }
    }
    try { Object.keys(obj).forEach((k) => localStorage.setItem(k, JSON.stringify(obj[k]))); } catch (e) {}
    cb && cb();
  }
  function copyInto(dst, src) {
    Object.keys(dst).forEach((k) => delete dst[k]);
    if (src && typeof src === "object") Object.keys(src).forEach((k) => { dst[k] = src[k]; });
  }
  function loadStore(cb) {
    storeGet([OV_KEY, FT_KEY], (r) => {
      copyInto(OV, r[OV_KEY]);
      copyInto(FACTORS, r[FT_KEY]);
      STORE_READY = true;
      cb && cb();
    });
  }

  // 跨标签页同步：在另一个标签页改了人工设定，本页的内存镜像必须跟着刷新，
  // 否则会出现"A 标签页改了、B 标签页列表还显示模型值"的不一致。
  function bindStoreSync() {
    try {
      if (!hasChrome() || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (!changes[OV_KEY] && !changes[FT_KEY]) return;
        if (changes[OV_KEY]) copyInto(OV, changes[OV_KEY].newValue);
        if (changes[FT_KEY]) copyInto(FACTORS, changes[FT_KEY].newValue);
        emit("store");
      });
    } catch (e) { /* 无权限时静默降级 */ }
  }
  function saveStore(cb) {
    const p = {};
    p[OV_KEY] = OV;
    p[FT_KEY] = FACTORS;
    storeSet(p, cb);
  }
  // —— 个股覆盖读写（唯一入口，列表页与详情页都只准调这些）——
  function ovGet(code, key) { const o = code && OV[code]; return (o && o[key]) || null; }
  function ovAll(code) { return (code && OV[code]) || null; }
  function ovCount() { let n = 0; Object.keys(OV).forEach((c) => { n += Object.keys(OV[c] || {}).length; }); return n; }
  function ovSet(code, key, val) {
    if (!code || !key) return;
    if (!OV[code]) OV[code] = {};
    OV[code][key] = val;
    saveStore(() => emit("store"));
  }
  function ovDel(code, key) {
    if (!OV[code]) return;
    delete OV[code][key];
    if (!Object.keys(OV[code]).length) delete OV[code];
    saveStore(() => emit("store"));
  }

  /* ===================== 设置 ===================== */
  function loadCfg(cb) {
    storeGet(["fxCNY2HKD", "liveMarket", "simulateDate"], (r) => {
      if (r.fxCNY2HKD != null) CFG.fxCNY2HKD = r.fxCNY2HKD;
      if (r.liveMarket != null) CFG.liveMarket = r.liveMarket;
      if (r.simulateDate != null) CFG.simulateDate = r.simulateDate;
      loadStore(() => { bindStoreSync(); cb && cb(); });
    });
  }

  /* ===================== 站点 API（HMAC-SHA256 签名） ===================== */
  async function hmac(t, i, a, o) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(t + i + a + o + SECRET));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function apiGet(path, params) {
    const base = "/api";
    const url = new URL(base + path, location.origin);
    let a = "";
    if (params) {
      for (const k in params) if (params[k] != null) url.searchParams.set(k, params[k]);
      a = url.search;
    }
    const i = base + path;
    const t = Math.floor(Date.now() / 1e3).toString();
    const s = await hmac(t, i, a, "");
    const res = await fetch(url, {
      headers: { "X-Timestamp": t, "X-Sign": s, "Referer": location.href, "Origin": location.origin },
    });
    if (!res.ok) throw new Error("API " + res.status);
    return res.json();
  }

  /* ===================== 腾讯 gtimg 行情（恒指 + A 股比价） ===================== */
  function toGtimgCode(code) {
    code = String(code);
    if (code[0] === "6" || code[0] === "5") return "sh" + code;
    if (code[0] === "8" || code[0] === "4") return "bj" + code;
    return "sz" + code;
  }
  async function gtimg(codes, signal) {
    const res = await fetch("https://qt.gtimg.cn/q=" + codes.join(","), { signal: signal });
    const txt = await res.text();
    const out = {};
    txt.split(";").forEach((line) => {
      const m = line.match(/v_(\w+)="([^"]*)"/);
      if (m) out[m[1]] = m[2].split("~");
    });
    return out;
  }
  function gtimgPct(arr) {
    if (!arr) return null;
    const ti = arr.findIndex((x) => /\d{4}\/\d{2}\/\d{2}/.test(x) || /^\d{12,14}$/.test(x));
    if (ti < 0) return null;
    const p = parseFloat(arr[ti + 2]);
    return isNaN(p) ? null : p;
  }
  function gtimgPrice(arr) {
    if (!arr) return null;
    const p = parseFloat(arr[3]);
    return isNaN(p) ? null : p;
  }

  /* ===================== 阶段引擎 ===================== */
  function pdate(s) {
    if (!s) return null;
    const d = new Date(s + "T00:00:00");
    return isNaN(d) ? null : d;
  }
  function todayDate() {
    if (CFG.simulateDate) {
      const d = new Date(CFG.simulateDate + "T00:00:00");
      if (!isNaN(d)) return d;
    }
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  function nowHour() { const n = new Date(); return n.getHours() + n.getMinutes() / 60; }

  /* ----- 「配售结果是否已公布」= 阶段判定的唯一入口 -----
     ⚠️ 血的教训（v0.4.3，老板实测 06731 本末科技）：
        原实现只看 `public_offer_subscription_multiple == null` 一个字段就断言
        「配售结果未出」。但该字段在站点是**懒填**的 —— 06731 招股截止 9/24、
        配售结果公布日 9/25，公布后该字段仍是 null，于是插件一直把它判成「招股期 S1」，
        「中签后预测」整列永远空白，而用户恰恰已经中签、最需要这个数。
        站点其实提供了 **7 组等价证据**，任一命中即视为已公布。判据要取全集，不能取单点。 */
  function allotmentPublished(s) {
    if (!s) return false;
    if (s.has_allotment) return true;                 // 站点自己的「已录入配发结果」标记
    if (s.allotment_pdf_url) return true;             // 配发结果 PDF 链接
    if (s.public_offer_subscription_multiple != null) return true;   // 公开超购倍数
    if (s.international_subscription_multiple != null) return true;  // 国际配售超购倍数
    if (s.public_offer_applicants != null || s.public_offer_allottees != null) return true;
    if (s.group_a_applicants != null || s.group_a_allottees != null) return true;
    if (s.group_b_applicants != null || s.group_b_allottees != null) return true;
    return false;
  }

  // 时间线相位（与「展示阶段」解耦）：视图靠它判断「S2 该不该给预估值」。
  //   PRE   招股期内 —— S2 尚不成立（连认购都没结束）
  //   AWAIT 空窗期：已过招股截止、配售结果未公布 —— S2 只能给「预估」（provisional）
  //   DK    配售结果已公布、未到暗盘日 —— S2 是正式预测
  //   POST  暗盘日之后
  const PHASE = { PRE: "PRE", AWAIT: "AWAIT", DK: "DK", POST: "POST" };
  function phaseOf(s, td) {
    if (!s) return null;
    const se = pdate(s.subscription_end_date);
    const dk = pdate(s.dark_pool_date);
    if (!se || !dk) return null;
    const t = +td;
    if (t <= +se) return PHASE.PRE;
    if (t > +dk) return PHASE.POST;
    return allotmentPublished(s) ? PHASE.DK : PHASE.AWAIT;
  }

  // S1 招股期 / S2 中签后(配售已公布) / S3 暗盘后 / LISTED 已上市 / UNKNOWN 缺日期
  // 注意：招股截止→配售结果公布前的「空窗期」仍归 S1（配售未出，可用信息仍是招股书级别），
  //      但视图会据 phaseOf()===AWAIT 把 S2 以「预估」形式显示出来，不再交白卷。
  function getStage(s, td) {
    const se = pdate(s.subscription_end_date);
    const dk = pdate(s.dark_pool_date);
    const ls = pdate(s.listing_date);
    if (!se || !dk || !ls) return "UNKNOWN";
    const t = +td;
    if (t <= +se) return "S1";                              // 认购期内（含截止当天）
    if (t > +dk) return t < +ls ? "S3" : "LISTED";          // 暗盘日之后
    if (!allotmentPublished(s)) return "S1";                // 配售结果未出 → 空窗期
    if (t === +dk && !CFG.simulateDate && nowHour() < DARK_END) return "S2"; // 暗盘日 18:30 前
    if (t === +dk) return "S3";                             // 暗盘日 18:30 后（或模拟预览）
    return "S2";                                            // 配售已公布 → 暗盘日之前
  }
  function stageNote(s, td) {
    const se = pdate(s.subscription_end_date);
    const dk = pdate(s.dark_pool_date);
    const ls = pdate(s.listing_date);
    const t = +td;
    if (t <= +se) return "认购中（截止 " + s.subscription_end_date + "）";
    if (t <= +dk && !allotmentPublished(s)) return "空窗期（配售结果未公布，仍按招股书口径估算）";
    if (t <= +dk) return "配售已公布，等待暗盘（" + s.dark_pool_date + "）";
    if (t < +ls) return "暗盘已结束，等待上市（" + s.listing_date + "）";
    return "已上市（" + s.listing_date + "）";
  }

  /* ----- 「当前阶段」应当落在哪张卡 = 唯一判定源 -----
     ⚠️ v0.4.8（老板截图指出 03757 罗博特科的「当前阶段」不对）：
        旧实现只按**数据阶段** ST.stage 判定「当前」—— 而空窗期（招股已截止、配售结果
        未公布）getStage() 仍返回 S1，于是 9/26 打开时「招股期 S1」卡还标着「当前阶段」，
        可招股 9/24 就已经截止了。老板原话：「这个应该是可以更新的，根据打开的时间能
        及时更新的呀。」
        改为按**时间相位 phaseOf** 判定「当前焦点」：
          PRE   招股期内       → s1（招股期方向就是当下要看的）
          AWAIT 空窗期         → s2（招股已截止；此刻在等「配售结果」，它决定暗盘＝s2 的
                                   标的。只是数据未出 → provisional，UI 标「预估值」）
          DK    配售后·暗盘前  → s2（正式预测）
          POST  暗盘后         → s3
          LISTED 已上市        → s3（UI 改显实测）
        注意：从「招股截止」到「暗盘结束」这整段，焦点**一直是 s2** —— 中签结果公布只是
        换了数据质量（预估值→正式值），不是换阶段。这与 list.js/renderCell、detail.js/
        stageStateOf 的既有语义一致。
        详情卡 badge 与列表列高亮**都必须调本函数**，不得各自硬编码 ko/st 比较。 */
  function stageFocus(s, td) {
    if (!s) return { key: null, phase: null, stage: "UNKNOWN", provisional: false };
    const stage = getStage(s, td);
    const phase = phaseOf(s, td);
    if (stage === "UNKNOWN") return { key: null, phase: phase, stage: stage, provisional: false };
    let key;
    if (stage === "S1") key = (phase === PHASE.AWAIT) ? "s2" : "s1";
    else if (stage === "S2") key = "s2";
    else key = "s3";
    return { key: key, phase: phase, stage: stage, provisional: phase === PHASE.AWAIT };
  }

  /* ===================== 预测模型（可解释 · 106 只样本校准） =====================

     ⚠️ v0.4.6 换口径 —— 老板的批评：「区间那么大，其实等于没有预测」。

     旧口径：`base = 该档均值`，`区间 = 均值 ± 该档标准差`。
     三个毛病（都已用 106~110 只带暗盘实测的样本量化，见 REGRESSION 注释）：
       ① **区间是「覆盖包络」不是「预测区间」**：平均宽 48pt（最宽 70pt），
          等于把"最好/最坏可能"都包进来 —— 对决策毫无用处；
       ② **但命中率只有 43.6%** —— 又宽又不准，两头都不讨好；
       ③ **中枢用均值，被妖股右尾拉高**：100–500 倍档 均值 +22.9 vs 中位 +2.4，
          于是典型样本被系统性高估（残差 P50 = −8.0，即一半的股比预测低 8pt 以上）。

     新口径（直接按样本分位数量出来，不再假设正态分布）：
       · **中枢 = 该条件集的中位数**（右偏分布下，中位数比均值更贴近"最可能落点"）；
       · **区间 = 该条件集的 [P25, P75]**（**不对称** —— 下侧 dLo、上侧 dHi 分开给，
         直接吃掉右偏），这是一个**真实的 50% 中央区间**：命中率实测 49.1%（名义 50%）；
       · 置信星级改由**区间宽度**决定（越窄越可决策），不再由涨幅大小决定。
     效果：点估计中位误差 27.3 → **23.6 pt**；低超购档区间从 28pt 收窄到 **5.6~8.1pt**；
     高超购档反而变宽（91~105pt）—— 那是因为妖股**本来就无法预测**，如实告知。 */
  const OVER_BUCKETS = [
    //        中位数   下侧   上侧   置信  n
    { max: 15,       med: -2.9, dLo: 2.0,  dHi: 6.1,  conf: 3 },   //  5
    { max: 100,      med: 0.1,  dLo: 2.0,  dHi: 3.6,  conf: 3 },   // 12
    { max: 500,      med: 2.4,  dLo: 6.6,  dHi: 27.0, conf: 2 },   // 24
    { max: 1000,     med: 21.0, dLo: 19.0, dHi: 19.9, conf: 2 },   //  7
    { max: 3000,     med: 66.0, dLo: 30.6, dHi: 24.9, conf: 1 },   // 30
    { max: 6000,     med: 55.5, dLo: 48.9, dHi: 42.2, conf: 1 },   // 19
    { max: Infinity, med: 129.5, dLo: 40.5, dHi: 65.0, conf: 1 },  //  9
  ];
  function overBucket(o) {
    for (const b of OVER_BUCKETS) if (o < b.max) return b;
    return OVER_BUCKETS[OVER_BUCKETS.length - 1];
  }
  // 无超购时的**备选条件集**：按 A+H 折价深度分档（数值同样是样本中位数 + [P25,P75]）
  const AH_BUCKETS = [
    { min: 40, name: "折价 \u226540%",  med: 14.8, dLo: 15.0, dHi: 22.7, conf: 2 },   // n=15
    { min: 20, name: "折价 20~40%",     med: 6.5,  dLo: 10.7, dHi: 13.5, conf: 2 },   // n=6
    { min: -Infinity, name: "折价 <20%", med: 2.9,  dLo: 4.0,  dHi: 2.2,  conf: 3 },  // n=13
  ];
  function ahBucket(prem) { for (const b of AH_BUCKETS) if (prem >= b.min) return b; return AH_BUCKETS[AH_BUCKETS.length - 1]; }
  // 兜底（既无超购也无 A+H）：全样本中位数 + [P25,P75]（n=110）
  const FLAT = { med: 29.7, dLo: 28.8, dHi: 48.0, conf: 1 };
  function overBucketTxt(o) {
    const i = OVER_BUCKETS.indexOf(overBucket(o));
    const lo = i === 0 ? 0 : OVER_BUCKETS[i - 1].max;
    const hi = OVER_BUCKETS[i].max === Infinity ? "\u221e" : OVER_BUCKETS[i].max;
    return lo + "\u2013" + hi + " 倍档";
  }
  // 赛道修正：站点接口无行业字段，按股票名关键词推断（诚实标注为「名称推断」）
  function sectorAdj(s) {
    const n = s.stock_name || "";
    const ch = s.listing_chapter || "";
    let a = 0, why = "名称未命中任何赛道关键词";
    if (/科技|电子|半导体|芯片|智能|机器人|自动化|数控|精密|光电|芯|光伏|新能源|储能|电池|新材|材料|装备|机电|计算|云|AI|光学|传感器|通信|软件|医药|生物|医疗|健康|基因|制药|微创/.test(n)) {
      a = 8; why = "名称含科技/半导体/机器人等关键词";
    } else if (/消费|食品|饮料|零售|品牌|传媒|文娱|旅游|户外|梅|糖|蜜|宠物|生活/.test(n)) {
      a = 5; why = "名称含消费/品牌等关键词";
    } else if (/金|矿|资源|铜|锂|钢铁|化工|传统|能源|电力|环保/.test(n)) {
      a = -5; why = "名称含资源/化工等关键词";
    } else if (/证券|保险|银行|金融/.test(n)) {
      a = -2; why = "名称含金融类关键词";
    }
    let extra = 0;
    if (/18C/.test(ch)) { extra = 4; why += "；且为 18C 特专科技章节"; }
    return { v: a + extra, base: a, extra: extra, why: why, inferred: true };
  }
  // A+H 锚：A 股现价相对发行价的溢价率含结构性溢价，必须截断 + 降权（S1 用「水平」，见 ahAnchor）
  function ahAnchor(s, ctx) {
    if (!s.is_ah_share || !s.a_share_code) return null;
    const prem = ctx.ah[s.a_share_code];
    if (prem == null) return null;
    return clamp(prem, -15, 15);
  }

  /* A+H 折价锚（v0.4.5 重标定）—— S2 专用，**按样本回归取值**，不再手工拍权重。
     ⚠️ 为什么改：旧实现是「clamp(溢价, ±15) 再按 25% 权重混合」→ 最大只贡献 ±3.75pt，
        等于把 A+H 折价这个最硬的信息削平了 —— 老板实测 03757 罗博特科（A 股较发行价
        溢价 41.5%）却给出 −31.9% ~ +28.1% 的 S2 区间，明显对不上。
     标定样本：**38 只 A+H 标的**，一律取「招股截止日前最后一个交易日的 A 股收盘价」
        （消除用现价做历史回测的前视偏差）：
            暗盘% = −0.82 + 0.238 × 折价%      pearson r = 0.396，R² = 0.157，n = 34
        即折价每高 10pt，暗盘均值高 2.38pt。取回归斜率 0.238 作系数、截断 ±12pt 防极端外推。
     ⚠️ 这是**方向上移**，不是「不会破发」的保证 —— 样本里暗盘 < −5% 的 4 只中，
        3 只折价落在 38~44%（与 03757 的 41.5% 同一区间），折价最深（79.7%）的滨化股份
        暗盘 −21.26%。所以只抬中枢、不设地板。 */
  const AH_K = 0.238;      // 折价% → 暗盘% 的回归斜率
  const AH_CAP = 12;       // 单次修正量截断（pt）
  function ahAdj(s, ctx) {
    if (!s.is_ah_share || !s.a_share_code) return null;
    const prem = ctx.ah[s.a_share_code];
    if (prem == null) return null;
    return { prem: prem, v: clamp(AH_K * prem, -AH_CAP, AH_CAP) };
  }
  // 暗盘实际价（站点口径：dark_pool_change_pct = 暗盘**收盘**价相对发行价的涨幅）。
  // ⚠️ 站点不提供「暗盘开盘价」：其「暗盘VS首日」页明确「暗盘涨幅取当日暗盘收盘价」，
  //    且前端全部 chunk 中不存在任何 open 类字段。故只能给收盘口径，标注「实测暗盘」。
  function darkActual(s) {
    const ipo = num(s.ipo_price);
    const dp = num(s.dark_pool_change_pct);
    if (ipo == null || dp == null || ipo <= 0) return null;
    return { price: ipo * (1 + dp / 100), pct: dp };
  }
  function firstDayActual(s) {
    const ipo = num(s.ipo_price);
    const v = num(s.first_day_close_price);
    if (ipo == null || v == null || ipo <= 0 || v <= 0) return null;
    return { price: v, pct: (v / ipo - 1) * 100 };
  }

  // ⚠️ 诚实性硬约束（v0.4.1）：界面上「涨跌幅」与「价格」是同时显示的，两者必须
  //    **严格互推**。旧实现用未量化的 loP 算价格、却把量化后的 loPct 显示出来 ——
  //    用户拿显示的 -1.4% 去手算，会得到 32.499 而不是显示的 32.492（实测偏差 0.007）。
  //    现统一口径：先把涨跌幅量化到 1 位小数，价格一律由**量化后**的涨跌幅反算，
  //    保证「看到的 %」× 发行价 = 「看到的价格」，也让分步求和能精确对上。
  function mkResult(key, ipo, loP, hiP, conf, extra) {
    const loPct = +(+loP).toFixed(1);
    const hiPct = +(+hiP).toFixed(1);
    return Object.assign({
      ok: true,
      key: key,
      loPct: loPct,
      hiPct: hiPct,
      lo: Math.round(ipo * (1 + loPct / 100) * 1000) / 1000,
      hi: Math.round(ipo * (1 + hiPct / 100) * 1000) / 1000,
      conf: conf,
    }, extra || {});
  }

  // S1：招股期（超购未出）→ 方向性 + 宽区间，低置信；A+H 可借 A 股现价估锚
  function predictS1(s, ctx) {
    const ipo = num(s.ipo_price);
    if (ipo == null || ipo <= 0) return null;
    const sec = sectorAdj(s);
    const ah = ahAnchor(s, ctx);
    const steps = [];
    let loP, hiP, conf = 1, anchor;

    const is18c = /18C/.test(s.listing_chapter || "");
    if (ah != null) {
      hiP = ah * 0.9 + 5;
      loP = Math.max(ah * 0.5, -5);
      // ⚠️ 区间反转防护：当 A 股深度折价（ah < 约 −11.1%）时，下沿的「−5% 保护」
      //    会高于上沿（×0.9+5），导致下沿 > 上沿。此时把下沿收敛到「上沿 − 1pt」，
      //    保证区间方向正确且至少保留 1pt 宽度。
      let loFixed = false;
      if (loP > hiP - 1) { loP = hiP - 1; loFixed = true; }
      conf = 2;
      anchor = { k: "A+H 溢价锚", txt: pctTxt(ah), d: "A 股现价（折港币）相对发行价的溢价，已截断 \u00b115%" };
      steps.push({
        k: "A+H 锚区间", v: null, type: "base", lo: +loP.toFixed(1), hi: +hiP.toFixed(1),
        d: "A 股溢价 " + pctTxt(ah) + " \u2192 上沿 " + pctTxt(hiP) + "（\u00d70.9 + 5%）、下沿 " + pctTxt(loP) +
          "（\u00d70.5，下限 \u22125%" + (loFixed ? "；因原下沿高于上沿，已收敛至「上沿 \u2212 1pt」" : "") + "）",
      });
      // 诚实标注"没参与"的因子：宁可少列，也不列一个不参与计算的修正
      steps.push({
        k: "赛道推断", v: null, type: "info",
        d: sec.v
          ? "\u26a0 本分支不参与计算：已有 A+H 锚（" + sec.why + "，但 A 股现价是比名称推断强得多的信号，故不叠加）"
          : "名称未命中赛道关键词",
      });
    } else {
      loP = -10; hiP = 20;
      let pick = "无赛道信号 \u2192 中性档";
      if (sec.v > 0) { loP = 0; hiP = 18; pick = "赛道偏乐观 \u2192 乐观档"; }
      else if (sec.v < 0) { loP = -15; hiP = 5; pick = "赛道偏悲观 \u2192 悲观档"; }
      anchor = { k: "赛道方向", txt: sec.v ? pctTxt(sec.v, 0) : "中性", d: "招股期无超购数据，按赛道给出方向性宽区间" };
      steps.push({
        k: "基准区间", v: null, type: "base", lo: +loP.toFixed(1), hi: +hiP.toFixed(1),
        d: pick + " \u2192 [" + pctTxt(loP, 0) + ", " + pctTxt(hiP, 0) + "]" +
          (sec.v ? "（" + sec.why + "；\u26a0 名称推断，此处是「选档」而非「直接加 " + pctTxt(sec.v, 0) + "」）" : ""),
      });
    }
    if (is18c) {
      hiP += 7;
      steps.push({
        k: "18C 章节", v: 7, type: "delta", lo: +loP.toFixed(1), hi: +hiP.toFixed(1),
        d: "18C 特专科技 \u2192 上沿 +7%（仅作用于上沿，下沿不变；赛道修正里另含 18C 的 +4）",
      });
    }
    // 保荐人战绩：招股期信息最少，保荐人历史战绩反而是最有信息量的免费信号之一。
    // 作用方式 = 把方向性区间整体平移（不改变宽度）。
    const sp1 = sponsorAdj(s.stock_code, 0.15, 8);
    if (sp1) {
      loP += sp1.v; hiP += sp1.v;
      const st1 = sponsorStep(sp1, "该股保荐人的历史首日表现");
      // 带上区间端点：S1 靠「最后一个带 lo/hi 的步骤」与最终区间对账，必须同步更新
      st1.lo = +loP.toFixed(1); st1.hi = +hiP.toFixed(1);
      steps.push(st1);
    }
    const cs1 = cornerstoneAdj(s.stock_code, s);
    if (cs1) {
      loP += cs1.v; hiP += cs1.v;
      const c1 = cornerstoneStep(cs1);
      c1.lo = +loP.toFixed(1); c1.hi = +hiP.toFixed(1);
      steps.push(c1);
    }
    return mkResult("s1", ipo, loP, hiP, conf, {
      title: KEY_LABEL.s1, basis: KEY_BASIS.s1, anchor: anchor, steps: steps,
      base: null, spread: null, stage: "S1",
      degrade: "招股期信息最少（无超购数据），区间必然偏宽",
    });
  }

  // S2：中签后 → 暗盘收盘预测（核心，依据超购校准映射 + 因子修正）
  // ⚠️ 超购倍数缺失时**必须降级出值**，不能交白卷（v0.4.3 修）：
  //    公开超购倍数是 S2 份量最重的因子，但它来自配发结果公告，站点录入常滞后
  //    （实测 06731 本末科技：配发结果公布当天该字段仍为 null）。原实现直接
  //    `return null`，于是「中签后预测」整列显示「—」—— 而这时用户**已经中签**，
  //    最需要这个数。降级路径：改用**备选条件集**（A+H 折价档 → 全样本兜底）。
  // ⚠️ v0.4.6：中枢用**中位数**、区间用**该条件集的 [P25, P75]**（不对称）。
  //    理由与实测数据见 OVER_BUCKETS 上方的「换口径」注释 —— 旧口径 48pt 宽却只有 43.6% 命中。
  function predictS2(s, ctx) {
    const ipo = num(s.ipo_price);
    if (ipo == null || ipo <= 0) return null;
    const over = num(s.public_offer_subscription_multiple);
    const steps = [];
    let base, dLo, dHi, conf, prov = false;

    if (over != null) {
      const b = overBucket(over);
      base = b.med; dLo = b.dLo; dHi = b.dHi; conf = b.conf;
      steps.push({
        k: "超购分档中枢", type: "base", v: b.med,
        d: "公开超购 " + over + " 倍 \u2192 " + overBucketTxt(over) +
          "（106 只样本该档暗盘「中位数」 " + pctTxt(b.med, 1) +
          "；区间取该档 [P25, P75] = " + pctTxt(b.med - b.dLo, 1) + " ~ " + pctTxt(b.med + b.dHi, 1) + "）",
      });
      // ⚠️ 已知取舍：超购已知时不再叠加 A+H 折价项 —— 档位中位数是无条件混合，
      //    再叠一个按均值拟合的折价斜率会重复计价。超购是远强于折价的信号，此处让位。
    } else {
      // 降级：宁可给一个标注清楚的粗估，也不留一个像"没算"的空格。
      // 条件集优先级：**A+H 折价档**（有 A 股这个硬信息）→ **全样本兜底**。
      prov = true;
      const ahd = ahAdj(s, ctx);
      const b = ahd ? ahBucket(ahd.prem) : FLAT;
      base = b.med; dLo = b.dLo; dHi = b.dHi;
      // 缺了超购这个最重的因子，就不该给最高置信（★☆☆ / ★★☆ 封顶）
      conf = Math.min(b.conf, 2);
      steps.push({
        k: ahd ? "A+H 折价档中枢" : "全样本中枢", type: "base", v: b.med,
        d: "\u26a0 站点尚未录入公开超购倍数（配发结果公告通常晚于招股截止 1\u20133 日）\u2192 无法按超购分档。" +
          (ahd
            ? "改用 A+H 折价档：A 股较发行价溢价 " + pctTxt(ahd.prem) + " \u2192「" + b.name + "」档，" +
              "该档暗盘中位数 " + pctTxt(b.med, 1) +
              "、[P25, P75] = " + pctTxt(b.med - b.dLo, 1) + " ~ " + pctTxt(b.med + b.dHi, 1)
            : "改用全样本兜底：暗盘中位数 " + pctTxt(b.med, 1) +
              "、[P25, P75] = " + pctTxt(b.med - b.dLo, 1) + " ~ " + pctTxt(b.med + b.dHi, 1)) +
          "。本预测未使用超购因子，配售结果公布后自动重算。",
      });
    }
    // ⚠️ v0.4.6：**S2 只保留「大盘环境」一个修正项**，其余五项一律不参与打分 —— 有消融实测依据。
    //    n=106（有超购 + 有暗盘）逐个叠加测过：
    //      档位中位数 + [P25,P75] 基线     命中 46.2%   点估计误差中位 23.7pt
    //      六项全部叠加（旧做法）          命中 **36.8%**  误差 **24.8pt**
    //      整体缩放系数 k：0→1 单调变差，**k=0 最好**
    //    根因之一：**保荐人战绩 / 基石占比是按「首日」标定的，而 S2 预测的是「暗盘」** —— 口径不符
    //    （S3 的标的才是首日，这两项在 S3 保留并加权，见 predictS3）。
    //    大盘环境是唯一实测有增益的（命中 48.1% > 基线 46.2%），故保留。
    const refs = [];
    const sec = sectorAdj(s);
    if (sec.v) refs.push("赛道 " + pctTxt(sec.v, 0));
    const intl = num(s.international_subscription_multiple);
    if (intl != null) { const d2 = intl > 5 ? 3 : (intl < 1 ? -4 : 0); if (d2) refs.push("国配 " + pctTxt(d2, 0)); }
    const cap = (num(s.shares_offered) || 0) * ipo / 1e8;
    if (cap) { const d4 = cap < 30 ? 3 : (cap > 300 ? -3 : 0); if (d4) refs.push("规模 " + pctTxt(d4, 0)); }
    const sp2 = sponsorAdj(s.stock_code, 0.15, 8);
    if (sp2) refs.push("保荐人 " + pctTxt(sp2.v, 1));
    const cs2 = cornerstoneAdj(s.stock_code, s);
    if (cs2) refs.push("基石 " + pctTxt(cs2.v, 1));
    steps.push({
      k: "其余因子（不参与）", type: "info",
      d: "\u26a0 " + (refs.length ? refs.join(" / ") : "本股无额外参考值") +
        " —— 仅供参考、不参与 S2 打分：n=106 消融实测，六项全叠会把命中率由 46.2% 拉低到 36.8%、" +
        "点估计误差由 23.7 拉到 24.8pt；且保荐人与基石的历史标定口径是「首日」，而 S2 预测的是「暗盘」。" +
        "这两项在 S3（标的即首日）照常参与，数值也在下方「招股书数据 / 模型因子」中看得到。",
    });
    if (CFG.liveMarket && ctx.hsi != null) {
      const d3 = +(0.3 * ctx.hsi).toFixed(2);
      base += d3;
      steps.push({ k: "大盘环境", type: "delta", v: d3, d: "恒指 " + pctTxt(ctx.hsi) + " \u00d7 0.3 = " + pctTxt(d3) });
    }
    const raw = base;
    base = clamp(base, -40, 400);
    if (base !== raw) {
      steps.push({ k: "上下界夹逼", type: "delta", v: +(base - raw).toFixed(2), d: "原始 " + pctTxt(raw, 1) + " 超出 [\u221240%, +400%] \u2192 收敛到 " + pctTxt(base, 1) });
    }
    // 区间不再是对称的 ±spread：下侧用 dLo、上侧用 dHi（真实分位区间，吃掉右偏）。
    // `spread` 仅保留为「总宽度的一半」，供旧断言与文案复用 —— **不再参与区间计算**。
    const half = +(((base + dHi) - (base - dLo)) / 2).toFixed(1);
    return mkResult("s2", ipo, base - dLo, base + dHi, conf, {
      title: KEY_LABEL.s2, basis: KEY_BASIS.s2,
      anchor: over != null
        ? { k: "公开超购倍数", txt: over + " 倍", d: "处于 " + overBucketTxt(over) }
        : { k: "暂缺超购锚", txt: "未录入", d: "配售结果未公布，本次为降级估算（未使用超购因子）" },
      steps: steps, base: +base.toFixed(1), dLo: dLo, dHi: dHi, spread: half, stage: "S2",
      provisional: prov,
    });
  }

  // S3：暗盘后 → 首日开盘预测（暗盘实际为锚 + 妖股收窄 + 隔夜大环境修正）
  function predictS3(s, ctx) {
    const ipo = num(s.ipo_price);
    const dk = num(s.dark_pool_change_pct);
    if (ipo == null || ipo <= 0 || dk == null) return null;
    const steps = [];
    let base = dk, spread = 10, conf = 3;
    steps.push({ k: "暗盘收盘锚", type: "base", v: +dk.toFixed(2), d: "暗盘收盘 " + pctTxt(dk) + "（已发生的事实，直接作锚）" });
    if (dk > 50) {
      base = dk * 0.7; spread = 18;
      steps.push({ k: "妖股收窄", type: "delta", v: +(base - dk).toFixed(2), d: "暗盘涨幅 >50% \u2192 取 0.7 倍（首日往往低于暗盘收盘），区间放宽到 \u00b118%" });
    } else if (dk < -5) {
      base = dk - 2; spread = 10;
      steps.push({ k: "破发延续", type: "delta", v: -2, d: "暗盘跌破 5% \u2192 额外 \u22122%（悲观情绪延续）" });
    } else {
      steps.push({ k: "常规情形", type: "delta", v: 0, d: "暗盘涨跌幅在 \u00b150% 内 \u2192 直接以暗盘为锚，区间 \u00b110%" });
    }
    if (CFG.liveMarket && ctx.hsi != null) {
      const d1 = +(0.4 * ctx.hsi).toFixed(2);
      base += d1;
      steps.push({ k: "隔夜大盘", type: "delta", v: d1, d: "恒指 " + pctTxt(ctx.hsi) + " \u00d7 0.4 = " + pctTxt(d1) });
    }
    const intl = num(s.international_subscription_multiple);
    if (intl != null && intl > 5) {
      base += 2;
      steps.push({ k: "国配修正", type: "delta", v: 2, d: "国际配售超购 " + intl + " 倍 > 5 \u2192 +2%" });
    }
    // S3 的预测标的就是首日，保荐人战绩（首日口径）相关性最高，故权重略大
    const sp3 = sponsorAdj(s.stock_code, 0.2, 10);
    if (sp3) { base += sp3.v; steps.push(sponsorStep(sp3, "该股保荐人的历史首日表现（S3 标的即首日，相关性更高）")); }
    const cs3 = cornerstoneAdj(s.stock_code, s);
    if (cs3) { base += cs3.v; steps.push(cornerstoneStep(cs3)); }
    const raw = base;
    base = clamp(base, -45, 400);
    if (base !== raw) {
      steps.push({ k: "上下界夹逼", type: "delta", v: +(base - raw).toFixed(2), d: "原始 " + pctTxt(raw, 1) + " 超出 [\u221245%, +400%] \u2192 收敛到 " + pctTxt(base, 1) });
    }
    return mkResult("s3", ipo, base - spread, base + spread, conf, {
      title: KEY_LABEL.s3, basis: KEY_BASIS.s3,
      anchor: { k: "暗盘收盘涨幅", txt: pctTxt(dk), d: "站点记录的暗盘收盘价相对发行价" },
      steps: steps, base: +base.toFixed(1), spread: spread, stage: "S3",
    });
  }

  // 各阶段预测都算出来，由视图按「未到 / 当前 / 已过」决定显—、高亮还是置灰保留。
  // v0.4.3 新增 phase / pending：空窗期（招股截止已过、配售结果未公布）时 S2 必须
  // 以「预估」形式显示，而不是因阶段未到就交白卷 —— 见 list.js renderCell 的 S2 分支。
  function predict(stock, stage, ctx) {
    if (stage === "UNKNOWN") return { unknown: true, stage: stage };
    const ph = phaseOf(stock, todayDate());
    return {
      stage: stage,
      phase: ph,
      pending: ph === PHASE.AWAIT,
      s1: predictS1(stock, ctx),
      s2: predictS2(stock, ctx),
      s3: predictS3(stock, ctx),
    };
  }
  /* ===================== 免费因子库（etnet 公開頁面抓取） =====================
     由 tools/fetch-etnet.py 抓取 etnet 公開免費頁面生成，變成 data/extras.js 隨插件
     本地加載 —— 插件運行時**不請求 etnet**，因此不涉及跨域、不觸及任何收費接口。
     內容：① 保薦人歷史戰績（保薦數目 / 首日上升機率 / 平均首日升跌）
           ② 已上市股的「首日開市升跌」（= 首日開盤價，S3 的預測標的） */
  const EX = (typeof window !== "undefined" && window.I668P_EXTRAS) || null;

  function exOf(code) { return (EX && EX.stocks && EX.stocks[code]) || null; }

  // 保荐人战绩（多保荐人时按样本数加权平均）
  function sponsorStats(code) {
    const e = exOf(code);
    if (!e || !e.sp || !e.sp.length) return null;
    let sw = 0, sn = 0;
    const picked = [];
    e.sp.forEach((nm) => {
      const s = EX.sponsors && EX.sponsors[nm];
      if (!s || !s.n) return;
      picked.push({ name: nm, n: s.n, prob: s.prob, avg: s.avg });
      sw += s.avg * s.n;
      sn += s.n;
    });
    if (!sn) return null;
    return { avg: sw / sn, n: sn, names: picked };
  }
  // 市场基准 = 库中所有保荐人按样本数加权后的平均首日升跌（代表整体水平）
  function sponsorBaseline() {
    if (!EX || !EX.sponsors) return null;
    let sw = 0, sn = 0;
    Object.keys(EX.sponsors).forEach((k) => {
      const s = EX.sponsors[k];
      if (!s || !s.n) return;
      sw += s.avg * s.n; sn += s.n;
    });
    return sn ? sw / sn : null;
  }
  // 保荐人修正：以「该股保荐人战绩」相对「市场基准」的偏离折算。
  // 权重刻意取小值：这是**统计值**不是个股确定性，不该主导预测；且做了上下限截断。
  function sponsorAdj(code, k, cap) {
    const st = sponsorStats(code);
    const base = sponsorBaseline();
    if (!st || base == null) return null;
    const raw = (st.avg - base) * k;
    const v = clamp(raw, -cap, cap);
    return {
      v: +v.toFixed(2), raw: +raw.toFixed(2), k: k, cap: cap,
      avg: +st.avg.toFixed(2), base: +base.toFixed(2), n: st.n, names: st.names,
      capped: Math.abs(raw - v) > 0.01,
    };
  }
  function sponsorStep(sp, why) {
    const nm = sp.names && sp.names.length ? sp.names.map((x) => x.name).join("、") : "";
    return {
      k: "保荐人战绩", type: "delta", v: sp.v,
      d: why + "：历史平均首日 " + pctTxt(sp.avg) + "（" + sp.n + " 间样本）vs 市场基准 " +
        pctTxt(sp.base) + " → 偏离 " + pctTxt(sp.avg - sp.base) + " × 权重 " + sp.k +
        " = " + pctTxt(sp.v) + (sp.capped ? "（已截断到 ±" + sp.cap + "pt）" : "") +
        (nm ? "　【" + nm + "】" : ""),
    };
  }

  // 首日**开盘**价实测（etnet「首日開市升跌」）。
  // ⚠️ S3 的预测标的就是首日开盘价，所以实测优先用开盘口径；
  //    取不到时才回退 i668 的收盘价（会在界面上明确标注口径，不混为一谈）。
  function firstDayOpenActual(s) {
    const ipo = num(s.ipo_price);
    const e = exOf(s.stock_code);
    const p = e ? e.openPct : null;
    if (ipo == null || p == null || ipo <= 0) return null;
    return { price: ipo * (1 + p / 100), pct: p };
  }

  /* ===================== 基石配售（招股章程） =====================
     数据源：招股章程 PDF（港交所披露易托管）—— 这是免费公开渠道里**唯一**
     有基石投资者数据的来源（etnet / AAStocks / 辉立 都只有保荐人与包销商）。
     ⚠️ v0.4.4：**链接不用自己找** —— i668 接口顶层就给了 `prospectus_url`
        （117/117，详情页时间线的「招股书 PDF ↗」就是它）。抓取脚本首选直接下它，
        披露易检索退为兜底（原先那套会挑错文件，17 只挑到了几十页的「延迟上市公告」）。
        工坊里也把这两枚原文链接透出来了，使用者可自行核对。
     指标：基石认购股数 ÷ 全球发售股数 = 基石占比。
     含义：基石多、占比高 = 机构认可度强，通常对暗盘/首日有正向支撑。
     ⚠️ 权重取小值：占比与首日涨幅并非线性关系，且该权重尚未经完整样本校准，
        故如实标注为"保守权重"，让使用者知道它的分量有限。 */
  const CS_BASE = 35;    // 市场基准基石占比（%）
  const CS_K = 0.12;     // 权重
  const CS_CAP = 6;      // 修正量上下限（百分点）

  function cornerstoneOf(code, stock) {
    const e = exOf(code);
    const p = e && e.pros;
    if (!p || !p.shares) return null;
    // ⚠️ 数据可信性防护（实测踩过）：
    //   ① 页数过少 => 匹配到的不是招股章程（如 3 页的「延迟上市公告」），直接丢弃；
    //   ② 基石股数 > 全球发售股数 => 提取有误（占比不可能 > 100%），直接丢弃。
    //    宁可少一个因子，也不能拿错数据去算。
    if (p.pages != null && p.pages < 100) return null;
    const total = num(stock && stock.shares_offered);
    if (total && total > 0 && p.shares > total) return null;
    const ratio = (total && total > 0) ? Math.round(p.shares / total * 1000) / 10 : null;
    return {
      shares: p.shares,
      usd: p.usd != null ? p.usd : null,
      hkd: p.hkd != null ? p.hkd : null,
      ratio: ratio,
      hasGreen: p.hasGreen === true,
      pages: p.pages || null,
    };
  }
  function cornerstoneAdj(code, stock) {
    const c = cornerstoneOf(code, stock);
    if (!c || c.ratio == null) return null;
    const raw = (c.ratio - CS_BASE) * CS_K;
    const v = clamp(raw, -CS_CAP, CS_CAP);
    return { v: +v.toFixed(2), raw: +raw.toFixed(2), c: c, base: CS_BASE, k: CS_K, cap: CS_CAP, capped: Math.abs(raw - v) > 0.01 };
  }
  function cornerstoneStep(cs) {
    const c = cs.c;
    return {
      k: "基石配售", type: "delta", v: cs.v,
      d: "招股章程载明基石认购 " + (c.shares / 1e4).toFixed(1) + " 万股" +
        (c.usd != null ? "（约 " + c.usd + " 百万美元）" : "") +
        "，占全球发售 " + c.ratio + "% vs 市场基准 " + cs.base + "% \u2192 偏离 " +
        (c.ratio - cs.base).toFixed(1) + "pt \u00d7 保守权重 " + cs.k + " = " + pctTxt(cs.v) +
        (cs.capped ? "（已截断到 \u00b1" + cs.cap + "pt）" : "") +
        "　【源：港交所招股章程】",
    };
  }

  /* ===================== 散户中签率（**只展示 · 不入权重**） =====================
     老板问到「散户中签率是不是也是影响暗盘价格的重要因素」。

     实测结论：**不是独立因子**。用站点自带数据（107 只，其中 106 只有超购）检验：
       · 与超购倍数高度共线：log10(超购) vs log10(中签率)  pearson **r = −0.72**
         —— 本质是同一枚硬币：中签率就是超购经回拨后的结果；
       · 单独解释力更弱：与暗盘涨跌 超购 r = **+0.464** > 中签率 r = −0.397；
       · 两者同时进回归只多 **2.6pp** R²（0.219 → 0.245），且中签率的系数**符号反转**
         （边际相关为负、条件相关为正）—— 典型的共线性伪信号，不稳定。
     故**只展示、不加权** —— 但它对「我能拿到多少货」是直接有用的，值得看得见。

     ⚠️ 口径诚实：站点只给「申请人数 / 中签人数」，所以这里是**人数口径中签率**，
        不是交易所公布的「一手中签率」（那需要配发基准表，免费源没有）。UI 必须写清。 */
  function rateOf(allottees, applicants) {
    const al = num(allottees), ap = num(applicants);
    if (!al || !ap) return null;
    return Math.round(al / ap * 1000) / 10;      // 百分数，保留 1 位
  }
  function allotmentRate(s) {
    const all = rateOf(s.public_offer_allottees, s.public_offer_applicants);
    const a = rateOf(s.group_a_allottees, s.group_a_applicants);
    const b = rateOf(s.group_b_allottees, s.group_b_applicants);
    if (all == null && a == null && b == null) return null;
    return { all: all, a: a, b: b };
  }

  /* ===================== 超额配股权（绿鞋） ===================== */
  // 老板明确要求「必须展示」：绿鞋不是可选项，它是上市后 30 天内的**官方托价机制** ——
  // 承销商可超额配售最多 15% 的股份，若首日跌破发行价，稳价人可买入托价；
  // 反之若股价走强，承销商行使权利增发、摊薄热度。看首日/暗盘表现时必须知道有没有它。
  // ⚠️ 为何不纳入权重：港股 IPO **绝大多数都设**（实测库内 117 只里 75 只有），
  //    区分度极低，加进模型反而引入噪声。故定位是「展示项」而非「因子」。
  function greenShoeOf(code, stock) {
    const e = exOf(code);
    const p = e && e.pros;
    if (!p || p.hasGreen == null) return null;
    if (p.pages != null && p.pages < 100) return null;   // 与基石同款防护：非招股章程一律丢弃
    const total = num(stock && stock.shares_offered);
    let gs = num(p.greenShares);
    let pct = (gs && total) ? Math.round(gs / total * 1000) / 10 : null;
    // 股数没抓到、但招股章程自述了占比 → 用自述占比（仅当它落在合理区间内才采信）
    if (pct == null) {
      const sp = num(p.greenPct);
      if (sp != null && sp >= 3 && sp <= 30) pct = sp;
    }
    // 合理性防护：超额配股权通常为全球发售股数的 10–15%（放宽到 3–30% 容错）。
    // 越界说明提取命中了别的句子 → 丢弃数字、只保留「有 / 无」这个可靠结论。
    if (pct != null && (pct < 3 || pct > 30)) { gs = null; pct = null; }
    return {
      has: p.hasGreen === true,
      shares: gs,
      pct: pct,
      stabilizer: p.stabilizer || null,
      known: true,
    };
  }

  /* ===================== 绿鞋：运行时按需解析兜底（v0.4.7） =====================
     内置 data/extras.js 只覆盖构建时的 117 只。新上市股在别人机器上没有内置数据；
     此时用 i668 接口给的 prospectus_url 去披露易抓招股章程 PDF，浏览器内用 pdf.js
     解析「超额配股权」。结果写入 chrome.storage.local 缓存（每台机器同一只股只抓一次）。
     —— 方案 A（混合）：内置优先，缺了才现场解析，不刷屏、不依赖我的服务器。 */
  let _pdfjs = null;
  async function loadPdfJs() {
    if (_pdfjs) return _pdfjs;
    const mod = await import(/* @vite-ignore */ chrome.runtime.getURL("vendor/pdf.min.mjs"));
    mod.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");
    _pdfjs = mod;
    return mod;
  }
  // 从 PDF 字节流抽取全文（供绿鞋正则）。CJK 招股章程必须带 cMaps，否则中文乱码、正则匹配不上
  async function extractPdfText(buf) {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({
      data: buf,
      cMapUrl: chrome.runtime.getURL("vendor/cmaps/"),
      cMapPacked: true,
    }).promise;
    let text = "";
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      const c = await page.getTextContent();
      text += c.items.map((it) => it.str || "").join(" ") + "\n";
    }
    await doc.destroy();
    return text;
  }
  // 把一份招股章程全文解析出绿鞋 —— 移植自 tools/fetch-prospectus.py 的 parse_prospectus（已验证口径）
  function parseGreenShoeFromText(flat) {
    const f = (flat || "").replace(/\s+/g, "");
    let hit = false, denied = false, shares = null, pct = null, stabilizer = null;
    if (/(?:超額配股權|超額配發權)」指|授出(?:超額配股權|超額配發權)|根據(?:超額配股權|超額配發權)|行使(?:超額配股權|超額配發權)/.test(f)) hit = true;
    if (/不設超額配股權|並無超額配股權|未有授出超額配股權|不會授出超額配股權/.test(f)) denied = true;
    let seg = null;
    const m1 = f.match(/「超額配股權」指([^「」]{0,600})/);
    if (m1) seg = m1[1];
    else {
      const re = /[^。；]{0,140}(?:超額配股權|超額配發權)[^。；]{0,240}/g;
      let mm;
      while ((mm = re.exec(f))) {
        if (mm[0].includes("發售量調整權")) continue;   // 排除「發售量調整權」（增发选择权，与绿鞋不同）
        seg = mm[0]; break;
      }
    }
    if (seg) {
      const ms = seg.match(/最多(?:合共)?([\d,]+)股|(?:合共)([\d,]+)股/);
      if (ms) {
        shares = parseInt((ms[1] || ms[2]).replace(/,/g, ""), 10);
        const mp = seg.slice(ms.index, ms.index + 200).match(/([\d.]+)%/);   // 占比以股数为锚取其后的百分比
        if (mp) pct = parseFloat(mp[1]);
      }
    }
    const ms2 = f.match(/「穩定價格操作人」指([^「」]{2,40})/);
    if (ms2) stabilizer = ms2[1].trim();
    // 合理性防护（与 greenShoeOf / Python 同款）：占比越界 → 丢弃数字、只留「有/无」
    if (pct != null && (pct < 3 || pct > 30)) { shares = null; pct = null; }
    const has = !!(hit && !denied);
    if (!has) { shares = null; pct = null; }
    return { hasGreen: has, greenShares: shares, greenPct: pct, stabilizer: stabilizer };
  }
  // 统一绿鞋输出（与 greenShoeOf 同口径：pct 优先用 股数/全球发售，否则用自述占比）
  function normalizeGs(rec, stock) {
    if (!rec || !rec.hasGreen) return null;
    const total = num(stock && stock.shares_offered);
    let shares = num(rec.greenShares);
    let pct = (shares && total) ? Math.round(shares / total * 1000) / 10 : null;
    if (pct == null) {
      const sp = num(rec.greenPct);
      if (sp != null && sp >= 3 && sp <= 30) pct = sp;
    }
    if (pct != null && (pct < 3 || pct > 30)) { shares = null; pct = null; }
    return { has: true, shares: shares, pct: pct, stabilizer: rec.stabilizer || null, known: true };
  }
  // 公开入口：内置有就用内置；没有就现场抓 PDF 解析并缓存
  async function ensureGreenShoe(code, stock) {
    const baked = greenShoeOf(code, stock);
    if (baked) return { src: "baked", gs: baked };
    const key = "gs_" + code;
    let cache = null;
    try { const o = await chrome.storage.local.get(key); cache = o && o[key]; } catch (e) {}
    if (cache && cache.done) {
      if (cache.hasGreen) return { src: "cache", gs: normalizeGs(cache, stock) };
      if (cache.noUrl) return { src: "noUrl", gs: null };
      if (cache.failed) return { src: "failed", gs: null };
      // cache.done 但 hasGreen=false 且非 noUrl/failed → 已确认无绿鞋，缓存结论避免重复抓 PDF
      return { src: "cache", gs: { has: false, shares: null, pct: null, stabilizer: null } };
    }
    const url = (stock && stock.prospectus_url) ||
      (exOf(code) && exOf(code).pros && exOf(code).pros.url);
    if (!url) {
      try { await chrome.storage.local.set({ [key]: { done: true, noUrl: true, ts: Date.now() } }); } catch (e) {}
      return { src: "noUrl", gs: null };
    }
    try {
      const resp = await fetch(url, { redirect: "follow" });
      if (!resp.ok) throw new Error("招股章程 HTTP " + resp.status);
      const buf = await resp.arrayBuffer();
      const text = await extractPdfText(buf);
      const parsed = parseGreenShoeFromText(text);
      const rec = {
        done: true, hasGreen: parsed.hasGreen, greenShares: parsed.greenShares,
        greenPct: parsed.greenPct, stabilizer: parsed.stabilizer, ts: Date.now(),
      };
      try { await chrome.storage.local.set({ [key]: rec }); } catch (e) {}
      return { src: "parsed", gs: parsed.hasGreen ? normalizeGs(rec, stock) : { has: false, shares: null, pct: null, stabilizer: null }, raw: parsed };
    } catch (e) {
      try { await chrome.storage.local.set({ [key]: { done: true, failed: true, ts: Date.now() } }); } catch (_) {}
      return { src: "error", gs: null, error: String((e && e.message) || e) };
    }
  }

  // 因子目录：已纳入 / 未纳入（未纳入项必须对用户讲清楚，否则"科学"二字不成立）
  function factorCatalog() {
    return {
      used: [
        { k: "超购分档", d: "公开超购倍数分 7 档，映射取自 2024–2026 共 106 只新股样本" },
        { k: "赛道修正", d: "按股票名称关键词推断（站点无行业字段），\u00b18% 以内" },
        { k: "A+H 折价锚", d: "A 股较发行价的溢价（折港币）× 回归斜率 0.238，截断 \u00b112pt \u2014\u2014 按 38 只 A+H 标的、用招股截止日前的 A 股收盘价标定（r = 0.396）。折价越深、暗盘均值越高；但这不是「不会破发」的保证（样本里折价 38~44% 仍有 3 只破发，最深折价的滨化股份暗盘 \u221221%）" },
        { k: "国配超购", d: "国际配售超购 >5 倍 +3%，<1 倍 \u22124%" },
        { k: "大盘环境", d: "恒指涨跌幅 \u00d7 0.3（S3 为 \u00d7 0.4）" },
        { k: "发行规模", d: "发行额 <30 亿港元 +3%，>300 亿 \u22123%" },
        { k: "保荐人战绩", d: "etnet 免费公开页：该股保荐人的历史首日平均升跌 vs 市场基准，按 15%（S2）/ 20%（S3）权重折算，截断 \u00b18 / \u00b110pt" },
        { k: "基石配售", d: "港交所披露易招股章程：基石认购股数 \u00f7 全球发售股数 = 基石占比，vs 市场基准 35% 按保守权重 0.12 折算，截断 \u00b16pt" },
      ],
      missing: [
        { k: "国配明细（长线基金占比）", d: "招股章程与所有免费源均只披露超额配售权与配售基准，不披露国际配售的认购人结构（谁是长线基金）\u2014\u2014 这是付费数据商的内容" },
        { k: "未上市股的开盘价", d: "招股 / 暗盘阶段尚未发生，不可能存在；已上市股的首日开盘价已由 etnet 补齐" },
      ],
      // 「展示但不入权重」：数据拿得到、也确实重要，但个股区分度低或与涨幅非线性，
      // 强行加权会引入噪声。单独列出，保证它们**在界面上看得见**，且不谎称已参与计算。
      shown: [
        { k: "超额配股权（绿鞋）", d: "港交所招股章程：承销商可超额配售（通常 15%），上市后 30 天内跌破发行价可由稳价人买入托价 \u2014\u2014 看首日必须知道有没有它。实测库内 117 只中 82 只有，区分度低，故只展示、不参与打分（工坊「招股书数据」区逐股显示有/无 + 规模 + 稳价人）" },
        { k: "发售结构（公开占比 / 回拨机制 / 基石名单）", d: "招股章程载明，工坊已逐股展示；机制差异（是否强制回拨、甲乙组分配）会显著改变中签率与暗盘筹码，但难以量化为单一分数" },
        { k: "散户中签率（整体 / 甲组 / 乙组）", d: "来自站点自带的中签人数。「与超购倍数高度共线」（log10 相关系数 \u22120.72，本质是超购经回拨后的结果），单独解释力更弱（对暗盘：超购 r=+0.46 > 中签率 \u22120.40），两者同进回归只多 2.6pp R\u00b2 且系数符号不稳定 \u2192 故「不加权，只展示」（口径为人数口径，非交易所的一手中签率）" },
      ],
    };
  }

  /* ===================== 取数（60s 节流 + 失败保留旧值） ===================== */
  async function loadData() {
    const stocks = await apiGet("/ipo-stocks");
    const map = {};
    stocks.forEach((s) => { map[s.stock_code] = s; });
    const ahCodes = stocks.filter((s) => s.is_ah_share && s.a_share_code).map((s) => s.a_share_code);
    const gtCodes = ["hkHSI"].concat(ahCodes.map(toGtimgCode));
    const ctx = { hsi: null, ah: {} };
    if (CFG.liveMarket && gtCodes.length) {
      try {
        const gt = await gtimg(gtCodes);
        ctx.hsi = gtimgPct(gt.hkHSI);
        ahCodes.forEach((code) => {
          const arr = gt[toGtimgCode(code)];
          if (!arr) return;
          const ap = gtimgPrice(arr);
          const st = stocks.find((x) => x.a_share_code === code);
          if (ap != null && st) {
            const ipo = num(st.ipo_price);
            if (ipo > 0) ctx.ah[code] = +(((ap * CFG.fxCNY2HKD) / ipo - 1) * 100).toFixed(1);
          }
        });
      } catch (e) { ctx.hsi = null; }
    }
    return { map, ctx, stocks };
  }
  async function loadDataCached(force) {
    if (!force && LAST.data && Date.now() - LAST.t < 60000) return LAST.data;
    const d = await loadData();
    LAST = { t: Date.now(), data: d };
    return d;
  }

  /* ===================== 对外接口 ===================== */
  return {
    // 常量
    SECRET: SECRET, MIN_COL_W: MIN_COL_W, MAX_COL_W: MAX_COL_W, DARK_END: DARK_END,
    WIDE_CLASS: WIDE_CLASS, COLS: COLS, STAGE_ORDER: STAGE_ORDER, KEY_ORDER: KEY_ORDER,
    STAGE_NAME: STAGE_NAME, KEY_LABEL: KEY_LABEL, KEY_BASIS: KEY_BASIS, CFG: CFG,
    // 工具
    clamp: clamp, num: num, fmt: fmt, pctTxt: pctTxt, stars: stars, mk: mk, clear: clear,
    warnOnce: warnOnce, on: on, emit: emit, ERRS: ERRS,
    // 缓存
    get CACHE() { return CACHE; },
    set CACHE(v) { CACHE = v; },
    // 存储
    OV: OV, FACTORS: FACTORS, OV_KEY: OV_KEY, FT_KEY: FT_KEY,
    isStoreReady: function () { return STORE_READY; },
    loadCfg: loadCfg, loadStore: loadStore, saveStore: saveStore,
    ovGet: ovGet, ovAll: ovAll, ovSet: ovSet, ovDel: ovDel, ovCount: ovCount,
    // API / 行情
    apiGet: apiGet, gtimg: gtimg, toGtimgCode: toGtimgCode,
    loadData: loadData, loadDataCached: loadDataCached,
    // 阶段
    pdate: pdate, todayDate: todayDate, nowHour: nowHour, getStage: getStage, stageNote: stageNote,
    stageFocus: stageFocus,
    allotmentPublished: allotmentPublished, phaseOf: phaseOf, PHASE: PHASE,
    // 模型
    predict: predict, predictS1: predictS1, predictS2: predictS2, predictS3: predictS3,
    overBucket: overBucket, overBucketTxt: overBucketTxt, sectorAdj: sectorAdj,
    darkActual: darkActual, firstDayActual: firstDayActual, firstDayOpenActual: firstDayOpenActual,
    sponsorAdj: sponsorAdj, sponsorStats: sponsorStats, sponsorBaseline: sponsorBaseline, exOf: exOf,
    cornerstoneOf: cornerstoneOf, cornerstoneAdj: cornerstoneAdj, greenShoeOf: greenShoeOf,
    ensureGreenShoe: ensureGreenShoe, parseGreenShoeFromText: parseGreenShoeFromText,
    extractPdfText: extractPdfText,
    ahAnchor: ahAnchor, ahAdj: ahAdj, AH_K: AH_K, AH_CAP: AH_CAP,
    OVER_BUCKETS: OVER_BUCKETS,
    ahBucket: ahBucket, AH_BUCKETS: AH_BUCKETS, FLAT: FLAT,
    allotmentRate: allotmentRate,
    factorCatalog: factorCatalog,
  };
})();
