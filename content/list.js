/* =========================================================================
 * 港股打新预测 · i668 增强  —  列表页视图（list.js）
 *
 * 职责：在 /stocks 列表页表格**最右追加**四列（实时孖展倍数 + S1/S2/S3 预测），
 *       不改动站点原有列序/列宽/行高。
 * 并把「腾出的宽度」给预测列，实现一屏全见。
 *
 * v0.4.0 变更：
 *  ① 视图层从单文件拆出，模型/存储一律走 window.I668P（core）。
 *  ② 应用「个股覆盖」：你在详情页工坊手动改过的值，这里优先显示并标注「✎ 人工」。
 *     ⚠ 事实优先：暗盘/首日一旦有实测，实测值仍然覆盖人工预测（不让人工预测盖住事实）。
 *  ③ 悬浮摘要卡（替代原生 title）：400ms 后显示「锚 → 修正 → 区间」主线 +
 *     模型未纳入因子 + 引导进详情页工坊，让人一眼判断这个数怎么来的、要不要改。
 *
 * 布局红线（动它之前先读）：
 *  · 四列一律 appendChild 到行尾（表格最右），绝不插到原列之间；
 *  · 先量准并锁死站点原表列宽，**之后**才放开 .app 宽度锁（站点「新股」列是弹性列，
 *    顺序反了它会从 200px 涨到 700px ＝ 改坏原表）；
 *  · 预测格内容 ≤2 行，保证行高 32px → 33px（仅 +1px）。
 * ========================================================================= */
(function () {
  "use strict";
  const P = window.I668P;
  if (!P) { console.warn("[i668p] core 未加载，list 层跳过"); return; }

  const COLS = P.COLS, MIN_COL_W = P.MIN_COL_W, MAX_COL_W = P.MAX_COL_W, MARGIN_COL_W = P.MARGIN_COL_W;
  const WIDE_CLASS = P.WIDE_CLASS, STAGE_ORDER = P.STAGE_ORDER, KEY_ORDER = P.KEY_ORDER;

  let COL_W = 140;          // 当前预测列宽（每轮由 applyWidth 计算写回）
  let ORIG_W = null;        // 站点原表各列宽（原生 960 容器下测得，仅测一次）
  let MO = null;            // MutationObserver（render 期间断开，防自触发）
  let TIMERS = [];          // start 期间创建的定时器，stop 时统一清理
  let STARTED = false;

  /* ---------------------- 定位站点表格 ---------------------- */
  // ⚠️ 只认「新股列表」那一张表：必须命中关键词，**绝不做宽松兜底**。
  //    v0.4.1 曾用「找第一个含 th 的 table」兜底 → 详情页的「甲组/乙组申购档位表」
  //    被误判成新股列表，往里插了三列（界面上表现为详情页多出三列空白）。
  //    教训：宁可不动，也绝不冒险动错表。
  const LIST_HEAD_RE = /新股|招股价|上市日期|入场费/;
  function findTables() {
    for (const b of document.querySelectorAll(".el-table")) {
      const h = b.querySelector(".el-table__header");
      const bd = b.querySelector(".el-table__body");
      if (!h || !bd) continue;
      if (!LIST_HEAD_RE.test(h.textContent || "")) continue;
      const rows = [...bd.querySelectorAll("tr")].filter((r) => r.children.length >= 5);
      if (!rows.length) continue;
      return { header: h, body: bd, block: b };
    }
    return { header: null, body: null, block: null };
  }

  // 列表层只在「新股列表页」工作。详情页（/stocks/<5位代码>）绝不能启动它 ——
  // 否则详情页自己的表格会被误注入（v0.4.1 的真实事故）。
  function isListPage() {
    const p = location.pathname || "";
    return /^\/stocks/.test(p) && !/^\/stocks\/\d{5}/.test(p);
  }

  /* ---------------------- 插列（一律行尾） ---------------------- */
  function insertColsInto(t, keys) {
    const cg = t.querySelector("colgroup");
    if (!cg) return;
    keys.forEach((k) => {
      const col = document.createElement("col");
      col.style.width = (k === "margin" ? MARGIN_COL_W : COL_W) + "px";
      col.setAttribute("data-pred-col", k);
      cg.appendChild(col);
    });
  }
  function clearInjected(header, body) {
    header.querySelectorAll("[data-pred-col]").forEach((n) => n.remove());
    body.querySelectorAll("[data-pred-col]").forEach((n) => n.remove());
    header.querySelectorAll("th[data-pred]").forEach((n) => n.remove());
    body.querySelectorAll("td[data-pred]").forEach((n) => n.remove());
  }

  /* ----- 锁定站点原表列宽 + 延迟放开容器宽度（关键，顺序不可颠倒）-----
     站点「新股」列是**弹性列**（colgroup 里没有固定宽度）。若直接放开 .app 的
     960px 上限，它会自己从 200px 涨到 700px（真机实测）—— 那就是"改坏原表"。
     故顺序必须是：① 趁容器还是原生 960px 时量准各列宽 → ② 把宽度写回表头/表体
     两个 colgroup（inline style 覆盖弹性行为）→ ③ 才给 <html> 加 `i668p-wide`
     放开容器。这样多出来的宽度只会落进预测 3 列，原表分毫不动。 */
  function applyOrigWidths(header, body) {
    if (!ORIG_W) return;
    [header, body].forEach((t) => {
      const cg = t.querySelector("colgroup");
      if (!cg) return;
      const cols = [...cg.children].filter((c) => !c.hasAttribute("data-pred-col"));
      ORIG_W.forEach((w, i) => {
        const c = cols[i];
        if (!c) return;
        const px = w + "px";
        if (c.style.width !== px) c.style.width = px;
      });
    });
  }
  function pinOriginal(header, body) {
    if (ORIG_W) { applyOrigWidths(header, body); return; }
    const row = header.querySelector("tr");
    if (!row) return;
    const ws = [...row.children]
      .filter((t) => !t.hasAttribute("data-pred"))
      .map((t) => Math.round(t.getBoundingClientRect().width));
    const sum = ws.reduce((a, b) => a + b, 0);
    if (ws.length < 5 || sum < 400) return;   // 布局未就绪（列宽还是 0）绝不锁定
    ORIG_W = ws;
    applyOrigWidths(header, body);
    try { document.documentElement.classList.add(WIDE_CLASS); } catch (e) {}
  }
  // 站点「原表宽」= 各原列宽之和。⚠ 不能用 block.clientWidth：容器放宽后它会跟着变大，
  // 再拿它 + 3 列会重复累加、把表越撑越宽。
  function measureBase(header) {
    if (ORIG_W) return ORIG_W.reduce((a, b) => a + b, 0);
    const row = header.querySelector("tr");
    if (!row) return 920;
    let w = 0;
    [...row.children].forEach((t) => { if (!t.hasAttribute("data-pred")) w += t.getBoundingClientRect().width; });
    return Math.round(w) || 920;
  }
  // 列宽自适应 + 表格总宽 = 原表宽 + 孖展窄列 + 3 列预测宽；el-table 的 table 宽度会被 Vue 重置，故每轮重设。
  // v0.8.0：「实时孖展」列改为**固定窄宽**（老板：这一列太宽了）。三列预测列分剩余可用宽度。
  function applyWidth(header, body, block) {
    const base = measureBase(header);
    const n = COLS.length - 1;                       // 三列预测列（孖展列固定窄宽，不参与均分）
    const avail = (block && block.clientWidth) ? block.clientWidth : (base + MARGIN_COL_W + COL_W * n);
    const w = P.clamp(Math.floor((avail - base - MARGIN_COL_W) / n), MIN_COL_W, MAX_COL_W);
    COL_W = w;
    const px = w + "px", mpx = MARGIN_COL_W + "px";
    const setW = (c) => {
      const want = (c.getAttribute("data-pred-col") === "margin") ? mpx : px;
      if (c.style.width !== want) c.style.width = want;
    };
    header.querySelectorAll("col[data-pred-col]").forEach(setW);
    body.querySelectorAll("col[data-pred-col]").forEach(setW);
    const target = (base + MARGIN_COL_W + w * n) + "px";
    if (header.style.width !== target) header.style.width = target;
    if (body.style.width !== target) body.style.width = target;
    return { base: base, colW: w, marginW: MARGIN_COL_W, avail: avail };
  }

  // 幂等：完整则复用（避免每轮重建抖动），不完整则清空重插
  function ensureColumns() {
    const { header, body, block } = findTables();
    if (!header || !body) return { found: false };
    const hRow = header.querySelector("tr");
    if (!hRow) return { found: false };
    const rows = [...body.querySelectorAll("tr")].filter((r) => r.children.length >= 5);
    if (!rows.length) return { found: false };

    const keys = COLS.map((c) => c.key);
    const needTd = rows.length * keys.length;
    const complete = header.querySelectorAll("th[data-pred]").length === keys.length &&
      body.querySelectorAll("td[data-pred]").length === needTd &&
      header.querySelectorAll("col[data-pred-col]").length === keys.length &&
      body.querySelectorAll("col[data-pred-col]").length === keys.length;

    if (!complete) clearInjected(header, body);
    pinOriginal(header, body);   // 必须早于插列：插了列会把表格撑宽，量到的原列宽就不准了
    if (!complete) {
      insertColsInto(header, keys);
      insertColsInto(body, keys);
      COLS.forEach((c) => {
        const el = document.createElement("th");
        el.className = "i668p-th" + (c.key === "margin" ? " is-sortable is-narrow" : "");
        el.setAttribute("data-pred", c.key);
        el.innerHTML = c.title + "<small>" + c.sub + "</small>";
        if (c.key === "margin") el.title = "点击按实时孖展倍数排序（降序 ↔ 升序）\n倍数越高＝市场认购越踊跃＝越值得打、越值得上融资";
        hRow.appendChild(el);
      });
      rows.forEach((r) => {
        COLS.forEach((c) => {
          const el = document.createElement("td");
          el.className = "i668p-td";
          el.setAttribute("data-pred", c.key);
          r.appendChild(el);
        });
      });
    }
    applyWidth(header, body, block);
    return { found: true, rows: rows, reused: complete };
  }

  function parseCode(row) {
    const first = row.children[0];
    if (!first) return null;
    const link = row.querySelector("a[href]");
    if (link) {
      const m = (link.getAttribute("href") || "").match(/(\d{5})/);
      if (m) return m[1];
    }
    const m = (first.textContent || "").match(/\d{5}/);
    return m ? m[0] : null;
  }

  /* ---------------------- 实时孖展倍数（招股期热度） ----------------------
   * 这是老板要的核心信息：**多只新股并行招股时，按实时孖展倍数排序才知道该打哪只**。
   * 申购之后再看到倍数毫无意义 —— 所以要的是「招股期内实时跳变」的值，
   * 不是配售结果公布后的最终超购倍数（那个插件早就有，但那时已经不能用了）。
   *
   * 口径：華盛證券「預計孖展倍數」＝ 券商融资认购(孖展)口径的超购倍数，
   *      是**最终公开发售超购倍数的下界**（只统计该券商渠道）。
   *      与详情页「公开发售超购（配售后最终值）」不是一回事，界面必须各自标注。
   * 取不到就显示「—」并说明原因，**绝不用模型值或任何估算冒充**。 */
  function renderMarginCell(td, code) {
    td.className = "i668p-td";
    td.innerHTML = "";
    td.removeAttribute("title");
    const m = P.marginOf(code);
    const meta = P.marginMeta();
    if (!m) {
      td.classList.add("is-inactive");
      td.title = meta.n
        ? "该股不在孖展源列表中（可能尚未进入招股或已下架）"
        : "实时孖展倍数未取到：" + (meta.err || "孖展源不可用") + "。\n" +
          "倍数是招股期决策的核心信息，插件不会用估算值替代 —— 请直接看券商 App。";
      return putText(td, "—", "i668p-invalid");
    }
    const cell = document.createElement("div");
    cell.className = "i668p-cell";
    const v = document.createElement("div");
    v.className = "i668p-margin " + P.marginTier(m.m);
    v.textContent = (m.m >= 100 ? Math.round(m.m) : Math.round(m.m * 100) / 100) + "倍";
    cell.appendChild(v);
    td.appendChild(cell);
    td.classList.add("is-margin");
    td.title = "实时孖展倍数 " + m.m + " 倍\n" +
      "联动：右侧「招股期预测 S1」已用本倍数作热度锚 → 落 " + P.overBucketTxt(m.m) +
      " 档，倍数一动、S1 区间跟着动\n" +
      "口径：華盛證券「預計孖展倍數」＝ 券商融资认购(孖展)口径的超购倍数，招股期内实时跳变\n" +
      "含义：倍数越高＝市场认购越踊跃＝热度越高，值得打、值得上融资\n" +
      "边界：它是**最终公开发售超购倍数的下界**（只统计该券商渠道），与下方「公开发售超购（配售后最终值）」口径不同，不可直接比较\n" +
      "数据源：華盛證券公开页" + (meta.src === "tradesmart" ? "（备源：第三方校准估算值）" : "") +
      " · 更新于 " + (meta.t ? new Date(meta.t).toLocaleString("zh-CN") : "—");
  }

  /* ---------------------- 按孖展倍数排序 ----------------------
   * 老板的原话：「公司多的时候要知道哪一个实时倍数最高」。
   * 只在用户点了列头之后才动行序（默认保持站点原序，避免一进页面就找不到熟悉的行）。
   * 排序是把 <tr> 在 tbody 内重排 —— Vue 重建表格后由 render() 末尾自动重排复原。 */
  let SORT = null;          // null | "desc" | "asc"
  function sortedRows() {
    if (!SORT) return;
    const { body } = findTables();
    if (!body) return;
    const all = [...body.querySelectorAll("tr")];
    const rows = all.filter((r) => r.children.length >= 5);
    const others = all.filter((r) => r.children.length < 5);
    const keyed = rows.map((r) => {
      const code = parseCode(r);
      const m = code ? P.marginOf(code) : null;
      return { r: r, m: m ? m.m : null };
    });
    keyed.sort((a, b) => {
      if (a.m == null && b.m == null) return 0;
      if (a.m == null) return 1;                 // 没有孖展数据的沉底
      if (b.m == null) return -1;
      return SORT === "asc" ? a.m - b.m : b.m - a.m;
    });
    keyed.forEach((k) => body.appendChild(k.r));
    others.forEach((r) => body.appendChild(r));
  }
  function updateSortUI() {
    const th = document.querySelector('th[data-pred="margin"]');
    if (!th) return;
    let a = th.querySelector(".i668p-sortarrow");
    if (!a) {
      a = document.createElement("span");
      a.className = "i668p-sortarrow";
      th.appendChild(a);
    }
    a.textContent = SORT === "desc" ? " ↓" : (SORT === "asc" ? " ↑" : " ⇅");
    th.classList.toggle("is-sorted", !!SORT);
  }

  /* ---------------------- 单元格渲染 ---------------------- */
  function putText(td, text, cls) {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    td.appendChild(d);
  }
  // 单行高优先：站点原始行高仅 32px，故预测格只渲染「价格 + 副行」两行。
  // opts: { note, tone, manual, prov }
  // ⚠️ 任何新增内容都必须塞进这**两行**里 —— 撑成三行就是改坏站点原表的行高。
  function drawValue(td, p, opts) {
    opts = opts || {};
    const cell = document.createElement("div");
    cell.className = "i668p-cell";
    // v0.4.6：老板的批评「区间那么大等于没有预测」同样适用于列表页 ——
    // 首行改为**中枢（最可能落点）** + 对应价格，区间降到第二行。仍严格保持 2 行、不撑高行高。
    const price = document.createElement("div");
    price.className = "i668p-price" + (p.base != null ? " is-mid" : "");
    if (p.base != null && !opts.note && !opts.manual) {
      // 发行价由「区间下沿价格 ÷ (1 + 下沿涨幅)」反推（与 core 的量化口径同源，保证互推一致）
      const ipo = p.loPct != null ? p.lo / (1 + p.loPct / 100) : 0;
      price.textContent = "中枢 " + P.pctTxt(p.base, 1) +
        (ipo > 0 ? " · " + P.fmt(ipo * (1 + p.base / 100)) : "");
    } else {
      price.textContent = Math.abs(p.hi - p.lo) > 0.001 ? P.fmt(p.lo) + "\u2013" + P.fmt(p.hi) : P.fmt(p.lo);
    }
    cell.appendChild(price);

    let cls = "", txt = "", prov = false;
    if (opts.note) {                                    // 实测标注（实测暗盘 / 实测首日）
      cls = "i668p-note" + (opts.tone ? " is-" + opts.tone : "");
      txt = opts.note;
    } else if (opts.manual) {                           // 人工设定：星级别无意义，改标来源
      const lp = p.loPct >= 0 ? "+" : "";
      const hp = p.hiPct >= 0 ? "+" : "";
      cls = "i668p-note is-manual";
      txt = "\u270e " + lp + p.loPct + "%~" + hp + p.hiPct + "%";
    } else if (p.loPct != null) {                       // 模型预测：涨跌幅 + 置信度星级
      const lp = p.loPct >= 0 ? "+" : "";
      const hp = p.hiPct >= 0 ? "+" : "";
      cls = "i668p-pct";
      txt = lp + p.loPct + "%~" + hp + p.hiPct + "%" + (p.conf != null ? " " + P.stars(p.conf) : "");
      prov = !!opts.prov;
    }
    if (txt) {
      const sub = document.createElement("div");
      sub.className = cls;
      sub.textContent = txt;
      if (prov) {                                       // 降级估算标记：同一行内追加，不新增行
        const g = document.createElement("span");
        g.className = "i668p-prov";
        g.textContent = "预";
        sub.appendChild(document.createTextNode(" "));
        sub.appendChild(g);
      }
      cell.appendChild(sub);
    }
    td.appendChild(cell);
  }

  // 列状态语义：未到阶段「—」/ 已过阶段「灰显保留数值」/ 当前阶段「高亮」/ 数据未出「待公布」
  function renderCell(td, res, key, stage, stock, code) {
    td.className = "i668p-td";
    td.innerHTML = "";
    td.removeAttribute("title");
    const st = STAGE_ORDER[stage] || 0;
    const ko = KEY_ORDER[key];
    const ov = P.ovGet(code, key);
    td.__i668p = { code: code, key: key, stage: stage, stock: stock, res: res, ov: ov };

    // 不适用（延期 / 搁置 / 无公开发售）：这不是"待公布"，是这件事根本不会发生 ——
    // 必须明确区分，否则一行「待公布」会让人以为过两天就有数。
    // 放在「无日期」之前：介绍上市本就没有招股/暗盘日期，说成「无日期」会误导。
    if (res && res.blocked) {
      td.classList.add("is-inactive");
      td.title = res.blocked.why;
      return putText(td, res.blocked.label, "i668p-invalid");
    }
    if (!st) { td.classList.add("is-inactive"); return putText(td, "无日期", "i668p-invalid"); }
    // ⚠️ v0.4.8：「当前 / 已过」按**时间相位**判定，不只看数据阶段（详见 core.stageFocus）。
    //    空窗期（招股已截止、配售结果未公布）时 stage 仍是 S1，但招股期其实已经过去 ——
    //    S1 列不能继续高亮成「当前阶段」（老板实测 03757：9/26 打开时 S1 仍高亮）。
    const foc = P.stageFocus(stock, P.todayDate());
    // ⚠️ 空窗期例外（v0.4.3 关键修复）：招股已截止、配售结果尚未公布时，S2 虽"未到阶段"，
    //    但用户此刻**已经知道自己中签了**，最需要的正是这个数。原实现走下面 `ko > st`
    //    分支直接画「—」，界面上看起来像"插件没算"（老板实测 06731 本末科技）。
    //    现改为：给出降级估算值 + 「预」标记 + 悬浮说明；配售结果公布后自动变正式值。
    const prov = !!(res && res.pending && res.s2 && res.s2.provisional);
    if (key === "s2" && prov && !ov) {                  // 人工设定优先于模型（含预估值）
      td.classList.add("is-prov");
      td.title = "空窗期预估：招股已截止，但配售结果（公开超购倍数）站点尚未公布 " +
        "—— 本值为降级估算（基准取中性 0%、区间放宽到 \u00b130%，未使用超购因子），只能看方向。" +
        "配售结果公布后会自动按完整模型重算。";
      return drawValue(td, res.s2, { prov: true });
    }
    if (ko > st) {                                      // 未来阶段：尚未开始
      td.classList.add("is-inactive");
      if (ov) td.title = "该阶段尚未开始（你已预设 " + P.fmt(ov.lo) + "\u2013" + P.fmt(ov.hi) + "，到阶段后生效）";
      return putText(td, "\u2014", "i668p-invalid");
    }
    // ⚠ 事实优先：暗盘已结束（S3 18:30 后 / LISTED）→ 第 2 列改显站点记录的暗盘实际价。
    //   人工预测不得盖住既成事实；你的设定仍保留在工坊里可对比复盘。
    if (key === "s2" && st >= 3) {
      const a = P.darkActual(stock);
      td.classList.add("is-inactive");
      if (a) {
        td.title = "暗盘实际收盘价（发行价 \u00d7 (1" + P.pctTxt(a.pct) + ")，站点口径为暗盘收盘价、非开盘价）";
        return drawValue(td, { lo: a.price, hi: a.price }, { note: "实测暗盘 " + P.pctTxt(a.pct), tone: a.pct >= 0 ? "up" : "down" });
      }
      td.title = "站点暂无该股暗盘数据";
      return putText(td, stage === "LISTED" ? "\u2014" : "待公布", "i668p-invalid");
    }
    if (stage === "LISTED" && key === "s3") {           // 已上市：第 3 列改显实测首日
      // ⚠️ 口径修正：S3 的预测标的是**首日开盘价**，所以实测优先用开盘口径
      //    （来自 etnet 免费公开页「首日開市升跌」）；取不到才回退 i668 的收盘价，
      //    且两种口径在界面上分别标注 —— 不把开盘和收盘混为一谈。
      const o = P.firstDayOpenActual(stock);
      const f = P.firstDayActual(stock);
      td.classList.add("is-inactive");
      if (o) {
        td.title = "上市首日开盘价 = 发行价 × (1" + P.pctTxt(o.pct) + ")；数据源 etnet 公开页「首日開市升跌」";
        return drawValue(td, { lo: o.price, hi: o.price }, { note: "实测首日开盘 " + P.pctTxt(o.pct), tone: o.pct >= 0 ? "up" : "down" });
      }
      if (f) {
        td.title = "上市首日收盘价（i668 站点口径，非开盘价；etnet 未收录该股开盘价）";
        return drawValue(td, { lo: f.price, hi: f.price }, { note: "实测首日收盘 " + P.pctTxt(f.pct), tone: f.pct >= 0 ? "up" : "down" });
      }
      return putText(td, "已上市", "i668p-invalid");
    }
    // —— 人工覆盖优先于模型 ——
    if (ov) {
      const p = { lo: ov.lo, hi: ov.hi, loPct: ov.loPct, hiPct: ov.hiPct };
      td.classList.add(foc.key !== key ? "is-inactive" : "is-active", "is-manual");
      td.title = "人工设定（" + (ov.ts ? new Date(ov.ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—") + "）" +
        (ov.note ? "：" + ov.note : "") + "　\u2014\u2014 到详情页「预测工坊」可修改或恢复模型值";
      return drawValue(td, p, { manual: true });
    }
    const p = res[key];
    if (!p) {                                           // 阶段已到，数据未公布
      td.classList.add("is-inactive");
      td.title = "该阶段数据尚未公布";
      return putText(td, "待公布", "i668p-invalid");
    }
    // 「已过阶段」不只是 ko<st：还包括空窗期里**已经结束的招股期**（foc.key 已指向别列）。
    // 两者界面语义相同 —— 数值保留、置灰、仅作回溯，绝不与「当前阶段」混淆。
    if (ko < st || foc.key !== key) {
      td.classList.add("is-inactive");
      td.title = ko < st
        ? "该阶段已失效，数值仅作回溯参考"
        : "招股期已截止，该值仅作回溯参考（当前焦点已转到中签后预估）";
      return drawValue(td, p, {});
    }
    td.classList.add("is-active");                      // 当前阶段
    td.title = "当前阶段预测（悬浮看计算过程；点进详情页可手动改价）";
    return drawValue(td, p, {});
  }

  /* ---------------------- 悬浮摘要卡 ---------------------- */
  let TIP = null, tipTimer = null, tipHideTimer = null;

  function tipNode() {
    if (!TIP) {
      TIP = document.createElement("div");
      TIP.id = "i668p-tip";
      document.body.appendChild(TIP);
    }
    return TIP;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    clearTimeout(tipHideTimer);
    if (TIP) TIP.style.display = "none";
  }
  // 移出后短延时隐藏：鼠标在相邻格子间移动时会先 out 再 over，
  // 若立即隐藏会出现闪烁，故留 120ms 让随后的 over 取消它。
  function hideTipSoon() {
    clearTimeout(tipTimer);
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(hideTip, 120);
  }
  function line(parent, left, right, cls) {
    const r = document.createElement("div");
    r.className = "i668p-tip-row" + (cls ? " " + cls : "");
    const a = document.createElement("span"); a.className = "i668p-tip-k"; a.textContent = left;
    const b = document.createElement("span"); b.className = "i668p-tip-v"; b.textContent = right == null ? "" : right;
    r.appendChild(a); r.appendChild(b);
    parent.appendChild(r);
    return r;
  }
  function buildTip(td) {
    const d = td.__i668p;
    if (!d) return false;
    const t = tipNode();
    t.innerHTML = "";
    const head = document.createElement("div");
    head.className = "i668p-tip-h";

    // ① 原始 title 语义（未到阶段 / 待公布 / 已失效）——直接透传，不编造
    if (td.classList.contains("i668p-invalid")) {
      head.textContent = td.title || "暂无数据";
      t.appendChild(head);
      if (d.ov) line(t, "你的预设", P.fmt(d.ov.lo) + "\u2013" + P.fmt(d.ov.hi) + (d.ov.note ? "（" + d.ov.note + "）" : ""));
      return true;
    }
    // ② 实测（暗盘 / 首日）
    if (td.querySelector(".i668p-note.is-up, .i668p-note.is-down")) {
      head.textContent = "实测数据 \u00b7 非预测";
      t.appendChild(head);
      line(t, "口径", td.title || "");
      const pre = d.ov;
      if (pre) {
        line(t, "你在 " + d.key.toUpperCase() + " 的设定", P.fmt(pre.lo) + "\u2013" + P.fmt(pre.hi) + (pre.note ? "（" + pre.note + "）" : ""), "is-warn");
        line(t, "结论", "实测优先，你的设定未采纳（工坊内可对比）", "is-dim");
      }
      const box = document.createElement("div");
      box.className = "i668p-tip-foot";
      box.textContent = "事实不给预测：已发生的数据一律以站点记录为准。";
      t.appendChild(box);
      return true;
    }
    // ②b 空窗期预估（降级估算）—— 必须排在「人工设定」之前判断，否则会被误读成模型正式值
    if (td.classList.contains("is-prov")) {
      const r = d.res && d.res.s2;
      const g = P.greenShoeOf(d.code, d.stock);
      head.textContent = "\u25d0 空窗期预估 \u00b7 中签后预测";
      t.appendChild(head);
      line(t, "为什么是预估", "招股已截止，但配售结果（公开超购倍数）站点尚未公布", "is-warn");
      line(t, "缺了什么", "S2 份量最重的「超购分档基准」用不上 \u2192 基准改取中性 0%、区间放宽到 \u00b130%、置信度 ★☆☆", "is-warn");
      if (r) {
        if (r.anchor) line(t, "锚", r.anchor.txt + " \u00b7 " + r.anchor.k, "is-strong");
        const aK = r.anchor ? r.anchor.k : "";
        (r.steps || [])
          .filter((s) => s.v != null && s.k !== aK && !/\u951a/.test(s.k))
          .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
          .slice(0, 3)
          .forEach((s) => line(t, s.k, P.pctTxt(s.v, 1)));
        line(t, "预估区间", P.fmt(r.lo) + "\u2013" + P.fmt(r.hi) + "（" + P.pctTxt(r.loPct) + " ~ " + P.pctTxt(r.hiPct) + "）", "is-strong");
      }
      if (g) line(t, "超额配股权", g.has ? "有（绿鞋）" + (g.pct != null ? " · " + g.pct + "%" : "") : "无", g.has ? "" : "is-dim");
      const box0 = document.createElement("div");
      box0.className = "i668p-tip-foot";
      box0.textContent = "配售结果公布后会自动按完整模型重算。只看方向，别当精准区间用。";
      t.appendChild(box0);
      return true;
    }
    // ③ 人工设定
    if (d.ov) {
      const p = P.num(d.stock.ipo_price);
      head.textContent = "\u270e 人工设定 \u00b7 " + (P.KEY_LABEL[d.key] || d.key);
      t.appendChild(head);
      line(t, "发行价", p != null ? P.fmt(p) : "—");
      line(t, "你的区间", P.fmt(d.ov.lo) + "\u2013" + P.fmt(d.ov.hi), "is-strong");
      line(t, "对应涨跌", P.pctTxt(d.ov.loPct) + " ~ " + P.pctTxt(d.ov.hiPct), "is-strong");
      if (d.ov.note) line(t, "备注", d.ov.note);
      line(t, "设定时间", d.ov.ts ? new Date(d.ov.ts).toLocaleString("zh-CN") : "—", "is-dim");
      const box = document.createElement("div");
      box.className = "i668p-tip-foot";
      box.textContent = "覆盖了模型值。到详情页「预测工坊」可修改或恢复。";
      t.appendChild(box);
      return true;
    }
    // ④ 模型预测：主线 = 锚 → 修正 → 区间
    const r = d.res && d.res[d.key];
    if (!r) return false;
    // 「当前阶段」按时间相位判定（见 core.stageFocus），不再靠 CSS class —— 空窗期的 S2
    // 是 is-prov（预估）而非 is-active，可它正是**当前**焦点，悬浮头不能说成「已过阶段」。
    const foc = P.stageFocus(d.stock, P.todayDate());
    const isNow = !!(foc && foc.key === d.key);
    head.textContent = (isNow
      ? (foc.provisional ? "\u25cf 当前阶段（预估值） \u00b7 " : "\u25cf 当前阶段 \u00b7 ")
      : "\u25cb 已过阶段 \u00b7 ") + (P.KEY_LABEL[d.key] || d.key);
    t.appendChild(head);
    line(t, "标的", P.KEY_BASIS[d.key] || "", "is-dim");
    if (r.anchor) line(t, "锚", r.anchor.txt + " \u00b7 " + r.anchor.k, "is-strong");
    // 绿鞋：老板要求必须展示。它不入权重，但直接决定首日有没有官方托价 —— 悬浮即见。
    const gg = P.greenShoeOf(d.code, d.stock);
    if (gg) line(t, "超额配股权", gg.has ? "有（绿鞋）" + (gg.pct != null ? " · " + gg.pct + "%" : "") : "无", gg.has ? "" : "is-dim");
    // 摘要只给「有数值且对结果影响最大」的 3 步：过滤纯描述行，并跳过已在上方
    // 「锚」行展示过的锚类步骤（否则同一因子会重复出现两遍，像两个不同结论）。
    const aK = r.anchor ? r.anchor.k : "";
    (r.steps || [])
      .filter((s) => s.v != null && s.k !== aK && !/\u951a/.test(s.k))
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
      .slice(0, 3)
      .forEach((s) => line(t, s.k, P.pctTxt(s.v, 1)));
    line(t, "预测区间", P.fmt(r.lo) + "\u2013" + P.fmt(r.hi) + "（" + P.pctTxt(r.loPct) + " ~ " + P.pctTxt(r.hiPct) + "）", "is-strong");
    line(t, "置信度", P.stars(r.conf) + "（" + (r.conf >= 3 ? "较高" : r.conf === 2 ? "中等" : "偏低") + "）");
    // v0.8.0：S1 用了实时孖展当热度锚 → 必须把口径与「未标定」摆在明面上，
    //   否则一个 ★☆☆ 的窄区间会被当成精确预测。
    if (d.key === "s1" && r.margin != null) {
      line(t, "热度锚口径", "实时孖展 " + r.margin + " 倍（券商融资认购口径，为最终公开发售超购倍数的下界）", "is-warn");
      line(t, "未标定", "孖展→暗盘 映射无历史样本可标定，只保证档位单调，置信封顶 ★★☆", "is-warn");
    }
    const miss = (P.factorCatalog().missing || []).slice(0, 3).map((m) => m.k).join(" / ");
    if (miss) line(t, "模型未纳入", miss, "is-warn");
    const box = document.createElement("div");
    box.className = "i668p-tip-foot";
    box.textContent = "点这一格进详情页 \u2192 「预测工坊」：看完整计算过程、手动改价。";
    t.appendChild(box);
    return true;
  }
  function placeTip(td) {
    const r = td.getBoundingClientRect();
    const t = tipNode();
    const w = t.offsetWidth || 340, h = t.offsetHeight || 200;
    let left = P.clamp(r.left, 8, Math.max(8, innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    t.style.left = Math.round(left) + "px";
    t.style.top = Math.round(top) + "px";
  }
  function scheduleTip(td) {
    clearTimeout(tipTimer);
    clearTimeout(tipHideTimer);   // ⚠ 必须清掉待执行的隐藏，否则 120ms 后会把本次显示取消
    tipTimer = setTimeout(() => {
      if (!td.isConnected) return;
      if (!buildTip(td)) return;
      const t = tipNode();
      t.style.display = "block";
      placeTip(td);
    }, 400);
  }

  /* ---------------------- 渲染主循环 ---------------------- */
  function render() {
    if (!isListPage()) return { found: false, rows: 0, filled: 0, skipped: true };  // 路径守卫
    if (MO) MO.disconnect();
    let out = { found: false, rows: 0, filled: 0, errs: P.ERRS.length, manual: 0 };
    try {
      const info = ensureColumns();
      if (info.found) {
        const tdToday = P.todayDate();
        let filled = 0, manual = 0;
        info.rows.forEach((r) => {
          const code = parseCode(r);
          const stock = code ? P.CACHE.map[code] : null;
          if (!stock) return;
          let stage, res;
          try { stage = P.getStage(stock, tdToday); res = P.predict(stock, stage, P.CACHE.ctx); }
          catch (e) { P.warnOnce("predict " + code, e); return; }
          COLS.forEach((c) => {
            const el = r.querySelector('[data-pred="' + c.key + '"]');
            if (!el) return;
            try {
              // 孖展列不是模型预测，单独渲染（没有阶段语义，也不参与 S1/S2/S3 判定）
              if (c.key === "margin") {
                renderMarginCell(el, code);
                filled++;
                return;
              }
              renderCell(el, res, c.key, stage, stock, code);
              if (el.classList.contains("is-manual")) manual++;
              filled++;
            } catch (e) {
              P.warnOnce("cell " + c.key + " " + code, e);
              el.className = "i668p-td is-inactive";
              el.innerHTML = "";
              putText(el, "!", "i668p-invalid");
            }
          });
        });
        out = { found: true, rows: info.rows.length, filled: filled, manual: manual, errs: P.ERRS.length };
      }
    } catch (e) {
      P.warnOnce("render", e);
      out.errs = P.ERRS.length;
    } finally {
      // 排序态：Vue 重建表格后把行序复原。必须在 MO 重新 observe **之前**做 ——
      // 否则这次 DOM 变更会被 observer 当成「结构变化」，再触发一轮 render（自触发环）。
      updateSortUI();
      if (SORT) sortedRows();
      if (MO) MO.observe(document.body, { childList: true, subtree: true });
    }
    return out;
  }

  /* ---------------------- 浮条 ---------------------- */
  function bar(status) {
    let b = document.getElementById("i668p-bar");
    if (!b) {
      b = document.createElement("div");
      b.id = "i668p-bar";
      const s = document.createElement("span");
      s.className = "i668p-status";
      s.id = "i668p-status";
      b.appendChild(s);
      const btn = document.createElement("button");
      btn.textContent = "重算";
      btn.onclick = () => run(true);
      b.appendChild(btn);
      document.body.appendChild(b);
    }
    const sp = document.getElementById("i668p-status");
    if (sp) sp.textContent = status || "";
    return sp;
  }
  function rowSignature() {
    const { body } = findTables();
    if (!body) return "";
    return body.querySelectorAll("tr").length + "/" + document.querySelectorAll("[data-pred]").length;
  }

  async function run(manual) {
    if (!isListPage()) return;      // 路径守卫：详情页不取数、不画浮条
    const st = bar(manual ? "重算中\u2026" : "加载预测中\u2026");
    try {
      P.CACHE = await P.loadDataCached(manual);
      // 实时孖展倍数：独立数据源（跨域券商公开页，走 background），失败不影响主流程
      await P.loadMargin(manual);
      const r = render();
      const cnt = Object.keys(P.CACHE.map).length;
      const env = P.CFG.liveMarket && P.CACHE.ctx.hsi != null ? "恒指 " + P.CACHE.ctx.hsi.toFixed(2) + "%" : "行情未启用";
      const errN = (r && r.errs) || 0;
      const mm = P.marginMeta();
      // 最热的一只：老板要的就是「哪只倍数最高」，直接摆在浮条上
      let hot = "";
      if (mm.n) {
        const arr = Object.keys(P.CACHE.map)
          .map((c) => ({ c: c, m: P.marginOf(c) }))
          .filter((x) => x.m)
          .sort((a, b) => b.m.m - a.m.m);
        if (arr.length) {
          const h = arr[0];
          const nm = (P.CACHE.map[h.c] && P.CACHE.map[h.c].stock_name) || h.c;
          hot = " \u00b7 最热 " + h.c + " " + nm + " " +
            (h.m.m >= 100 ? Math.round(h.m.m) : Math.round(h.m.m * 100) / 100) + "倍";
        }
      }
      st.textContent = r.found
        ? "已注入 " + r.rows + " 行 \u00d7 " + COLS.length + " 列 \u00b7 样本 " + cnt + " 只 \u00b7 " + env +
          (mm.n ? " \u00b7 孖展 " + mm.n + " 只" + hot : (mm.err ? " \u00b7 孖展未取到" : "")) +
          (r.manual ? " \u00b7 \u270e 人工设定 " + r.manual + " 格" : "") +
          (errN ? " \u00b7 \u26a0 " + errN + " 类异常" : "")
        : "未匹配到新股表格（页面结构可能已变化）";
      st.title = "数据来源 i668 /api/ipo-stocks；行情 腾讯 gtimg；实时孖展 华盛证券公开页（融资认购口径，招股期实时跳变）。" +
        "点「实时孖展」列头可按倍数排序。悬浮预测格看计算过程，点进详情页可手动改价。仅供研究，非投资建议。";
    } catch (e) {
      const r2 = render();
      st.textContent = "数据获取失败：" + e.message + (r2 && r2.found ? "（沿用上次数据）" : "（刷新重试）");
    }
  }

  /* ---------------------- 启动 / 停止 ---------------------- */
  let overHandler = null, outHandler = null, scrollHandler = null, headHandler = null;

  function start() {
    if (STARTED) return;
    if (!isListPage()) return;      // 详情页绝不启动列表层
    STARTED = true;

    // 悬浮摘要（事件委托：td 是动态创建的）
    overHandler = (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const td = t.closest("td[data-pred]");
      if (td) scheduleTip(td); else hideTipSoon();
    };
    outHandler = (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("td[data-pred]")) hideTipSoon();
    };
    scrollHandler = () => hideTip();
    document.addEventListener("mouseover", overHandler, true);
    document.addEventListener("mouseout", outHandler, true);
    window.addEventListener("scroll", scrollHandler, true);
    // 列头点击 → 按孖展倍数排序（事件委托：th 会被重建，绑在元素上会丢）
    headHandler = (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const th = t.closest('th[data-pred="margin"]');
      if (!th) return;
      SORT = SORT === "desc" ? "asc" : "desc";
      updateSortUI();
      sortedRows();
    };
    document.addEventListener("click", headHandler, true);

    run(false);

    // 行结构变化 → 重渲染（Vue 重建表格时自愈）；200ms 防抖 + 签名比对防自触发
    let to = null, lastSig = "";
    MO = new MutationObserver(() => {
      clearTimeout(to);
      to = setTimeout(() => {
        const sig = rowSignature();
        if (sig !== lastSig) { lastSig = sig; render(); }
      }, 500);
    });
    MO.observe(document.body, { childList: true, subtree: true });

    let rz = null;
    const onResize = () => { clearTimeout(rz); rz = setTimeout(() => render(), 150); };
    window.addEventListener("resize", onResize);

    const timer = setInterval(() => run(false), 5 * 60 * 1000);
    const onFocus = () => run(false);
    window.addEventListener("focus", onFocus);

    TIMERS.push({ clear: () => clearInterval(timer) });
    TIMERS.push({ clear: () => window.removeEventListener("resize", onResize) });
    TIMERS.push({ clear: () => window.removeEventListener("focus", onFocus) });
  }

  function stop() {
    if (!STARTED) return;
    STARTED = false;
    hideTip();
    if (MO) { MO.disconnect(); MO = null; }
    TIMERS.forEach((t) => { try { t.clear(); } catch (e) {} });
    TIMERS = [];
    if (overHandler) document.removeEventListener("mouseover", overHandler, true);
    if (outHandler) document.removeEventListener("mouseout", outHandler, true);
    if (scrollHandler) window.removeEventListener("scroll", scrollHandler, true);
    if (headHandler) document.removeEventListener("click", headHandler, true);
    overHandler = outHandler = scrollHandler = headHandler = null;
    // 清理：直接全文档扫，不依赖 findTables —— SPA 切换后页面上可能已经是另一张表，
    // 按表清理会漏掉（v0.4.1「详情页残留三列」就是这个原因）。
    document.querySelectorAll("[data-pred-col], th[data-pred], td[data-pred]").forEach((n) => n.remove());
    try { document.documentElement.classList.remove(WIDE_CLASS); } catch (e) {}
    const b = document.getElementById("i668p-bar");
    if (b) b.remove();
    if (TIP) { TIP.remove(); TIP = null; }
    ORIG_W = null;
  }

  // 人工设定被改动时立即重渲染：来源可能是本页工坊，也可能是另一个标签页
  // （core 监听了 chrome.storage.onChanged 并 emit）。模块只加载一次 → 只注册一次。
  P.on((ev) => { if (ev === "store" && STARTED) render(); });

  P.list = { start: start, stop: stop, render: render, run: run, findTables: findTables };
})();
