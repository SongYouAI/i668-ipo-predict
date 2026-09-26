#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓「招股章程」并提取「基石配售」与「超额配股权（绿鞋）」数据

为什么是招股章程：
  基石投资者名单/金额、超额配股权，在**免费公开**渠道里只有招股章程（Prospectus）有。
  etnet / AAStocks / 辉立 等站点都只有保荐人、包销商、发售结构，**没有基石**。

⚠️ v0.4.4：PDF 链接优先用**站点自己挂的那一枚**。
  老板原话：「人家网址上本身就有披露啊，你直接看就行」——对，i668 接口顶层就给了
    · `prospectus_url`    招股章程 PDF（实测 117/117 全覆盖；详情页时间线里的「招股书 PDF ↗」就是它）
    · `allotment_pdf_url` 配售结果公告 PDF（实测 109/117）
  直接拿站点给的链接下载，**不做检索**。原来那套披露易四步检索
  （prefix.do → titleSearchServlet.do → 挑「全球發售」→ 下 PDF）退为**兜底**：
  只在站点没挂链接时才用，因为它又慢又会挑错文件（实测 17 只挑到只有几十页的
  「延迟上市公告」→ 被页数防护丢掉，等于白抓）。

链路（首选）：
  1) i668 `/api/ipo-stocks` → 取 `prospectus_url`
  2) 下载 PDF（6–30MB）→ PyMuPDF 提取文本
  3) 正则提取「基石配售」的认购总额与股数；判断是否设「超額配股權」

用法（⚠️ 需要 pymupdf，用托管 venv 的解释器）：
    $PY tools/fetch-prospectus.py                # 当前 i668 列表里的全部股票
    $PY tools/fetch-prospectus.py --active       # 只做「招股中/未上市」的（快）
    $PY tools/fetch-prospectus.py --codes 06802,03228

产出：合并写入 data/extras.js 的 stocks[code].pros =
      {pages, usd, hkd, shares, nameCount, hasGreen, greenShares, greenPct, stabilizer, src, url}
注意：写回时会保留其它工具（fetch-etnet.py）已抓的字段，不互相覆盖。
"""
import json, os, re, sys, time, tempfile, urllib.request, urllib.parse, concurrent.futures

urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_JS = os.path.join(HERE, "data", "extras.js")
HKEX = "https://www1.hkexnews.hk"
I668_SECRET = "6680fc61c8585cfca143366eea267b67617b7c2830c1c896cd952b276db117c9"


def http(url, timeout=60, json_mode=False):
    h = {"User-Agent": UA, "Accept-Language": "zh-HK,zh;q=0.9"}
    if json_mode:
        h.update({"Accept": "application/json, text/javascript, */*; q=0.01",
                  "X-Requested-With": "XMLHttpRequest",
                  "Referer": HKEX + "/search/titlesearch.xhtml?lang=zh"})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_stock_id(code):
    u = HKEX + "/search/prefix.do?callback=cb&lang=ZH&type=A&name=" + urllib.parse.quote(str(code))
    s = http(u, json_mode=True).decode("utf-8", "ignore")
    m = re.search(r"\{.*\}", s, re.S)
    if not m:
        return None
    try:
        j = json.loads(m.group())
        arr = j.get("stockInfo") or []
        return str(arr[0]["stockId"]) if arr else None
    except Exception:
        return None


def find_prospectus(sid):
    """返回招股章程 PDF 相对路径（优先带 _c 的中文版）"""
    # ⚠️ 不要加 t1code/t2code 过滤：实测带上「上市文件/招股章程」类型码后接口返回 0 条，
    #    不带类型、搜该股全部公告再按标题筛「全球發售」才拿得到。
    q = urllib.parse.urlencode({
        "sortDir": "0", "sortByOptions": "DateTime", "category": "0", "market": "SEHK",
        "stockId": str(sid), "documentType": "-1", "fromDate": "", "toDate": "", "title": "",
        "searchType": "1", "rowRange": "100", "lang": "zh",
    })
    s = http(HKEX + "/search/titleSearchServlet.do?" + q, json_mode=True).decode("utf-8", "ignore")
    try:
        rows = json.loads(s).get("result")
        if isinstance(rows, str):
            rows = json.loads(rows)
        rows = rows or []
    except Exception:
        rows = []
    # 「全球發售」= 招股章程；带 _c 的是中文版
    for r in rows:
        t = (r.get("TITLE") or "")
        link = (r.get("FILE_LINK") or "")
        if ("全球發售" in t or "招股" in t) and link.endswith("_c.pdf"):
            return link
    for r in rows:
        link = (r.get("FILE_LINK") or "")
        if link.endswith("_c.pdf"):
            return link
    return None


def parse_prospectus(pdf_path):
    """从招股章程里提取基石配售 + 绿鞋（股数 / 占比 / 稳定价格操作人）"""
    import pymupdf
    doc = pymupdf.open(pdf_path)
    n = doc.page_count
    out = {"pages": n, "usd": None, "hkd": None, "shares": None, "nameCount": None,
           "hasGreen": None, "greenShares": None, "greenPct": None, "stabilizer": None}
    kpages = []
    green_hit = False
    green_denied = False
    for i in range(n):
        t = doc[i].get_text()
        flat = re.sub(r"\s+", "", t)      # PDF 里中文常被空格/断行拆开，先去空白再判
        if "基石投資者" in flat:
            kpages.append(i)
        if not green_hit:
            # 只在「授出 / 定義 / 行使」语境下才算有绿鞋 —— 单纯出现该词可能是
            # 「不設超額配股權」的反面表述，会误判成有。同义词一并接受：
            # 各家招股章程用「超額配股權」/「超額配發權」两种写法。
            if re.search(r"(?:超額配股權|超額配發權)」指|授出(?:超額配股權|超額配發權)|根據(?:超額配股權|超額配發權)|行使(?:超額配股權|超額配發權)", flat):
                green_hit = True
            if re.search(r"不設超額配股權|並無超額配股權|未有授出超額配股權|不會授出超額配股權", flat):
                green_denied = True
        # 绿鞋：股数 / 占比 / 稳价人
        # ⚠️ 踩过的坑（v0.4.3）：
        #   ① 不能全页瞎搜「合共最多…股」—— 09976 同一页还有「發售量調整權」（增發选择权，
        #      与绿鞋是两个不同的期权），盲搜会把增发的股数当成绿鞋的。
        #   ② 必须锚定**定义条目**「「超額配股權」指…」：该段边界清晰（到下一个「」为止），
        #      且是所有招股章程都有的写法，命中率远高于搜正文句子。
        #   ③ 正文表述至少有 4 类（实测）：
        #      「額外配發及發行合共最多X股」(06731) / 「發行最多額外X股」(09856)
        #      「配發及發行最多合共X股」(09976、09615) / 「最多X股額外H股」(定義式)
        if out["greenShares"] is None:
            seg = None
            m = re.search(r"「超額配股權」指([^「」]{0,600})", flat)
            if m:
                seg = m.group(1)                      # ① 定义条目：最权威、边界最清晰
            else:
                # ② 退路：含「超額配股權」的整句，排除提到「發售量調整權」的句子
                for sm in re.finditer(r"[^。；]{0,140}(?:超額配股權|超額配發權)[^。；]{0,240}", flat):
                    if "發售量調整權" in sm.group():
                        continue
                    seg = sm.group()
                    break
            if seg:
                ms = re.search(r"最多(?:合共)?([\d,]+)股|(?:合共)([\d,]+)股", seg)
                if ms:                                # ⚠️ 没有匹配到股数就什么都不设
                    out["greenShares"] = int((ms.group(1) or ms.group(2)).replace(",", ""))
                    # ⚠️ 占比必须**以股数为锚**取其后的百分比：整段瞎搜会抓到
                    #    「經紀佣金 1%」「交易徵費 0.0027%」之类的费率（实测抓到 1.0%）。
                    mp = re.search(r"([\d.]+)%", seg[ms.start():ms.start() + 200])
                    if mp:
                        out["greenPct"] = float(mp.group(1))
        if out["stabilizer"] is None:
            m = re.search(r"「穩定價格操作人」指([^「」]{2,40})", flat)
            if m:
                out["stabilizer"] = m.group(1).strip()

    # ⚠️ 绿鞋合理性防护（v0.4.3）：超额配股权法定上限为全球发售股数的 15%（个别 10–20%），
    #    实测越界一律是提取命中了别的句子（06675 = 85.91%、03388 = 100%，明显不是绿鞋）。
    #    越界时**连股数一起丢弃**，只保留「有 / 无」这个可靠结论 ——
    #    宁可不显示数字，也不能显示错的数字。core.js 的 greenShoeOf 有同款二次防护。
    if out["greenPct"] is not None and (out["greenPct"] < 3 or out["greenPct"] > 30):
        out["greenShares"] = None
        out["greenPct"] = None

    out["hasGreen"] = bool(green_hit and not green_denied)
    if out["hasGreen"] is False:
        out["greenShares"] = None
        out["greenPct"] = None

    # 基石配售段落：遍历**所有**含「基石配售」的页（金额与股数常分散在不同页），
    # 并兼容各家的不同表述 —— 实测至少有这两类：
    #   ①「…已同意按發售價認購合共約310百萬美元…發售股份總數將為34,788,400股」
    #   ②「…總金額為340百萬美元…認購的發售股份總數為80,876,700股」
    # 早期只匹配 ① 的「合共約…發售股份總數將為」，导致提取率极低。
    RE_USD = re.compile(r"(?:合共約|總金額為|合共為|認購總額為|合共)([\d,\.]+)百萬美元")
    RE_HKD = re.compile(r"(?:或約|或)([\d,\.]+)百萬港元")
    RE_SHR = re.compile(r"總數(?:將)?為([\d,]+)股")
    for i in kpages:
        tt = re.sub(r"\s+", "", doc[i].get_text())     # 去空白：PDF 里中文常被断行拆开
        if "基石配售" not in tt:
            continue
        if out["usd"] is None:
            m = RE_USD.search(tt)
            if m:
                out["usd"] = float(m.group(1).replace(",", ""))
        if out["hkd"] is None:
            m = RE_HKD.search(tt)
            if m:
                out["hkd"] = float(m.group(1).replace(",", ""))
        if out["shares"] is None:
            m = RE_SHR.search(tt)
            if m:
                out["shares"] = int(m.group(1).replace(",", ""))
        if out["usd"] is not None and out["shares"] is not None:
            break

    # 基石数量：章节里每个基石一段「XXX 為一家…」的小标题，启发式统计带「有限公司」或英文名的段落头
    if kpages:
        blk = ""
        for i in kpages[:8]:
            blk += doc[i].get_text()
        # 形如「名稱\n名稱（「簡稱」）為一家…」——统计出现「為一家」的次数作为下限
        out["nameCount"] = len(re.findall(r"為一家", blk)) or None

    doc.close()
    return out


def fetch_list():
    """取 i668 列表的**原始记录**（不只是股票代码）。

    ⚠️ v0.4.4 关键改动 —— 老板原话：「人家网址上本身就有披露啊，你直接看就行」。

    站点接口顶层就给了两枚现成的披露文件链接：
      · `prospectus_url`    招股章程 PDF（实测 **117/117 全覆盖**）
                            —— 详情页「时间线」里的「招股书 PDF ↗」就是它；
      · `allotment_pdf_url` 配售结果公告 PDF（实测 **109/117**）。

    原来绕去披露易自己做「代码 → stockId → 标题搜索 → 挑 PDF」四步检索，
    既慢又会挑错文件（实测有 17 只挑到了只有几十页的「延迟上市公告」，
    页数 <100 被可信性防护丢掉，等于白抓）。**有现成的就用现成的。**
    """
    import hmac, hashlib
    t = str(int(time.time()))
    sig = hmac.new(I668_SECRET.encode(), (t + "/api/ipo-stocks" + "" + "" + I668_SECRET).encode(),
                   hashlib.sha256).hexdigest()
    req = urllib.request.Request("https://www.i668.vip/api/ipo-stocks", headers={
        "X-Timestamp": t, "X-Sign": sig, "Referer": "https://www.i668.vip/stocks",
        "Origin": "https://www.i668.vip", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def listed_of(rec):
    d = (rec or {}).get("listing_date") or ""
    return bool(d and d < time.strftime("%Y-%m-%d"))


def load_extras():
    """从现有 data/extras.js 里读出已有数据（避免覆盖 etnet 抓的字段）"""
    if not os.path.exists(DATA_JS):
        return {"meta": {}, "sponsors": {}, "stocks": {}}
    s = open(DATA_JS, encoding="utf-8").read()
    m = re.search(r"window\.I668P_EXTRAS\s*=\s*(\{.*\});?\s*$", s, re.S)
    if not m:
        return {"meta": {}, "sponsors": {}, "stocks": {}}
    try:
        return json.loads(m.group(1))
    except Exception:
        return {"meta": {}, "sponsors": {}, "stocks": {}}


def write_extras(d):
    body = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
    open(DATA_JS, "w", encoding="utf-8").write(
        "/* 自动生成的免费因子数据库（勿手改）—— 由 tools/ 下的抓取脚本生成\n"
        " * 数据源：① etnet 公開頁（fetch-etnet.py）保荐人战绩 / 首日开盘价\n"
        " *        ② 港交所披露易（fetch-prospectus.py）招股章程 → 基石配售 / 超额配股权\n"
        " * 仅含公开免费数据；随插件本地加载，运行时不请求任何第三方、不上传任何数据。\n"
        " */\n"
        "window.I668P_EXTRAS = " + body + ";\n")


def one(item):
    """item = (code, 站点挂的招股章程链接 or None, 是否已上市)"""
    code, url, _listed = item
    try:
        if url:
            # 首选：站点自己挂的链接（详情页「招股书 PDF ↗」）。直接下，不检索。
            src = "i668.prospectus_url"
        else:
            # 兜底：站点没挂链接时才走披露易四步检索
            sid = get_stock_id(code)
            if not sid:
                return code, {"err": "站点未挂招股章程链接，披露易也没找到 stockId"}
            link = find_prospectus(sid)
            if not link:
                return code, {"err": "未找到招股章程"}
            url = HKEX + link
            src = "hkexnews.search"
        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        tmp.write(http(url, timeout=180))
        tmp.close()
        try:
            r = parse_prospectus(tmp.name)
        finally:
            os.unlink(tmp.name)
        r["src"] = src
        r["url"] = url          # 存下来：工坊里直接给「查看招股章程 ↗」，老板可自行核对
        return code, r
    except Exception as e:
        return code, {"err": str(e)[:80]}


def preflight():
    """依赖自检（v0.4.3 加）。

    ⚠️ 实测踩过：pymupdf 只装在托管 venv 里，系统 `/usr/bin/python3` 没有 ——
    直接跑 `python3 tools/fetch-prospectus.py` 会**每只都失败**（并在旧版里把已有
    正常数据覆盖成 error）。这里提前拦住，并直接打印可用的解释器路径。
    """
    try:
        import pymupdf  # noqa: F401
        return True
    except Exception:
        import glob, subprocess
        # 只推荐**真的装了 pymupdf** 的解释器，避免把人引到另一个同样缺依赖的环境
        cands = sorted(glob.glob(os.path.expanduser(
            "~/.workbuddy/binaries/python/envs/*/bin/python")))
        good = []
        for c in cands:
            try:
                subprocess.run([c, "-c", "import pymupdf"], check=True, timeout=30,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                good.append(c)
            except Exception:
                pass
        print("❌ 缺少依赖 pymupdf —— 系统 python3 里没有装。")
        print("   本脚本需要装了 pymupdf 的解释器，请改用：")
        for c in (good or cands):
            print("     %s tools/fetch-prospectus.py %s" % (c, " ".join(sys.argv[1:])))
        if not good:
            print("     ⚠️ 上述环境都没装 pymupdf，先装依赖：")
            print("        <解释器> -m pip install pymupdf")
        return False


def main():
    args = sys.argv[1:]
    if not preflight():
        return 2
    arr = fetch_list()
    by = {str(s.get("stock_code")): s for s in arr}
    if "--codes" in args:
        want = [c.strip() for c in args[args.index("--codes") + 1].split(",") if c.strip()]
        codes = [(c, (by.get(c) or {}).get("prospectus_url"), listed_of(by.get(c))) for c in want]
    else:
        codes = [(c, rec.get("prospectus_url"), listed_of(rec)) for c, rec in by.items()]
        if "--active" in args:
            codes = [x for x in codes if not x[2]]
    n_site = sum(1 for x in codes if x[1])
    print("待抓招股章程：%d 只（其中 %d 只由站点直接提供链接，%d 只需兜底检索）"
          % (len(codes), n_site, len(codes) - n_site))
    data = load_extras()
    stocks = data.setdefault("stocks", {})
    ok = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        for code, r in ex.map(one, codes):
            row = stocks.setdefault(code, {})
            # ⚠️ 失败绝不能清空已有值（v0.4.3 修）：跑 `--codes` 时若某只抓取失败，
            #    原实现 `row["pros"] = r` 会把磁盘上**上次抓到的正常数据整个覆盖**成
            #    {"err": ...} —— 一次网络抖动就毁掉已有数据（实测已踩：3 只被清空 +
            #    meta 统计被写成 0/3）。现在失败时若已有正常数据则**原样保留**。
            if r.get("err"):
                if row.get("pros") and not row["pros"].get("err"):
                    print("  ⚠ %s %s —— 保留上次成功的数据" % (code, r.get("err")))
                else:
                    row["pros"] = r
                    print("  ⚠ %s %s" % (code, r.get("err")))
            else:
                row["pros"] = r
                # 站点披露的「配售结果公告」PDF（有此链接＝配售结果已公布），
                # 一并存下：工坊里给个可点的 ↗，老板能自己核对超购倍数。
                au = (by.get(code) or {}).get("allotment_pdf_url")
                if au:
                    row["allotUrl"] = au
                ok += 1
                print("  ✅ %s 基石 %s美元/%s股 绿鞋=%s (%d页, %s)" %
                      (code, r.get("usd"), r.get("shares"), r.get("hasGreen"),
                       r.get("pages") or 0, r.get("src")))
    # meta 统计按**文件整体**重算，而不是只算本次抓的那几只 ——
    # 否则跑一次 `--codes` 局部抓取就会把 117 只的统计改成 "0/3"。
    allpros = [(s.get("pros") or {}) for s in stocks.values()]
    data.setdefault("meta", {})["prospectus"] = {
        "source": "站点挂链的招股章程 PDF（hkexnews 托管）",
        "fetched": time.strftime("%Y-%m-%d"),
        "ok": sum(1 for p in allpros if p and not p.get("err")),
        "total": sum(1 for p in allpros if p),
        "fromSite": sum(1 for p in allpros if p.get("src") == "i668.prospectus_url"),
    }
    write_extras(data)
    print("完成：成功 %d / %d，已写入 data/extras.js" % (ok, len(codes)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
