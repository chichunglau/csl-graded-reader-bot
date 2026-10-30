// 把 apps-script/ 合併成 4 個檔（dist/），方便直接貼進 Apps Script 編輯器
const fs = require('fs'), path = require('path');
const AS = path.join(__dirname, '..', 'apps-script'), OUT = path.join(__dirname, '..', 'dist');
fs.mkdirSync(OUT, { recursive: true });
const read = f => fs.readFileSync(path.join(AS, f), 'utf8');
const GS = ['Config', 'Levels', 'Assets', 'Phonetics', 'Analyzer', 'Data', 'Llm', 'Prompts', 'Report', 'Adjust', 'Code', 'Api', 'Setup'];
const version = /version: '([\d.]+)'/.exec(read('Config.gs'))[1];
const head = `/**\n * 分級讀本調級機器人 v${version}（合併版，由 dev/build_dist.js 產生）\n * 貼進 Apps Script 的「程式碼.gs」。另需 Index.html、I18n.html 與 appsscript.json。\n * 各段原始檔見 GitHub 專案的 apps-script/ 資料夾。\n */\n`;
const body = GS.map(n => `\n// ================================================================ ${n}.gs\n` + read(n + '.gs')).join('\n');
fs.writeFileSync(path.join(OUT, 'Code.gs'), head + body);
const index = read('Index.html')
  .replace("<?!= include_('Styles') ?>", () => read('Styles.html'))
  .replace("<?!= include_('Client') ?>", () => read('Client.html'));
if (/include_\('(Styles|Client)'\)/.test(index)) throw new Error('include 未展開');
fs.writeFileSync(path.join(OUT, 'Index.html'), index);
fs.copyFileSync(path.join(AS, 'I18n.html'), path.join(OUT, 'I18n.html'));
fs.copyFileSync(path.join(AS, 'appsscript.json'), path.join(OUT, 'appsscript.json'));
for (const f of fs.readdirSync(OUT)) console.log(f, Math.round(fs.statSync(path.join(OUT, f)).size / 1024) + 'KB');
