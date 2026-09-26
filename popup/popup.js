// popup.js — 读取/保存插件设置 + 管理「人工改价」设定
const KEYS = {
  fx: "fxCNY2HKD",
  live: "liveMarket",
  sim: "simulateDate",
};
const OV_KEY = "i668p.ov";        // 个股人工改价：{ code: { s1:{...}, s2:{...} } }

function setStatus(msg, color) {
  const el = document.getElementById("status");
  el.textContent = msg || "";
  el.style.color = color || "";
  if (msg) setTimeout(() => { el.textContent = ""; }, 3000);
}

function load() {
  chrome.storage.local.get([KEYS.fx, KEYS.live, KEYS.sim], (cfg) => {
    document.getElementById("fx").value = cfg[KEYS.fx] != null ? cfg[KEYS.fx] : 1.09;
    document.getElementById("live").checked = cfg[KEYS.live] != null ? cfg[KEYS.live] : true;
    document.getElementById("sim").value = cfg[KEYS.sim] || "";
  });
  renderOv();
}

// 统计并展示人工设定：n 格 / c 只股票
function renderOv() {
  chrome.storage.local.get([OV_KEY], (r) => {
    const ov = r[OV_KEY] || {};
    const codes = Object.keys(ov);
    let n = 0;
    codes.forEach((c) => { n += Object.keys(ov[c] || {}).length; });
    const el = document.getElementById("ovstat");
    el.textContent = n ? n + " 格 / " + codes.length + " 只股票" : "暂无";
    el.className = n ? "ov-badge has" : "ov-badge";
    document.getElementById("clear").disabled = !n;
  });
}

function save() {
  const fx = parseFloat(document.getElementById("fx").value);
  const live = document.getElementById("live").checked;
  const sim = document.getElementById("sim").value;
  chrome.storage.local.set({
    [KEYS.fx]: isNaN(fx) ? 1.09 : fx,
    [KEYS.live]: live,
    [KEYS.sim]: sim,
  }, () => setStatus("已保存。回到 i668 页面刷新即可生效。"));
}

// ⚠ 破坏性操作：二次确认后清除全部人工设定
function clearOv() {
  chrome.storage.local.get([OV_KEY], (r) => {
    const ov = r[OV_KEY] || {};
    const codes = Object.keys(ov);
    let n = 0;
    codes.forEach((c) => { n += Object.keys(ov[c] || {}).length; });
    if (!n) { setStatus("当前没有人工设定。"); return; }
    const ok = confirm(
      "确定清除全部「人工改价」？\n\n" +
      "将删除 " + n + " 格设定（涉及 " + codes.length + " 只股票），" +
      "全部恢复为模型预测值。\n此操作不可撤销。"
    );
    if (!ok) return;
    chrome.storage.local.remove(OV_KEY, () => {
      renderOv();
      setStatus("已清除全部人工设定。", "#1a7f4b");
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("clear").addEventListener("click", clearOv);
});
