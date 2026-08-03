/**
 * api/rpc.js — same-origin proxy in front of the Apps Script web app.
 *
 * Why this exists at all: an Apps Script web app cannot answer an OPTIONS
 * preflight and cannot set response headers, so a browser on a different origin
 * can barely talk to it. Routing every call through a function on this site
 * makes the request same-origin, and CORS stops being a question. Two things
 * come free with that: the Apps Script URL never reaches the browser, and there
 * is one place to add a shared secret, a timeout and a size limit.
 *
 * This proxy is deliberately dumb. It does not know what a session is, does not
 * cache, and does not interpret payloads. Authentication and authorisation stay
 * in the Apps Script project, which is the only thing that can see the sheet.
 */
const UPSTREAM = require("./_upstream");

/** Arguments are small. Anything larger is a bug or an attack, not a report. */
const MAX_BODY = 512 * 1024;

/** Apps Script's own ceiling is well under this; leave room for a slow sheet. */
const TIMEOUT_MS = 25000;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "Use POST." });
  }

  let bodyText;
  try {
    bodyText = await readBody(req);
  } catch (e) {
    const tooBig = e && e.code === "TOO_LARGE";
    return send(res, tooBig ? 413 : 400, {
      ok: false,
      code: "BAD_REQUEST",
      error: tooBig ? "That request was too large." : "Malformed request."
    });
  }

  /* Parse here as well as upstream: it costs nothing, and it means an obviously
     broken call never spends an Apps Script invocation. */
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (e) {
    return send(res, 400, { ok: false, code: "BAD_REQUEST", error: "Malformed request." });
  }
  if (!payload || typeof payload !== "object" || typeof payload.fn !== "string") {
    return send(res, 400, { ok: false, code: "BAD_REQUEST", error: "Malformed request." });
  }

  /* The secret is added here, never in the page. Overwrite rather than merge, so
     a client cannot supply its own. */
  if (UPSTREAM.secret) payload.secret = UPSTREAM.secret;
  else delete payload.secret;

  let upstreamText;
  try {
    upstreamText = await callUpstream(JSON.stringify(payload));
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    console.error("rpc proxy: " + (e && e.message));
    return send(res, 504, {
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      error: timedOut
        ? "The server took too long to answer. Please try again."
        : "Could not reach the server. Please try again in a moment."
    });
  }

  /* Only ever relay valid JSON. When Apps Script is mid-deploy or the quota is
     spent it answers with an HTML error page, and forwarding that verbatim
     would put Google's markup — and sometimes the script URL — on the screen. */
  try {
    JSON.parse(upstreamText);
  } catch (e) {
    console.error("rpc proxy: upstream sent non-JSON (" + upstreamText.slice(0, 200) + ")");
    return send(res, 502, {
      ok: false,
      code: "UPSTREAM_BAD_REPLY",
      error: "The server is not responding correctly. Ask the district office to check the system."
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(upstreamText);
};

/**
 * POST to Apps Script and return the response body.
 *
 * Apps Script does not answer a POST directly. It runs doPost, stores the
 * output, and returns a 302 to a script.googleusercontent.com URL that serves
 * it — so the hop after the redirect is a GET with no body. Following redirects
 * explicitly, rather than trusting fetch's defaults, keeps that behaviour
 * visible instead of looking like a bug the first time someone reads this.
 */
async function callUpstream(bodyText) {
  let url = UPSTREAM.url;
  let init = {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: bodyText,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS)
  };

  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch(url, init);
    const location = r.status >= 300 && r.status < 400 && r.headers.get("location");
    if (!location) return await r.text();
    url = new URL(location, url).toString();
    init = { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) };
  }
  throw new Error("upstream redirected too many times");
}

/**
 * Read the request body as text.
 *
 * Vercel's Node runtime sometimes parses the body for us and sometimes leaves
 * the stream untouched, depending on the Content-Type. Once it has parsed, the
 * stream is drained and reading it again yields nothing — so check for a parsed
 * body first and only fall back to the stream.
 */
function readBody(req) {
  if (typeof req.body === "string") return Promise.resolve(req.body);
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString("utf8"));
  if (req.body && typeof req.body === "object") return Promise.resolve(JSON.stringify(req.body));

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const err = new Error("body too large");
        err.code = "TOO_LARGE";
        req.destroy();
        return reject(err);
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
