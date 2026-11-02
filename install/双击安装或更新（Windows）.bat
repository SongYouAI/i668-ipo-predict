@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================================
REM   港股打新预测 · i668 增强  ——  安装 / 更新助手（Windows）
REM
REM   为什么需要这个脚本：
REM     Chrome 不允许商店外的扩展自动安装，必须由人手动「加载已解压的扩展程序」。
REM     脚本把能自动的都做掉：找安装包 → 解压 → 清掉开发用文件 → 路径放进剪贴板
REM     → 打开浏览器。剩下 4 步只能人点（Chrome 限制）。
REM
REM   ⚠ 更新时再双击一次即可：只覆盖程序文件，设置与人工改价存在浏览器里，不会丢。
REM   ⚠ 目录用英文（i668-extension），避免中文路径在命令行下的编码问题。
REM ============================================================================

set "DEST=%USERPROFILE%\i668-extension"
set "FINAL=%DEST%\i668-ipo-predict"
set "ZIP="
set "SRC="

echo.
echo ==============================================================
echo    港股打新预测插件 · 安装 / 更新助手
echo ==============================================================
echo.

REM ---------- 1. 先判断：是不是已经解压在扩展目录里了 ----------
for %%I in ("%~dp0..") do set "PARENT=%%~fI"
if exist "%PARENT%\manifest.json" goto :INPLACE

REM 找安装包
for %%F in ("%~dp0i668*.zip" "%~dp0..\i668*.zip" "%USERPROFILE%\Downloads\i668*.zip" "%USERPROFILE%\Desktop\i668*.zip") do (
  if exist "%%~fF" if not defined ZIP set "ZIP=%%~fF"
)

if not defined ZIP (
  echo 本地没找到 i668*.zip，正在从 GitHub 下载（约 1.5MB，通常十几秒）...
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://github.com/SongYouAI/i668-ipo-predict/releases/latest/download/i668-ipo-predict.zip' -OutFile '%TEMP%\i668-install.zip' -UseBasicParsing } catch { exit 1 }"
  if not exist "%TEMP%\i668-install.zip" (
    echo.
    echo [X] 下载失败。
    echo     办法：让作者把 i668 安装包（zip）直接发给你，放到「下载」文件夹，
    echo           再双击一次本脚本即可。
    echo.
    pause
    exit /b 1
  )
  set "ZIP=%TEMP%\i668-install.zip"
)
echo [1/4] 安装包：!ZIP!

REM 解压
if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%" 2>nul
powershell -NoProfile -Command "Expand-Archive -Path '!ZIP!' -DestinationPath '%DEST%' -Force" >nul 2>&1

for /d %%D in ("%DEST%\*") do (
  if exist "%%D\manifest.json" set "SRC=%%D"
)
if not defined SRC (
  echo.
  echo [X] 安装包里没找到 manifest.json —— 文件可能不完整，请重新下载或找作者要。
  echo.
  pause
  exit /b 1
)
if /i not "!SRC!"=="%FINAL%" (
  if exist "%FINAL%" rmdir /s /q "%FINAL%"
  move "!SRC!" "%FINAL%" >nul
)
echo [2/4] 已解压到：%FINAL%

REM 清掉不需要的目录
for %%D in (tools screenshots _metadata .git) do (
  if exist "%FINAL%\%%D" rmdir /s /q "%FINAL%\%%D"
)
goto :VERINFO

:INPLACE
set "FINAL=%PARENT%"
echo [1/4] 检测到已在扩展目录内，无需解压：%FINAL%

:VERINFO
for /f "tokens=2 delims=:, " %%V in ('findstr /i "\"version\"" "%FINAL%\manifest.json"') do set "VER=%%~V"
echo [3/4] 版本：v!VER!

REM ---------- 4. 路径进剪贴板 + 打开浏览器 ----------
echo|set /p="%FINAL%"| clip
echo [4/4] 扩展路径已复制到剪贴板

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "CHROME=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if defined CHROME start "" "!CHROME!"

echo.
echo ==============================================================
echo    只差 4 步（Chrome 规定必须你亲手点，脚本不能代劳）
echo ==============================================================
echo.
if not defined CHROME echo    [!] 没找到 Chrome，请手动打开你的浏览器
echo    1^) 地址栏手动输入（很短，直接敲）：
echo.
echo          chrome://extensions/
echo.
echo    2^) 打开右上角的「开发者模式」开关
echo.
echo    3^) 点左上角「加载已解压的扩展程序」
echo.
echo    4^) 在弹出的选择框里，地址栏粘贴下面这个路径后回车，再点「选择文件夹」：
echo.
echo          %FINAL%
echo.
echo --------------------------------------------------------------
echo    装好后：打开 https://www.i668.vip/stocks 就能看到预测三列。
echo    以后作者更新：双击本脚本一次，回扩展页点那个 ↻ 刷新按钮。
echo    因子库与模型参数会自己同步，不用重装。
echo ==============================================================
echo.
pause
