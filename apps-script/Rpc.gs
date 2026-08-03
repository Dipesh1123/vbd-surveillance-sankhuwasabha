/**
 * Rpc.gs — JSON transport, so the frontend can live somewhere other than here.
 *
 * The app is still served from HtmlService at the /exec URL (see Code.gs), and
 * that path still works. This file adds a second door: POST a JSON body of
 * {fn, args} and get back the same {ok, data} | {ok:false, code, error}
 * envelope that google.script.run would have handed the page directly.
 *
 * On CORS, which is the whole reason this is shaped the way it is:
 * an Apps Script web app cannot answer a preflight OPTIONS request and cannot
 * set response headers. So a browser on another origin can only talk to it with
 * a CORS "simple request" — which in practice means a POST whose Content-Type
 * is text/plain. The supported deployment avoids the question entirely by
 * putting a same-origin proxy in front (api/rpc.js), and the client sends
 * text/plain regardless so that a proxy-less deployment also has a chance.
 */

/**
 * Callable methods, by name.
 *
 * Deliberately an allowlist rather than a lookup in the global scope: this
 * project's globals also include provisionEverything and setupDatabase, neither
 * of which should be one HTTP request away from anybody who learns the URL.
 *
 * With no authentication in front of the API, this list is the only thing
 * deciding what the outside world can call. Adding a name here publishes it.
 */
var RPC_METHODS = {
  apiBootstrap: true,
  apiGetPulse: true,
  apiSavePulse: true,
  apiListCases: true,
  apiSaveCase: true,
  apiDeleteCase: true,
  apiSetOutcome: true,
  apiDashboard: true,
  apiExport: true,
  apiDataQuality: true
};

/** Arguments are small; a huge body is either a bug or an attack. */
var RPC_MAX_BODY = 512 * 1024;

function doPost(e) {
  return rpcJsonOut_(rpcDispatch_(e));
}

/**
 * Turn a request into a response envelope. Kept separate from doPost so the
 * test suite can drive it without a ContentService object.
 */
function rpcDispatch_(e) {
  var raw = (e && e.postData && e.postData.contents) || '';
  if (!raw) return rpcFail_('BAD_REQUEST', 'Empty request.');
  if (raw.length > RPC_MAX_BODY) return rpcFail_('BAD_REQUEST', 'Request too large.');

  var req;
  try {
    req = JSON.parse(raw);
  } catch (err) {
    return rpcFail_('BAD_REQUEST', 'Malformed request.');
  }
  if (!req || typeof req !== 'object') return rpcFail_('BAD_REQUEST', 'Malformed request.');

  var gate = rpcCheckSecret_(req);
  if (gate) return gate;

  var fn = req.fn;
  if (typeof fn !== 'string' || !Object.prototype.hasOwnProperty.call(RPC_METHODS, fn)) {
    return rpcFail_('NO_SUCH_METHOD', 'Unknown request.');
  }

  var args = req.args;
  if (args === undefined || args === null) args = [];
  if (!rpcIsArray_(args)) return rpcFail_('BAD_REQUEST', 'Malformed request.');

  var handler = rpcResolve_(fn);
  if (!handler) return rpcFail_('NO_SUCH_METHOD', 'Unknown request.');

  try {
    var out = handler.apply(null, args);
    /* Every api* handler goes through guard_ and returns an envelope already.
       If one ever forgets, wrap it rather than sending a bare value the client
       would read as "the server returned nothing". */
    if (!out || typeof out !== 'object' || !('ok' in out)) return { ok: true, data: out };
    return out;
  } catch (err) {
    console.error('rpc ' + fn + ': ' + (err && err.message) + (err && err.stack ? '\n' + err.stack : ''));
    return rpcFail_('ERROR', 'Something went wrong on the server.');
  }
}

/**
 * Optional shared secret between the hosting proxy and this script.
 *
 * Off unless the script property `api_shared_secret` is set, because a value
 * required here but missing at the proxy would lock every palika out at once.
 * When it is set, knowing the /exec URL is no longer enough to reach the API —
 * useful because that URL travels in deployment notes and browser history.
 */
function rpcCheckSecret_(req) {
  var want;
  try {
    want = PropertiesService.getScriptProperties().getProperty('api_shared_secret') || '';
  } catch (e) {
    want = '';
  }
  if (!want) return null;
  var got = (req && typeof req.secret === 'string') ? req.secret : '';
  if (!constantTimeEquals(got, want)) return rpcFail_('FORBIDDEN', 'This request was not accepted.');
  return null;
}

/*
 * Look the handler up at call time, not at load time. Apps Script evaluates the
 * .gs files in sequence into one shared global scope, so a reference to
 * apiBootstrap taken while this file is loading may still be undefined.
 */
function rpcResolve_(name) {
  var g = (typeof globalThis !== 'undefined') ? globalThis : this;
  var f = g[name];
  return (typeof f === 'function') ? f : null;
}

function rpcFail_(code, message) {
  return { ok: false, code: code, error: message };
}

/* Array.isArray exists on V8, but this also runs under the test harness's
   sandbox where the value may come from another realm. */
function rpcIsArray_(v) {
  return Object.prototype.toString.call(v) === '[object Array]';
}

function rpcJsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
