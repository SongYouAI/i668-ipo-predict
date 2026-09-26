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
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
