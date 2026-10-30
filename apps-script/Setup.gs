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
