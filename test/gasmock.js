/* Minimal Google Apps Script runtime mock, good enough to exercise the real
   backend logic (sheets, ranges, cache, lock, digests, date formatting). */
const crypto = require("crypto");

function pad(n, w) { return String(n).padStart(w || 2, "0"); }

// Asia/Kathmandu = UTC+05:45
const TZ_OFFSET_MIN = 5 * 60 + 45;

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet; this.row = row; this.col = col;
    this.numRows = numRows; this.numCols = numCols;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        row.push(this.sheet._get(this.row + r, this.col + c));
      }
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    for (let r = 0; r < vals.length; r++)
      for (let c = 0; c < vals[r].length; c++)
        this.sheet._set(this.row + r, this.col + c, vals[r][c]);
    return this;
  }
  setValue(v) { this.sheet._set(this.row, this.col, v); return this; }
  setNote() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
  setFontWeight() { return this; }
  setVerticalAlignment() { return this; }
  setWrap() { return this; }
  setNumberFormat() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  getName() { return this.name; }
  _get(r, c) {
    const row = this.rows[r - 1];
    if (!row) return "";
    const v = row[c - 1];
    return v === undefined ? "" : v;
  }
  _set(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    const row = this.rows[r - 1];
    while (row.length < c) row.push("");
    row[c - 1] = v;
  }
  getLastRow() {
    let last = 0;
    this.rows.forEach((row, i) => {
      if (row && row.some(v => v !== "" && v !== null && v !== undefined)) last = i + 1;
    });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.rows.forEach(row => { if (row) last = Math.max(last, row.length); });
    return last;
  }
  getRange(row, col, numRows, numCols) {
    return new Range(this, row, col, numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
  }
  appendRow(arr) {
    const r = this.getLastRow() + 1;
    arr.forEach((v, i) => this._set(r, i + 1, v));
  }
  setFrozenRows() { return this; }
  setRowHeight() { return this; }
  setColumnWidth() { return this; }
}

class Spreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  setSpreadsheetTimeZone() { return this; }
  setActiveSheet() { return this; }
  moveActiveSheet() { return this; }
}

const SS = new Spreadsheet();

const cacheStore = new Map();
const propStore = new Map();
// Lets a test simulate CacheService evicting entries early, which is the exact
// failure mode the durable session store exists to survive.
const cacheControl = { enabled: true };
// Lets a test force lock contention, the 5 PM deadline failure mode.
const lockControl = { failNext: false, acquired: 0, released: 0 };

const g = {
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: k => (propStore.has(k) ? propStore.get(k) : null),
      setProperty: (k, v) => { propStore.set(k, String(v)); },
      deleteProperty: k => { propStore.delete(k); },
      getProperties: () => Object.fromEntries(propStore)
    })
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => SS,
    getUi: () => { throw new Error("no UI in tests"); }
  },
  Utilities: {
    formatDate(date, tz, fmt) {
      const t = new Date(date.getTime() + TZ_OFFSET_MIN * 60000);
      const Y = t.getUTCFullYear(), M = pad(t.getUTCMonth() + 1), D = pad(t.getUTCDate());
      const h = pad(t.getUTCHours()), m = pad(t.getUTCMinutes()), s = pad(t.getUTCSeconds());
      if (fmt === "yyyy-MM-dd") return `${Y}-${M}-${D}`;
      if (fmt === "yyyy-MM-dd HH:mm:ss") return `${Y}-${M}-${D} ${h}:${m}:${s}`;
      return `${Y}-${M}-${D}`;
    },
    computeDigest(alg, text) {
      const buf = crypto.createHash("sha256").update(text, "utf8").digest();
      return Array.from(buf).map(b => (b > 127 ? b - 256 : b));
    },
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF_8" }
  },
  CacheService: {
    getScriptCache: () => ({
      get: k => (cacheControl.enabled && cacheStore.has(k) ? cacheStore.get(k) : null),
      put: (k, v) => { if (cacheControl.enabled) cacheStore.set(k, v); },
      remove: k => cacheStore.delete(k)
    })
  },
  LockService: {
    getDocumentLock: () => ({
      tryLock: () => {
        if (lockControl.failNext) { lockControl.failNext = false; return false; }
        lockControl.acquired++;
        return true;
      },
      releaseLock: () => { lockControl.released++; }
    })
  },
  ScriptApp: { getService: () => ({ getUrl: () => "https://script.google.com/mock" }) },
  ContentService: {
    MimeType: { JSON: "application/json", TEXT: "text/plain" },
    createTextOutput(text) {
      return {
        _text: String(text),
        _mime: "text/plain",
        setMimeType(m) { this._mime = m; return this; },
        getContent() { return this._text; },
        getMimeType() { return this._mime; }
      };
    }
  },
  console: console
};

/** Count sheet reads/writes so tests can assert on round-trip cost. */
const counters = { getValues: 0, setValues: 0, appendRow: 0 };
const origGet = Range.prototype.getValues;
Range.prototype.getValues = function () { counters.getValues++; return origGet.call(this); };
const origSet = Range.prototype.setValues;
Range.prototype.setValues = function (v) { counters.setValues++; return origSet.call(this, v); };
const origApp = Sheet.prototype.appendRow;
Sheet.prototype.appendRow = function (a) { counters.appendRow++; return origApp.call(this, a); };

module.exports = { globals: g, SS, cacheControl, lockControl, counters, propStore, cacheStore };
