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
  document.getElementById("upd").addEventListener("click", checkUpdate);
  document.getElementById("fb").addEventListener("click", feedback);
  renderVer();
  renderData();
});

/* ===================== v0.6.0：数据更新 =====================
   为什么 popup 也做一次检查：插件的「因子库 / 模型参数」走远程文件，
   页面端每 6 小时才自动查一次；这里给用户一个立即催更的入口。
   ⚠️ 这里只做**粗校验**（字段在不在、条数够不够），真正的严格校验在
      content/core.js 的 validRemote()。popup 写进去的坏数据不会污染模型：
      页面加载时 applyRemote 会整份拒绝，继续用内置数据。 */
const REMOTE_KEY = "i668p.remote";

/* v0.6.2：代码包下载页 —— 用 Release 固定别名，不是仓库首页。
   为什么不用仓库地址：仓库首页要教人找绿色 Code 按钮，解压出来还带
   tools/ screenshots/ 和一层 -main 目录，小白极易选错层级。
   releases/latest/download/<文件> 是 GitHub 的永久别名：
   永远指向「最新一个 Release 的该文件」，所以朋友收藏一次地址，
   以后每次点都是最新代码包，我换版本也不用通知他改链接。 */
const DL_URL = "https://github.com/SongYouAI/i668-ipo-predict/releases/latest/download/i668-ipo-predict.zip";

let dataVer = null;

function setHint(id, msg, cls) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = "hint" + (cls ? " " + cls : "");
}

// 语义化版本比较：a 比 b 新返回 >0
function vcmp(a, b) {
  const pa = String(a || "").split(".");
  const pb = String(b || "").split(".");
  for (let i = 0; i < 3; i++) {
    const x = parseInt(pa[i], 10) || 0;
    const y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 代码版本落后时给一条能直接点的地址。
// 版本号只接受「数字 + 点」，含任何其他字符一律视为无效 —— 不能只是把杂字剔掉：
// 实测 "<img ...>9.9" 剔完会变成 "9.9"，反而误报「有新版本 v9.9」。
// v0.6.3 修的就是这个假警报。
const VRE = /^[0-9]+(\.[0-9]+)*$/;

function showCodeWarn(p) {
  const el = document.getElementById("codewarn");
  const localV = chrome.runtime.getManifest().version;
  const raw = String(p && p.appVersion ? p.appVersion : "").trim();
  const remoteV = VRE.test(raw) ? raw : "";
  if (!remoteV || vcmp(remoteV, localV) <= 0) {
    el.hidden = true;
    el.textContent = "";   // 一并清空，别把上一轮的文案留在 DOM 里
    return;
  }
  el.hidden = false;
  el.innerHTML =
    "插件代码有新版本 <b>v" + remoteV + "</b>（你现在 v" + localV + "）。" +
    "数据已是最新，但新功能要重新下载一次安装包：<br>" +
    '<a href="' + DL_URL + '" target="_blank" rel="noreferrer">' + DL_URL + "</a>";
}

function renderVer() {
  const v = chrome.runtime.getManifest().version;
  document.getElementById("ver").textContent =
    "插件 v" + v + " · 数据自动同步 · 中枢优先 + 50% 分位区间";
}

function renderData() {
  chrome.storage.local.get([REMOTE_KEY], (r) => {
    const rec = r[REMOTE_KEY];
    dataVer = rec && rec.p ? rec.p.v : null;
    const el = document.getElementById("datav");
    if (dataVer) {
      el.textContent = dataVer;
      el.className = "ov-badge has";
    } else {
      el.textContent = "内置版";
      el.className = "ov-badge";
    }
  });
}

function checkUpdate() {
  const btn = document.getElementById("upd");
  btn.disabled = true;
  document.getElementById("reload").hidden = true;
  document.getElementById("codewarn").hidden = true;
  setHint("updmsg", "检查中…");

  // 先记下当前标签页：更新成功后可以直接帮用户刷新它，省得他自己回去找
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs && tabs[0];
    const tabId = t && /^https:\/\/www\.i668\.vip\//.test(t.url || "") ? t.id : null;

    chrome.storage.local.get([REMOTE_KEY], (r) => {
      const rec = r[REMOTE_KEY];
      const curV = rec && rec.p ? rec.p.v : null;

      // 交给 background 解析「最新 commit → CDN 地址」，
      // 否则会撞上 jsDelivr 对分支引用的 12 小时缓存（详见 background.js）
      chrome.runtime.sendMessage({ type: "i668p.remote" }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok || !resp.text) {
          setHint("updmsg", "检查失败：网络不通。不影响使用，当前用的仍是本地数据。", "bad");
          btn.disabled = false;
          return;
        }
        let p = null;
        try { p = JSON.parse(resp.text); } catch (e) { p = null; }
        const okShape = p && typeof p.v === "string" && p.params && p.data &&
          p.data.extras && p.data.extras.stocks &&
          Object.keys(p.data.extras.stocks).length >= 20;
        if (!okShape) {
          setHint("updmsg", "拿到的数据不完整，已忽略（继续使用现有数据）", "bad");
          btn.disabled = false;
          return;
        }

        // 代码版本先判：数据没变，也可能代码已经落后了
        showCodeWarn(p);

        const n = Object.keys(p.data.extras.stocks).length;

        if (curV && p.v === curV) {
          setHint("updmsg", "数据已是最新：" + p.v + "（因子库 " + n + " 只）", "ok");
          btn.disabled = false;
          return;
        }

        const o = {};
        o[REMOTE_KEY] = { at: Date.now(), p: p };
        chrome.storage.local.set(o, () => {
          renderData();
          if (tabId != null) {
            // 已经在 i668 页面上：给一个「一键刷新」，点完这个弹窗自然关掉
            setHint("updmsg", "已更新到 " + p.v + "（因子库 " + n + " 只）", "ok");
            const rb = document.getElementById("reload");
            rb.hidden = false;
            rb.onclick = () => { chrome.tabs.reload(tabId); };
          } else {
            setHint("updmsg",
              "已更新到 " + p.v + "（因子库 " + n + " 只）。打开 i668 页面即生效。", "ok");
          }
          btn.disabled = false;
        });
      });
    });
  });
}

/* ===================== v0.6.0：意见反馈 =====================
   为什么用「复制诊断信息」而不是跳 GitHub Issues：使用者多是港股打新的普通人，
   没 GitHub 账号、也不翻墙。复制一段带版本与环境的信息，微信直接发过来最省事，
   而且比让用户口述「我这儿不对」有用得多。 */
function feedback() {
  const lines = [
    "【港股打新预测插件 · 反馈】",
    "插件版本：" + chrome.runtime.getManifest().version,
    "数据版本：" + (dataVer || "内置（未同步过远程）"),
    "浏览器：" + navigator.userAgent,
    "时间：" + new Date().toLocaleString("zh-CN"),
  ];
  const finish = (url) => {
    if (url) lines.push("页面：" + url);
    lines.push("", "我的问题 / 建议：");
    const text = lines.join("\n");
    // 剪贴板失败就退化为「选中一段可复制的文本」
    navigator.clipboard.writeText(text).then(() => {
      setHint("fbmsg", "已复制 ✓ 粘贴到微信发我即可（记得补一句具体哪里不对）", "ok");
    }).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "width:100%;height:90px;margin-top:6px;font-size:11px;";
      document.body.appendChild(ta);
      ta.select();
      setHint("fbmsg", "已选中下方文字，按 Ctrl/⌘+C 复制后发我", "ok");
    });
  };
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      finish(t && t.url ? t.url : "");
    });
  } catch (e) { finish(""); }
}
