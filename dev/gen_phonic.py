"""產生 apps-script/Phonetics.gs：Big5 常用字中的多音字讀音順序（對應 ToneOZ IVS 選擇器）。
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
data = '\n'.join(c + ','.join(r) for c, r in sorted(keep.items()))
out.write_text('''/**
 * Phonetics.gs — 多音字讀音順序，供 ToneOZ 拼音／注音字型自動選音
 *
 * ToneOZ 字型用「表意文字變體選擇器」(IVS) 決定多音字顯示哪個讀音：字本身顯示第 0 個（預設）讀音，
 * 字後面接 U+E01E0＋i（i ≥ 1）顯示第 i 個讀音；字＋U+E01E0 則是不顯示標音。程式依 TBCL「參考注音」找出 i，
 * 所以詞表內的詞（例如「慢慢地」的「地」、「睡著」的「著」）會顯示正確讀音。
 *
 * 資料來源：ToneOZ toneoz-font-zhuyin 專案 phonetic/phonic_table_Z.txt，
 *   源自 But Ko〈注音IVS字型規格〉https://github.com/ButTaiwan/bpmfvs
 *   Copyright 2020 But Ko，Apache License 2.0（http://www.apache.org/licenses/LICENSE-2.0）
 * 修改：只保留 Big5 常用字中有兩個以上讀音、且讀音數與 ToneOZ-Zhuyin-Kai-Traditional 的 cmap14 一致的 %d 字；
 *   格式改為一行一字「字＋讀音（逗號分隔）」。由 dev/gen_phonic.py 產生。
 */
var GR_PHONIC = %s;
''' % (len(keep), json.dumps(data, ensure_ascii=False)), encoding='utf-8')
print(len(keep), 'chars ->', out, out.stat().st_size, 'bytes')
