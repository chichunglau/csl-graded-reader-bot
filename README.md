# 分級讀本調級機器人（TBCL／TOCFL）

貼上一章分級讀本，選定 TBCL 目標等級，機器人會：

1. 用國教院 TBCL 詞語表斷詞，算出各級詞語分布、可理解覆蓋率、適讀等級，列出超綱詞、未收錄片段、簡體字與大陸用語；
2. 把檢核結果交給 AI（預設 Claude）改寫到目標等級；
3. 改完再用詞表驗證，沒通過就帶著剩下的問題再改一輪；
4. 產出修訂稿、修訂紀錄、建議生詞表（拼音取自 TBCL 參考欄位）與編修報告。

介面有 16 種語言（繁體中文、English、日本語、한국어，以及越南、印尼、泰、菲律賓、馬來、緬甸、柬埔寨、寮、印地、尼泊爾、孟加拉、僧伽羅語）；**分析結果、修訂稿與報告一律以臺灣正體中文輸出**。閱讀區可切換 ToneOZ 繁體＋漢語拼音或注音字型，並調整字級，協助學生閱讀。

介面採簡潔單欄版（v1.3）：上方是 TOCFL 八級滑桿（準備一級到精通級，下方對應 TBCL 1–7 級，右上徽章顯示目前等級），下方是對話式輸入框，按藍色送出鍵（或 Ctrl＋Enter）即調整；尚未設定 AI 時送出鍵改做分析。語言與字體收在右上「顯示設定」。

整套程式跑在 Google Apps Script，資料放 Google 試算表，網頁直接嵌入 Google Sites。不需要另外架伺服器。

設計理念與指標定義見 [DESIGN.md](DESIGN.md)，對外 API 見 [API.md](API.md)。

---

## 檔案

| 檔案 | 用途 |
|---|---|
| `apps-script/appsscript.json` | 專案資訊清單（時區、權限、網頁應用程式設定） |
| `apps-script/Config.gs` | 設定與指令碼屬性說明 |
| `apps-script/Levels.gs` | TBCL 七級 ↔ TOCFL ↔ CEFR、各級數量、文本類型、句長建議 |
| `apps-script/Assets.gs` | 內建大陸用語、非標準字形、簡繁對照（約 90 條用語、880 字） |
| `apps-script/Analyzer.gs` | 分級檢核引擎：雙向最大匹配斷詞、覆蓋率、適讀等級、規範檢查、多音字選音 |
| `apps-script/Phonetics.gs` | 2,328 個常用多音字的讀音順序，讓 ToneOZ 字型顯示 TBCL 參考讀音（Apache 2.0 資料，見 THIRD_PARTY_NOTICES.md） |
| `apps-script/Data.gs` | 從試算表載入詞表、分塊快取、每日配額、執行紀錄 |
| `apps-script/Llm.gs` | **LLM 介面**：Claude（預設）、OpenAI、Gemini、自訂端點 |
| `apps-script/Prompts.gs` | 提示詞與結構化輸出格式 |
| `apps-script/Adjust.gs` | 主流程：分析 → 改寫 → 驗證 → 第二輪 |
| `apps-script/Report.gs` | Markdown 編修報告 |
| `apps-script/Code.gs` | 網頁入口與前端呼叫的函式 |
| `apps-script/Api.gs` | **對外 JSON API**（doPost） |
| `apps-script/Setup.gs` | 試算表選單、初始化、自我檢測 |
| `apps-script/Index.html`、`Styles.html`、`Client.html` | 網頁介面 |
| `apps-script/I18n.html` | 16 種語言的介面翻譯（由 `dev/i18n/*.json` 產生） |
| `templates/*.csv` | 試算表各分頁的欄位範本 |
| `dev/` | 本機測試、預覽建置、翻譯原檔與字型工具（不必上傳到 Apps Script） |

---

## 部署步驟（約 20 分鐘）

### 1. 建立試算表與 Apps Script 專案

> **快速版**：`dist/` 資料夾是合併好的 4 個檔（`appsscript.json`、`Code.gs`、`Index.html`、`I18n.html`），只要貼這 4 個檔即可取代下面第 4 步的 17 個檔。改了 `apps-script/` 後執行 `node dev/build_dist.js` 重新產生。

1. 在 Google 雲端硬碟新增一份試算表，命名為「分級讀本機器人資料庫」。
2. 試算表選單「擴充功能 → Apps Script」。
3. 左側「專案設定」（齒輪）→ 勾選「在編輯器中顯示 appsscript.json 資訊清單檔案」。回到編輯器，把 `appsscript.json` 的內容整份貼上。
4. 新增以下檔案並貼上內容（「＋」→「指令碼」或「HTML」；檔名不含副檔名，大小寫要一致）：
   - 指令碼：`Config`、`Levels`、`Assets`、`Phonetics`、`Analyzer`、`Data`、`Llm`、`Prompts`、`Report`、`Adjust`、`Code`、`Api`、`Setup`
   - HTML：`Index`、`Styles`、`I18n`、`Client`
   - 預設的「程式碼.gs」可以刪除，或直接改名成 `Code` 後貼上內容。
5. 上方函式選單選 `setupProject` → 執行 → 依畫面授權。完成後試算表會多出「說明、TBCL詞語、TBCL漢字、TBCL語法點、專名、用語對照、介面翻譯、執行紀錄」分頁，並出現「分級讀本機器人」選單。

> 資訊人員也可以用 [clasp](https://github.com/google/clasp)：`clasp clone <scriptId>`，把 `apps-script/` 內的檔案放進去後 `clasp push`。

### 2. 匯入 TBCL 詞表

1. 到國教院 <https://coct.naer.edu.tw/> →「文件下載」，下載 TBCL 詞語表 CSV（例如 `合併7級TBCL詞語表_按漢拼排序_112_05_17_去除國名洲名宗教名.csv`）。
2. 在試算表點「TBCL詞語」分頁 →「檔案 → 匯入 → 上傳」→ 匯入位置選「取代目前的工作表」。
   - 程式會自動找「詞語」「級別」「參考漢語拼音」「參考注音」欄，不必調整欄位順序。
   - 若中文變亂碼，先用記事本或 Excel 把 CSV 另存為 UTF-8 再匯入。
3. （選用）漢字表匯入「TBCL漢字」，語法點表匯入「TBCL語法點」。語法點表會提供給 AI 當作可用語法清單。
4. 詞表若是「去除國名洲名宗教名」版本，請把讀本會用到的國名、地名放進「專名」分頁，否則會被當成未收錄。
5. Apps Script「專案設定 → 指令碼屬性」新增 `TBCL_VERSION_LABEL`，值填詞表檔名或日期，會寫進每一份報告。
6. 試算表選單「分級讀本機器人 → ② 重新載入詞表」，再執行「③ 自我檢測」。看到「TBCL 詞語：14,4xx 筆」就完成了。

### 3. 設定 AI（指令碼屬性）

「專案設定 → 指令碼屬性 → 新增指令碼屬性」：

| 屬性 | 必填 | 說明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 是 | Claude API 金鑰，在 Claude Console 建立（文件：<https://platform.claude.com/docs>） |
| `ANTHROPIC_MODEL` | 否 | 預設 `claude-sonnet-5-5`；要更快更省可改 `claude-haiku-5-5` |
| `LLM_PROVIDER` | 否 | `anthropic`（預設）、`openai`、`gemini`、`custom`、`none`（只分析） |
| `DAILY_LIMIT` | 否 | 每日 AI 呼叫上限，全站合計，預設 200。網頁開放給所有人時請調低 |
| `MAX_ROUNDS` | 否 | 改寫＋驗證最多幾輪，預設 2 |
| `MAX_CHARS` | 否 | 單次調整漢字上限，預設 3000 |
| `MAX_NEW_PER_100` | 否 | AI 可保留的生詞上限（每 100 詞次），預設 1 |
| `LLM_MAX_TOKENS` | 否 | 單次輸出上限，預設 8000 |

金鑰只存在指令碼屬性，不會出現在網頁或回應裡。

**費用估算**：一章 500 字的讀本，每輪約 3,000 輸入 tokens、1,500 輸出 tokens。以 Sonnet 5.5（每百萬 tokens 輸入 2 美元、輸出 10 美元）計算，每輪約 0.02 美元；兩輪約 0.04 美元。實際以 Anthropic 官方價目與帳單為準，「執行紀錄」分頁會記下每次的 tokens 數。

### 4. 部署成網頁應用程式

1. Apps Script 右上「部署 → 新增部署作業」→ 類型選「網頁應用程式」。
2. 執行身分：**我**（用部署者的權限讀試算表、呼叫 API，使用者不需要試算表權限）。
3. 誰可以存取：
   - 學校使用 Google Workspace：選只限本機構網域的選項，只有校內帳號能用。
   - 個人 Gmail 帳號部署：選「擁有 Google 帳戶的使用者」，使用者登入 Google 後才能用。
   - 不必登入的「所有人」只在要公開給校外訪客時使用，並把 `DAILY_LIMIT` 調低。
4. 部署 → 複製結尾是 `/exec` 的網址。
5. 之後修改程式：「部署 → 管理部署作業 → 編輯（鉛筆）→ 版本：新版本 → 部署」，網址不變，Google Sites 不必重新嵌入。

### 5. 嵌入 Google Sites

1. 編輯協作平台頁面 → 右側「插入 → 嵌入」→「依網址」。
2. 貼上 `/exec` 網址 → 選「整個網頁」→ 插入。
3. 把嵌入框拉到滿版寬度、高度至少 1,400 像素（結果頁較長）。
4. 發布協作平台。

若嵌入框顯示需要登入或「無法開啟」，通常是第 4 步的存取權限比協作平台的讀者範圍還窄。

要放在學校其他網站時（程式已允許 iframe 嵌入）：

```html
<iframe src="https://script.google.com/macros/s/……/exec" style="width:100%;height:1600px;border:0" title="分級讀本調級機器人"></iframe>
```

---

## 多語介面與學生輔助字體

### 介面語言

- 頁面右上的「介面語言」可切換 16 種語言，選擇會記在該瀏覽器。第一次開啟時依瀏覽器語言自動判斷，判斷不到就用繁體中文。
- 只有按鈕、說明、圖表標籤會翻譯。**AI 改寫、修訂紀錄、對標陳述、編修報告都固定是臺灣正體中文**（提示詞第 11 條明訂），教師之間交換的教材格式一致。
- 指令碼屬性 `UI_DEFAULT_LANG` 可設定全站預設語言（例如東南亞專班頁面設 `vi`）。

**網址參數**：Google Sites 可以在不同頁面嵌入不同設定，網址後面加：

| 參數 | 值 | 例 |
|---|---|---|
| `lang` | `zh-Hant`、`en`、`ja`、`ko`、`vi`、`id`、`th`、`fil`、`ms`、`my`、`km`、`lo`、`hi`、`ne`、`bn`、`si` | `…/exec?lang=vi` |
| `font` | `std`（標準）、`pinyin`（ToneOZ 拼音）、`zhuyin`（ToneOZ 注音） | `…/exec?lang=th&font=pinyin` |
| `size` | `s`、`m`、`l` | `…/exec?size=l` |
| `level` | `1`–`7`（滑桿預設等級） | `…/exec?level=2` |

**修正翻譯**：翻譯由 Claude 撰寫，英、日、韓以外的語言建議請各國學生或同事校對。試算表選單「匯出內建介面翻譯」會把全部 233 條 × 16 種語言寫到「介面翻譯」分頁；直接改格子，再執行「② 重新載入詞表」即可生效，不必改程式。

### ToneOZ 繁體＋漢語拼音／注音字型

「閱讀字體」選 ToneOZ 後，文本欄、標記文本、修訂稿與生詞表會用 ToneOZ 楷體顯示，每個字旁邊附漢語拼音或注音，字級與行距自動放大。

**多音字**：程式依 TBCL 詞表的「參考注音」替多音字加上 IVS 選音碼，例如「慢慢地」的「地」顯示 ˙ㄉㄜ、「睡著」的「著」顯示 ㄓㄠˊ。詞表沒有收錄的詞維持字型的預設讀音。修訂稿分頁的「複製（含 ToneOZ 多音字選音）」會連選音碼一起複製，貼到 Word 或 Google 文件後把字型設成 ToneOZ，讀音仍然正確。（依 ToneOZ 說明，拼音與注音字型的選音碼互通；本專案以注音字型實測。）

**字型從哪裡來**，三擇一：

| 做法 | 設定 | 適合 |
|---|---|---|
| 學生電腦已安裝 ToneOZ 字型 | 不用設定（程式先找本機字型） | 電腦教室統一安裝 |
| 用官方 GitHub 專案經 jsDelivr 提供的注音字型 | 已內建在 `TONEOZ_ZHUYIN_URL`（約 16 MB） | 先試用 |
| 學校自行提供網頁字型（建議） | 指令碼屬性 `TONEOZ_PINYIN_URL`、`TONEOZ_ZHUYIN_URL` | 正式上線、手機使用 |

**拼音字型需要學校自行提供**：ToneOZ 拼音庫楷－繁只在官網以 zip 提供，沒有公開的網頁字型網址。步驟：

1. 從 <https://toneoz.com/blog/download-fonts/> 下載「澳聲通拼音庫楷－繁」（`ToneOZ-Pinyin-Kai-Traditional.zip`），解壓出 `.ttf`。
2. 縮小檔案（建議，原檔約 30 MB，學生用手機會載很久）：`pip install fonttools`，然後
   `python3 dev/subset_toneoz.py ToneOZ-Pinyin-Kai-Traditional.ttf ToneOZ-Pinyin-Kai-TC-web.woff`
   只保留常用 5,401 字與多音字選音，實測注音版從 31 MB 縮到約 4 MB。
3. 放到允許跨網域讀取的位置。最簡單的是建一個**公開** GitHub 專案放進去，網址寫成
   `https://cdn.jsdelivr.net/gh/<帳號>/<專案>@main/ToneOZ-Pinyin-Kai-TC-web.woff`；學校網站伺服器也可以，但要加 `Access-Control-Allow-Origin` 標頭。Google 雲端硬碟的分享連結不能當網頁字型。
4. 指令碼屬性填入 `TONEOZ_PINYIN_URL`。注音字型也可以照同樣方式縮小後改填 `TONEOZ_ZHUYIN_URL`。
5. 開啟頁面選「ToneOZ 繁體＋漢語拼音」，提示列出現「已套用」就成功；若顯示「找不到字型」，通常是網址不能跨網域讀取。

> 內建的 jsDelivr 注音字型網址是依 jsDelivr 的 GitHub 轉址規則組成，開發環境無法連線實測；如果載入失敗，請改用上面的自行提供方式。

**授權**：ToneOZ 字型免費商用；漢字部分依全字庫（政府資料開放授權條款 1.0）、拼音部分依 SIL OFL 1.1、注音部分依 Apache 2.0。自行縮小或轉檔後散布，請保留原授權說明，詳見 THIRD_PARTY_NOTICES.md。

---

## 常見問題

| 訊息 | 處理 |
|---|---|
| 未載入 TBCL 詞表 | 確認「TBCL詞語」分頁有資料，執行選單「② 重新載入詞表」 |
| 尚未設定 LLM | 指令碼屬性加上 `ANTHROPIC_API_KEY` |
| HTTP 401 | 金鑰錯誤或已撤銷 |
| HTTP 429／529 | 服務忙碌，程式會自動重試兩次；仍失敗請稍後再試 |
| 今日 AI 呼叫次數已達上限 | 隔天重置，或調高 `DAILY_LIMIT` |
| 模型輸出被截斷 | 文本太長；分章處理或調高 `LLM_MAX_TOKENS` |
| 超過 6 分鐘未完成 | Apps Script 單次執行上限為 6 分鐘；分章、把 `MAX_ROUNDS` 改成 1，或改用 Haiku |
| 人名被列為未收錄或超綱 | 加進「進階設定 → 不得更動的詞」或「專名」分頁 |
| 選了 ToneOZ 卻顯示「找不到字型」 | 學生電腦沒裝字型，且字型網址無法跨網域讀取；見上方「ToneOZ 字型」 |
| 某個多音字讀音不對 | 該詞不在 TBCL 詞表（字型用預設讀音），或詞表參考注音與字型讀音表寫法不同；可用 ToneOZ「IVS 選音編輯器」https://toneoz.com/ime 手動校正後再貼回 |
| 翻譯不自然 | 在「介面翻譯」分頁修改後重新載入，見上方「修正翻譯」 |

---

## 本機測試（開發用）

需要 Node.js 18 以上：

```bash
node dev/test_analyzer.js      # 分析引擎；並與 taiwan-huayu-materials 的 Python 版結果比對
node dev/test_backend.js       # 模擬 Apps Script 服務與 Claude 回應，跑完整兩輪流程與 doPost
node dev/build_preview.js preview.html   # 產生單頁介面預覽（示範詞表＋預錄回應）
node dev/build_i18n.js                   # 由 dev/i18n/*.json 產生 I18n.html，並檢查缺漏與 {佔位符}
python3 dev/gen_phonic.py <toneoz-font-zhuyin 專案目錄> apps-script/Phonetics.gs   # 重建多音字表
```

`dev/fixtures/demo_lexicon.csv` 是 66 詞的**示範詞表**，等級只為測試程式，不是國教院資料。
