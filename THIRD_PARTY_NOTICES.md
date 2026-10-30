# 第三方資料與字型授權

## 多音字讀音表（apps-script/Phonetics.gs）

- 來源：ToneOZ〈toneoz-font-zhuyin〉專案 `phonetic/phonic_table_Z.txt`（https://github.com/jeffreyxuan/toneoz-font-zhuyin），其資料源自 But Ko〈注音IVS字型規格〉（https://github.com/ButTaiwan/bpmfvs）。
- 授權：Apache License 2.0。Copyright 2020 But Ko。全文：http://www.apache.org/licenses/LICENSE-2.0
- 修改：只保留 Big5 常用字中有兩個以上讀音、且讀音數與 ToneOZ-Zhuyin-Kai-Traditional 字型 cmap14 一致的 2,328 字；改為一行一字的格式。由 `dev/gen_phonic.py` 產生。

## ToneOZ 字型（本專案不附字型檔，只引用網址或由學校自行提供）

- 澳聲通拼音庫楷－繁、澳聲通注音庫楷－繁，作者 ToneOZ（https://toneoz.com/），免費商用授權。
- 漢字部分：全字庫正楷體，政府資料開放授權條款第 1 版（Open Government Data License, version 1.0，https://data.gov.tw/en/licenses）。
- 拼音及非漢字部分：FONTWORKS Klee One、LXGW 霞鶩文楷，SIL Open Font License 1.1。
- 注音部分：源流明體注音（But Ko〈注音IVS字型規格〉），Apache License 2.0。
- 使用 `dev/subset_toneoz.py` 縮小或轉檔後再散布時，請保留上述授權說明與原作者標示。

## 字形與用語對照（apps-script/Assets.gs）

取自 taiwan-huayu-materials 技能的對照表，可在試算表「用語對照」分頁增補。

## 介面字型

Noto Sans／Noto Serif 系列、LXGW WenKai TC 經 Google Fonts 載入，SIL Open Font License 1.1。
