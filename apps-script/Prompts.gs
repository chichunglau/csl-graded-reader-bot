/**
 * Prompts.gs — 提示詞與結構化輸出格式
 *
 * 設計重點：等級判斷由程式（TBCL 詞表）負責，LLM 只負責「改寫」；改完再交回程式驗證。
 * 所以提示詞裡的等級資訊全部來自自動檢核，並要求模型不要自行宣稱 TBCL 等級。
 */

var GR_SYSTEM_PROMPT = [
  '你是臺灣華語分級讀本的編修專家，熟悉國家教育研究院「臺灣華語文能力基準」（TBCL，三等七級）與華語文能力測驗（TOCFL）。',
  '你的工作是把讀本文本調整到指定的 TBCL 等級，讓該級學習者能順暢閱讀，同時保持故事好看、語言自然。',
  '',
  '工作原則',
  '1. 最小必要修改：保留情節、人物、事件順序、觀點與作者語氣。調整的是語言難度與規範，不是另寫一個故事。',
  '2. 超綱詞依序處理：(a) 換成目標級以內、意思相同的詞；(b) 改寫句子避開；(c) 對主題不可或缺的詞保留，列入 kept_above_level 並說明理由（讀本會把它列為生詞，請讓它在文中出現兩三次以上）；(d) 「不得更動的詞」一律不改。',
  '3. 語法：使用目標級以內的句式。必要的高級結構當作固定說法，並寫進 grammar_notes。',
  '4. 句長與篇章：符合目標級的文本類型與建議句長；長句拆短，但避免連續使用「然後」。降級時可把抽象描寫改成具體動作、感官細節或對話。',
  '5. 升級時：不改變情節，加入目標級的詞語、連接詞與複句，增加細節；不要使用高於目標級的詞。',
  '6. 自然度：改完的句子要像臺灣人會說、會寫的話。不要為了避開某個詞寫出生硬的句子；對話保留「喔」「好啊」「真的嗎？」這類自然回應。',
  '7. 臺灣規範：正體字（教育部標準字形）、臺灣用語（計程車、捷運、軟體、品質、便當……）、不用兒化，全形標點，引號用「」，內層用『』。',
  '8. 不加入會過期的具體資訊（票價、時刻、法規），不加入原文沒有的文化斷言。',
  '9. 保留原文的段落數、段落順序與換行；對話體保留說話者標籤。',
  '10. 等級資訊只能引用本訊息提供的自動檢核結果；其他等級判斷一律寫「推估」。不要自創 TBCL 能力指標代碼。',
  '11. 不論使用者介面是哪一種語言，revised_text、changes、grammar_notes、summary 一律以臺灣正體中文撰寫；只有 kept_above_level 的 english 欄位寫英譯。',
  '',
  '修訂紀錄 changes：每一處修改寫一條。original 必須是「待修改文本」中逐字存在的片段；revised 是修改後片段；',
  'category 從「詞彙、語法、句長、用語、字形、自然度、內容、其他」擇一；reason 用一句話說明，例如「擁擠為第 5 級（依詞表），改用第 1 級的『人很多』」。',
  '完成後呼叫 submit_revision 工具提交，不要另外輸出文字。'
].join('\n');

var GR_REVISION_TOOL = {
  name: 'submit_revision',
  description: '提交調整後的完整讀本文本、修訂紀錄、刻意保留的超綱詞與語法說明。',
  schema: {
    type: 'object',
    properties: {
      revised_text: { type: 'string', description: '調整後的完整文本，保留原文段落與換行。' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            original: { type: 'string' },
            revised: { type: 'string' },
            category: { type: 'string', enum: ['詞彙', '語法', '句長', '用語', '字形', '自然度', '內容', '其他'] },
            reason: { type: 'string' }
          },
          required: ['original', 'revised', 'category', 'reason']
        }
      },
      kept_above_level: {
        type: 'array',
        description: '刻意保留、將列為生詞的超綱詞。',
        items: {
          type: 'object',
          properties: {
            word: { type: 'string' },
            reason: { type: 'string' },
            pos: { type: 'string', description: '詞類（鄧守信教學語法體系，如 N、V、Vs、Adv）；不確定可留空。' },
            english: { type: 'string', description: '簡短英譯' }
          },
          required: ['word', 'reason']
        }
      },
      grammar_notes: {
        type: 'array',
        description: '文本中可能超出目標級、或值得教師注意的語法點。',
        items: {
          type: 'object',
          properties: {
            point: { type: 'string' },
            example: { type: 'string', description: '修訂稿中的例句' },
            note: { type: 'string' }
          },
          required: ['point', 'example']
        }
      },
      summary: { type: 'string', description: '兩三句話說明這次調整的重點。' }
    },
    required: ['revised_text', 'changes', 'summary']
  }
};

var GR_DIRECTION_LABEL = { down: '降級', up: '升級', polish: '維持等級，只修正規範與自然度' };

/**
 * 組出使用者訊息。
 *  draft：待修改文本（第 1 輪是原文，第 2 輪起是上一版）
 *  an：draft 的自動檢核結果
 *  plan：{ target, direction, purpose, learner, protected, known, glossary, notes, round, prevIssues }
 */
function buildUserPrompt_(draft, an, plan, ctx) {
  var L = grLevelInfo(plan.target);
  var P = GR_PURPOSES[plan.purpose] || GR_PURPOSES.extensive;
  var lines = [];
  var est = an.estimate;
  var estText = est.level ? '第 ' + est.level + ' 級' : (est.beyond ? '高於第 7 級（或未收錄詞過多）' : '無法估計');

  lines.push('【目標】' + grLevelLabel(plan.target));
  lines.push('- 本級學習者能力：' + L.performance);
  lines.push('- 文本類型：' + L.textType);
  if (L.sentLenGuide) lines.push('- 建議平均句長：' + L.sentLenGuide + ' 字以內（編者經驗值）');
  lines.push('- 用途：' + P.label + '，可理解覆蓋率目標 ≥' + Math.round(P.threshold * 100) + '%');
  lines.push('- 學習者：' + (GR_LEARNERS[plan.learner] || GR_LEARNERS.adult_nonchar));
  lines.push('- 調整方向：' + GR_DIRECTION_LABEL[plan.direction] + '（目前估計適讀等級：' + estText + '）');
  lines.push('');

  if (an.meta.lexiconLoaded) {
    lines.push('【自動檢核結果】（依 ' + (ctx.lexLabel || 'TBCL 詞語表') + '）');
    lines.push('- 目標級以內詞次覆蓋率 ' + an.target.withinPct + '%；含生詞、已學詞、專名後可理解覆蓋率 ' + an.target.effectivePct + '%');
    var must = an.target.above.filter(function (a) { return !a.glossed; });
    if (must.length) {
      lines.push('- 必須處理的超綱詞（詞／TBCL 級／次數）：' + must.map(function (a) { return a.w + '／' + a.lv + '／' + a.n; }).join('、'));
    } else {
      lines.push('- 沒有未處理的超綱詞。');
    }
    var kept = an.target.above.filter(function (a) { return a.glossed; });
    if (kept.length) lines.push('- 超綱但已列為生詞或保留詞（可以保留）：' + kept.map(function (a) { return a.w + '（' + a.lv + '）'; }).join('、'));
    if (an.oov.length) lines.push('- 詞表未收錄的片段（可能是超綱詞、專名或錯字，請自行判斷）：' + an.oov.slice(0, 30).map(function (o) { return o.w; }).join('、'));
    if (plan.direction === 'up') {
      lines.push('- 第 ' + plan.target + ' 級詞語目前佔 ' + an.target.targetLevelShare + '% 詞次；請多用第 ' + plan.target + ' 級的詞語與句式。');
    }
  } else {
    lines.push('【自動檢核結果】尚未載入 TBCL 詞表，無法提供逐詞等級。請依你對 TBCL 第 ' + plan.target + ' 級的理解調整，所有等級說明都寫「推估」。');
  }
  if (an.sentences.overLong && an.sentences.overLong.length) {
    lines.push('- 過長的句子（請拆短）：' + an.sentences.overLong.slice(0, 8).map(function (s) { return '「' + s.text + '」（' + s.len + ' 字）'; }).join('；'));
  }
  lines.push('- 目前平均句長 ' + an.sentences.mean + ' 字，最長 ' + an.sentences.max + ' 字。');
  if (an.norms) {
    if (an.norms.simplified.length) lines.push('- 疑似簡體字（改為正體，注意一簡多繁）：' + an.norms.simplified.map(function (s) { return s.c; }).join('、'));
    if (an.norms.variants.length) lines.push('- 非標準字形：' + an.norms.variants.map(function (v) { return v.c + '→' + v.to; }).join('、'));
    if (an.norms.terms.length) lines.push('- 大陸用語候選（依語境確認後改成臺灣說法）：' + an.norms.terms.map(function (t) { return t.form + '→' + t.tw; }).join('、'));
  }
  lines.push('');

  var protectedWords = GRAnalyzer.parseWordList(plan.protectedWords).concat(ctx.proper || []);
  if (protectedWords.length) lines.push('【不得更動的詞】' + uniq_(protectedWords).slice(0, 200).join('、'));
  var known = GRAnalyzer.parseWordList(plan.known);
  if (known.length) lines.push('【學習者已學、可以使用的詞】' + known.slice(0, 400).join('、'));
  var gloss = GRAnalyzer.parseWordList(plan.glossary);
  if (gloss.length) lines.push('【本書生詞（可以保留）】' + gloss.slice(0, 200).join('、'));
  if (ctx.grammar && ctx.grammar.length) {
    var g = ctx.grammar.filter(function (x) { return x.l <= plan.target; });
    var near = g.filter(function (x) { return x.l >= plan.target - 1; });
    if (near.length) lines.push('【第 ' + Math.max(1, plan.target - 1) + '–' + plan.target + ' 級可用語法點（TBCL 語法點表）】' + near.slice(0, 250).map(function (x) { return x.name; }).join('、'));
  }
  if (plan.notes) lines.push('【教師補充指示】' + String(plan.notes).slice(0, 1000));

  if (plan.round > 1 && plan.prevIssues) {
    lines.push('');
    lines.push('【第 ' + plan.round + ' 輪】上一版的自動驗證仍未通過：' + plan.prevIssues);
    lines.push('請在上一版（下方「待修改文本」）的基礎上繼續修改，只改有問題的地方；changes 只記錄這一輪的修改。');
  }

  lines.push('');
  lines.push('待修改文本：');
  lines.push('<<<');
  lines.push(draft);
  lines.push('>>>');
  return lines.join('\n');
}

function uniq_(arr) {
  var seen = {}, out = [];
  arr.forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } });
  return out;
}
