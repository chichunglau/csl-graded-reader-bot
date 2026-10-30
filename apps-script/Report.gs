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
