const assert = require('assert'), fs = require('fs');
const load = require('./load_gs'), makeMocks = require('./mock_gas');
const FILES = ['Assets.gs', 'Phonetics.gs', 'Levels.gs', 'Analyzer.gs', 'Config.gs', 'Data.gs', 'Llm.gs', 'Prompts.gs', 'Report.gs', 'Adjust.gs', 'Code.gs', 'Api.gs', 'Setup.gs'];
const fx = __dirname + '/fixtures/';
const sample = fs.readFileSync(fx + 'sample.txt', 'utf8');

const REV1 = sample.replace('非常擁擠。攤販賣的東西琳瑯滿目，空氣中都是食物的香味。', '非常擁擠。很多人在賣東西，有很多好吃的食物。')
  .replace('安娜迫不及待地想品嚐臺灣美食。', '安娜很想吃臺灣的東西。').replace('出租車', '計程車').replace('觉得', '覺得').replace('开心', '開心');
const REV2 = REV1.replace('非常擁擠。', '人非常多。').replace('夜市裡人很多，人非常多。', '夜市裡人非常多。');
const toolResp = (text, changes, kept) => ({ body: { id: 'msg', type: 'message', role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 't1', name: 'submit_revision', input: { revised_text: text, changes, kept_above_level: kept || [], summary: '降級並改為臺灣用語。' } }],
  usage: { input_tokens: 1500, output_tokens: 600 } } });

function setup(handler) {
  const m = makeMocks({
    sheets: { 'TBCL詞語': makeMocks({}).csvRows(fx + 'demo_lexicon.csv'), '專名': [['詞語', '備註'], ['安娜', '人名'], ['小美', '人名'], ['士林夜市', '地名'], ['法國', '國名']],
              '用語對照': [['大陸用詞', '臺灣用詞', '備註'], ['打卡', '打卡', '測試覆蓋']], '執行紀錄': [['時間']] },
    props: { SHEET_ID: 'SHEET123', ANTHROPIC_API_KEY: 'sk-test', API_TOKEN: 'tok' , TBCL_VERSION_LABEL: '示範詞表'},
    fetchHandler: handler
  });
  const g = load(FILES, m.globals);
  return { g, m };
}

// 1) 分析＋快取
let { g, m } = setup(() => { throw new Error('no fetch expected'); });
let r = g.uiAnalyze({ text: sample, target: 3 });
assert.ok(r.ok, r.error);
assert.strictEqual(r.before.meta.lexiconLoaded, true);
assert.strictEqual(r.direction, 'down');
assert.ok(Object.keys(m.cache).some(k => k.endsWith(':word:n')), 'lexicon cached');
assert.ok(r.report.includes('## 二、檢核結果'));
console.log('analyze OK — est', r.before.estimate.level, 'beyond', r.before.estimate.beyond, 'eff', r.before.target.effectivePct, '| statement:', r.statement);
g.GR_CTX_MEMO_ = null; // 模擬下一次執行：應該從快取讀
const ctx2 = g.getContext_();
assert.strictEqual(ctx2.lex.forms, r.before.meta.lexiconForms);
assert.strictEqual(ctx2.proper.length, 4);

// 2) 調整：第 1 輪留下「擁擠」→ 未通過；第 2 輪修正 → 通過
({ g, m } = setup((url, opt, n) => n === 1
  ? toolResp(REV1, [{ original: '攤販賣的東西琳瑯滿目', revised: '很多人在賣東西', category: '詞彙', reason: '攤販 6 級、琳瑯滿目 7 級' },
                    { original: '出租車', revised: '計程車', category: '用語', reason: '臺灣說計程車' }])
  : toolResp(REV2, [{ original: '非常擁擠', revised: '人非常多', category: '詞彙', reason: '擁擠 5 級' }])));
r = g.uiAdjust({ text: sample, target: 3, purpose: 'intensive' });
assert.ok(r.ok, r.error);
const f1 = m.log.fetches[0];
assert.strictEqual(f1.url, 'https://api.anthropic.com/v1/messages');
assert.strictEqual(f1.opt.headers['anthropic-version'], '2026-10-21');
assert.strictEqual(f1.opt.headers['x-api-key'], 'sk-test');
assert.strictEqual(f1.body.model, 'claude-sonnet-5-5');
assert.ok(!('temperature' in f1.body), 'no temperature in 2026-10-21');
assert.strictEqual(f1.body.tool_choice.name, 'submit_revision');
assert.ok(f1.body.messages[0].content.includes('琳瑯滿目／7／1'), 'prompt lists above-level words');
assert.ok(f1.body.messages[0].content.includes('出租車→計程車'));
assert.ok(f1.body.messages[0].content.includes('【不得更動的詞】'));
assert.strictEqual(m.log.fetches.length, 2, 'two rounds');
assert.ok(m.log.fetches[1].body.messages[0].content.includes('擁擠（5）'), 'round 2 feedback names 擁擠');
assert.strictEqual(r.rounds, 2); assert.strictEqual(r.passed, true, r.issues);
assert.strictEqual(r.revisedText, REV2.trim());
assert.strictEqual(r.changes.length, 3);
assert.strictEqual(r.llm.inputTokens, 3000);
assert.strictEqual(m.store.quota_20261022, '2');
assert.ok(m.log.appended.some(a => a.name === '執行紀錄'));
console.log('adjust OK — rounds', r.rounds, 'passed', r.passed, '| before est', r.before.estimate.level, '→ after est', r.after.estimate.level, '| eff', r.before.target.effectivePct, '→', r.after.target.effectivePct);
console.log('warnings', r.warnings, '| glossary', JSON.stringify(r.glossary));
fs.writeFileSync(__dirname + '/out_report.md', r.report);

// 3) 合級文本不呼叫 LLM
({ g, m } = setup(() => { throw new Error('should not call'); }));
r = g.uiAdjust({ text: REV2, target: 3, purpose: 'intensive' });
assert.ok(r.ok, r.error); assert.strictEqual(r.rounds, 0);
console.log('skip-LLM OK —', r.summary);

// 4) doPost
({ g, m } = setup(() => toolResp(REV2, [])));
let out = JSON.parse(g.doPost({ postData: { contents: JSON.stringify({ token: 'bad', action: 'health' }) } }).text);
assert.strictEqual(out.ok, false);
out = JSON.parse(g.doPost({ postData: { contents: JSON.stringify({ token: 'tok', action: 'analyze', text: sample, target: 2 }) } }).text);
assert.ok(out.ok, out.error); assert.ok(!out.before.spans, 'api omits spans by default');
out = JSON.parse(g.doPost({ postData: { contents: JSON.stringify({ token: 'tok', action: 'health' }) } }).text);
assert.strictEqual(out.status.lexicon.loaded, true);
console.log('doPost OK — health', JSON.stringify(out.status.llm));

// 5) API 錯誤處理（401、429 重試）
let calls = 0;
({ g, m } = setup(() => { calls++; return calls < 3 ? { code: 529, body: { error: { type: 'overloaded_error', message: 'Overloaded' } } } : toolResp(REV2, []); }));
r = g.uiAdjust({ text: sample, target: 3, mode: 'down' });
assert.ok(r.ok, r.error); assert.strictEqual(calls >= 3, true);
({ g, m } = setup(() => ({ code: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } })));
r = g.uiAdjust({ text: sample, target: 3 });
assert.strictEqual(r.ok, false); assert.ok(r.error.includes('401') && !r.error.includes('sk-test'));
console.log('errors OK —', r.error);

// 6) 未設定金鑰：只能分析
({ g, m } = setup(() => { throw new Error('x'); }));
delete m.store.ANTHROPIC_API_KEY;
r = g.uiAdjust({ text: sample, target: 3 });
assert.strictEqual(r.ok, false); console.log('no-key OK —', r.error);
// 7) 介面翻譯：匯出內建翻譯到試算表，再讀回來當覆蓋值；uiBootstrap 帶出字型網址
({ g, m } = setup(() => { throw new Error('x'); }));
const bi = g.builtinI18n_();
assert.strictEqual(bi.langs.length, 16);
g.exportTranslations();
const sh = m.book['介面翻譯'];
assert.strictEqual(sh._rows[0][0], 'key'); assert.strictEqual(sh._rows[0].length, 17);
sh._rows.find(r => r[0] === 'btn.analyze')[sh._rows[0].indexOf('vi')] = 'Phân tích (đã sửa)';
g.clearLexiconCache();
const boot = g.uiBootstrap();
assert.ok(boot.ok, boot.error);
assert.strictEqual(boot.ui.i18n.vi['btn.analyze'], 'Phân tích (đã sửa)');
assert.ok(boot.ui.fonts.zhuyinUrl.startsWith('https://cdn.jsdelivr.net/gh/jeffreyxuan/toneoz-font-zhuyin@'));
assert.strictEqual(boot.ui.fonts.pinyinUrl, '');
m.store.TONEOZ_PINYIN_URL = 'javascript:alert(1)';
assert.strictEqual(g.uiBootstrap().ui.fonts.pinyinUrl, '', 'unsafe font URL rejected');
assert.deepStrictEqual(JSON.parse(JSON.stringify(g.urlPrefs_({ lang: 'vi', font: 'pinyin', size: 'l', level: '2', x: '<script>' }))), { lang: 'vi', font: 'pinyin', size: 'l', level: 2 });
assert.deepStrictEqual(JSON.parse(JSON.stringify(g.urlPrefs_({ lang: '"><script>', font: 'evil' }))), {});
console.log('i18n sheet OK — keys exported', sh._rows.length - 1);
console.log('ALL BACKEND TESTS PASSED');
