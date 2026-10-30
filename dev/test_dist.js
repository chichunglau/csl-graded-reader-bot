// 用合併版 Code.gs 跑一次：分析、讀內建翻譯、doPost、介面樣板
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const makeMocks = require('./mock_gas');
const fx = __dirname + '/fixtures/';
const m = makeMocks({ sheets: { 'TBCL詞語': makeMocks({}).csvRows(fx + 'demo_lexicon.csv'), '執行紀錄': [['時間']] },
  props: { SHEET_ID: 'x', API_TOKEN: 'tok' }, fetchHandler: () => { throw new Error('no fetch'); } });
m.globals.HtmlService.createHtmlOutputFromFile = n => ({ getContent: () => fs.readFileSync(__dirname + '/../dist/' + n + '.html', 'utf8') });
const g = vm.createContext(Object.assign({ console }, m.globals));
vm.runInContext(fs.readFileSync(__dirname + '/../dist/Code.gs', 'utf8'), g);
const r = g.uiAnalyze({ text: fs.readFileSync(fx + 'sample.txt', 'utf8'), target: 3 });
assert.ok(r.ok, r.error); assert.strictEqual(r.before.meta.lexiconLoaded, true);
assert.strictEqual(g.builtinI18n_().langs.length, 16);
const api = JSON.parse(g.doPost({ postData: { contents: JSON.stringify({ token: 'tok', action: 'health' }) } }).text);
assert.ok(api.ok);
const idx = fs.readFileSync(__dirname + '/../dist/Index.html', 'utf8');
const tags = idx.match(/<\?!?=?[^?]*\?>/g); console.log('template tags', tags);
assert.strictEqual(tags.length, 2);
console.log('DIST OK — est', r.before.estimate.level, 'beyond', r.before.estimate.beyond);
