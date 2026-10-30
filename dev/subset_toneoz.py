"""把 ToneOZ 拼音／注音字型縮成網頁用檔案（Big5 常用字 5,401 字＋標點＋英數，保留 IVS 多音字）。
用法：python3 dev/subset_toneoz.py ToneOZ-Pinyin-Kai-Traditional.ttf ToneOZ-Pinyin-Kai-TC-web.woff
需要 fontTools（pip install fonttools）；裝了 brotli 時可把輸出檔名改成 .woff2，檔案更小。
實測：ToneOZ-Zhuyin-Kai-Traditional 31 MB（TTF）→ 約 4 MB（WOFF）。
注意：輸出檔仍適用原字型的授權（全字庫 OGDL 1.0、SIL OFL 1.1、Apache 2.0），請一併保留授權說明。"""
import sys, tempfile, os
from fontTools import subset
src, dst = sys.argv[1], sys.argv[2]
chars = []
for b1 in range(0xA4, 0xC7):
    for b2 in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
        if 0xA440 <= b1 * 256 + b2 <= 0xC67E:
            try:
                chars.append(bytes([b1, b2]).decode('big5'))
            except UnicodeDecodeError:
                pass
chars += list('，。、；：？！「」『』（）《》〈〉…—．·～０１２３４５６７８９') + [chr(c) for c in range(0x20, 0x7F)]
with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False, encoding='utf-8') as f:
    f.write(''.join(chars))
flavor = 'woff2' if dst.endswith('.woff2') else 'woff'
subset.main([src, '--text-file=' + f.name, '--unicodes=U+E01E0-E01EF', '--layout-features=', '--name-IDs=*',
             '--flavor=' + flavor, '--output-file=' + dst])
os.unlink(f.name)
print(dst, round(os.path.getsize(dst) / 1e6, 1), 'MB')
