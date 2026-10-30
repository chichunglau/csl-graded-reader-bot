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
