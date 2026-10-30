/**
 * Llm.gs — 可替換的 LLM 介面（支援平行批次）
 *
 * Apps Script 的 UrlFetchApp 單一請求約 60 秒就會中斷（不可調整），所以長文改成「分段＋平行」：
 * Adjust.gs 把一章切成約 600 字的段落，這裡用 UrlFetchApp.fetchAll 同時送出，每段都在 60 秒內完成。
 *
 * 每個供應商只要提供兩個函式：
 *   build(system, user, tool, model) → { url, headers, body }
 *   parse(json)                      → { data, inputTokens, outputTokens }（格式不符時 throw）
 * 對外：
 *   callLlmBatch_(system, users[], tool) → [{ ok, data, provider, model, inputTokens, outputTokens } | { ok:false, error }]
 *   callLlmJson_(system, user, tool)     → 單一請求，失敗時 throw
 *
 * 狀態：anthropic 依 Claude API 2026-10-21 版文件撰寫；openai、gemini、custom 為預留，未實測。
 */

var GR_PROVIDERS_ = {
  anthropic: {
    build: function (system, user, tool, model) {
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': prop_('ANTHROPIC_API_KEY'), 'anthropic-version': GR_CONFIG.defaults.ANTHROPIC_VERSION },
        body: {
          model: model, max_tokens: propInt_('LLM_MAX_TOKENS'), system: system,
          messages: [{ role: 'user', content: user }],
          tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
          tool_choice: { type: 'tool', name: tool.name }
        }
      };
    },
    parse: function (res) {
      if (res.stop_reason === 'max_tokens') throw new Error('模型輸出被截斷（達到 LLM_MAX_TOKENS）。請調小 SEGMENT_CHARS 或調高 LLM_MAX_TOKENS。');
      var block = (res.content || []).filter(function (b) { return b.type === 'tool_use'; })[0];
      if (!block || !block.input) throw new Error('模型沒有回傳結構化結果（stop_reason=' + res.stop_reason + '）。');
      var u = res.usage || {};
      return { data: block.input, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 };
    }
  },

  // 預留：OpenAI 相容（Chat Completions＋JSON 模式）
  openai: {
    build: function (system, user, tool, model) {
      return {
        url: String(prop_('OPENAI_BASE_URL')).replace(/\/+$/, '') + '/chat/completions',
        headers: { Authorization: 'Bearer ' + prop_('OPENAI_API_KEY') },
        body: { model: model, max_tokens: propInt_('LLM_MAX_TOKENS'), response_format: { type: 'json_object' },
                messages: [{ role: 'system', content: system + jsonInstruction_(tool) }, { role: 'user', content: user }] }
      };
    },
    parse: function (res) {
      var msg = res.choices && res.choices[0] && res.choices[0].message;
      if (!msg || !msg.content) throw new Error('OpenAI 回應格式不符。');
      var u = res.usage || {};
      return { data: parseJsonLoose_(msg.content), inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 };
    }
  },

  // 預留：Gemini（generateContent＋JSON 回應）
  gemini: {
    build: function (system, user, tool, model) {
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
        headers: { 'x-goog-api-key': prop_('GEMINI_API_KEY') },
        body: { systemInstruction: { parts: [{ text: system + jsonInstruction_(tool) }] },
                contents: [{ role: 'user', parts: [{ text: user }] }],
                generationConfig: { responseMimeType: 'application/json', maxOutputTokens: propInt_('LLM_MAX_TOKENS') } }
      };
    },
    parse: function (res) {
      var c = res.candidates && res.candidates[0];
      var text = c && c.content && c.content.parts && c.content.parts.map(function (p) { return p.text || ''; }).join('');
      if (!text) throw new Error('Gemini 回應格式不符（finishReason=' + (c && c.finishReason) + '）。');
      var u = res.usageMetadata || {};
      return { data: parseJsonLoose_(text), inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0 };
    }
  },

  /**
   * 預留：自訂端點（學校自建服務、Cloud Run 代理、校內模型）
   *   POST CUSTOM_LLM_URL，Authorization: Bearer CUSTOM_LLM_TOKEN（有設定才送）
   *   { "system": "...", "user": "...", "tool": { "name": "...", "schema": {...} } }
   * 回應：{ "data": {...符合 schema...}, "usage": { "input_tokens": 0, "output_tokens": 0 } }
   */
  custom: {
    build: function (system, user, tool) {
      var token = prop_('CUSTOM_LLM_TOKEN', '');
      return { url: prop_('CUSTOM_LLM_URL'), headers: token ? { Authorization: 'Bearer ' + token } : {},
               body: { system: system, user: user, tool: { name: tool.name, schema: tool.schema } } };
    },
    parse: function (res) {
      var u = res.usage || {};
      return { data: res.data || res, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 };
    }
  }
};

function llmStatus_() {
  var p = String(prop_('LLM_PROVIDER')).toLowerCase();
  var need = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', custom: 'CUSTOM_LLM_URL' }[p];
  var model = { anthropic: prop_('ANTHROPIC_MODEL'), openai: prop_('OPENAI_MODEL', ''), gemini: prop_('GEMINI_MODEL', ''), custom: 'custom' }[p] || '';
  var configured = !!(need && prop_(need, '')) && !!model;
  return { provider: p, model: model, configured: configured,
           hint: configured ? '' : (p === 'none' ? '已關閉 LLM，只提供分析。'
                 : '請在指令碼屬性設定 ' + (need || 'LLM_PROVIDER') + (model ? '' : ' 與模型名稱') + '。') };
}

/** 同時送出多個請求；每個結果各自成功或失敗，不會因一段失敗而全部失敗。 */
function callLlmBatch_(system, users, tool) {
  var st = llmStatus_();
  if (!st.configured) throw new Error('尚未設定 LLM：' + st.hint);
  var prov = GR_PROVIDERS_[st.provider];
  if (!prov) throw new Error('不支援的 LLM_PROVIDER：' + st.provider);
  var reqs = users.map(function (u) { return prov.build(system, u, tool, st.model); });
  return httpJsonBatch_(reqs).map(function (r) {
    if (!r.ok) return { ok: false, error: r.error };
    try {
      var out = prov.parse(r.json);
      out.ok = true; out.provider = st.provider; out.model = st.model;
      return out;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function callLlmJson_(system, user, tool) {
  var r = callLlmBatch_(system, [user], tool)[0];
  if (!r.ok) throw new Error(r.error);
  return r;
}

// ----------------------------------------------------------------------------- 共用

function jsonInstruction_(tool) {
  return '\n\n請只輸出一個 JSON 物件，不要加任何說明或 Markdown 標記。JSON 必須符合以下 JSON Schema：\n'
       + JSON.stringify(tool.schema);
}

/** 容忍 ```json 包裝或前後雜訊的 JSON 解析。 */
function parseJsonLoose_(text) {
  var s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch (e) {}
  var a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('模型回傳的不是有效的 JSON。');
}

/**
 * 平行 POST JSON：[{url, headers, body}] → [{ ok, json } | { ok:false, error }]。
 * 429／5xx／529 與連線失敗會整批重試最多 2 次（只重送失敗的請求）。錯誤訊息不含金鑰。
 */
function httpJsonBatch_(reqs) {
  var retryable = { 408: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1, 529: 1 };
  var results = reqs.map(function () { return null; });
  var pending = reqs.map(function (_, i) { return i; });
  for (var attempt = 0; attempt < 3 && pending.length; attempt++) {
    if (attempt) Utilities.sleep(2000 * Math.pow(2, attempt - 1));
    var resps;
    try {
      resps = UrlFetchApp.fetchAll(pending.map(function (i) {
        var q = reqs[i];
        return { url: q.url, method: 'post', contentType: 'application/json', headers: q.headers,
                 payload: JSON.stringify(q.body), muteHttpExceptions: true, followRedirects: true };
      }));
    } catch (e) {
      // 整批連線失敗（含約 60 秒逾時）：記下錯誤，下一輪重試
      var msg = /timeout|timed out|逾時/i.test(e.message) ? '連線逾時（單次請求約 60 秒上限），請調小 SEGMENT_CHARS 或改用較快的模型' : '連線失敗：' + e.message;
      pending.forEach(function (i) { results[i] = { ok: false, error: 'LLM 服務錯誤（' + msg + '）', retry: true }; });
      continue;
    }
    var next = [];
    pending.forEach(function (i, k) {
      var resp = resps[k], code = resp.getResponseCode(), text = resp.getContentText();
      if (code >= 200 && code < 300) {
        try { results[i] = { ok: true, json: JSON.parse(text) }; } catch (e) { results[i] = { ok: false, error: 'LLM 回應不是 JSON。' }; }
        return;
      }
      var detail = text;
      try { var j = JSON.parse(text); detail = (j.error && (j.error.message || j.error.type)) || j.message || text; } catch (e) {}
      results[i] = { ok: false, error: 'LLM 服務錯誤（HTTP ' + code + '：' + String(detail).slice(0, 300) + '）' };
      if (retryable[code]) next.push(i);
    });
    pending = next;
  }
  return results.map(function (r) { return r ? { ok: r.ok, json: r.json, error: r.error } : { ok: false, error: 'LLM 沒有回應。' }; });
}
