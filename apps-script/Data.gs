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

function cacheKey_(kind) { return 'gr' + prop_('CACHE_VER', '1') + ':' + kind; }

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

/** 每呼叫一次 LLM 扣一次；超過 DAILY_LIMIT 就擋下，避免網頁被濫用而產生費用。 */
function consumeQuota_() {
  var limit = propInt_('DAILY_LIMIT');
  var key = 'quota_' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var used = parseInt(props.getProperty(key) || '0', 10);
    if (used >= limit) throw new Error('今日 LLM 呼叫次數已達上限（' + limit + ' 次），請明天再試，或請管理者調高 DAILY_LIMIT。');
    if (used === 0) {
      props.getKeys().forEach(function (k) { if (k.indexOf('quota_') === 0 && k !== key) props.deleteProperty(k); });
    }
    props.setProperty(key, String(used + 1));
    return { used: used + 1, limit: limit };
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
      new Date(), source, action, req.target || '', res.direction || '', req.purpose || '',
      b.stats ? b.stats.hanChars : '',
      b.estimate ? (b.estimate.level || (b.estimate.beyond ? '>7' : '')) : '',
      a.estimate ? (a.estimate.level || (a.estimate.beyond ? '>7' : '')) : '',
      b.target ? b.target.effectivePct : '', a.target ? a.target.effectivePct : '',
      res.rounds || 0, res.llm ? res.llm.provider : '', res.llm ? res.llm.model : '',
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
