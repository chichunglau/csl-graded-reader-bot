const fs = require('fs'), assert = require('assert');
const load = require('./load_gs');
const g = load(['Assets.gs', 'Levels.gs', 'Analyzer.gs']);
const A = g.GRAnalyzer;
// 簡易 CSV（無引號欄位）
const rows = fs.readFileSync(__dirname + '/fixtures/demo_lexicon.csv', 'utf8').trim().split('\n').map(l => l.split(','));
const lex = A.buildLeveled(rows, 'word');
const norms = A.prepareNorms(g.GR_ASSETS, []);
const text = fs.readFileSync(__dirname + '/fixtures/sample.txt', 'utf8');
const proper = fs.readFileSync(__dirname + '/fixtures/proper.txt', 'utf8');
const r = A.analyze(text, { lex, norms, lexLabel: 'demo' }, { target: 3, proper, sentLenGuide: 13, stripSpeakers: false });
const py = JSON.parse(fs.readFileSync(__dirname + '/fixtures/py.json', 'utf8'));

console.log('forms', lex.forms, 'entries', lex.entries, 'maxLen', lex.maxLen);
console.log('tokens', r.stats.tokens, 'py', py.tokens, '| hanChars', r.stats.hanChars, 'py', py.han_chars);
console.log('levelDist', r.levelDist.map(d => d.tokens).join(','), 'py', JSON.stringify(py.level_tokens));
console.log('within', r.target.withinPct, 'py', (py.coverage_within_target * 100).toFixed(1));
console.log('effective', r.target.effectivePct, 'py', (py.coverage_effective * 100).toFixed(1));
console.log('estimate', JSON.stringify(r.estimate));
console.log('status', r.target.status, '| above', r.target.above.map(a => a.w + a.lv + ':' + a.py).join(' '));
console.log('oov', JSON.stringify(r.oov.map(o => o.w)), 'py', JSON.stringify(py.oov));
console.log('terms', JSON.stringify(r.norms.terms.map(t => t.term + '→' + t.tw)), '| simp', JSON.stringify(r.norms.simplified));
console.log('sentences', JSON.stringify({ c: r.sentences.count, mean: r.sentences.mean, max: r.sentences.max, over: r.sentences.overLong.length }));
console.log('warnings', r.warnings);
console.log('spans sample', JSON.stringify(r.spans.slice(0, 12)));

// 與 Python 版一致性
assert.strictEqual(r.stats.tokens, py.tokens);
assert.strictEqual(r.stats.hanChars, py.han_chars);
for (const [k, v] of Object.entries(py.level_tokens)) assert.strictEqual(r.levelDist[+k - 1].tokens, v, 'level ' + k);
// 第一 現視為數詞（Python 版當未收錄），所以只比對 TBCL 各級與詞次
assert.strictEqual(r.target.withinPct, +(py.coverage_within_target * 100).toFixed(1));
// spans 還原原文
const rebuilt = r.spans.map(s => s.t).join('');
assert.strictEqual(rebuilt, text.replace(/\r\n?/g, '\n'));
// 詞表解析細節
assert.strictEqual(JSON.stringify(A.expandEntry('車子/車').sort()), JSON.stringify(['車', '車子']));
assert.strictEqual(JSON.stringify(A.expandEntry('哪(兒)').sort()), JSON.stringify(['哪', '哪兒']));
assert.strictEqual(A.parseLevel('第1*級'), 1);
assert.strictEqual(lex.map['車'].p, 'chē'); assert.strictEqual(lex.map['車子'].p, 'chēzi');
// 序列化往返
const back = A.parseSerialized(A.serializeLeveled(lex));
assert.strictEqual(back.forms, lex.forms); assert.strictEqual(back.map['琳瑯滿目'].l, 7);
// 無詞表時不當機
const r0 = A.analyze(text, { norms }, { target: 3 });
assert.strictEqual(r0.meta.lexiconLoaded, false); assert.strictEqual(r0.estimate.level, null);
console.log('ALL OK');
// 多音字 IVS：依 TBCL 參考漢語拼音選音
const g2 = load(['Assets.gs', 'Levels.gs', 'Analyzer.gs', 'Phonetics.gs']);
const B = g2.GRAnalyzer, phonic = B.preparePhonic(g2.GR_PHONIC, g2.GR_PY_SYLLABLES);
console.log('phonic chars', Object.keys(phonic).length, '了', JSON.stringify(phonic['了']), '地', JSON.stringify(phonic['地']));
const syl = phonic.__syl;
assert.strictEqual(JSON.stringify(B.splitPinyin('xuéshēng', 2, syl)), JSON.stringify(['xué', 'shēng']));
assert.strictEqual(JSON.stringify(B.splitPinyin("Xī'ān", 2, syl)), JSON.stringify(['xī', 'ān']));
assert.strictEqual(JSON.stringify(B.splitPinyin('zhēnzhū nǎichá', 4, syl)), JSON.stringify(['zhēn', 'zhū', 'nǎi', 'chá']));
assert.strictEqual(JSON.stringify(B.splitPinyin('nǚrén', 2, syl)), JSON.stringify(['nǚ', 'rén']));
assert.strictEqual(B.splitPinyin('xué', 3, syl), null);
const lx2 = B.buildLeveled([['詞語', '級別', '參考漢語拼音'], ['了', '第1級', 'le'], ['慢慢', '第2級', 'mànmàn'], ['地', '第2級', 'de'],
  ['走', '第1級', 'zǒu'], ['地方', '第2級', 'dìfang'], ['睡著', '第3級', 'shuìzháo'], ['長大', '第2級', 'zhǎngdà']], 'word');
const r2 = B.analyze('他慢慢地走了。這個地方。他睡著了。長大了。', { lex: lx2, phonic }, { target: 2 });
const vs = s => Array.from(s).filter(c => c.codePointAt(0) >= 0xE01E0).map(c => (c.codePointAt(0) - 0xE01E0)).join(',');
const ivSpans = r2.spans.filter(s => s.iv).map(s => s.t + ':' + vs(s.iv));
console.log('iv spans', ivSpans.join(' '));
assert.ok(ivSpans.includes('地:1'), '地 de → index 1');
assert.ok(!r2.spans.some(s => s.t === '了' && s.iv), '了 le → 預設讀音，不加選擇器');
assert.ok(ivSpans.includes('地方:1'), '地方 → 方 fang index 1');
assert.ok(ivSpans.includes('睡著:3'), '睡著 → 著 zháo index 3');
assert.ok(ivSpans.includes('長大:1'), '長大 → 長 zhǎng index 1');
assert.strictEqual(r2.spans.map(s => s.t).join(''), '他慢慢地走了。這個地方。他睡著了。長大了。');
console.log('IVS OK');
