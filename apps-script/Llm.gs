/**
 * Llm.gs — 可替換的 LLM 介面
 *
 * 所有供應商都實作同一個合約：
 *   callLlmJson_(system, user, tool) → { data: <符合 tool.schema 的物件>, provider, model, inputTokens, outputTokens }
 * 要換模型或接學校自己的服務，只要改指令碼屬性 LLM_PROVIDER，或在下方 PROVIDERS 加一個函式。
 *
 * 狀態：
 *   anthropic  依 Claude API 2026-10-21 版文件撰寫（強制工具呼叫，保證回傳結構化 JSON）。
 *   openai     預留：Chat Completions＋JSON 模式。模型名稱請依官方文件填 OPENAI_MODEL。
 *   gemini     預留：generateContent＋JSON 回應。模型名稱請依官方文件填 GEMINI_MODEL。
 *   custom     預留：POST {system, user, tool} 到 CUSTOM_LLM_URL，回傳 {data, usage?}。
 */

var GR_PROVIDERS_ = {
  anthropic: callAnthropic_,
  openai: callOpenAI_,
  gemini: callGemini_,
  custom: callCustom_
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

function callLlmJson_(system, user, tool) {
  var st = llmStatus_();
  if (!st.configured) throw new Error('尚未設定 LLM：' + st.hint);
  var fn = GR_PROVIDERS_[st.provider];
  if (!fn) throw new Error('不支援的 LLM_PROVIDER：' + st.provider);
  var out = fn(system, user, tool, st.model);
  out.provider = st.provider;
  out.model = st.model;
  return out;
}

// ----------------------------------------------------------------------------- Claude（預設）

function callAnthropic_(system, user, tool, model) {
  var body = {
    model: model,
    max_tokens: propInt_('LLM_MAX_TOKENS'),
    system: system,
    messages: [{ role: 'user', content: user }],
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
    tool_choice: { type: 'tool', name: tool.name }
  };
  var res = httpJson_('https://api.anthropic.com/v1/messages', {
    'x-api-key': prop_('ANTHROPIC_API_KEY'),
    'anthropic-version': GR_CONFIG.defaults.ANTHROPIC_VERSION
  }, body);
  if (res.stop_reason === 'max_tokens') {
    throw new Error('模型輸出被截斷（達到 LLM_MAX_TOKENS）。請縮短文本、分章處理，或調高 LLM_MAX_TOKENS。');
  }
  var block = (res.content || []).filter(function (b) { return b.type === 'tool_use'; })[0];
  if (!block || !block.input) throw new Error('模型沒有回傳結構化結果（stop_reason=' + res.stop_reason + '）。');
  var u = res.usage || {};
  return { data: block.input, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 };
}

// ----------------------------------------------------------------------------- 預留：OpenAI 相容

function callOpenAI_(system, user, tool, model) {
  var base = String(prop_('OPENAI_BASE_URL')).replace(/\/+$/, '');
  var res = httpJson_(base + '/chat/completions', { Authorization: 'Bearer ' + prop_('OPENAI_API_KEY') }, {
    model: model,
    max_tokens: propInt_('LLM_MAX_TOKENS'),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system + jsonInstruction_(tool) },
      { role: 'user', content: user }
    ]
  });
  var msg = res.choices && res.choices[0] && res.choices[0].message;
  if (!msg || !msg.content) throw new Error('OpenAI 回應格式不符。');
  var u = res.usage || {};
  return { data: parseJsonLoose_(msg.content), inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 };
}

// ----------------------------------------------------------------------------- 預留：Gemini

function callGemini_(system, user, tool, model) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  var res = httpJson_(url, { 'x-goog-api-key': prop_('GEMINI_API_KEY') }, {
    systemInstruction: { parts: [{ text: system + jsonInstruction_(tool) }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: propInt_('LLM_MAX_TOKENS') }
  });
  var c = res.candidates && res.candidates[0];
  var text = c && c.content && c.content.parts && c.content.parts.map(function (p) { return p.text || ''; }).join('');
  if (!text) throw new Error('Gemini 回應格式不符（finishReason=' + (c && c.finishReason) + '）。');
  var u = res.usageMetadata || {};
  return { data: parseJsonLoose_(text), inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0 };
}

// ----------------------------------------------------------------------------- 預留：自訂端點

/**
 * 自訂端點合約（學校自建服務、Cloud Run 代理、校內模型都可以）：
 *   POST CUSTOM_LLM_URL
 *   Authorization: Bearer CUSTOM_LLM_TOKEN（有設定才送）
 *   { "system": "...", "user": "...", "tool": { "name": "...", "schema": {...} } }
 * 回應：{ "data": {...符合 schema...}, "usage": { "input_tokens": 0, "output_tokens": 0 } }
 */
function callCustom_(system, user, tool) {
  var token = prop_('CUSTOM_LLM_TOKEN', '');
  var res = httpJson_(prop_('CUSTOM_LLM_URL'), token ? { Authorization: 'Bearer ' + token } : {}, {
    system: system, user: user, tool: { name: tool.name, schema: tool.schema }
  });
  var data = res.data || res;
  var u = res.usage || {};
  return { data: data, inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 };
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

/** POST JSON；遇到 429／5xx／529 自動退避重試。錯誤訊息不含金鑰。 */
function httpJson_(url, headers, body) {
  var retryable = { 408: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1, 529: 1 };
  var last = '';
  for (var attempt = 0; attempt < 3; attempt++) {
    if (attempt) Utilities.sleep(2000 * Math.pow(2, attempt - 1));
    var resp;
    try {
      resp = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json', headers: headers,
        payload: JSON.stringify(body), muteHttpExceptions: true, followRedirects: true
      });
    } catch (e) {
      last = '連線失敗：' + e.message;
      continue;
    }
    var code = resp.getResponseCode(), text = resp.getContentText();
    if (code >= 200 && code < 300) return JSON.parse(text);
    var detail = text;
    try { var j = JSON.parse(text); detail = (j.error && (j.error.message || j.error.type)) || j.message || text; } catch (e) {}
    last = 'HTTP ' + code + '：' + String(detail).slice(0, 300);
    if (!retryable[code]) break;
  }
  throw new Error('LLM 服務錯誤（' + last + '）');
}
