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
