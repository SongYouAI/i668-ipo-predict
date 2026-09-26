/* =========================================================================
 * tools/verify-calc.js —— 计算过程一致性验算（浏览器内运行）
 *
 * 用法（沙箱无法 --load-extension，故注入真实源码后跑）：
 *   1. 打开 i668 列表页，按顺序注入 data/extras.js → core → list → detail → boot
 *   2. cat tools/verify-calc.js | agent-browser eval --stdin
 *
 * 断言 9 类（对全部股票 × 3 阶段，逐个样本）：
 *   ⓪ 导出契约（防"定义了没导出"这类静默失效）
 *   ⓪b 空窗期不得交白卷（v0.4.3 回归守卫）
 *   ⓪c 绿鞋数据合理性（v0.4.3）
 *   ⓪d 就绪门禁（v0.4.4）：样本数低于下限直接判失败 —— 防「0 样本 → ✅ 通过」的假绿灯
 *   ① 价格 ⇄ 涨跌幅 必须严格互推（显示的 % × 发行价 == 显示的价格）
 *   ② lo ≤ hi，无 NaN/Infinity
 *   ③ S2/S3：逐步求和 == 修正后基准
 *   ④ S2/S3：展开区间 == 基准 ± spread
 *   ⑤ S1：最后一个带区间端点的步骤 == 最终区间
 * 任一条不满足即视为"计算过程在糊弄人"，必须修到 0 错误。
 * ========================================================================= */
(() => {
  const P = window.I668P;
  if (!P) return "I668P 未加载";
  const errs = [];
  // ⓪ 导出契约：视图层会用到的 API 必须都在（防「定义了没导出」这类静默失效）
  const need = ["predict","getStage","todayDate","darkActual","firstDayActual","firstDayOpenActual",
    "sponsorAdj","sponsorStats","sponsorBaseline","exOf","factorCatalog","ovGet","ovSet","ovDel","ovAll",
    "fmt","pctTxt","stars","mk","clear","num","clamp","warnOnce","on","emit",
    "allotmentPublished","phaseOf","PHASE","greenShoeOf","cornerstoneOf",
    "ahAdj","ahAnchor","allotmentRate","AH_K","AH_CAP",
    "overBucket","OVER_BUCKETS","ahBucket","AH_BUCKETS","FLAT",
    "KEY_LABEL","KEY_BASIS","STAGE_NAME","STAGE_ORDER","KEY_ORDER","COLS","CFG"];
  const miss = need.filter(k => P[k] === undefined);
  if (miss.length) errs.push(["导出缺失", miss.join(",")]);
  if (!window.I668P_EXTRAS) errs.push(["因子库", "I668P_EXTRAS 未加载"]);

  const d = P.CACHE;
  if (!d || !d.map) return "无缓存数据";
  let nStock = 0, nStage = 0, nSp = 0, nOpen = 0, nAwait = 0, nProv = 0, nGreen = 0, nAH = 0, nRate = 0;
  let nAct = 0, nHit = 0, wSum = 0;   // S2 区间：命中率与平均宽度（老板要的"能用"指标）
  Object.keys(d.map).forEach((code) => {
    const s = d.map[code];
    const st = P.getStage(s, P.todayDate());
    if (st === "UNKNOWN") return;
    const res = P.predict(s, st, d.ctx);
    if (!res || res.unknown) return;
    nStock++;

    // ⓪b 空窗期不得交白卷：相位为 AWAIT 时，S2 必须有值且必须标记 provisional。
    //     —— 这条正是老板实测 06731 踩出来的坑（配售结果公布当天站点仍未录入超购倍数，
    //        S2 整列「—」），加断言锁死，防止以后重构又把它改回去。
    if (res.phase === P.PHASE.AWAIT) {
      nAwait++;
      const r2 = res.s2;
      if (!r2) errs.push([code + "/await", "空窗期 S2 为 null（交白卷）"]);
      else {
        if (r2.provisional !== true) errs.push([code + "/await", "空窗期 S2 未标记 provisional"]);
        if (r2.spread == null || r2.spread <= 0) errs.push([code + "/await", "空窗期 S2 spread 异常", r2.spread]);
        // v0.4.6：置信度改由**区间宽度**决定，且缺超购时封顶 ★★☆（不得宣称最高置信）
        if (r2.conf > 2) errs.push([code + "/await", "空窗期 S2 不得给最高置信", r2.conf]);
      }
    }
    if (res.pending && res.s2 && res.s2.provisional) nProv++;

    // ⓪c 绿鞋合理性：有 → 占比必须在 3–30%（提取命中了别的句子就会越界）；无 → 不该有股数
    const g = P.greenShoeOf(code, s);
    if (g) {
      nGreen++;
      if (g.has && g.pct != null && (g.pct < 3 || g.pct > 30)) errs.push([code + "/green", "绿鞋占比越界", g.pct]);
      if (!g.has && g.shares) errs.push([code + "/green", "无绿鞋却有股数", g.shares]);
      if (g.has && g.pct != null && g.shares == null) errs.push([code + "/green", "有占比无股数"]);
    }

    // ⓪e A+H 折价档必须生效（v0.4.6 改）：
    //    超购缺失（降级）且有 A 股溢价时，S2 的中枢必须来自 **A+H 折价档的中位数**，
    //    步骤里出现「A+H 折价档中枢」，且区间必须落在该档 [P25,P75] 上（不是对称 ±spread）。
    //    —— 老板报「区间那么大等于没预测」的修复点，防重构又改回对称 sd 口径。
    const ahd = P.ahAdj(s, P.CACHE.ctx);
    if (ahd) {
      nAH++;
      if (res.s2) {
        const st = (res.s2.steps || []).find((x) => x.k === "A+H 折价档中枢");
        if (res.s2.provisional) {
          const b = P.ahBucket(ahd.prem);
          if (!st) errs.push([code + "/ah", "降级+A+H 时 S2 缺少「A+H 折价档中枢」", ahd.prem]);
          else if (Math.abs(st.v - b.med) > 0.011) errs.push([code + "/ah", "中枢≠折价档中位数", st.v, b.med]);
          if (res.s2.dLo == null || res.s2.dHi == null) errs.push([code + "/ah", "缺少分位半宽 dLo/dHi"]);
        }
      }
    }
    // 中签率（只展示项）口径自检：有中签人数时不得算出 >100% 或负数
    const rt = P.allotmentRate(s);
    if (rt) {
      nRate++;
      ["all", "a", "b"].forEach((k) => {
        if (rt[k] != null && (rt[k] < 0 || rt[k] > 100)) errs.push([code + "/rate", "中签率越界 " + k, rt[k]]);
      });
    }

    ["s1","s2","s3"].forEach((k) => {
      const r = res[k];
      if (!r) return;
      nStage++;
      const tag = code + "/" + k;
      const ipo = P.num(s.ipo_price);
      if (!ipo) { errs.push([tag, "无发行价"]); return; }
      const loE = Math.round(ipo * (1 + r.loPct / 100) * 1000) / 1000;
      const hiE = Math.round(ipo * (1 + r.hiPct / 100) * 1000) / 1000;
      if (Math.abs(loE - r.lo) > 0.0011) errs.push([tag, "lo≠f(loPct)", r.lo, loE]);
      if (Math.abs(hiE - r.hi) > 0.0011) errs.push([tag, "hi≠f(hiPct)", r.hi, hiE]);
      if (r.lo > r.hi + 1e-9) errs.push([tag, "lo>hi", r.lo, r.hi]);
      if (!isFinite(r.lo) || !isFinite(r.hi)) errs.push([tag, "NaN/Infinity"]);
      if (r.base != null) {
        let sum = 0;
        (r.steps || []).forEach((x) => { if (x.type !== "info" && x.v != null) sum += x.v; });
        if (Math.abs(sum - r.base) > 0.3) errs.push([tag, "步骤求和≠基准", +sum.toFixed(2), r.base]);
        // v0.4.6：区间改为**不对称分位区间** —— 下侧 dLo、上侧 dHi，不再是对称 ±spread。
        // 这三条就是「区间别再做成对称包络」的回归守卫。
        if (r.dLo != null && r.dHi != null) {
          if (Math.abs((r.base - r.dLo) - r.loPct) > 0.11) errs.push([tag, "loPct≠基准−dLo", r.loPct, r.base - r.dLo]);
          if (Math.abs((r.base + r.dHi) - r.hiPct) > 0.11) errs.push([tag, "hiPct≠基准+dHi", r.hiPct, r.base + r.dHi]);
          if (r.dLo <= 0 || r.dHi <= 0) errs.push([tag, "分位半宽必须为正", r.dLo, r.dHi]);
        } else if (r.spread != null) {
          if (Math.abs((r.base - r.spread) - r.loPct) > 0.11) errs.push([tag, "loPct≠基准−spread"]);
          if (Math.abs((r.base + r.spread) - r.hiPct) > 0.11) errs.push([tag, "hiPct≠基准+spread"]);
        }
      } else {
        let last = null;
        (r.steps || []).forEach((x) => { if (x.lo != null) last = x; });
        if (!last) errs.push([tag, "S1 无区间端点步骤"]);
        else {
          if (Math.abs(last.lo - r.loPct) > 0.11) errs.push([tag, "S1 loPct≠末步", last.lo, r.loPct]);
          if (Math.abs(last.hi - r.hiPct) > 0.11) errs.push([tag, "S1 hiPct≠末步", last.hi, r.hiPct]);
        }
      }
      if ((r.steps || []).some(x => x.k === "保荐人战绩")) nSp++;
      if (k === "s3" && P.firstDayOpenActual(s)) nOpen++;
      // v0.4.6：老板的批评是「区间那么大等于没预测」，所以覆盖率与宽度必须一直盯着。
      // 目标：宽度尽量小、命中率贴近名义的 50%（不是越宽越好 —— 旧口径 48pt 却只有 43.6%）。
      if (k === "s2") {
        const act = P.num(s.dark_pool_change_pct);
        if (act != null) {
          nAct++;
          wSum += (r.hiPct - r.loPct);
          if (act >= r.loPct && act <= r.hiPct) nHit++;
        }
      }
    });
  });
  // ⛔ ⓪d 就绪门禁（v0.4.4 加）—— **防"假绿灯"**，这是最危险的一类失败：
  //    注入后立刻跑（插件还没把 /api/ipo-stocks 取回来）会得到
  //    「股票 0 只 / 阶段 0 个 / 错误 0 处」→ 被判成「✅ 全部一致」。
  //    实测已踩：同一条命令一次 0 只、一次 117 只，全看有没有等数据。
  //    → 样本数低于下限一律**判失败**，让"没数据"永远不等于"通过"。
  const MIN_STOCK = 50;    // 实测库内 117 只；低于 50 只只可能是数据没到位 / 因子库丢了
  const MIN_STAGE = 100;   // 117 只 × 3 阶段 ≈ 344
  if (nStock < MIN_STOCK) {
    errs.unshift(["就绪门禁", "有效股票仅 " + nStock + " 只（下限 " + MIN_STOCK + "）"
      + "—— 数据未就绪或因子库丢失，本次结果不可信，请等面板渲染出来再跑"]);
  }
  if (nStage < MIN_STAGE) errs.unshift(["就绪门禁", "阶段样本仅 " + nStage + " 个（下限 " + MIN_STAGE + "）"]);

  const head = "股票 " + nStock + " 只 / 阶段 " + nStage + " 个 / 空窗期 " + nAwait + " 个(预估 " + nProv +
    ") / 保荐人因子 " + nSp + " / 首日开盘 " + nOpen + " / 绿鞋已抓 " + nGreen +
    " / A+H 折价档 " + nAH + " / 中签率 " + nRate + " / 错误 " + errs.length + " 处" +
    (nAct ? "\nS2 区间：平均宽 " + (wSum / nAct).toFixed(1) + " pt，实测命中 " +
      (nHit / nAct * 100).toFixed(1) + "%（n=" + nAct + "，名义 50%）" : "");
  return head + (errs.length
    ? "\n❌ " + errs.length + " 处不一致（前 10 条）:\n" + errs.slice(0, 10).map(e => e.join(" | ")).join("\n")
    : "\n✅ 导出契约 + 计算过程与结果 + 空窗期降级 全部一致");
})()
