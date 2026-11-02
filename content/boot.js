/* =========================================================================
 * 港股打新预测 · i668 增强  —  路由分流（boot.js，最后加载）
 *
 * i668 是 Vue SPA：从列表点进详情、用「← 新股列表」返回，都是 pushState 路由切换，
 * content script **不会重新执行**。故必须自己监听路由并按视图装/拆：
 *   /stocks          → list 层（三列预测 + 浮条）
 *   /stocks/<5位代码> → detail 层（预测工坊）
 * 两者互斥，切走时一律拆干净（含 html.i668p-wide 宽度锁与浮条），避免污染另一个视图。
 *
 * 检测手段：轮询 location.pathname 为主。原因是 content script 在 isolated world
 * 运行，patch 本 world 的 history.pushState **拦不到页面 main world 的调用**；
 * 而 popstate 只在前进/后退触发。轮询仅在路径变化时才动作，开销可忽略。
 * ========================================================================= */
(function () {
  "use strict";
  const P = window.I668P;
  if (!P) { console.warn("[i668p] core 未加载，boot 层跳过"); return; }

  const RX_DETAIL = /^\/stocks\/\d{5}/;
  const RX_LIST = /^\/stocks/;
  let cur = "";      // "" | "list" | "detail"

  function want() {
    const p = location.pathname || "";
    if (RX_DETAIL.test(p)) return "detail";
    if (RX_LIST.test(p)) return "list";
    return "";
  }

  function switchTo(w) {
    if (cur === "list" && P.list) P.list.stop();
    if (cur === "detail" && P.detail) P.detail.unmount();
    cur = w;
    if (w === "list" && P.list) P.list.start();
    if (w === "detail" && P.detail) P.detail.mount();
  }

  function apply() {
    const w = want();
    if (w !== cur) { switchTo(w); return; }
    // 同一视图内自愈：站点 Vue 重渲染可能把工坊节点冲掉，补挂回去
    if (w === "detail" && P.detail && !P.detail.isMounted()) P.detail.mount();
  }

  /* ===== 远程参数库（v0.6.0）=====
     为什么放在这里、为什么延迟 3 秒：
       · 放在路由分流之后，是因为首屏渲染绝不能等网络 —— 网络慢时用户照样立刻看到预测；
       · 延迟 3 秒，是等 list.start() 里的 loadStore 先把缓存应用完，避免并发覆盖；
       · 只有「之前应用过某个版本、现在变成了另一个版本」才提示刷新。
         首次安装（before 为 null）静默应用即可 —— 内置数据本来就是打包时的最新，
         弹一次「已更新」纯属噪音。 */
  function remoteBar(ver) {
    try {
      if (sessionStorage.getItem("i668p.remote.bar") === String(ver)) return;  // 同一版本只提示一次
      sessionStorage.setItem("i668p.remote.bar", String(ver));
    } catch (e) { /* 隐私模式无 sessionStorage，退化为每次都提示 */ }
    const bar = document.createElement("div");
    bar.className = "i668p-remote-bar";
    const txt = document.createElement("span");
    txt.className = "i668p-remote-txt";
    txt.textContent = "因子库 / 模型参数已更新到 " + ver + "（新股与重标定，无需重装扩展）";
    const go = document.createElement("button");
    go.className = "i668p-remote-btn";
    go.textContent = "刷新生效";
    go.onclick = function () { location.reload(); };
    const x = document.createElement("button");
    x.className = "i668p-remote-x";
    x.textContent = "\u00d7";
    x.title = "暂不刷新";
    x.onclick = function () { bar.remove(); };
    bar.appendChild(txt);
    bar.appendChild(go);
    bar.appendChild(x);
    document.body.appendChild(bar);
  }

  function checkRemote() {
    const before = P.REMOTE_VER;
    try {
      P.checkRemoteUpdate(false, function (r) {
        if (!r || !r.ok) return;                       // 网络/校验失败 → 静默，用内置数据照常工作
        if (before && r.ver && r.ver !== before) remoteBar(r.ver);
      });
    } catch (e) { /* 任何异常都不影响主功能 */ }
  }

  function init() {
    P.loadCfg(() => {
      apply();
      window.addEventListener("popstate", apply);
      // 详情页首屏 DOM 是异步渲染的：前几秒提高轮询频率，之后降为低频自愈
      let fast = 0;
      const fastTimer = setInterval(() => {
        apply();
        if (++fast > 20) clearInterval(fastTimer);
      }, 250);
      setInterval(apply, 800);
      // 等首屏稳定后再去拉远程数据
      setTimeout(checkRemote, 3000);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
