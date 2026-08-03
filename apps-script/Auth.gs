/**
 * Auth.gs — sessions, roles and rate limiting.
 *
 * Why not Google sign-in? Palika focal persons in the field frequently have no
 * Google account and share a device at the health post. The system therefore
 * authenticates the REPORTING UNIT, not the individual, using a short code the
 * district issues and can revoke. Every write is still attributed and audited.
 *
 * Two roles:
 *   'unit'     — one palika. May submit its own daily return and line-list its
 *                own positive cases. Sees aggregate dashboards for the district.
 *   'district' — surveillance staff. Read/write across all palikas and the only
 *                role that ever receives patient names.
 */

var SESSION_PREFIX = 'sess_';
var ATTEMPT_PREFIX = 'try_';
var MAX_ATTEMPTS = 8;          // per code, per window
var ATTEMPT_WINDOW_SEC = 900;  // 15 minutes

/* ------------------------------------------------------------ sessions -- */

/**
 * Sessions live in TWO places on purpose:
 *
 *   PropertiesService — durable. This is the source of truth.
 *   CacheService      — fast path only.
 *
 * CacheService alone is not safe for this: Google documents it as best-effort
 * and will evict entries before their TTL under memory pressure, which would
 * throw a focal person back to the login screen in the middle of typing a
 * return. It also caps TTL at 6 hours, which would silently contradict the
 * session_hours setting. Expiry is therefore carried INSIDE the payload and
 * enforced on read, so correctness never depends on the cache.
 */

function sessionTtlSeconds() {
  var hours = parseFloat(configGet('session_hours', '10'));
  if (isNaN(hours) || hours <= 0) hours = 10;
  return Math.round(hours * 3600);
}

function sessionKey_(token) { return SESSION_PREFIX + String(token); }

/** Cache writes are always optional — never let one fail a request. */
function cachePut_(key, raw, ttlSeconds) {
  try {
    CacheService.getScriptCache().put(key, raw, Math.max(1, Math.min(ttlSeconds, 21600)));
  } catch (e) { /* cache is a nicety, not a requirement */ }
}

function createSession_(role, unitId, palika) {
  var token = randomToken(32);
  var ttl = sessionTtlSeconds();
  var payload = {
    role: role,
    unit_id: unitId || '',
    palika: palika || '',
    issued: nowStamp(),
    expires: Date.now() + ttl * 1000
  };
  var raw = JSON.stringify(payload);
  PropertiesService.getScriptProperties().setProperty(sessionKey_(token), raw);
  cachePut_(sessionKey_(token), raw, ttl);
  maybePurgeSessions_();
  return { token: token, session: payload };
}

/**
 * Resolve a token to a session. Throws on anything invalid so that API handlers
 * can simply call requireSession() and get on with the real work.
 */
function requireSession(token) {
  if (!token) throw userError('SESSION_EXPIRED');
  var key = sessionKey_(token);

  var raw = null;
  try { raw = CacheService.getScriptCache().get(key); } catch (e) { /* fall through */ }
  if (!raw) raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) throw userError('SESSION_EXPIRED');

  var s;
  try { s = JSON.parse(raw); } catch (e) { throw userError('SESSION_EXPIRED'); }

  if (!s.expires || Date.now() > s.expires) {
    destroySession_(token);
    throw userError('SESSION_EXPIRED');
  }

  // Sliding expiry: an active reporter should not be logged out mid-entry.
  // Only rewrite the durable copy once the session is past halfway, so a busy
  // day of data entry does not burn Properties quota on every keystroke's save.
  var ttl = sessionTtlSeconds();
  var remaining = s.expires - Date.now();
  if (remaining < ttl * 500) {
    s.expires = Date.now() + ttl * 1000;
    var fresh = JSON.stringify(s);
    PropertiesService.getScriptProperties().setProperty(key, fresh);
    cachePut_(key, fresh, ttl);
  } else {
    cachePut_(key, raw, Math.ceil(remaining / 1000));
  }
  return s;
}

function destroySession_(token) {
  var key = sessionKey_(token);
  try { CacheService.getScriptCache().remove(key); } catch (e) {}
  try { PropertiesService.getScriptProperties().deleteProperty(key); } catch (e) {}
}

/** Sweep dead sessions occasionally rather than on a schedule nobody sets up. */
function maybePurgeSessions_() {
  if (Math.random() > 0.05) return;
  purgeExpiredSessions_();
}

function purgeExpiredSessions_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    var now = Date.now();
    var dead = [];
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(SESSION_PREFIX) !== 0) return;
      var s = null;
      try { s = JSON.parse(all[k]); } catch (e) { /* corrupt — drop it */ }
      if (!s || !s.expires || now > s.expires) dead.push(k);
    });
    dead.forEach(function (k) { props.deleteProperty(k); });
    if (dead.length) console.log('purged ' + dead.length + ' expired session(s)');
    return dead.length;
  } catch (e) {
    console.error('session purge failed: ' + e.message);
    return 0;
  }
}

/** District role required — used to gate every route that exposes PII. */
function requireDistrict(token) {
  var s = requireSession(token);
  if (s.role !== 'district') throw userError('DISTRICT_ONLY');
  return s;
}

/**
 * A unit session may only touch its own palika. District may touch any.
 * Returns the unit record the caller is allowed to write to.
 */
function requireWritableUnit(session, palikaOrUnitId) {
  var unit = unitById(palikaOrUnitId) || unitByPalika(palikaOrUnitId);
  if (!unit) throw userError('Unknown palika: ' + palikaOrUnitId);
  if (session.role === 'district') return unit;
  if (session.unit_id !== unit.unit_id) throw userError('NOT_YOUR_PALIKA');
  return unit;
}

/* -------------------------------------------------------- rate limiting -- */

/**
 * Lockout counters are held in PropertiesService, not the cache. A brute-force
 * control that an attacker can reset by waiting for a cache eviction is not a
 * control at all. Volume is trivially small: at most MAX_ATTEMPTS writes per
 * unit per window, and a successful login clears the counter.
 */
function attemptKey_(label) {
  return ATTEMPT_PREFIX + label;
}

function readAttempts_(label) {
  var raw = PropertiesService.getScriptProperties().getProperty(attemptKey_(label));
  if (!raw) return { n: 0, until: 0 };
  var o;
  try { o = JSON.parse(raw); } catch (e) { return { n: 0, until: 0 }; }
  if (!o.until || Date.now() > o.until) return { n: 0, until: 0 };  // window elapsed
  return { n: toInt(o.n), until: o.until };
}

function tooManyAttempts_(label) {
  return readAttempts_(label).n >= MAX_ATTEMPTS;
}

function noteFailedAttempt_(label) {
  var cur = readAttempts_(label);
  var next = {
    n: cur.n + 1,
    // The window starts at the first failure and does not slide, so an attacker
    // cannot keep it open indefinitely by continuing to guess.
    until: cur.until || (Date.now() + ATTEMPT_WINDOW_SEC * 1000)
  };
  PropertiesService.getScriptProperties().setProperty(attemptKey_(label), JSON.stringify(next));
  return next.n;
}

function clearAttempts_(label) {
  try {
    PropertiesService.getScriptProperties().deleteProperty(attemptKey_(label));
  } catch (e) { /* nothing to clear */ }
}

/* ---------------------------------------------------------------- login -- */

/**
 * Log in as a palika reporting unit.
 * @param {string} palikaOrUnit  palika name or unit_id
 * @param {string} code          the access code issued by the district
 */
function apiLogin(palikaOrUnit, code) {
  return guard_(function () {
    var unit = unitById(palikaOrUnit) || unitByPalika(palikaOrUnit);
    if (!unit) throw userError('Select your palika from the list.');

    var label = 'unit:' + unit.unit_id;
    if (tooManyAttempts_(label)) {
      audit(unit.unit_id, 'unit', 'login_blocked', '', 'too many failed attempts');
      throw userError('Too many wrong codes. Wait 15 minutes, or ask the district office to reset your code.');
    }

    if (!unit.code_hash) {
      throw userError('No access code has been issued for ' + unit.palika + ' yet. Ask the district office.');
    }
    var ok = constantTimeEquals(hashCode(code || '', unit.code_salt), unit.code_hash);
    if (!ok) {
      var n = noteFailedAttempt_(label);
      audit(unit.unit_id, 'unit', 'login_failed', '', 'attempt ' + n);
      throw userError('That code is not correct. ' + Math.max(0, MAX_ATTEMPTS - n) + ' attempts left.');
    }

    clearAttempts_(label);
    var made = createSession_('unit', unit.unit_id, unit.palika);
    audit(unit.unit_id, 'unit', 'login', '', unit.palika);
    return {
      token: made.token,
      role: 'unit',
      unit_id: unit.unit_id,
      palika: unit.palika,
      palika_ne: unit.palika_ne
    };
  });
}

/**
 * Log in as district surveillance (unlocks patient names across all palikas).
 */
function apiLoginDistrict(code) {
  return guard_(function () {
    var label = 'district';
    if (tooManyAttempts_(label)) {
      audit('DISTRICT', 'district', 'login_blocked', '', 'too many failed attempts');
      throw userError('Too many wrong codes. Wait 15 minutes before trying again.');
    }

    var hash = configGet('district_code_hash', '');
    var salt = configGet('district_code_salt', '');
    if (!hash) {
      throw userError('No district code is set. In the spreadsheet: VBD Surveillance ▸ Reset district access code.');
    }

    if (!constantTimeEquals(hashCode(code || '', salt), hash)) {
      var n = noteFailedAttempt_(label);
      audit('DISTRICT', 'district', 'login_failed', '', 'attempt ' + n);
      throw userError('That code is not correct. ' + Math.max(0, MAX_ATTEMPTS - n) + ' attempts left.');
    }

    clearAttempts_(label);
    var made = createSession_('district', '', '');
    audit('DISTRICT', 'district', 'login', '', 'line list unlocked');
    return { token: made.token, role: 'district', unit_id: '', palika: '' };
  });
}

function apiLogout(token) {
  try {
    if (token) {
      var s = requireSession(token);
      audit(s.unit_id || 'DISTRICT', s.role, 'logout', '', '');
    }
  } catch (e) { /* already expired — still destroy the token below */ }
  if (token) destroySession_(token);
  return { ok: true };
}

/* ---------------------------------------------------------------- guard -- */

/**
 * Wrap every API entry point. Converts thrown errors into a shape the client can
 * render, and keeps internal details (stack traces, sheet names) off the wire.
 */
function guard_(fn) {
  try {
    var data = fn();
    return { ok: true, data: data };
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    var known = {
      SESSION_EXPIRED: 'Your session has ended. Please sign in again.',
      DISTRICT_ONLY: 'This screen is for district surveillance staff only.',
      NOT_YOUR_PALIKA: 'You can only enter data for your own palika.'
    };
    if (known[msg]) return { ok: false, code: msg, error: known[msg] };
    // A data-entry mistake is not an incident: log it as a plain line so real
    // faults still stand out with a stack trace in the execution log.
    if (e && e.userFacing) console.log('user error: ' + msg);
    else console.error(msg + (e && e.stack ? '\n' + e.stack : ''));
    return { ok: false, code: e && e.userFacing ? 'INVALID' : 'ERROR', error: msg };
  }
}
