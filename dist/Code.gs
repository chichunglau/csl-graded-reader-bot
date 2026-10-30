/**
 * 分級讀本調級機器人 v1.4.0（合併版，由 dev/build_dist.js 產生）
 * 貼進 Apps Script 的「程式碼.gs」。另需 Index.html、I18n.html 與 appsscript.json。
 * 各段原始檔見 GitHub 專案的 apps-script/ 資料夾。
 */

// ================================================================ Config.gs
/**
 * Config.gs — 設定集中處
 *
 * 敏感資訊（API 金鑰、權杖）一律放「專案設定 → 指令碼屬性」，不要寫在程式碼裡。
 *
 * 指令碼屬性一覽（有預設值者可不填）：
 *   SHEET_ID              資料試算表 ID（執行 setupProject 會自動寫入）
 *   TBCL_VERSION_LABEL    詞表版本標示，會寫進報告，例如「合併7級TBCL詞語表_112_05_17」
 *   LLM_PROVIDER          anthropic（預設）｜openai｜gemini｜custom｜none
 *   ANTHROPIC_API_KEY     Claude API 金鑰
 *   ANTHROPIC_MODEL       預設 claude-sonnet-5-5（追求速度與成本可改 claude-haiku-5-5）
 *   OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL     預留
 *   GEMINI_API_KEY / GEMINI_MODEL                        預留
 *   CUSTOM_LLM_URL / CUSTOM_LLM_TOKEN                    預留：學校自建或代理端點
 *   LLM_MAX_TOKENS        每段輸出上限，預設 4000
 *   SEGMENT_CHARS         每段漢字數，預設 600。Apps Script 單一外部請求約 60 秒就會中斷，
 *                         長文因此切段平行送出；若仍出現逾時，調小此值或改用 claude-haiku-5-5
 *   MAX_ROUNDS            改寫＋驗證最多幾輪，預設 2
 *   MAX_CHARS             單次調整的漢字上限，預設 3000（長篇讀本請分章）
 *   DAILY_LIMIT           每日 LLM 呼叫上限（全站合計，每段算一次），預設 300
 *   API_TOKEN             對外 API（doPost）權杖；setupProject 會自動產生
 *   UI_DEFAULT_LANG       介面預設語言（zh-Hant、en、ja、ko、vi、id、th、fil、ms、my、km、lo、hi、ne、bn、si）；
 *                         留空＝依瀏覽器語言自動判斷。網址加 ?lang=vi 可指定，方便 Google Sites 各語言頁面分開嵌入。
 *   TONEOZ_PINYIN_URL     ToneOZ 拼音庫楷-繁 的網頁字型網址（.woff2／.woff／.ttf，需允許跨網域）；留空＝只用電腦已安裝的字型
 *   TONEOZ_ZHUYIN_URL     ToneOZ 注音庫楷-繁 的網頁字型網址；預設為官方 GitHub 專案經 jsDelivr 提供的 WOFF（約 16 MB）
 */
var GR_CONFIG = {
  version: '1.4.0',
  sheets: {
    guide: '說明',
    words: 'TBCL詞語',
    chars: 'TBCL漢字',
    grammar: 'TBCL語法點',
    proper: '專名',
    terms: '用語對照',
    log: '執行紀錄',
    i18n: '介面翻譯'
  },
  defaults: {
    LLM_PROVIDER: 'anthropic',
    ANTHROPIC_MODEL: 'claude-sonnet-5-5',
    ANTHROPIC_VERSION: '2026-10-21',     // 此版本已移除 temperature／top_p／top_k，請勿加入這些參數
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    LLM_MAX_TOKENS: 4000,
    SEGMENT_CHARS: 600,
    MAX_ROUNDS: 2,
    MAX_CHARS: 3000,
    DAILY_LIMIT: 300,
    ANALYZE_MAX_CHARS: 60000,
    UI_DEFAULT_LANG: '',
    TONEOZ_PINYIN_URL: '',
    TONEOZ_ZHUYIN_URL: 'https://cdn.jsdelivr.net/gh/jeffreyxuan/toneoz-font-zhuyin@ff3e9ab275f744557b56ba2f9bf1eb2753a9e457/fonts/woff/ToneOZ-Zhuyin-Kai-Traditional.woff'
  },
  cacheSeconds: 21600                     // CacheService 上限 6 小時
};

function prop_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (v === null || v === '') {
    if (fallback !== undefined) return fallback;
    return GR_CONFIG.defaults.hasOwnProperty(key) ? GR_CONFIG.defaults[key] : '';
  }
  return v;
}

function propInt_(key) {
  var n = parseInt(prop_(key), 10);
  return isNaN(n) ? GR_CONFIG.defaults[key] : n;
}


// ================================================================ Levels.gs
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

/**
 * TOCFL 四等八級（華測會現行架構）。tbcl＝整體對應的 TBCL 等級。
 * 準備一級與準備二級都對應 TBCL 第 1 級；本工具以 TBCL 第 1 級詞表的子級區分：
 *   準備一級只用標示「第1級」的詞，標示「第1*級」的詞（第 1 級後段）視為超綱，句長也更短；
 *   準備二級可用整個第 1 級。此區分是本工具的編修慣例，不是華測會或國教院公布的對應。
 */
var GR_TOCFL = [
  { stop: 0, code: 'Novice 1', name: '準備一級', bandName: '準備級', cefr: 'Pre-A1', tbcl: 1, strictStar: true, sentLenGuide: 6 },
  { stop: 1, code: 'Novice 2', name: '準備二級', bandName: '準備級', cefr: 'Pre-A1', tbcl: 1, strictStar: false, sentLenGuide: 8 },
  { stop: 2, code: 'A1', name: '入門級', bandName: '入門基礎級', cefr: 'A1', tbcl: 2, en: 'Level 1' },
  { stop: 3, code: 'A2', name: '基礎級', bandName: '入門基礎級', cefr: 'A2', tbcl: 3, en: 'Level 2' },
  { stop: 4, code: 'B1', name: '進階級', bandName: '進階高階級', cefr: 'B1', tbcl: 4, en: 'Level 3' },
  { stop: 5, code: 'B2', name: '高階級', bandName: '進階高階級', cefr: 'B2', tbcl: 5, en: 'Level 4' },
  { stop: 6, code: 'C1', name: '流利級', bandName: '流利精通級', cefr: 'C1', tbcl: 6, en: 'Level 5' },
  { stop: 7, code: 'C2', name: '精通級', bandName: '流利精通級', cefr: 'C2', tbcl: 7, en: 'Level 6' }
];

/** 接受 0–7、'N1'、'Novice 1'、'A2'… → 0–7；認不出回傳 -1。 */
function grParseTocfl(v) {
  if (v === null || v === undefined || v === '') return -1;
  if (typeof v === 'number' || /^\d$/.test(String(v))) { var n = parseInt(v, 10); return n >= 0 && n <= 7 ? n : -1; }
  var s = String(v).replace(/\s+/g, '').toUpperCase().replace('NOVICE', 'N');
  return ['N1', 'N2', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'].indexOf(s);
}

/** 只給 TBCL 等級時的預設 TOCFL 級：第 1 級 → 準備二級，其餘一對一。 */
function grStopOfTbcl(level) { return level <= 1 ? 1 : Math.min(7, level); }

/** 「TBCL 第 1 級（基礎）｜TOCFL 準備一級（Novice 1，Pre-A1）」 */
function grTargetLabel(stop) {
  var T = GR_TOCFL[stop], L = grLevelInfo(T.tbcl);
  return 'TBCL 第 ' + L.level + ' 級（' + L.band + (T.strictStar ? '，不含 1* 詞' : '') + '）｜TOCFL ' + T.name + '（' + T.code + '，CEFR ' + T.cefr + '）';
}


// ================================================================ Assets.gs
/**
 * Assets.gs — 內建字形與用語對照（取自 taiwan-huayu-materials 技能 assets，可在試算表「用語對照」分頁增補）
 * cnTwTerms：大陸用語\t臺灣常用\t備註；variants：非標準字形\t標準字形\t備註；
 * sharedChars：臺灣也通用的簡化字（偵測簡體時不標記）；t2s：正體\t簡體（多個以 | 分隔）。
 * 此檔由 dev/gen_assets.py 產生。
 */
var GR_ASSETS = {
  "cnTwTerms": "出租車\t計程車\n打的去\t坐計程車去\t「打的」為大陸口語；臺灣說坐計程車、叫車\n打個的\t叫一臺計程車\n地鐵\t捷運\t臺灣都會軌道系統多稱捷運；指一般地下鐵路時「地鐵」亦可\n公交\t公車\t含「公交車」\n自行車\t腳踏車／單車\tTBCL 亦收「自行車」；口語多說腳踏車\n摩托車\t機車\t「機車」在臺灣口語另有「難相處」義\n空調\t冷氣\n衛生間\t洗手間／廁所\n服務員\t服務生／店員\n營業員\t店員\n售貨員\t店員\n便利店\t便利商店／超商\n軟件\t軟體\n硬件\t硬體\n視頻\t影片／視訊\t視訊通話用「視訊」\n網絡\t網路\n互聯網\t網際網路／網路\n鼠標\t滑鼠\n屏幕\t螢幕\n打印\t列印\t含「打印機」→印表機\nU盤\t隨身碟\n優盤\t隨身碟\n短信\t簡訊\n博客\t部落格\n激光\t雷射\n智能\t智慧\t「智能手機」→智慧型手機\n筆記本電腦\t筆記型電腦／筆電\t「筆記本」單用指本子時兩岸相同\n台式電腦\t桌上型電腦\n文件夾\t資料夾\n默認\t預設\n激活\t啟用\n登錄\t登入\t臺灣「登錄」多指登記、記錄\n帖子\t貼文\n屏蔽\t封鎖\n音頻\t音訊／音檔\n點贊\t按讚\n網民\t網友\n充電寶\t行動電源\n二維碼\tQR code\n性價比\tCP 值\n信息\t訊息／資訊\t依語境選用\n質量\t品質\t臺灣「質量」多指物理學的質量（mass）\n土豆\t馬鈴薯\t臺灣「土豆」常指花生\n西紅柿\t番茄\n菠蘿\t鳳梨\n獼猴桃\t奇異果\n番石榴\t芭樂\n三文魚\t鮭魚\n金槍魚\t鮪魚\n酸奶\t優格／優酪乳\n冰激凌\t冰淇淋\n冰棍\t冰棒\n方便麵\t泡麵\n盒飯\t便當\n外賣\t外送／外帶\tdelivery 用外送，takeaway 用外帶\n食堂\t餐廳／學生餐廳\n小區\t社區\n本科\t大學部\t「本科生」→大學生\n考研\t考研究所\n高考\t大學入學考試\t臺灣「高考」指公務人員高等考試；升大學為學測、分科測驗等\n課件\t教學簡報／講義\n身份證\t身分證\t臺灣正式寫法為「身分證」\n人民幣\t新臺幣\t情境設在臺灣時\n普通話\t華語／國語\t教學語境多稱華語，日常多稱國語\n漢語\t華語／中文\t臺灣教材多用華語、中文\n愛人\t配偶／太太／先生\t臺灣「愛人」多指情人\n靠譜\t可靠\n溜達\t散步／逛逛\n地道\t道地\t臺灣「地道」多指地下道；表示 authentic 用「道地」\n啥\t什麼\n咋\t怎麼\n甭\t不用\n新西蘭\t紐西蘭\t國名音譯\n意大利\t義大利\t含「意大利麵」→義大利麵\n悉尼\t雪梨\t地名音譯\n老撾\t寮國\t國名\n文萊\t汶萊\t國名\n肯尼亞\t肯亞\t國名\n尼日利亞\t奈及利亞\t國名\n坦桑尼亞\t坦尚尼亞\t國名\n沙特阿拉伯\t沙烏地阿拉伯\t國名\n迪拜\t杜拜\t地名\n馬爾代夫\t馬爾地夫\t國名\n也門\t葉門\t國名\n危地馬拉\t瓜地馬拉\t國名\n洪都拉斯\t宏都拉斯\t國名\n特朗普\t川普\t人名音譯\n奧巴馬\t歐巴馬\t人名音譯",
  "variants": "着\t著\t「着」為簡化字／舊字形；臺灣作「著」（看著、著名）\n裏\t裡\t教育部標準作「裡」；TBCL 詞表兼收「裏」，全書統一即可\n爲\t為\t舊字形\n衞\t衛\t舊字形\n羣\t群\t異體\n衆\t眾\t舊字形\n綫\t線\t港式用字\n峯\t峰\t異體\n啓\t啟\t舊字形\n牀\t床\t異體\n麪\t麵\t異體\n鷄\t雞\t異體\n敎\t教\t舊字形\n眞\t真\t舊字形\n擧\t舉\t舊字形\n舖\t鋪\t異體\n綉\t繡\t異體\n説\t說\t日港字形（Unicode 不同碼位）\n麽\t麼\t異體\n囘\t回\t異體\n淸\t清\t舊字形\n靑\t青\t舊字形\n緖\t緒\t舊字形\n吿\t告\t舊字形\n戸\t戶\t日本字形\n歩\t步\t日本字形\n経\t經\t日本字形\n売\t賣\t日本字形\n台\t臺\t資訊：教育部標準字為「臺」，「台」為通行字；全書統一即可",
  "sharedChars": "丑了于云伙余党准几凶划制千卷只台吁后向周咨喂回困布干征志才扎斗朴松板注涂游系胡致舍范表谷郁采里霉面",
  "t2s": "們\t们\n這\t这\n個\t个\n來\t来\n說\t说\n為\t为\n時\t时\n會\t会\n過\t过\n對\t对\n發\t发\n髮\t发\n沒\t没\n麼\t么\n還\t还\n進\t进\n樣\t样\n經\t经\n現\t现\n實\t实\n動\t动\n頭\t头\n兩\t两\n問\t问\n長\t长\n給\t给\n讓\t让\n開\t开\n關\t关\n電\t电\n話\t话\n門\t门\n車\t车\n東\t东\n買\t买\n賣\t卖\n書\t书\n學\t学\n習\t习\n題\t题\n認\t认\n識\t识\n讀\t读\n寫\t写\n語\t语\n詞\t词\n請\t请\n謝\t谢\n見\t见\n觀\t观\n覺\t觉\n視\t视\n聽\t听\n講\t讲\n記\t记\n計\t计\n論\t论\n設\t设\n試\t试\n該\t该\n誰\t谁\n調\t调\n談\t谈\n課\t课\n錯\t错\n錢\t钱\n銀\t银\n鐵\t铁\n鐘\t钟\n鍾\t钟\n鏡\t镜\n鍋\t锅\n飯\t饭\n飲\t饮\n館\t馆\n雞\t鸡\n鳥\t鸟\n魚\t鱼\n馬\t马\n駕\t驾\n騎\t骑\n號\t号\n層\t层\n歲\t岁\n廣\t广\n應\t应\n慶\t庆\n庫\t库\n廳\t厅\n廁\t厕\n歷\t历\n曆\t历\n壓\t压\n廠\t厂\n縣\t县\n鄉\t乡\n區\t区\n醫\t医\n華\t华\n單\t单\n衛\t卫\n軍\t军\n農\t农\n決\t决\n況\t况\n減\t减\n涼\t凉\n淨\t净\n凈\t净\n務\t务\n勞\t劳\n勢\t势\n辦\t办\n網\t网\n絡\t络\n軟\t软\n頻\t频\n腦\t脑\n機\t机\n場\t场\n飛\t飞\n線\t线\n紅\t红\n綠\t绿\n藍\t蓝\n黃\t黄\n總\t总\n結\t结\n紙\t纸\n級\t级\n組\t组\n織\t织\n練\t练\n終\t终\n紹\t绍\n續\t续\n細\t细\n絕\t绝\n統\t统\n絲\t丝\n紀\t纪\n約\t约\n納\t纳\n純\t纯\n紛\t纷\n紋\t纹\n紐\t纽\n維\t维\n綜\t综\n編\t编\n緩\t缓\n縮\t缩\n績\t绩\n繼\t继\n繩\t绳\n緊\t紧\n縱\t纵\n繞\t绕\n繪\t绘\n綱\t纲\n緒\t绪\n緣\t缘\n纖\t纤\n紡\t纺\n絨\t绒\n綿\t绵\n縫\t缝\n繳\t缴\n纏\t缠\n繡\t绣\n纜\t缆\n糾\t纠\n愛\t爱\n邊\t边\n變\t变\n賓\t宾\n補\t补\n產\t产\n嘗\t尝\n嚐\t尝\n償\t偿\n徹\t彻\n塵\t尘\n陳\t陈\n稱\t称\n遲\t迟\n齒\t齿\n蟲\t虫\n處\t处\n傳\t传\n闖\t闯\n創\t创\n從\t从\n叢\t丛\n達\t达\n帶\t带\n擔\t担\n當\t当\n噹\t当\n導\t导\n燈\t灯\n鄧\t邓\n敵\t敌\n遞\t递\n點\t点\n釣\t钓\n頂\t顶\n凍\t冻\n獨\t独\n斷\t断\n隊\t队\n噸\t吨\n奪\t夺\n惡\t恶\n兒\t儿\n爾\t尔\n罰\t罚\n廢\t废\n費\t费\n風\t风\n豐\t丰\n鳳\t凤\n婦\t妇\n復\t复\n複\t复\n蓋\t盖\n趕\t赶\n剛\t刚\n鋼\t钢\n崗\t岗\n鞏\t巩\n貢\t贡\n溝\t沟\n構\t构\n購\t购\n夠\t够\n顧\t顾\n慣\t惯\n歸\t归\n龜\t龟\n規\t规\n貴\t贵\n國\t国\n漢\t汉\n護\t护\n畫\t画\n懷\t怀\n壞\t坏\n歡\t欢\n環\t环\n換\t换\n揮\t挥\n輝\t辉\n匯\t汇\n彙\t汇\n夥\t伙\n貨\t货\n獲\t获\n穫\t获\n積\t积\n極\t极\n際\t际\n濟\t济\n夾\t夹\n價\t价\n堅\t坚\n監\t监\n簡\t简\n劍\t剑\n艦\t舰\n鍵\t键\n將\t将\n獎\t奖\n醬\t酱\n膠\t胶\n澆\t浇\n驕\t骄\n腳\t脚\n攪\t搅\n餃\t饺\n階\t阶\n節\t节\n潔\t洁\n屆\t届\n僅\t仅\n儘\t尽\n盡\t尽\n驚\t惊\n靜\t静\n舊\t旧\n舉\t举\n劇\t剧\n據\t据\n懼\t惧\n凱\t凯\n殼\t壳\n懇\t恳\n誇\t夸\n塊\t块\n寬\t宽\n礦\t矿\n虧\t亏\n擴\t扩\n蘭\t兰\n攔\t拦\n欄\t栏\n籃\t篮\n覽\t览\n懶\t懒\n爛\t烂\n樂\t乐\n類\t类\n淚\t泪\n離\t离\n禮\t礼\n厲\t厉\n麗\t丽\n輛\t辆\n療\t疗\n鄰\t邻\n臨\t临\n靈\t灵\n嶺\t岭\n劉\t刘\n龍\t龙\n樓\t楼\n蘆\t芦\n爐\t炉\n陸\t陆\n錄\t录\n驢\t驴\n慮\t虑\n亂\t乱\n羅\t罗\n蘿\t萝\n邏\t逻\n嗎\t吗\n媽\t妈\n罵\t骂\n麥\t麦\n滿\t满\n貿\t贸\n夢\t梦\n彌\t弥\n廟\t庙\n滅\t灭\n鳴\t鸣\n謀\t谋\n畝\t亩\n難\t难\n鬧\t闹\n膩\t腻\n寧\t宁\n濃\t浓\n歐\t欧\n盤\t盘\n龐\t庞\n賠\t赔\n噴\t喷\n騙\t骗\n飄\t飘\n蘋\t苹\n憑\t凭\n評\t评\n撲\t扑\n鋪\t铺\n齊\t齐\n啟\t启\n氣\t气\n棄\t弃\n淺\t浅\n槍\t枪\n牆\t墙\n搶\t抢\n橋\t桥\n喬\t乔\n竅\t窍\n親\t亲\n輕\t轻\n傾\t倾\n窮\t穷\n驅\t驱\n趨\t趋\n權\t权\n勸\t劝\n確\t确\n擾\t扰\n熱\t热\n榮\t荣\n潤\t润\n灑\t洒\n傘\t伞\n喪\t丧\n掃\t扫\n殺\t杀\n紗\t纱\n曬\t晒\n傷\t伤\n賞\t赏\n燒\t烧\n攝\t摄\n紳\t绅\n審\t审\n聲\t声\n勝\t胜\n聖\t圣\n濕\t湿\n溼\t湿\n詩\t诗\n師\t师\n飾\t饰\n適\t适\n釋\t释\n壽\t寿\n獸\t兽\n輸\t输\n樹\t树\n數\t数\n帥\t帅\n雙\t双\n順\t顺\n碩\t硕\n訴\t诉\n蘇\t苏\n雖\t虽\n隨\t随\n孫\t孙\n損\t损\n態\t态\n攤\t摊\n灘\t滩\n嘆\t叹\n歎\t叹\n湯\t汤\n濤\t涛\n討\t讨\n體\t体\n條\t条\n圖\t图\n團\t团\n糰\t团\n襪\t袜\n彎\t弯\n灣\t湾\n萬\t万\n違\t违\n圍\t围\n偉\t伟\n聞\t闻\n穩\t稳\n無\t无\n霧\t雾\n戲\t戏\n蝦\t虾\n嚇\t吓\n鮮\t鲜\n閒\t闲\n閑\t闲\n顯\t显\n險\t险\n憲\t宪\n詳\t详\n響\t响\n項\t项\n協\t协\n脅\t胁\n興\t兴\n選\t选\n尋\t寻\n訓\t训\n訊\t讯\n鴨\t鸭\n亞\t亚\n嚴\t严\n鹽\t盐\n陽\t阳\n養\t养\n鑰\t钥\n藥\t药\n爺\t爷\n葉\t叶\n頁\t页\n業\t业\n儀\t仪\n遺\t遗\n億\t亿\n憶\t忆\n義\t义\n藝\t艺\n議\t议\n陰\t阴\n隱\t隐\n鷹\t鹰\n營\t营\n贏\t赢\n擁\t拥\n優\t优\n憂\t忧\n郵\t邮\n猶\t犹\n與\t与\n譽\t誉\n園\t园\n員\t员\n圓\t圆\n遠\t远\n願\t愿\n躍\t跃\n閱\t阅\n雲\t云\n運\t运\n雜\t杂\n災\t灾\n載\t载\n讚\t赞\n贊\t赞\n髒\t脏\n臟\t脏\n棗\t枣\n責\t责\n擇\t择\n則\t则\n賊\t贼\n閘\t闸\n戰\t战\n張\t张\n漲\t涨\n帳\t帐\n賬\t账\n趙\t赵\n偵\t侦\n陣\t阵\n鎮\t镇\n爭\t争\n證\t证\n鄭\t郑\n職\t职\n執\t执\n質\t质\n種\t种\n眾\t众\n軸\t轴\n晝\t昼\n豬\t猪\n燭\t烛\n囑\t嘱\n駐\t驻\n專\t专\n轉\t转\n賺\t赚\n莊\t庄\n裝\t装\n壯\t壮\n狀\t状\n準\t准\n資\t资\n鄒\t邹\n鑽\t钻\n後\t后\n裡\t里\n裏\t里\n臺\t台\n檯\t台\n颱\t台\n隻\t只\n係\t系\n繫\t系\n餘\t余\n鬆\t松\n範\t范\n捲\t卷\n錶\t表\n闆\t板\n鬍\t胡\n兇\t凶\n籲\t吁\n緻\t致\n週\t周\n徵\t征\n鬱\t郁\n製\t制\n捨\t舍\n穀\t谷\n醜\t丑\n幾\t几\n韆\t千\n衝\t冲\n沖\t冲\n並\t并\n樸\t朴\n誌\t志\n乾\t干\n幹\t干\n麵\t面\n瞭\t了\n纔\t才\n佈\t布\n採\t采\n迴\t回\n於\t于\n劃\t划\n註\t注\n紮\t扎\n餵\t喂\n諮\t咨\n遊\t游\n黨\t党\n須\t须\n鬚\t须\n嚮\t向\n睏\t困\n黴\t霉\n塗\t涂\n內\t内\n冊\t册\n別\t别\n戶\t户\n吳\t吴\n溫\t温\n強\t强\n呂\t吕\n稅\t税\n脫\t脱\n悅\t悦\n兌\t兑\n徑\t径\n搖\t摇\n銳\t锐\n訂\t订\n許\t许\n訪\t访\n誠\t诚\n誤\t误\n譯\t译\n謎\t谜\n諒\t谅\n諸\t诸\n謂\t谓\n誕\t诞\n詢\t询\n諾\t诺\n謊\t谎\n謹\t谨\n譜\t谱\n譏\t讥\n診\t诊\n誼\t谊\n謙\t谦\n謠\t谣\n誦\t诵\n誘\t诱\n詭\t诡\n詐\t诈\n訝\t讶\n辭\t辞\n銷\t销\n鎖\t锁\n針\t针\n釘\t钉\n鈔\t钞\n鉛\t铅\n鈴\t铃\n銅\t铜\n鋒\t锋\n鏈\t链\n鍛\t锻\n鑄\t铸\n鑑\t鉴\n鑒\t鉴\n鋁\t铝\n錫\t锡\n鑼\t锣\n鐮\t镰\n鉤\t钩\n錦\t锦\n鏽\t锈\n鈕\t钮\n餓\t饿\n餅\t饼\n飽\t饱\n饅\t馒\n飼\t饲\n饒\t饶\n饑\t饥\n飢\t饥\n餚\t肴\n閃\t闪\n閉\t闭\n閣\t阁\n闊\t阔\n閩\t闽\n闡\t阐\n驗\t验\n駛\t驶\n驟\t骤\n騷\t骚\n碼\t码\n螞\t蚂\n騰\t腾\n鯨\t鲸\n鵝\t鹅\n鴿\t鸽\n鶴\t鹤\n貝\t贝\n負\t负\n財\t财\n販\t贩\n貧\t贫\n貪\t贪\n賀\t贺\n賴\t赖\n贈\t赠\n賭\t赌\n賽\t赛\n貼\t贴\n敗\t败\n較\t较\n輪\t轮\n輔\t辅\n輯\t辑\n轟\t轰\n連\t连\n遷\t迁\n軌\t轨\n邁\t迈\n顏\t颜\n領\t领\n預\t预\n頓\t顿\n額\t额\n頸\t颈\n顆\t颗\n側\t侧\n備\t备\n儲\t储\n倆\t俩\n勵\t励\n參\t参\n寶\t宝\n屬\t属\n島\t岛\n幣\t币\n幫\t帮\n彈\t弹\n憐\t怜\n戀\t恋\n擊\t击\n擠\t挤\n擺\t摆\n攜\t携\n撿\t捡\n暫\t暂\n楊\t杨\n標\t标\n檢\t检\n櫃\t柜\n殘\t残\n毀\t毁\n測\t测\n烏\t乌\n煙\t烟\n獄\t狱\n獅\t狮\n癢\t痒\n盜\t盗\n盞\t盏\n睜\t睁\n矯\t矫\n礎\t础\n礙\t碍\n禍\t祸\n竊\t窃\n競\t竞\n筆\t笔\n築\t筑\n簽\t签\n籤\t签\n糧\t粮\n聯\t联\n聰\t聪\n肅\t肃\n膽\t胆\n臉\t脸\n術\t术\n觸\t触\n貓\t猫\n跡\t迹\n踐\t践\n蹤\t踪\n韓\t韩\n魯\t鲁\n濱\t滨\n蠶\t蚕\n鑿\t凿\n毆\t殴\n惱\t恼\n懲\t惩\n擬\t拟\n籠\t笼\n聾\t聋\n襲\t袭\n癡\t痴\n瘋\t疯\n盧\t卢\n顱\t颅\n濫\t滥\n艱\t艰\n寵\t宠\n壟\t垄\n澗\t涧\n瀏\t浏\n曠\t旷\n獻\t献\n勳\t勋\n犧\t牺\n漁\t渔\n嚨\t咙\n氫\t氢\n輩\t辈\n蕭\t萧\n廚\t厨\n櫥\t橱\n畢\t毕\n褲\t裤\n蔥\t葱\n薑\t姜\n鹹\t咸\n勻\t匀\n囉\t啰\n筍\t笋\n醃\t腌\n煉\t炼\n罷\t罢\n檔\t档\n湧\t涌\n滬\t沪\n滾\t滚\n漿\t浆\n潛\t潜\n濾\t滤\n煩\t烦\n燙\t烫\n獵\t猎\n異\t异\n瞞\t瞒\n窩\t窝\n簾\t帘\n羨\t羡\n膚\t肤\n臘\t腊\n艙\t舱\n艷\t艳\n螢\t萤\n蠟\t蜡\n襯\t衬\n豎\t竖\n寢\t寝\n峽\t峡\n恆\t恒\n慘\t惨\n憤\t愤\n拋\t抛\n掛\t挂\n揚\t扬\n擋\t挡\n敘\t叙\n曉\t晓\n暈\t晕\n棟\t栋\n橫\t横\n櫻\t樱\n澤\t泽\n磚\t砖\n腸\t肠\n薦\t荐\n撥\t拨\n劑\t剂\n卻\t却\n厭\t厌\n喚\t唤\n報\t报\n壺\t壶\n奧\t奥\n妝\t妆\n嬰\t婴\n齡\t龄\n著\t着|著"
};


// ================================================================ Phonetics.gs
/**
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
 * 修改：只保留 Big5 常用字中有兩個以上讀音、且讀音數與 ToneOZ-Zhuyin-Kai-Traditional 的 cmap14 一致的 2328 字；
 *   注音依同專案 phonetic/phonic_types.txt 轉成漢語拼音；格式改為一行一字「字＋讀音（逗號分隔）」。由 dev/gen_phonic.py 產生。
 */
var GR_PHONIC = "一yī,yí,yì,yi\n丁dīng,zhēng,ding\n七qī,qí\n丈zhàng,zhang\n三sān,sā,sàn\n上shàng,shǎng,shang,shāng\n下xià,xia\n不bù,bú,fōu,fū,bu,fǒu\n且qiě,jū\n並bìng,bàng,bīng\n中zhōng,zhòng\n串chuàn,guàn\n主zhǔ,zhu\n么yāo,me,mó,ma,má,mǒ,mì,mo,sī\n乎hū,hú,hu\n乖guāi,guai\n乘chéng,shèng\n乙yǐ,zhé\n乞qǐ,qì,qi\n乾gān,qián,gàn\n亂luàn,làn\n了le,liǎo,liào\n予yǔ,yú\n事shì,shi\n二èr,ér\n于yú,xū,wū\n亙gèn,gèng,hù,huán,xuān\n些xiē,suò,suō\n亞yà,yā,yǎ\n亟jí,qì\n亡wáng,wú\n亢kàng,gāng\n亨hēng,pēng,héng\n京jīng,yuán\n亮liàng,liáng,liang\n亳bò,bó\n人rén,ren\n什shén,shí,shé,shi\n仆pū,pú,fù\n仇chóu,qiú\n仔zǐ,zǎi,zī,zi\n他tā,tuō\n仗zhàng,zhang\n付fù,fu\n令lìng,líng,lǐng\n仰yǎng,áng\n仳pǐ,pí\n任rèn,rén\n份fèn,bīn,fen\n仿fǎng,páng\n企qì,qǐ\n伍wǔ,wu\n伏fú,fu\n伐fā,fá\n休xiū,xǔ,xiǔ\n伕fū,fú\n伙huǒ,huo,huō\n伯bó,bo,bǎi,bà\n估gū,gù,gǔ,gu\n伺sì,cì\n似sì,shì\n伽jiā,qié,gā\n佃diàn,tián\n佈bù,bu\n住zhù,zhu\n佔zhàn,diān,zhān\n何hé,hē,hè\n佗tuó,tā,tuō\n余yú,xú\n佚yì,dié\n佛fó,bì,fú,bó,fù\n作zuò,zuó,zuō,zuo\n佝kòu,gōu\n佣yòng,yōng,yóng\n佰bǎi,bó,mò\n併bìng,bīng\n佻tiāo,tiáo\n使shǐ,shì,shi\n來lái,lài,lai\n侍shì,shi\n侖lún,lùn\n供gōng,gòng\n侯hóu,hòu\n便biàn,pián,bian\n係xì,xi,jì\n俄é,è\n俊jùn,zùn\n俏qiào,xiào\n俐lì,li\n俞yú,shū,yù,shù\n俟sì,qí\n俠xiá,jiá\n信xìn,shēn\n俱jù,jū\n俺ǎn,yàn\n俾bì,bǐ,bēi\n倀chāng,chàng,chéng\n倆liǎng,liǎ\n倉cāng,chuàng\n個gè,ge,gě\n倏shù,shū\n們men,mén,mèn\n倒dào,dǎo\n倔jué,juè\n倘tǎng,cháng\n候hòu,hou\n借jiè,jí\n倡chàng,chāng\n倥kōng,kǒng\n倩qiàn,qìng\n倪ní,nì\n倭wō,wēi,wǒ\n值zhí,zhì\n假jiǎ,jià,gēi\n偕xié,jiē\n停tíng,ting\n側cè,zè,zhāi\n偺zá,zán,zǎ\n偽wèi,wěi,wéi\n傀kuǐ,guī,kuí\n傅fù,fu\n傍bāng,bàng,páng\n傖cāng,chen,chéng\n傢jiā,jia,jie,gū\n傭yōng,yóng,yòng\n傳chuán,zhuàn\n債zhài,zhai\n傾qīng,qǐng,kēng\n僅jǐn,jìn,fù,nú\n僑qiáo,jiǎo\n僕pú,pū,fù\n僥jiǎo,yáo,jiāo\n僮tóng,zhuàng\n僱gù,hù\n價jià,ga,jie,jiè\n僻pì,bèi\n億yì,yī\n儅dāng,dàng\n儉jiǎn,jiàn\n儐bīn,bìn\n儘jǐn,jìn\n儲chú,chǔ\n儳chàn,chán\n儷lì,lí\n儸luó,luo\n儻tǎng,tàng\n儿rén,ér,ēr,ēr,ní,er\n兄xiōng,xiong\n先xiān,xiàn\n克kè,kēi\n兌duì,yuè,ruì,miǎn,wèn\n免miǎn,wèn\n兒ér,ēr,ní,ēr,rén,er\n兜dōu,dou\n入rù,rì,rǔ\n內nèi,nà,nei\n兩liǎng,liàng\n八bā,ba,bá\n公gōng,gong\n六liù,lù,lù\n共gòng,gōng,gǒng\n其qí,jī,jì\n冊cè,chǎi\n冒mào,mò\n冠guàn,guān\n冥míng,mǐng\n冪mì,mù\n凜lǐn,qín\n几jī,jǐ\n凸tú,tū,dié,gǔ\n凹āo,wā,yāo,wà\n出chū,chu\n刀dāo,dao\n分fēn,fèn,fen\n切qiē,qiè\n划huá,huà\n列liè,zhū,zá,lie\n別bié,biè\n刨bào,páo\n利lì,li\n刷shuā,shuà,shua\n券quàn,xuàn\n刺cì,cī,là\n刻kè,kē\n削xiāo,xuè,xuē\n剋kè,kēi\n剌lá,là,lā\n前qián,qian\n剎chà,shā,shà\n剔tī,ti,tì\n剖pǒu,pōu\n剛gāng,gang\n剝bō,bāo\n副fù,pì\n剴kǎi,ái\n創chuàng,chuāng\n剽piào,piāo\n剿jiǎo,chāo\n劃huà,huá,hua\n劇jù,jí\n劈pī,pǐ\n劊kuài,guì,chuāng,chuàng\n力lì,li\n助zhù,chú\n勁jìng,jìn\n勃bó,bèi\n勒lè,lēi,le,lē\n動dòng,dong\n勘kān,kàn\n務wù,wú,wǔ,wu\n勝shèng,shēng\n勞láo,lào,lao\n勢shì,shi\n勣jī,jì\n勦jiǎo,chāo\n勺sháo,zhuó,shuò\n勾gōu,gòu\n包bāo,pào,bao\n化huà,huā,hua\n北běi,bèi,bò\n匙chí,shi,shí\n匠jiàng,jiang\n匱kuì,guì\n匹pī,pǐ\n區qū,ōu,gōu\n千qiān,qiā\n午wǔ,huo\n半bàn,ban\n卒zú,cù\n卓zhuó,zhuō\n南nán,ná,nā\n卜bǔ,bo,bó\n占zhàn,zhān,diān\n卡kǎ,qiǎ\n危wéi,wēi\n卷juàn,juǎn,quán\n厚hòu,hou\n原yuán,yuàn\n厭yàn,yān,yā,yǎn\n厲lì,lài\n去qù,qu\n參cān,shēn,cēn,sān,sā,sàn\n叉chā,chá,chǎ,chà\n友yǒu,you\n反fǎn,fān,fàn\n叔shú,shu,shū\n受shòu,shou\n叟sǒu,sōu\n叢cóng,cōng\n口kǒu,kou,luó\n古gǔ,gu\n句jù,gōu,gòu\n叨dāo,tāo,dao\n只zhǐ,zhī,qí\n召zhào,shào\n叭bā,ba\n可kě,kè\n台tái,yí,tāi,tai\n司sī,si\n叻lè,lì\n吁xū,yù\n吃chī,jí\n各gè,gě\n合hé,gě,he\n吉jí,ji\n吋cùn,dòu\n同tóng,tòng,tong\n吐tǔ,tù\n吒zhà,zhā,zha\n否fǒu,pǐ\n吧ba,bā,biā\n含hán,hàn\n听yǐn,tīng,tìng,yí,ting\n吭kēng,háng\n吱zhī,zī,qì\n吳wú,tūn\n吵chǎo,chāo\n吶nà,nè\n吹chuī,chuì\n吾wú,yù,yú,wu\n呀yā,ya,xiā\n呃è,e\n呆dāi,ái\n告gào,gù,gao\n呢ne,ní\n呱guā,wā,gū,guǎ,gua\n味wèi,wei\n呵hē,ō,a,kē,ā\n呷xiá,gā,xiā\n呼hū,hu\n咀jǔ,zuǐ\n咄duò,duō\n咋zé,zǎ,zhā,zhà,za\n和hé,hàn,hè,huò,huo,hú,huó,he\n咎jiù,gāo\n咕gū,gu\n咖kā,gā\n咚dōng,dong\n咧liě,liē,lié,lie\n咪mī,mi\n咬yǎo,jiāo\n咯lo,gē,kǎ,luò,gé\n咱zán,zá,zǎ,zan\n咳ké,hāi,kǎ\n咻xiū,xǔ\n咽yān,yè,yàn\n哄hōng,hǒng,hòng,xiàng\n哇wā,wa\n哈hā,hǎ,kā,hà,ha\n員yuán,yún,yùn,yuàn\n哥gē,ge\n哦ó,é,ò,o\n哨shào,shao\n哩lǐ,li,lī,lí\n哪nǎ,na,nuó,něi,né\n哭kū,ku\n哮xiāo,xiào\n哺bǔ,bù,pǔ,bū\n哼hēng,heng\n唆suō,suo\n唇chún,zhēn\n唉āi,ài\n唔wú,wù\n唧jí,jī,ji\n唬hǔ,xià,hu\n唯wéi,wěi\n唷yō,yù,yo\n啁zhōu,zhāo,tiào,cháo\n啃kěn,kèn\n啊a,ā,á,ǎ,à,ō\n問wèn,wen\n啜chuò,chuài\n啞yǎ,yā,è\n啦la,lā\n啪pā,piā\n啻chì,tì\n啼tí,ti\n喀kā,kà,kè\n喂wèi,wéi\n喇lǎ,lā,la,lá\n喋dié,zhá\n喔ō,o,wò,wō,wū,wo\n喚huàn,huan\n喝hē,hè,yè,he\n喪sāng,sàng,sang\n喫chī,jí\n喬qiáo,jiāo\n單dān,shàn,chán\n喱lǐ,lí,lī,li\n喲yāo,yō,yo\n喳zhā,chā\n喻yù,yú\n嗆qiàng,qiāng,qiáng\n嗎ma,mǎ,má,mà,mā\n嗑kè,hé,kē\n嗚wū,wù\n嗟jiē,jiè,juē\n嗦suō,suo\n嗨hāi,hēi\n嗯en,nú,èn,ēn\n嗶bì,bī\n嗽sòu,sou\n嗾sǒu,zú\n嘀dí,dī,di\n嘆tàn,yòu\n嘍lóu,lou,lǒu\n嘎gā,gá,gǎ\n嘐xiāo,jiāo\n嘔ǒu,òu,ōu,xū\n嘗cháng,chang\n嘛má,ma\n嘟dū,du\n嘩huá,huā\n嘮láo,lào,lao\n嘯xiào,chì\n嘰jī,jiào,ji\n嘲cháo,zhāo\n嘴zuǐ,zui\n嘿hēi,mò\n噓xū,shī\n噢yǔ,ō\n噥nóng,nong,táng,náng\n噫yì,yī\n噯ài,āi,ǎi\n噱xuē,jué,xué\n噴pēn,pèn,fen,pen\n噶gé,gá\n噸dùn,dūn,tún,tǔn,zhùn\n噹dāng,diāng,dàng,dǎng\n嚇xià,hè\n嚕lū,lǔ,lu\n嚥yàn,yān,yè\n嚷rǎng,rāng,rang\n嚼jiáo,jué,jiào\n囀zhuǎn,zhuàn\n囁niè,zhé\n囂xiāo,áo\n囉luō,luó,luo\n囊náng,nāng,nang\n囌sū,sù\n囝jiǎn,nān,yuè\n回huí,hui\n因yīn,yin\n囤tún,dùn\n囪cōng,chuāng\n圈quān,juàn,juān,quàn,quan\n園yuán,tuán,wán\n團tuán,qiú\n在zài,zai\n圩yú,wéi,xū\n地dì,de,di\n圳zùn,zhèn,chóu\n圻qí,yín\n圾sè,jī,jí\n均jūn,yùn\n坊fāng,fáng,fang\n坏pēi,huài,péi,pī,guài\n坑kēng,keng,kàng\n坦tǎn,tan\n坷kě,kē\n垃lè,lā\n埋mái,mán\n埔pǔ,bù,bǔ\n埠bù,fù\n埤pí,bì,bēi,pì\n培péi,pǒu,bèi\n堂táng,tang,tǎng\n堆duī,tuī\n堊è,shèng\n堝guō,wō\n堡bǎo,bǔ,pù,pǔ\n堤tí,dī\n場chǎng,cháng,chāng,chang\n塌tā,tà\n塗tú,tu\n塞sāi,sè,sài,sēi,sai\n塢wù,wǔ,wū\n填tián,zhèn\n塹qiàn,jiàn\n墜zhuì,zhui\n墮duò,huī\n墳fén,fèn\n墾kěn,yín\n壅yōng,yǒng\n壎xuān,xūn\n壑huò,hè\n壓yā,yà,ya\n壘lěi,lǜ\n壞huài,guài,pī,pēi,péi\n士shì,shi\n夏xià,jiǎ\n夕xì,xī\n外wài,wai\n多duō,duó\n大dà,dài,tài,da,dá\n天tiān,tian\n太tài,tai\n夫fū,fú,fu\n夭yāo,yǎo,ǎo\n失shī,shi\n夸kuā,kuà\n夾jiá,jiā,gā,jià\n奄yān,yǎn\n奇qí,jī\n奈nài,nai\n契qì,xiè,qiè\n奔bēn,bèn\n套tào,tao\n奘zàng,zhuǎng\n奧ào,yù\n奪duó,duì\n奮fèn,gǎng\n女nǚ,nǜ,rǔ,nü\n奶nǎi,nai\n她tā,jiě\n好hǎo,hào\n妃fēi,pèi\n妊rèn,rén\n妒dù,du\n妝zhuāng,zhuang\n妞niū,niu\n妨fáng,fāng\n妮ní,nī\n妯zhóu,zhú\n妳nǐ,nǎi\n妹mèi,mei\n妻qī,qì\n姊jiě,jie,zǐ,zi\n始shǐ,shì\n姍shān,shàn,xiān\n姐jiě,jie\n姑gū,gu\n委wěi,wēi\n姣jiǎo,xiáo,jiāo\n姥lǎo,lao,mǔ\n姬jī,zhěn\n娃wá,wa\n娌lǐ,li\n娘niáng,niang\n娛yú,yù\n娜nà,nuó\n娠shēn,zhèn\n娩miǎn,wǎn\n娶qǔ,qù\n婀ē,ě\n婁lóu,lǚ,lǘ,lǒu\n婆pó,po\n婢bì,bèi\n婦fù,fu\n婿xù,xu\n媛yuán,yuàn\n媼ǎo,wēn\n媽mā,ma\n嫂sǎo,sao\n嫖piáo,piāo\n嫗yù,yǔ\n嫩nèn,nen\n嬈ráo,yǎo,rǎo\n嬤mā,ma,mó,mo\n嬰yīng,yìng\n嬸shěn,shen\n子zǐ,zi\n字zì,zi\n孚fú,fū\n孛bèi,bó\n孫sūn,xùn,sùn\n孱chán,càn\n孳zī,zì\n學xué,bó,bèi,xiáo\n孿luán,lüán\n它tā,tuō,tuó\n宅zhái,zhè\n守shǒu,shòu\n宗zōng,zong\n定dìng,ding\n宛wǎn,yuān\n宜yí,yi\n客kè,ke\n害hài,hé,hai\n家jiā,gū,jia,jie\n宿sù,xiǔ,xiù\n寂jí,jì\n密mì,mi\n實shí,shi\n寧níng,nìng,zhù\n寨zhài,zhai\n審shěn,pán\n寫xiě,xiè\n寵chǒng,lóng\n寶bǎo,bao\n寸cùn,cun\n射shè,yè,yì,shí\n將jiāng,jiàng,qiāng\n尉wèi,yù\n尋xún,xín\n對duì,dui\n導dǎo,dào\n少shǎo,shào,shao\n尚shàng,shang\n尢wāng,yóu\n尬gà,jiè\n就jiù,jiu\n尷gān,jiān\n尸shī,shǐ\n尺chǐ,chě,chí\n尾wěi,yǐ\n尿niào,suī\n屁pì,pi\n居jū,jī\n屆jiè,qū\n屈qū,qu\n屍shī,shǐ\n屎shǐ,xī\n屏píng,bǐng,bīng\n屑xiè,xuè\n屘mān,mǎn\n屜tì,xiè,tí,ti\n屠tú,chú\n屬shǔ,zhǔ\n屯tún,zhūn,chún\n岔chà,chá\n岡gāng,gǎng,tóng,tòng,wǎng\n峒dòng,tóng\n峙zhì,shì\n崁kǎn,kàn\n崖yái,yá\n崗gāng,gǎng\n崙lún,lùn\n崢zhēng,chéng\n崤yáo,xiáo\n崴wēi,wǎi\n嵌qiān,kǎn,qiàn,kàn\n嶄zhǎn,chán\n嶸róng,hóng\n嶺lǐng,líng\n巍wéi,wēi\n工gōng,ēi\n巫wū,wú\n差chā,chāi,cī,cuō,chà,chài\n己jǐ,ji\n巴bā,ba\n巷xiàng,hàng\n巽xùn,sùn\n市shì,shi\n布bù,bǔ,bu\n帆fán,fān\n帑tǎng,nú\n帖tiě,tiē,tiè\n帚zhǒu,zhou\n帥shuài,shuò\n幀zhèng,zhēn\n幃wéi,wěi\n幌huǎng,huàng\n幕mù,mò\n幢chuáng,zhuàng\n幣bì,yìn\n幫bāng,bang\n干gān,gàn,qián,hán\n平píng,biàn,pián\n并bìng,bīng,bàng\n幹gàn,hán,gān\n幾jǐ,jī\n底dǐ,de\n度dù,duò,duó,du\n庫kù,shè\n庸yōng,yóng\n廁cè,cì,sì,ce,si\n廄jiù,jì\n廈xià,shà\n廠chǎng,ān,hàn,hǎn\n廣guǎng,yǎn,ān\n弁biàn,pán\n弄nòng,lòng,nong,nōng\n式shì,shi\n弛chí,shǐ\n弟dì,di,tì,tuí\n弦xián,xuán\n張zhāng,zhàng\n強qiáng,qiǎng,jiàng,qiāng\n彆biè,bié,bie,biē\n彈dàn,tán,tan\n彊qiáng,qiǎng,jiàng\n彌mí,mǐ\n形xíng,xing\n彩cǎi,cai\n彪biāo,biáng\n彭péng,bāng\n彷páng,fǎng\n役yì,yi\n彿fú,fù,fó,bì,bó\n征zhēng,zhǐ\n待dài,dāi\n徇xùn,xún\n徊huí,huái\n得dé,de,děi,dǎi,dè\n從cóng,zòng,zōng,cōng\n徠lái,lài\n御yù,yà\n復fù,fòu\n徬páng,bàng\n微wéi,wēi,wei\n徵zhēng,zhǐ\n心xīn,xin\n忘wàng,wáng\n忙máng,mang\n忪sōng,zhōng\n快kuài,kuai\n忽hū,hu\n怎zěn,zě\n怔zhēng,lèng,zhèng,zheng\n思sī,sāi,si,sì\n急jí,ji\n性xìng,xing\n怨yuàn,yuān\n怫fèi,fú,bèi\n怯què,qiè\n恆héng,gèng\n恣zì,zī,cī\n恪kè,què\n恫dòng,tōng\n息xí,xī,xi\n悄qiǎo,qiāo\n悖bèi,bó\n悚sǒng,sóng\n悠yōu,you\n悶mēn,mèn,men\n情qíng,qing,qín\n惋wàn,wǎn\n惑huò,huo\n惜xí,xī\n惟wéi,wei\n惡è,wù,wū,ě\n想xiǎng,xiǎn,xiáng,xiang\n惺xīng,xǐng\n愀qiǎo,jiǔ\n愉yú,tōu\n意yì,yi\n愒kài,qì\n愛ài,ai\n感gǎn,hàn\n愣lèng,lēng,leng\n愾kài,xì,qì,xī,yì\n態tài,tai\n慌huāng,huang\n慢màn,man\n慨kǎi,kài\n慮lǜ,bì\n慵yōng,yóng\n慶qìng,qīng\n慷kāng,kǎng\n慼qī,cù\n憂yōu,yòu\n憐lián,líng\n憚dàn,dá,dān\n憲xiàn,xiòng\n應yīng,yìng,ying\n懋mào,mòu\n懍lǐn,lǎn\n懲chéng,chěng\n懵méng,měng\n懶lǎn,lài\n懷huái,fù\n懺chàn,qiān,qiǎn\n懾zhé,shè\n戌xū,qu,xu\n成chéng,cheng,shèng\n我wǒ,ě\n戕qiáng,qiāng,zāng\n戚qī,cù,qi\n戰zhàn,zhan\n戲xì,hū,huī,xī\n戶hù,hu\n房fáng,fang,páng\n扁biǎn,piān\n扇shàn,shān,shan\n手shǒu,shou\n才cái,cai\n扎zhā,zhá,zā,zhǎ,zha\n扒pá,bā,bié\n打dǎ,dá,da\n扔rēng,réng,rěng,rèng\n扛káng,gāng,gàng\n扭niǔ,niu\n扮bàn,fěn,ban\n扯chě,che\n扳bān,pān\n承chéng,cheng\n抆wèn,wěn\n把bǎ,bà,bǎi,ba\n抑yì,yi\n抓zhuā,chuǎ,zhāo\n折zhé,zhē,shé,zhě\n披pī,pēi\n抵dǐ,zhǐ\n抹mǒ,mò,mā\n押yā,yá\n抽chōu,chou\n拂fú,bì\n拆chāi,cā,chè\n拇mǔ,mu\n拈nián,niān,diān,niǎn\n拉lā,lá,la,lǎ,là\n拌bàn,pàn\n拍pāi,bó,pā,pò\n拎līng,līn\n拐guǎi,guai\n拓tuò,tà,zhí,tuō\n拗niù,ào,ǎo,āo,yù\n拘jū,gōu,ju\n拙zhuó,zhuō\n拚pàn,pīn,fān,bià\n招zhāo,qiáo,sháo\n拜bài,bai\n括guā,kuò\n拮jié,jiá\n拼pīn,bià,pàn,fān\n拽zhuài,zhuāi,yè,zhuǎi\n拾shí,shè,shī,shi\n持chí,chi\n指zhǐ,zhi\n挈qiè,qì\n挑tiǎo,tiāo,tiáo,tiao\n挖wā,wá\n挨āi,ái\n挫cuò,cuà\n振zhèn,zhēn\n挾xiá,xié,jiā,jiá\n捉zhuō,zhuó\n捎shāo,shào\n捏niē,nie\n捕bǔ,bù\n捨shě,shè\n捩liè,lì\n捱ái,āi\n捲juǎn,quán,juàn\n捻niǎn,niē\n掃sǎo,sào\n掄lún,lūn,liú\n掌zhǎng,zhang\n排pái,pǎi\n掖yè,yē,yì\n掙zhēng,zhèng,zheng\n採cǎi,cài\n探tàn,tān\n接jiē,jie\n掬jú,jū\n揆kuí,kuǐ\n揉róu,rou\n提tí,shí,dī,dǐ\n揖yī,jí\n換huàn,huan\n揣chuǎi,chuāi,chuài,tuán,zhuī\n揭jiē,qì\n揮huī,hún\n揹bēi,bèi\n搓cuō,cuo\n搗dǎo,dao\n搭dā,da\n搶qiǎng,qiāng,chēng,chuǎng,qiàng\n搽chá,cā\n摑guó,guāi\n摒bìng,bǐng\n摘zhāi,tì\n摟lǒu,lōu,lóu,lou\n摩mó,mā\n摸mō,mó,māo,mo\n摺zhé,zhě,zhē,shé\n摻chān,shǎn,càn,xiān,shān\n撇piě,piē\n撈lāo,láo\n撒sǎ,sā,sa,sà\n撓náo,nào,xiāo,nao\n撕sī,xī\n撚niǎn,niē\n撞zhuàng,chuáng\n撢dǎn,tàn\n撥bō,fá,bo\n撩liáo,liāo\n撫fǔ,wǔ\n撬qiào,qiāo\n播bò,bō\n撮cuò,cuō,zuǒ,zuó,zuì\n撾zhuā,wō\n撿jiǎn,jiān,jiàn\n擁yǒng,yōng\n擂léi,lèi\n擄lǔ,luǒ\n擇zé,zhái,zè\n擊jí,jī\n擋dǎng,dàng\n操cāo,cào\n擔dān,dàn,dǎn,dá,jiē,qì,dan\n擘bò,bāi\n據jù,jū\n擬nǐ,ní\n擭huò,wò\n擰nǐng,nìng,níng\n擱gē,gé,ge\n擲zhí,zhì\n擴kuò,tǎng\n擷jié,xié\n擺bǎi,bēi,bai\n擻sǒu,sòu\n擾rǎo,yòu\n攘ráng,rǎng,rang\n攙chān,shàn,chán\n攜xī,xié\n攝shè,niè,zhé\n攣luán,liàn,lüán\n攤tān,nàn\n攪jiǎo,gǎo\n放fàng,fǎng\n故gù,gu\n敖áo,ào\n教jiào,jiāo\n敞chǎng,chang\n散sàn,sǎn,san\n敦dūn,duì,duī,dùn\n敵dí,huá,qì\n數shù,shǔ,shuò,cù,sù,shu\n斂liàn,liǎn\n文wén,wèn\n斐fěi,fēi\n斗dǒu,dòu,dou\n料liào,liao\n斜xié,yé,xiá,xie\n斡wò,guǎn\n斬zhǎn,zhàn\n斯sī,si\n方fāng,fang\n於yú,wū,xū,yū,yu\n施shī,yí,yì,yī\n旁páng,bàng,péng\n旋xuán,xuàn\n日rì,mì,ri\n昆kūn,hún\n明míng,ming\n昔xí,xī,cuò\n星xīng,xing\n昤líng,līng\n是shì,shi\n晃huàng,huǎng,huang\n晅xuān,xuǎn\n晦huì,hui\n景jǐng,yǐng\n暇xiá,xià\n暈yūn,yùn,yìn\n暍hè,yē,yè\n暖nuǎn,xuān\n暗àn,ǎn,yǎn\n暝míng,mìng\n暫zhàn,zàn\n暱nì,zhí\n暴bào,pù,bō\n暸liǎo,liáo\n曆lì,li\n曇tán,yù,tián\n曙shù,shǔ\n曜yào,yuè\n曝pù,bào\n曲qǔ,qū,qú\n曳yì,yè\n更gèng,gēng,jīng\n曼màn,wàn\n曾céng,zēng\n有yǒu,yòu\n服fú,fù,fu\n朗lǎng,lang\n望wàng,wang\n朝cháo,zhāo\n期qí,jī,qī\n朧lóng,lǒng,lōng\n末mò,mo,me\n札zhá,zhā\n朮zhú,shù,shú,suì\n朱zhū,shú\n朴pú,pò,piáo,pǔ,pō\n朵duǒ,duo,duō\n杆gān,gǎn\n杉shān,shā\n李lǐ,li\n材cái,cai\n杓sháo,biāo\n杠gāng,gàng\n杷pá,pa,bà,ba\n板bǎn,pàn\n枉wǎng,wang\n枋fāng,bìng\n析xī,xi\n枓dǒu,zhǔ,dōu\n枕zhěn,zhèn\n枝zhī,qí\n枸gǒu,gōu,jǔ\n柄bǐng,bìng\n柏bó,bǎi,bò\n某mǒu,méi\n柑gān,qián\n柚yòu,yóu\n柞zuò,zé,zhà\n柢dǐ,chí\n查chá,zhā\n柴chái,zhài,chai\n柵zhà,shān,shàn,shi,cè\n校xiào,jiào\n核hé,hú,hē\n格gé,ge,gē\n桁héng,háng,hàng\n桃táo,tao\n桅wéi,guǐ\n框kuāng,kuàng,kuang\n桔jié,jú\n桿gǎn,gān\n梁liáng,liang\n梃tǐng,tìng\n條tiáo,tiāo,dí,tiao\n梟xiāo,jiāo\n梢shāo,sào\n梧wú,wù\n械xiè,jiè\n梵fàn,fán\n棋qí,jī\n棍gùn,hùn\n棕zōng,zòng\n棚péng,peng\n棣dì,dài,tì\n棲qī,xī\n棵kē,kě\n棹zhào,zhuō\n椅yǐ,yī\n椎zhuī,chuí\n椰yé,yē\n楔xiē,xiè\n楚chǔ,chu\n楛kǔ,hù\n楞lèng,léng\n業yè,niè\n楷kǎi,jiē\n榔láng,lang\n榜bǎng,bèng,bàng\n榦gàn,hán\n榮róng,rong\n榴liú,liu\n榻tà,tā\n構gòu,gōu\n槌chuí,chui\n槍qiāng,chēng\n槓gàng,gāng\n槭cù,qī,qì,sè\n槽cáo,zāo\n樂lè,yuè,yào,lào\n樅cōng,zōng\n樓lóu,lou\n標biāo,piǎo\n樞shū,qū\n模mó,mú,mo\n樣yàng,xiàng,yáng,yang\n樸pú,pǔ,pò,pō,piáo\n橈náo,ráo\n機jī,jǐ\n橫héng,hèng\n檐yán,dàn\n檔dǎng,dàng\n檜kuài,guì,huì\n檮táo,chóu,dǎo,dào\n檯tái,tāi,yí\n檳bīn,bīng\n檸níng,chǔ\n檻kǎn,jiàn\n櫃guì,jǔ,kuì\n櫛jié,zhì\n櫝dú,mēn\n欄lán,lan\n欠qiàn,qian\n次cì,zī\n歌gē,ge\n歎tàn,yòu\n歐ōu,ǒu\n歙xì,shè,xī\n歜chù,cǎn\n歡huān,tàn,huan\n正zhèng,zhēng,zheng\n歪wāi,wǎi,wai\n歸guī,kuì\n歹dǎi,jīng,zhēn,è\n殖zhí,shi\n殯bìn,bīn\n殷yīn,yǐn,yān\n殺shā,shài,shà,sha\n殼ké,qiào,què,ke\n毀huǐ,huì\n毆ōu,qū\n母mǔ,mu\n毒dú,dài\n比bǐ,bì,pí,bī,bí\n毛máo,mao\n氈zhān,tǎn\n氏shì,zhī\n氐dī,dǐ\n氓méng,máng\n氣qì,qi\n氬yǎ,yà\n氯lǜ,lù\n水shuǐ,shui\n氾fàn,fán\n汐xì,xī\n汗hàn,hán\n汙wū,wù,wā,yū,yú\n污wū,wù,wā,yū,yú\n汰tài,tai\n汶wèn,mén\n沃wò,wù\n沆hàng,háng\n沈shěn,chén\n沉chén,chēn\n沒méi,mò\n沖chōng,chòng\n沙shā,shà\n沫mò,mo\n沬mèi,huì,mò\n沮jǔ,jū,jù\n沸fèi,fú\n治zhì,chí\n沿yán,yàn\n泄xiè,yì\n泊bó,pō,pò\n泌mì,bì\n法fǎ,fá,fā,fà,xìng,fa\n泛fàn,fěng,fan\n泜chí,zhī\n泡pào,pāo,pao\n波bō,pō\n泥ní,nì\n洗xǐ,xiǎn,xi\n洞dòng,tóng\n洩xiè,yì\n洮táo,yáo\n洸guāng,huǎng\n洹huán,yuán\n活huó,huo\n洽qià,xiá\n派pài,pai\n浚jùn,xùn\n浪làng,láng,lang\n浬lǐ,lí\n浮fú,fóu\n浸jìn,jīn\n浹jiá,jiā\n消xiāo,fèi,xiao,lù\n涌yǒng,chōng\n涎xián,yàn,xian\n液yè,yì\n涵hán,han\n涸hé,hào\n涼liáng,liàng\n涿zhuó,zhuō\n淆yáo,xiáo,xiào\n淋lín,lìn\n淌tǎng,chǎng\n淑shú,shū\n淨jìng,chēng,zhēng,jing\n淪lún,lūn,lǔn\n淳chún,zhūn\n混hùn,gǔn,kūn,hún,hǔn,hun\n淹yān,yàn\n淺qiǎn,jiān\n渙huàn,huì\n渠qú,jù\n渣zhā,zhǎ\n渦wō,guō\n港gǎng,jiǎng\n渴kě,hé,jié\n渾hún,hùn,gǔn,hǔn\n湣mǐn,hūn\n湧yǒng,chōng\n湩dòng,zhòng\n湮yīn,yān\n湯tāng,shāng,tang\n溜liū,liù,liu\n溝gōu,gòu\n溪xī,qī\n溺nì,niào\n溼shī,tà,shí\n滑huá,gǔ\n滯zhì,chì\n滷lǔ,xī\n滿mǎn,mèn\n漂piào,piāo,piǎo\n漆qī,qù\n漕cáo,zào\n漣lián,lán\n漩xuán,xuàn\n漫màn,mán\n漬zì,sè\n漯tà,luò\n漱shù,sòu\n漲zhǎng,zhàng,zhāng\n漸jiàn,jiān\n漿jiāng,jiàng\n潑pō,bō,po\n潔jié,jí\n潛qián,qiǎn\n潠xùn,sùn\n潦liáo,lào,lǎo\n潯xún,yín\n潰kuì,huì,xiè\n澄chéng,dèng,deng,dēng\n澆jiāo,jiào,ào\n澎péng,pēng\n澠shéng,mǐn,miǎn\n澤zé,shì\n澳ào,yù\n澹dàn,tán\n濕shī,tà,xí,luò,shí\n濘nìng,zhǔ,chǔ,níng\n濛méng,mēng,měng\n濟jì,jǐ,qí\n濤táo,tāo,dào,chóu,shòu\n濩huò,hù\n濫làn,lǎn,jiàn\n濬jùn,xùn\n濯zhuó,zhào\n濰wéi,zhì\n濺jiàn,jiān\n濾lǜ,lù\n瀆dú,dòu\n瀋shěn,chén\n瀏liú,liū\n瀑pù,bào\n瀕bīn,pín\n瀰mí,mǐ\n瀾lán,làn\n灑sǎ,xǐ,xiǎn,cuǐ\n火huǒ,huo\n炊chuī,chuì\n炕kàng,kēng\n炤zhào,zhāo\n炮pào,páo,bāo\n炸zhà,zhá,dàn\n為wéi,wèi\n烊yáng,yàng\n烏wū,wù\n烘hōng,hóng\n烙lào,luò\n焚fén,fèn\n焜kūn,gùn\n無wú,mó,mú\n煆xià,xiā\n煉liàn,làn\n煎jiān,jiàn\n煖nuǎn,xuān\n煞shà,shā\n煦xǔ,xù\n煩fán,fan\n煬yáng,yàng\n熄xí,xī\n熙xī,yí\n熟shóu,shú\n熨yùn,yù,yū\n熬áo,āo\n燉dùn,dūn,tún\n燎liáo,liǎo,liào\n燒shāo,shào,shao\n燕yàn,yān\n燙tàng,dàng\n燜mēn,mèn\n燠yù,ào\n燥zào,sào\n燭zhú,tóng,chóng\n燸rú,xū,nuǎn,xuān,ruǎn\n燻xūn,xùn\n燾táo,dào,tāo\n爆bào,bó,zhà\n爍shuò,luò\n爪zhuǎ,zhǎo\n父fù,fǔ,fu\n爸bà,ba,bǎ\n爹diē,die\n爺yé,ye\n爻yáo,xiáo\n爾ěr,ēr\n片piàn,piān\n牌pái,pai\n牟móu,mù\n牠tā,tuō\n牡mǔ,mǒu\n物wù,wu\n牲shēng,sheng\n犀xī,xi\n犁lí,li\n犛lí,máo\n狸lí,li\n猓guǒ,guō\n猩xīng,xing\n猶yóu,yòu\n獲huò,huái\n獵liè,què,xí\n獺tà,tǎ\n率lǜ,shuài,shuò\n王wáng,wàng,yù,wang\n玟wén,mín,wēn\n玩wán,wàn\n理lǐ,li\n琊yé,yá,yà\n琍lì,lí\n琢zhuó,zuó\n琯guǎn,gùn\n琴qín,qin\n琶pá,ba,pa\n琺fà,fǎ\n琿hún,huī\n瑁mèi,mào\n瑜yú,yù\n瑟sè,se\n瑰guī,gui\n瑾jǐn,jìn\n璃lí,li\n環huán,huan\n璽xǐ,xī\n瓠hù,hú\n瓦wǎ,wà\n甚shèn,shén,shé\n生shēng,sheng\n甥shēng,sheng\n甦sū,sù\n用yòng,yong\n甫fǔ,fu\n甭béng,bèng\n甲jiǎ,jià,jia\n甸diàn,diān,tián,shèng\n甽quǎn,zhèn\n界jiè,jie\n畜xù,chù\n畦qí,xī\n番fān,pān,pó\n畫huà,hua\n異yì,yí\n當dāng,dàng,dǎng,dang\n畿jī,qí\n疆jiāng,qiáng\n疊dié,dá\n疋shū,pǐ,yǎ,pī,zhēng,zhèng,yā\n疏shū,shù,sū\n疑yí,nǐ\n疙gē,yì,jì\n疣yóu,yòu\n疵cī,cí\n疾jí,ji\n病bìng,bing\n症zhèng,zhēng\n痛tòng,tong\n痱fèi,féi\n痳lín,má,lìn\n痴chī,chí\n瘋fēng,feng\n瘧nüè,yào\n瘩dá,da,dā\n癆láo,lào\n癌ái,yán\n癖pǐ,pì\n癘lì,lài\n癟biě,biē\n癡chī,chí\n癢yǎng,yáng,yang\n癥zhēng,zhèng\n癬xiǎn,xuǎn\n發fā,fà,fa\n白bái,bó,bai\n百bǎi,bó\n的de,dí,dì,dī\n皋gāo,háo\n皖wǎn,huǎn\n皮pí,pi\n皰pào,bāo\n皿mǐn,mǐng\n益yì,yí,yi\n盛chéng,shèng\n盟méng,mèng\n盡jìn,jǐn\n監jiān,jiàn\n盤pán,pan\n盧lú,lǘ\n盪dàng,tāng,dang\n目mù,mu\n盲máng,mang\n相xiàng,xiāng,xiang\n盹dǔn,duě\n盾dùn,shǔn\n省shěng,xǐng,sheng\n看kàn,kān,kan\n眶kuāng,kuàng\n眼yǎn,yan\n眾zhòng,pān,yín\n睛jīng,jing\n睢suī,huī\n督dū,du\n睥bì,pì\n睪gāo,yì,zé\n瞄miáo,miào\n瞇mī,mí,mǐ\n瞑míng,miàn,mǐng,mián\n瞞mán,mén\n瞪dèng,deng\n瞭liǎo,liào,le,liáo\n瞿qú,jù,qū\n矇méng,mēng,měng,meng\n矜jīn,qín,guān\n矢shǐ,shì\n矣yǐ,yí\n知zhī,zhì\n矩jǔ,ju\n矯jiǎo,jiáo\n石shí,dàn,shī\n矽xì,xī\n砌qì,qiè\n研yán,yàn\n砝fǎ,fá,jié\n砟zhǎ,zhà\n砲pào,páo,bāo\n硃zhū,shú\n硼péng,pēng\n碌lù,liù,luò,lu\n碣jié,yà\n碩shuò,shí\n碰pèng,peng\n磅bàng,pāng,páng,bèng\n磕kē,kè,ke\n磨mó,mò,mo\n磯jī,ji\n磷lín,lìn\n礦kuàng,gǒng\n示shì,qí,shi\n祇qí,zhǐ,zhī\n祕mì,bì\n神shén,shen\n票piào,piāo\n祭jì,zhài\n禁jìn,jīn\n禦yù,yà\n禧xī,xǐ\n禪chán,shàn\n禺yú,yù,ǒu\n私sī,si\n秘mì,bì\n秤chèng,píng,chēng\n稀xī,xi\n稍shāo,shào,shao\n稜léng,lēng,líng,leng\n稟bǐng,bīn,lǐn,bǐn\n種zhǒng,zhòng,chóng\n稱chēng,chèng,chèn\n稼jià,jia\n稽jī,qǐ\n穀gǔ,yù\n積jī,zhǐ,ji\n穢huì,wèi\n穫huò,hù,huái\n穴xuè,xué\n究jiù,jiū,guǐ,jiu\n穹qiōng,qióng\n空kōng,kòng,kǒng\n突tú,tū\n窄zhǎi,zé\n窕tiǎo,yáo\n窘jiǒng,jǔn\n窩wō,wo\n窪wā,guī\n窺kuī,kuǐ\n窿lóng,long\n竄cuàn,cuān\n竺zhú,dǔ\n笆bā,ba\n笮zé,zhà,zuó\n筋jīn,jin\n筑zhú,zhù\n筒tǒng,tong\n答dá,dā,da\n筠yún,jūn\n筧jiǎn,xiàn\n箄pái,bēi,bǐ,bī,bì\n箇gè,gě,ge\n箏zhēng,zheng\n箕jī,ji\n節jié,jiē,jie\n築zhú,zhù\n篩shāi,shī\n篷péng,peng\n簍lǒu,lǚ,lòu\n簪zān,zēn\n簫xiāo,xiǎo\n簸bǒ,bò\n簿bù,bó\n籠lóng,lǒng,long\n籬lí,li\n籲yù,xū\n米mǐ,mi\n粥zhōu,yù,zhù\n粱liáng,liang\n粳gēng,jīng\n粽zòng,zhòng\n精jīng,jing\n糊hú,hū,hù,hu\n糙cāo,cào,cao\n糜mí,méi\n糝sǎn,shēn,sān\n糧liáng,liang\n糰tuán,qiú\n糸mì,sī\n系xì,jì,xi\n糾jiū,jiǔ,jiǎo\n紀jì,jǐ,ji\n約yuē,yāo,yuè\n紅hóng,gōng,hòng\n紆yū,ōu\n紇hé,gē,gé\n紊wèn,wěn\n紋wén,wèn\n純chún,zhǔn\n紕pī,pí,bǐ,pǐ\n紗shā,miǎo\n紡fǎng,bǎng\n索suǒ,suó,suo\n紮zhá,zā,zhā,zhǎ\n累lèi,lěi,léi\n紹shào,chāo\n紼fú,fèi\n終zhōng,zhong\n組zǔ,qū\n結jié,jiē,jiè,jie\n絞jiǎo,xiáo,jiào\n絡luò,lào\n絢xuàn,xún\n給gěi,jǐ\n絮xù,xu\n絹juàn,xuàn\n綏suī,suí\n經jīng,jìng,jing\n綜zòng,zōng,zèng\n綞duǒ,chuí\n綠lǜ,lù\n綢chóu,tāo,chòu,zhī\n維wéi,yí,wei\n綴zhuì,chuò\n綸lún,guān\n綺qǐ,yǐ\n綽chuò,chāo,chuo\n緊jǐn,jin\n線xiàn,xian\n緝qì,jī,qī,jí\n緣yuán,yuàn\n編biān,biǎn,biàn\n縐zhòu,chǎo,chào,zhōu\n縛fú,fù\n縝zhěn,chēn\n縣xiàn,xuán\n縫féng,fèng,feng\n縮suō,sù\n縯yǐn,yǎn\n縱zòng,zōng,zǒng\n縴qiàn,xiān\n縷lǚ,lü\n縹piǎo,piāo,piào\n總zǒng,zōng\n績jī,jì\n繁fán,pó\n繃bēng,bèng,běng\n繅sāo,zǎo\n繆miù,móu,miào,mù,liǎo,liáo\n繒zēng,zèng\n織zhī,zhì\n繚liáo,rǎo\n繞rào,rǎo\n繡xiù,tòu\n繩shéng,shèng\n繪huì,guì\n繫xì,jì\n繭jiǎn,chóng\n繳jiǎo,zhuó,jiáo,jiào\n繹yì,shì\n纂zuǎn,zuǎ\n纏chán,chan\n纖xiān,qiàn\n缸gāng,gang\n罕hǎn,han\n罪zuì,zui\n置zhì,zhi\n署shǔ,shù\n罵mà,ma\n罷bà,ba,pí\n羅luó,luo,luō\n羊yáng,xiáng\n羨xiàn,yí\n義yì,chā,chá,chǎ,yi\n羹gēng,láng\n翕xì,xī\n翟dí,zhái\n翮gé,hé\n翳yì,yī\n翹qiào,qiáo\n翻fān,fan\n耀yào,yuè\n老lǎo,lao\n耆qí,shì\n耐nài,nai\n耑duān,zhuān\n耕gēng,jīng\n耗hào,hao\n耙pá,bà\n耳ěr,ēr\n耶yé,yē\n聒guā,guō\n聖shèng,kū\n聘pìng,pìn\n聞wén,wèn\n聲shēng,qìng,sheng\n聶niè,zhé\n聽tīng,tìng,yí,yǐn,ting\n肉ròu,rù\n肋lè,lē,lèi\n肖xiào,xiāo\n肚dù,dǔ,du\n肛gāng,hāng\n股gǔ,gu\n肢zhī,zhi\n肩jiān,jian\n肪fáng,fāng\n肫zhūn,chún\n肯kěn,kěng\n育yù,yō\n肴yáo,xiáo\n肺fèi,pèi\n背bèi,bēi\n胖pàng,pán,pàn,pāng\n胞bāo,bao\n胡hú,hu\n胳gē,gé\n能néng,nài\n脂zhī,zhǐ,zhi\n脅xié,xiē,xiàn\n脈mài,mò\n脊jǐ,jí,ji\n脣chún,zhēn\n脫tuō,tuì,tuǒ\n脯pú,fǔ\n脹zhàng,chán\n腋yè,yì\n腌āng,yān,ā\n腐fǔ,fu\n腦nǎo,nào\n腫zhǒng,zhōng\n腮sāi,sai\n腰yāo,yao\n腱jiàn,qián\n腳jiǎo,jué,jiao\n腸cháng,chang\n腿tuǐ,tui\n膀bǎng,páng,pāng,bàng\n膊bó,bo\n膏gāo,gào\n膚fū,fǔ\n膜mó,mò\n膠jiāo,xiáo\n膽dǎn,dá,dàn,tán,shān\n臂bì,bei,bèi\n臃yōng,yǒng\n臘là,xī,xí\n臟zàng,zāng\n臢zāng,zā\n臥wò,wo\n臧zāng,zàng,cáng\n臨lín,lìn\n自zì,zi,zī\n臭chòu,xiù\n致zhì,zhi\n臺tái,tāi,yí\n臾yú,yǒng\n舅jiù,jiu\n與yǔ,yù,yú\n興xīng,xìng,xing\n舉jǔ,ju\n舍shè,shě\n舒shū,shu\n般bān,bō,pán\n艘sāo,sōu\n艮gèn,gěn\n色sè,shǎi,shè\n艾ài,yì\n芍sháo,dì,xiào,shuò,què\n芣fóu,fú\n芥jiè,gài\n芯xīn,xìn\n花huā,hua,lún\n芸yún,yì\n芾fèi,fú\n苑yuàn,yù,yuán\n苔tái,tāi\n苛kē,hē,hé\n苣jù,qǔ\n若ruò,rě\n苦kǔ,kù\n苧zhù,níng\n茂mào,mòu\n茄qié,jiā\n茆mǎo,máo\n茉mò,mo\n茗míng,mǐng\n茨cí,cī\n茲zī,cí\n茸róng,rōng,rǒng\n茹rú,rù\n草cǎo,zhú,zào,cào\n荒huāng,huang\n荷hé,hè,he\n荸bí,bó\n荼tú,shū\n莆pú,fǔ\n莉lì,li\n莎shā,suō\n莖jīng,jìng\n莘xīn,shēn\n莞wǎn,guǎn,guān,wān\n莠yòu,yǒu\n莧xiàn,wàn\n莫mò,mù,mo\n菁jīng,jing\n菌jùn,jūn\n菔fú,bó\n菟tù,tú\n菩pú,bèi\n華huá,huā,huà\n菰gū,gu\n菲fēi,fěi,fèi\n菴ān,àn\n菸yān,yú,yū\n菽shú,shū\n萄táo,tao\n萎wēi,wěi\n萬wàn,mò\n落luò,là,lào,luo\n葉yè,shè,xié\n著zhe,zhù,zhāo,zháo,zhuó,zhuo\n葛gě,gé\n葷hūn,xūn\n蒙méng,mēng,měng\n蒲pú,pǔ\n蒼cāng,cǎng\n蓋gài,gě,hé,gai\n蓬péng,peng\n蓮lián,liǎn\n蓿sù,xu,xù\n蔆léng,líng\n蔓màn,mán,wàn\n蔔bó,bo,bǔ\n蔗zhè,zhe\n蔚wèi,yù\n蔡cài,sà\n蔣jiǎng,jiāng\n蔬shū,sū\n蔭yìn,yīn\n蔽bì,fú\n蕃fān,fán,bō\n蕈xùn,xìn\n蕉jiāo,qiáo\n蕩dàng,tāng,dang\n薄bó,bò,báo\n薇wéi,wēi\n薔qiáng,sè\n薜bì,bò\n薩sà,sa\n薰xūn,xùn\n薺jì,qí,qì\n藉jiè,jí\n藍lán,lan\n藏cáng,zàng\n藝yì,yi\n藥yào,shuò,yao\n藩fán,fān\n藪sǒu,shú,sòu\n藷shǔ,zhū\n蘆lú,hù,lu\n蘇sū,sù\n蘊yùn,wēn\n蘋píng,pín,pēng\n虎hǔ,hū,hu\n處chǔ,chù,chu\n虜lǔ,luǒ\n號hào,háo,hao\n虧kuī,xū,yú\n虫huǐ,chóng,chong\n虹hóng,gòng\n虺huǐ,huī\n蚌bàng,bèng\n蚣gōng,zhōng\n蚤zǎo,zao\n蚱zhà,zha\n蚵kē,é,hé\n蛄gū,gǔ\n蛆qū,jū\n蛇shé,yí\n蛐qū,qu\n蛛zhū,zhu\n蛤gé,há\n蛻tuì,shuì\n蛾é,yǐ\n蜆xiǎn,xiàn\n蜇zhé,zhē\n蜊lí,lì\n蜿wān,wǎn\n蝙biān,biǎn\n蝦xiā,há,hā\n蝸guā,wō\n螂láng,lang\n螞mǎ,mà,mā\n螫zhē,shì\n蟀shuài,shuò\n蟆má,ma,mò\n蟈guō,guo\n蟒mǎng,měng\n蟯ráo,náo\n蟲chóng,huǐ,chong\n蟹xiè,xiě\n蠅yíng,ying\n蠍xiē,gòng,hóng,hé\n蠔háo,cì\n蠕rú,ruǎn\n蠟là,zhà,chà\n蠡lí,lǐ\n蠱gǔ,zhōng,chóng\n蠶cán,tiǎn\n血xiě,xuè,xuě\n行xíng,háng,xìng,hàng,héng,xing\n術shù,suì,shú,zhú\n衙yá,yú\n衝chōng,chòng\n衣yī,yì,yi\n衰shuāi,cuī,suō\n衹qí,zhī,zhǐ\n袋dài,dai\n袍páo,bào\n被bèi,pī\n袱fú,fu\n裂liè,liě\n裒póu,bāo\n補bǔ,bu\n裝zhuāng,zhuang\n裡lǐ,li\n裨bì,pí\n裯chóu,dāo,chú\n裳cháng,shang,shāng\n裹guǒ,guo\n複fù,fòu\n褊biǎn,pián\n褐hé,hè\n褚chǔ,zhǔ\n褪tùn,tuì\n褶zhé,dié,xué,zhě,xí\n襪wà,mò\n襬bǎi,bēi\n襯chèn,chen\n襲xí,xi\n西xī,xi\n要yào,yāo\n覃tán,qín\n覆fù,fòu\n見jiàn,xiàn,jian\n規guī,guì,gui\n親qīn,qìng,xīn\n覲jìn,jǐn\n覺jué,jiào\n覽lǎn,làn\n觀guān,guàn\n角jiǎo,jué,lù,jiao\n解jiě,jiè,xiè\n觸chù,hóng\n言yán,yín,yan\n計jì,ji\n訌hóng,hòng\n訐jié,jì\n訑yí,dàn\n訓xùn,xun\n記jì,ji\n訢xīn,xī\n訥nè,nà\n設shè,she\n許xǔ,xū,hǔ\n訴sù,su\n診zhěn,zhēn\n訾zǐ,zī\n詆dǐ,tì\n詐zhà,zhǎ\n詔zhào,zhāo\n試shì,shi\n詨jiāo,xiào\n詫chà,dù\n詬gòu,hòu\n詰jié,jí\n話huà,hua\n詳xiáng,yáng,xiang\n詻è,luò\n誇kuā,kuà\n語yǔ,yù,yu\n誠chéng,cheng\n誣wū,wú\n誤wù,wu\n誦sòng,song\n誧pǔ,bū\n誨huì,huǐ\n說shuō,shuì,yuè,shuò,shuo\n誰shéi,shuí,séi\n誼yì,yí\n調tiáo,diào,zhōu,diāo\n請qǐng,jìng,qīng,qíng,qìng\n諍zhēng,zhèng\n諒liàng,liáng\n論lùn,lún\n諜dié,xiè\n諦dì,tí\n諫jiàn,làn\n諭yù,tǒu\n諱huì,hui\n諳ān,tǒu\n諷fèng,fěng,fēng\n諸zhū,chú\n諼xuān,shuàn\n謀móu,mòu,mó\n謎mí,mì,mèi\n謙qiān,qiàn,zhàn\n謝xiè,xie\n謨mó,mò\n謫zhé,zé\n謹jǐn,jin\n譁huá,huā\n識shì,zhì,shí,shi\n譙qiáo,qiào\n讀dú,dòu\n讖chèn,chàn\n讜dǎng,dàng\n谷gǔ,yù\n谿xī,qī\n豁huò,huá,huō,hè\n豈qǐ,kǎi\n豉chǐ,shì\n貉hé,mò,háo\n貓māo,máo\n負fù,fu\n貫guàn,wān\n責zé,zhài\n貯zhǔ,zhù\n貴guì,gui\n貶biǎn,fá\n貸dài,tè\n費fèi,bì,fú,xìng,fei\n貿mào,mòu\n賃lìn,rèn\n賄huì,huǐ,huī\n資zī,zì\n賈gǔ,jiǎ,jià\n賊zéi,zé\n賒shē,shā\n賓bīn,bìn\n賜sì,cì\n賢xián,xiàn\n賣mài,mai\n質zhí,zhì\n賺zhuàn,zuàn\n贅zhuì,zhui\n贍shàn,dàn\n贛gàn,gòng\n赤chì,chi\n赳jiū,jiǔ\n起qǐ,qi\n趕gǎn,qián\n趙zhào,diào\n趟tàng,tāng\n趣qù,cù,qū\n趨qū,cù\n足zú,jù\n跌dié,diē\n跑pǎo,páo\n跛bǒ,bì\n跟gēn,gen\n跡jī,jì\n跤jiāo,qiāo,xiāo\n路lù,lu\n跳tiào,táo\n踏tà,tā,ta\n踐jiàn,jian\n踝huái,huà\n踢tī,ti\n踫pèng,pán\n踱duò,duó\n踹chuài,shuàn\n蹈dào,dǎo\n蹊xī,qī,qi\n蹟jī,jì\n蹣mán,pán,pǎn\n蹬dèng,dēng\n蹲dūn,cún\n蹶jué,juě,guì\n蹺qiāo,qiào\n蹼pú,pǔ\n躁zào,zao\n躂tà,dā,dá,da\n躡niè,shè\n身shēn,juān,shen\n躲duǒ,duo\n車chē,jū\n軋gá,yà,zhá,zhí\n軒xuān,xiǎn,xuàn\n軸zhóu,zhòu,zhú\n軻kē,kě\n軼yì,dié,yí\n較jiào,jiǎo,jué,jiáo,xiào\n載zài,zǎi,zāi\n輕qīng,qìng\n輜zī,zì\n輯jí,ji\n輸shū,shù\n輾niǎn,zhǎn\n輿yú,yù\n轂gǔ,gū\n轄xiá,kài,hé\n轉zhuǎn,zhuàn,zhuǎi,zhuan\n轍chè,zhé\n轔lín,lìn\n辟bì,pì\n辣là,la,lā\n辨biàn,piàn\n辯biàn,biǎn,pián\n辰chén,chen\n辱rù,rǔ\n迆yí,yǐ\n迎yíng,yìng\n迤yí,yǐ,tuó\n迫pò,pǎi\n迸bèng,bǐng\n追zhuī,duī,rǔ,rù\n送sòng,song\n逅hòu,gòu\n這zhè,zhèi\n通tōng,tong,tòng\n逛guàng,guang\n造zào,cào,zǎo\n逢féng,péng\n連lián,liǎn,liàn,lian\n逮dǎi,dài,dì\n逼bī,bì,bi\n遂suì,suí\n遊yóu,you\n運yùn,yǔn\n遍biàn,piàn\n過guò,guō,guo\n道dào,dao\n達dá,tà,tì,da\n違wéi,huí\n遛liù,liú,liu\n遜xùn,sùn\n遠yuǎn,yuàn\n遢tà,ta,tā\n適shì,dí,guā,kuò\n遮zhē,zhě\n遲chí,zhì\n遴lín,lìn\n選xuǎn,dié\n遺yí,wèi\n避bì,bèi\n還hái,huán,xuán,bù,pǐ,fū,fú,fōu,fǒu,wù,hai\n邊biān,bian\n邋lá,liè,lā\n那nà,nǎ,nā,nuó,nèi,něi,yǒu,na\n邪xié,yé,yá,yú,xú,xiá\n郃gé,hé\n郎láng,làng,lang\n郝hǎo,hè\n都dōu,dū\n郾yǎn,yàn\n鄉xiāng,xiàng\n鄗hào,qiāo\n鄘yōng,yóng\n鄙bǐ,bì\n鄧dèng,shān\n鄰lín,lìn\n鄴yè,qiū\n酈lì,zhí,lí\n酊dǐng,dīng\n酩míng,mǐng\n酪luò,lào\n酬chóu,chou\n酵xiào,jiào\n醃yān,ā,āng\n醋cù,zuò\n醒xǐng,xīng\n醫yī,yì\n醱pò,fā,pō\n釀niàng,niáng\n采cǎi,cài\n釋shì,yì\n里lǐ,li\n重zhòng,chóng\n量liàng,liáng,liang\n釐lí,xī,xǐ\n釘dīng,dìng,ding\n釙pò,pō\n釧chuàn,chuān\n釩fán,fǎn,fàn\n釵chāi,chā\n鈉nà,ruì\n鈐qián,hán\n鈔chāo,chào,chǎo\n鈕niǔ,chǒu\n鈷gū,gǔ,gú,gù\n鈸bá,bó\n鈹pí,pī\n鈽bù,bū\n鈾yòu,yóu,zhòu\n鈿diàn,tián\n鉀jiǎ,hé,jià,gé\n鉋bào,páo\n鉍bì,sè\n鉗qián,ān\n鉚mǎo,liǔ\n鉛qiān,yán\n鉻gè,luò,gē\n鉼bǐng,píng\n銑xiǎn,xǐ,xī\n銨ān,ǎn\n銳ruì,duì\n銷xiāo,xiao\n銻tì,tí,tī\n銼cuò,zuò\n鋁lǚ,lǜ\n鋅xīn,zǐ\n鋤chú,jǔ\n鋪pū,pù,pú\n鋸jù,jū,ju\n鋼gāng,gàng\n錕kūn,gǔn\n錢qián,jiǎn,qian\n錫xí,xī,tì\n錯cuò,cù,cuō\n鍊liàn,làn\n鍋guō,guǒ\n鍥qiè,jié\n鎊bàng,pāng\n鎗qiāng,chēng\n鎘gé,lì\n鎬gǎo,hào\n鏃zú,chuò,cù\n鏈liàn,lián\n鏑dí,dī\n鏜tāng,táng\n鏤lòu,lǘ,lǚ\n鏽xiù,yòu\n鐃náo,nào\n鐘zhōng,zhong\n鐲zhuó,shǔ\n鐵tiě,dié,zhí,tie\n鐺dāng,chēng,tāng,chéng,dang\n鑠shuò,yuè\n鑰yào,yuè\n鑲xiāng,ráng\n鑽zuān,zuàn,zuǎn\n鑿záo,zuò\n長cháng,zhǎng,zhàng,chàng\n門mén,men\n閃shǎn,shan\n開kāi,bìng,jiān,qí,yán,kai\n閒xián,jiān,jiàn\n間jiān,jiàn,jiǎn\n閔mǐn,mín\n閘zhá,zhā,yā\n閡hé,ài,hè\n閣gé,gē\n閤gé,hé\n閩mǐn,mín\n閻yán,yǎn,yàn\n闆bǎn,pàn\n闌lán,làn\n闕quē,què,qué\n闖chuǎng,chuàng,chèn\n關guān,xiào\n闡chǎn,chán\n闢pì,bì\n防fáng,fang\n阿ā,ē,à\n陂pí,pō,bēi\n降jiàng,xiáng\n陘xíng,jìng\n陝shǎn,xiá\n陰yīn,yìn,ān\n陳chén,zhèn,chen\n陴pí,pī\n陶táo,yáo\n陸lù,liù\n陽yáng,yang\n隄tí,dī\n隅yú,yù\n隆lóng,lōng\n隊duì,zhuì\n隋suí,duò\n隕yǔn,yuán\n隘ài,è\n險xiǎn,jiǎn,xián\n隱yǐn,yìn\n隸lì,dài\n隹zhuī,cuī,wéi\n隻zhī,zhǐ\n雀què,qiāo,qiǎo\n雅yǎ,yā\n雇gù,hù\n雋juàn,jùn\n雌cī,cí\n雖suī,suí\n雙shuāng,shuàng,huāng\n雜zá,guǐ,jiù,qiú,za\n離lí,chī\n難nán,nàn,nuó,nan\n雨yǔ,yù\n雩yú,yù\n雪xuě,xuè\n零líng,lián,ling\n雹báo,bó\n需xū,rú,xu\n霰xiàn,sǎn\n露lù,lòu\n霸bà,pò\n靈líng,lìng,ling\n青qīng,jīng\n靜jìng,jing\n非fēi,fěi\n靡mǐ,mí\n面miàn,mian\n靦miǎn,tiǎn\n靨yè,yǎn\n革gé,jí\n靶bǎ,bà\n靼dá,zhé\n鞅yāng,yàng,yǎng\n鞘qiào,shāo\n鞠jú,jū\n韁jiāng,gāng\n韃dá,tà\n韋wéi,huí\n韜tāo,tào\n音yīn,yìn,yin\n韹huáng,yīng\n頁yè,xié\n頃qǐng,qīng,kuǐ\n項xiàng,xiang\n須xū,xu\n頊xù,xū\n頌sòng,róng\n頑wán,kūn\n頒bān,fén\n頓dùn,dú\n頗pǒ,pō,pó,pò\n頜hàn,gé,hé,nán,hē\n頡jié,xié,jiá\n頫fǔ,miǎn,tiào\n頭tóu,tou\n頸jǐng,gěng\n頻pín,bīn\n顆kē,kě\n題tí,dì,tǐ\n額é,è\n顏yán,yá\n顛diān,diàn,tián\n類lèi,lei\n顧gù,gu\n顫zhàn,chàn,shān,zhan\n風fēng,fèng,fěng\n颯sà,lì\n颱tái,tāi,yí\n食shí,sì,yì,shi\n飩dùn,tún,zhùn,tun\n飭chì,shì\n飲yǐn,yìn\n飴yí,sì\n飾shì,chì\n餃jiǎo,jiào\n餅bǐng,bing\n養yǎng,yàng\n餘yú,xú,yu,yé\n餚yáo,xiáo\n餛hún,kūn\n餡xiàn,kàn\n餾liù,liú\n饉jǐn,jìn\n首shǒu,shou\n馨xīn,xīng\n馬mǎ,ma\n馮féng,píng\n馱tuó,duò,tuò\n馴xún,xùn\n駒jū,jù\n駕jià,jiā\n駝tuó,tuo\n駱luò,jià\n騎qí,jì\n騫qiān,jiǎn\n騰téng,teng,tēng\n騷sāo,sǎo\n驀mò,mà\n驃piào,biāo,diào\n驕jiāo,xiāo\n驚jīng,liáng,liàng,hèn\n驟zòu,zhòu\n驪lí,chí\n骨gǔ,gū,gú,gu\n骯āng,kǎng,háng\n骰tóu,shǎi\n髁kē,kè\n髒zāng,zǎng,zàng\n體tǐ,tī,bèn\n高gāo,gao\n髮fǎ,fà,fā,fa\n髻jì,ji\n鬥dòu,dǒu\n鬧nào,nao\n鬨hòng,xiàng,hǒng,hōng\n鬲lì,gé\n魄pò,tuò\n魏wèi,wéi\n魯lǔ,lǚ\n鮑bào,bāo\n鮭guī,xié,guì\n鮮xiān,xiǎn,xiàn,xian\n鯈chóu,tiáo,yóu\n鯖qīng,zhēng\n鯽jì,zéi\n鰓sāi,xǐ\n鰥guān,guàn\n鰾biào,piào\n鱖guì,jué\n鳥niǎo,diǎo\n鳩jiū,jiù,qiú\n鴃jué,jú\n鴆zhèn,dàn\n鴉yā,yǎ\n鴦yāng,yang\n鴻hóng,hòng\n鵑juān,jiān\n鵠hú,gǔ,gù\n鵪ān,yā\n鵬péng,fèng\n鵲què,qiǎo\n鶉chún,tuán\n鶴hè,háo\n鷂yào,yáo\n鸛guàn,huān,quán\n鹵lǔ,xī\n鹽yán,yàn\n麗lì,lí\n麥mài,mò,líng\n麴qú,qū,qǔ\n麻má,ma\n麼me,má,mó,ma,mǒ,yāo\n黑hēi,hè,hěi\n點diǎn,dian\n鼓gǔ,gu\n齊qí,jì,zī,zhāi,jǐ\n齜zī,chái\n齟jǔ,zhā\n齦yín,kěn,yǐn\n齧niè,yǎo\n齬yǔ,wú\n龍lóng,lǒng\n龐páng,péng,lóng\n龜guī,jūn,qiū";
/** 合法的漢語拼音音節（不含聲調，ü 寫作 v），用來切分連寫的 TBCL 參考漢語拼音。 */
var GR_PY_SYLLABLES = "a e m o ai an ao ba bi bo bu ca ce ci cu da de di du eh ei en er fa fo fu ga ge gu ha he hu ji ju ka ke ku la le li lo lu lv ma me mi mo mu na ne ni nu nv ou pa pi po pu qi qu re ri ru sa se si su ta te ti tu wa wo wu xi xu ya ye yi yo yu za ze zi zu ang bai ban bao bei ben bia bie bin cai can cao cen cha che chi chu cou cua cui cun cuo dai dan dao dei den dia die diu dou due dui dun duo eng fan fei fen fou gai gan gao gei gen gou gua gui gun guo hai han hao hei hen hou hua hue hui hun huo jia jie jin jiu jue jun kai kan kao kei ken kou kua kui kun kuo lai lan lao lei lia lie lin liu lou lun luo lve mai man mao mei men mie min miu mou nai nan nao nei nen nia nie nin niu nou nui nun nuo nve pai pan pao pei pen pia pie pin pou qia qie qin qiu que qun ran rao ren rou rua rui run ruo sai san sao sei sen sha she shi shu sou sui sun suo tai tan tao tie tou tui tun tuo wai wan wei wen xia xie xin xiu xue xun yai yan yao yin you yue yun zai zan zao zei zen zha zhe zhi zhu zou zua zui zun zuo bang beng bian biao bing cang ceng chai chan chao chen chou chua chui chun chuo cong cuan dang deng dian diao ding dong duan fang feng fiao gang geng gong guai guan hang heng hong huai huan jian jiao jing juan kang keng kong kuai kuan lang leng lian liao ling long luan lvan mang meng mian miao ming nang neng nian niao ning nong nuan pang peng pian piao ping qian qiao qing quan rang reng rong ruan sang seng shai shan shao shei shen shou shua shui shun shuo song suan tang teng tian tiao ting tong tuan wang weng xian xiao xing xuan yang ying yong yuan zang zeng zhai zhan zhao zhei zhen zhou zhua zhui zhun zhuo zong zuan biang chang cheng chong chuai chuan diang guang huang jiang jiong kuang liang niang qiang qiong shang sheng shuai shuan xiang xiong zhang zheng zhong zhuai zhuan chuang shuang zhuang";


// ================================================================ Analyzer.gs
/**
 * Analyzer.gs — TBCL 分級檢核引擎
 *
 * 純 JavaScript，不呼叫任何 Apps Script 服務，所以同一份程式可以在 Apps Script、瀏覽器與 Node 執行。
 * 方法移植自 taiwan-huayu-materials 技能的 level_profiler.py：
 *   - 斷詞：詞典雙向最大匹配，詞典＝TBCL ∪ 生詞 ∪ 已學詞 ∪ 專名／保留詞；
 *   - 統計：TBCL 等級分布、目標級覆蓋率、可理解覆蓋率、超綱詞、未收錄片段、漢字等級、句長；
 *   - 規範：疑似簡體字、非標準字形、大陸用語候選。
 * 限制：只檢核詞彙、漢字、句長與用語候選；語法點、語意、自然度交給 LLM 與人工判斷。
 */
var GRAnalyzer = (function () {
  'use strict';

  var HAN_RE = /[\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{20000}-\u{3134F}\u{3007}]/u;
  var SENT_END = /[。！？；!?;…\n]+/;
  var SPEAKER_RE = /^[ \t　]*[A-Za-z㐀-鿿]{1,6}[ \t]*[：:][ \t　]*/;
  var NUMERAL_RE = /^第?[〇零一二三四五六七八九十百千萬億兩幾]+$/;
  var BAND = { 1: '基礎', 2: '基礎', 3: '基礎', 4: '進階', 5: '進階', 6: '精熟', 7: '精熟' };
  var FW_DIGITS = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9' };
  var CN_DIGITS = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };

  function isHan(ch) { return HAN_RE.test(ch); }
  function chars(s) { return Array.from(s || ''); }
  function hanCount(s) { var n = 0; chars(s).forEach(function (c) { if (isHan(c)) n++; }); return n; }
  function round1(x) { return Math.round(x * 1000) / 10; }   // 0.9734 → 97.3
  function dict() { return Object.create(null); }

  // --------------------------------------------------------------------------- 詞表解析

  /** '第1級' '第1*級' '1' 'Level 3' '七' → 1..7；認不出回傳 null。 */
  function parseLevel(s) {
    if (s === null || s === undefined || s === '') return null;
    if (typeof s === 'number') return s >= 1 && s <= 9 ? Math.floor(s) : null;
    var t = String(s).replace(/[０-９]/g, function (c) { return FW_DIGITS[c]; })
                     .replace(/[一二三四五六七八九]/g, function (c) { return CN_DIGITS[c]; });
    var m = /(\d+)/.exec(t);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return n >= 1 && n <= 9 ? n : null;
  }

  /** 「車子/車」→ 車子、車；「中1」→ 中；「哪(兒)」→ 哪、哪兒。 */
  function expandEntry(raw) {
    var out = dict();
    var s = String(raw === null || raw === undefined ? '' : raw).trim().replace(/　/g, ' ');
    s.split(/[／\/、]/).forEach(function (part) {
      part = part.replace(/\s+/g, '').replace(/[0-9０-９*＊]+$/, '');
      if (!part) return;
      var stack = [part];
      while (stack.length) {
        var p = stack.pop();
        var m = /[（(]([^）)]*)[）)]/.exec(p);
        if (m) {
          stack.push(p.slice(0, m.index) + m[1] + p.slice(m.index + m[0].length));
          stack.push(p.slice(0, m.index) + p.slice(m.index + m[0].length));
        } else if (p) {
          out[p] = true;
        }
      }
    });
    return Object.keys(out);
  }

  function findCol(header, keys, avoid) {
    avoid = avoid || [];
    for (var k = 0; k < keys.length; k++) {
      for (var i = 0; i < header.length; i++) {
        var h = String(header[i] || '').trim().toLowerCase();
        if (h.indexOf(keys[k]) >= 0 && !avoid.some(function (a) { return h.indexOf(a) >= 0; })) return i;
      }
    }
    return -1;
  }

  /**
   * 由二維陣列（試算表 getValues() 或 CSV 解析結果）建立分級詞典。
   * 支援國教院詞語表（序號,詞語,等別,級別,情境,…,參考注音,參考漢語拼音）或兩欄「詞語,級別」。
   * kind: 'word'（詞語表）或 'char'（漢字表）。
   * 回傳 { map: {詞形: {l, p, z}}, entries, forms, maxLen }；同一詞形取最低等級。
   */
  function buildLeveled(rows, kind) {
    var res = { map: dict(), entries: 0, forms: 0, maxLen: 1 };
    rows = (rows || []).filter(function (r) { return r && r.some(function (c) { return String(c).trim() !== ''; }); });
    if (!rows.length) return res;
    var header = rows[0].map(function (c) { return String(c); });
    var wordKeys = kind === 'char' ? ['漢字', '汉字', 'hanzi', 'character', '字'] : ['詞語', '词语', 'word', '詞彙', '词汇', '詞'];
    var wordAvoid = kind === 'char' ? ['頻', '频', '序', '詞', '词'] : ['頻', '频', '序'];
    var wi = findCol(header, wordKeys, wordAvoid);
    var li = findCol(header, ['級別', '级别', '等級', '等级', 'level', '級', '级']);
    var pi = findCol(header, ['參考漢語拼音', '漢語拼音', '汉语拼音', '拼音', 'pinyin']);
    var zi = findCol(header, ['參考注音', '注音', 'zhuyin', 'bopomofo']);
    var start = 1;
    if (wi < 0 || li < 0) {
      wi = 0; li = 1; pi = -1; zi = -1;
      start = parseLevel(rows[0][1]) !== null ? 0 : 1;
    }
    var map = res.map;
    for (var r = start; r < rows.length; r++) {
      var row = rows[r];
      var lvl = parseLevel(row[li]);
      var star = /[*＊]/.test(String(row[li] || '')) ? 1 : 0;   // 「第1*級」＝該級後段
      if (lvl === null || lvl > 7) continue;
      res.entries++;
      var forms = kind === 'char' ? chars(String(row[wi] || '').trim()).filter(isHan) : expandEntry(row[wi]);
      var pys = pi >= 0 ? String(row[pi] || '').split(/[／\/]/) : [];
      var zys = zi >= 0 ? String(row[zi] || '').split(/[／\/]/) : [];
      var parts = String(row[wi] || '').split(/[／\/、]/);
      forms.forEach(function (f) {
        // 詞形與拼音數量一致時逐一對齊（車子/車 ↔ chēzi/chē），否則保留整欄
        var idx = -1;
        for (var k = 0; k < parts.length; k++) if (expandEntry(parts[k]).indexOf(f) >= 0) { idx = k; break; }
        var p = pys.length === parts.length && idx >= 0 ? pys[idx] : pys.join('/');
        var z = zys.length === parts.length && idx >= 0 ? zys[idx] : zys.join('/');
        var old = map[f];
        if (!old || lvl < old.l || (lvl === old.l && old.s && !star)) map[f] = { l: lvl, s: star, p: String(p || '').trim(), z: String(z || '').trim() };
      });
    }
    var keys = Object.keys(map);
    res.forms = keys.length;
    res.maxLen = Math.min(12, keys.reduce(function (m, w) { return Math.max(m, chars(w).length); }, 1));
    return res;
  }

  /** 壓縮成「詞\t級\t拼音\t注音」行，方便放進快取。 */
  function serializeLeveled(lx) {
    var lines = [lx.entries + '\t' + lx.maxLen];
    Object.keys(lx.map).forEach(function (w) {
      var v = lx.map[w];
      lines.push(w + '\t' + v.l + '\t' + (v.p || '') + '\t' + (v.z || '') + '\t' + (v.s ? 1 : 0));
    });
    return lines.join('\n');
  }

  function parseSerialized(str) {
    var res = { map: dict(), entries: 0, forms: 0, maxLen: 1 };
    if (!str) return res;
    var lines = str.split('\n');
    var head = lines[0].split('\t');
    res.entries = parseInt(head[0], 10) || 0;
    res.maxLen = parseInt(head[1], 10) || 1;
    for (var i = 1; i < lines.length; i++) {
      var c = lines[i].split('\t');
      if (c[0]) res.map[c[0]] = { l: parseInt(c[1], 10), p: c[2] || '', z: c[3] || '', s: c[4] === '1' ? 1 : 0 };
    }
    res.forms = Object.keys(res.map).length;
    return res;
  }

  /** 每行一詞、或以逗號／頓號／空白分隔的清單 → 詞形陣列。 */
  function parseWordList(input) {
    if (!input) return [];
    var items = Array.isArray(input) ? input : String(input).split(/[\n,，;；\s]+/);
    var out = dict();
    items.forEach(function (it) {
      var s = Array.isArray(it) ? it[0] : it;
      s = String(s === null || s === undefined ? '' : s).trim();
      if (!s || s.charAt(0) === '#') return;
      expandEntry(s).forEach(function (f) { out[f] = true; });
    });
    return Object.keys(out);
  }

  // --------------------------------------------------------------------------- 字形與用語資源

  function parseTsv(str) {
    return String(str || '').split('\n').filter(function (l) { return l.trim() && l.charAt(0) !== '#'; })
      .map(function (l) { return l.split('\t'); });
  }

  /**
   * 準備字形與用語資源。extraTerms：試算表「用語對照」的列 [大陸用詞, 臺灣用詞, 備註]，會覆蓋內建條目。
   */
  function prepareNorms(assets, extraTerms) {
    var t2s = dict();
    parseTsv(assets.t2s).forEach(function (r) { if (r.length >= 2) t2s[r[0]] = r[1].split('|'); });
    var shared = dict();
    chars(String(assets.sharedChars || '').replace(/\s/g, '')).forEach(function (c) { shared[c] = true; });
    var simpOnly = dict();
    Object.keys(t2s).forEach(function (t) {
      t2s[t].forEach(function (s) { if (s !== t && !shared[s] && !t2s[s]) simpOnly[s] = true; });
    });
    var variants = dict();
    parseTsv(assets.variants).forEach(function (r) { if (r.length >= 2) variants[r[0]] = { to: r[1], note: r[2] || '' }; });
    var terms = dict();
    parseTsv(assets.cnTwTerms).concat(extraTerms || []).forEach(function (r) {
      var cn = String(r[0] || '').trim();
      if (cn && r[1]) terms[cn] = { tw: String(r[1]).trim(), note: String(r[2] || '').trim() };
    });
    // 同時比對簡體字形（未轉換的大陸教材），結果歸回正體條目
    var forms = dict();
    Object.keys(terms).forEach(function (t) {
      [t].concat(simplifiedVariants(t, t2s, 8)).forEach(function (f) { if (!(f in forms)) forms[f] = t; });
    });
    return { t2s: t2s, simpOnly: simpOnly, variants: variants, terms: terms, termForms: forms };
  }

  function simplifiedVariants(word, t2s, limit) {
    var acc = [''];
    chars(word).forEach(function (ch) {
      var opts = t2s[ch] || [ch];
      var next = [];
      acc.forEach(function (a) { opts.forEach(function (o) { next.push(a + o); }); });
      acc = next.slice(0, limit);
    });
    return acc;
  }

  function findTerms(text, forms) {
    var hits = dict();
    var taken = new Array(text.length);
    Object.keys(forms).sort(function (a, b) { return b.length - a.length; }).forEach(function (f) {
      var start = 0;
      while (true) {
        var i = text.indexOf(f, start);
        if (i < 0) break;
        var free = true;
        for (var k = i; k < i + f.length; k++) if (taken[k]) { free = false; break; }
        if (free) {
          hits[f] = (hits[f] || 0) + 1;
          for (var j = i; j < i + f.length; j++) taken[j] = true;
        }
        start = i + 1;
      }
    });
    return hits;
  }

  function contextOf(text, needle, width) {
    width = width || 12;
    var i = text.indexOf(needle);
    if (i < 0) return '';
    return text.slice(Math.max(0, i - width), Math.min(text.length, i + needle.length + width)).replace(/\n/g, ' ');
  }

  // --------------------------------------------------------------------------- 多音字（ToneOZ IVS）

  /** GR_PHONIC 字串 → { 字: [讀音0, 讀音1, …] }（讀音存成「無調拼音＋數字調」，例如 le5、xue2）。 */
  function preparePhonic(str, syllables) {
    var map = dict();
    String(str || '').split('\n').forEach(function (ln) {
      var cs = chars(ln);
      if (cs.length > 1) map[cs[0]] = cs.slice(1).join('').split(',').map(function (p) { return pySyl(p); });
    });
    var syl = dict();
    String(syllables || '').split(/\s+/).forEach(function (x) { if (x) syl[x] = true; });
    Object.defineProperty(map, '__syl', { value: syl, enumerable: false });
    return map;
  }

  var TONE = { 'ā': 'a1', 'á': 'a2', 'ǎ': 'a3', 'à': 'a4', 'ē': 'e1', 'é': 'e2', 'ě': 'e3', 'è': 'e4',
               'ī': 'i1', 'í': 'i2', 'ǐ': 'i3', 'ì': 'i4', 'ō': 'o1', 'ó': 'o2', 'ǒ': 'o3', 'ò': 'o4',
               'ū': 'u1', 'ú': 'u2', 'ǔ': 'u3', 'ù': 'u4', 'ǖ': 'v1', 'ǘ': 'v2', 'ǚ': 'v3', 'ǜ': 'v4', 'ü': 'v0' };

  /** 帶調號的單一音節 → 「無調拼音＋數字調」：xué → xue2、de → de5。 */
  function pySyl(p) {
    var base = '', tone = 5;
    chars(String(p || '').toLowerCase().normalize('NFC').replace(/u:/g, 'ü')).forEach(function (c) {
      var m = TONE[c];
      if (m) { base += m.charAt(0); if (m.charAt(1) !== '0') tone = +m.charAt(1); }
      else if (/[a-z]/.test(c)) base += c;
    });
    return base ? base + tone : '';
  }

  /** 把整個詞的拼音切成 n 個音節（先依空白、撇號、連字號，再依合法音節表切分連寫）。切不出剛好 n 個時回傳 null。 */
  function splitPinyin(py, n, syl) {
    var chunks = String(py || '').toLowerCase().normalize('NFC').replace(/u:/g, 'ü').split(/[\s'’‘\-·]+/).filter(Boolean);
    var segs = chunks.map(function (ch) {
      var cs = chars(ch).filter(function (c) { return TONE[c] || /[a-z]/.test(c); });
      var base = cs.map(function (c) { return TONE[c] ? TONE[c].charAt(0) : c; }).join('');
      var out = [], memo = dict();
      (function walk(i, acc) {
        if (out.length > 8) return;
        if (i === base.length) { out.push(acc.slice()); return; }
        for (var L = Math.min(6, base.length - i); L > 0; L--) {
          if (!syl[base.slice(i, i + L)]) continue;
          acc.push(cs.slice(i, i + L).join('')); walk(i + L, acc); acc.pop();
        }
      })(0, []);
      return out;
    });
    var result = null;
    (function pick(k, acc) {
      if (result) return;
      if (k === segs.length) { if (acc.length === n) result = acc.slice(); return; }
      segs[k].forEach(function (s) { if (acc.length + s.length <= n) pick(k + 1, acc.concat(s)); });
    })(0, []);
    return result;
  }

  /**
   * 依 TBCL 參考漢語拼音為詞中的多音字加上 IVS 選擇器。
   * ToneOZ／注音 IVS 規格：字本身＝預設讀音（第 0 個）；字＋U+E01E0＋i（i ≥ 1）＝第 i 個讀音；
   * 字＋U+E01E0 單獨使用＝不顯示標音，所以預設讀音不加任何選擇器。
   * 拼音切不出與字數相同的音節數，或不需要選音時回傳 null。
   */
  function ivsFor(word, pinyin, phonic) {
    if (!pinyin || !phonic) return null;
    var cs = chars(word);
    var syl = splitPinyin(String(pinyin).split(/[\/／]/)[0], cs.length, phonic.__syl || dict());
    if (!syl) return null;
    var out = '', changed = false;
    for (var i = 0; i < cs.length; i++) {
      out += cs[i];
      var list = phonic[cs[i]];
      if (!list) continue;
      var idx = list.indexOf(pySyl(syl[i]));
      if (idx > 0) { out += String.fromCodePoint(0xE01E0 + idx); changed = true; }
    }
    return changed ? out : null;
  }

  // --------------------------------------------------------------------------- 斷詞

  function Segmenter(has, maxLen) {
    this.has = has;
    this.maxLen = Math.max(1, maxLen || 1);
  }
  Segmenter.prototype.fmm = function (cs) {
    var i = 0, out = [], n = cs.length;
    while (i < n) {
      for (var L = Math.min(this.maxLen, n - i); L > 0; L--) {
        var w = cs.slice(i, i + L).join('');
        if (L === 1 || this.has(w)) { out.push(w); i += L; break; }
      }
    }
    return out;
  };
  Segmenter.prototype.bmm = function (cs) {
    var j = cs.length, out = [];
    while (j > 0) {
      for (var L = Math.min(this.maxLen, j); L > 0; L--) {
        var w = cs.slice(j - L, j).join('');
        if (L === 1 || this.has(w)) { out.push(w); j -= L; break; }
      }
    }
    return out.reverse();
  };
  Segmenter.prototype.score = function (seg) {
    var self = this, oov = 0, singles = 0;
    seg.forEach(function (w) { if (!self.has(w)) oov++; if (chars(w).length === 1) singles++; });
    return [seg.length, oov, singles];
  };
  Segmenter.prototype.cut = function (run) {
    var cs = chars(run);
    var f = this.fmm(cs), b = this.bmm(cs);
    if (f.join('|') === b.join('|')) return f;
    var sf = this.score(f), sb = this.score(b);
    for (var i = 0; i < 3; i++) { if (sf[i] !== sb[i]) return sf[i] < sb[i] ? f : b; }
    return f;
  };

  // --------------------------------------------------------------------------- 主分析

  /**
   * analyze(text, ctx, opts)
   *  ctx  = { lex, chars, norms, phonic, lexLabel }（lex/chars 為 buildLeveled 結果，norms 為 prepareNorms 結果，phonic 為 preparePhonic 結果，可省略）
   *  opts = { target, purpose('extensive'|'intensive'), threshold, glossary, known, proper,
   *           stripSpeakers(預設 true), sentLenGuide, strictStar（準備一級：1* 詞視為超綱）, top(預設 60), withSpans(預設 true) }
   */
  function analyze(text, ctx, opts) {
    opts = opts || {};
    ctx = ctx || {};
    text = stripSelectors(String(text || '')).replace(/\r\n?/g, '\n');
    var lexMap = ctx.lex && ctx.lex.map ? ctx.lex.map : dict();
    var lexLoaded = !!(ctx.lex && ctx.lex.forms > 0);
    var top = opts.top || 60;
    var threshold = opts.threshold || (opts.purpose === 'intensive' ? 0.95 : 0.98);
    var target = opts.target ? parseInt(opts.target, 10) : null;

    var glossary = setOf(parseWordList(opts.glossary));
    var known = setOf(parseWordList(opts.known));
    var proper = setOf(parseWordList(opts.proper));
    var maxLen = Math.max(ctx.lex ? ctx.lex.maxLen : 1, maxLenOf(glossary), maxLenOf(known), maxLenOf(proper));
    var has = function (w) { return !!(lexMap[w] || glossary[w] || known[w] || proper[w]); };
    var seg = new Segmenter(has, Math.min(maxLen, 12));

    // ---- 逐行切出 spans：w=TBCL 詞、g=生詞、k=已學詞、p=專名／保留、n=數詞、o=未收錄、x=非漢字、s=說話者標籤
    var spans = [];
    var body = [];          // 去除說話者標籤後的文本（計算句長、用語）
    var speakers = opts.stripSpeakers !== false ? speakerNames(text) : dict();
    text.split('\n').forEach(function (line, li) {
      if (li > 0) { spans.push({ t: '\n', k: 'x' }); body.push('\n'); }
      if (opts.stripSpeakers !== false) {
        var m = SPEAKER_RE.exec(line);
        if (m && speakers[labelName(m[0])] && line.charAt(m[0].length) !== '「' && m[0].length < line.length) {
          spans.push({ t: m[0], k: 's' });
          line = line.slice(m[0].length);
        }
      }
      body.push(line);
      var cs = chars(line), buf = '', bufHan = null;
      var flush = function () {
        if (!buf) return;
        if (bufHan) segmentRun(buf); else spans.push({ t: buf, k: 'x' });
        buf = '';
      };
      cs.forEach(function (c) {
        var h = isHan(c);
        if (bufHan !== null && h !== bufHan) flush();
        bufHan = h; buf += c;
      });
      flush();
    });

    function segmentRun(run) {
      var oov = '';
      var pushOov = function () {
        if (!oov) return;
        spans.push({ t: oov, k: NUMERAL_RE.test(oov) ? 'n' : 'o' });
        oov = '';
      };
      seg.cut(run).forEach(function (w) {
        if (!has(w)) { oov += w; return; }
        pushOov();
        var prev = spans[spans.length - 1];
        if (prev && prev.k === 'n' && /^第/.test(prev.t) && /^[章節回課篇部集冊卷]$/.test(w)) {
          prev.t += w;                              // 「第一章」「第三課」是章節編號，不檢查等級
          return;
        }
        if (lexMap[w]) {
          var sp = { t: w, k: 'w', l: lexMap[w].l, gl: !!(glossary[w] || known[w] || proper[w]) };
          if (lexMap[w].s) sp.st = 1;
          var iv = ctx.phonic ? ivsFor(w, lexMap[w].p, ctx.phonic) : null;
          if (iv) sp.iv = iv;                       // ToneOZ 字型用：含多音字選擇器的字串
          spans.push(sp);
        }
        else if (glossary[w]) spans.push({ t: w, k: 'g' });
        else if (known[w]) spans.push({ t: w, k: 'k' });
        else spans.push({ t: w, k: 'p' });
      });
      pushOov();
    }

    var bodyText = body.join('');
    var toks = spans.filter(function (s) { return 'wgkpno'.indexOf(s.k) >= 0; });
    var nTok = toks.length;
    var hanTotal = hanCount(bodyText);

    // ---- 句長
    var sents = bodyText.split(SENT_END).filter(function (s) { return hanCount(s) > 0; });
    var lens = sents.map(hanCount);
    var guide = opts.sentLenGuide || null;
    var longCut = guide ? Math.ceil(guide * 1.8) : null;
    var sentStats = {
      count: lens.length,
      mean: lens.length ? Math.round(10 * lens.reduce(sum, 0) / lens.length) / 10 : 0,
      median: median(lens),
      max: lens.length ? Math.max.apply(null, lens) : 0,
      guide: guide,
      longest: sents.map(function (s, i) { return { len: lens[i], text: s.trim() }; })
        .sort(function (a, b) { return b.len - a.len; }).slice(0, 5),
      overLong: longCut ? sents.map(function (s, i) { return { len: lens[i], text: s.trim() }; })
        .filter(function (x) { return x.len > longCut; }) : []
    };

    // ---- 等級分布
    var byLv = {}, byLvType = {}, cat = { g: 0, k: 0, p: 0, n: 0, o: 0 }, catType = { g: dict(), k: dict(), p: dict(), n: dict(), o: dict() };
    for (var lv = 1; lv <= 7; lv++) { byLv[lv] = 0; byLvType[lv] = dict(); }
    toks.forEach(function (s) {
      if (s.k === 'w') { byLv[s.l]++; byLvType[s.l][s.t] = (byLvType[s.l][s.t] || 0) + 1; }
      else { cat[s.k]++; catType[s.k][s.t] = (catType[s.k][s.t] || 0) + 1; }
    });
    var support = cat.g + cat.k + cat.p + cat.n;
    var dist = [], cum = 0;
    for (lv = 1; lv <= 7; lv++) {
      cum += byLv[lv];
      dist.push({ level: lv, band: BAND[lv], tokens: byLv[lv], pct: nTok ? round1(byLv[lv] / nTok) : 0,
                  cumPct: nTok ? round1(cum / nTok) : 0, types: Object.keys(byLvType[lv]).length });
    }

    // ---- 適讀等級估計：最小的 L，使「≤L 級詞＋生詞／已學／專名／數詞」覆蓋率 ≥ 門檻
    var curve = [], est = null, acc = 0;
    for (lv = 1; lv <= 7; lv++) {
      acc += byLv[lv];
      var cov = nTok ? (acc + support) / nTok : 0;
      curve.push({ level: lv, cov: round1(cov) });
      if (est === null && cov >= threshold) est = lv;
    }
    var oovPct = nTok ? cat.o / nTok : 0;
    var estimate = {
      level: lexLoaded && nTok ? est : null,
      threshold: round1(threshold),
      curve: curve,
      beyond: lexLoaded && nTok && est === null,
      reliable: lexLoaded && oovPct <= 0.05,
      oovPct: round1(oovPct)
    };

    var result = {
      meta: { lexiconLoaded: lexLoaded, lexiconLabel: ctx.lexLabel || '', lexiconForms: ctx.lex ? ctx.lex.forms : 0,
              charsLoaded: !!(ctx.chars && ctx.chars.forms), estimated: !lexLoaded },
      stats: { hanChars: hanTotal, tokens: nTok, types: Object.keys(toks.reduce(function (m, s) { m[s.t] = 1; return m; }, {})).length },
      sentences: sentStats,
      levelDist: dist,
      support: { glossary: cat.g, known: cat.k, proper: cat.p, numerals: cat.n },
      oov: topList(catType.o, top).map(function (x) { return { w: x[0], n: x[1], ctx: contextOf(bodyText, x[0]) }; }),
      estimate: estimate,
      warnings: []
    };
    if (!lexLoaded) result.warnings.push('尚未載入 TBCL 詞語表：等級統計無法計算，所有等級判斷都只能「推估」。請在試算表「TBCL詞語」分頁匯入國教院詞語表。');
    else if (!estimate.reliable) result.warnings.push('未收錄片段約佔 ' + estimate.oovPct + '%，等級估計可能偏高。人名、地名、店名請加入「專名／保留詞」後重跑。');

    // ---- 目標等級檢核
    if (target) {
      var strictStar = !!opts.strictStar && target === 1;
      var isAbove = function (s) { return s.k === 'w' && (s.l > target || (strictStar && s.l === 1 && !!s.st)); };
      var within = 0;
      var above = dict();
      toks.forEach(function (s) {
        if (s.k !== 'w') return;
        if (!isAbove(s)) { within++; return; }
        s.ab = 1;                                   // 前端依此標朱筆
        if (!above[s.t]) above[s.t] = { w: s.t, lv: s.l, lvl: s.l > target ? String(s.l) : s.l + '*', n: 0, glossed: s.gl };
        above[s.t].n++;
      });
      var aboveList = Object.keys(above).map(function (w) {
        var a = above[w], e = lexMap[w] || {};
        a.ctx = contextOf(bodyText, w); a.py = e.p || ''; a.zy = e.z || '';
        return a;
      }).sort(function (a, b) { return b.lv - a.lv || b.n - a.n; });
      var unglossed = aboveList.filter(function (a) { return !a.glossed; });
      var glossedTok = aboveList.filter(function (a) { return a.glossed; }).reduce(function (m, a) { return m + a.n; }, 0);
      var unglossedTok = unglossed.reduce(function (m, a) { return m + a.n; }, 0);
      var effective = nTok ? (within + support + glossedTok) / nTok : 0;
      var status = estimate.level === null ? (estimate.beyond ? '偏難' : '無法判定')
                 : estimate.level > target ? '偏難' : estimate.level < target ? '偏易' : '合級';
      if (strictStar && status !== '偏難' && unglossed.length && effective < threshold) status = '偏難';
      result.target = {
        level: target,
        strictStar: strictStar,
        withinPct: nTok ? round1(within / nTok) : 0,
        effectivePct: round1(effective),
        threshold: round1(threshold),
        pass: lexLoaded && effective >= threshold,
        status: lexLoaded ? status : '無法判定',
        verdict: effective >= 0.98 ? '≥98%：適合泛讀、分級讀本、測驗閱讀文本'
               : effective >= 0.95 ? '95–98%：適合教師帶領的精讀課文'
               : '<95%：對目標等級偏難，先處理「超綱且未列生詞」',
        aboveTypes: aboveList.length,
        aboveUnglossedTypes: unglossed.length,
        aboveUnglossedTokens: unglossedTok,
        newWordsPer100: nTok ? Math.round(1000 * unglossedTok / nTok) / 10 : 0,
        above: aboveList.slice(0, top),
        singleUse: unglossed.filter(function (a) { return a.n === 1; }).map(function (a) { return a.w; }).slice(0, top),
        targetLevelShare: nTok ? round1(byLv[target] / nTok) : 0
      };
    }

    // ---- 漢字等級（選用）
    if (ctx.chars && ctx.chars.forms) {
      var cmap = ctx.chars.map, ccount = dict(), cLv = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }, notIn = dict(), nNot = 0;
      chars(bodyText).forEach(function (c) { if (isHan(c)) ccount[c] = (ccount[c] || 0) + 1; });
      Object.keys(ccount).forEach(function (c) {
        if (cmap[c]) cLv[cmap[c].l] += ccount[c]; else { notIn[c] = ccount[c]; nNot += ccount[c]; }
      });
      result.chars = {
        dist: Object.keys(cLv).map(function (k) { return { level: +k, n: cLv[k], pct: hanTotal ? round1(cLv[k] / hanTotal) : 0 }; }),
        notInList: Object.keys(notIn),
        notInCount: nNot,
        above: target ? Object.keys(ccount).filter(function (c) { return cmap[c] && cmap[c].l > target; })
          .map(function (c) { return { c: c, lv: cmap[c].l, n: ccount[c] }; }).sort(function (a, b) { return b.lv - a.lv; }) : []
      };
    }

    // ---- 字形與用語
    if (ctx.norms) {
      var nm = ctx.norms, simp = dict(), vars = dict();
      chars(bodyText).forEach(function (c) {
        if (nm.variants[c]) vars[c] = (vars[c] || 0) + 1;
        else if (nm.simpOnly[c]) simp[c] = (simp[c] || 0) + 1;
      });
      var raw = findTerms(bodyText, nm.termForms), termHits = dict();
      Object.keys(raw).forEach(function (f) {
        var t = nm.termForms[f];
        if (!termHits[t]) termHits[t] = { term: t, form: f, n: 0, tw: nm.terms[t].tw, note: nm.terms[t].note };
        termHits[t].n += raw[f];
      });
      var simpN = Object.keys(simp).reduce(function (m, c) { return m + simp[c]; }, 0);
      result.norms = {
        simplified: topList(simp, top).map(function (x) { return { c: x[0], n: x[1] }; }),
        simplifiedPct: hanTotal ? round1(simpN / hanTotal) : 0,
        variants: topList(vars, top).map(function (x) { return { c: x[0], n: x[1], to: nm.variants[x[0]].to, note: nm.variants[x[0]].note }; }),
        terms: Object.keys(termHits).map(function (t) { var h = termHits[t]; h.ctx = contextOf(bodyText, h.form); return h; })
          .sort(function (a, b) { return b.n - a.n; })
      };
      if (hanTotal && simpN / hanTotal > 0.05) {
        result.warnings.unshift('文本約 ' + result.norms.simplifiedPct + '% 為簡體字。TBCL 詞表是正體，轉成正體前等級統計不可靠。');
      }
    }

    if (opts.withSpans !== false) result.spans = mergeSpans(spans);
    return result;
  }

  // --------------------------------------------------------------------------- 工具

  /** 移除 IVS／變體選擇器（從 ToneOZ 選音編輯器貼上的文字會帶有這些看不見的字元）。 */
  function stripSelectors(s) { return s.replace(/[\u{E0100}-\u{E01EF}\uFE00-\uFE0F]/gu, ''); }

  function labelName(label) { return label.replace(/[ \t\u3000：:]/g, ''); }

  /** 說話者標籤：同一個名字在行首出現兩次以上，且不是「第一章」「老師說」這類敘述，才當成說話者。 */
  function speakerNames(text) {
    var cnt = dict(), ok = dict();
    text.split('\n').forEach(function (line) {
      var m = SPEAKER_RE.exec(line);
      if (m) { var n = labelName(m[0]); cnt[n] = (cnt[n] || 0) + 1; }
    });
    Object.keys(cnt).forEach(function (n) {
      if (cnt[n] >= 2 && !/^第.+[章節回課部篇]$|[說道問答講]$|^(注意|提示|說明|例如|答案|問題|題目|備註|附註|範例)$/.test(n)) ok[n] = true;
    });
    return ok;
  }

  function setOf(arr) { var s = dict(); arr.forEach(function (w) { s[w] = true; }); return s; }
  function maxLenOf(s) { return Object.keys(s).reduce(function (m, w) { return Math.max(m, chars(w).length); }, 1); }
  function sum(a, b) { return a + b; }
  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }
  function topList(counter, n) {
    return Object.keys(counter).map(function (k) { return [k, counter[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n);
  }
  /** 相鄰的非漢字片段合併，縮小傳給前端的資料量。 */
  function mergeSpans(spans) {
    var out = [];
    spans.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && last.k === 'x' && s.k === 'x') last.t += s.t; else out.push(s);
    });
    return out;
  }

  return {
    parseLevel: parseLevel,
    expandEntry: expandEntry,
    buildLeveled: buildLeveled,
    serializeLeveled: serializeLeveled,
    parseSerialized: parseSerialized,
    parseWordList: parseWordList,
    prepareNorms: prepareNorms,
    preparePhonic: preparePhonic,
    ivsFor: ivsFor,
    splitPinyin: splitPinyin,
    pySyl: pySyl,
    analyze: analyze,
    stripSelectors: stripSelectors,
    Segmenter: Segmenter,
    isHan: isHan
  };
})();

if (typeof module !== 'undefined') module.exports = GRAnalyzer;


// ================================================================ Data.gs
/**
 * Data.gs — 從試算表載入 TBCL 詞語、漢字、語法點、專名與用語對照，並放進快取。
 *
 * 國教院詞語表約 1.4 萬筆，每次從試算表讀取要 1–3 秒；第一次讀取後壓縮存進 CacheService（分塊，6 小時），
 * 之後的請求只需幾十毫秒。更新詞表後請執行選單「重新載入詞表」或 clearLexiconCache()。
 */

var GR_CTX_MEMO_ = null;   // 同一次執行內重複使用

function openSheet_() {
  var id = prop_('SHEET_ID', '');
  if (id) return SpreadsheetApp.openById(id);
  try { return SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { return null; }
}

function emptyLeveled_() { return { map: Object.create(null), entries: 0, forms: 0, maxLen: 1 }; }

/** 載入所有分級資料；回傳 GRAnalyzer.analyze 需要的 ctx。 */
function getContext_() {
  if (GR_CTX_MEMO_) return GR_CTX_MEMO_;
  var S = GR_CONFIG.sheets;
  var ss = openSheet_();
  var ctx = { lex: emptyLeveled_(), chars: null, grammar: [], proper: [], norms: null,
              lexLabel: prop_('TBCL_VERSION_LABEL', '') };
  var extraTerms = [];
  if (ss) {
    ctx.lex = loadLeveledCached_(ss, S.words, 'word');
    var ch = loadLeveledCached_(ss, S.chars, 'char');
    if (ch.forms) ctx.chars = ch;
    ctx.grammar = loadGrammarCached_(ss, S.grammar);
    ctx.proper = readRows_(ss, S.proper, true).map(function (r) { return String(r[0] || '').trim(); }).filter(String);
    extraTerms = readRows_(ss, S.terms, true).filter(function (r) { return r[0] && r[1]; });
  }
  if (!ctx.lexLabel && ctx.lex.forms) ctx.lexLabel = '試算表「' + S.words + '」（' + ctx.lex.entries + ' 筆）';
  ctx.norms = GRAnalyzer.prepareNorms(GR_ASSETS, extraTerms);
  ctx.phonic = typeof GR_PHONIC !== 'undefined' ? GRAnalyzer.preparePhonic(GR_PHONIC, GR_PY_SYLLABLES) : null;
  GR_CTX_MEMO_ = ctx;
  return ctx;
}

/** 讀分頁所有列（顯示值）；skipHeader=true 時略過第一列。分頁不存在回傳 []。 */
function readRows_(ss, name, skipHeader) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 1) return [];
  var rows = sh.getRange(1, 1, sh.getLastRow(), Math.max(1, sh.getLastColumn())).getDisplayValues();
  return skipHeader ? rows.slice(1) : rows;
}

function loadLeveledCached_(ss, sheetName, kind) {
  var key = cacheKey_(kind);
  var hit = cacheGetBig_(key);
  if (hit !== null) return GRAnalyzer.parseSerialized(hit);
  var lx = GRAnalyzer.buildLeveled(readRows_(ss, sheetName, false), kind);
  if (lx.forms) cachePutBig_(key, GRAnalyzer.serializeLeveled(lx));
  return lx;
}

/** 語法點表：自動偵測「語法點／名稱」與「級別」欄。回傳 [{name, l}]。 */
function loadGrammarCached_(ss, sheetName) {
  var key = cacheKey_('grammar');
  var hit = cacheGetBig_(key);
  if (hit !== null) return JSON.parse(hit);
  var rows = readRows_(ss, sheetName, false);
  if (rows.length < 2) return [];
  var header = rows[0].map(function (h) { return String(h).toLowerCase(); });
  var find = function (keys) {
    for (var k = 0; k < keys.length; k++) for (var i = 0; i < header.length; i++) if (header[i].indexOf(keys[k]) >= 0) return i;
    return -1;
  };
  var ni = find(['語法點', '语法点', '語法', '名稱', 'grammar']);
  var li = find(['級別', '级别', '等級', 'level', '級']);
  if (ni < 0 || li < 0) { ni = 0; li = 1; }
  var out = [];
  rows.slice(1).forEach(function (r) {
    var l = GRAnalyzer.parseLevel(r[li]);
    var name = String(r[ni] || '').trim();
    if (l && name) out.push({ name: name, l: l });
  });
  cachePutBig_(key, JSON.stringify(out));
  return out;
}

/**
 * 試算表「介面翻譯」分頁：第一列為 key 與語言代碼，填了內容的格子會覆蓋內建翻譯。
 * 回傳 { 語言代碼: { key: 文字 } }。
 */
function loadI18nOverrides_() {
  var key = cacheKey_('i18n');
  var hit = cacheGetBig_(key);
  if (hit !== null) return JSON.parse(hit);
  var out = {};
  var ss = openSheet_();
  if (ss) {
    var rows = readRows_(ss, GR_CONFIG.sheets.i18n, false);
    if (rows.length > 1) {
      var head = rows[0].map(function (h) { return String(h).trim(); });
      rows.slice(1).forEach(function (r) {
        var k = String(r[0] || '').trim();
        if (!k) return;
        for (var c = 1; c < head.length; c++) {
          var v = String(r[c] || '');
          if (head[c] && v.trim()) (out[head[c]] = out[head[c]] || {})[k] = v;
        }
      });
    }
  }
  cachePutBig_(key, JSON.stringify(out));
  return out;
}

/** 讀出 I18n.html 內建的翻譯表 { langs: [...], strings: {...} }。 */
function builtinI18n_() {
  var raw = HtmlService.createHtmlOutputFromFile('I18n').getContent();
  return JSON.parse(raw.split('/*I18N*/')[1]);
}

// ----------------------------------------------------------------------------- 大型快取

function cacheKey_(kind) { return 'gr2.' + prop_('CACHE_VER', '1') + ':' + kind; }   // gr2：詞表快取格式含 1* 子級

/** 分塊寫入快取：每塊 30,000 個 UTF-16 單位，UTF-8 最多約 90KB，低於單值 100KB 上限。 */
function cachePutBig_(key, str) {
  try {
    var cache = CacheService.getScriptCache(), size = 30000, parts = {}, n = 0;
    for (var i = 0; i < str.length; i += size) parts[key + ':' + (n++)] = str.slice(i, i + size);
    cache.putAll(parts, GR_CONFIG.cacheSeconds);
    cache.put(key + ':n', String(n), GR_CONFIG.cacheSeconds);
  } catch (e) {
    console.warn('快取寫入失敗（不影響結果，只是下次會再讀試算表）：' + e);
  }
}

function cacheGetBig_(key) {
  var cache = CacheService.getScriptCache();
  var n = parseInt(cache.get(key + ':n') || '0', 10);
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + ':' + i);
  var got = cache.getAll(keys), out = [];
  for (var j = 0; j < n; j++) {
    if (got[keys[j]] === undefined) return null;
    out.push(got[keys[j]]);
  }
  return out.join('');
}

/** 更新詞表後執行：讓下一次請求重新讀試算表。 */
function clearLexiconCache() {
  var props = PropertiesService.getScriptProperties();
  var v = parseInt(props.getProperty('CACHE_VER') || '1', 10) + 1;
  props.setProperty('CACHE_VER', String(v));
  GR_CTX_MEMO_ = null;
  var ctx = getContext_();
  var msg = '已重新載入：TBCL 詞語 ' + ctx.lex.entries + ' 筆（' + ctx.lex.forms + ' 個詞形）'
          + (ctx.chars ? '、漢字 ' + ctx.chars.forms + ' 字' : '')
          + (ctx.grammar.length ? '、語法點 ' + ctx.grammar.length + ' 個' : '')
          + '、專名 ' + ctx.proper.length + ' 個。';
  notify_(msg);
  return msg;
}

// ----------------------------------------------------------------------------- 每日配額

/** 一次預留 n 次 LLM 呼叫（每段一次）；不夠就整批擋下，避免做到一半。 */
function consumeQuota_(n) {
  n = Math.max(1, n || 1);
  var limit = propInt_('DAILY_LIMIT');
  var key = 'quota_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var used = parseInt(props.getProperty(key) || '0', 10);
    if (used + n > limit) throw new Error('今日 AI 呼叫次數剩 ' + Math.max(0, limit - used) + ' 次，這次需要 ' + n + ' 次（上限 ' + limit + ' 次），請明天再試，或請管理者調高 DAILY_LIMIT。');
    if (used === 0) {
      props.getKeys().forEach(function (k) { if (k.indexOf('quota_') === 0 && k !== key) props.deleteProperty(k); });
    }
    props.setProperty(key, String(used + n));
    return { used: used + n, limit: limit };
  } finally {
    lock.releaseLock();
  }
}

function quotaStatus_() {
  var key = 'quota_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  return { used: parseInt(PropertiesService.getScriptProperties().getProperty(key) || '0', 10), limit: propInt_('DAILY_LIMIT') };
}

// ----------------------------------------------------------------------------- 執行紀錄

function appendLog_(source, action, req, res, ms) {
  try {
    var ss = openSheet_();
    var sh = ss && ss.getSheetByName(GR_CONFIG.sheets.log);
    if (!sh) return;
    var b = res.before || res, a = res.after || {};
    var user = '';
    try { user = Session.getActiveUser().getEmail(); } catch (e) {}
    sh.appendRow([
      new Date(), source, action, (GR_TOCFL[req.stop] ? GR_TOCFL[req.stop].code + '／' : '') + (req.target || ''), res.direction || '', req.purpose || '',
      b.stats ? b.stats.hanChars : '',
      b.estimate ? (b.estimate.level || (b.estimate.beyond ? '>7' : '')) : '',
      a.estimate ? (a.estimate.level || (a.estimate.beyond ? '>7' : '')) : '',
      b.target ? b.target.effectivePct : '', a.target ? a.target.effectivePct : '',
      (res.rounds || 0) + (res.segments > 1 ? '×' + res.segments + '段' : ''), res.llm ? res.llm.provider : '', res.llm ? res.llm.model : '',
      res.llm ? res.llm.inputTokens : '', res.llm ? res.llm.outputTokens : '', ms, user
    ]);
  } catch (e) {
    console.warn('寫入執行紀錄失敗：' + e);
  }
}

function notify_(msg) {
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* 非試算表介面（網頁或觸發器）執行時沒有 UI */ }
}


// ================================================================ Llm.gs
/**
 * Llm.gs — 可替換的 LLM 介面（支援平行批次）
 *
 * Apps Script 的 UrlFetchApp 單一請求約 60 秒就會中斷（不可調整），所以長文改成「分段＋平行」：
 * Adjust.gs 把一章切成約 600 字的段落，這裡用 UrlFetchApp.fetchAll 同時送出，每段都在 60 秒內完成。
 *
 * 每個供應商只要提供兩個函式：
 *   build(system, user, tool, model) → { url, headers, body }
 *   parse(json)                      → { data, inputTokens, outputTokens }（格式不符時 throw）
 * 對外：
 *   callLlmBatch_(system, users[], tool) → [{ ok, data, provider, model, inputTokens, outputTokens } | { ok:false, error }]
 *   callLlmJson_(system, user, tool)     → 單一請求，失敗時 throw
 *
 * 狀態：anthropic 依 Claude API 2026-10-21 版文件撰寫；openai、gemini、custom 為預留，未實測。
 */

var GR_PROVIDERS_ = {
  anthropic: {
    build: function (system, user, tool, model) {
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': prop_('ANTHROPIC_API_KEY'), 'anthropic-version': GR_CONFIG.defaults.ANTHROPIC_VERSION },
        body: {
          model: model, max_tokens: propInt_('LLM_MAX_TOKENS'), system: system,
          messages: [{ role: 'user', content: user }],
          tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
          tool_choice: { type: 'tool', name: tool.name }
        }
      };
    },
    parse: function (res) {
      if (res.stop_reason === 'max_tokens') throw new Error('模型輸出被截斷（達到 LLM_MAX_TOKENS）。請調小 SEGMENT_CHARS 或調高 LLM_MAX_TOKENS。');
      var block = (res.content || []).filter(function (b) { return b.type === 'tool_use'; })[0];
      if (!block || !block.input) throw new Error('模型沒有回傳結構化結果（stop_reason=' + res.stop_reason + '）。');
      var u = res.usage || {};
      return { data: block.input, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 };
    }
  },

  // 預留：OpenAI 相容（Chat Completions＋JSON 模式）
  openai: {
    build: function (system, user, tool, model) {
      return {
        url: String(prop_('OPENAI_BASE_URL')).replace(/\/+$/, '') + '/chat/completions',
        headers: { Authorization: 'Bearer ' + prop_('OPENAI_API_KEY') },
        body: { model: model, max_tokens: propInt_('LLM_MAX_TOKENS'), response_format: { type: 'json_object' },
                messages: [{ role: 'system', content: system + jsonInstruction_(tool) }, { role: 'user', content: user }] }
      };
    },
    parse: function (res) {
      var msg = res.choices && res.choices[0] && res.choices[0].message;
      if (!msg || !msg.content) throw new Error('OpenAI 回應格式不符。');
      var u = res.usage || {};
      return { data: parseJsonLoose_(msg.content), inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 };
    }
  },

  // 預留：Gemini（generateContent＋JSON 回應）
  gemini: {
    build: function (system, user, tool, model) {
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
        headers: { 'x-goog-api-key': prop_('GEMINI_API_KEY') },
        body: { systemInstruction: { parts: [{ text: system + jsonInstruction_(tool) }] },
                contents: [{ role: 'user', parts: [{ text: user }] }],
                generationConfig: { responseMimeType: 'application/json', maxOutputTokens: propInt_('LLM_MAX_TOKENS') } }
      };
    },
    parse: function (res) {
      var c = res.candidates && res.candidates[0];
      var text = c && c.content && c.content.parts && c.content.parts.map(function (p) { return p.text || ''; }).join('');
      if (!text) throw new Error('Gemini 回應格式不符（finishReason=' + (c && c.finishReason) + '）。');
      var u = res.usageMetadata || {};
      return { data: parseJsonLoose_(text), inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0 };
    }
  },

  /**
   * 預留：自訂端點（學校自建服務、Cloud Run 代理、校內模型）
   *   POST CUSTOM_LLM_URL，Authorization: Bearer CUSTOM_LLM_TOKEN（有設定才送）
   *   { "system": "...", "user": "...", "tool": { "name": "...", "schema": {...} } }
   * 回應：{ "data": {...符合 schema...}, "usage": { "input_tokens": 0, "output_tokens": 0 } }
   */
  custom: {
    build: function (system, user, tool) {
      var token = prop_('CUSTOM_LLM_TOKEN', '');
      return { url: prop_('CUSTOM_LLM_URL'), headers: token ? { Authorization: 'Bearer ' + token } : {},
               body: { system: system, user: user, tool: { name: tool.name, schema: tool.schema } } };
    },
    parse: function (res) {
      var u = res.usage || {};
      return { data: res.data || res, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 };
    }
  }
};

function llmStatus_() {
  var p = String(prop_('LLM_PROVIDER')).toLowerCase();
  var need = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', custom: 'CUSTOM_LLM_URL' }[p];
  var model = { anthropic: prop_('ANTHROPIC_MODEL'), openai: prop_('OPENAI_MODEL', ''), gemini: prop_('GEMINI_MODEL', ''), custom: 'custom' }[p] || '';
  var configured = !!(need && prop_(need, '')) && !!model;
  return { provider: p, model: model, configured: configured,
           hint: configured ? '' : (p === 'none' ? '已關閉 LLM，只提供分析。'
                 : '請在指令碼屬性設定 ' + (need || 'LLM_PROVIDER') + (model ? '' : ' 與模型名稱') + '。') };
}

/** 同時送出多個請求；每個結果各自成功或失敗，不會因一段失敗而全部失敗。 */
function callLlmBatch_(system, users, tool) {
  var st = llmStatus_();
  if (!st.configured) throw new Error('尚未設定 LLM：' + st.hint);
  var prov = GR_PROVIDERS_[st.provider];
  if (!prov) throw new Error('不支援的 LLM_PROVIDER：' + st.provider);
  var reqs = users.map(function (u) { return prov.build(system, u, tool, st.model); });
  return httpJsonBatch_(reqs).map(function (r) {
    if (!r.ok) return { ok: false, error: r.error };
    try {
      var out = prov.parse(r.json);
      out.ok = true; out.provider = st.provider; out.model = st.model;
      return out;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function callLlmJson_(system, user, tool) {
  var r = callLlmBatch_(system, [user], tool)[0];
  if (!r.ok) throw new Error(r.error);
  return r;
}

// ----------------------------------------------------------------------------- 共用

function jsonInstruction_(tool) {
  return '\n\n請只輸出一個 JSON 物件，不要加任何說明或 Markdown 標記。JSON 必須符合以下 JSON Schema：\n'
       + JSON.stringify(tool.schema);
}

/** 容忍 ```json 包裝或前後雜訊的 JSON 解析。 */
function parseJsonLoose_(text) {
  var s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch (e) {}
  var a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('模型回傳的不是有效的 JSON。');
}

/**
 * 平行 POST JSON：[{url, headers, body}] → [{ ok, json } | { ok:false, error }]。
 * 429／5xx／529 與連線失敗會整批重試最多 2 次（只重送失敗的請求）。錯誤訊息不含金鑰。
 */
function httpJsonBatch_(reqs) {
  var retryable = { 408: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1, 529: 1 };
  var results = reqs.map(function () { return null; });
  var pending = reqs.map(function (_, i) { return i; });
  for (var attempt = 0; attempt < 3 && pending.length; attempt++) {
    if (attempt) Utilities.sleep(2000 * Math.pow(2, attempt - 1));
    var resps;
    try {
      resps = UrlFetchApp.fetchAll(pending.map(function (i) {
        var q = reqs[i];
        return { url: q.url, method: 'post', contentType: 'application/json', headers: q.headers,
                 payload: JSON.stringify(q.body), muteHttpExceptions: true, followRedirects: true };
      }));
    } catch (e) {
      // 整批連線失敗（含約 60 秒逾時）：記下錯誤，下一輪重試
      var msg = /timeout|timed out|逾時/i.test(e.message) ? '連線逾時（單次請求約 60 秒上限），請調小 SEGMENT_CHARS 或改用較快的模型' : '連線失敗：' + e.message;
      pending.forEach(function (i) { results[i] = { ok: false, error: 'LLM 服務錯誤（' + msg + '）', retry: true }; });
      continue;
    }
    var next = [];
    pending.forEach(function (i, k) {
      var resp = resps[k], code = resp.getResponseCode(), text = resp.getContentText();
      if (code >= 200 && code < 300) {
        try { results[i] = { ok: true, json: JSON.parse(text) }; } catch (e) { results[i] = { ok: false, error: 'LLM 回應不是 JSON。' }; }
        return;
      }
      var detail = text;
      try { var j = JSON.parse(text); detail = (j.error && (j.error.message || j.error.type)) || j.message || text; } catch (e) {}
      results[i] = { ok: false, error: 'LLM 服務錯誤（HTTP ' + code + '：' + String(detail).slice(0, 300) + '）' };
      if (retryable[code]) next.push(i);
    });
    pending = next;
  }
  return results.map(function (r) { return r ? { ok: r.ok, json: r.json, error: r.error } : { ok: false, error: 'LLM 沒有回應。' }; });
}


// ================================================================ Prompts.gs
/**
 * Prompts.gs — 提示詞與結構化輸出格式
 *
 * 設計重點：等級判斷由程式（TBCL 詞表）負責，LLM 只負責「改寫」；改完再交回程式驗證。
 * 所以提示詞裡的等級資訊全部來自自動檢核，並要求模型不要自行宣稱 TBCL 等級。
 */

var GR_SYSTEM_PROMPT = [
  '你是臺灣華語分級讀本的編修專家，熟悉國家教育研究院「臺灣華語文能力基準」（TBCL，三等七級）與華語文能力測驗（TOCFL）。',
  '你的工作是把讀本文本調整到指定的 TBCL 等級，讓該級學習者能順暢閱讀，同時保持故事好看、語言自然。',
  '',
  '工作原則',
  '1. 最小必要修改：保留情節、人物、事件順序、觀點與作者語氣。調整的是語言難度與規範，不是另寫一個故事。',
  '2. 超綱詞依序處理：(a) 換成目標級以內、意思相同的詞；(b) 改寫句子避開；(c) 對主題不可或缺的詞保留，列入 kept_above_level 並說明理由（讀本會把它列為生詞，請讓它在文中出現兩三次以上）；(d) 「不得更動的詞」一律不改。',
  '3. 語法：使用目標級以內的句式。必要的高級結構當作固定說法，並寫進 grammar_notes。',
  '4. 句長與篇章：符合目標級的文本類型與建議句長；長句拆短，但避免連續使用「然後」。降級時可把抽象描寫改成具體動作、感官細節或對話。',
  '5. 升級時：不改變情節，加入目標級的詞語、連接詞與複句，增加細節；不要使用高於目標級的詞。',
  '6. 自然度：改完的句子要像臺灣人會說、會寫的話。不要為了避開某個詞寫出生硬的句子；對話保留「喔」「好啊」「真的嗎？」這類自然回應。',
  '7. 臺灣規範：正體字（教育部標準字形）、臺灣用語（計程車、捷運、軟體、品質、便當……）、不用兒化，全形標點，引號用「」，內層用『』。',
  '8. 不加入會過期的具體資訊（票價、時刻、法規），不加入原文沒有的文化斷言。',
  '9. 保留原文的段落數、段落順序與換行；對話體保留說話者標籤。',
  '10. 等級資訊只能引用本訊息提供的自動檢核結果；其他等級判斷一律寫「推估」。不要自創 TBCL 能力指標代碼。',
  '11. 不論使用者介面是哪一種語言，revised_text、changes、grammar_notes、summary 一律以臺灣正體中文撰寫；只有 kept_above_level 的 english 欄位寫英譯。',
  '',
  '修訂紀錄 changes：每一處修改寫一條，同一個詞在多處的相同替換合併成一條。original 必須是「待修改文本」中逐字存在的短片段（不要整句照抄）；revised 是修改後片段；',
  'category 從「詞彙、語法、句長、用語、字形、自然度、內容、其他」擇一；reason 不超過 25 字，例如「擁擠第 5 級，改用第 1 級的人很多」。',
  '完成後呼叫 submit_revision 工具提交，不要另外輸出文字。'
].join('\n');

var GR_REVISION_TOOL = {
  name: 'submit_revision',
  description: '提交調整後的完整讀本文本、修訂紀錄、刻意保留的超綱詞與語法說明。',
  schema: {
    type: 'object',
    properties: {
      revised_text: { type: 'string', description: '調整後的完整文本，保留原文段落與換行。' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            original: { type: 'string' },
            revised: { type: 'string' },
            category: { type: 'string', enum: ['詞彙', '語法', '句長', '用語', '字形', '自然度', '內容', '其他'] },
            reason: { type: 'string' }
          },
          required: ['original', 'revised', 'category', 'reason']
        }
      },
      kept_above_level: {
        type: 'array',
        description: '刻意保留、將列為生詞的超綱詞。',
        items: {
          type: 'object',
          properties: {
            word: { type: 'string' },
            reason: { type: 'string' },
            pos: { type: 'string', description: '詞類（鄧守信教學語法體系，如 N、V、Vs、Adv）；不確定可留空。' },
            english: { type: 'string', description: '簡短英譯' }
          },
          required: ['word', 'reason']
        }
      },
      grammar_notes: {
        type: 'array',
        description: '文本中可能超出目標級、或值得教師注意的語法點。',
        items: {
          type: 'object',
          properties: {
            point: { type: 'string' },
            example: { type: 'string', description: '修訂稿中的例句' },
            note: { type: 'string' }
          },
          required: ['point', 'example']
        }
      },
      summary: { type: 'string', description: '兩三句話說明這次調整的重點。' }
    },
    required: ['revised_text', 'changes', 'summary']
  }
};

var GR_DIRECTION_LABEL = { down: '降級', up: '升級', polish: '維持等級，只修正規範與自然度' };

/**
 * 組出使用者訊息。
 *  draft：待修改文本（第 1 輪是原文，第 2 輪起是上一版）
 *  an：draft 的自動檢核結果
 *  plan：{ target, direction, purpose, learner, protected, known, glossary, notes, round, prevIssues }
 */
function buildUserPrompt_(draft, an, plan, ctx) {
  var L = grLevelInfo(plan.target), T = GR_TOCFL[plan.stop !== undefined ? plan.stop : grStopOfTbcl(plan.target)];
  var P = GR_PURPOSES[plan.purpose] || GR_PURPOSES.extensive;
  var lines = [];
  var est = an.estimate;
  var estText = est.level ? '第 ' + est.level + ' 級' : (est.beyond ? '高於第 7 級（或未收錄詞過多）' : '無法估計');

  lines.push('【目標】' + grTargetLabel(T.stop));
  if (T.strictStar) lines.push('- 準備一級：只用 TBCL 第 1 級裡標示「第1級」的詞；標示「第1*級」的詞（第 1 級後段）也算超綱。句子以 6 字左右的短句為主。');
  lines.push('- 本級學習者能力：' + L.performance);
  lines.push('- 文本類型：' + L.textType);
  var guide = plan.sentLenGuide || L.sentLenGuide;
  if (guide) lines.push('- 建議平均句長：' + guide + ' 字以內（編者經驗值）');
  lines.push('- 用途：' + P.label + '，可理解覆蓋率目標 ≥' + Math.round(P.threshold * 100) + '%');
  lines.push('- 學習者：' + (GR_LEARNERS[plan.learner] || GR_LEARNERS.adult_nonchar));
  lines.push('- 調整方向：' + GR_DIRECTION_LABEL[plan.direction] + '（目前估計適讀等級：' + estText + '）');
  lines.push('');

  if (an.meta.lexiconLoaded) {
    lines.push('【自動檢核結果】（依 ' + (ctx.lexLabel || 'TBCL 詞語表') + '）');
    lines.push('- 目標級以內詞次覆蓋率 ' + an.target.withinPct + '%；含生詞、已學詞、專名後可理解覆蓋率 ' + an.target.effectivePct + '%');
    var must = an.target.above.filter(function (a) { return !a.glossed; });
    if (must.length) {
      lines.push('- 必須處理的超綱詞（詞／TBCL 級／次數）：' + must.map(function (a) { return a.w + '／' + (a.lvl || a.lv) + '／' + a.n; }).join('、'));
    } else {
      lines.push('- 沒有未處理的超綱詞。');
    }
    var kept = an.target.above.filter(function (a) { return a.glossed; });
    if (kept.length) lines.push('- 超綱但已列為生詞或保留詞（可以保留）：' + kept.map(function (a) { return a.w + '（' + (a.lvl || a.lv) + '）'; }).join('、'));
    if (an.oov.length) lines.push('- 詞表未收錄的片段（可能是超綱詞、專名或錯字，請自行判斷）：' + an.oov.slice(0, 30).map(function (o) { return o.w; }).join('、'));
    if (plan.direction === 'up') {
      lines.push('- 第 ' + plan.target + ' 級詞語目前佔 ' + an.target.targetLevelShare + '% 詞次；請多用第 ' + plan.target + ' 級的詞語與句式。');
    }
  } else {
    lines.push('【自動檢核結果】尚未載入 TBCL 詞表，無法提供逐詞等級。請依你對 TBCL 第 ' + plan.target + ' 級的理解調整，所有等級說明都寫「推估」。');
  }
  if (an.sentences.overLong && an.sentences.overLong.length) {
    lines.push('- 過長的句子（請拆短）：' + an.sentences.overLong.slice(0, 8).map(function (s) { return '「' + s.text + '」（' + s.len + ' 字）'; }).join('；'));
  }
  lines.push('- 目前平均句長 ' + an.sentences.mean + ' 字，最長 ' + an.sentences.max + ' 字。');
  if (an.norms) {
    if (an.norms.simplified.length) lines.push('- 疑似簡體字（改為正體，注意一簡多繁）：' + an.norms.simplified.map(function (s) { return s.c; }).join('、'));
    if (an.norms.variants.length) lines.push('- 非標準字形：' + an.norms.variants.map(function (v) { return v.c + '→' + v.to; }).join('、'));
    if (an.norms.terms.length) lines.push('- 大陸用語候選（依語境確認後改成臺灣說法）：' + an.norms.terms.map(function (t) { return t.form + '→' + t.tw; }).join('、'));
  }
  lines.push('');

  var protectedWords = GRAnalyzer.parseWordList(plan.protectedWords).concat(ctx.proper || []);
  if (protectedWords.length) lines.push('【不得更動的詞】' + uniq_(protectedWords).slice(0, 200).join('、'));
  var known = GRAnalyzer.parseWordList(plan.known);
  if (known.length) lines.push('【學習者已學、可以使用的詞】' + known.slice(0, 400).join('、'));
  var gloss = GRAnalyzer.parseWordList(plan.glossary);
  if (gloss.length) lines.push('【本書生詞（可以保留）】' + gloss.slice(0, 200).join('、'));
  if (ctx.grammar && ctx.grammar.length) {
    var g = ctx.grammar.filter(function (x) { return x.l <= plan.target; });
    var near = g.filter(function (x) { return x.l >= plan.target - 1; });
    if (near.length) lines.push('【第 ' + Math.max(1, plan.target - 1) + '–' + plan.target + ' 級可用語法點（TBCL 語法點表）】' + near.slice(0, 250).map(function (x) { return x.name; }).join('、'));
  }
  if (plan.notes) lines.push('【教師補充指示】' + String(plan.notes).slice(0, 1000));

  if (plan.segCount > 1) {
    lines.push('');
    lines.push('【分段】全文分成 ' + plan.segCount + ' 段同時處理，這是第 ' + (plan.segIndex + 1) + ' 段。只改這一段，不要補寫前後文；人物與用詞請與全文一致。');
  }

  if (plan.round > 1 && plan.prevIssues) {
    lines.push('');
    lines.push('【第 ' + plan.round + ' 輪】上一版的自動驗證仍未通過：' + plan.prevIssues);
    lines.push('請在上一版（下方「待修改文本」）的基礎上繼續修改，只改有問題的地方；changes 只記錄這一輪的修改。');
  }

  lines.push('');
  lines.push('待修改文本：');
  lines.push('<<<');
  lines.push(draft);
  lines.push('>>>');
  return lines.join('\n');
}

function uniq_(arr) {
  var seen = {}, out = [];
  arr.forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } });
  return out;
}


// ================================================================ Report.gs
/**
 * Report.gs — 產生 Markdown 編修報告（純 JavaScript，前端預覽與 API 共用）
 * 骨架依 taiwan-huayu-materials 技能：定位摘要 → 檢核結果 → 修訂紀錄 → 修訂後文本 → 生詞 → 對標陳述 → 請您確認。
 */
var GRReport = (function () {
  'use strict';

  function cell(s) { return String(s === null || s === undefined ? '' : s).replace(/\|/g, '｜').replace(/\n/g, ' '); }
  function est(an) {
    if (!an || !an.meta.lexiconLoaded) return '推估（未載入詞表）';
    return an.estimate.level ? '第 ' + an.estimate.level + ' 級' : (an.estimate.beyond ? '高於第 7 級' : '—');
  }
  function pct(v) { return v === undefined || v === null ? '—' : v + '%'; }

  function metricsRows(b, a, hasAfter) {
    var rows = [
      ['適讀等級估計', est(b), hasAfter ? est(a) : ''],
      ['目標級以內詞次覆蓋率', pct(b.target && b.target.withinPct), hasAfter ? pct(a.target && a.target.withinPct) : ''],
      ['可理解覆蓋率（含生詞、已學詞、專名）', pct(b.target && b.target.effectivePct), hasAfter ? pct(a.target && a.target.effectivePct) : ''],
      ['超綱且未列生詞（種／詞次）', b.target ? b.target.aboveUnglossedTypes + '／' + b.target.aboveUnglossedTokens : '—',
        hasAfter && a.target ? a.target.aboveUnglossedTypes + '／' + a.target.aboveUnglossedTokens : ''],
      ['平均句長／最長（字）', b.sentences.mean + '／' + b.sentences.max, hasAfter ? a.sentences.mean + '／' + a.sentences.max : ''],
      ['漢字數／詞次', b.stats.hanChars + '／' + b.stats.tokens, hasAfter ? a.stats.hanChars + '／' + a.stats.tokens : ''],
      ['疑似簡體字／大陸用語候選', b.norms ? b.norms.simplified.length + '／' + b.norms.terms.length : '—',
        hasAfter && a.norms ? a.norms.simplified.length + '／' + a.norms.terms.length : '']
    ];
    return rows;
  }

  function markdown(res) {
    var b = res.before, a = res.after || res.before;
    var hasAfter = res.action === 'adjust' && res.rounds > 0;
    var L = grLevelInfo(res.target);
    var P = GR_PURPOSES[res.purpose] || GR_PURPOSES.extensive;
    var out = [], p = function (s) { out.push(s === undefined ? '' : s); };
    var NUM = '一二三四五六七八九十', sec = 0;
    var h = function (title) { p('## ' + NUM.charAt(sec++) + '、' + title); p(); };

    p('# 分級讀本編修報告');
    p();
    h('定位摘要');
    p('- 目標等級：' + (res.levelLabel || grLevelLabel(res.target)));
    var guide = (GR_TOCFL[res.tocfl] && GR_TOCFL[res.tocfl].sentLenGuide) || L.sentLenGuide;
    p('- 文本類型（第 ' + L.level + ' 級）：' + L.textType + (guide ? '；建議平均句長 ' + guide + ' 字以內（經驗值）' : ''));
    p('- 用途：' + P.label + '，可理解覆蓋率門檻 ' + Math.round(P.threshold * 100) + '%（第二語言閱讀研究經驗值，非官方標準）');
    p('- 學習者：' + (GR_LEARNERS[res.learner] || GR_LEARNERS.adult_nonchar));
    p('- 詞表：' + (b.meta.lexiconLoaded ? (res.lexiconLabel || 'TBCL 詞語表') : '未載入（所有等級為推估）'));
    if (res.action === 'adjust') {
      p('- 調整方向：' + res.directionLabel + '；改寫 ' + res.rounds + ' 輪' + (res.segments > 1 ? '（分 ' + res.segments + ' 段平行處理）' : '') + '；驗證結果：'
        + (!res.verified ? '未驗證（無詞表）' : res.passed ? '通過' : '未完全通過'));
      if (res.llm && res.llm.model) p('- 改寫模型：' + res.llm.provider + ' / ' + res.llm.model);
    }
    p();

    h('檢核結果');
    p(hasAfter ? '| 指標 | 修訂前 | 修訂後 |\n|---|---|---|' : '| 指標 | 數值 |\n|---|---|');
    metricsRows(b, a, hasAfter).forEach(function (r) { p('| ' + r[0] + ' | ' + r[1] + (hasAfter ? ' | ' + r[2] : '') + ' |'); });
    p();
    if (b.target && b.target.above.length) {
      p('修訂前超綱詞：' + b.target.above.map(function (x) { return x.w + '（' + (x.lvl || x.lv) + '）×' + x.n; }).join('、'));
      p();
    }
    if (b.warnings && b.warnings.length) { b.warnings.forEach(function (w) { p('> ' + w); }); p(); }

    if (res.action === 'adjust' && res.changes && res.changes.length) {
      h('修訂紀錄');
      p('| # | 輪 | 原文 | 修訂 | 類別 | 理由 |\n|---|---|---|---|---|---|');
      res.changes.forEach(function (c, i) {
        p('| ' + (i + 1) + ' | ' + c.round + ' | ' + cell(c.original) + (c.located ? '' : '（未定位）') + ' | ' + cell(c.revised) + ' | ' + cell(c.category) + ' | ' + cell(c.reason) + ' |');
      });
      p();
    }

    if (res.action === 'adjust') {
      h('修訂後文本');
      p(res.revisedText);
      p();
    }

    if (res.glossary && res.glossary.length) {
      h('建議生詞表');
      p('拼音、注音取自 TBCL 詞表「參考漢語拼音」「參考注音」欄；空白者請查教育部《國語辭典簡編本》。');
      p();
      p('| 詞 | TBCL 級 | 次數 | 漢語拼音 | 注音 | 詞類 | 英譯 | 來源／理由 |\n|---|---|---|---|---|---|---|---|');
      res.glossary.forEach(function (g) {
        p('| ' + cell(g.w) + ' | ' + (g.lvl || g.lv || '未收錄') + ' | ' + g.n + ' | ' + cell(g.py) + ' | ' + cell(g.zy) + ' | ' + cell(g.pos) + ' | ' + cell(g.en) + ' | ' + cell(g.source + (g.reason ? '：' + g.reason : '')) + ' |');
      });
      p();
    }

    if (res.grammarNotes && res.grammarNotes.length) {
      h('語法注意（模型標註，等級為推估，請以 TBCL 語法點檢索系統確認）');
      res.grammarNotes.forEach(function (g) { p('- ' + g.point + '：' + (g.example || '') + (g.note ? '（' + g.note + '）' : '')); });
      p();
    }

    h('對標陳述');
    p('> ' + res.statement);
    p();

    var confirm = [];
    var an = a;
    if (an.oov && an.oov.length) confirm.push('詞表未收錄的片段（專名、斷詞錯誤、超綱詞或錯字）：' + an.oov.slice(0, 30).map(function (o) { return o.w; }).join('、') + '。人名地名請加入「專名」分頁。');
    if (an.norms && an.norms.terms.length) confirm.push('大陸用語候選，請依語境確認：' + an.norms.terms.map(function (t) { return t.form + '→' + t.tw; }).join('、'));
    if (an.target && an.target.singleUse && an.target.singleUse.length) confirm.push('只出現一次的超綱詞（復現不足，可替換或在後文再用）：' + an.target.singleUse.join('、'));
    (res.warnings || []).forEach(function (w) { confirm.push(w); });
    confirm.push('語法點、語意與自然度未經程式驗證，請教師通讀確認。');
    h('請您確認');
    confirm.forEach(function (c) { p('- ' + c); });
    p();
    return out.join('\n');
  }

  return { markdown: markdown };
})();


// ================================================================ Adjust.gs
/**
 * Adjust.gs — 機器人主流程：分析 → 改寫 → 再驗證（最多 MAX_ROUNDS 輪）
 *
 * runAnalyzeCore_ / runAdjustCore_ 不直接呼叫 Apps Script 服務（LLM 與配額由 deps 注入），
 * 所以可以在 Node 用假 LLM 測試，也方便日後搬到 Cloud Run 等其他平台。
 */

function normalizeRequest_(req) {
  req = req || {};
  // 目標等級：優先用 TOCFL 八級（tocfl：0–7 或 N1、A2…）；只給 TBCL target 時，第 1 級視為準備二級
  var stop = grParseTocfl(req.tocfl);
  if (stop < 0) {
    var t = parseInt(req.target, 10);
    stop = grStopOfTbcl(t >= 1 && t <= 7 ? t : 3);
  }
  var T = GR_TOCFL[stop];
  return {
    text: GRAnalyzer.stripSelectors(String(req.text || '')).replace(/\r\n?/g, '\n'),
    stop: stop,
    target: T.tbcl,
    strictStar: !!T.strictStar,
    sentLenGuide: T.sentLenGuide || grLevelInfo(T.tbcl).sentLenGuide,
    mode: ['auto', 'down', 'up', 'localize'].indexOf(req.mode) >= 0 ? req.mode : 'auto',
    purpose: GR_PURPOSES[req.purpose] ? req.purpose : 'extensive',
    learner: GR_LEARNERS[req.learner] ? req.learner : 'adult_nonchar',
    protectedWords: String(req.protectedWords || ''),
    known: String(req.known || ''),
    glossary: String(req.glossary || ''),
    notes: String(req.notes || ''),
    stripSpeakers: req.stripSpeakers !== false,
    includeSpans: req.includeSpans !== false,
    includeReport: req.includeReport !== false
  };
}

function analysisOpts_(plan, ctx, extraGlossary) {
  return {
    target: plan.target,
    strictStar: plan.strictStar,
    purpose: plan.purpose,
    threshold: GR_PURPOSES[plan.purpose].threshold,
    glossary: plan.glossary + (extraGlossary && extraGlossary.length ? '\n' + extraGlossary.join('\n') : ''),
    known: plan.known,
    proper: GRAnalyzer.parseWordList(plan.protectedWords).concat(ctx.proper || []),
    stripSpeakers: plan.stripSpeakers,
    sentLenGuide: plan.sentLenGuide
  };
}

/** auto：依估計等級決定降級或升級；localize：同 auto，但一定會修正字形與用語。 */
function decideDirection_(mode, an, target) {
  if (mode === 'down' || mode === 'up') return mode;
  var est = an.estimate;
  if (!an.meta.lexiconLoaded) return 'down';
  if (an.target && an.target.strictStar && an.target.aboveUnglossedTypes) return 'down';
  if (est.level === null) return est.beyond ? 'down' : 'polish';
  if (est.level > target) return 'down';
  if (est.level < target) return 'up';
  return 'polish';
}

function hasNormIssues_(an) {
  return !!(an.norms && (an.norms.simplified.length || an.norms.variants.length || an.norms.terms.length));
}

function maxNewWords_(an) {
  var per100 = parseFloat(typeof prop_ === 'function' ? prop_('MAX_NEW_PER_100', '1') : '1') || 1;
  return Math.max(3, Math.round(an.stats.tokens * per100 / 100));
}

function checkPass_(after, strict, plan, direction, keptCount) {
  var issues = [];
  if (after.meta.lexiconLoaded) {
    var t = after.target;
    if (!t.pass) issues.push('可理解覆蓋率 ' + t.effectivePct + '%，未達 ' + t.threshold + '%');
    var remaining = t.above.filter(function (a) { return !a.glossed; });
    if (remaining.length) issues.push('仍有超綱詞：' + remaining.slice(0, 20).map(function (a) { return a.w + '（' + (a.lvl || a.lv) + '）'; }).join('、'));
    var cap = maxNewWords_(after);
    if (keptCount > cap) issues.push('刻意保留的生詞有 ' + keptCount + ' 個，超過建議上限 ' + cap + ' 個，請再替換一些');
    if (direction === 'up' && strict.estimate.level !== null && strict.estimate.level < plan.target) {
      issues.push('適讀等級估計為第 ' + strict.estimate.level + ' 級，仍低於目標；請多用第 ' + plan.target + ' 級的詞語與句式');
    }
  }
  if (after.norms && after.norms.simplified.length) {
    issues.push('仍有簡體字：' + after.norms.simplified.map(function (s) { return s.c; }).join('、'));
  }
  if (plan.sentLenGuide && after.sentences.mean > plan.sentLenGuide * 1.2) {
    issues.push('平均句長 ' + after.sentences.mean + ' 字，高於建議的 ' + plan.sentLenGuide + ' 字');
  }
  return { pass: issues.length === 0, issues: issues.join('；') };
}

function alignmentStatement_(an, plan, ctx) {
  var T = GR_TOCFL[plan.stop], L = grLevelInfo(plan.target);
  var s = '本文目標為 TOCFL ' + T.name + '（' + T.code + '，CEFR ' + T.cefr + '），對應 TBCL 第 ' + L.level + ' 級（' + L.band + '）';
  s += T.strictStar ? '前段：只用詞表標示「第1級」的詞，「第1*級」詞視為超綱（本工具的區分方式，非官方對應）。' : '。';
  if (an.meta.lexiconLoaded && an.target) {
    var est = an.estimate.level ? '第 ' + an.estimate.level + ' 級' : (an.estimate.beyond ? '高於第 7 級' : '無法估計');
    s += '含生詞後可理解覆蓋率 ' + an.target.effectivePct + '%，適讀等級估計為' + est
       + '（依 ' + (ctx.lexLabel || 'TBCL 詞語表') + '；門檻 ' + an.target.threshold + '%）。';
  } else {
    s += '（推估：尚未載入 TBCL 詞語表，等級未經詞表驗證。）';
  }
  return s + 'TBCL 與 TOCFL 為整體對應，逐技能可能錯開一級；語法與自然度需人工確認。';
}

function baseResult_(action, plan, ctx) {
  return { ok: true, action: action, tocfl: plan.stop, target: plan.target, levelLabel: grTargetLabel(plan.stop),
           purpose: plan.purpose, learner: plan.learner, lexiconLabel: ctx.lexLabel || '', warnings: [] };
}

function runAnalyzeCore_(req, ctx) {
  var plan = normalizeRequest_(req);
  if (!plan.text.trim()) throw new Error('請貼上要分析的文本。');
  if (plan.text.length > GR_CONFIG.defaults.ANALYZE_MAX_CHARS) throw new Error('文本太長（上限 ' + GR_CONFIG.defaults.ANALYZE_MAX_CHARS + ' 字），請分章分析。');
  var an = GRAnalyzer.analyze(plan.text, ctx, analysisOpts_(plan, ctx));
  if (!plan.includeSpans) delete an.spans;
  var direction = decideDirection_(plan.mode, an, plan.target);
  var res = baseResult_('analyze', plan, ctx);
  res.before = an; res.after = an; res.direction = direction; res.directionLabel = GR_DIRECTION_LABEL[direction];
  res.statement = alignmentStatement_(an, plan, ctx);
  if (plan.includeReport) res.report = GRReport.markdown(res);
  return res;
}

// ----------------------------------------------------------------------------- 分段

function hanCount_(s) { return Array.from(s || '').filter(GRAnalyzer.isHan).length; }

/**
 * 依段落切成每段約 maxHan 個漢字的區塊；單一段落過長時依句號切開。
 * 回傳 [{ t, glue }]，glue 是該區塊後面接的分隔（'\n' 或 ''），全部接回去等於原文。
 */
function splitSegments_(text, maxHan) {
  var out = [], cur = [], curN = 0;
  var flush = function () { if (cur.length) { out.push({ t: cur.join('\n'), glue: '\n' }); cur = []; curN = 0; } };
  text.split('\n').forEach(function (line) {
    var n = hanCount_(line);
    if (n > maxHan) {
      flush();
      var parts = line.match(/[^。！？!?…]+[。！？!?…]*[」』）)"]*/g) || [line];
      if (parts.join('') !== line) parts = [line];
      var buf = '', bn = 0;
      parts.forEach(function (p) {
        var pn = hanCount_(p);
        if (buf && bn + pn > maxHan) { out.push({ t: buf, glue: '' }); buf = ''; bn = 0; }
        buf += p; bn += pn;
      });
      out.push({ t: buf, glue: '\n' });
      return;
    }
    if (cur.length && curN + n > maxHan) flush();
    cur.push(line); curN += n;
  });
  flush();
  if (out.length) out[out.length - 1].glue = '';
  return out.map(function (s) {
    var lead = /^[\s　]*/.exec(s.t)[0], trail = /[\s　]*$/.exec(s.t.slice(lead.length))[0];
    return { lead: lead, core: s.t.slice(lead.length, s.t.length - trail.length), trail: trail, glue: s.glue,
             active: hanCount_(s.t) > 0 };
  });
}

function joinSegments_(segs) {
  return segs.map(function (s) { return s.lead + s.core + s.trail + s.glue; }).join('');
}

/**
 * deps = { callLlmBatch(system, users[], tool) → [{ok, data, provider, model, inputTokens, outputTokens} | {ok:false, error}],
 *          consumeQuota(n), maxRounds, maxChars, segmentChars }
 */
function runAdjustCore_(req, ctx, deps) {
  var plan = normalizeRequest_(req);
  if (!plan.text.trim()) throw new Error('請貼上要調整的文本。');
  var opts = analysisOpts_(plan, ctx);
  var before = GRAnalyzer.analyze(plan.text, ctx, opts);
  if (before.stats.hanChars > deps.maxChars) {
    throw new Error('文本有 ' + before.stats.hanChars + ' 個漢字，超過單次調整上限 ' + deps.maxChars + ' 字。長篇讀本請分章調整（分析功能不受此限）。');
  }
  var direction = decideDirection_(plan.mode, before, plan.target);
  var res = baseResult_('adjust', plan, ctx);
  Object.assign(res, {
    direction: direction, directionLabel: GR_DIRECTION_LABEL[direction],
    before: before, after: before, revisedText: plan.text, rounds: 0, segments: 0, passed: false,
    verified: before.meta.lexiconLoaded, issues: '', changes: [], glossary: [], grammarNotes: [],
    summary: '', llm: { provider: '', model: '', calls: 0, inputTokens: 0, outputTokens: 0 }
  });

  // 已合級又沒有規範問題：不呼叫 LLM，省下費用
  var first = checkPass_(before, before, plan, direction, 0);
  if (direction === 'polish' && first.pass && !hasNormIssues_(before) && plan.mode !== 'localize') {
    res.passed = res.verified;
    res.summary = '文本已符合目標等級，沒有偵測到字形或用語問題，因此未呼叫 LLM。';
    return finishAdjust_(res, plan, ctx);
  }

  var segs = splitSegments_(plan.text, Math.max(150, deps.segmentChars || 600));
  var active = [];
  segs.forEach(function (s, i) { if (s.active) active.push(i); });
  res.segments = active.length;
  var kept = {}, summaries = [], segIssues = {};
  var keptIn = function (text) { return Object.keys(kept).filter(function (w) { return text.indexOf(w) >= 0; }); };
  var segCheck = function (i) {
    var t = segs[i].core;
    var a = GRAnalyzer.analyze(t, ctx, Object.assign(analysisOpts_(plan, ctx, keptIn(t)), { withSpans: false }));
    var st = GRAnalyzer.analyze(t, ctx, Object.assign({}, opts, { withSpans: false }));
    return { an: a, check: checkPass_(a, st, plan, direction, 0) };
  };

  var todo = active.slice(), draft = plan.text, current = before;
  var maxRounds = Math.max(1, deps.maxRounds || 1);
  while (res.rounds < maxRounds && todo.length) {
    try {
      deps.consumeQuota(todo.length);
    } catch (e) {
      if (res.rounds === 0) throw e;
      res.warnings.push('第 ' + (res.rounds + 1) + ' 輪沒有執行（' + e.message + '），保留第 ' + res.rounds + ' 輪的修訂稿。');
      break;
    }
    res.rounds++;
    var round = res.rounds;
    var users = todo.map(function (i) {
      var t = segs[i].core;
      var segAn = GRAnalyzer.analyze(t, ctx, Object.assign(analysisOpts_(plan, ctx, keptIn(t)), { withSpans: false }));
      return buildUserPrompt_(t, segAn, {
        stop: plan.stop, target: plan.target, strictStar: plan.strictStar, sentLenGuide: plan.sentLenGuide,
        direction: direction, purpose: plan.purpose, learner: plan.learner,
        protectedWords: plan.protectedWords, known: plan.known, glossary: plan.glossary, notes: plan.notes,
        round: round, prevIssues: segIssues[i] || '', segIndex: active.indexOf(i), segCount: active.length
      }, ctx);
    });
    var outs = deps.callLlmBatch(GR_SYSTEM_PROMPT, users, GR_REVISION_TOOL);
    var okCount = 0, fails = [];
    outs.forEach(function (out, k) {
      var i = todo[k], seg = segs[i];
      res.llm.calls++;
      if (!out || !out.ok) { fails.push((out && out.error) || 'LLM 沒有回應'); return; }
      var d = out.data || {};
      var revised = String(d.revised_text || '').replace(/\r\n?/g, '\n').trim();
      if (!revised) { fails.push('模型沒有回傳修訂稿'); return; }
      okCount++;
      (d.changes || []).forEach(function (c) {
        res.changes.push({ round: round, segment: active.indexOf(i) + 1, original: String(c.original || ''), revised: String(c.revised || ''),
                           category: String(c.category || '其他'), reason: String(c.reason || ''),
                           located: seg.core.indexOf(String(c.original || '')) >= 0 });
      });
      (d.kept_above_level || []).forEach(function (kw) { if (kw && kw.word) kept[String(kw.word).trim()] = kw; });
      (d.grammar_notes || []).forEach(function (g) {
        if (g && g.point && !res.grammarNotes.some(function (x) { return x.point === g.point; })) res.grammarNotes.push(g);
      });
      if (d.summary && round === 1) summaries.push(String(d.summary));
      seg.core = revised;
      res.llm.provider = out.provider; res.llm.model = out.model;
      res.llm.inputTokens += out.inputTokens || 0; res.llm.outputTokens += out.outputTokens || 0;
    });
    if (!okCount && round === 1) throw new Error(fails[0] || 'LLM 沒有回傳修訂稿。');
    if (fails.length) {
      var uniqFails = fails.filter(function (f, k) { return fails.indexOf(f) === k; });
      res.warnings.push('第 ' + round + ' 輪有 ' + fails.length + ' 段沒有完成，該段保留' + (round === 1 ? '原文' : '上一版') + '：' + uniqFails.slice(0, 2).join('；'));
    }

    // 合併後整篇驗證
    draft = joinSegments_(segs);
    var keptWords = keptIn(draft);
    var strict = GRAnalyzer.analyze(draft, ctx, Object.assign({}, opts, { withSpans: false }));
    current = GRAnalyzer.analyze(draft, ctx, analysisOpts_(plan, ctx, keptWords));
    current.strict = { effectivePct: strict.target.effectivePct, estimate: strict.estimate.level, beyond: strict.estimate.beyond };
    var keptAbove = keptWords.filter(function (w) {
      return current.target.above.some(function (a) { return a.w === w; }) || !(ctx.lex && ctx.lex.map[w]);
    });
    var check = checkPass_(current, strict, plan, direction, keptAbove.length);
    res.passed = res.verified && check.pass;
    res.issues = check.issues;
    if (check.pass) break;

    // 下一輪只重送沒過的段落；若每段單看都過、但整篇沒過（例如保留生詞太多），就全部重送
    todo = active.filter(function (i) {
      var c = segCheck(i).check;
      segIssues[i] = c.issues;
      return !c.pass;
    });
    if (!todo.length) {
      todo = active.slice();
      active.forEach(function (i) { segIssues[i] = check.issues; });
    }
  }

  res.after = current;
  res.revisedText = draft;
  res.summary = summaries.join(' ');
  res.glossary = buildGlossary_(current, kept, plan, ctx, draft);
  var ratio = before.stats.hanChars ? current.stats.hanChars / before.stats.hanChars : 1;
  if (ratio < 0.6) res.warnings.push('修訂稿篇幅只有原文的 ' + Math.round(ratio * 100) + '%，請確認沒有刪掉情節。');
  var lost = res.changes.filter(function (c) { return !c.located; }).length;
  if (lost) res.warnings.push('有 ' + lost + ' 條修訂紀錄的「原文」在待修改文本中找不到（模型轉述或合併了句子），請對照修訂稿確認。');
  if (!res.verified) res.warnings.push('尚未載入 TBCL 詞語表：修訂結果沒有經過詞表驗證，等級一律為推估。');
  else if (!res.passed) res.warnings.push('已改寫 ' + res.rounds + ' 輪，仍未完全通過驗證：' + res.issues + '。可加入生詞或保留詞後再調整一次，或人工修改。');
  return finishAdjust_(res, plan, ctx);
}

function finishAdjust_(res, plan, ctx) {
  res.statement = alignmentStatement_(res.after, plan, ctx);
  if (!plan.includeSpans) { delete res.before.spans; if (res.after) delete res.after.spans; }
  if (plan.includeReport) res.report = GRReport.markdown(res);
  return res;
}

/** 建議生詞表：修訂稿中仍超出目標級的詞＋模型刻意保留的詞。拼音、注音只取 TBCL 詞表的參考欄位。 */
function buildGlossary_(an, kept, plan, ctx, text) {
  var out = [], seen = {}, userGloss = {};
  GRAnalyzer.parseWordList(plan.glossary).forEach(function (w) { userGloss[w] = true; });
  (an.target ? an.target.above : []).forEach(function (a) {
    var k = kept[a.w] || {};
    seen[a.w] = true;
    out.push({ w: a.w, lv: a.lv, lvl: a.lvl, n: a.n, py: a.py || '', zy: a.zy || '', pos: k.pos || '', en: k.english || '',
               reason: k.reason || '', source: k.word ? '模型保留' : (userGloss[a.w] ? '生詞表' : '未處理') });
  });
  // 模型保留、但詞表未收錄的詞（例如新詞、地方小吃）
  Object.keys(kept).forEach(function (w) {
    if (seen[w]) return;
    var e = ctx.lex && ctx.lex.map[w];
    if (e && (e.l < plan.target || (e.l === plan.target && !(plan.strictStar && e.s)))) return;   // 其實沒有超綱，不必列
    var count = 0, i = -1;
    while ((i = text.indexOf(w, i + 1)) >= 0) count++;
    if (!count) return;                             // 修訂稿裡已經沒有這個詞
    var k = kept[w];
    out.push({ w: w, lv: e ? e.l : null, lvl: e ? (e.s && plan.strictStar ? e.l + '*' : String(e.l)) : '', n: count, py: e ? e.p : '', zy: e ? e.z : '', pos: k.pos || '', en: k.english || '',
               reason: k.reason || '', source: '模型保留' });
  });
  return out.sort(function (a, b) { return (b.lv || 8) - (a.lv || 8) || b.n - a.n; });
}


// ================================================================ Code.gs
/**
 * Code.gs — 網頁入口（Google Sites 嵌入）與前端可呼叫的函式
 *
 * 前端用 google.script.run 呼叫沒有底線結尾的函式（uiBootstrap、uiAnalyze、uiAdjust）；
 * 以底線結尾的函式是私有函式，前端無法呼叫。
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'health') {
    // 狀態資訊含模型與用量，需要 API 權杖；沒有權杖只回報服務正常
    var token = prop_('API_TOKEN', '');
    return jsonOut_(token && p.token === token ? { ok: true, status: statusInfo_() } : { ok: true });
  }
  var t = HtmlService.createTemplateFromFile('Index');
  t.prefsJson = JSON.stringify(urlPrefs_(p)).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('分級讀本等級調整機器人')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    // 允許嵌入 Google Sites 與學校網站的 iframe
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 樣板中 <?!= include_('Styles') ?> 使用。 */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** 網址參數：?lang=vi&font=pinyin&size=l&level=3（只接受白名單值）。 */
function urlPrefs_(p) {
  var out = {};
  if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(p.lang || '')) out.lang = p.lang;
  if (['std', 'pinyin', 'zhuyin'].indexOf(p.font) >= 0) out.font = p.font;
  if (['s', 'm', 'l'].indexOf(p.size) >= 0) out.size = p.size;
  if (/^[1-7]$/.test(p.level || '')) out.level = parseInt(p.level, 10);
  var stop = grParseTocfl(p.tocfl);
  if (stop >= 0) out.tocfl = stop;
  if (['light', 'dark', 'auto'].indexOf(p.theme) >= 0) out.theme = p.theme;
  return out;
}

function uiBootstrap() {
  return safeRun_(function () {
    return {
      ok: true, levels: GR_LEVELS, tocfl: GR_TOCFL, purposes: GR_PURPOSES, learners: GR_LEARNERS, status: statusInfo_(),
      ui: {
        defaultLang: prop_('UI_DEFAULT_LANG'),
        fonts: { pinyinUrl: safeFontUrl_(prop_('TONEOZ_PINYIN_URL')), zhuyinUrl: safeFontUrl_(prop_('TONEOZ_ZHUYIN_URL')) },
        i18n: loadI18nOverrides_()
      }
    };
  });
}

function safeFontUrl_(u) {
  u = String(u || '').trim();
  return /^https:\/\/[^\s"'()<>]+$/.test(u) ? u : '';
}

function uiAnalyze(req) {
  return safeRun_(function () { return runAnalyze_(req, 'ui'); });
}

function uiAdjust(req) {
  return safeRun_(function () { return runAdjust_(req, 'ui'); });
}

// ----------------------------------------------------------------------------- 共用執行

function runAnalyze_(req, source) {
  var t0 = Date.now();
  var res = runAnalyzeCore_(req, getContext_());
  appendLog_(source, 'analyze', normalizeRequest_(req), res, Date.now() - t0);
  return res;
}

function runAdjust_(req, source) {
  var t0 = Date.now();
  var st = llmStatus_();
  if (!st.configured) throw new Error('目前只能分析，尚未設定 LLM：' + st.hint);
  var res = runAdjustCore_(req, getContext_(), {
    callLlmBatch: callLlmBatch_,
    consumeQuota: consumeQuota_,
    maxRounds: propInt_('MAX_ROUNDS'),
    maxChars: propInt_('MAX_CHARS'),
    segmentChars: propInt_('SEGMENT_CHARS')
  });
  appendLog_(source, 'adjust', normalizeRequest_(req), res, Date.now() - t0);
  return res;
}

function statusInfo_() {
  var ctx = getContext_();
  var llm = llmStatus_();
  return {
    version: GR_CONFIG.version,
    lexicon: { loaded: ctx.lex.forms > 0, entries: ctx.lex.entries, forms: ctx.lex.forms, label: ctx.lexLabel },
    chars: ctx.chars ? ctx.chars.forms : 0,
    grammar: ctx.grammar.length,
    proper: ctx.proper.length,
    llm: { provider: llm.provider, model: llm.model, configured: llm.configured, hint: llm.hint },
    quota: quotaStatus_(),
    limits: { maxChars: propInt_('MAX_CHARS'), maxRounds: propInt_('MAX_ROUNDS'), segmentChars: propInt_('SEGMENT_CHARS') }
  };
}

function safeRun_(fn) {
  try {
    return fn();
  } catch (err) {
    console.error(err && err.stack || err);
    return { ok: false, error: String(err && err.message || err) };
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}


// ================================================================ Api.gs
/**
 * Api.gs — 對外 JSON API（給其他系統串接：課程平臺、LINE Bot、看板、批次腳本）
 *
 * POST {網頁應用程式網址}
 * Content-Type: text/plain（瀏覽器端用 text/plain 可避開 CORS 預檢；伺服器端用 application/json 亦可）
 * Body：
 *   {
 *     "token":   "<指令碼屬性 API_TOKEN>",
 *     "action":  "analyze" | "adjust" | "levels" | "health",
 *     "text":    "要處理的文本",
 *     "target":  3,                       // TBCL 1–7
 *     "mode":    "auto" | "down" | "up" | "localize",
 *     "purpose": "extensive" | "intensive",
 *     "learner": "adult_nonchar" | "adult_char" | "overseas" | "child",
 *     "protectedWords": "安娜\n士林夜市",   // 不得更動的詞
 *     "known": "…", "glossary": "…", "notes": "…",
 *     "includeSpans": false,              // 是否回傳逐詞標記（預設 false，資料量較小）
 *     "includeReport": true               // 是否回傳 Markdown 編修報告
 *   }
 * 回應：{ "ok": true, ... } 或 { "ok": false, "error": "..." }
 *
 * 注意：Apps Script 網頁應用程式的 POST 會先回 302 轉址，用 curl 請加 -L，其他用戶端請開啟「跟隨轉址」。
 */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var token = prop_('API_TOKEN', '');
    if (!token || req.token !== token) {
      out = { ok: false, error: 'unauthorized：權杖錯誤或尚未設定 API_TOKEN' };
    } else {
      if (req.includeSpans === undefined) req.includeSpans = false;
      switch (req.action) {
        case 'health': out = { ok: true, status: statusInfo_() }; break;
        case 'levels': out = { ok: true, levels: GR_LEVELS, purposes: GR_PURPOSES, learners: GR_LEARNERS }; break;
        case 'analyze': out = runAnalyze_(req, 'api'); break;
        case 'adjust': out = runAdjust_(req, 'api'); break;
        default: out = { ok: false, error: '不支援的 action：' + req.action };
      }
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return jsonOut_(out);
}


// ================================================================ Setup.gs
/**
 * Setup.gs — 初始化與維護（在試算表選單或 Apps Script 編輯器執行）
 */

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('分級讀本機器人')
      .addItem('① 初始化試算表', 'setupProject')
      .addItem('② 重新載入詞表（更新詞表後執行）', 'clearLexiconCache')
      .addItem('③ 自我檢測', 'selfTest')
      .addSeparator()
      .addItem('匯出內建介面翻譯（到「介面翻譯」分頁修改）', 'exportTranslations')
      .addItem('顯示對外 API 權杖', 'showApiToken')
      .addToUi();
  } catch (e) { /* 獨立專案沒有試算表選單 */ }
}

var GR_SHEET_SPECS_ = [
  { key: 'guide', header: ['分級讀本等級調整機器人', ''], rows: [
    ['TBCL詞語', '從國教院 coct.naer.edu.tw「文件下載」取得 TBCL 詞語表 CSV，用「檔案 → 匯入 → 取代目前的工作表」匯入此分頁。欄位會自動偵測（詞語、級別、參考漢語拼音、參考注音）。'],
    ['TBCL漢字', '（選用）漢字表，至少要有「漢字」「級別」兩欄。'],
    ['TBCL語法點', '（選用）語法點表，至少要有「語法點」「級別」兩欄；會提供給模型作為可用語法清單。'],
    ['專名', '人名、地名、店名、品牌與「不得更動的詞」，一行一個。避免被斷詞拆開而誤判超綱。'],
    ['用語對照', '大陸用詞／臺灣用詞／備註。內建約 90 條，這裡可增補或覆蓋。'],
    ['執行紀錄', '每次分析或調整都會記一列，可用來統計使用量與 API 費用。'],
    ['介面翻譯', '介面按鈕與說明的多語翻譯。執行選單「匯出內建介面翻譯」後，直接修改格子即可覆蓋內建翻譯；改完執行「② 重新載入詞表」讓快取更新。結果內容一律以中文輸出，不受介面語言影響。'],
    ['更新詞表後', '請執行選單「分級讀本機器人 → ② 重新載入詞表」，否則快取最多保留 6 小時。'],
    ['詞表版本', '請在 Apps Script「專案設定 → 指令碼屬性」設定 TBCL_VERSION_LABEL（例如檔名或日期），會寫進報告。']
  ] },
  { key: 'words', header: ['序號', '詞語', '等別', '級別', '情境', '書面字頻(每百萬字)', '口語字頻(每百萬字)', '簡編本系統號', '參考注音', '參考漢語拼音'] },
  { key: 'chars', header: ['序號', '漢字', '等別', '級別'] },
  { key: 'grammar', header: ['序號', '語法點', '等別', '級別'] },
  { key: 'proper', header: ['詞語', '備註'] },
  { key: 'terms', header: ['大陸用詞', '臺灣用詞', '備註'] },
  { key: 'i18n', header: ['key', 'zh-Hant', 'en'] },
  { key: 'log', header: ['時間', '來源', '動作', '目標級', '方向', '用途', '漢字數', '修訂前估計', '修訂後估計',
                         '修訂前覆蓋率%', '修訂後覆蓋率%', '輪數', 'LLM', '模型', '輸入 tokens', '輸出 tokens', '耗時 ms', '使用者'] }
];

/** 建立（或補齊）資料試算表的分頁、寫入 SHEET_ID、產生 API_TOKEN。不會覆蓋既有資料。 */
function setupProject() {
  var props = PropertiesService.getScriptProperties();
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (!ss && props.getProperty('SHEET_ID')) ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
  if (!ss) ss = SpreadsheetApp.create('分級讀本機器人資料庫');
  props.setProperty('SHEET_ID', ss.getId());

  GR_SHEET_SPECS_.forEach(function (spec) {
    var name = GR_CONFIG.sheets[spec.key];
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, spec.header.length).setValues([spec.header]).setFontWeight('bold');
      sh.setFrozenRows(1);
      if (spec.rows) sh.getRange(2, 1, spec.rows.length, spec.rows[0].length).setValues(spec.rows).setWrap(true);
    }
  });
  var guide = ss.getSheetByName(GR_CONFIG.sheets.guide);
  if (guide) { guide.setColumnWidth(1, 140); guide.setColumnWidth(2, 640); ss.setActiveSheet(guide); ss.moveActiveSheet(1); }
  var first = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);

  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  if (!props.getProperty('LLM_PROVIDER')) props.setProperty('LLM_PROVIDER', GR_CONFIG.defaults.LLM_PROVIDER);
  if (!props.getProperty('ANTHROPIC_MODEL')) props.setProperty('ANTHROPIC_MODEL', GR_CONFIG.defaults.ANTHROPIC_MODEL);

  notify_('初始化完成。\n\n下一步：\n1. 在「TBCL詞語」分頁匯入國教院詞語表 CSV。\n2. 到 Apps Script「專案設定 → 指令碼屬性」新增 ANTHROPIC_API_KEY。\n3. 執行選單「② 重新載入詞表」與「③ 自我檢測」。\n4. 部署為網頁應用程式，並在 Google Sites 用「嵌入 → 網址」貼上網址。\n\n試算表：' + ss.getUrl());
}

/** 自我檢測：確認詞表、LLM 設定與分析引擎。 */
function selfTest() {
  GR_CTX_MEMO_ = null;
  var st = statusInfo_();
  var sample = '安娜是從法國來的學生。今天晚上，她和朋友一起去夜市。夜市裡人很多，非常熱鬧。';
  var res = runAnalyzeCore_({ text: sample, target: 3, protectedWords: '安娜\n法國', includeSpans: false, includeReport: false }, getContext_());
  var an = res.before;
  var lines = [
    '版本：' + st.version,
    'TBCL 詞語：' + (st.lexicon.loaded ? st.lexicon.entries + ' 筆（' + st.lexicon.forms + ' 個詞形）' : '未載入'),
    '漢字表：' + (st.chars || '未載入') + '；語法點：' + (st.grammar || '未載入') + '；專名：' + st.proper,
    'LLM：' + st.llm.provider + ' / ' + (st.llm.model || '—') + (st.llm.configured ? '（已設定）' : '（未設定：' + st.llm.hint + '）'),
    '今日配額：' + st.quota.used + ' / ' + st.quota.limit,
    '',
    '範例分析：詞次 ' + an.stats.tokens + '，適讀等級估計 ' + (an.estimate.level || '—') + '，第 3 級可理解覆蓋率 ' + (an.target ? an.target.effectivePct + '%' : '—'),
    an.warnings.length ? '提醒：' + an.warnings.join(' ') : ''
  ];
  notify_(lines.join('\n'));
  return lines.join('\n');
}

function showApiToken() {
  var t = prop_('API_TOKEN', '');
  notify_(t ? '對外 API 權杖：\n' + t + '\n\n請只提供給需要串接的系統管理者。要更換時，到指令碼屬性修改 API_TOKEN。' : '尚未產生，請先執行「初始化試算表」。');
}

/** 把內建翻譯全部寫到「介面翻譯」分頁（會覆蓋分頁內容），方便請各國學生或同事校對。 */
function exportTranslations() {
  var ss = openSheet_();
  if (!ss) { notify_('請先執行「初始化試算表」。'); return; }
  var b = builtinI18n_();
  var langs = b.langs.map(function (l) { return l.code; });
  var keys = Object.keys(b.strings['zh-Hant']);
  var rows = [['key'].concat(langs)].concat(keys.map(function (k) {
    return [k].concat(langs.map(function (l) { return (b.strings[l] && b.strings[l][k]) || ''; }));
  }));
  var sh = ss.getSheetByName(GR_CONFIG.sheets.i18n) || ss.insertSheet(GR_CONFIG.sheets.i18n);
  sh.clearContents();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  sh.setFrozenRows(1); sh.setFrozenColumns(2);
  clearLexiconCache();
  notify_('已匯出 ' + keys.length + ' 條 × ' + langs.length + ' 種語言。修改後執行「② 重新載入詞表」即可生效；不需要改的列可以刪掉。');
}
