/**
 * Adjust.gs — 機器人主流程：分析 → 改寫 → 再驗證（最多 MAX_ROUNDS 輪）
 *
 * runAnalyzeCore_ / runAdjustCore_ 不直接呼叫 Apps Script 服務（LLM 與配額由 deps 注入），
 * 所以可以在 Node 用假 LLM 測試，也方便日後搬到 Cloud Run 等其他平台。
 */

function normalizeRequest_(req) {
  req = req || {};
  // 目標等級：優先用 TOCFL 八級（tocfl：0–7 或 N1、A2…）；只給 TBCL target 時，第 1 級視為準備二級
  var stop = grParseTocfl(req.tocfl);
  if (stop < 0) {
    var t = parseInt(req.target, 10);
    stop = grStopOfTbcl(t >= 1 && t <= 7 ? t : 3);
  }
  var T = GR_TOCFL[stop];
  return {
    text: GRAnalyzer.stripSelectors(String(req.text || '')).replace(/\r\n?/g, '\n'),
    stop: stop,
    target: T.tbcl,
    strictStar: !!T.strictStar,
    sentLenGuide: T.sentLenGuide || grLevelInfo(T.tbcl).sentLenGuide,
    mode: ['auto', 'down', 'up', 'localize'].indexOf(req.mode) >= 0 ? req.mode : 'auto',
    purpose: GR_PURPOSES[req.purpose] ? req.purpose : 'extensive',
    learner: GR_LEARNERS[req.learner] ? req.learner : 'adult_nonchar',
    protectedWords: String(req.protectedWords || ''),
    known: String(req.known || ''),
    glossary: String(req.glossary || ''),
    notes: String(req.notes || ''),
    stripSpeakers: req.stripSpeakers !== false,
    includeSpans: req.includeSpans !== false,
    includeReport: req.includeReport !== false
  };
}

function analysisOpts_(plan, ctx, extraGlossary) {
  return {
    target: plan.target,
    strictStar: plan.strictStar,
    purpose: plan.purpose,
    threshold: GR_PURPOSES[plan.purpose].threshold,
    glossary: plan.glossary + (extraGlossary && extraGlossary.length ? '\n' + extraGlossary.join('\n') : ''),
    known: plan.known,
    proper: GRAnalyzer.parseWordList(plan.protectedWords).concat(ctx.proper || []),
    stripSpeakers: plan.stripSpeakers,
    sentLenGuide: plan.sentLenGuide
  };
}

/** auto：依估計等級決定降級或升級；localize：同 auto，但一定會修正字形與用語。 */
function decideDirection_(mode, an, target) {
  if (mode === 'down' || mode === 'up') return mode;
  var est = an.estimate;
  if (!an.meta.lexiconLoaded) return 'down';
  if (an.target && an.target.strictStar && an.target.aboveUnglossedTypes) return 'down';
  if (est.level === null) return est.beyond ? 'down' : 'polish';
  if (est.level > target) return 'down';
  if (est.level < target) return 'up';
  return 'polish';
}

function hasNormIssues_(an) {
  return !!(an.norms && (an.norms.simplified.length || an.norms.variants.length || an.norms.terms.length));
}

function maxNewWords_(an) {
  var per100 = parseFloat(typeof prop_ === 'function' ? prop_('MAX_NEW_PER_100', '1') : '1') || 1;
  return Math.max(3, Math.round(an.stats.tokens * per100 / 100));
}

function checkPass_(after, strict, plan, direction, keptCount) {
  var issues = [];
  if (after.meta.lexiconLoaded) {
    var t = after.target;
    if (!t.pass) issues.push('可理解覆蓋率 ' + t.effectivePct + '%，未達 ' + t.threshold + '%');
    var remaining = t.above.filter(function (a) { return !a.glossed; });
    if (remaining.length) issues.push('仍有超綱詞：' + remaining.slice(0, 20).map(function (a) { return a.w + '（' + (a.lvl || a.lv) + '）'; }).join('、'));
    var cap = maxNewWords_(after);
    if (keptCount > cap) issues.push('刻意保留的生詞有 ' + keptCount + ' 個，超過建議上限 ' + cap + ' 個，請再替換一些');
    if (direction === 'up' && strict.estimate.level !== null && strict.estimate.level < plan.target) {
      issues.push('適讀等級估計為第 ' + strict.estimate.level + ' 級，仍低於目標；請多用第 ' + plan.target + ' 級的詞語與句式');
    }
  }
  if (after.norms && after.norms.simplified.length) {
    issues.push('仍有簡體字：' + after.norms.simplified.map(function (s) { return s.c; }).join('、'));
  }
  if (plan.sentLenGuide && after.sentences.mean > plan.sentLenGuide * 1.2) {
    issues.push('平均句長 ' + after.sentences.mean + ' 字，高於建議的 ' + plan.sentLenGuide + ' 字');
  }
  return { pass: issues.length === 0, issues: issues.join('；') };
}

function alignmentStatement_(an, plan, ctx) {
  var T = GR_TOCFL[plan.stop], L = grLevelInfo(plan.target);
  var s = '本文目標為 TOCFL ' + T.name + '（' + T.code + '，CEFR ' + T.cefr + '），對應 TBCL 第 ' + L.level + ' 級（' + L.band + '）';
  s += T.strictStar ? '前段：只用詞表標示「第1級」的詞，「第1*級」詞視為超綱（本工具的區分方式，非官方對應）。' : '。';
  if (an.meta.lexiconLoaded && an.target) {
    var est = an.estimate.level ? '第 ' + an.estimate.level + ' 級' : (an.estimate.beyond ? '高於第 7 級' : '無法估計');
    s += '含生詞後可理解覆蓋率 ' + an.target.effectivePct + '%，適讀等級估計為' + est
       + '（依 ' + (ctx.lexLabel || 'TBCL 詞語表') + '；門檻 ' + an.target.threshold + '%）。';
  } else {
    s += '（推估：尚未載入 TBCL 詞語表，等級未經詞表驗證。）';
  }
  return s + 'TBCL 與 TOCFL 為整體對應，逐技能可能錯開一級；語法與自然度需人工確認。';
}

function baseResult_(action, plan, ctx) {
  return { ok: true, action: action, tocfl: plan.stop, target: plan.target, levelLabel: grTargetLabel(plan.stop),
           purpose: plan.purpose, learner: plan.learner, lexiconLabel: ctx.lexLabel || '', warnings: [] };
}

function runAnalyzeCore_(req, ctx) {
  var plan = normalizeRequest_(req);
  if (!plan.text.trim()) throw new Error('請貼上要分析的文本。');
  if (plan.text.length > GR_CONFIG.defaults.ANALYZE_MAX_CHARS) throw new Error('文本太長（上限 ' + GR_CONFIG.defaults.ANALYZE_MAX_CHARS + ' 字），請分章分析。');
  var an = GRAnalyzer.analyze(plan.text, ctx, analysisOpts_(plan, ctx));
  if (!plan.includeSpans) delete an.spans;
  var direction = decideDirection_(plan.mode, an, plan.target);
  var res = baseResult_('analyze', plan, ctx);
  res.before = an; res.after = an; res.direction = direction; res.directionLabel = GR_DIRECTION_LABEL[direction];
  res.statement = alignmentStatement_(an, plan, ctx);
  if (plan.includeReport) res.report = GRReport.markdown(res);
  return res;
}

// ----------------------------------------------------------------------------- 分段

function hanCount_(s) { return Array.from(s || '').filter(GRAnalyzer.isHan).length; }

/**
 * 依段落切成每段約 maxHan 個漢字的區塊；單一段落過長時依句號切開。
 * 回傳 [{ t, glue }]，glue 是該區塊後面接的分隔（'\n' 或 ''），全部接回去等於原文。
 */
function splitSegments_(text, maxHan) {
  var out = [], cur = [], curN = 0;
  var flush = function () { if (cur.length) { out.push({ t: cur.join('\n'), glue: '\n' }); cur = []; curN = 0; } };
  text.split('\n').forEach(function (line) {
    var n = hanCount_(line);
    if (n > maxHan) {
      flush();
      var parts = line.match(/[^。！？!?…]+[。！？!?…]*[」』）)"]*/g) || [line];
      if (parts.join('') !== line) parts = [line];
      var buf = '', bn = 0;
      parts.forEach(function (p) {
        var pn = hanCount_(p);
        if (buf && bn + pn > maxHan) { out.push({ t: buf, glue: '' }); buf = ''; bn = 0; }
        buf += p; bn += pn;
      });
      out.push({ t: buf, glue: '\n' });
      return;
    }
    if (cur.length && curN + n > maxHan) flush();
    cur.push(line); curN += n;
  });
  flush();
  if (out.length) out[out.length - 1].glue = '';
  return out.map(function (s) {
    var lead = /^[\s　]*/.exec(s.t)[0], trail = /[\s　]*$/.exec(s.t.slice(lead.length))[0];
    return { lead: lead, core: s.t.slice(lead.length, s.t.length - trail.length), trail: trail, glue: s.glue,
             active: hanCount_(s.t) > 0 };
  });
}

function joinSegments_(segs) {
  return segs.map(function (s) { return s.lead + s.core + s.trail + s.glue; }).join('');
}

/**
 * deps = { callLlmBatch(system, users[], tool) → [{ok, data, provider, model, inputTokens, outputTokens} | {ok:false, error}],
 *          consumeQuota(n), maxRounds, maxChars, segmentChars }
 */
function runAdjustCore_(req, ctx, deps) {
  var plan = normalizeRequest_(req);
  if (!plan.text.trim()) throw new Error('請貼上要調整的文本。');
  var opts = analysisOpts_(plan, ctx);
  var before = GRAnalyzer.analyze(plan.text, ctx, opts);
  if (before.stats.hanChars > deps.maxChars) {
    throw new Error('文本有 ' + before.stats.hanChars + ' 個漢字，超過單次調整上限 ' + deps.maxChars + ' 字。長篇讀本請分章調整（分析功能不受此限）。');
  }
  var direction = decideDirection_(plan.mode, before, plan.target);
  var res = baseResult_('adjust', plan, ctx);
  Object.assign(res, {
    direction: direction, directionLabel: GR_DIRECTION_LABEL[direction],
    before: before, after: before, revisedText: plan.text, rounds: 0, segments: 0, passed: false,
    verified: before.meta.lexiconLoaded, issues: '', changes: [], glossary: [], grammarNotes: [],
    summary: '', llm: { provider: '', model: '', calls: 0, inputTokens: 0, outputTokens: 0 }
  });

  // 已合級又沒有規範問題：不呼叫 LLM，省下費用
  var first = checkPass_(before, before, plan, direction, 0);
  if (direction === 'polish' && first.pass && !hasNormIssues_(before) && plan.mode !== 'localize') {
    res.passed = res.verified;
    res.summary = '文本已符合目標等級，沒有偵測到字形或用語問題，因此未呼叫 LLM。';
    return finishAdjust_(res, plan, ctx);
  }

  var segs = splitSegments_(plan.text, Math.max(150, deps.segmentChars || 600));
  var active = [];
  segs.forEach(function (s, i) { if (s.active) active.push(i); });
  res.segments = active.length;
  var kept = {}, summaries = [], segIssues = {};
  var keptIn = function (text) { return Object.keys(kept).filter(function (w) { return text.indexOf(w) >= 0; }); };
  var segCheck = function (i) {
    var t = segs[i].core;
    var a = GRAnalyzer.analyze(t, ctx, Object.assign(analysisOpts_(plan, ctx, keptIn(t)), { withSpans: false }));
    var st = GRAnalyzer.analyze(t, ctx, Object.assign({}, opts, { withSpans: false }));
    return { an: a, check: checkPass_(a, st, plan, direction, 0) };
  };

  var todo = active.slice(), draft = plan.text, current = before;
  var maxRounds = Math.max(1, deps.maxRounds || 1);
  while (res.rounds < maxRounds && todo.length) {
    try {
      deps.consumeQuota(todo.length);
    } catch (e) {
      if (res.rounds === 0) throw e;
      res.warnings.push('第 ' + (res.rounds + 1) + ' 輪沒有執行（' + e.message + '），保留第 ' + res.rounds + ' 輪的修訂稿。');
      break;
    }
    res.rounds++;
    var round = res.rounds;
    var users = todo.map(function (i) {
      var t = segs[i].core;
      var segAn = GRAnalyzer.analyze(t, ctx, Object.assign(analysisOpts_(plan, ctx, keptIn(t)), { withSpans: false }));
      return buildUserPrompt_(t, segAn, {
        stop: plan.stop, target: plan.target, strictStar: plan.strictStar, sentLenGuide: plan.sentLenGuide,
        direction: direction, purpose: plan.purpose, learner: plan.learner,
        protectedWords: plan.protectedWords, known: plan.known, glossary: plan.glossary, notes: plan.notes,
        round: round, prevIssues: segIssues[i] || '', segIndex: active.indexOf(i), segCount: active.length
      }, ctx);
    });
    var outs = deps.callLlmBatch(GR_SYSTEM_PROMPT, users, GR_REVISION_TOOL);
    var okCount = 0, fails = [];
    outs.forEach(function (out, k) {
      var i = todo[k], seg = segs[i];
      res.llm.calls++;
      if (!out || !out.ok) { fails.push((out && out.error) || 'LLM 沒有回應'); return; }
      var d = out.data || {};
      var revised = String(d.revised_text || '').replace(/\r\n?/g, '\n').trim();
      if (!revised) { fails.push('模型沒有回傳修訂稿'); return; }
      okCount++;
      (d.changes || []).forEach(function (c) {
        res.changes.push({ round: round, segment: active.indexOf(i) + 1, original: String(c.original || ''), revised: String(c.revised || ''),
                           category: String(c.category || '其他'), reason: String(c.reason || ''),
                           located: seg.core.indexOf(String(c.original || '')) >= 0 });
      });
      (d.kept_above_level || []).forEach(function (kw) { if (kw && kw.word) kept[String(kw.word).trim()] = kw; });
      (d.grammar_notes || []).forEach(function (g) {
        if (g && g.point && !res.grammarNotes.some(function (x) { return x.point === g.point; })) res.grammarNotes.push(g);
      });
      if (d.summary && round === 1) summaries.push(String(d.summary));
      seg.core = revised;
      res.llm.provider = out.provider; res.llm.model = out.model;
      res.llm.inputTokens += out.inputTokens || 0; res.llm.outputTokens += out.outputTokens || 0;
    });
    if (!okCount && round === 1) throw new Error(fails[0] || 'LLM 沒有回傳修訂稿。');
    if (fails.length) {
      var uniqFails = fails.filter(function (f, k) { return fails.indexOf(f) === k; });
      res.warnings.push('第 ' + round + ' 輪有 ' + fails.length + ' 段沒有完成，該段保留' + (round === 1 ? '原文' : '上一版') + '：' + uniqFails.slice(0, 2).join('；'));
    }

    // 合併後整篇驗證
    draft = joinSegments_(segs);
    var keptWords = keptIn(draft);
    var strict = GRAnalyzer.analyze(draft, ctx, Object.assign({}, opts, { withSpans: false }));
    current = GRAnalyzer.analyze(draft, ctx, analysisOpts_(plan, ctx, keptWords));
    current.strict = { effectivePct: strict.target.effectivePct, estimate: strict.estimate.level, beyond: strict.estimate.beyond };
    var keptAbove = keptWords.filter(function (w) {
      return current.target.above.some(function (a) { return a.w === w; }) || !(ctx.lex && ctx.lex.map[w]);
    });
    var check = checkPass_(current, strict, plan, direction, keptAbove.length);
    res.passed = res.verified && check.pass;
    res.issues = check.issues;
    if (check.pass) break;

    // 下一輪只重送沒過的段落；若每段單看都過、但整篇沒過（例如保留生詞太多），就全部重送
    todo = active.filter(function (i) {
      var c = segCheck(i).check;
      segIssues[i] = c.issues;
      return !c.pass;
    });
    if (!todo.length) {
      todo = active.slice();
      active.forEach(function (i) { segIssues[i] = check.issues; });
    }
  }

  res.after = current;
  res.revisedText = draft;
  res.summary = summaries.join(' ');
  res.glossary = buildGlossary_(current, kept, plan, ctx, draft);
  var ratio = before.stats.hanChars ? current.stats.hanChars / before.stats.hanChars : 1;
  if (ratio < 0.6) res.warnings.push('修訂稿篇幅只有原文的 ' + Math.round(ratio * 100) + '%，請確認沒有刪掉情節。');
  var lost = res.changes.filter(function (c) { return !c.located; }).length;
  if (lost) res.warnings.push('有 ' + lost + ' 條修訂紀錄的「原文」在待修改文本中找不到（模型轉述或合併了句子），請對照修訂稿確認。');
  if (!res.verified) res.warnings.push('尚未載入 TBCL 詞語表：修訂結果沒有經過詞表驗證，等級一律為推估。');
  else if (!res.passed) res.warnings.push('已改寫 ' + res.rounds + ' 輪，仍未完全通過驗證：' + res.issues + '。可加入生詞或保留詞後再調整一次，或人工修改。');
  return finishAdjust_(res, plan, ctx);
}

function finishAdjust_(res, plan, ctx) {
  res.statement = alignmentStatement_(res.after, plan, ctx);
  if (!plan.includeSpans) { delete res.before.spans; if (res.after) delete res.after.spans; }
  if (plan.includeReport) res.report = GRReport.markdown(res);
  return res;
}

/** 建議生詞表：修訂稿中仍超出目標級的詞＋模型刻意保留的詞。拼音、注音只取 TBCL 詞表的參考欄位。 */
function buildGlossary_(an, kept, plan, ctx, text) {
  var out = [], seen = {}, userGloss = {};
  GRAnalyzer.parseWordList(plan.glossary).forEach(function (w) { userGloss[w] = true; });
  (an.target ? an.target.above : []).forEach(function (a) {
    var k = kept[a.w] || {};
    seen[a.w] = true;
    out.push({ w: a.w, lv: a.lv, lvl: a.lvl, n: a.n, py: a.py || '', zy: a.zy || '', pos: k.pos || '', en: k.english || '',
               reason: k.reason || '', source: k.word ? '模型保留' : (userGloss[a.w] ? '生詞表' : '未處理') });
  });
  // 模型保留、但詞表未收錄的詞（例如新詞、地方小吃）
  Object.keys(kept).forEach(function (w) {
    if (seen[w]) return;
    var e = ctx.lex && ctx.lex.map[w];
    if (e && (e.l < plan.target || (e.l === plan.target && !(plan.strictStar && e.s)))) return;   // 其實沒有超綱，不必列
    var count = 0, i = -1;
    while ((i = text.indexOf(w, i + 1)) >= 0) count++;
    if (!count) return;                             // 修訂稿裡已經沒有這個詞
    var k = kept[w];
    out.push({ w: w, lv: e ? e.l : null, lvl: e ? (e.s && plan.strictStar ? e.l + '*' : String(e.l)) : '', n: count, py: e ? e.p : '', zy: e ? e.z : '', pos: k.pos || '', en: k.english || '',
               reason: k.reason || '', source: '模型保留' });
  });
  return out.sort(function (a, b) { return (b.lv || 8) - (a.lv || 8) || b.n - a.n; });
}
