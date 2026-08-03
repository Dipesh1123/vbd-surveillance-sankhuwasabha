/**
 * Util.gs — shared helpers: dates, hashing, IDs, coercion, Bikram Sambat.
 */

var TZ = 'Asia/Kathmandu';

/* ---------------------------------------------------------------- dates -- */

/** Today in the district's own timezone as yyyy-mm-dd (never the server's UTC day). */
function todayIso() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/** Current local timestamp, ISO-ish and sortable as text. */
function nowStamp() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

/** Coerce anything the sheet might hand back into a yyyy-mm-dd string. */
function toIsoDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  return '';
}

/** Whole days from a to b (both yyyy-mm-dd). Positive when b is later. */
function daysBetween(a, b) {
  var da = new Date(a + 'T00:00:00Z').getTime();
  var db = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((db - da) / 86400000);
}

/** Shift a yyyy-mm-dd date by n days. */
function addDays(iso, n) {
  var d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of yyyy-mm-dd from -> to. Capped so a bad range can't hang the script. */
function dateRange(from, to) {
  var out = [];
  var cur = from;
  var guard = 0;
  while (cur <= to && guard++ < 2000) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/* ------------------------------------------------------- Bikram Sambat -- */

var BS_MONTHS_NE = ['बैशाख', 'जेठ', 'असार', 'साउन', 'भदौ', 'असोज', 'कार्तिक', 'मंसिर', 'पुष', 'माघ', 'फागुन', 'चैत'];
var BS_WEEKDAYS_NE = ['आइतबार', 'सोमबार', 'मंगलबार', 'बुधबार', 'बिहीबार', 'शुक्रबार', 'शनिबार'];

/** Western digits -> Devanagari digits. */
function toNepaliDigits(n) {
  return String(n).replace(/[0-9]/g, function (c) { return '०१२३४५६७८९'[Number(c)]; });
}

/**
 * Convert an AD date to a Bikram Sambat display string using the BS_Calendar
 * sheet. Returns the AD date unchanged if it falls outside the loaded table —
 * better a correct Gregorian date than a wrong Nepali one.
 *
 * @param {string} iso   yyyy-mm-dd
 * @param {Array}  table rows of {ad_start, bs_year, bs_month}, ascending
 */
function adToBs(iso, table) {
  if (!iso || !table || !table.length) return iso || '';
  var hit = null;
  for (var i = 0; i < table.length; i++) {
    if (iso >= table[i].ad_start) hit = table[i]; else break;
  }
  if (!hit) return iso;
  // Guard the upper edge: if we are past the last known month start by more than
  // 32 days the table has run out and we cannot be sure of the month.
  if (hit === table[table.length - 1] && daysBetween(hit.ad_start, iso) > 32) return iso;
  var day = daysBetween(hit.ad_start, iso) + 1;
  return toNepaliDigits(day) + ' ' + BS_MONTHS_NE[hit.bs_month - 1] + ' ' + toNepaliDigits(hit.bs_year);
}

/** BS string prefixed with the Nepali weekday. */
function adToBsLong(iso, table) {
  if (!iso) return '';
  var wd = BS_WEEKDAYS_NE[new Date(iso + 'T00:00:00Z').getUTCDay()];
  return wd + ', ' + adToBs(iso, table);
}

/* ------------------------------------------------------------ coercion -- */

/** Non-negative integer or 0. Never NaN, never negative — counts cannot be. */
function toInt(v) {
  var n = parseInt(v, 10);
  return (isNaN(n) || n < 0) ? 0 : n;
}

function toBool(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === 'y';
}

/** Trim, collapse whitespace, strip control chars, and cap length. */
function toText(v, max) {
  if (v === null || v === undefined) return '';
  var s = String(v).replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim();
  var cap = max || 500;
  return s.length > cap ? s.slice(0, cap) : s;
}

/**
 * Strip anything that would make a cell start life as a formula when the sheet
 * is opened or re-imported. Protects against CSV/formula injection.
 */
function safeCell(v) {
  var s = toText(v, 500);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/* -------------------------------------------------------------- crypto -- */

function randomToken(bytes) {
  var n = bytes || 24;
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  var out = '';
  for (var i = 0; i < n; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/** SHA-256(code + ':' + salt) as lowercase hex. */
function hashCode(code, salt) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(code).trim().toUpperCase() + ':' + String(salt),
    Utilities.Charset.UTF_8
  );
  return raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/** Comparison that does not leak how many characters matched. */
function constantTimeEquals(a, b) {
  var x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  var diff = 0;
  for (var i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* ----------------------------------------------------------------- ids -- */

function pulseId(unitId, reportDate) {
  return 'P-' + unitId + '-' + reportDate;
}

/** Case IDs carry the BS year band so they read well on a printed line list. */
function nextCaseId(existingIds) {
  var max = 0;
  (existingIds || []).forEach(function (id) {
    var m = /(\d+)\s*$/.exec(String(id));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  var n = max + 1;
  return 'C-' + ('0000' + n).slice(-4);
}

/* --------------------------------------------------------------- misc --- */

/** One CSV line from an array of values, with escaping + injection guard. */
function csvLine(values) {
  return values.map(function (v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
}

/** Shorten a palika name for narrow tables. */
function shortName(name) {
  return String(name || '').replace(' Rural Municipality', ' RM').replace(' Municipality', ' M');
}

/**
 * An error that is the user's to fix (bad date, wrong code, quota reached) as
 * opposed to a fault in the system. guard_() shows both to the caller but only
 * writes a stack trace to the log for the latter — otherwise routine data-entry
 * mistakes drown out real incidents in Stackdriver.
 */
function userError(message) {
  var e = new Error(message);
  e.userFacing = true;
  return e;
}

