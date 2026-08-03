/**
 * Repo.gs — the data-access layer.
 *
 * Nothing else in the project talks to SpreadsheetApp directly. Every read and
 * write goes through here so that column order, type coercion, caching and
 * locking are handled in exactly one place.
 *
 * Design notes for whoever maintains this:
 *  - Reads are whole-sheet + in-memory filter. At district scale (10 palikas x
 *    365 days ≈ 3,650 pulse rows/year) that is a single getValues() call and is
 *    far faster than per-row lookups.
 *  - Writes take a document lock. Two focal persons submitting at the same
 *    second must not interleave and corrupt a row.
 *  - Row numbers are never cached across calls — a human may sort the sheet by
 *    hand at any time, so we always re-locate by primary key.
 */

var _bookCache = null;

function book() {
  if (!_bookCache) _bookCache = SpreadsheetApp.getActiveSpreadsheet();
  return _bookCache;
}

function sheetFor(name) {
  var sh = book().getSheetByName(name);
  if (!sh) {
    throw new Error(
      'The database has not been built yet (sheet "' + name + '" is missing).\n\n' +
      'Run the function  provisionEverything  once — from the Apps Script editor\'s\n' +
      'Run button, or from the spreadsheet menu: VBD Surveillance ▸ Set up / repair database.\n\n' +
      'Note: apiBootstrap is NOT the setup function — it is what the web page calls ' +
      'to load its data, and it needs the database to already exist.'
    );
  }
  return sh;
}

/** Which schema sheets do not exist yet. Empty array means fully provisioned. */
function missingSheets() {
  var b = book();
  return Object.keys(SCHEMA).filter(function (name) { return !b.getSheetByName(name); });
}

/* ------------------------------------------------------- request cache --- */

/**
 * Per-execution memo of whole sheets and header rows.
 *
 * This matters more than it looks. Saving one case naturally wants to read
 * Cases (for the ID sequence), Pulses (for the declared count) and Cases again
 * (to count what is already line-listed) — and every write re-reads the header
 * row. That is four or five full getValues() round trips, three of them while
 * the document lock is held. With a year of data behind it, ten palikas all
 * submitting before the 5 PM deadline would queue past the 20-second lock
 * timeout and start seeing "the system is busy".
 *
 * Apps Script gives every request a fresh global scope, so memoising here is
 * safe: the memo cannot outlive the request that filled it. Writes invalidate
 * the affected table so a read after a write is never stale.
 */
var _tableCache = {};
var _headerCache = {};

function invalidateTable(name) {
  delete _tableCache[name];
}

/** Header row as an array of column names. */
function headersOf(name) {
  if (_headerCache[name]) return _headerCache[name];
  var sh = sheetFor(name);
  var lastCol = sh.getLastColumn();
  if (lastCol === 0) return [];
  var hdrs = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  _headerCache[name] = hdrs;
  return hdrs;
}

/**
 * Read a whole sheet as an array of typed objects.
 * Coercion is driven by SCHEMA so the rest of the code never sees a raw Date
 * object or a numeric string where an int is expected.
 */
function readAll(name) {
  if (_tableCache[name]) return _tableCache[name];
  var rows = readAllUncached_(name);
  _tableCache[name] = rows;
  return rows;
}

function readAllUncached_(name) {
  var def = SCHEMA[name];
  var sh = sheetFor(name);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];

  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });

  var typeOf = {};
  def.columns.forEach(function (c) { typeOf[c.name] = c.type; });

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    // Skip fully blank rows left behind by manual deletion.
    var blank = true;
    for (var c = 0; c < row.length; c++) {
      if (row[c] !== '' && row[c] !== null) { blank = false; break; }
    }
    if (blank) continue;

    var obj = { _row: r + 1 };
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      if (!h) continue;
      var v = row[i];
      switch (typeOf[h]) {
        case 'int':      obj[h] = toInt(v); break;
        case 'bool':     obj[h] = toBool(v); break;
        case 'date':     obj[h] = toIsoDate(v); break;
        case 'datetime': obj[h] = (v instanceof Date) ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss') : String(v || ''); break;
        default:         obj[h] = (v === null || v === undefined) ? '' : String(v);
      }
    }
    out.push(obj);
  }
  return out;
}

/** Turn an object into a row array in the sheet's real column order. */
function toRowArray(name, obj) {
  var headers = headersOf(name);
  var def = SCHEMA[name];
  var typeOf = {};
  def.columns.forEach(function (c) { typeOf[c.name] = c.type; });

  return headers.map(function (h) {
    if (!h) return '';
    var v = obj[h];
    if (v === undefined || v === null) return '';
    switch (typeOf[h]) {
      case 'int':  return toInt(v);
      case 'bool': return toBool(v);
      case 'date': return toIsoDate(v);
      default:     return safeCell(v);
    }
  });
}

/** Append one object as a new row. Returns the object unchanged. */
function insertRow(name, obj) {
  var sh = sheetFor(name);
  sh.appendRow(toRowArray(name, obj));
  invalidateTable(name);
  return obj;
}

/** Overwrite the row at 1-based sheet row number. */
function updateRowAt(name, rowNumber, obj) {
  var sh = sheetFor(name);
  var arr = toRowArray(name, obj);
  sh.getRange(rowNumber, 1, 1, arr.length).setValues([arr]);
  invalidateTable(name);
  return obj;
}

/**
 * Insert-or-update by primary key. Safe under concurrency: the caller must
 * already hold the document lock (see withLock).
 */
function upsertByKey(name, keyField, obj) {
  var rows = readAll(name);
  var keyVal = String(obj[keyField]);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyField]) === keyVal) {
      // Merge so callers can send partial updates.
      var merged = {};
      Object.keys(rows[i]).forEach(function (k) { if (k !== '_row') merged[k] = rows[i][k]; });
      Object.keys(obj).forEach(function (k) { merged[k] = obj[k]; });
      updateRowAt(name, rows[i]._row, merged);
      return { row: merged, created: false };
    }
  }
  insertRow(name, obj);
  return { row: obj, created: true };
}

function findByKey(name, keyField, keyVal) {
  var rows = readAll(name);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][keyField]) === String(keyVal)) return rows[i];
  }
  return null;
}

/**
 * Run fn while holding the document lock. Every mutating API call is wrapped in
 * this — without it two simultaneous submissions can both read "no row yet" and
 * both append, producing a duplicate daily return.
 */
function withLock(fn) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) {
    throw userError('The system is busy saving another report. Please try again in a few seconds.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------- config ---- */

/** Config sheet as a plain key -> value object (cached for the request). */
var _configCache = null;
function config() {
  if (_configCache) return _configCache;
  var out = {};
  readAll('Config').forEach(function (r) {
    if (r.key) out[r.key] = r.value;
  });
  _configCache = out;
  return out;
}

function configGet(key, fallback) {
  var v = config()[key];
  return (v === undefined || v === '') ? fallback : v;
}

function configSet(key, value) {
  _configCache = null;
  upsertByKey('Config', 'key', { key: key, value: String(value) });
}

/* -------------------------------------------------------------- units ---- */

var _unitsCache = null;
function units() {
  if (!_unitsCache) {
    _unitsCache = readAll('Units').filter(function (u) { return u.unit_id && u.active !== false; });
  }
  return _unitsCache;
}

function unitById(id) {
  var all = units();
  for (var i = 0; i < all.length; i++) if (all[i].unit_id === id) return all[i];
  return null;
}

function unitByPalika(name) {
  var all = units();
  for (var i = 0; i < all.length; i++) if (all[i].palika === name) return all[i];
  return null;
}

/**
 * The palika a request is acting on, by name or unit_id.
 *
 * With no sessions there is nothing to check this against — whoever is asking
 * may write to any palika. It exists to turn whatever the browser sent into a
 * real Units row, and to fail clearly when it does not name one, rather than
 * writing a row attributed to a palika that does not exist.
 */
function resolveUnit(palikaOrUnitId) {
  var unit = unitById(palikaOrUnitId) || unitByPalika(palikaOrUnitId);
  if (!unit) throw userError('Select a palika before saving.');
  return unit;
}

/** Names only, in sheet order — the canonical palika list for the UI. */
function palikaNames() {
  return units().map(function (u) { return u.palika; });
}

/* -------------------------------------------------------- BS calendar ---- */

var _bsCache = null;
function bsTable() {
  if (!_bsCache) {
    _bsCache = readAll('BS_Calendar')
      .filter(function (r) { return r.ad_start && r.bs_year && r.bs_month; })
      .map(function (r) { return { ad_start: r.ad_start, bs_year: r.bs_year, bs_month: r.bs_month }; })
      .sort(function (a, b) { return a.ad_start < b.ad_start ? -1 : a.ad_start > b.ad_start ? 1 : 0; });
  }
  return _bsCache;
}

/* -------------------------------------------------------------- audit ---- */

/**
 * Append-only audit trail. Deliberately never throws: an audit failure must not
 * cost a health worker their data entry. Failures go to the execution log.
 */
function audit(actor, role, action, entityId, detail) {
  try {
    sheetFor('Audit').appendRow([
      nowStamp(),
      safeCell(actor || 'anonymous'),
      safeCell(role || ''),
      safeCell(action || ''),
      safeCell(entityId || ''),
      safeCell(detail || ''),
      ''
    ]);
    invalidateTable('Audit');
  } catch (e) {
    console.error('audit failed: ' + e.message);
  }
}

/** Drop the per-request caches (used by Setup after rebuilding the workbook). */
function resetCaches() {
  _bookCache = null;
  _configCache = null;
  _unitsCache = null;
  _bsCache = null;
  _tableCache = {};
  _headerCache = {};
}
