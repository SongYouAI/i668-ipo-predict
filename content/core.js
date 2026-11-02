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
  const REMOTE_KEY = "i668p.remote"; // 远程参数库缓存：{ at: 时间戳, p: payload }
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
    storeGet([OV_KEY, FT_KEY, AHC_KEY, REMOTE_KEY], (r) => {
      copyInto(OV, r[OV_KEY]);
      copyInto(FACTORS, r[FT_KEY]);
      copyInto(AHC_HIST, r[AHC_KEY]);
      // 远程参数库：先用缓存（离线可用），网络更新走 checkRemoteUpdate 的后台任务
      applyRemoteCached(r[REMOTE_KEY]);
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

  /* -------- A 股「招股截止日」收盘价（A+H 溢价的唯一正确基准，v0.5.3） --------
     ⚠️ 这是一个**口径**问题，不是精度问题。
        AH_LIN 的 40 只标定样本，溢价一律用「招股截止日 A 股收盘价」计算。
        旧实现运行时取的是**实时价**（qt.gtimg 现价），于是：
          · 03757 罗博特科：截止日 565.86（溢价 +41.5%）→ 10 月底 296（−26.0%）
          · 02249 晶合集成：截止日 +102.8% → 今日 −17.8%（漂移 −120pt）
        40 只里 39 只漂移，中位 −40pt —— 模型的输入跑出了标定时的分布范围，
        同一个模型看着没问题，数字却天天变、且系统性偏低。
     三级取价（优先级从高到低）：
        ① data/ahclose.js 固化值 —— 离线、零请求、与标定完全同口径（已过截止日的股）
        ② 实时价 —— 仅用于「截止日尚未到」的招股中新股，此时实时价才是当前最优可得
        ③ 运行时回补 —— 已过截止日但固化库没有（刚上市的新股）：抓一次历史日线并缓存 7 天 */
  // v0.6.0：改为 let —— 远程参数库可整体替换这份固化表（新 A+H 上市无需发新版）
  let AHC = (typeof window !== "undefined" && window.I668P_AHCLOSE) || null;
  const AHC_KEY = "ahcHist";
  const AHC_TTL = 7 * 864e5;
  let AHC_HIST = {};        // {aCode|endDate: {c, t}} 运行时回补缓存（镜像自 storage）

  function ahLibRec(hkCode, endDate) {
    const r = AHC && AHC.close && AHC.close[hkCode];
    if (!r || r.c == null) return null;
    // 取价日必须在截止日当天或之前（≤），且不能隔太久 —— 否则是上一轮招股留下的旧记录
    if (endDate) {
      if (r.d > endDate) return null;
      const gap = (+new Date(endDate + "T00:00:00") - +new Date(r.d + "T00:00:00")) / 864e5;
      if (!(gap >= 0 && gap <= 10)) return null;
    }
    return r;
  }
  // 腾讯 fqkline 历史日线：取 endDate（含）之前最近交易日的前复权收盘价。
  // ⚠️ 日期参数必须带横线（2026-09-24）；写成 20260924 会**静默返回空数组**。
  async function gtimgCloseAt(gtCode, endDate) {
    const e = new Date(endDate + "T00:00:00");
    if (isNaN(e)) return null;
    const s = new Date(e); s.setDate(s.getDate() - 20);
    const ds = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
    const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" +
      gtCode + ",day," + ds(s) + "," + ds(e) + ",25,qfq";
    const res = await fetch(url);
    // ⚠️ 免费接口会限流：短时间猛拉会被 WAF 挡到 waf.tencent.com，返回 **HTML 跳转页**
    //    而不是 JSON。直接 res.json() 会抛 SyntaxError，把「取不到」伪装成「程序崩了」。
    //    这里一律先当文本看，非 JSON 就干净返回 null（上层退回实时价，并在界面如实标注）。
    if (!res || !res.ok) return null;
    const txt = await res.text();
    if (txt.charAt(0) !== "{") return null;
    let j;
    try { j = JSON.parse(txt); } catch (err) { return null; }
    const node = (j && j.data && j.data[gtCode]) || {};
    const arr = node.qfqday || node.day || [];
    let best = null;
    arr.forEach((row) => { if (String(row[0]) <= endDate) best = row; });
    if (!best) return null;
    const c = parseFloat(best[2]);
    return isNaN(c) ? null : { d: best[0], c: c };
  }
  function ahHistGet(aCode, endDate) {
    const k = aCode + "|" + endDate;
    const r = AHC_HIST[k];
    if (r && Date.now() - r.t < AHC_TTL) return r;
    return null;
  }
  function ahHistSet(aCode, endDate, rec) {
    AHC_HIST[aCode + "|" + endDate] = { c: rec.c, d: rec.d, t: Date.now() };
    const p = {}; p[AHC_KEY] = AHC_HIST;
    storeSet(p, null);
  }
  function loadAhHist(cb) {
    storeGet([AHC_KEY], (r) => { copyInto(AHC_HIST, r[AHC_KEY]); cb && cb(); });
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
  /* ⚠️ v0.5.0 重标定 —— 市场在 2026-07 反转，旧参数整体高估。

     环境变化（i668 接口 115 只带暗盘实测的样本）：
       期间        暗盘中位   破发率   超购中位
       2026 Q1     +31.1%     13%     1073 倍
       2026 Q2     +72.0%     21%     2003 倍
       2026 Q3      -1.2%     55%      218 倍
       2026 Q4      -1.5%     67%        4 倍
     也就是说：**现在的常态是「超购低、破发多」，而旧参数是按上半年的高热环境标的**。

     标定方法（分层混合，不是简单全样本重算，也不是纯近期——两者都试过）：
       · 以 2026-07-01 为界分成「历史段」与「近期段」；
       · 中枢/分位 = λ·近期 + (1−λ)·历史，λ = n_近期 /(n_近期 + 8)。
         K=8 是先验强度：近期只有几只时不敢全信，样本多了逐步接管；
       · **该档历史样本 < 5 只时直接弃用历史、纯用近期** —— 这几只旧样本本身
         就不构成一个可信的先验（例：<15 倍档历史只有 3 只，却会把中枢从 −4.9
         拉到 −0.6，正是「用不可信的先验压住了眼前的事实」）；
       · 区间仍取该条件集的 [P25, P75]（名义 50% 中央区间），不做人为加宽。

     效果（同一批 115 只，`node tools/backtest.js` 可复跑，该脚本直接加载本文件）：
       口径                旧参数                新参数
       全期 n=115        命中 46.1% / 20.9pt    命中 45.2% / 23.0pt
       2026-07 后 n=31   命中 38.7% /  8.9pt    命中 41.9% /  8.3pt

     ⚠️ 必须说清楚：**命中率只挪了约 3pt，n=31 的场景下在噪声范围内
        （标准误约 ±9pt），不构成"显著提升"**；全期还略降 —— 那是主动放弃
        拟合上半年高温行情的代价。这次改动的真正价值是「中枢方向修正」
        （低超购档 −2.9 → −4.9）与「新增破发率」，不在命中率上。
        谁把这次说成大幅提升，都是过度宣称。

     ⚠️ 仍未解决的问题（如实记录，别以为已经修好）：高档位（≥500 倍）
       在 7 月后几乎没有样本（500–1k 与 1k–3k 各只有 1 只），λ≈0.11，
       所以那几档**基本还是上半年的值**。若近期真出现高超购新股，
       这几档可能仍偏高 —— 破发率字段（pb）与置信星级会提示这一点。
       v0.5.4：把 nh/nr（历史/近期样本数）写进参数表，界面上逐档标注样本时效，
       不再只靠这条注释「内部知道」（λ 旧注释误写为 0，实为 1/(1+8)=0.11，已更正）。 */
  const OVER_BUCKETS = [
    //               中位数  下侧   上侧  置信 破发率   nh  nr   λ = nr/(nr+8)，nh<5 时纯用近期
    { max: 15,       med: -4.9, dLo: 4.5,  dHi: 3.2,  conf: 1, pb: 0.83, nh: 3,  nr: 7 },  // n=10  nh<5 → 纯近期
    { max: 100,      med: 0.1,  dLo: 3.6,  dHi: 6.1,  conf: 2, pb: 0.53, nh: 7,  nr: 6 },  // n=13  λ=0.43
    { max: 500,      med: 3.5,  dLo: 12.7, dHi: 13.0, conf: 3, pb: 0.39, nh: 14, nr: 12 }, // n=26  λ=0.60
    { max: 1000,     med: 30.5, dLo: 21.9, dHi: 10.9, conf: 1, pb: 0.22, nh: 6,  nr: 1 },  // n=7   λ=0.11
    { max: 3000,     med: 71.3, dLo: 35.3, dHi: 22.3, conf: 3, pb: 0.03, nh: 29, nr: 1 },  // n=30  λ=0.11
    { max: 6000,     med: 41.7, dLo: 31.3, dHi: 47.2, conf: 2, pb: 0.23, nh: 16, nr: 4 },  // n=20  λ=0.33
    { max: Infinity, med: 129.5, dLo: 40.6, dHi: 64.9, conf: 1, pb: 0.09, nh: 9,  nr: 0 }, // n=9   λ=0
  ];
  function overBucket(o) {
    for (const b of OVER_BUCKETS) if (o < b.max) return b;
    return OVER_BUCKETS[OVER_BUCKETS.length - 1];
  }
  // 该档的样本时效（**只用于告知，不参与计算** —— 参数已固化在表里）。
  //   thin：近期样本 ≤2 只 → 这一档的数基本来自 2026 上半年高热环境，
  //   而市场已在 7 月反转，故该档可能偏高。宁可把「这数不太靠得住」写在脸上。
  function bucketSample(b) {
    if (!b) return null;
    const n = (b.nh || 0) + (b.nr || 0);
    const lam = b.nh < 5 ? 1 : b.nr / (b.nr + 8);
    return { n: n, nh: b.nh || 0, nr: b.nr || 0, lam: +lam.toFixed(2), thin: (b.nr || 0) <= 2 };
  }
  /* A+H 溢价 → 暗盘：**线性标定**（v0.5.1 重标，取代原「三段折价档」AH_BUCKETS）

     ⚠️ 原实现有两个错，都已用 40 只 A+H 样本量化：
       ① S1 用 `[0.5×溢价, 0.9×溢价+5]` 当区间 —— 等于假设「暗盘 ≈ 0.5~0.9 倍溢价」。
          实测回归斜率只有 0.237，S1 那条式子的斜率是它的 2~3.5 倍：
          全样本区间命中仅 **12.8%**（名义 50%），中位误差 14.8pt，且系统偏高。
       ② 原 AH_BUCKETS 是按「旧口径溢价」标的三段档，7 月后 A+H 溢价中位仍 +44%，
          而这些股的暗盘中位已跌到 −4.3% —— 档位中位数（+2.9~+14.8）整体偏高。

     标定口径（关键）：溢价一律取「**招股截止日 A 股收盘价**（腾讯历史 K 线，前复权）×1.09 ÷ 发行价 − 1」。
       不能用「今天的 A 股价」—— 会把数月漂移算进溢价：03757 罗博特科招股期 +41.5%，
       到 10 月底已 −26%，用现价回测等于给自己编数据。

     分段回归（n=40，其中 39 只有暗盘）：
       历史段 2026-01~06（n=24）：暗盘 = +5.7 + 0.237×溢价，r = +0.427
       近期段 2026-07 起（n=15）：暗盘 = −5.8 + 0.006×溢价，r = +0.019  ← 关联基本消失
     分层混合（与 S2 同一方法）λ = 15/(15+8) = 0.652：
       斜率 0.086、截距 −1.83；残差 [P25, P75] = [−4.3, +16.7]

     效果（同一批 39 只）：区间命中 12.8% → **51.3%**（名义 50%），中位误差 14.8 → 10.5pt，
       区间均宽 10.4 → 20.9pt。命中率上去了，宽度也合理变宽 —— 原来的「窄」是假的窄。

     ⚠️ 必须说清楚：近期段斜率 ≈ 0，说明「折价越深、暗盘越高」在当前环境里**不再成立**
        （样本里 +80% 溢价的滨化股份暗盘 −21.3%，+103% 的晶合集成 +11.8%）。
        所以斜率被近期样本压到 0.086，A+H 溢价现在只能当**很弱的**方向参考，
        不再是「折价深就不会破发」的保证。若将来该关系恢复，λ 会随近期样本增加自动把它调回来。 */
  const AH_LIN = { a: -1.83, b: 0.086, dLo: 4.3, dHi: 16.7, conf: 2, name: "A+H 溢价线性" };
  // 返回 { med, dLo, dHi, lo, hi }：med 为中枢，lo/hi 为 [P25, P75] 区间（%）
  function ahLine(prem) {
    const c = AH_LIN.a + AH_LIN.b * prem;
    return {
      med: +c.toFixed(1), dLo: AH_LIN.dLo, dHi: AH_LIN.dHi,
      lo: +(c - AH_LIN.dLo).toFixed(1), hi: +(c + AH_LIN.dHi).toFixed(1),
    };
  }
  // 兜底（既无超购也无 A+H）：全样本中位数 + [P25,P75]
  // v0.5.0 同步按分层混合重标：历史 84 只 / 近期 31 只，λ=31/39=0.79
  //   旧值 med 29.7（+48.0 上沿）是按上半年高热环境标的，在 7 月后环境里偏高太多
  const FLAT = { med: 7.3, dLo: 12.4, dHi: 13.9, conf: 1, pb: 0.24 };
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
  // A+H 溢价：A 股（折港币）相对发行价的溢价率。**用原始值**，不再 clamp ±15 ——
  //   截断会把 41.5% 与 103% 压成同一个数，而线性斜率本来就能安全外推（见 AH_LIN 注释）。
  function ahPrem(s, ctx) {
    if (!s.is_ah_share || !s.a_share_code) return null;
    const prem = ctx.ah[s.a_share_code];
    return prem == null ? null : prem;
  }
  // 溢价基准日的可核查说明：告诉使用者这个溢价是**哪一天**的 A 股价算出来的。
  // 标定口径 = 招股截止日收盘价；只有截止日还没到的新股才用实时价（并明确标注）。
  function ahBasis(s, ctx) {
    const m = ctx && ctx.ahMeta && s && s.a_share_code ? ctx.ahMeta[s.a_share_code] : null;
    if (!m) return "";
    if (m.src === "none") {
      return "⚠ 招股截止日（" + (m.se || "—") + "）已过，但当日 A 股收盘价取不到（行情接口限流）→ " +
        "已放弃用 A+H 溢价，改用赛道 / 全样本兜底，避免错口径把区间整体带偏";
    }
    if (m.src === "lib" || m.src === "hist") {
      return "A 股价取 " + (m.d || "招股截止日") + " 收盘 " + m.c.toFixed(2) +
        " 元（截止日口径，与标定一致" + (m.src === "hist" ? "；运行时回补，缓存 7 天" : "") + "）";
    }
    return "A 股价取实时 " + (m.c != null ? m.c.toFixed(2) : "—") +
      " 元（招股截止日尚未到，只能用实时价）";
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

  // S1：招股期（超购未出）→ 方向性 + 宽区间，低置信；A+H 可借招股截止日 A 股收盘价估锚
  function predictS1(s, ctx) {
    const ipo = num(s.ipo_price);
    if (ipo == null || ipo <= 0) return null;
    const sec = sectorAdj(s);
    const ah = ahPrem(s, ctx);
    const steps = [];
    let loP, hiP, conf = 1, anchor;

    const is18c = /18C/.test(s.listing_chapter || "");
    if (ah != null) {
      // v0.5.1：改用线性标定（斜率 0.086 + 残差分位），取代旧的 [0.5×, 0.9×+5] 口径。
      //   旧口径实测命中 12.8%、系统偏高；新区间宽度固定 21pt，不会出现下沿>上沿。
      const cal = ahLine(ah);
      loP = cal.lo; hiP = cal.hi;
      conf = 2;
      anchor = { k: "A+H 溢价锚", txt: pctTxt(ah), d: "A 股（折港币）相对发行价的溢价，按样本回归折算为暗盘方向｜" + ahBasis(s, ctx) };
      steps.push({
        k: "A+H 线性中枢", v: cal.med, type: "base", lo: loP, hi: hiP,
        d: "A 股溢价 " + pctTxt(ah) + " \u2192 中枢 " + pctTxt(cal.med, 1) +
          "（斜率 0.086、截距 \u22121.8pt，40 只 A+H 分层混合标定）；" +
          "区间 = 中枢 + 残差 [P25, P75] = " + (-AH_LIN.dLo).toFixed(1) + "pt ~ +" + AH_LIN.dHi.toFixed(1) + "pt" +
          " \u2192 " + pctTxt(loP, 1) + " ~ " + pctTxt(hiP, 1) +
          "。\u26a0 2026-07 后该关系基本失效（r 由 +0.43 降到 +0.02），溢价只作很弱的方向参考" +
          "。" + ahBasis(s, ctx),
      });
      // 诚实标注"没参与"的因子：宁可少列，也不列一个不参与计算的修正
      steps.push({
        k: "赛道推断", v: null, type: "info",
        d: sec.v
          ? "\u26a0 本分支不参与计算：已有 A+H 锚（" + sec.why + "，但 A 股价（截止日收盘）是比名称推断强得多的信号，故不叠加）"
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
  //    最需要这个数。降级路径：改用**备选条件集**（A+H 溢价线性模型 → 全样本兜底）。
  // ⚠️ v0.4.6：中枢用**中位数**、区间用**该条件集的 [P25, P75]**（不对称）。
  //    理由与实测数据见 OVER_BUCKETS 上方的「换口径」注释 —— 旧口径 48pt 宽却只有 43.6% 命中。
  function predictS2(s, ctx) {
    const ipo = num(s.ipo_price);
    if (ipo == null || ipo <= 0) return null;
    const over = num(s.public_offer_subscription_multiple);
    const steps = [];
    let base, dLo, dHi, conf, pb = null, prov = false;

    if (over != null) {
      const b = overBucket(over);
      base = b.med; dLo = b.dLo; dHi = b.dHi; conf = b.conf; pb = b.pb;
      const bs = bucketSample(b);
      steps.push({
        k: "超购分档中枢", type: "base", v: b.med,
        d: "公开超购 " + over + " 倍 \u2192 " + overBucketTxt(over) +
          "（该档暗盘「中位数」 " + pctTxt(b.med, 1) +
          "；区间取该档 [P25, P75] = " + pctTxt(b.med - b.dLo, 1) + " ~ " + pctTxt(b.med + b.dHi, 1) + "）" +
          "。样本 n=" + bs.n + "（近期 " + bs.nr + " / 历史 " + bs.nh + "，λ=" + bs.lam + "）" +
          (bs.thin
            ? "。\u26a0 本档近期样本仅 " + bs.nr + " 只，参数基本沿用 2026 上半年高热环境，" +
              "而市场已在 7 月反转 —— 该档数值可能偏高，只当方向参考"
            : ""),
      });
      // 破发概率：暗盘收盘价低于发行价的比例。对「要不要打」比中位数更直接 ——
      // 中位数只告诉你典型落点，破发率才告诉你亏损的几率有多大。
      if (b.pb != null) {
        steps.push({
          k: "暗盘破发概率", type: "info", v: +(b.pb * 100).toFixed(0),
          d: "该超购档历史上有 " + Math.round(b.pb * 100) + "% 的新股暗盘收在发行价之下" +
            (b.pb >= 0.5 ? " —— 超过一半会破发，本档整体是负期望" : "") +
            "（按「历史段 / 近期段」分层混合统计，非单一年份口径）",
        });
      }
      // ⚠️ 已知取舍：超购已知时不再叠加 A+H 折价项 —— 档位中位数是无条件混合，
      //    再叠一个按均值拟合的折价斜率会重复计价。超购是远强于折价的信号，此处让位。
    } else {
      // 降级：宁可给一个标注清楚的粗估，也不留一个像"没算"的空格。
      // 条件集优先级：**A+H 溢价线性模型**（有 A 股这个硬信息）→ **全样本兜底**。
      prov = true;
      const ahp = ahPrem(s, ctx);
      const b = ahp != null
        ? Object.assign({ conf: AH_LIN.conf, name: AH_LIN.name }, ahLine(ahp))
        : FLAT;
      base = b.med; dLo = b.dLo; dHi = b.dHi; pb = b.pb;
      // 缺了超购这个最重的因子，就不该给最高置信（★☆☆ / ★★☆ 封顶）
      conf = Math.min(b.conf, 2);
      steps.push({
        k: ahp != null ? "A+H 线性中枢" : "全样本中枢", type: "base", v: b.med,
        d: "\u26a0 站点尚未录入公开超购倍数（配发结果公告通常晚于招股截止 1\u20133 日）\u2192 无法按超购分档。" +
          (ahp != null
            ? "改用 A+H 溢价线性模型：A 股较发行价溢价 " + pctTxt(ahp) + " \u2192 中枢 " + pctTxt(b.med, 1) +
              "（斜率 0.086、截距 \u22121.8pt），[P25, P75] = " + pctTxt(b.med - b.dLo, 1) + " ~ " + pctTxt(b.med + b.dHi, 1) +
              "。\u26a0 2026-07 后「折价越深越涨」已不成立（r 由 +0.43 降到 +0.02），此值只作很弱的方向参考。" +
              ahBasis(s, ctx)
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
    // 注意：上面超购分支里的 `b` 是块级 const，到此已出作用域，必须重新取档
    const obs = over != null ? bucketSample(overBucket(over)) : null;
    return mkResult("s2", ipo, base - dLo, base + dHi, conf, {
      title: KEY_LABEL.s2, basis: KEY_BASIS.s2,
      anchor: over != null
        ? { k: "公开超购倍数", txt: over + " 倍",
            d: "处于 " + overBucketTxt(over) +
              (obs && obs.thin
                ? "（\u26a0 该档近期样本仅 " + obs.nr + " 只，参数以 2026 上半年为主）" : "") }
        : { k: "暂缺超购锚", txt: "未录入", d: "配售结果未公布，本次为降级估算（未使用超购因子）" },
      steps: steps, base: +base.toFixed(1), dLo: dLo, dHi: dHi, spread: half, stage: "S2",
      provisional: prov, pb: pb,
    });
  }

  /* S3：暗盘后 → 首日【开盘】预测（v0.5.0 重构）

     ⚠️ 旧实现有一个**方向性错误**，必须记下来：
        旧规则「暗盘涨超 50% → 首日取 0.7 倍」，等于假设妖股首日一定回落 30%。
        用 118 只带「首日开市升跌」的样本实测：
          · 暗盘 > 50% 的 42 只，首日开盘 / 暗盘 的比值**中位数 = 1.008**（不是 0.70）
          · 首日开盘 − 暗盘 的中位差 +0.9pt（P20 −8.3 / P80 +14.4）
          · 暗盘涨幅与首日开盘涨幅的相关系数 **+0.990**
        结论：首日开盘基本就是暗盘收盘的延续，不存在系统性回落。
        旧规则会把每一只妖股的预测硬压低 30%，这是 S3 一直不准的根源。

     新结构：**base = 暗盘 + 该暗盘档的偏移中位数**，区间取偏移的 [P20, P80]。
       · 保留「跟随暗盘」—— 0.99 相关性给出的最强信息，不能用一个档位中位数
         把个股差异抹平（否则暗盘 +55% 与 +95% 会给出同一个预测，还会在档边界断层）；
       · 档位只贡献一个**小幅偏移**，表达「这个涨幅区间的次日开盘倾向」；
       · 偏移表按与 S2 相同的分层混合口径标定（2026-07-01 为界，K=8，
         该档历史 <5 只则纯用近期）。

     口径警告：**S3 的标的是「首日开盘价」，不是首日收盘价。**
       站点接口只给 first_day_close_price，用它评估会把结果算错 ——
       实测首日收盘比开盘中位低 3.0pt，两者不能混用。
       本表的样本来自 extras.js 的 openPct（etnet「首日開市升跌」）。

     评估（全样本 n=118 in-sample，统一开盘价口径，用本文件实测复跑）：
       旧规则 0.7 倍       命中 59.3%   点估计误差中位 7.9pt
       本方案              命中 58.5%   点估计误差中位 4.1pt
     命中率持平，但**误差几乎减半**：旧规则靠宽区间（±10 / ±18）兜住了覆盖率，
     代价是点估计系统性错误（妖股一律 ×0.7）。对「暗盘后是否次日卖出」这件事，
     落点准比区间大有用得多。

     ⚠️ 保荐人 / 基石 / 国配 在 S3 **不参与打分**（与 S2 同理，但理由不同）：
        实测「首日开盘 − 暗盘」的残差与保荐人战绩偏离的相关系数只有 **+0.051**，
        分组看甚至方向相反（战绩好的保荐人，残差反而 −4.6pt）。暗盘已经吸收了
        绝大部分信息，再叠这些因子只是加噪声。它们仍会在下方因子区展示。 */
  const DARK_TO_OPEN = [
    //         偏移中位  下侧    上侧   样本 近期
    { max: -5,       med: -1.4, dLo: 3.5,  dHi: 2.7,  n: 10 },  // 暗盘 <-5%   近期 7 只 → 纯近期
    { max: 0,        med: 2.0,  dLo: 10.7, dHi: 2.3,  n: 13 },  // -5~0%      近期 8 只 λ=0.50
    { max: 10,       med: -1.7, dLo: 4.1,  dHi: 1.9,  n: 21 },  // 0~10%      近期 6 只 λ=0.43
    { max: 30,       med: -4.2, dLo: 3.4,  dHi: 4.8,  n: 10 },  // 10~30%     近期 2 只 λ=0.20
    { max: 50,       med: -2.8, dLo: 4.4,  dHi: 8.6,  n: 14 },  // 30~50%     近期 0 只 λ=0
    { max: 100,      med: 2.3,  dLo: 8.0,  dHi: 10.9, n: 23 },  // 50~100%    近期 1 只 λ=0
    { max: Infinity, med: 3.0,  dLo: 13.8, dHi: 14.2, n: 18 },  // >100%      近期 2 只 λ=0.20
  ];
  function darkBucket(dk) {
    for (const b of DARK_TO_OPEN) if (dk < b.max) return b;
    return DARK_TO_OPEN[DARK_TO_OPEN.length - 1];
  }
  function darkBucketTxt(dk) {
    const i = DARK_TO_OPEN.indexOf(darkBucket(dk));
    const lo = i === 0 ? null : DARK_TO_OPEN[i - 1].max;
    const hi = DARK_TO_OPEN[i].max === Infinity ? "\u221e" : DARK_TO_OPEN[i].max;
    return (lo === null ? "<" + hi : lo + "~" + hi) + "% 档";
  }

  function predictS3(s, ctx) {
    const ipo = num(s.ipo_price);
    const dk = num(s.dark_pool_change_pct);
    if (ipo == null || ipo <= 0 || dk == null) return null;
    const steps = [];
    const b = darkBucket(dk);
    const dLo = b.dLo, dHi = b.dHi;
    let base = dk;
    const conf = b.n >= 20 && (dLo + dHi) <= 14 ? 3 : (b.n >= 10 ? 2 : 1);
    steps.push({
      k: "暗盘收盘锚", type: "base", v: +dk.toFixed(2),
      d: "暗盘收盘 " + pctTxt(dk) + "（已发生的事实，直接作锚。暗盘与首日开盘涨幅的相关系数达 0.99，是最强的锚）",
    });
    if (Math.abs(b.med) >= 0.1) {
      base += b.med;
      steps.push({
        k: "暗盘档偏移", type: "delta", v: b.med,
        d: "暗盘落在 " + darkBucketTxt(dk) + " \u2192 首日开盘相对暗盘的历史偏移中位 " + pctTxt(b.med, 1) +
          "；区间取该档偏移 [P20, P80] = " + pctTxt(b.med - b.dLo, 1) + " ~ " + pctTxt(b.med + b.dHi, 1) +
          "（" + b.n + " 只实测，非「涨超 50% 就一定回落」的旧假设）",
      });
    } else {
      steps.push({ k: "暗盘档偏移", type: "delta", v: 0,
        d: "暗盘落在 " + darkBucketTxt(dk) + "，该档偏移中位约 0 \u2192 首日开盘按暗盘持平处理" });
    }
    if (CFG.liveMarket && ctx.hsi != null) {
      const d1 = +(0.4 * ctx.hsi).toFixed(2);
      base += d1;
      steps.push({ k: "隔夜大盘", type: "delta", v: d1, d: "恒指 " + pctTxt(ctx.hsi) + " \u00d7 0.4 = " + pctTxt(d1) });
    }
    // 其余因子：与 S2 一样「只展示、不参与」—— 实测对「首日开盘−暗盘」的残差近乎无关
    const refs = [];
    const intl = num(s.international_subscription_multiple);
    if (intl != null) refs.push("国配 " + intl + " 倍");
    const sp3 = sponsorAdj(s.stock_code, 0.2, 10);
    if (sp3) refs.push("保荐人战绩偏离 " + pctTxt(sp3.v, 1));
    const cs3 = cornerstoneAdj(s.stock_code, s);
    if (cs3) refs.push("基石 " + pctTxt(cs3.v, 1));
    steps.push({
      k: "其余因子（不参与）", type: "info",
      d: "\u26a0 " + (refs.length ? refs.join(" / ") : "本股无额外参考值") +
        " —— 仅供参考、不参与 S3 打分：118 只实测，「首日开盘 − 暗盘」的残差与保荐人战绩偏离" +
        "相关系数仅 +0.051（分组看方向甚至相反），叠加只会引入噪声。",
    });
    const raw = base;
    base = clamp(base, -45, 400);
    if (base !== raw) {
      steps.push({ k: "上下界夹逼", type: "delta", v: +(base - raw).toFixed(2), d: "原始 " + pctTxt(raw, 1) + " 超出 [\u221245%, +400%] \u2192 收敛到 " + pctTxt(base, 1) });
    }
    return mkResult("s3", ipo, base - dLo, base + dHi, conf, {
      title: KEY_LABEL.s3, basis: KEY_BASIS.s3,
      anchor: { k: "暗盘收盘涨幅", txt: pctTxt(dk), d: "站点记录的暗盘收盘价相对发行价" },
      steps: steps, base: +base.toFixed(1), dLo: dLo, dHi: dHi,
      spread: +(((dLo + dHi) / 2).toFixed(1)), stage: "S3",
    });
  }

  // 各阶段预测都算出来，由视图按「未到 / 当前 / 已过」决定显—、高亮还是置灰保留。
  // v0.4.3 新增 phase / pending：空窗期（招股截止已过、配售结果未公布）时 S2 必须
  // 以「预估」形式显示，而不是因阶段未到就交白卷 —— 见 list.js renderCell 的 S2 分支。
  /* ----- 不适用判定：这些股票**不该**给三阶段预测 -----
     ① 招股已终止：站点 `listing_status` = `postponed`（延期）/ `shelved`（搁置）。
        此时发行价仍留着（ipo_price 有值），模型照常按 S1 出一段区间 ——
        界面看起来像"可以打"，实际这只股已经不打或还没重新招股。
     ② 无公开发售（介绍上市）：`ipo_price` ≤ 0 且 `hk_shares_offered` 缺失
        （实测库内仅 01821 中旅港澳一只）。没有公开发售就没有中签、没有暗盘，
        三阶段预测全部无意义；此前是靠 predictS1 里 `ipo <= 0 → null` 侥幸挡住 S1，
        S2 仍会在空窗期给出一段"降级估算"。
     判定只用站点已返回的字段，不做名称/文本猜测；判定不成立时一律返回 null。 */
  const ISSUE = {
    postponed: {
      k: "postponed", label: "已延期",
      why: "该股已延期上市（站点状态 postponed），发行价虽仍在，但招股已中止 —— " +
        "没有配售结果、没有暗盘，三阶段预测全部不适用。若重新招股，站点状态恢复后会自动重新计算。",
    },
    shelved: {
      k: "shelved", label: "已搁置",
      why: "该股已搁置上市（站点状态 shelved），本次发行未完成 —— 三阶段预测不适用。",
    },
    intro: {
      k: "intro", label: "无公开发售",
      why: "该股为介绍上市：无发行价（发行价为 0）、无公开发售股数 —— " +
        "既没有公开认购，也没有暗盘与中签，三阶段预测不适用。",
    },
  };
  function stockIssue(s) {
    if (!s) return null;
    const ls = String(s.listing_status || "").toLowerCase();
    if (ls === "postponed") return ISSUE.postponed;
    if (ls === "shelved") return ISSUE.shelved;
    const ipo = num(s.ipo_price);
    if ((ipo == null || ipo <= 0) && num(s.hk_shares_offered) == null) return ISSUE.intro;
    return null;
  }

  function predict(stock, stage, ctx) {
    // 判定顺序：不适用在前 —— 介绍上市本就没有招股/暗盘日期，若先判 UNKNOWN 会说成
    // 「无日期」，把"这类股不存在这三阶段"误报成"数据缺了"。
    const issue = stockIssue(stock);
    if (issue) {
      return { stage: stage, phase: phaseOf(stock, todayDate()), blocked: issue, s1: null, s2: null, s3: null };
    }
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
  // v0.6.0：改为 let —— 远程参数库可整体替换（补新股的保荐人/首日升跌无需发新版）
  let EX = (typeof window !== "undefined" && window.I668P_EXTRAS) || null;

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
  // v0.6.0：这三项从独立常量收进对象 —— 独立 const 基本类型无法在运行时被远程参数覆盖，
  // 而它们确实需要随时重标（基石权重尚未经完整样本校准，见下方注释）。
  const CS = {
    base: 35,   // 市场基准基石占比（%）
    k: 0.12,    // 权重
    cap: 6,     // 修正量上下限（百分点）
  };

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
    const raw = (c.ratio - CS.base) * CS.k;
    const v = clamp(raw, -CS.cap, CS.cap);
    return { v: +v.toFixed(2), raw: +raw.toFixed(2), c: c, base: CS.base, k: CS.k, cap: CS.cap, capped: Math.abs(raw - v) > 0.01 };
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

  /* ===================== 绿鞋：运行时按需解析兜底（v0.5.0） =====================
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
  // opts.from / opts.to：只抽某一段页（1-based，含端点）。省略即全文。
  async function extractPdfText(buf, opts) {
    const o = opts || {};
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({
      data: buf,
      cMapUrl: chrome.runtime.getURL("vendor/cmaps/"),
      cMapPacked: true,
    }).promise;
    const total = doc.numPages;
    const from = Math.max(1, o.from || 1);
    const to = Math.min(o.to || total, total);
    let text = "";
    for (let i = from - 1; i < to; i++) {
      const page = await doc.getPage(i + 1);
      const c = await page.getTextContent();
      text += c.items.map((it) => it.str || "").join(" ") + "\n";
    }
    await doc.destroy();
    return text;
  }

  /* 分段解析绿鞋（v0.4.10）：招股章程动辄 400–800 页 / 20–40 MB，全量逐页抽文字会把页面
     卡住数十秒，而「超額配股權」的定义几乎总在「釋義」章 —— 实测 02681（476 页）在第 23–31 页。
     故先抽前 GS_EARLY_PAGES 页交给判定函数；只有「既没命中、也没被否定」才续读到尾。
     一次 getDocument、一次 destroy：不重复解析这个大文件。 */
  const GS_EARLY_PAGES = 80;
  /* v0.5.5：改成「按需 Range 下载」，不再先把整份章程拉完再解析。
     同一份 23.7MB / 476 页的章程，三轮交替实测：
       全量 data 模式  14.1s / 22.6MB
       Range 按需模式   6.1s / 6.6MB   → 2.3×、省 71% 流量（绿鞋结论完全一致）
     前提（缺一不可）：DNR 规则把 content-range / accept-ranges 暴露给页面，
     pdf.js 靠 Content-Range 推算总大小；读不到会直接失败 → 由调用方降级为全量。
     rangeChunkSize 不能调小：64KB 时读 80 页要 24 次往返，耗时反而涨到 15.7s
     （512KB 12.6s / 1MB 11.9s / 2MB 10.6s / 4MB 8.8s）—— RTT 比字节更贵。 */
  const GS_RANGE_CHUNK = 4 * 1024 * 1024;
  // src：ArrayBuffer（全量字节）或 { url }（按需 Range 取块）
  async function parseGreenShoePdf(src) {
    const pdfjs = await loadPdfJs();
    const viaUrl = !!(src && typeof src === "object" && src.url);
    const doc = await pdfjs.getDocument(Object.assign(
      viaUrl
        ? { url: src.url, rangeChunkSize: GS_RANGE_CHUNK, disableAutoFetch: true, disableStream: true }
        : { data: src },
      { cMapUrl: chrome.runtime.getURL("vendor/cmaps/"), cMapPacked: true }
    )).promise;
    const total = doc.numPages;
    const readRange = async (from, to) => {
      let s = "";
      for (let i = from - 1; i < to; i++) {
        const page = await doc.getPage(i + 1);
        const c = await page.getTextContent();
        s += c.items.map((it) => it.str || "").join(" ") + "\n";
      }
      return s;
    };
    try {
      let text = await readRange(1, Math.min(GS_EARLY_PAGES, total));
      let parsed = parseGreenShoeFromText(text);
      parsed.pagesRead = Math.min(GS_EARLY_PAGES, total);
      parsed.pagesTotal = total;
      if (!parsed.decided && total > GS_EARLY_PAGES) {
        text += "\n" + (await readRange(GS_EARLY_PAGES + 1, total));
        parsed = parseGreenShoeFromText(text);
        parsed.pagesRead = total;
        parsed.pagesTotal = total;
      }
      return parsed;
    } finally {
      try { await doc.destroy(); } catch (e) {}
    }
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
    // decided = 这一段文字已经能给出确定结论（有 或 明确没有）。
    // 分段解析靠它判断「要不要继续往后读」—— 没 decided 就不能断言无绿鞋。
    return { hasGreen: has, greenShares: shares, greenPct: pct, stabilizer: stabilizer, decided: hit || denied };
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
  // ⚠️ v0.4.10：失败缓存**必须过期**。原实现把失败写成 {done:true,failed:true} 永久保留，
  //    一次网络抖动 / 一次跨域拦截，就等于该股在这台机器上永远「解析失败」，
  //    除非手动清 chrome.storage 才可能恢复。现改为 24h 后自动重试一次。
  // 失败归因：三类原因给用户的处置建议完全不同，必须分开讲，不能一律叫「解析失败」
  //   cors  —— 浏览器跨域拦截（披露易只放行自家域名），重试无意义，只能点原文看
  //   http  —— 港交所返回错误码（404/503），过一阵可能自愈
  //   parse —— 拿到了 PDF 但抽不出数据（扫描件 / 版式变化）
  function gsErrorKind(msg) {
    const s = String(msg || "");
    if (/HTTP \d+/.test(s)) return "http";
    if (!s || /Failed to fetch|NetworkError|Load failed|CORS|跨域|fetch failed/i.test(s)) return "cors";
    return "parse";
  }
  const GS_FAIL_TTL = 24 * 3600 * 1000;
  async function ensureGreenShoe(code, stock) {
    const baked = greenShoeOf(code, stock);
    if (baked) return { src: "baked", gs: baked };
    const key = "gs_" + code;
    let cache = null;
    try { const o = await chrome.storage.local.get(key); cache = o && o[key]; } catch (e) {}
    if (cache && cache.done) {
      if (cache.hasGreen) return { src: "cache", gs: normalizeGs(cache, stock) };
      if (cache.noUrl) return { src: "noUrl", gs: null };   // 无链接是稳定事实，不必过期
      if (cache.failed) {
        const age = Date.now() - (cache.ts || 0);
        if (age < GS_FAIL_TTL) return { src: "failed", gs: null, error: cache.error || "", kind: cache.kind || gsErrorKind(cache.error) };
        // 过期 → 继续往下重新尝试（不 return）
      } else {
        // cache.done 但 hasGreen=false 且非 noUrl/failed → 已确认无绿鞋，缓存结论避免重复抓 PDF
        return { src: "cache", gs: { has: false, shares: null, pct: null, stabilizer: null } };
      }
    }
    const url = (stock && stock.prospectus_url) ||
      (exOf(code) && exOf(code).pros && exOf(code).pros.url);
    if (!url) {
      try { await chrome.storage.local.set({ [key]: { done: true, noUrl: true, ts: Date.now() } }); } catch (e) {}
      return { src: "noUrl", gs: null };
    }
    try {
      // ① 优先按需 Range（只下前 80 页所需的块）；② 失败再退回全量下载。
      //    Range 依赖 DNR 暴露 Content-Range，扩展未重载/权限未生效时会失败 —— 必须能退。
      let parsed;
      try {
        parsed = await parseGreenShoePdf({ url: url });
      } catch (eRange) {
        const resp = await fetch(url, { redirect: "follow" });
        if (!resp.ok) throw new Error("招股章程 HTTP " + resp.status);
        parsed = await parseGreenShoePdf(await resp.arrayBuffer());
      }
      const rec = {
        done: true, hasGreen: parsed.hasGreen, greenShares: parsed.greenShares,
        greenPct: parsed.greenPct, stabilizer: parsed.stabilizer, ts: Date.now(),
      };
      try { await chrome.storage.local.set({ [key]: rec }); } catch (e) {}
      return { src: "parsed", gs: parsed.hasGreen ? normalizeGs(rec, stock) : { has: false, shares: null, pct: null, stabilizer: null }, raw: parsed };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const kind = gsErrorKind(msg);
      try { await chrome.storage.local.set({ [key]: { done: true, failed: true, error: msg, kind: kind, ts: Date.now() } }); } catch (_) {}
      return { src: "error", gs: null, error: msg, kind: kind };
    }
  }

  // 因子目录：已纳入 / 未纳入（未纳入项必须对用户讲清楚，否则"科学"二字不成立）
  function factorCatalog() {
    return {
      used: [
        { k: "超购分档", d: "公开超购倍数分 7 档，映射取自 2024–2026 共 106 只新股样本" },
        { k: "赛道修正", d: "按股票名称关键词推断（站点无行业字段），\u00b18% 以内" },
        { k: "A+H 溢价锚", d: "A 股（折港币）较发行价的溢价 → 暗盘方向，线性折算：中枢 = −1.8 + 0.086×溢价，区间 = 中枢 + 残差 [P25,P75]。按 40 只 A+H、用「招股截止日」的 A 股收盘价标定（不用现价，避免数月漂移）。\u26a0 该关系 2026-07 后基本失效（r 由 +0.43 降到 +0.02：+80% 溢价的滨化股份暗盘 −21%），斜率已被近期样本压到 0.086，只作很弱的方向参考" },
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
    const ahStocks = stocks.filter((s) => s.is_ah_share && s.a_share_code);
    const ctx = { hsi: null, ah: {}, ahMeta: {} };
    const td = todayDate();

    // —— 第 ① 级：固化库（离线、零请求、与 AH_LIN 标定完全同口径）——
    //    不受「实时行情」开关影响：这是本地数据文件，不是网络行情。
    const needLive = [], needHist = [];
    ahStocks.forEach((s) => {
      const code = s.a_share_code, ipo = num(s.ipo_price), se = s.subscription_end_date;
      if (!(ipo > 0)) return;
      const lib = ahLibRec(s.stock_code, se);
      if (lib) {
        ctx.ah[code] = +(((lib.c * CFG.fxCNY2HKD) / ipo - 1) * 100).toFixed(1);
        ctx.ahMeta[code] = { src: "lib", d: lib.d, c: lib.c, hk: s.stock_code };
        return;
      }
      const seD = pdate(se);
      // 截止日已过（严格早于今天）却查不到固化值 → 新上市的 A+H，运行时补一次历史日线
      if (seD && +seD < +td) needHist.push(s); else needLive.push(s);
    });

    // —— 第 ②/③ 级：实时价（招股中）与历史回补（已过截止日的新股）——
    const ahCodes = ahStocks.map((s) => s.a_share_code);
    const gtCodes = ["hkHSI"].concat(ahCodes.map(toGtimgCode));
    const put = (s, ap, meta) => {
      const ipo = num(s.ipo_price);
      if (!(ipo > 0) || ap == null) return false;
      ctx.ah[s.a_share_code] = +(((ap * CFG.fxCNY2HKD) / ipo - 1) * 100).toFixed(1);
      ctx.ahMeta[s.a_share_code] = meta;
      return true;
    };
    let live = {};
    if (CFG.liveMarket && gtCodes.length) {
      try {
        const gt = await gtimg(gtCodes);
        ctx.hsi = gtimgPct(gt.hkHSI);
        ahCodes.forEach((code) => {
          const p = gtimgPrice(gt[toGtimgCode(code)]);
          if (p != null) live[code] = p;
        });
      } catch (e) { ctx.hsi = null; }
    }
    needLive.forEach((s) => {
      const p = live[s.a_share_code];
      if (p != null) put(s, p, { src: "live", why: "pending", d: null, c: p, hk: s.stock_code });
    });

    if (needHist.length && CFG.liveMarket) {
      // 小并发（3）排队，避免一次性打 40 个免费接口；单只失败就退回实时价并如实标注
      const queue = needHist.slice();
      const worker = async () => {
        while (queue.length) {
          const s = queue.shift();
          const se = s.subscription_end_date, a = s.a_share_code;
          let rec = ahHistGet(a, se);
          if (!rec) {
            try {
              const got = await gtimgCloseAt(toGtimgCode(a), se);
              if (got) { rec = { c: got.c, d: got.d, t: Date.now() }; ahHistSet(a, se, got); }
            } catch (e) { rec = null; }
            // 免费接口有频率限制，3 并发之间也要留间隔，否则会被 WAF 挡（见 gtimgCloseAt 注释）
            await new Promise((r) => setTimeout(r, 150));
          }
          if (rec) {
            put(s, rec.c, { src: "hist", d: rec.d, c: rec.c, hk: s.stock_code });
          } else {
            // 截止日已过、却拿不到历史收盘价（通常是接口限流）→ **宁可不给溢价**。
            //    AH_LIN 斜率 0.086：溢价错 60pt 就是中枢偏 5pt，这是**系统性错误**，
            //    不是「仅供参考」。退回赛道 / 全样本兜底更安全，界面也会如实说明。
            ctx.ahMeta[a] = { src: "none", why: "fail", hk: s.stock_code, se: se };
          }
        }
      };
      const n = Math.min(3, needHist.length);
      await Promise.all(Array.from({ length: n }, () => worker()));
    }
    return { map, ctx, stocks };
  }
  async function loadDataCached(force) {
    if (!force && LAST.data && Date.now() - LAST.t < 60000) return LAST.data;
    const d = await loadData();
    LAST = { t: Date.now(), data: d };
    return d;
  }

  /* ===================== 远程参数库（v0.6.0） =====================

     为什么需要：要把插件分享给别人用，而 **Chrome 商店外的扩展不会自动更新**
     （开发者模式加载的扩展，每次更新都要别人重新下载、解压、覆盖、点刷新——
     10 个小白用户里能坚持更新两次的不会超过 2 个）。
     但实测这个插件 90% 的更新是「数据 + 参数」，不是算法：
       · 数据：data/extras.js（因子库）、data/ahclose.js（A+H 基准价）
       · 参数：OVER_BUCKETS 七档、DARK_TO_OPEN 七档、AH_LIN、FLAT、基石权重、汇率
     这些外置成 dist/latest.json，运行时拉取并缓存 —— 改数据/参数**不用重发版本**，
     别人下次打开页面自动用上。只有改 core.js 算法才需要重装。

     三级回落（国内访问 GitHub 不稳，必须留后路）：
       ① 本地缓存 chrome.storage（6 小时内不重复请求，离线可用）
       ② jsDelivr CDN → GitHub raw（依次尝试）
       ③ 打包内置 data/*.js（网络全挂也能用完整功能）

     ⚠️ 两个必须记住的坑：
       ① **Infinity 序列化**：JSON.stringify(Infinity) 得到 "null"。OVER_BUCKETS 与
          DARK_TO_OPEN 最后一档的 max 都是 Infinity，存进 JSON 会变 null，读回来若不
          转回，`o < null` 恒为 false → 最后一档永远匹配不上，overBucketTxt 还会显示
          "null"。故 apply 时把 null/缺失的 max 一律还原成 Infinity。
       ② **不能拖慢页面**：数据拉取是后台异步的，渲染永远先用内置/缓存。
          拿到新数据后就地改参数（下次计算即生效），并提示「刷新页面生效」。 */

  const REMOTE_TTL = 6 * 3600 * 1000;
  /* 源顺序按「国内实测可用性」排，不是随便列的（2026-11-02 在这台机器上逐个 curl 过）：
       testingcf 3.0s ✓ · gcore 3.9s ✓ · cdn.jsdelivr.net ✗（TLS 被 RST）· raw ✗（SSL 拦截）
     jsDelivr 的这几个域名都是官方提供的，不是第三方加速站 —— 后者（ghproxy 之类）
     时好时坏，放进生产链路等于给用户埋雷。
     ⚠️ jsDelivr 对**分支**引用缓存 s-maxage=43200（12 小时，实测响应头确认）。
        意味着你更新 dist/latest.json 后，用户最多要等 12 小时才收到；
        点 popup 里的「检查数据更新」也绕不过 CDN 缓存。
        要准实时必须再加一个不走 CDN 的源（Gitee raw 或自建），见 README。 */
  const REMOTE_URLS = [
    "https://testingcf.jsdelivr.net/gh/SongYouAI/i668-ipo-predict@main/dist/latest.json",
    "https://gcore.jsdelivr.net/gh/SongYouAI/i668-ipo-predict@main/dist/latest.json",
    "https://fastly.jsdelivr.net/gh/SongYouAI/i668-ipo-predict@main/dist/latest.json",
    "https://cdn.jsdelivr.net/gh/SongYouAI/i668-ipo-predict@main/dist/latest.json",
    "https://raw.githubusercontent.com/SongYouAI/i668-ipo-predict/main/dist/latest.json",
  ];
  let REMOTE_VER = null;      // 已应用的远程数据版本号（界面用来显示数据是否最新）

  function isNum(x) { return typeof x === "number" && isFinite(x); }

  // 单档校验：中位数与上下侧必须是有限数；max 升序由 validRemote 统一检查
  function validBucket(b) {
    return !!b && typeof b === "object" && isNum(b.med) && isNum(b.dLo) && isNum(b.dHi) && b.dLo >= 0 && b.dHi >= 0;
  }
  function validBuckets(arr, min) {
    if (!Array.isArray(arr) || arr.length < (min || 3)) return false;
    if (!arr.every(validBucket)) return false;
    // 最后一档必须无上界（JSON 里是 null），否则 overBucket 的兜底会失效
    const last = arr[arr.length - 1];
    if (last.max !== null && last.max !== undefined && last.max !== Infinity) return false;
    // max 必须严格升序：overBucket 靠「第一个 o < max」取值，乱序会整体错档
    for (let i = 1; i < arr.length - 1; i++) {
      if (!(arr[i].max > arr[i - 1].max)) return false;
    }
    return true;
  }
  // 整体校验：宁可整份丢弃，也不接受半份坏数据 —— 参数错一位，所有人预测全错
  function validRemote(p) {
    if (!p || typeof p !== "object") return false;
    const pa = p.params;
    if (!pa || typeof pa !== "object") return false;
    if (!validBuckets(pa.overBuckets)) return false;
    if (!validBuckets(pa.darkToOpen)) return false;
    if (!pa.ahLin || !isNum(pa.ahLin.a) || !isNum(pa.ahLin.b) || !isNum(pa.ahLin.dLo) || !isNum(pa.ahLin.dHi)) return false;
    if (!pa.flat || !isNum(pa.flat.med) || !isNum(pa.flat.dLo) || !isNum(pa.flat.dHi)) return false;
    if (pa.cs && (!isNum(pa.cs.base) || !isNum(pa.cs.k) || !isNum(pa.cs.cap))) return false;
    if (pa.fx != null && (!isNum(pa.fx) || pa.fx <= 0)) return false;
    const d = p.data;
    if (!d || !d.extras || !d.extras.stocks || typeof d.extras.stocks !== "object") return false;
    // 数据完整性护栏：远程库比内置库少一半以上，说明抓错了或抓残了 → 拒绝
    const n = Object.keys(d.extras.stocks).length;
    const baseN = EX && EX.stocks ? Object.keys(EX.stocks).length : 0;
    if (n < 20 || (baseN && n < baseN * 0.5)) return false;
    if (d.ahclose && d.ahclose.close && typeof d.ahclose.close !== "object") return false;
    return true;
  }
  // 就地覆盖：OVER_BUCKETS 等是 const 数组/对象，改内容而非换引用，所有闭包立即看到新值
  function applyRemote(p) {
    if (!validRemote(p)) return false;
    try {
      const pa = p.params;
      const norm = (arr) => arr.map((b) => {
        const o = {
          max: (b.max === null || b.max === undefined) ? Infinity : b.max,
          med: b.med, dLo: b.dLo, dHi: b.dHi,
          conf: isNum(b.conf) ? b.conf : 1,
        };
        if (isNum(b.pb)) o.pb = b.pb;
        if (isNum(b.nh)) o.nh = b.nh;
        if (isNum(b.nr)) o.nr = b.nr;
        if (isNum(b.n)) o.n = b.n;
        return o;
      });
      const ob = norm(pa.overBuckets);
      OVER_BUCKETS.length = 0;
      ob.forEach((x) => OVER_BUCKETS.push(x));
      const dk = norm(pa.darkToOpen);
      DARK_TO_OPEN.length = 0;
      dk.forEach((x) => DARK_TO_OPEN.push(x));
      Object.assign(AH_LIN, pa.ahLin);
      Object.assign(FLAT, {
        med: pa.flat.med, dLo: pa.flat.dLo, dHi: pa.flat.dHi,
        conf: isNum(pa.flat.conf) ? pa.flat.conf : 1,
        pb: isNum(pa.flat.pb) ? pa.flat.pb : FLAT.pb,
      });
      if (pa.cs) { CS.base = pa.cs.base; CS.k = pa.cs.k; CS.cap = pa.cs.cap; }
      if (isNum(pa.fx)) CFG.fxCNY2HKD = pa.fx;
      EX = p.data.extras;
      if (p.data.ahclose && p.data.ahclose.close) AHC = p.data.ahclose;
      REMOTE_VER = typeof p.v === "string" ? p.v : null;
      return true;
    } catch (e) { return false; }
  }
  function applyRemoteCached(rec) {
    if (!rec || !rec.p) return false;
    return applyRemote(rec.p);
  }
  function remoteInfo() {
    return { ver: REMOTE_VER, urls: REMOTE_URLS.slice(), ttl: REMOTE_TTL };
  }
  // 后台检查更新：force=true 时无视 6 小时 TTL（供界面「立即检查」用）
  function checkRemoteUpdate(force, cb) {
    const done = typeof cb === "function" ? cb : function () {};
    storeGet([REMOTE_KEY], (r) => {
      const rec = r[REMOTE_KEY];
      const now = Date.now();
      if (!force && rec && now - (rec.at || 0) < REMOTE_TTL) {
        done({ skipped: true, ver: REMOTE_VER });
        return;
      }
      let i = 0;
      const tryNext = () => {
        if (i >= REMOTE_URLS.length) { done({ ok: false, err: "所有源均不可用", ver: REMOTE_VER }); return; }
        const url = REMOTE_URLS[i++];
        let req;
        try { req = fetch(url, { cache: "no-store" }); }
        catch (e) { tryNext(); return; }
        Promise.resolve(req)
          .then((res) => {
            if (!res || !res.ok) throw new Error("HTTP " + (res && res.status));
            return res.json();
          })
          .then((payload) => {
            if (!validRemote(payload)) throw new Error("结构校验失败");
            const pack = { at: now, p: payload };
            const o = {};
            o[REMOTE_KEY] = pack;
            storeSet(o, () => {
              const applied = applyRemote(payload);
              done({ ok: applied, ver: REMOTE_VER, fetchedAt: now });
            });
          })
          .catch(() => tryNext());
      };
      tryNext();
    });
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
    gtimgCloseAt: gtimgCloseAt, ahLibRec: ahLibRec, ahBasis: ahBasis,
    // AHC 会被远程数据整体替换，这里必须用 getter，否则导出的是旧引用
    get AH_CLOSE() { return AHC; },
    // 远程参数库
    remoteInfo: remoteInfo, checkRemoteUpdate: checkRemoteUpdate, applyRemote: applyRemote,
    validRemote: validRemote, isNum: isNum,
    get REMOTE_VER() { return REMOTE_VER; },
    get EX() { return EX; },
    loadData: loadData, loadDataCached: loadDataCached,
    // 阶段
    pdate: pdate, todayDate: todayDate, nowHour: nowHour, getStage: getStage, stageNote: stageNote,
    stageFocus: stageFocus,
    allotmentPublished: allotmentPublished, phaseOf: phaseOf, PHASE: PHASE,
    // 模型
    predict: predict, predictS1: predictS1, predictS2: predictS2, predictS3: predictS3,
    stockIssue: stockIssue, ISSUE: ISSUE,
    overBucket: overBucket, overBucketTxt: overBucketTxt, bucketSample: bucketSample, sectorAdj: sectorAdj,
    darkActual: darkActual, firstDayActual: firstDayActual, firstDayOpenActual: firstDayOpenActual,
    sponsorAdj: sponsorAdj, sponsorStats: sponsorStats, sponsorBaseline: sponsorBaseline, exOf: exOf,
    cornerstoneOf: cornerstoneOf, cornerstoneAdj: cornerstoneAdj, greenShoeOf: greenShoeOf,
    ensureGreenShoe: ensureGreenShoe, parseGreenShoeFromText: parseGreenShoeFromText,
    parseGreenShoePdf: parseGreenShoePdf,
    gsErrorKind: gsErrorKind,
    extractPdfText: extractPdfText,
    ahPrem: ahPrem, ahLine: ahLine, AH_LIN: AH_LIN, ahBasis: ahBasis,
    OVER_BUCKETS: OVER_BUCKETS,
    FLAT: FLAT,
    DARK_TO_OPEN: DARK_TO_OPEN,
    CS: CS,
    allotmentRate: allotmentRate,
    factorCatalog: factorCatalog,
  };
})();
