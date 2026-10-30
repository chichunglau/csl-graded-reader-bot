/**
 * Analyzer.gs — TBCL 分級檢核引擎
 *
 * 純 JavaScript，不呼叫任何 Apps Script 服務，所以同一份程式可以在 Apps Script、瀏覽器與 Node 執行。
 * 方法移植自 taiwan-huayu-materials 技能的 level_profiler.py：
 *   - 斷詞：詞典雙向最大匹配，詞典＝TBCL ∪ 生詞 ∪ 已學詞 ∪ 專名／保留詞；
 *   - 統計：TBCL 等級分布、目標級覆蓋率、可理解覆蓋率、超綱詞、未收錄片段、漢字等級、句長；
 *   - 規範：疑似簡體字、非標準字形、大陸用語候選。
 * 限制：只檢核詞彙、漢字、句長與用語候選；語法點、語意、自然度交給 LLM 與人工判斷。
 */
var GRAnalyzer = (function () {
  'use strict';

  var HAN_RE = /[\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{20000}-\u{3134F}\u{3007}]/u;
  var SENT_END = /[。！？；!?;…\n]+/;
  var SPEAKER_RE = /^[ \t　]*[A-Za-z㐀-鿿]{1,6}[ \t]*[：:][ \t　]*/;
  var NUMERAL_RE = /^第?[〇零一二三四五六七八九十百千萬億兩幾]+$/;
  var BAND = { 1: '基礎', 2: '基礎', 3: '基礎', 4: '進階', 5: '進階', 6: '精熟', 7: '精熟' };
  var FW_DIGITS = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9' };
  var CN_DIGITS = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };

  function isHan(ch) { return HAN_RE.test(ch); }
  function chars(s) { return Array.from(s || ''); }
  function hanCount(s) { var n = 0; chars(s).forEach(function (c) { if (isHan(c)) n++; }); return n; }
  function round1(x) { return Math.round(x * 1000) / 10; }   // 0.9734 → 97.3
  function dict() { return Object.create(null); }

  // --------------------------------------------------------------------------- 詞表解析

  /** '第1級' '第1*級' '1' 'Level 3' '七' → 1..7；認不出回傳 null。 */
  function parseLevel(s) {
    if (s === null || s === undefined || s === '') return null;
    if (typeof s === 'number') return s >= 1 && s <= 9 ? Math.floor(s) : null;
    var t = String(s).replace(/[０-９]/g, function (c) { return FW_DIGITS[c]; })
                     .replace(/[一二三四五六七八九]/g, function (c) { return CN_DIGITS[c]; });
    var m = /(\d+)/.exec(t);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return n >= 1 && n <= 9 ? n : null;
  }

  /** 「車子/車」→ 車子、車；「中1」→ 中；「哪(兒)」→ 哪、哪兒。 */
  function expandEntry(raw) {
    var out = dict();
    var s = String(raw === null || raw === undefined ? '' : raw).trim().replace(/　/g, ' ');
    s.split(/[／\/、]/).forEach(function (part) {
      part = part.replace(/\s+/g, '').replace(/[0-9０-９*＊]+$/, '');
      if (!part) return;
      var stack = [part];
      while (stack.length) {
        var p = stack.pop();
        var m = /[（(]([^）)]*)[）)]/.exec(p);
        if (m) {
          stack.push(p.slice(0, m.index) + m[1] + p.slice(m.index + m[0].length));
          stack.push(p.slice(0, m.index) + p.slice(m.index + m[0].length));
        } else if (p) {
          out[p] = true;
        }
      }
    });
    return Object.keys(out);
  }

  function findCol(header, keys, avoid) {
    avoid = avoid || [];
    for (var k = 0; k < keys.length; k++) {
      for (var i = 0; i < header.length; i++) {
        var h = String(header[i] || '').trim().toLowerCase();
        if (h.indexOf(keys[k]) >= 0 && !avoid.some(function (a) { return h.indexOf(a) >= 0; })) return i;
      }
    }
    return -1;
  }

  /**
   * 由二維陣列（試算表 getValues() 或 CSV 解析結果）建立分級詞典。
   * 支援國教院詞語表（序號,詞語,等別,級別,情境,…,參考注音,參考漢語拼音）或兩欄「詞語,級別」。
   * kind: 'word'（詞語表）或 'char'（漢字表）。
   * 回傳 { map: {詞形: {l, p, z}}, entries, forms, maxLen }；同一詞形取最低等級。
   */
  function buildLeveled(rows, kind) {
    var res = { map: dict(), entries: 0, forms: 0, maxLen: 1 };
    rows = (rows || []).filter(function (r) { return r && r.some(function (c) { return String(c).trim() !== ''; }); });
    if (!rows.length) return res;
    var header = rows[0].map(function (c) { return String(c); });
    var wordKeys = kind === 'char' ? ['漢字', '汉字', 'hanzi', 'character', '字'] : ['詞語', '词语', 'word', '詞彙', '词汇', '詞'];
    var wordAvoid = kind === 'char' ? ['頻', '频', '序', '詞', '词'] : ['頻', '频', '序'];
    var wi = findCol(header, wordKeys, wordAvoid);
    var li = findCol(header, ['級別', '级别', '等級', '等级', 'level', '級', '级']);
    var pi = findCol(header, ['參考漢語拼音', '漢語拼音', '汉语拼音', '拼音', 'pinyin']);
    var zi = findCol(header, ['參考注音', '注音', 'zhuyin', 'bopomofo']);
    var start = 1;
    if (wi < 0 || li < 0) {
      wi = 0; li = 1; pi = -1; zi = -1;
      start = parseLevel(rows[0][1]) !== null ? 0 : 1;
    }
    var map = res.map;
    for (var r = start; r < rows.length; r++) {
      var row = rows[r];
      var lvl = parseLevel(row[li]);
      if (lvl === null || lvl > 7) continue;
      res.entries++;
      var forms = kind === 'char' ? chars(String(row[wi] || '').trim()).filter(isHan) : expandEntry(row[wi]);
      var pys = pi >= 0 ? String(row[pi] || '').split(/[／\/]/) : [];
      var zys = zi >= 0 ? String(row[zi] || '').split(/[／\/]/) : [];
      var parts = String(row[wi] || '').split(/[／\/、]/);
      forms.forEach(function (f) {
        // 詞形與拼音數量一致時逐一對齊（車子/車 ↔ chēzi/chē），否則保留整欄
        var idx = -1;
        for (var k = 0; k < parts.length; k++) if (expandEntry(parts[k]).indexOf(f) >= 0) { idx = k; break; }
        var p = pys.length === parts.length && idx >= 0 ? pys[idx] : pys.join('/');
        var z = zys.length === parts.length && idx >= 0 ? zys[idx] : zys.join('/');
        var old = map[f];
        if (!old || lvl < old.l) map[f] = { l: lvl, p: String(p || '').trim(), z: String(z || '').trim() };
      });
    }
    var keys = Object.keys(map);
    res.forms = keys.length;
    res.maxLen = Math.min(12, keys.reduce(function (m, w) { return Math.max(m, chars(w).length); }, 1));
    return res;
  }

  /** 壓縮成「詞\t級\t拼音\t注音」行，方便放進快取。 */
  function serializeLeveled(lx) {
    var lines = [lx.entries + '\t' + lx.maxLen];
    Object.keys(lx.map).forEach(function (w) {
      var v = lx.map[w];
      lines.push(w + '\t' + v.l + '\t' + (v.p || '') + '\t' + (v.z || ''));
    });
    return lines.join('\n');
  }

  function parseSerialized(str) {
    var res = { map: dict(), entries: 0, forms: 0, maxLen: 1 };
    if (!str) return res;
    var lines = str.split('\n');
    var head = lines[0].split('\t');
    res.entries = parseInt(head[0], 10) || 0;
    res.maxLen = parseInt(head[1], 10) || 1;
    for (var i = 1; i < lines.length; i++) {
      var c = lines[i].split('\t');
      if (c[0]) res.map[c[0]] = { l: parseInt(c[1], 10), p: c[2] || '', z: c[3] || '' };
    }
    res.forms = Object.keys(res.map).length;
    return res;
  }

  /** 每行一詞、或以逗號／頓號／空白分隔的清單 → 詞形陣列。 */
  function parseWordList(input) {
    if (!input) return [];
    var items = Array.isArray(input) ? input : String(input).split(/[\n,，;；\s]+/);
    var out = dict();
    items.forEach(function (it) {
      var s = Array.isArray(it) ? it[0] : it;
      s = String(s === null || s === undefined ? '' : s).trim();
      if (!s || s.charAt(0) === '#') return;
      expandEntry(s).forEach(function (f) { out[f] = true; });
    });
    return Object.keys(out);
  }

  // --------------------------------------------------------------------------- 字形與用語資源

  function parseTsv(str) {
    return String(str || '').split('\n').filter(function (l) { return l.trim() && l.charAt(0) !== '#'; })
      .map(function (l) { return l.split('\t'); });
  }

  /**
   * 準備字形與用語資源。extraTerms：試算表「用語對照」的列 [大陸用詞, 臺灣用詞, 備註]，會覆蓋內建條目。
   */
  function prepareNorms(assets, extraTerms) {
    var t2s = dict();
    parseTsv(assets.t2s).forEach(function (r) { if (r.length >= 2) t2s[r[0]] = r[1].split('|'); });
    var shared = dict();
    chars(String(assets.sharedChars || '').replace(/\s/g, '')).forEach(function (c) { shared[c] = true; });
    var simpOnly = dict();
    Object.keys(t2s).forEach(function (t) {
      t2s[t].forEach(function (s) { if (s !== t && !shared[s] && !t2s[s]) simpOnly[s] = true; });
    });
    var variants = dict();
    parseTsv(assets.variants).forEach(function (r) { if (r.length >= 2) variants[r[0]] = { to: r[1], note: r[2] || '' }; });
    var terms = dict();
    parseTsv(assets.cnTwTerms).concat(extraTerms || []).forEach(function (r) {
      var cn = String(r[0] || '').trim();
      if (cn && r[1]) terms[cn] = { tw: String(r[1]).trim(), note: String(r[2] || '').trim() };
    });
    // 同時比對簡體字形（未轉換的大陸教材），結果歸回正體條目
    var forms = dict();
    Object.keys(terms).forEach(function (t) {
      [t].concat(simplifiedVariants(t, t2s, 8)).forEach(function (f) { if (!(f in forms)) forms[f] = t; });
    });
    return { t2s: t2s, simpOnly: simpOnly, variants: variants, terms: terms, termForms: forms };
  }

  function simplifiedVariants(word, t2s, limit) {
    var acc = [''];
    chars(word).forEach(function (ch) {
      var opts = t2s[ch] || [ch];
      var next = [];
      acc.forEach(function (a) { opts.forEach(function (o) { next.push(a + o); }); });
      acc = next.slice(0, limit);
    });
    return acc;
  }

  function findTerms(text, forms) {
    var hits = dict();
    var taken = new Array(text.length);
    Object.keys(forms).sort(function (a, b) { return b.length - a.length; }).forEach(function (f) {
      var start = 0;
      while (true) {
        var i = text.indexOf(f, start);
        if (i < 0) break;
        var free = true;
        for (var k = i; k < i + f.length; k++) if (taken[k]) { free = false; break; }
        if (free) {
          hits[f] = (hits[f] || 0) + 1;
          for (var j = i; j < i + f.length; j++) taken[j] = true;
        }
        start = i + 1;
      }
    });
    return hits;
  }

  function contextOf(text, needle, width) {
    width = width || 12;
    var i = text.indexOf(needle);
    if (i < 0) return '';
    return text.slice(Math.max(0, i - width), Math.min(text.length, i + needle.length + width)).replace(/\n/g, ' ');
  }

  // --------------------------------------------------------------------------- 多音字（ToneOZ IVS）

  /** GR_PHONIC 字串 → { 字: [讀音0, 讀音1, …] }（讀音存成「無調拼音＋數字調」，例如 le5、xue2）。 */
  function preparePhonic(str, syllables) {
    var map = dict();
    String(str || '').split('\n').forEach(function (ln) {
      var cs = chars(ln);
      if (cs.length > 1) map[cs[0]] = cs.slice(1).join('').split(',').map(function (p) { return pySyl(p); });
    });
    var syl = dict();
    String(syllables || '').split(/\s+/).forEach(function (x) { if (x) syl[x] = true; });
    Object.defineProperty(map, '__syl', { value: syl, enumerable: false });
    return map;
  }

  var TONE = { 'ā': 'a1', 'á': 'a2', 'ǎ': 'a3', 'à': 'a4', 'ē': 'e1', 'é': 'e2', 'ě': 'e3', 'è': 'e4',
               'ī': 'i1', 'í': 'i2', 'ǐ': 'i3', 'ì': 'i4', 'ō': 'o1', 'ó': 'o2', 'ǒ': 'o3', 'ò': 'o4',
               'ū': 'u1', 'ú': 'u2', 'ǔ': 'u3', 'ù': 'u4', 'ǖ': 'v1', 'ǘ': 'v2', 'ǚ': 'v3', 'ǜ': 'v4', 'ü': 'v0' };

  /** 帶調號的單一音節 → 「無調拼音＋數字調」：xué → xue2、de → de5。 */
  function pySyl(p) {
    var base = '', tone = 5;
    chars(String(p || '').toLowerCase().normalize('NFC').replace(/u:/g, 'ü')).forEach(function (c) {
      var m = TONE[c];
      if (m) { base += m.charAt(0); if (m.charAt(1) !== '0') tone = +m.charAt(1); }
      else if (/[a-z]/.test(c)) base += c;
    });
    return base ? base + tone : '';
  }

  /** 把整個詞的拼音切成 n 個音節（先依空白、撇號、連字號，再依合法音節表切分連寫）。切不出剛好 n 個時回傳 null。 */
  function splitPinyin(py, n, syl) {
    var chunks = String(py || '').toLowerCase().normalize('NFC').replace(/u:/g, 'ü').split(/[\s'’‘\-·]+/).filter(Boolean);
    var segs = chunks.map(function (ch) {
      var cs = chars(ch).filter(function (c) { return TONE[c] || /[a-z]/.test(c); });
      var base = cs.map(function (c) { return TONE[c] ? TONE[c].charAt(0) : c; }).join('');
      var out = [], memo = dict();
      (function walk(i, acc) {
        if (out.length > 8) return;
        if (i === base.length) { out.push(acc.slice()); return; }
        for (var L = Math.min(6, base.length - i); L > 0; L--) {
          if (!syl[base.slice(i, i + L)]) continue;
          acc.push(cs.slice(i, i + L).join('')); walk(i + L, acc); acc.pop();
        }
      })(0, []);
      return out;
    });
    var result = null;
    (function pick(k, acc) {
      if (result) return;
      if (k === segs.length) { if (acc.length === n) result = acc.slice(); return; }
      segs[k].forEach(function (s) { if (acc.length + s.length <= n) pick(k + 1, acc.concat(s)); });
    })(0, []);
    return result;
  }

  /**
   * 依 TBCL 參考漢語拼音為詞中的多音字加上 IVS 選擇器。
   * ToneOZ／注音 IVS 規格：字本身＝預設讀音（第 0 個）；字＋U+E01E0＋i（i ≥ 1）＝第 i 個讀音；
   * 字＋U+E01E0 單獨使用＝不顯示標音，所以預設讀音不加任何選擇器。
   * 拼音切不出與字數相同的音節數，或不需要選音時回傳 null。
   */
  function ivsFor(word, pinyin, phonic) {
    if (!pinyin || !phonic) return null;
    var cs = chars(word);
    var syl = splitPinyin(String(pinyin).split(/[\/／]/)[0], cs.length, phonic.__syl || dict());
    if (!syl) return null;
    var out = '', changed = false;
    for (var i = 0; i < cs.length; i++) {
      out += cs[i];
      var list = phonic[cs[i]];
      if (!list) continue;
      var idx = list.indexOf(pySyl(syl[i]));
      if (idx > 0) { out += String.fromCodePoint(0xE01E0 + idx); changed = true; }
    }
    return changed ? out : null;
  }

  // --------------------------------------------------------------------------- 斷詞

  function Segmenter(has, maxLen) {
    this.has = has;
    this.maxLen = Math.max(1, maxLen || 1);
  }
  Segmenter.prototype.fmm = function (cs) {
    var i = 0, out = [], n = cs.length;
    while (i < n) {
      for (var L = Math.min(this.maxLen, n - i); L > 0; L--) {
        var w = cs.slice(i, i + L).join('');
        if (L === 1 || this.has(w)) { out.push(w); i += L; break; }
      }
    }
    return out;
  };
  Segmenter.prototype.bmm = function (cs) {
    var j = cs.length, out = [];
    while (j > 0) {
      for (var L = Math.min(this.maxLen, j); L > 0; L--) {
        var w = cs.slice(j - L, j).join('');
        if (L === 1 || this.has(w)) { out.push(w); j -= L; break; }
      }
    }
    return out.reverse();
  };
  Segmenter.prototype.score = function (seg) {
    var self = this, oov = 0, singles = 0;
    seg.forEach(function (w) { if (!self.has(w)) oov++; if (chars(w).length === 1) singles++; });
    return [seg.length, oov, singles];
  };
  Segmenter.prototype.cut = function (run) {
    var cs = chars(run);
    var f = this.fmm(cs), b = this.bmm(cs);
    if (f.join('|') === b.join('|')) return f;
    var sf = this.score(f), sb = this.score(b);
    for (var i = 0; i < 3; i++) { if (sf[i] !== sb[i]) return sf[i] < sb[i] ? f : b; }
    return f;
  };

  // --------------------------------------------------------------------------- 主分析

  /**
   * analyze(text, ctx, opts)
   *  ctx  = { lex, chars, norms, phonic, lexLabel }（lex/chars 為 buildLeveled 結果，norms 為 prepareNorms 結果，phonic 為 preparePhonic 結果，可省略）
   *  opts = { target, purpose('extensive'|'intensive'), threshold, glossary, known, proper,
   *           stripSpeakers(預設 true), sentLenGuide, top(預設 60), withSpans(預設 true) }
   */
  function analyze(text, ctx, opts) {
    opts = opts || {};
    ctx = ctx || {};
    text = String(text || '').replace(/\r\n?/g, '\n');
    var lexMap = ctx.lex && ctx.lex.map ? ctx.lex.map : dict();
    var lexLoaded = !!(ctx.lex && ctx.lex.forms > 0);
    var top = opts.top || 60;
    var threshold = opts.threshold || (opts.purpose === 'intensive' ? 0.95 : 0.98);
    var target = opts.target ? parseInt(opts.target, 10) : null;

    var glossary = setOf(parseWordList(opts.glossary));
    var known = setOf(parseWordList(opts.known));
    var proper = setOf(parseWordList(opts.proper));
    var maxLen = Math.max(ctx.lex ? ctx.lex.maxLen : 1, maxLenOf(glossary), maxLenOf(known), maxLenOf(proper));
    var has = function (w) { return !!(lexMap[w] || glossary[w] || known[w] || proper[w]); };
    var seg = new Segmenter(has, Math.min(maxLen, 12));

    // ---- 逐行切出 spans：w=TBCL 詞、g=生詞、k=已學詞、p=專名／保留、n=數詞、o=未收錄、x=非漢字、s=說話者標籤
    var spans = [];
    var body = [];          // 去除說話者標籤後的文本（計算句長、用語）
    text.split('\n').forEach(function (line, li) {
      if (li > 0) { spans.push({ t: '\n', k: 'x' }); body.push('\n'); }
      if (opts.stripSpeakers !== false) {
        var m = SPEAKER_RE.exec(line);
        if (m && line.charAt(m[0].length) !== '「' && m[0].length < line.length) {
          spans.push({ t: m[0], k: 's' });
          line = line.slice(m[0].length);
        }
      }
      body.push(line);
      var cs = chars(line), buf = '', bufHan = null;
      var flush = function () {
        if (!buf) return;
        if (bufHan) segmentRun(buf); else spans.push({ t: buf, k: 'x' });
        buf = '';
      };
      cs.forEach(function (c) {
        var h = isHan(c);
        if (bufHan !== null && h !== bufHan) flush();
        bufHan = h; buf += c;
      });
      flush();
    });

    function segmentRun(run) {
      var oov = '';
      var pushOov = function () {
        if (!oov) return;
        spans.push({ t: oov, k: NUMERAL_RE.test(oov) ? 'n' : 'o' });
        oov = '';
      };
      seg.cut(run).forEach(function (w) {
        if (!has(w)) { oov += w; return; }
        pushOov();
        if (lexMap[w]) {
          var sp = { t: w, k: 'w', l: lexMap[w].l, gl: !!(glossary[w] || known[w] || proper[w]) };
          var iv = ctx.phonic ? ivsFor(w, lexMap[w].p, ctx.phonic) : null;
          if (iv) sp.iv = iv;                       // ToneOZ 字型用：含多音字選擇器的字串
          spans.push(sp);
        }
        else if (glossary[w]) spans.push({ t: w, k: 'g' });
        else if (known[w]) spans.push({ t: w, k: 'k' });
        else spans.push({ t: w, k: 'p' });
      });
      pushOov();
    }

    var bodyText = body.join('');
    var toks = spans.filter(function (s) { return 'wgkpno'.indexOf(s.k) >= 0; });
    var nTok = toks.length;
    var hanTotal = hanCount(bodyText);

    // ---- 句長
    var sents = bodyText.split(SENT_END).filter(function (s) { return hanCount(s) > 0; });
    var lens = sents.map(hanCount);
    var guide = opts.sentLenGuide || null;
    var longCut = guide ? Math.ceil(guide * 1.8) : null;
    var sentStats = {
      count: lens.length,
      mean: lens.length ? Math.round(10 * lens.reduce(sum, 0) / lens.length) / 10 : 0,
      median: median(lens),
      max: lens.length ? Math.max.apply(null, lens) : 0,
      guide: guide,
      longest: sents.map(function (s, i) { return { len: lens[i], text: s.trim() }; })
        .sort(function (a, b) { return b.len - a.len; }).slice(0, 5),
      overLong: longCut ? sents.map(function (s, i) { return { len: lens[i], text: s.trim() }; })
        .filter(function (x) { return x.len > longCut; }) : []
    };

    // ---- 等級分布
    var byLv = {}, byLvType = {}, cat = { g: 0, k: 0, p: 0, n: 0, o: 0 }, catType = { g: dict(), k: dict(), p: dict(), n: dict(), o: dict() };
    for (var lv = 1; lv <= 7; lv++) { byLv[lv] = 0; byLvType[lv] = dict(); }
    toks.forEach(function (s) {
      if (s.k === 'w') { byLv[s.l]++; byLvType[s.l][s.t] = (byLvType[s.l][s.t] || 0) + 1; }
      else { cat[s.k]++; catType[s.k][s.t] = (catType[s.k][s.t] || 0) + 1; }
    });
    var support = cat.g + cat.k + cat.p + cat.n;
    var dist = [], cum = 0;
    for (lv = 1; lv <= 7; lv++) {
      cum += byLv[lv];
      dist.push({ level: lv, band: BAND[lv], tokens: byLv[lv], pct: nTok ? round1(byLv[lv] / nTok) : 0,
                  cumPct: nTok ? round1(cum / nTok) : 0, types: Object.keys(byLvType[lv]).length });
    }

    // ---- 適讀等級估計：最小的 L，使「≤L 級詞＋生詞／已學／專名／數詞」覆蓋率 ≥ 門檻
    var curve = [], est = null, acc = 0;
    for (lv = 1; lv <= 7; lv++) {
      acc += byLv[lv];
      var cov = nTok ? (acc + support) / nTok : 0;
      curve.push({ level: lv, cov: round1(cov) });
      if (est === null && cov >= threshold) est = lv;
    }
    var oovPct = nTok ? cat.o / nTok : 0;
    var estimate = {
      level: lexLoaded && nTok ? est : null,
      threshold: round1(threshold),
      curve: curve,
      beyond: lexLoaded && nTok && est === null,
      reliable: lexLoaded && oovPct <= 0.05,
      oovPct: round1(oovPct)
    };

    var result = {
      meta: { lexiconLoaded: lexLoaded, lexiconLabel: ctx.lexLabel || '', lexiconForms: ctx.lex ? ctx.lex.forms : 0,
              charsLoaded: !!(ctx.chars && ctx.chars.forms), estimated: !lexLoaded },
      stats: { hanChars: hanTotal, tokens: nTok, types: Object.keys(toks.reduce(function (m, s) { m[s.t] = 1; return m; }, {})).length },
      sentences: sentStats,
      levelDist: dist,
      support: { glossary: cat.g, known: cat.k, proper: cat.p, numerals: cat.n },
      oov: topList(catType.o, top).map(function (x) { return { w: x[0], n: x[1], ctx: contextOf(bodyText, x[0]) }; }),
      estimate: estimate,
      warnings: []
    };
    if (!lexLoaded) result.warnings.push('尚未載入 TBCL 詞語表：等級統計無法計算，所有等級判斷都只能「推估」。請在試算表「TBCL詞語」分頁匯入國教院詞語表。');
    else if (!estimate.reliable) result.warnings.push('未收錄片段約佔 ' + estimate.oovPct + '%，等級估計可能偏高。人名、地名、店名請加入「專名／保留詞」後重跑。');

    // ---- 目標等級檢核
    if (target) {
      var within = 0;
      for (lv = 1; lv <= target; lv++) within += byLv[lv];
      var above = dict();
      toks.forEach(function (s) {
        if (s.k === 'w' && s.l > target) {
          if (!above[s.t]) above[s.t] = { w: s.t, lv: s.l, n: 0, glossed: s.gl };
          above[s.t].n++;
        }
      });
      var aboveList = Object.keys(above).map(function (w) {
        var a = above[w], e = lexMap[w] || {};
        a.ctx = contextOf(bodyText, w); a.py = e.p || ''; a.zy = e.z || '';
        return a;
      }).sort(function (a, b) { return b.lv - a.lv || b.n - a.n; });
      var unglossed = aboveList.filter(function (a) { return !a.glossed; });
      var glossedTok = aboveList.filter(function (a) { return a.glossed; }).reduce(function (m, a) { return m + a.n; }, 0);
      var unglossedTok = unglossed.reduce(function (m, a) { return m + a.n; }, 0);
      var effective = nTok ? (within + support + glossedTok) / nTok : 0;
      var status = estimate.level === null ? (estimate.beyond ? '偏難' : '無法判定')
                 : estimate.level > target ? '偏難' : estimate.level < target ? '偏易' : '合級';
      result.target = {
        level: target,
        withinPct: nTok ? round1(within / nTok) : 0,
        effectivePct: round1(effective),
        threshold: round1(threshold),
        pass: lexLoaded && effective >= threshold,
        status: lexLoaded ? status : '無法判定',
        verdict: effective >= 0.98 ? '≥98%：適合泛讀、分級讀本、測驗閱讀文本'
               : effective >= 0.95 ? '95–98%：適合教師帶領的精讀課文'
               : '<95%：對目標等級偏難，先處理「超綱且未列生詞」',
        aboveTypes: aboveList.length,
        aboveUnglossedTypes: unglossed.length,
        aboveUnglossedTokens: unglossedTok,
        newWordsPer100: nTok ? Math.round(1000 * unglossedTok / nTok) / 10 : 0,
        above: aboveList.slice(0, top),
        singleUse: unglossed.filter(function (a) { return a.n === 1; }).map(function (a) { return a.w; }).slice(0, top),
        targetLevelShare: nTok ? round1(byLv[target] / nTok) : 0
      };
    }

    // ---- 漢字等級（選用）
    if (ctx.chars && ctx.chars.forms) {
      var cmap = ctx.chars.map, ccount = dict(), cLv = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }, notIn = dict(), nNot = 0;
      chars(bodyText).forEach(function (c) { if (isHan(c)) ccount[c] = (ccount[c] || 0) + 1; });
      Object.keys(ccount).forEach(function (c) {
        if (cmap[c]) cLv[cmap[c].l] += ccount[c]; else { notIn[c] = ccount[c]; nNot += ccount[c]; }
      });
      result.chars = {
        dist: Object.keys(cLv).map(function (k) { return { level: +k, n: cLv[k], pct: hanTotal ? round1(cLv[k] / hanTotal) : 0 }; }),
        notInList: Object.keys(notIn),
        notInCount: nNot,
        above: target ? Object.keys(ccount).filter(function (c) { return cmap[c] && cmap[c].l > target; })
          .map(function (c) { return { c: c, lv: cmap[c].l, n: ccount[c] }; }).sort(function (a, b) { return b.lv - a.lv; }) : []
      };
    }

    // ---- 字形與用語
    if (ctx.norms) {
      var nm = ctx.norms, simp = dict(), vars = dict();
      chars(bodyText).forEach(function (c) {
        if (nm.variants[c]) vars[c] = (vars[c] || 0) + 1;
        else if (nm.simpOnly[c]) simp[c] = (simp[c] || 0) + 1;
      });
      var raw = findTerms(bodyText, nm.termForms), termHits = dict();
      Object.keys(raw).forEach(function (f) {
        var t = nm.termForms[f];
        if (!termHits[t]) termHits[t] = { term: t, form: f, n: 0, tw: nm.terms[t].tw, note: nm.terms[t].note };
        termHits[t].n += raw[f];
      });
      var simpN = Object.keys(simp).reduce(function (m, c) { return m + simp[c]; }, 0);
      result.norms = {
        simplified: topList(simp, top).map(function (x) { return { c: x[0], n: x[1] }; }),
        simplifiedPct: hanTotal ? round1(simpN / hanTotal) : 0,
        variants: topList(vars, top).map(function (x) { return { c: x[0], n: x[1], to: nm.variants[x[0]].to, note: nm.variants[x[0]].note }; }),
        terms: Object.keys(termHits).map(function (t) { var h = termHits[t]; h.ctx = contextOf(bodyText, h.form); return h; })
          .sort(function (a, b) { return b.n - a.n; })
      };
      if (hanTotal && simpN / hanTotal > 0.05) {
        result.warnings.unshift('文本約 ' + result.norms.simplifiedPct + '% 為簡體字。TBCL 詞表是正體，轉成正體前等級統計不可靠。');
      }
    }

    if (opts.withSpans !== false) result.spans = mergeSpans(spans);
    return result;
  }

  // --------------------------------------------------------------------------- 工具

  function setOf(arr) { var s = dict(); arr.forEach(function (w) { s[w] = true; }); return s; }
  function maxLenOf(s) { return Object.keys(s).reduce(function (m, w) { return Math.max(m, chars(w).length); }, 1); }
  function sum(a, b) { return a + b; }
  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }
  function topList(counter, n) {
    return Object.keys(counter).map(function (k) { return [k, counter[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n);
  }
  /** 相鄰的非漢字片段合併，縮小傳給前端的資料量。 */
  function mergeSpans(spans) {
    var out = [];
    spans.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && last.k === 'x' && s.k === 'x') last.t += s.t; else out.push(s);
    });
    return out;
  }

  return {
    parseLevel: parseLevel,
    expandEntry: expandEntry,
    buildLeveled: buildLeveled,
    serializeLeveled: serializeLeveled,
    parseSerialized: parseSerialized,
    parseWordList: parseWordList,
    prepareNorms: prepareNorms,
    preparePhonic: preparePhonic,
    ivsFor: ivsFor,
    splitPinyin: splitPinyin,
    pySyl: pySyl,
    analyze: analyze,
    Segmenter: Segmenter,
    isHan: isHan
  };
})();

if (typeof module !== 'undefined') module.exports = GRAnalyzer;
