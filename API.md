# 對外 API

部署好的網頁應用程式網址（結尾 `/exec`）同時是 JSON API。用途：課程平臺批次檢核、LINE Bot、看板讀取、整本書分章處理。

## 驗證

每個請求帶 `token`，值為指令碼屬性 `API_TOKEN`（`setupProject` 會自動產生；試算表選單「顯示對外 API 權杖」可查看）。權杖錯誤回 `{ "ok": false, "error": "unauthorized…" }`。

## 請求

```
POST https://script.google.com/macros/s/<部署 ID>/exec
Content-Type: text/plain;charset=utf-8
```

Apps Script 會先回 302 轉址再給結果，用戶端要**跟隨轉址**（curl 加 `-L`）。瀏覽器端用 `text/plain` 可避開 CORS 預檢。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `token` | string | 必填 |
| `action` | string | `analyze`（只分析，不呼叫 AI）、`adjust`（分析＋改寫＋驗證）、`levels`（等級對照表）、`health`（詞表與 AI 狀態） |
| `text` | string | 文本（`analyze`、`adjust` 必填） |
| `target` | number | TBCL 目標級 1–7，預設 3 |
| `mode` | string | `auto`（預設）、`down`、`up`、`localize` |
| `purpose` | string | `extensive`（分級讀本，門檻 98%，預設）、`intensive`（精讀，95%） |
| `learner` | string | `adult_nonchar`（預設）、`adult_char`、`overseas`、`child` |
| `protectedWords` | string | 不得更動的詞，換行或頓號分隔 |
| `known` | string | 學習者已學的詞 |
| `glossary` | string | 本書生詞 |
| `notes` | string | 給 AI 的補充指示 |
| `stripSpeakers` | boolean | 是否移除行首說話者標籤，預設 `true` |
| `includeSpans` | boolean | 是否回傳逐詞標記，API 預設 `false` |
| `includeReport` | boolean | 是否回傳 Markdown 編修報告，預設 `true` |

## 回應（重點欄位）

數值為示範詞表跑出的範例。

```jsonc
{
  "ok": true,
  "action": "adjust",
  "target": 3,
  "levelLabel": "TBCL 第 3 級（基礎）｜TOCFL 基礎級（Level 2，CEFR A2）",
  "direction": "down",                 // down｜up｜polish
  "rounds": 2,
  "passed": true,                      // 通過詞表驗證
  "verified": true,                    // false＝沒有詞表，等級為推估
  "revisedText": "……",
  "before": {                          // 修訂前分析（after 結構相同）
    "stats": { "hanChars": 128, "tokens": 79, "types": 63 },
    "sentences": { "count": 10, "mean": 12.8, "max": 20, "guide": 13 },
    "levelDist": [{ "level": 1, "tokens": 46, "pct": 58.2, "cumPct": 58.2, "types": 33 }],
    "estimate": { "level": null, "beyond": true, "threshold": 98, "curve": [{ "level": 1, "cov": 66.7 }] },
    "target": {
      "withinPct": 77.2, "effectivePct": 86.1, "pass": false, "status": "偏難",
      "aboveUnglossedTypes": 8, "newWordsPer100": 10.1,
      "above": [{ "w": "琳瑯滿目", "lv": 7, "n": 1, "glossed": false, "py": "línlángmǎnmù", "zy": "ㄌㄧㄣˊ ㄌㄤˊ ㄇㄢˇ ㄇㄨˋ", "ctx": "……" }]
    },
    "oov": [{ "w": "出租", "n": 1, "ctx": "……" }],
    "norms": { "simplified": [{ "c": "觉", "n": 1 }], "variants": [], "terms": [{ "term": "出租車", "tw": "計程車", "n": 1 }] },
    "warnings": []
  },
  "after": { "…": "…" },
  "changes": [{ "round": 1, "original": "出租車", "revised": "計程車", "category": "用語", "reason": "……", "located": true }],
  "glossary": [{ "w": "香味", "lv": 5, "n": 1, "py": "xiāngwèi", "zy": "ㄒㄧㄤ ㄨㄟˋ", "pos": "N", "en": "aroma", "source": "模型保留", "reason": "……" }],
  "grammarNotes": [{ "point": "V V 看", "example": "你一定要吃吃看！", "note": "……" }],
  "statement": "本文目標為 TBCL 第 3 級（基礎），對應 TOCFL 基礎級……",
  "warnings": [],
  "llm": { "provider": "anthropic", "model": "claude-sonnet-5-5", "inputTokens": 3000, "outputTokens": 1200 },
  "report": "# 分級讀本編修報告 ……"
}
```

錯誤時：`{ "ok": false, "error": "錯誤說明" }`（HTTP 狀態碼仍為 200，請看 `ok`）。

## 範例

**curl**

```bash
curl -sL "https://script.google.com/macros/s/<部署 ID>/exec" \
  -H "Content-Type: text/plain;charset=utf-8" \
  --data '{"token":"<API_TOKEN>","action":"analyze","target":3,"text":"安娜是從法國來的學生。","protectedWords":"安娜"}'
```

**Python（整本書分章檢核）**

```python
import json, requests
URL, TOKEN = "https://script.google.com/macros/s/<部署 ID>/exec", "<API_TOKEN>"
for i, chapter in enumerate(open("讀本.txt", encoding="utf-8").read().split("\n\n\n"), 1):
    r = requests.post(URL, data=json.dumps({"token": TOKEN, "action": "analyze", "target": 3,
                                            "text": chapter, "includeReport": False}),
                      headers={"Content-Type": "text/plain;charset=utf-8"}, timeout=120).json()
    t = r["before"]["target"]
    print(f"第 {i} 章：估計第 {r['before']['estimate']['level']} 級，覆蓋率 {t['effectivePct']}%，超綱 {t['aboveUnglossedTypes']} 種")
```

**瀏覽器 JavaScript**

```js
const res = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify({ token: TOKEN, action: 'adjust', target: 2, text })
}).then(r => r.json());
```

> 權杖等同於使用 AI 額度的鑰匙。只放在伺服器端或內部工具，不要寫進公開網頁的前端程式碼。

## 限制

- 單次執行上限 6 分鐘（Apps Script 限制）；`adjust` 一章約 20–60 秒。
- `adjust` 受 `MAX_CHARS`（預設 3,000 字）與 `DAILY_LIMIT`（預設每日 200 次 AI 呼叫，全站合計）限制。
- Apps Script 網頁應用程式有每日執行次數配額，大量批次處理請分散時間。
