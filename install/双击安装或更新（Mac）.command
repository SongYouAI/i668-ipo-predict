#!/bin/bash
# ============================================================================
#  港股打新预测 · i668 增强  ——  安装 / 更新助手（macOS）
#
#  为什么需要这个脚本：
#    Chrome 不允许商店外的扩展自动安装，必须由人手动「加载已解压的扩展程序」。
#    这个脚本把能自动的部分全做掉：找安装包 → 解压到固定目录 → 清掉开发用文件
#    → 把扩展路径放进剪贴板 → 打开浏览器。剩下的 4 步只能人点（Chrome 限制）。
#
#  ⚠️ 更新时直接再双击一次即可：会覆盖程序文件，但你的设置与人工改价存在
#    浏览器里（chrome.storage），不会被删。
# ============================================================================
set -u

DEST="$HOME/i668-港股打新插件"
FINAL="$DEST/i668-ipo-predict"
ZIP=""
SRC=""

say() { printf "\n%s\n" "$1"; }
pause() { printf "\n"; read -n 1 -s -r -p "按任意键关闭这个窗口…"; printf "\n"; }

clear
say "=============================================================="
say "   港股打新预测插件 · 安装 / 更新助手"
say "=============================================================="

# ---------- 1. 找安装包：优先本地（微信收到的最快），没有再联网下 ----------
HERE="$(cd "$(dirname "$0")" && pwd)"
for f in "$HERE"/i668*.zip "$HERE"/../i668*.zip "$HOME/Downloads"/i668*.zip "$HOME/Desktop"/i668*.zip; do
  if [ -f "$f" ]; then ZIP="$f"; break; fi
done

if [ -z "$ZIP" ]; then
  say "本地没找到 i668*.zip，正在从 GitHub 下载（约 110MB，网速慢可能要几分钟）…"
  curl -L --progress-bar --max-time 900 -o /tmp/i668-install.zip \
    "https://codeload.github.com/SongYouAI/i668-ipo-predict/zip/refs/heads/main"
  if [ ! -s /tmp/i668-install.zip ] || [ "$(wc -c < /tmp/i668-install.zip)" -lt 100000 ]; then
    say "❌ 下载失败或文件不完整。"
    say "   办法：让作者把 i668 安装包（zip）直接发给你，放到「下载」文件夹，"
    say "         再双击一次本脚本即可。"
    pause; exit 1
  fi
  ZIP=/tmp/i668-install.zip
fi
say "① 安装包：$ZIP"

# ---------- 2. 解压到固定目录（覆盖旧版） ----------
rm -rf "$DEST"
mkdir -p "$DEST"
unzip -q "$ZIP" -d "$DEST" 2>/dev/null
SRC="$(find "$DEST" -maxdepth 3 -name manifest.json -print -quit 2>/dev/null | xargs -I{} dirname {} 2>/dev/null)"
if [ -z "$SRC" ] || [ ! -f "$SRC/manifest.json" ]; then
  say "❌ 安装包里没找到 manifest.json —— 文件可能不完整，请重新下载或找作者要。"
  pause; exit 1
fi

# 顶层目录统一改名，便于下次覆盖与让用户认路
if [ "$SRC" != "$FINAL" ]; then
  rm -rf "$FINAL"
  mv "$SRC" "$FINAL"
fi
say "② 已解压到：$FINAL"

# ---------- 3. 清掉不需要的目录（体积能小 10MB+） ----------
rm -rf "$FINAL/tools" "$FINAL/screenshots" "$FINAL/_metadata" "$FINAL/.git" 2>/dev/null
VER="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$FINAL/manifest.json" 2>/dev/null || echo "?")"
say "③ 版本：v$VER  ·  体积：$(du -sh "$FINAL" 2>/dev/null | cut -f1)"

# ---------- 4. 扩展路径进剪贴板 ----------
# 只放「路径」：第 1 步的 chrome://extensions 很短，用户手打即可；
# 第 4 步要选目录，路径又长又深，那才是真正需要粘贴的地方。
printf '%s' "$FINAL" | pbcopy 2>/dev/null

# ---------- 5. 打开浏览器 ----------
OPENED=""
if open -a "Google Chrome" 2>/dev/null; then OPENED="Google Chrome";
elif open -a "Microsoft Edge" 2>/dev/null; then OPENED="Microsoft Edge";
elif open -a "Arc" 2>/dev/null; then OPENED="Arc";
fi

say "=============================================================="
say "   只差 4 步（Chrome 规定必须你亲手点，脚本不能代劳）"
say "=============================================================="
if [ -n "$OPENED" ]; then
  say "  浏览器已打开：$OPENED"
else
  say "  ⚠ 没找到 Chrome，请手动打开你的浏览器"
fi
say ""
say "  1) 地址栏手动输入（很短，直接敲）："
say ""
say "        chrome://extensions/"
say ""
say "  2) 打开右上角的「开发者模式」开关"
say ""
say "  3) 点左上角「加载已解压的扩展程序」"
say ""
say "  4) 在弹出的选择框里按 ⌘⇧G，粘贴下面这个路径后回车，再点「选择」："
say ""
say "        $FINAL"
say ""
say "--------------------------------------------------------------"
say "  装好后：打开 https://www.i668.vip/stocks 就能看到预测三列。"
say "  以后作者更新：双击本脚本一次 → 回扩展页点一下那个 ⟳ 刷新按钮。"
say "  因子库与模型参数会自己同步，不用重装。"
say "=============================================================="

pause
