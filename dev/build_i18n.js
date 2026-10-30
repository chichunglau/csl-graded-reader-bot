// 由 dev/i18n/*.json 產生 apps-script/I18n.html，並檢查缺漏 key 與 {佔位符} 是否一致
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, 'i18n'), AS = path.join(__dirname, '..', 'apps-script');
const langs = JSON.parse(fs.readFileSync(path.join(dir, '_langs.json'), 'utf8'));
const strings = {};
for (const l of langs) {
  const f = path.join(dir, l.code + '.json');
  if (fs.existsSync(f)) strings[l.code] = JSON.parse(fs.readFileSync(f, 'utf8'));
}
const master = strings['zh-Hant'];
// 程式實際用到的 key
const client = fs.readFileSync(path.join(AS, 'Client.html'), 'utf8'), index = fs.readFileSync(path.join(AS, 'Index.html'), 'utf8');
const used = new Set([...client.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map(m => m[1])
  .concat([...index.matchAll(/data-i18n(?:-ph|-aria)?="([^"]+)"/g)].map(m => m[1]))
  .concat([...client.matchAll(/'((?:st|verdict|cat|src|band|gl\.note)\.[a-zA-Z_.]+)'/g)].map(m => m[1])));
const dynamic = ['type.1', 'type.2', 'type.3', 'type.4', 'type.5', 'type.6', 'type.7', 'dir.down', 'dir.up', 'dir.polish',
  'purpose.extensive', 'purpose.intensive', 'learner.adult_nonchar', 'learner.adult_char', 'learner.overseas', 'learner.child',
  'level.meta', 'level.meta.nolen', 'kpi.cov.d', 'badge', 'tocfl.names', 'composer.hint'];
dynamic.forEach(k => used.add(k));
let problems = 0;
const missingMaster = [...used].filter(k => !(k in master) && !/\.$/.test(k));
if (missingMaster.length) { console.log('zh-Hant 缺少程式用到的 key：', missingMaster); problems++; }
const unused = Object.keys(master).filter(k => !used.has(k));
if (unused.length) console.log('（提醒）zh-Hant 有程式沒用到的 key：', unused);
const ph = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
for (const l of langs) {
  const s = strings[l.code];
  if (!s) { console.log(`${l.code}: 沒有翻譯檔（會退回英文）`); continue; }
  const miss = Object.keys(master).filter(k => !(k in s));
  const extra = Object.keys(s).filter(k => !(k in master));
  const bad = Object.keys(master).filter(k => k in s && k !== 'badge' && ph(s[k]) !== ph(master[k]));
  const tocfl = s['tocfl.names'] && s['tocfl.names'].split(',').length !== 8 ? ['tocfl.names 需 8 項'] : [];
  if (miss.length || extra.length || bad.length || tocfl.length) {
    problems++;
    console.log(`${l.code}: 缺 ${miss.length}`, miss.slice(0, 8), `多 ${extra.length}`, extra.slice(0, 5), '佔位符不符', bad, tocfl);
  } else console.log(`${l.code}: OK（${Object.keys(s).length} 條）`);
}
const json = JSON.stringify({ langs, strings });
if (json.includes('*/') || /<\/script/i.test(json)) throw new Error('翻譯內容含有不允許的字串');
fs.writeFileSync(path.join(AS, 'I18n.html'),
  '<script>\n/* 介面翻譯：由 dev/build_i18n.js 從 dev/i18n/*.json 產生。要修正翻譯，建議在試算表「介面翻譯」分頁覆蓋，不必改程式。 */\n'
  + 'window.GR_I18N = /*I18N*/' + json + '/*I18N*/;\n</script>\n');
console.log('wrote I18n.html', Math.round(json.length / 1024) + 'KB', problems ? `— ${problems} 個語言有問題` : '— 全部通過');
process.exitCode = problems ? 1 : 0;
