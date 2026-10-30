/**
 * Levels.gs — TBCL 七級與 TOCFL 對應、各級數量與文本特徵。
 *
 * 依據（資料查核 2026-10，正式文件引用前請再對官網）：
 *   - TBCL 各級漢字、詞語、語法點累計數：國教院技術報告與 TBCL 官網（詞數依詞表版本微調，以匯入的詞表為準）。
 *   - TBCL ↔ TOCFL：華測會與國教院的對應研究；TOCFL 成績單自 2021-08 起附 TBCL 等級。
 *     此為「整體對應」，官方對照圖依聽、讀、寫分開呈現，逐技能可能錯開一級。
 *   - sentLenGuide（建議平均句長上限，漢字數）：編者經驗值，非官方標準，可依教材調整。
 */
var GR_LEVELS = [
  { level: 1, band: '基礎', tocfl: '準備級', tocflEn: 'Novice 1–2', cefr: 'Pre-A1',
    cumWords: 401, cumChars: 246, cumGrammar: 15, sentLenGuide: 8,
    textType: '單詞、固定短語、極短問答',
    performance: '理解並運用與個人生活相關的簡單字詞：數字、價錢、時間、國籍、家庭；問候、感謝、道歉' },
  { level: 2, band: '基礎', tocfl: '入門級', tocflEn: 'Level 1', cefr: 'A1',
    cumWords: 804, cumChars: 504, cumGrammar: 107, sentLenGuide: 10,
    textType: '短句、簡短對話',
    performance: '運用生活相關的字詞與短句處理日常即時需求（購物、飲食、交通、作息）' },
  { level: 3, band: '基礎', tocfl: '基礎級', tocflEn: 'Level 2', cefr: 'A2',
    cumWords: 1265, cumChars: 801, cumGrammar: 241, sentLenGuide: 13,
    textType: '完整句子、簡短段落',
    performance: '以簡單完整的句子介紹身邊的人、地、事物與活動；簡單敘述經歷；從傳單、菜單、海報擷取基本訊息' },
  { level: 4, band: '進階', tocfl: '進階級', tocflEn: 'Level 3', cefr: 'B1',
    cumWords: 2685, cumChars: 1300, cumGrammar: 390, sentLenGuide: 17,
    textType: '連貫段落',
    performance: '就熟悉的生活、學習、工作話題成段敘述與說明；理解結構清楚的段落' },
  { level: 5, band: '進階', tocfl: '高階級', tocflEn: 'Level 4', cefr: 'B2',
    cumWords: 5322, cumChars: 1900, cumGrammar: 496, sentLenGuide: 22,
    textType: '組織完整的篇章',
    performance: '理解多種主題篇章所表達的觀點；以組織完整的篇章表達觀點與評論' },
  { level: 6, band: '精熟', tocfl: '流利級', tocflEn: 'Level 5', cefr: 'C1',
    cumWords: 9473, cumChars: 2500, cumGrammar: null, sentLenGuide: 28,
    textType: '長篇、多段落論述；抽象、專業與社會議題',
    performance: '處理抽象、專業與社會議題；摘要、比較、論證；語體轉換' },
  { level: 7, band: '精熟', tocfl: '精通級', tocflEn: 'Level 6', cefr: 'C2',
    cumWords: 14470, cumChars: 3100, cumGrammar: null, sentLenGuide: null,
    textType: '專業與學術篇章、書面語',
    performance: '在專業與學術情境中精確、得體地理解與表達，掌握書面語與文化意涵' }
];

/** 讀本用途 → 可理解覆蓋率門檻（第二語言閱讀研究經驗值，非官方標準）。 */
var GR_PURPOSES = {
  extensive: { label: '分級讀本／泛讀', threshold: 0.98 },
  intensive: { label: '教師帶領的精讀課文', threshold: 0.95 }
};

/** 學習者設定（寫進提示詞，影響改寫策略）。 */
var GR_LEARNERS = {
  adult_nonchar: '成人，非漢字圈，在臺學習',
  adult_char: '成人，漢字圈（日、韓等），在臺學習',
  overseas: '成人，海外學習，臺灣生活情境需稍加說明',
  child: '兒童（7–12 歲），句子更短、圖像支援、避免抽象詞'
};

function grLevelInfo(level) {
  for (var i = 0; i < GR_LEVELS.length; i++) if (GR_LEVELS[i].level === level) return GR_LEVELS[i];
  return null;
}

/** 「TBCL 第 3 級（基礎）｜TOCFL 基礎級（Level 2，CEFR A2）」 */
function grLevelLabel(level) {
  var L = grLevelInfo(level);
  if (!L) return '—';
  return 'TBCL 第 ' + L.level + ' 級（' + L.band + '）｜TOCFL ' + L.tocfl + '（' + L.tocflEn + '，CEFR ' + L.cefr + '）';
}
