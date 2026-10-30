// 最小化的 Apps Script 服務模擬，只實作本專案用到的方法
const fs = require('fs');
function csvRows(p) { return fs.readFileSync(p, 'utf8').trim().split('\n').map(l => l.split(',')); }
module.exports = function makeMocks({ sheets = {}, props = {}, fetchHandler }) {
  const store = Object.assign({}, props), cache = {}, log = { fetches: [], appended: [] };
  const mkSheet = (name, rows) => ({
    _rows: rows,
    getLastRow() { return this._rows.length; },
    getLastColumn() { return Math.max(0, ...this._rows.map(r => r.length)); },
    getRange(r, c, nr, nc) {
      const self = this;
      return {
        getDisplayValues() { return self._rows.slice(r - 1, r - 1 + nr).map(row => { const o = []; for (let i = 0; i < nc; i++) o.push(row[c - 1 + i] === undefined ? '' : String(row[c - 1 + i])); return o; }); },
        setValues(v) { v.forEach((row, i) => { self._rows[r - 1 + i] = row; }); return this; },
        setFontWeight() { return this; }, setWrap() { return this; }
      };
    },
    appendRow(row) { this._rows.push(row); log.appended.push({ name, row }); },
    setFrozenRows() {}, setFrozenColumns() {}, setColumnWidth() {}, clearContents() { this._rows = []; }
  });
  const book = {}; for (const [n, rows] of Object.entries(sheets)) book[n] = mkSheet(n, rows);
  const ss = { getSheetByName: n => book[n] || null, getId: () => 'SHEET123', getUrl: () => 'https://docs.google.com/x',
               insertSheet(n) { return (book[n] = mkSheet(n, [])); }, getSheets: () => Object.values(book),
               setActiveSheet() {}, moveActiveSheet() {}, deleteSheet() {} };
  return {
    log, store, cache, book,
    globals: {
      PropertiesService: { getScriptProperties: () => ({
        getProperty: k => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = String(v); },
        deleteProperty: k => { delete store[k]; }, getKeys: () => Object.keys(store) }) },
      CacheService: { getScriptCache: () => ({
        get: k => (k in cache ? cache[k] : null), put: (k, v) => { if (String(v).length > 100000) throw new Error('too big'); cache[k] = v; },
        putAll: o => { for (const [k, v] of Object.entries(o)) { if (Buffer.byteLength(v) > 100 * 1024) throw new Error('value too big ' + Buffer.byteLength(v)); cache[k] = v; } },
        getAll: ks => { const o = {}; ks.forEach(k => { if (k in cache) o[k] = cache[k]; }); return o; } }) },
      SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss, create: () => ss, getUi: () => { throw new Error('no ui'); } },
      UrlFetchApp: { fetch: (url, opt) => { log.fetches.push({ url, opt, body: JSON.parse(opt.payload) }); const r = fetchHandler(url, opt, log.fetches.length);
        return { getResponseCode: () => r.code || 200, getContentText: () => JSON.stringify(r.body) }; } },
      Utilities: { formatDate: () => '20261022', sleep: () => {}, getUuid: () => 'aaaa-bbbb' },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
      Session: { getActiveUser: () => ({ getEmail: () => 'teacher@example.edu.tw' }) },
      ContentService: { createTextOutput: t => ({ text: t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
      HtmlService: { createHtmlOutputFromFile: n => ({ getContent: () => fs.readFileSync(__dirname + '/../apps-script/' + n + '.html', 'utf8') }) }
    },
    csvRows
  };
};
