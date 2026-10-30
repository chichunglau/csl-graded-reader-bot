"""產生 apps-script/Phonetics.gs：Big5 常用字中的多音字讀音順序（對應 ToneOZ IVS 選擇器），以帶調號的漢語拼音表示。
用法：python3 dev/gen_phonic.py <toneoz-font-zhuyin 目錄> apps-script/Phonetics.gs
需要 fontTools（pip install fonttools），用 ToneOZ-Zhuyin-Kai-Traditional 的 cmap14 核對讀音數量。"""
import json, sys, pathlib
from fontTools.ttLib import TTFont
repo, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
table = {}
for ln in (repo / 'phonetic' / 'phonic_table_Z.txt').read_text(encoding='utf-8').splitlines():
    cols = ln.split('\t')
    if cols and cols[0]:
        table[cols[0]] = [c.strip() for c in cols[1:] if c.strip()]
font = TTFont(repo / 'fonts' / 'woff' / 'ToneOZ-Zhuyin-Kai-Traditional.woff', lazy=True)
uvs = [t for t in font['cmap'].tables if t.format == 14][0].uvsDict
have = {}
for vs, lst in uvs.items():
    for u, _ in lst:
        have.setdefault(u, set()).add(vs)
def common(c):
    try:
        b = c.encode('big5')
    except Exception:
        return False
    return len(b) == 2 and 0xA440 <= int.from_bytes(b, 'big') <= 0xC67E
keep = {c: r for c, r in table.items()
        if len(r) > 1 and common(c) and {0xE01E0 + i for i in range(len(r))} <= have.get(ord(c), set())}
# 注音 → 數字調拼音（ToneOZ phonetic/phonic_types.txt）→ 帶調號拼音
z2n = {}
for ln in (repo / 'phonetic' / 'phonic_types.txt').read_text(encoding='utf-8').splitlines():
    a = ln.split('\t')
    if len(a) >= 2 and a[0] and a[1]:
        z2n.setdefault(a[0].strip(), a[1].strip().lower())
MARK = {'a': 'āáǎà', 'e': 'ēéěè', 'i': 'īíǐì', 'o': 'ōóǒò', 'u': 'ūúǔù', 'ü': 'ǖǘǚǜ'}
def marked(num):
    base, tone = num[:-1].replace('v', 'ü').replace('u:', 'ü'), int(num[-1])
    if tone == 5 or tone == 0:
        return base
    if 'a' in base: i = base.index('a')
    elif 'e' in base: i = base.index('e')
    elif 'ou' in base: i = base.index('o')
    else: i = max(base.rfind(v) for v in 'iouü')
    return base[:i] + MARK[base[i]][tone - 1] + base[i + 1:]
missing = set()
def to_py(z):
    n = z2n.get(z)
    if not n: missing.add(z); return None
    return marked(n)
conv = {}
for c, r in keep.items():
    py = [to_py(z) for z in r]
    if all(py): conv[c] = py
if missing: print('無法轉換的注音（該字略過）：', sorted(missing)[:20])
keep = conv
data = '\n'.join(c + ','.join(r) for c, r in sorted(keep.items()))
out.write_text('''/**
 * Phonetics.gs — 多音字讀音順序，供 ToneOZ 拼音／注音字型自動選音
 *
 * ToneOZ 字型用「表意文字變體選擇器」(IVS) 決定多音字顯示哪個讀音：字本身顯示第 0 個（預設）讀音，
 * 字後面接 U+E01E0＋i（i ≥ 1）顯示第 i 個讀音；字＋U+E01E0 則是不顯示標音。
 * 讀音以帶調號的漢語拼音表示（輕聲不標調）；程式依 TBCL「參考漢語拼音」找出 i，
 * 所以詞表內的詞（例如「慢慢地」的「地」、「睡著」的「著」）會顯示正確讀音。
 *
 * 資料來源：ToneOZ toneoz-font-zhuyin 專案 phonetic/phonic_table_Z.txt，
 *   源自 But Ko〈注音IVS字型規格〉https://github.com/ButTaiwan/bpmfvs
 *   Copyright 2020 But Ko，Apache License 2.0（http://www.apache.org/licenses/LICENSE-2.0）
 * 修改：只保留 Big5 常用字中有兩個以上讀音、且讀音數與 ToneOZ-Zhuyin-Kai-Traditional 的 cmap14 一致的 %d 字；
 *   注音依同專案 phonetic/phonic_types.txt 轉成漢語拼音；格式改為一行一字「字＋讀音（逗號分隔）」。由 dev/gen_phonic.py 產生。
 */
var GR_PHONIC = %s;
/** 合法的漢語拼音音節（不含聲調，ü 寫作 v），用來切分連寫的 TBCL 參考漢語拼音。 */
var GR_PY_SYLLABLES = %s;
''' % (len(keep), json.dumps(data, ensure_ascii=False), json.dumps(' '.join(sorted({n[:-1].replace('u:', 'v') for n in z2n.values()}, key=lambda x: (len(x), x))), ensure_ascii=False)), encoding='utf-8')
print(len(keep), 'chars ->', out, out.stat().st_size, 'bytes')
