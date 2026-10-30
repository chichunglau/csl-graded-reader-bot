/**
 * Api.gs — 對外 JSON API（給其他系統串接：課程平臺、LINE Bot、看板、批次腳本）
 *
 * POST {網頁應用程式網址}
 * Content-Type: text/plain（瀏覽器端用 text/plain 可避開 CORS 預檢；伺服器端用 application/json 亦可）
 * Body：
 *   {
 *     "token":   "<指令碼屬性 API_TOKEN>",
 *     "action":  "analyze" | "adjust" | "levels" | "health",
 *     "text":    "要處理的文本",
 *     "target":  3,                       // TBCL 1–7
 *     "mode":    "auto" | "down" | "up" | "localize",
 *     "purpose": "extensive" | "intensive",
 *     "learner": "adult_nonchar" | "adult_char" | "overseas" | "child",
 *     "protectedWords": "安娜\n士林夜市",   // 不得更動的詞
 *     "known": "…", "glossary": "…", "notes": "…",
 *     "includeSpans": false,              // 是否回傳逐詞標記（預設 false，資料量較小）
 *     "includeReport": true               // 是否回傳 Markdown 編修報告
 *   }
 * 回應：{ "ok": true, ... } 或 { "ok": false, "error": "..." }
 *
 * 注意：Apps Script 網頁應用程式的 POST 會先回 302 轉址，用 curl 請加 -L，其他用戶端請開啟「跟隨轉址」。
 */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var token = prop_('API_TOKEN', '');
    if (!token || req.token !== token) {
      out = { ok: false, error: 'unauthorized：權杖錯誤或尚未設定 API_TOKEN' };
    } else {
      if (req.includeSpans === undefined) req.includeSpans = false;
      switch (req.action) {
        case 'health': out = { ok: true, status: statusInfo_() }; break;
        case 'levels': out = { ok: true, levels: GR_LEVELS, purposes: GR_PURPOSES, learners: GR_LEARNERS }; break;
        case 'analyze': out = runAnalyze_(req, 'api'); break;
        case 'adjust': out = runAdjust_(req, 'api'); break;
        default: out = { ok: false, error: '不支援的 action：' + req.action };
      }
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return jsonOut_(out);
}
