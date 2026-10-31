#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""=========================================================================
 tools/fetch-ah-close.py
 为每只 A+H 股取「**招股截止日**当天（或之前最近交易日）的 A 股收盘价」，
 生成 data/ahclose.js 供插件本地加载（运行时零请求）。

 为什么必须按截止日取价（v0.5.3）：
   AH_LIN 的 40 只标定样本，溢价一律用「招股截止日 A 股收盘价」算。
   若界面用「今天的实时价」，同一只已上市股的溢价会随 A 股天天漂移，最大漂到
   −120pt（02249 晶合集成：截止日 +102.8% → 今日 −17.8%），于是模型的输入
   跑出了标定时的分布范围，输出自然对不上。实测 40 只里 39 只漂移，中位 −40pt。

 为什么单独一个文件、不塞进 extras.js：
   extras.js 由 fetch-etnet.py 整体重建，塞进去的字段会被下一次重建冲掉
   （pros 就是这么丢过一次，117 → 99）。独立文件互不影响。

 用法：
   python3 tools/fetch-ah-close.py            # 增量补齐（保留旧记录）
   python3 tools/fetch-ah-close.py --rebuild  # 全量重抓（丢弃旧记录）
========================================================================="""
import json
import os
import re
import sys
import time
import hmac
import hashlib
import urllib.request
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "ahclose.js")
SECRET = b"6680fc61c8585cfca143366eea267b67617b7c2830c1c896cd952b276db117c9"
API_BASE = "https://www.i668.vip/api"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"


def api_get(path):
    """i668 接口（HMAC-SHA256 签名：X-Timestamp / X-Sign）。"""
    ts = str(int(time.time()))
    sign_path = "/api" + path
    msg = (ts + sign_path + "" + "").encode() + SECRET
    sig = hmac.new(SECRET, msg, hashlib.sha256).hexdigest()
    req = urllib.request.Request(
        API_BASE + path,
        headers={
            "X-Timestamp": ts,
            "X-Sign": sig,
            "Referer": "https://www.i668.vip/stocks",
            "Origin": "https://www.i668.vip",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def gt_code(code):
    """A 股代码 → 腾讯行情代码前缀。"""
    c = str(code)
    if c[0] in ("6", "5"):
        return "sh" + c
    if c[0] in ("8", "4"):
        return "bj" + c
    return "sz" + c


def close_at(a_code, end_date):
    """取 end_date（含）之前最近一个交易日的前复权收盘价。

    ⚠️ 腾讯 fqkline 的日期参数必须是 **YYYY-MM-DD 带横线**，写成 20260924
       会返回空数组（不会报错，静默空结果 —— 极容易误判成「该股无数据」）。
    """
    g = gt_code(a_code)
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    start = end - timedelta(days=20)          # 20 天窗口，覆盖春节/国庆长假
    url = ("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param="
           + g + ",day," + start.isoformat() + "," + end.isoformat() + ",25,qfq")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://gu.qq.com/"})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read().decode("utf-8", "ignore")
    # 短时间猛拉会被 WAF 挡到 waf.tencent.com，返回 HTML 跳转页而不是 JSON。
    # 必须显式识别，不然 json.loads 抛出的 SyntaxError 会被误读成「该股没有数据」。
    if not raw.lstrip().startswith("{"):
        raise RuntimeError("接口返回非 JSON（被 WAF 限流？请降低频率后重试）")
    j = json.loads(raw)
    node = ((j.get("data") or {}).get(g) or {})
    rows = node.get("qfqday") or node.get("day") or []
    best = None
    for row in rows:
        if str(row[0]) <= end_date:            # 日线按日期升序，取最后一根 ≤ 截止日
            best = row
    if not best:
        return None, None
    try:
        return best[0], float(best[2])         # [日期, 开, 收, 高, 低, 量]
    except (IndexError, ValueError):
        return None, None


def load_old():
    """读回已有 ahclose.js（增量模式保留老股票，避免接口偶尔缺股导致丢数据）。"""
    if not os.path.exists(OUT):
        return {}
    try:
        txt = open(OUT, encoding="utf-8").read()
        i = txt.index("{")
        j = txt.rindex("}")
        return (json.loads(txt[i:j + 1]).get("close") or {})
    except Exception as e:                      # noqa: BLE001
        print("  ⚠ 旧文件解析失败，按全量处理：", e)
        return {}


def main():
    rebuild = "--rebuild" in sys.argv
    print("═" * 68)
    print(" A+H 溢价基准价抓取（招股截止日 A 股收盘价，前复权）")
    print("═" * 68)

    stocks = api_get("/ipo-stocks")
    if not isinstance(stocks, list):
        raise SystemExit("接口返回异常：" + str(stocks)[:200])
    ah = [s for s in stocks if s.get("is_ah_share") and s.get("a_share_code")]
    print("全量 %d 只，其中 A+H %d 只" % (len(stocks), len(ah)))

    old = {} if rebuild else load_old()
    print("旧库 A+H 记录 %d 条%s\n" % (len(old), "" if rebuild else "（增量保留）"))

    today = date.today().isoformat()
    out = dict(old)
    stats = {"ok": 0, "fail": 0, "pending": 0, "skip": 0}
    fails = []

    for s in ah:
        hk = s.get("stock_code")
        a_code = str(s.get("a_share_code") or "")
        end = s.get("subscription_end_date") or ""
        ipo = s.get("ipo_price")
        name = s.get("stock_name") or ""

        # 招股期还没截止 → 截止日收盘价尚不存在，运行时该用实时价，这里不固化
        if end and end > today:
            stats["pending"] += 1
            print("  · %s %-8s 截止 %s 未到 → 留给运行时实时价" % (hk, name, end))
            continue

        # 截止日未变且已有记录 → 直接复用，省一次请求
        o = out.get(hk)
        if not rebuild and o and o.get("d") == end and o.get("c") is not None:
            stats["skip"] += 1
            continue

        try:
            d, c = close_at(a_code, end)
        except Exception as e:                  # noqa: BLE001
            d, c = None, None
            fails.append("%s %s: %s" % (hk, a_code, e))

        if c is None:
            stats["fail"] += 1
            fails.append("%s %s(%s) 截止 %s 取价失败" % (hk, a_code, name, end))
            print("  ✗ %s %-8s A=%s 截止 %s 取价失败" % (hk, name, a_code, end))
            continue

        prem = None
        try:
            if ipo and float(ipo) > 0:
                prem = round((c * 1.09 / float(ipo) - 1) * 100, 1)
        except (TypeError, ValueError):
            prem = None
        out[hk] = {"a": a_code, "d": d, "c": c, "prem": prem}
        stats["ok"] += 1
        print("  ✓ %s %-8s A=%s 截止 %s → %s 收盘 %-9.3f 溢价 %s%%"
              % (hk, name, a_code, end, d, c, ("%+.1f" % prem) if prem is not None else "—"))
        time.sleep(0.08)                        # 别把免费接口打急

    # 按港股代码排序，输出稳定（便于 git diff）
    ordered = {k: out[k] for k in sorted(out.keys())}
    payload = {
        "meta": {
            "source": "腾讯财经 fqkline（前复权日线）",
            "what": "A+H 股在「招股截止日」的 A 股收盘价（人民币），供 A+H 溢价线性模型使用",
            "why": "AH_LIN 标定口径一致；用实时价会随 A 股漂移，40 只里 39 只漂移、中位 −40pt",
            "fetched": today,
            "count": len(ordered),
            "note": "运行时零请求；汇率换算仍由插件设置里的 CNY→HKD 现算，此处只存人民币原始价",
        },
        "close": ordered,
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    header = (
        "/* 自动生成（勿手改）—— 由 tools/fetch-ah-close.py 生成\n"
        " * 数据源：腾讯财经 fqkline 前复权日线，取「招股截止日」当天或之前最近交易日的收盘价\n"
        " * 用途：A+H 溢价线性模型（AH_LIN）的输入价 —— 与标定口径严格一致\n"
        " * 为何不用实时价：实时价会随 A 股波动漂移，同一只已上市股的溢价每天变，\n"
        " *   实测 40 只中 39 只漂移、中位 −40pt、最大 −120pt，模型输入会跑出标定分布。\n"
        " * 仅含公开行情数据；随插件本地加载，运行时不请求任何行情接口。\n"
        " */\n"
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(header + "window.I668P_AHCLOSE = " + body + ";\n")

    print("\n" + "─" * 68)
    print("写入 %s" % os.path.relpath(OUT, ROOT))
    print("  新增/更新 %d ｜ 复用 %d ｜ 招股中未固化 %d ｜ 失败 %d ｜ 库内共 %d 条"
          % (stats["ok"], stats["skip"], stats["pending"], stats["fail"], len(ordered)))
    if fails:
        print("  失败明细：")
        for x in fails[:20]:
            print("    -", x)
    print("─" * 68)


if __name__ == "__main__":
    main()
