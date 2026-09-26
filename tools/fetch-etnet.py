#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取 etnet（經濟通）公開免費頁面，生成本插件的免費因子資料庫 data/extras.js

数据源（全部为公开免费页面，无需登录、无需 key）：
  1. 保荐人战绩榜
     https://www.etnet.com.hk/www/tc/stocks/ipo-sponsor-performance.php[?page=N]
     → 保荐人名称 / 保荐数目 / 首日上升概率 / 平均首日升跌
  2. 个股 IPO 页
     https://www.etnet.com.hk/www/tc/stocks/ipo-info.php?code=<4位代码>[&tab=sponsor]
     → 该股保荐人（名称匹配）/ 首日开市升跌 / 首日收市升跌

用法：
    python3 tools/fetch-etnet.py            # 全量抓取并重建 data/extras.js
    python3 tools/fetch-etnet.py --quick    # 只抓当前招股中 + 近 30 只已上市（快）

注意：
  · 生成的是**本地数据文件**，插件运行时不再请求 etnet，因此不涉及跨域与收费接口。
  · 抓到的只是公开统计数据，不含任何个人信息；不上传任何数据。
  · 请节制频率（默认 6 并发 + 失败退避），别给对方站点添麻烦。
"""
import json, re, os, sys, time, urllib.request, concurrent.futures, datetime

# 若环境设了代理，这里显式禁用（沙箱常见坑：走代理会 502）
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
ROOT = "https://www.etnet.com.hk/www/tc/stocks"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "data", "extras.js")

# i668 站点签名密钥（站点前端公开常量，用于取回新股代码清单）
I668_SECRET = "6680fc61c8585cfca143366eea267b67617b7c2830c1c896cd952b276db117c9"


def fetch(url, tries=3, timeout=45):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception:
            if i == tries - 1:
                return None
            time.sleep(1.2 + i)
    return None


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()


def table_rows(html):
    out = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html or "", re.S):
        cells = [strip_tags(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]
        if cells:
            out.append(cells)
    return out


def to_f(s):
    m = re.search(r"[-+]?\d+(?:\.\d+)?", s or "")
    return float(m.group()) if m else None


def to_i(s):
    m = re.search(r"\d+", (s or "").replace(",", ""))
    return int(m.group()) if m else None


# ---------- ① 保荐人战绩榜 ----------
def grab_sponsors(pages=(1, 2, 3)):
    got = []
    for p in pages:
        url = ROOT + "/ipo-sponsor-performance.php" + ("" if p == 1 else "?page=%d" % p)
        html = fetch(url)
        if not html:
            print("  ! 保荐人榜第 %d 页抓取失败" % p)
            continue
        for cells in table_rows(html)[1:]:
            if len(cells) < 7:
                continue
            name, num, prob, avg = cells[0], to_i(cells[1]), to_f(cells[2]), to_f(cells[6])
            if name and avg is not None and num:
                got.append([name, num, prob, avg])
        time.sleep(0.6)
    # 同名去重（保留样本数最大的那条）
    dedup = {}
    for name, num, prob, avg in got:
        if name not in dedup or num > dedup[name][1]:
            dedup[name] = [name, num, prob, avg]
    return sorted(dedup.values(), key=lambda x: -x[1])


# ---------- 代码清单（来自 i668，保证与插件服务的对象一致） ----------
def grab_codes():
    import hmac, hashlib
    t = str(int(time.time()))
    sig = hmac.new(I668_SECRET.encode(), (t + "/api/ipo-stocks" + "" + "" + I668_SECRET).encode(),
                   hashlib.sha256).hexdigest()
    req = urllib.request.Request("https://www.i668.vip/api/ipo-stocks", headers={
        "X-Timestamp": t, "X-Sign": sig, "Referer": "https://www.i668.vip/stocks",
        "Origin": "https://www.i668.vip", "User-Agent": UA,
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            arr = json.loads(r.read().decode("utf-8"))
        return [s["stock_code"] for s in arr if s.get("stock_code")]
    except Exception as e:
        print("  ! 取 i668 代码清单失败：%s（将只抓 etnet 侧）" % e)
        return []


# ---------- ② 个股因子 ----------
def grab_one(code, sp_names):
    n = str(int(code))
    sp, op, cl = [], None, None
    h1 = fetch(ROOT + "/ipo-info.php?code=%s&tab=sponsor" % n)
    if h1:
        sp = [nm for nm in sp_names if nm in h1]      # 名称匹配，不靠猜页面结构
    h2 = fetch(ROOT + "/ipo-info.php?code=%s" % n)
    if h2:
        m = re.search(r"首日開市升跌\s*([-\+\d.]+)\s*\(([-\+\d.]+)%\)", h2)
        if m:
            op = float(m.group(2))
        m2 = re.search(r"首日收市升跌\s*([-\+\d.]+)\s*\(([-\+\d.]+)%\)", h2)
        if m2:
            cl = float(m2.group(2))
    return code, {"sp": sp, "openPct": op, "closePct": cl}


def main():
    quick = "--quick" in sys.argv
    print("① 抓取保荐人战绩榜 …")
    sponsors = grab_sponsors()
    print("   保荐人 %d 家" % len(sponsors))
    if not sponsors:
        print("   抓不到保荐人榜，终止（可能是网络或被限流）")
        return 1

    codes = grab_codes()
    if quick:
        codes = codes[:30]
    print("② 抓取 %d 只个股的保荐人 / 首日开盘 …" % len(codes))
    sp_names = [s[0] for s in sponsors]
    res = {}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        for code, v in ex.map(lambda c: grab_one(c, sp_names), codes):
            res[code] = v
            done += 1
            if done % 15 == 0:
                print("   进度 %d/%d" % (done, len(codes)), flush=True)

    sp_map = {s[0]: {"n": s[1], "prob": s[2], "avg": s[3]} for s in sponsors}
    out = {
        "meta": {
            "source": "etnet.com.hk（經濟通）IPO 資料庫 · 公開免費頁面",
            "fetched": datetime.date.today().isoformat(),
            "sponsorCount": len(sp_map),
            "stockCount": len(res),
            "note": "保薦人戰績 = etnet「保薦人表現」榜；首日開市升跌 = etnet 個股 IPO 頁「首日表現」。"
                    "全部為公開免費頁面抓取，隨插件本地加載，運行時不再請求 etnet。",
        },
        "sponsors": sp_map,
        "stocks": res,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("/* 自动生成的免费因子数据库（勿手改）—— 由 tools/fetch-etnet.py 抓取 etnet 公开页面生成\n"
                " * 数据源：https://www.etnet.com.hk/www/tc/stocks/ipo-sponsor-performance.php（保荐人表现榜）\n"
                " *        https://www.etnet.com.hk/www/tc/stocks/ipo-info.php?code=<4位代码>（个股 IPO 页）\n"
                " * 仅含公开免费统计数据；随插件本地加载，不请求 etnet、不上传任何数据。\n"
                " */\n"
                "window.I668P_EXTRAS = " + body + ";\n")

    n_sp = sum(1 for v in res.values() if v.get("sp"))
    n_op = sum(1 for v in res.values() if v.get("openPct") is not None)
    print("③ 已写出 %s" % OUT)
    print("   股票 %d 只 | 有保荐人 %d 只 | 有首日开盘 %d 只" % (len(res), n_sp, n_op))
    return 0


if __name__ == "__main__":
    sys.exit(main())
