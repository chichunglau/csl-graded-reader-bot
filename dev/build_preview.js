// 產生介面預覽（單一 HTML）：內嵌分析引擎、示範詞表與預錄的 AI 回應
const fs = require('fs'), path = require('path');
const AS = path.join(__dirname, '..', 'apps-script');
const read = f => fs.readFileSync(path.join(AS, f), 'utf8');
const out = process.argv[2];
const csv = fs.readFileSync(path.join(__dirname, 'fixtures', 'demo_lexicon.csv'), 'utf8');
const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.txt'), 'utf8').trim();
const REV1 = sample.replace('攤販賣的東西琳瑯滿目，空氣中都是食物的香味。', '很多人在賣東西，有很多好吃的食物。')
  .replace('安娜迫不及待地想品嚐臺灣美食。', '安娜很想吃臺灣的東西。').replace('出租車', '計程車').replace('觉得', '覺得').replace('开心', '開心');
const REV2 = REV1.replace('夜市裡人很多，非常擁擠。', '夜市裡人非常多。').replace('有很多好吃的食物。', '到處都是食物的香味。');
const canned = {
  r1: { revised_text: REV1, summary: '把第 4–7 級的描寫詞換成第 1–3 級的說法，簡體字改正體，「出租車」改為臺灣用語「計程車」。',
    changes: [
      { original: '攤販賣的東西琳瑯滿目，空氣中都是食物的香味', revised: '很多人在賣東西，有很多好吃的食物', category: '詞彙', reason: '攤販 6 級、琳瑯滿目 7 級、空氣 4 級、香味 5 級（依詞表），改用第 1–3 級詞語' },
      { original: '安娜迫不及待地想品嚐臺灣美食', revised: '安娜很想吃臺灣的東西', category: '詞彙', reason: '迫不及待 6 級、品嚐 5 級、美食 4 級，改用「很想吃」' },
      { original: '出租車', revised: '計程車', category: '用語', reason: '「出租車」為大陸用語，臺灣說計程車' },
      { original: '觉得', revised: '覺得', category: '字形', reason: '簡體字改正體' },
      { original: '开心', revised: '開心', category: '字形', reason: '簡體字改正體' }],
    grammar_notes: [{ point: 'V V 看（嘗試）', example: '你一定要吃吃看！', note: '口語常用；等級請以 TBCL 語法點檢索系統確認' }] },
  r2: { revised_text: REV2, summary: '第 2 輪處理剩下的「擁擠」，並補回原文的香味描寫，「香味」保留為本章生詞。',
    changes: [
      { original: '夜市裡人很多，非常擁擠。', revised: '夜市裡人非常多。', category: '詞彙', reason: '擁擠為第 5 級（依詞表），併入「人非常多」' },
      { original: '有很多好吃的食物。', revised: '到處都是食物的香味。', category: '內容', reason: '補回原文的感官描寫；「香味」第 5 級，保留並列為生詞' }],
    kept_above_level: [{ word: '香味', reason: '夜市的氣味是本章重點描寫', pos: 'N', english: 'aroma; appetizing smell' }] }
};
const backend = `
var PropertiesService = { getScriptProperties: function () { return { getProperty: function () { return null; } }; } };
${read('Levels.gs')}
${read('Assets.gs')}
${read('Phonetics.gs')}
${read('Analyzer.gs')}
${read('Config.gs')}
${read('Prompts.gs')}
${read('Report.gs')}
${read('Adjust.gs')}
(function () {
  var DEMO_CSV = ${JSON.stringify(csv)};
  var CANNED = ${JSON.stringify(canned)};
  var rows = DEMO_CSV.trim().split('\\n').map(function (l) { return l.split(','); });
  var lex = GRAnalyzer.buildLeveled(rows, 'word');
  var ctx = { lex: lex, chars: null, grammar: [], proper: [], norms: GRAnalyzer.prepareNorms(GR_ASSETS, []), phonic: GRAnalyzer.preparePhonic(GR_PHONIC),
              lexLabel: '示範詞表（' + lex.entries + ' 詞，等級為示意，非國教院 TBCL 資料）' };
  var used = 0;
  function safe(fn) { try { return fn(); } catch (e) { return { ok: false, error: e.message }; } }
  function fakeLlm(system, user) {
    var draft = user.slice(user.indexOf('<<<') + 3, user.lastIndexOf('>>>'));
    var d = draft.indexOf('琳瑯滿目') >= 0 ? CANNED.r1 : draft.indexOf('非常擁擠') >= 0 ? CANNED.r2 : null;
    if (!d) throw new Error('預覽版不會真的呼叫 AI，只能示範內建範例。部署到 Apps Script 並設定 API 金鑰後，就能改寫自己的文本。請按「載入範例」試用調整流程。');
    return { data: JSON.parse(JSON.stringify(d)), provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1800, outputTokens: 700 };
  }
  function status() {
    return { version: GR_CONFIG.version, lexicon: { loaded: true, entries: lex.entries, forms: lex.forms, label: ctx.lexLabel },
             chars: 0, grammar: 0, proper: 0, llm: { provider: 'anthropic', model: 'claude-sonnet-5-5', configured: true, hint: '' },
             quota: { used: used, limit: 200 }, limits: { maxChars: 3000, maxRounds: 2 } };
  }
  window.GR_PREVIEW = {
    note: '介面預覽：使用 ' + lex.entries + ' 詞的示範詞表（等級為示意，不是國教院 TBCL 資料），AI 改寫為預錄結果，只能示範內建範例。預覽環境不能載入外部字型檔，ToneOZ 字型只有在本機已安裝時才會顯示。正式版部署到 Google Apps Script 後，會讀取您匯入的 TBCL 詞表並呼叫 Claude API。',
    uiBootstrap: function () { return { ok: true, levels: GR_LEVELS, purposes: GR_PURPOSES, learners: GR_LEARNERS, status: status(),
      ui: { defaultLang: '', i18n: {}, fonts: { pinyinUrl: '', zhuyinUrl: '' } } }; },
    uiAnalyze: function (req) { return safe(function () { return runAnalyzeCore_(req, ctx); }); },
    uiAdjust: function (req) { return safe(function () { return runAdjustCore_(req, ctx, { callLlm: fakeLlm, consumeQuota: function () { used++; }, maxRounds: 2, maxChars: 3000 }); }); }
  };
})();
`;
let html = read('Index.html')
  .replace("<?!= include_('Styles') ?>", () => read('Styles.html'))
  .replace("<?!= prefsJson ?>", '{}')
  .replace("<?!= include_('I18n') ?>", () => read('I18n.html'))
  .replace("<?!= include_('Client') ?>", () => '<script>\n' + backend + '\n</script>\n' + read('Client.html'));
// 轉成 Artifact 頁面格式：去掉文件外框，保留 title、字型、樣式與內容
html = html.replace(/<!DOCTYPE html>\s*/i, '').replace(/<html[^>]*>\s*/i, '<script>document.documentElement.dataset.font="std";document.documentElement.dataset.size="m";</script>\n').replace(/<\/html>\s*/i, '')
  .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '').replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
  .replace(/<base[^>]*>\s*/i, '').replace(/<meta charset[^>]*>\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '')
  .replace('<title>分級讀本調級機器人</title>', '<title>分級讀本調級機器人</title>\n<meta name="claude:viewport-fit-sides" content="cover">');
fs.writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + 'KB');
