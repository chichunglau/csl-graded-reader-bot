// 在 Node 載入 Apps Script 的 .gs 檔（共用全域），供測試與預覽建置使用
const fs = require('fs'), vm = require('vm'), path = require('path');
module.exports = function load(files, extraGlobals) {
  const ctx = vm.createContext(Object.assign({ console }, extraGlobals || {}));
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8'), ctx, { filename: f });
  return ctx;
};
