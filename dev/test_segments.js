// v1.4 修正的測試：分段平行、部分失敗、配額不足保留結果、準備一級、health 權杖、說話者判斷、IVS 過濾
const assert = require('assert'), fs = require('fs');
const load = require('./load_gs'), makeMocks = require('./mock_gas');
const FILES = ['Assets.gs', 'Phonetics.gs', 'Levels.gs', 'Analyzer.gs', 'Config.gs', 'Data.gs', 'Llm.gs', 'Prompts.gs', 'Report.gs', 'Adjust.gs', 'Code.gs', 'Api.gs', 'Setup.gs'];
const fx = __dirname + '/fixtures/';
const lexRows = makeMocks({}).csvRows(fx + 'demo_lexicon.csv');
// 加一個「第1*級」詞，測試準備一級
lexRows.push(['67', '喜歡', '基礎', '第1*級', '', '', '', '', 'ㄒㄧˇ ˙ㄏㄨㄢ', 'xǐhuan']);
function setup(handler, props) {
  const m = makeMocks({ sheets: { 'TBCL詞語': lexRows.map(r => r.slice()), '專名': [['詞語'], ['安娜'], ['小美'], ['士林夜市'], ['法國']], '執行紀錄': [['時間']] },
    props: Object.assign({ SHEET_ID: 'x', ANTHROPIC_API_KEY: 'k', API_TOKEN: 'tok' }, props || {}), fetchHandler: handler });
  return { g: load(FILES, m.globals), m };
}
const segText = body => { const c = body.messages[0].content; return c.slice(c.indexOf('<<<\n') + 4, c.lastIndexOf('\n>>>')); };
const reply = text => ({ body: { stop_reason: 'tool_use', content: [{ type: 'tool_use', input: { revised_text: text, changes: [{ original: '擁擠', revised: '人很多', category: '詞彙', reason: '擁擠 5 級' }], summary: '改寫' } }], usage: { input_tokens: 100, output_tokens: 50 } } });
const fix = t => t.replace(/非常擁擠/g, '人非常多').replace(/擁擠/g, '人多');

// 長文：12 段，每段約 50 字 → 共約 600+ 字，SEGMENT_CHARS=150 → 多段
const para = '夜市裡人很多，非常擁擠。安娜想去買東西，她和朋友一起去夜市。小美說這家很有名。';
const long = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? '' : '') + para).join('\n\n');

// 1) splitSegments_ 往返
let { g, m } = setup(() => reply(''));
for (const t of [long, '　　第一段。\n\n第二段很長' + '很長很長。'.repeat(80) + '\n結尾。\n', '只有一行', '\n\n開頭空行\n']) {
  const segs = g.splitSegments_(t, 150);
  assert.strictEqual(g.joinSegments_(segs), t, 'segments rejoin to original');
}
console.log('split/rejoin OK');

// 2) 分段平行：一次 fetchAll 送出全部段落；第 2 輪只重送沒過的段落
let round = 0;
({ g, m } = setup((url, opt) => { const t = segText(JSON.parse(opt.payload)); return reply(fix(t)); }, { SEGMENT_CHARS: '150' }));
let r = g.uiAdjust({ text: long, target: 3 });
assert.ok(r.ok, r.error);
console.log('segments', r.segments, '| fetchAll batches', JSON.stringify(m.log.batches), '| rounds', r.rounds, '| passed', r.passed);
assert.ok(r.segments >= 3, 'split into several segments');
assert.strictEqual(m.log.batches[0], r.segments, 'round 1 sends all segments in one parallel batch');
assert.ok(!r.revisedText.includes('擁擠'), 'all segments revised');
assert.strictEqual(r.revisedText.split('\n\n').length, long.split('\n\n').length, 'paragraph breaks kept');
assert.strictEqual(r.llm.calls, m.log.fetches.length);

// 2b) 第 1 輪有一段沒改好 → 第 2 輪只重送那一段
let calls2 = 0;
({ g, m } = setup((url, opt) => { calls2++; const t = segText(JSON.parse(opt.payload)); return reply(calls2 === 1 ? t : fix(t)); }, { SEGMENT_CHARS: '150' }));
r = g.uiAdjust({ text: long, target: 3 });
assert.ok(r.ok, r.error);
assert.strictEqual(JSON.stringify(m.log.batches), JSON.stringify([r.segments, 1]), 'round 2 resends only the failing segment');
assert.strictEqual(r.rounds, 2); assert.ok(r.passed);
console.log('round-2 resend OK — batches', JSON.stringify(m.log.batches));

// 3) 部分段落失敗：其他段落照常合併，失敗段保留原文並提出警告
let n = 0;
({ g, m } = setup((url, opt) => { n++; const t = segText(JSON.parse(opt.payload)); return n === 2 ? { code: 400, body: { error: { message: 'bad request' } } } : reply(fix(t)); }, { SEGMENT_CHARS: '150', MAX_ROUNDS: '1' }));
r = g.uiAdjust({ text: long, target: 3 });
assert.ok(r.ok, r.error);
assert.ok(r.warnings.some(w => w.includes('沒有完成') && w.includes('原文')), JSON.stringify(r.warnings));
assert.ok(r.revisedText.includes('擁擠') && r.revisedText.includes('人非常多'), 'mixed: failed segment kept original');
console.log('partial failure OK —', r.warnings[0].slice(0, 60));

// 4) 第 2 輪配額不足：保留第 1 輪結果，不丟掉
const segCount = g.splitSegments_(long, 150).filter(s => s.active).length;
({ g, m } = setup((url, opt) => { const t = segText(JSON.parse(opt.payload)); return reply(t.replace('非常擁擠', '人非常多')); }, { SEGMENT_CHARS: '150', DAILY_LIMIT: String(segCount) }));
r = g.uiAdjust({ text: long + '\n擁擠的地方。', target: 3 });
assert.ok(r.ok, r.error);
assert.strictEqual(r.rounds, 1);
assert.ok(r.warnings.some(w => w.includes('第 2 輪沒有執行')), JSON.stringify(r.warnings));
assert.ok(r.revisedText.includes('人非常多'));
console.log('quota mid-way OK —', r.warnings.find(w => w.includes('第 2 輪')).slice(0, 70));
// 第 1 輪就不夠：直接報錯
({ g, m } = setup(() => reply(''), { SEGMENT_CHARS: '150', DAILY_LIMIT: '1' }));
r = g.uiAdjust({ text: long, target: 3 });
assert.strictEqual(r.ok, false); assert.ok(r.error.includes('需要'), r.error);

// 5) 準備一級：1* 詞視為超綱；準備二級不算
({ g, m } = setup(() => reply('')));
const t5 = '我喜歡她。她喜歡我。';
const n1 = g.uiAnalyze({ text: t5, tocfl: 'N1' }), n2 = g.uiAnalyze({ text: t5, tocfl: 'Novice 2' }), byTarget = g.uiAnalyze({ text: t5, target: 1 });
assert.ok(n1.ok && n2.ok, n1.error || n2.error);
assert.strictEqual(n1.tocfl, 0); assert.strictEqual(n2.tocfl, 1); assert.strictEqual(byTarget.tocfl, 1, 'target 1 alone → Novice 2');
const ab = n1.before.target.above.find(a => a.w === '喜歡');
assert.ok(ab && ab.lvl === '1*', 'N1 flags 1* word');
assert.ok(!n2.before.target.above.some(a => a.w === '喜歡'), 'N2 allows 1* word');
assert.strictEqual(n1.before.target.status, '偏難');
assert.ok(n1.levelLabel.includes('準備一級') && n1.statement.includes('第1*級'));
assert.ok(n1.before.spans.some(s => s.t === '喜歡' && s.ab), 'span marked above for client');
console.log('Novice 1/2 OK —', n1.levelLabel, '|', n1.before.target.effectivePct, 'vs', n2.before.target.effectivePct);

// 6) health：沒有權杖只回 ok
let h = JSON.parse(g.doGet({ parameter: { action: 'health' } }).text);
assert.deepStrictEqual(Object.keys(h), ['ok']);
h = JSON.parse(g.doGet({ parameter: { action: 'health', token: 'tok' } }).text);
assert.ok(h.status && h.status.llm);
console.log('health token OK');

// 7) 說話者：重複出現的名字才算；第一章、注意不算；IVS 選音碼過濾
const A = g.GRAnalyzer, lex = g.getContext_().lex;
const sp = A.analyze('第一章：夜市\n安娜：你好！\n小美：你好！\n安娜：我們去吧。\n注意：明天考試。', { lex }, {}).spans.filter(s => s.k === 's').map(s => s.t);
assert.ok(!sp.includes('第一章：') && !sp.includes('注意：') && sp.filter(x => x === '安娜：').length === 2 && !sp.includes('小美：'), JSON.stringify(sp));
const withIvs = '學\u{E01E1}生';
assert.strictEqual(A.analyze(withIvs, { lex }, {}).spans.map(s => s.t).join(''), '學生');
console.log('speaker + IVS strip OK —', JSON.stringify(sp));
console.log('ALL SEGMENT TESTS PASSED');
