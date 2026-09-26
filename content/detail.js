/* =========================================================================
 * 港股打新预测 · i668 增强  —  详情页「预测工坊」（detail.js）
 *
 * 挂在 /stocks/<5位代码> 详情页（站点自有「基本信息 / 时间安排 / 申购档位」卡片区）。
 * 为什么不做在列表格子上：站点点击事件绑在整行 tr 上（实测点任意格都跳详情），
 * 在格子里做编辑就必须拦掉冒泡 ＝ 剥夺站点原有的「点整行进详情」；且站点行高仅
 * 32px，塞输入控件必然把整表撑高（＝ 改坏原表）。详情页有 920px 宽、统一样式的
 * card 区，是唯一自然的位置。
 *
 * 工坊五块：
 *  ① 三阶段预测卡（含状态：当前 / 已过 / 未到 / 待公布 / 已实测）
 *  ② 计算过程：逐项拆开每一步的增量与理由（可解释）
 *  ③ 模型因子：已纳入 8 项 + 只展示 2 项（不入权重）+ 未纳入 2 项及原因
 *  ④ 招股书数据：基石配售 + 超额配股权（绿鞋，老板要求必须展示）
 *  ⑤ 手动改价：区间（可填价格或涨跌幅）+ 备注；事实（暗盘/首日）只读不可改
 * ========================================================================= */
(function () {
  "use strict";
  const P = window.I668P;
  if (!P) { console.warn("[i668p] core 未加载，detail 层跳过"); return; }

  let ROOT = null;            // 工坊根节点
  let MOUNT_FOR = "";         // 当前已挂载的股票代码
  let COLLAPSED = false;
  let BOUND = false;          // P.on 只注册一次
  const ST = { code: "", stock: null, res: null, stage: "", phase: "", sig: "", editing: "", msg: "", loading: false, failed: "" };

  function codeOf() {
    const m = String(location.pathname || "").match(/\/stocks\/(\d{5})/);
    return m ? m[1] : null;
  }
  function q(sel, root) { return (root || ROOT || document).querySelector(sel); }

  /* ---------------------- 挂载点：站点详情页的卡片区 ---------------------- */
  // 挂载点：直接挂到站点根容器 .app 内。
  // ⚠️ 宽屏时由 CSS 把工坊 fixed 停靠到**右侧空白区**（老板明确要求"右侧有大片空白可用"），
  //    这样工坊不占文档流、不把站点内容往下推、也不改变站点内容的结构与宽度；
  //    窄屏时由 CSS 让它回到文档流、插在内容最上方。
  function findMount() {
    return document.querySelector(".app") || document.body;
  }

  /* ---------------------- 输入解析：价格或涨跌幅 ---------------------- */
  function parseInput(raw, ipo) {
    let s = String(raw == null ? "" : raw).trim().replace(/[，,\s]/g, "");
    if (!s) return null;
    const isPct = /%$/.test(s);
    if (isPct) s = s.replace(/%$/, "");
    const v = parseFloat(s);
    if (isNaN(v)) return null;
    if (isPct) {
      if (v <= -100) return null;
      return { price: Math.round(ipo * (1 + v / 100) * 1000) / 1000, pct: v };
    }
    if (v <= 0) return null;
    return { price: Math.round(v * 1000) / 1000, pct: (v / ipo - 1) * 100 };
  }

  /* ---------------------- 小组件 ---------------------- */
  function card(cls) { return P.mk("div", "i668p-ws-card" + (cls ? " " + cls : "")); }
  function kv(parent, k, v, cls) {
    const row = P.mk("div", "i668p-ws-kv" + (cls ? " " + cls : ""));
    row.appendChild(P.mk("span", "i668p-ws-kk", k));
    row.appendChild(P.mk("span", "i668p-ws-vv", v == null ? "—" : String(v)));
    parent.appendChild(row);
    return row;
  }
  function secTitle(parent, text, sub) {
    const h = P.mk("div", "i668p-ws-sec");
    h.appendChild(P.mk("span", "i668p-ws-sec-t", text));
    if (sub) h.appendChild(P.mk("span", "i668p-ws-sec-s", sub));
    parent.appendChild(h);
    return h;
  }
  function pctSpan(p) {
    const s = P.mk("span", p >= 0 ? "is-up" : "is-down", P.pctTxt(p));
    return s;
  }

  /* ---------------------- ① 三阶段预测卡 ---------------------- */
  function rOf(key) { return ST.res ? ST.res[key] : null; }
  // S2 是否处于「降级估算」：空窗期（招股截止已过、配售结果未公布）或站点未录入超购倍数。
  // 老板实测踩过：06731 配售结果公布当天站点仍未录入超购倍数，旧实现让 S2 整列空白。
  function isProv(key) {
    if (key !== "s2") return false;
    const r = rOf("s2");
    if (!r) return false;
    return r.provisional === true || (ST.res && ST.res.pending === true);
  }
  function stageStateOf(key) {
    const st = P.STAGE_ORDER[ST.stage] || 0;
    const ko = P.KEY_ORDER[key];
    if (!st) return { txt: "无日期", cls: "is-dim" };
    // ⚠️ v0.4.8：按**时间相位**判定「当前阶段」，不再只看数据阶段（详见 core.js/stageFocus）。
    //    空窗期（招股已截止、配售结果未公布）时 ST.stage 仍是 S1，但招股期其实已经过去了，
    //    不能再把 S1 标成「当前阶段」。此刻的焦点是「等配售结果 → 暗盘」＝ S2 —— 它只有
    //    降级估算（未用超购因子），故标「当前阶段 · 预估值」。
    const foc = ST.stock ? P.stageFocus(ST.stock, P.todayDate()) : null;
    if (foc && foc.phase === "AWAIT") {
      if (key === "s1") return { txt: "已过阶段 · 招股期已截止", cls: "is-past" };
      if (key === "s2") return { txt: "当前阶段 · 预估值（配售结果未公布）", cls: "is-prov" };
      return { txt: "未到该阶段", cls: "is-dim" };
    }
    if (ko > st) {
      // 空窗期例外：S2 尚未"正式"到来，但要给预估值，状态如实标注
      if (isProv(key)) return { txt: "预估值 · 配售结果未公布", cls: "is-prov" };
      return { txt: "未到该阶段", cls: "is-dim" };
    }
    // 事实优先：暗盘已结束 → S2 有实测；已上市 → S3 有实测
    if (key === "s2" && st >= 3) return P.darkActual(ST.stock) ? { txt: "已出实测（见下方）", cls: "is-actual" } : { txt: "实测缺失", cls: "is-dim" };
    if (key === "s3" && ST.stage === "LISTED") return P.firstDayActual(ST.stock) ? { txt: "已出实测（见下方）", cls: "is-actual" } : { txt: "实测缺失", cls: "is-dim" };
    if (!rOf(key)) return { txt: "待公布", cls: "is-dim" };
    if (ko < st) return { txt: "已过阶段（保留回溯）", cls: "is-past" };
    if (isProv(key)) return { txt: "当前阶段 · 降级估算", cls: "is-prov" };
    return { txt: "当前阶段", cls: "is-cur" };
  }

  function buildStageCards(wrap) {
    const grid = P.mk("div", "i668p-ws-grid");
    const ipo = P.num(ST.stock && ST.stock.ipo_price) || 0;
    ["s1", "s2", "s3"].forEach((key) => {
      const r = rOf(key);
      const ov = P.ovGet(ST.code, key);
      const stt = stageStateOf(key);
      const c = card(stt.cls + (ST.editing === key ? " is-editing" : "") + (ov ? " has-ov" : ""));

      const hd = P.mk("div", "i668p-ws-ch");
      hd.appendChild(P.mk("span", "i668p-ws-ct", P.KEY_LABEL[key]));
      hd.appendChild(P.mk("span", "i668p-ws-cs", key.toUpperCase()));
      c.appendChild(hd);
      c.appendChild(P.mk("div", "i668p-ws-basis", P.KEY_BASIS[key]));

      if (ST.editing === key) {
        buildEditor(c, key, ov, r);
      } else {
        const val = ov ? { lo: ov.lo, hi: ov.hi, loPct: ov.loPct, hiPct: ov.hiPct } : r;
        if (val) {
          // v0.4.6：老板的批评是「区间那么大等于没有预测」→ **把「中枢」（最可能落点）放到首位**，
          // 区间降为次要信息，并标明它是「50% 区间」（约一半概率落在其中），
          // 而不是原来那种"最高/最低可能都包进来"的覆盖包络。
          if (!ov && r && r.base != null) {
            const mid = P.mk("div", "i668p-ws-mid");
            mid.appendChild(P.mk("span", "i668p-ws-mid-k", "中枢"));
            mid.appendChild(P.mk("span", "i668p-ws-mid-v", P.pctTxt(r.base, 1)));
            if (ipo) mid.appendChild(P.mk("span", "i668p-ws-mid-p", P.fmt(ipo * (1 + r.base / 100))));
            c.appendChild(mid);
          }
          const p = P.mk("div", "i668p-ws-price" + (r && r.base != null ? " is-sub" : ""),
            Math.abs(val.hi - val.lo) > 0.001 ? P.fmt(val.lo) + " – " + P.fmt(val.hi) : P.fmt(val.lo));
          c.appendChild(p);
          const pr = P.mk("div", "i668p-ws-pct");
          pr.appendChild(pctSpan(val.loPct));
          pr.appendChild(P.mk("span", "i668p-ws-tilde", " ~ "));
          pr.appendChild(pctSpan(val.hiPct));
          if (!ov && r && r.conf != null) pr.appendChild(P.mk("span", "i668p-ws-conf", "  " + P.stars(r.conf)));
          c.appendChild(pr);
          if (!ov && r && r.dLo != null) {
            c.appendChild(P.mk("div", "i668p-ws-tag is-band",
              "50% 区间 · 约一半概率落在此内（非最高/最低可能）"));
          }
        } else {
          c.appendChild(P.mk("div", "i668p-ws-price is-empty", "—"));
          c.appendChild(P.mk("div", "i668p-ws-pct is-dim", "该阶段数据尚未公布"));
        }
        if (ov) {
          c.appendChild(P.mk("div", "i668p-ws-tag is-manual", "\u270e 人工设定" + (ov.note ? " · " + ov.note : "")));
        } else if (isProv(key) && r) {
          c.appendChild(P.mk("div", "i668p-ws-tag is-prov",
            "\u26a0 降级估算：未使用超购因子" + (ST.res && ST.res.pending ? "（配售结果未公布）" : "")));
        }
        const stl = P.mk("div", "i668p-ws-state " + stt.cls, stt.txt);
        c.appendChild(stl);

        const acts = P.mk("div", "i668p-ws-acts");
        const b1 = P.mk("button", "i668p-ws-btn", ov ? "修改" : "改价");
        b1.onclick = () => { ST.editing = key; ST.msg = ""; render(); };
        acts.appendChild(b1);
        if (ov) {
          const b2 = P.mk("button", "i668p-ws-btn is-ghost", "恢复模型值");
          b2.onclick = () => { P.ovDel(ST.code, key); ST.editing = ""; render(); };
          acts.appendChild(b2);
        }
        c.appendChild(acts);
      }
      grid.appendChild(c);
    });
    wrap.appendChild(grid);
  }

  // 编辑态
  function buildEditor(cardEl, key, ov, r) {
    const ipo = P.num(ST.stock.ipo_price);
    cardEl.appendChild(P.mk("div", "i668p-ws-hint", "填价格（如 13.20）或涨跌幅（如 +50%）；留空上沿＝单点"));
    const l1 = P.mk("label", "i668p-ws-field");
    l1.appendChild(P.mk("span", null, "区间下沿"));
    const i1 = P.mk("input", "i668p-ws-in");
    i1.id = "i668p-e-lo"; i1.type = "text"; i1.placeholder = "13.20 或 +5.6%";
    if (ov) i1.value = P.fmt(ov.lo);
    else if (r) i1.value = P.fmt(r.lo);
    l1.appendChild(i1);
    cardEl.appendChild(l1);

    const l2 = P.mk("label", "i668p-ws-field");
    l2.appendChild(P.mk("span", null, "区间上沿"));
    const i2 = P.mk("input", "i668p-ws-in");
    i2.id = "i668p-e-hi"; i2.type = "text"; i2.placeholder = "15.00 或 +20%";
    if (ov) i2.value = P.fmt(ov.hi);
    else if (r) i2.value = P.fmt(r.hi);
    l2.appendChild(i2);
    cardEl.appendChild(l2);

    const l3 = P.mk("label", "i668p-ws-field");
    l3.appendChild(P.mk("span", null, "备注"));
    const i3 = P.mk("input", "i668p-ws-in");
    i3.id = "i668p-e-note"; i3.type = "text"; i3.placeholder = "依据，如「基石豪华 / 保荐人强」";
    if (ov && ov.note) i3.value = ov.note;
    l3.appendChild(i3);
    cardEl.appendChild(l3);

    if (ipo) cardEl.appendChild(P.mk("div", "i668p-ws-hint", "发行价 " + P.fmt(ipo) + " 港元"));

    const acts = P.mk("div", "i668p-ws-acts");
    const save = P.mk("button", "i668p-ws-btn is-primary", "保存");
    save.onclick = () => saveEdit(key);
    const cancel = P.mk("button", "i668p-ws-btn", "取消");
    cancel.onclick = () => { ST.editing = ""; ST.msg = ""; render(); };
    acts.appendChild(save); acts.appendChild(cancel);
    if (ov) {
      const reset = P.mk("button", "i668p-ws-btn is-ghost", "恢复模型值");
      reset.onclick = () => { P.ovDel(ST.code, key); ST.editing = ""; render(); };
      acts.appendChild(reset);
    }
    cardEl.appendChild(acts);
    if (ST.msg) cardEl.appendChild(P.mk("div", "i668p-ws-msg", ST.msg));
  }

  function saveEdit(key) {
    const ipo = P.num(ST.stock.ipo_price);
    if (!ipo) { ST.msg = "站点未提供发行价，无法换算"; render(); return; }
    const rawLo = (q("#i668p-e-lo") || {}).value;
    const rawHi = (q("#i668p-e-hi") || {}).value;
    const note = ((q("#i668p-e-note") || {}).value || "").trim();
    let a = parseInput(rawLo, ipo);
    let b = parseInput(rawHi, ipo);
    if (!a && !b) { ST.msg = "请填写有效价格（如 13.20）或涨跌幅（如 +50%）"; render(); return; }
    if (!a) a = b;
    if (!b) b = a;
    if (b.price < a.price) { const t = a; a = b; b = t; }
    P.ovSet(ST.code, key, {
      lo: a.price, hi: b.price,
      loPct: +a.pct.toFixed(1), hiPct: +b.pct.toFixed(1),
      note: note, ts: Date.now(),
    });
    ST.editing = ""; ST.msg = "";
    render();
  }

  /* ---------------------- ② 计算过程 ---------------------- */
  // 置信度不是随便打星：它来自该超购档样本的历史离散度，必须说清来源
  function confWhy(r) {
    if (r.key === "s1") return "招股期无超购数据，信息最少";
    if (r.conf >= 3) return "该超购档样本离散度小，方向稳定";
    if (r.conf === 2) return "该档样本离散度中等";
    return "该档样本离散度大，仅作方向参考";
  }

  function buildProcess(wrap, key) {
    const r = rOf(key);
    const ov = P.ovGet(ST.code, key);
    secTitle(wrap, "计算过程", P.KEY_LABEL[key] + " · " + (P.KEY_BASIS[key] || ""));
    if (!r) {
      wrap.appendChild(P.mk("div", "i668p-ws-hint", ST.stage === "UNKNOWN"
        ? "该股时间线日期缺失，无法判定所处阶段。"
        : "该阶段数据尚未公布（如招股期无超购数据时无法计算）。"));
      return;
    }
    if (ov) {
      wrap.appendChild(P.mk("div", "i668p-ws-warn", "\u26a0 该阶段当前显示的是你的人工设定，下方为模型原值（仅供对比）。"));
    }
    if (r.provisional) {
      wrap.appendChild(P.mk("div", "i668p-ws-warn",
        "\u26a0 本次为「降级估算」：站点尚未录入公开超购倍数（S2 份量最重的因子），" +
        "基准改取中性 0%、区间放宽到 \u00b130%、置信度 ★☆☆。此处的数字只能看方向，不能当精准区间用。"));
    }
    if (!r.provisional && ST.res && ST.res.pending && key === "s2") {
      wrap.appendChild(P.mk("div", "i668p-ws-hint",
        "注：公开超购倍数已录入，但站点尚未标记配售结果公布 —— 本页按完整模型计算。"));
    }
    const tbl = P.mk("div", "i668p-ws-proc");
    (r.steps || []).forEach((s) => {
      const row = P.mk("div", "i668p-ws-prow");
      row.appendChild(P.mk("span", "i668p-ws-pk", s.k));
      row.appendChild(P.mk("span", "i668p-ws-pd", s.d));
      const v = P.mk("span", "i668p-ws-pv", (s.v == null) ? "—" : P.pctTxt(s.v, 1));
      if (s.v != null) v.classList.add(s.v > 0 ? "is-up" : (s.v < 0 ? "is-down" : "is-flat"));
      row.appendChild(v);
      tbl.appendChild(row);
    });
    if (r.base != null) {
      const row = P.mk("div", "i668p-ws-prow is-sum");
      row.appendChild(P.mk("span", "i668p-ws-pk", "修正后基准"));
      row.appendChild(P.mk("span", "i668p-ws-pd", "上述各项汇总（已做上下界夹逼）"));
      row.appendChild(P.mk("span", "i668p-ws-pv", P.pctTxt(r.base, 1)));
      tbl.appendChild(row);
    }
    if (r.spread != null) {
      const row = P.mk("div", "i668p-ws-prow is-sum");
      row.appendChild(P.mk("span", "i668p-ws-pk", "展开区间"));
      row.appendChild(P.mk("span", "i668p-ws-pd", "基准 \u00b1 " + r.spread + "%（该档样本的历史离散度）"));
      row.appendChild(P.mk("span", "i668p-ws-pv", P.pctTxt(r.loPct) + " ~ " + P.pctTxt(r.hiPct)));
      tbl.appendChild(row);
    }
    wrap.appendChild(tbl);
    const foot = P.mk("div", "i668p-ws-hint",
      "置信度 " + P.stars(r.conf) + "（" + confWhy(r) + "）；预测区间 " + P.fmt(r.lo) + " – " + P.fmt(r.hi) +
      "。样本：2024–2026 共 106 只港股新股（tools/backtest.js 可复跑）。");
    wrap.appendChild(foot);
  }

  /* ---------------------- ⑤ 招股书数据（站点挂链的招股章程） ----------------------
     免费源里最难拿的两项都在这里：
       · 基石配售 —— etnet / AAStocks / 辉立 都只有保荐人与包销商，只有招股章程有；
       · 超额配股权（绿鞋）—— 同理。**老板明确要求必须展示**：它是上市后 30 天内
         唯一的官方托价机制（跌破发行价可由稳价人买入托住），看首日必须知道有没有。
     两项都是只读事实，不可编辑。

     v0.4.4：**把披露原文的直链透出来**。老板原话「人家网址上本身就有披露啊，你直接看就行」
     —— 对：i668 接口顶层就给了 `prospectus_url`（117/117）与 `allotment_pdf_url`（109/117），
     详情页时间线里的「招股书 PDF ↗」就是前者。这里原样透出，你自己能核对上面的数字，
     不用信我的复述。 */
  /* 绿鞋：把「一行 + 一段说明」包成可替换的 item，供同步渲染与异步兜底共用 */
  function greenShoeItem(g) {
    const item = P.mk("div", "i668p-ws-aitem");
    const r = P.mk("div", "i668p-ws-arow is-green");
    r.appendChild(P.mk("span", "i668p-ws-ak", "超额配股权"));
    if (g && g.has != null) {
      r.appendChild(P.mk("span", "i668p-ws-av " + (g.has ? "is-on" : "is-off"), g.has ? "有（绿鞋）" : "无"));
      r.appendChild(P.mk("span", "i668p-ws-ad",
        g.has
          ? (g.shares
              ? "最多 " + (g.shares / 1e4).toFixed(1) + " 万股" + (g.pct != null ? " · 占全球发售 " + g.pct + "%" : "")
              : "招股章程载明已授出")
          : "招股章程未载明超额配股权"));
    } else if (g && g.placeholder) {
      r.appendChild(P.mk("span", "i668p-ws-av i668p-gs-loading", "解析中…（从披露易招股章程实时解析）"));
    } else {
      r.appendChild(P.mk("span", "i668p-ws-av", g && g.msg ? g.msg : "—"));
    }
    item.appendChild(r);
    if (g && g.has != null) {
      item.appendChild(P.mk("div", "i668p-ws-hint",
        (g.stabilizer ? "稳价人 " + g.stabilizer + "。" : "") +
        (g.has
          ? "有绿鞋 = 承销商可超额配售" + (g.pct != null ? "约 " + g.pct + "%" : "（通常 15%）") +
            "，上市后 30 天内若跌破发行价，稳价人可买入托价 —— 是首日/暗盘的下方支撑；" +
            "若股价走强，行使权利增发则会摊薄热度。"
          : "无绿鞋 = 上市后没有官方托价机制，首日跌破发行价时缺少承销商买入支撑，波动通常更大。")));
    } else if (g && g.placeholder) {
      item.appendChild(P.mk("div", "i668p-ws-hint",
        "新上市股的内置绿鞋数据尚未收录，正用浏览器从披露易招股章程现场解析超额配股权（仅此一次，结果缓存到本机）。"));
    }
    return item;
  }

  function buildProspectus(wrap) {
    const e = P.exOf(ST.code) || {};
    const pro = e.pros || {};
    const c = P.cornerstoneOf(ST.code, ST.stock);
    const g = P.greenShoeOf(ST.code, ST.stock);
    const links = [];
    if (pro.url) links.push(["招股章程 PDF", pro.url]);
    else if (ST.stock && ST.stock.prospectus_url) links.push(["招股章程 PDF", ST.stock.prospectus_url]);
    if (e.allotUrl) links.push(["配售结果公告", e.allotUrl]);
    if (!c && !g && !links.length) return;   // 该股什么都还没抓到 → 整段不出现
    secTitle(wrap, "招股书数据", links.length ? "站点已挂披露原文 · 只读" : "只读");
    const box = P.mk("div", "i668p-ws-actual");

    if (c) {
      const r = P.mk("div", "i668p-ws-arow");
      r.appendChild(P.mk("span", "i668p-ws-ak", "基石配售"));
      r.appendChild(P.mk("span", "i668p-ws-av", (c.shares / 1e4).toFixed(1) + " 万股"));
      r.appendChild(P.mk("span", "i668p-ws-av", c.ratio != null ? "占全球发售 " + c.ratio + "%" : "—"));
      r.appendChild(P.mk("span", "i668p-ws-ad", c.usd != null ? "认购额约 " + c.usd + " 百万美元" : "招股章程载明"));
      box.appendChild(r);
      if (c.ratio != null) {
        box.appendChild(P.mk("div", "i668p-ws-hint",
          "基石占比已作为因子计入预测（市场基准 35%，保守权重 0.12，截断 ±6pt）—— 详见上方「计算过程」。"));
      }
    }

    if (g) {
      box.appendChild(greenShoeItem(g));
    } else {
      // 内置无绿鞋 → 放占位 item，待 ensureGreenShoe 异步解析后替换
      const item = greenShoeItem({ placeholder: true });
      item.setAttribute("data-i668p-gs", "prosp");
      box.appendChild(item);
    }

    if (links.length) {
      const lr = P.mk("div", "i668p-ws-links");
      lr.appendChild(P.mk("span", "i668p-ws-links-t", "披露原文"));
      links.forEach(function (kv) {
        const a = P.mk("a", "i668p-ws-link", kv[0] + " ↗");
        a.href = kv[1];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        lr.appendChild(a);
      });
      box.appendChild(lr);
    }
    wrap.appendChild(box);
  }

  /* ---------------------- ③ 模型因子 ---------------------- */
  // 三类必须分开讲，否则「科学」二字不成立：
  //   已纳入 = 真的参与打分（界面上能看到它产生的增量）
  //   只展示 = 数据拿得到、也确实重要，但不入权重（如绿鞋，区分度低）
  //   未纳入 = 免费源拿不到（如国配认购人结构）—— 这才是「改价」存在的理由
  function factRows(box, list) {
    list.forEach((f) => {
      const r = P.mk("div", "i668p-ws-frow");
      r.appendChild(P.mk("span", "i668p-ws-fk", f.k));
      r.appendChild(P.mk("span", "i668p-ws-fd", f.d));
      box.appendChild(r);
    });
  }
  /* ---------------------- ⑥ 散户中签率（站点自带 · 只读） ----------------------
     老板问到「散户中签率是不是也是影响暗盘价格的重要因素」。
     实测结论：与公开超购倍数**高度共线**（log10 相关系数 −0.72），**不入权重**；
     但对「我能拿到多少货」是直接有用的 —— 所以展示，并当场写清口径与不加权的理由。 */
  function buildAllot(wrap) {
    const r = P.allotmentRate(ST.stock || {});
    if (!r) return;
    secTitle(wrap, "散户中签率", "人数口径 · 只读 · 不入权重");
    const box = P.mk("div", "i668p-ws-actual");
    const row = P.mk("div", "i668p-ws-arow is-rate");
    row.appendChild(P.mk("span", "i668p-ws-ak", "中签率"));
    row.appendChild(P.mk("span", "i668p-ws-av", r.all != null ? r.all + "%" : "—"));
    row.appendChild(P.mk("span", "i668p-ws-av", r.a != null ? "甲组 " + r.a + "%" : "甲组 —"));
    row.appendChild(P.mk("span", "i668p-ws-ad", r.b != null ? "乙组 " + r.b + "%" : "乙组 —"));
    box.appendChild(row);
    box.appendChild(P.mk("div", "i668p-ws-hint",
      "口径：站点只给「申请人数 / 中签人数」，所以这是「人数口径」，不是交易所公布的「一手中签率」（那需要配发基准表，免费源没有）。" +
      "为何不入权重：它与公开超购倍数高度共线（log10 相关系数 \u22120.72 \u2014\u2014 中签率本就是超购经回拨后的结果），" +
      "对暗盘的单独解释力也更弱（超购 r = +0.46 > 中签率 \u22120.40）；两者同时进回归只多 2.6pp R\u00b2 且系数符号会反转。" +
      "所以它影响的是「你能拿到多少货」，而不是「暗盘会涨多少」。" +
      "读法提示：乙组按人数口径常是 100%（大户只要申请基本都能分到），区分度低，所以主要看甲组与整体 —— " +
      "站点未提供每档「分到多少手」的明细，想要精确的一手中签率只能翻配发结果公告。"));
    wrap.appendChild(box);
  }

  function buildFactors(wrap) {
    secTitle(wrap, "模型因子", "用了什么 / 没用什么 / 只展示什么");
    const cat = P.factorCatalog();
    const box1 = P.mk("div", "i668p-ws-fac");
    box1.appendChild(P.mk("div", "i668p-ws-fac-h", "已纳入 " + cat.used.length + " 项（参与打分）"));
    factRows(box1, cat.used);
    wrap.appendChild(box1);

    if (cat.shown && cat.shown.length) {
      const box3 = P.mk("div", "i668p-ws-fac is-shown");
      box3.appendChild(P.mk("div", "i668p-ws-fac-h", "只展示 " + cat.shown.length + " 项（不入权重，上方「招股书数据」可见）"));
      factRows(box3, cat.shown);
      wrap.appendChild(box3);
    }

    const box2 = P.mk("div", "i668p-ws-fac is-miss");
    box2.appendChild(P.mk("div", "i668p-ws-fac-h is-warn", "\u26a0 未纳入 " + cat.missing.length + " 项（免费数据不可得）"));
    factRows(box2, cat.missing);
    box2.appendChild(P.mk("div", "i668p-ws-hint", "模型看不见这些 —— 这正是「改价」存在的意义：把你的信息补进去。"));
    wrap.appendChild(box2);
  }

  /* ---------------------- ④ 实测 + 复盘 ---------------------- */
  function buildActual(wrap) {
    secTitle(wrap, "实测数据", "站点记录 · 只读 · 不可修改");
    const a = P.darkActual(ST.stock);
    const o = P.firstDayOpenActual(ST.stock);   // 首日**开盘**（etnet）
    const f = P.firstDayActual(ST.stock);       // 首日收盘（i668）
    const box = P.mk("div", "i668p-ws-actual");
    if (!a && !o && !f) {
      box.appendChild(P.mk("div", "i668p-ws-hint", "暂无实测数据（尚未到暗盘日 / 上市日，或站点未录入）。"));
      wrap.appendChild(box);
      return;
    }
    const ipo = P.num(ST.stock.ipo_price);
    if (a) {
      const r = P.mk("div", "i668p-ws-arow");
      r.appendChild(P.mk("span", "i668p-ws-ak", "暗盘收盘"));
      r.appendChild(P.mk("span", "i668p-ws-av", P.fmt(a.price)));
      r.appendChild(pctSpan(a.pct));
      r.appendChild(P.mk("span", "i668p-ws-ad", "口径：站点「暗盘VS首日」页 \u2014\u2014 涨幅取当日暗盘收盘价"));
      box.appendChild(r);
    }
    if (o) {
      const r = P.mk("div", "i668p-ws-arow");
      r.appendChild(P.mk("span", "i668p-ws-ak", "首日开盘"));
      r.appendChild(P.mk("span", "i668p-ws-av", P.fmt(o.price)));
      r.appendChild(pctSpan(o.pct));
      r.appendChild(P.mk("span", "i668p-ws-ad", "口径：etnet「首日開市升跌」—— S3 的预测标的就是它"));
      box.appendChild(r);
    }
    if (f) {
      const r = P.mk("div", "i668p-ws-arow");
      r.appendChild(P.mk("span", "i668p-ws-ak", "首日收盘"));
      r.appendChild(P.mk("span", "i668p-ws-av", P.fmt(f.price)));
      r.appendChild(pctSpan(f.pct));
      r.appendChild(P.mk("span", "i668p-ws-ad", "口径：上市首日收盘价（相对发行价）"));
      box.appendChild(r);
    }
    if (ipo) box.appendChild(P.mk("div", "i668p-ws-hint",
      "发行价 " + P.fmt(ipo) + " 港元。本插件不冒充开盘价：首日开盘价取自 etnet 公开页「首日開市升跌」，" +
      "取不到时才回退 i668 的收盘价 —— 并明确标注为「首日收盘」，两种口径不混用。"));
    wrap.appendChild(box);

    // 复盘：你设过 vs 实际
    const pairs = [
      { key: "s2", lab: "中签后预测 S2", act: a, aname: "暗盘收盘" },
      { key: "s3", lab: "暗盘后预测 S3", act: f, aname: "首日收盘" },
    ].filter((x) => x.act && P.ovGet(ST.code, x.key));
    if (pairs.length) {
      secTitle(wrap, "复盘", "你的设定 vs 实际结果");
      const cb = P.mk("div", "i668p-ws-cmp");
      pairs.forEach((x) => {
        const ov = P.ovGet(ST.code, x.key);
        const mid = (ov.loPct + ov.hiPct) / 2;
        const diff = x.act.pct - mid;
        const r = P.mk("div", "i668p-ws-crow");
        r.appendChild(P.mk("span", "i668p-ws-ck", x.lab));
        r.appendChild(P.mk("span", "i668p-ws-cv", "你设 " + P.pctTxt(ov.loPct) + "~" + P.pctTxt(ov.hiPct) + "（中值 " + P.pctTxt(mid) + "）"));
        r.appendChild(P.mk("span", "i668p-ws-cv", x.aname + " " + P.pctTxt(x.act.pct)));
        r.appendChild(P.mk("span", "i668p-ws-cx " + (diff >= 0 ? "is-down" : "is-up"), (diff >= 0 ? "低估 " : "高估 ") + Math.abs(diff).toFixed(1) + "pt"));
        cb.appendChild(r);
      });
      wrap.appendChild(cb);
    }
  }

  /* ---------------------- 渲染工坊 ---------------------- */
  function render() {
    if (!ROOT) return;
    P.clear(ROOT);
    const head = P.mk("div", "i668p-ws-head");
    const tl = P.mk("div", "i668p-ws-title-box");
    tl.appendChild(P.mk("span", "i668p-ws-title", "预测工坊"));
    const name = ST.stock ? (ST.code + " " + (ST.stock.stock_name || "")) : ST.code;
    tl.appendChild(P.mk("span", "i668p-ws-code", name));
    if (ST.stage) {
      // 阶段 chip 也随时间走：空窗期 ≠ 招股期，必须分开说。否则 chip 说「招股期 S1」、
      // 状态行说「空窗期」、卡片 badge 又说「当前阶段」—— 三处各说各话（老板截图即此）。
      const ph = ST.stock ? P.phaseOf(ST.stock, P.todayDate()) : null;
      tl.appendChild(ph === "AWAIT"
        ? P.mk("span", "i668p-ws-stage is-await", "空窗期 · 等待配售结果")
        : P.mk("span", "i668p-ws-stage", P.STAGE_NAME[ST.stage] || ST.stage));
    }
    head.appendChild(tl);

    const acts = P.mk("div", "i668p-ws-hacts");
    const rf = P.mk("button", "i668p-ws-btn is-ghost", "刷新数据");
    rf.onclick = () => { load(true); };
    const tg = P.mk("button", "i668p-ws-btn is-ghost", COLLAPSED ? "展开" : "收起");
    tg.onclick = () => { COLLAPSED = !COLLAPSED; render(); };
    acts.appendChild(rf); acts.appendChild(tg);
    head.appendChild(acts);
    ROOT.appendChild(head);

    const body = P.mk("div", "i668p-ws-body");
    ROOT.appendChild(body);
    if (COLLAPSED) { body.style.display = "none"; return; }

    if (ST.loading) { body.appendChild(P.mk("div", "i668p-ws-hint", "加载数据中…")); return; }
    if (ST.failed || !ST.stock) {
      body.appendChild(P.mk("div", "i668p-ws-warn", "未能取得该股数据：" + (ST.failed || "站点接口未返回该代码") + "。可点「刷新数据」重试。"));
      return;
    }

    const ipo = P.num(ST.stock.ipo_price);
    const gs = P.greenShoeOf(ST.code, ST.stock);
    const facts = P.mk("div", "i668p-ws-facts");
    kv(facts, "发行价", ipo != null ? P.fmt(ipo) + " 港元" : "—");
    kv(facts, "每手", ST.stock.lot_size ? ST.stock.lot_size + " 股" : (ST.stock.shares_per_lot ? ST.stock.shares_per_lot + " 股" : "—"));
    kv(facts, "状态", P.stageNote(ST.stock, P.todayDate()));
    kv(facts, "公开发售超购", ST.stock.public_offer_subscription_multiple != null ? ST.stock.public_offer_subscription_multiple + " 倍" : "未公布");
    // 绿鞋放在速览区最显眼处（老板明确要求"必须展示"）：它是上市后 30 天内唯一的官方托价机制
    // 内置没有时先放占位（data-i668p-gs=facts），待 ensureGreenShoe 异步解析后回填
    if (gs) {
      kv(facts, "超额配股权", gs.has
        ? "有（绿鞋）" + (gs.pct != null ? " · " + gs.pct + "%" : "") + (gs.shares ? " · " + (gs.shares / 1e4).toFixed(1) + " 万股" : "")
        : "无", gs.has ? "is-gy" : "is-gn");
    } else {
      const gr = kv(facts, "超额配股权", "解析中…", "is-gy");
      gr.setAttribute("data-i668p-gs", "facts");
    }
    kv(facts, "招股截止 / 暗盘 / 上市", [ST.stock.subscription_end_date, ST.stock.dark_pool_date, ST.stock.listing_date].filter(Boolean).join(" / ") || "—");
    body.appendChild(facts);

    secTitle(body, "三阶段预测", "招股期 → 中签后 → 暗盘后");
    buildStageCards(body);
    if (ST.msg) body.appendChild(P.mk("div", "i668p-ws-msg", ST.msg));
    // 空窗期说明：S2 是降级估算，必须讲明白为什么、缺了什么，否则数字会被误读
    if (ST.res && ST.res.pending) {
      const sp = ST.res.s2 && ST.res.s2.spread != null ? ST.res.s2.spread : 30;
      const ahd = P.ahAdj(ST.stock, P.CACHE && P.CACHE.ctx ? P.CACHE.ctx : { ah: {} });
      body.appendChild(P.mk("div", "i668p-ws-warn",
        "\u26a0 当前处于「空窗期」：招股已截止，但配售结果（含公开超购倍数）在站点尚未公布 —— " +
        "S2「中签后预测」因此是「降级估算」（基准按中性 0%，区间放宽到 \u00b1" + sp + "%，未使用超购因子）。" +
        (ahd ? "由于该股是 A+H（A 股较发行价溢价 " + P.pctTxt(ahd.prem) + "），已按折价把中枢上移并相应收窄区间。" : "") +
        "配售结果一公布，本页会自动按完整模型重算。"));
    }

    // 招股书数据紧随预测之后：绿鞋 / 基石是"看首日必须知道"的事实，不能埋在页面底部
    buildProspectus(body);
    // 中签率只在配售结果公布后才有（空窗期不显示，避免给一个"未公布"的空壳）
    buildAllot(body);

    // 正在编辑哪个阶段，就展示哪个阶段的计算过程（编辑时它才是有参考价值的那一栏）
    const curKey = ST.editing || (ST.stage === "S1" ? "s1" : (ST.stage === "S2" ? "s2" : "s3"));
    buildProcess(body, curKey);
    buildActual(body);
    buildFactors(body);

    const foot = P.mk("div", "i668p-ws-foot");
    foot.textContent = "免费 · 纯前端 · 数据不上传。模型有边界，请结合公告与自身判断使用；非投资建议。";
    body.appendChild(foot);

    // 绿鞋兜底：内置未收录时，现场从披露易招股章程解析（仅缺数据才触发，结果缓存到本机）
    if (ST.stock && !ST.loading && !P.greenShoeOf(ST.code, ST.stock)) {
      const code = ST.code, stock = ST.stock;
      P.ensureGreenShoe(code, stock).then((out) => {
        if (MOUNT_FOR !== code || !ROOT || !ROOT.isConnected) return;   // 已切股 / 卸载，丢弃过期结果
        updateGsNodes(out);
      }).catch(() => {});
    }
  }

  // 用兜底解析结果回填「速览区 kv」与「招股书数据区 item」
  function updateGsNodes(out) {
    const gs = out && out.gs;
    const src = out && out.src;
    const fr = ROOT && ROOT.querySelector('[data-i668p-gs="facts"]');
    if (fr) {
      const v = fr.querySelector(".i668p-ws-vv");
      if (v) {
        if (gs) {
          v.textContent = gs.has
            ? "有（绿鞋）" + (gs.pct != null ? " · " + gs.pct + "%" : "") + (gs.shares ? " · " + (gs.shares / 1e4).toFixed(1) + " 万股" : "")
            : "无";
          fr.className = "i668p-ws-kv " + (gs.has ? "is-gy" : "is-gn");
        } else {
          v.textContent = src === "noUrl" ? "无链接" : (src === "failed" || src === "error" ? "解析失败" : "—");
        }
      }
    }
    const pr = ROOT && ROOT.querySelector('[data-i668p-gs="prosp"]');
    if (pr) {
      pr.innerHTML = "";
      pr.appendChild(greenShoeItem(gs && gs.has != null ? gs : (gs ? null : { msg: src === "noUrl" ? "无招股章程链接，无法解析" : (src === "failed" || src === "error" ? "招股章程解析失败" : "暂无绿鞋数据") })));
    }
  }

  /* ---------------------- 阶段随钟走（低频自刷新） ----------------------
     ⚠️ v0.4.8 老板原话：「这个应该是可以更新的，根据打开的时间能及时更新的呀。」
        原实现只在 load() 时算一次阶段，之后**再也不变** —— 页面常开时会失真：
          · 跨过暗盘日 18:30（暗盘收市）→ 阶段该从 S2 变 S3；
          · 跨过零点到上市日          → 该从 S3 变 LISTED 并显示实测；
          · 站点补录了配售结果        → 该从「预估」变正式预测。
        两个看门狗，都**只在签名变化时重绘**（阅读时不抖动、不打断）：
          tick 60s  —— 纯本地重算 getStage/phaseOf（零网络），时钟跨边界即刷新；
          soft 120s —— 仅在「新数据可能随时出现」的窗口（空窗期 / 暗盘日 / 上市日）
                       静默重取，配售结果一公布就自动切换，不必手点「刷新数据」。
        编辑中 / 加载中 / 已卸载 / 后台标签一律不打扰。 */
  let TICK = null, SOFT = null;

  function stageSig(s, stage, phase) {          // 变化检测签名（只取会驱动 UI 的字段）
    if (!s) return "";
    const da = P.darkActual(s), fa = P.firstDayActual(s), fo = P.firstDayOpenActual(s);
    return [stage, phase, s.ipo_price, s.public_offer_subscription_multiple,
      s.has_allotment ? 1 : 0, s.allotment_pdf_url ? 1 : 0,
      da ? da.price : "", fa ? fa.price : "", fo ? fo.price : ""].join("|");
  }
  function sameDay(d, td) {                     // "YYYY-MM-DD" 是否就是今天
    if (!d) return false;
    const p = P.pdate(d);
    return !!p && +p === +td;
  }
  function canTick() {
    return !!(ROOT && ROOT.isConnected && ST.stock && !ST.loading && !ST.editing);
  }
  function startWatchers() {
    stopWatchers();
    TICK = setInterval(() => {
      if (!canTick()) return;
      const td = P.todayDate();
      const st2 = P.getStage(ST.stock, td), ph2 = P.phaseOf(ST.stock, td);
      const sig2 = stageSig(ST.stock, st2, ph2);
      if (st2 === ST.stage && ph2 === ST.phase && sig2 === ST.sig) return;
      ST.stage = st2; ST.phase = ph2; ST.sig = sig2;
      try { ST.res = P.predict(ST.stock, ST.stage, P.CACHE && P.CACHE.ctx ? P.CACHE.ctx : { ah: {} }); }
      catch (e) { P.warnOnce("tick predict", e); }
      render();
    }, 60000);
    SOFT = setInterval(() => {
      if (!canTick()) return;
      if (document.visibilityState !== "visible") return;   // 后台标签不打扰站点接口
      const td = P.todayDate(), s = ST.stock;
      const ph = P.phaseOf(s, td);
      const volatile = ph === "AWAIT" || sameDay(s.dark_pool_date, td) || sameDay(s.listing_date, td);
      if (volatile) dataTick();
    }, 120000);
  }
  function stopWatchers() {
    if (TICK) { clearInterval(TICK); TICK = null; }
    if (SOFT) { clearInterval(SOFT); SOFT = null; }
  }
  async function dataTick() {                    // 静默重取：新值始终落盘，无实质变化则不重绘
    const code = ST.code;
    if (!code) return;
    try {
      const d = await P.loadDataCached(false);   // 60s 缓存；本 tick 120s 一次 → 必然真的去取
      if (MOUNT_FOR !== code) return;            // 期间已切股 → 丢弃过期结果
      const s = d.map[code];
      if (!s) return;
      const td = P.todayDate();
      const st2 = P.getStage(s, td), ph2 = P.phaseOf(s, td);
      const sig2 = stageSig(s, st2, ph2);
      const unchanged = st2 === ST.stage && ph2 === ST.phase && sig2 === ST.sig;
      P.CACHE = d; ST.stock = s;
      if (unchanged) return;
      ST.stage = st2; ST.phase = ph2; ST.sig = sig2;
      ST.res = P.predict(s, ST.stage, d.ctx);
      render();
    } catch (e) { P.warnOnce("dataTick", e); }
  }

  /* ---------------------- 数据加载 / 挂载 ---------------------- */
  async function load(force) {
    const code = codeOf();
    if (!code) return;
    ST.code = code;
    ST.loading = true;
    ST.failed = "";
    render();
    try {
      const d = await P.loadDataCached(!!force);
      P.CACHE = d;
      const s = d.map[code];
      if (!s) { ST.failed = "站点「新股列表」接口未返回该代码"; ST.stock = null; }
      else {
        ST.stock = s;
        ST.stage = P.getStage(s, P.todayDate());
        ST.phase = P.phaseOf(s, P.todayDate());
        ST.sig = stageSig(s, ST.stage, ST.phase);
        ST.res = P.predict(s, ST.stage, d.ctx);
      }
    } catch (e) {
      P.warnOnce("detail load", e);
      ST.failed = e.message || String(e);
    }
    ST.loading = false;
    render();
  }

  function mount() {
    const code = codeOf();
    if (!code) return false;
    if (MOUNT_FOR === code && ROOT && ROOT.isConnected) return true;
    unmount();
    const app = findMount();
    if (!app) return false;
    ROOT = document.createElement("div");
    ROOT.id = "i668p-ws";
    ROOT.className = "i668p-ws";
    app.appendChild(ROOT);
    // 由 CSS 决定停靠方式（宽屏→右侧空白区 / 窄屏→文档流顶部）
    try { document.documentElement.classList.add("i668p-detail"); } catch (e) {}
    MOUNT_FOR = code;
    if (!BOUND) {
      BOUND = true;
      P.on((ev) => { if (ev === "store" && ROOT && ROOT.isConnected) render(); });
    }
    load(false);
    startWatchers();
    return true;
  }
  function unmount() {
    stopWatchers();
    if (ROOT && ROOT.isConnected) ROOT.remove();
    ROOT = null;
    MOUNT_FOR = "";
    ST.editing = ""; ST.msg = "";
    try { document.documentElement.classList.remove("i668p-detail"); } catch (e) {}
  }

  P.detail = { mount: mount, unmount: unmount, isMounted: () => !!(ROOT && ROOT.isConnected) };
})();
