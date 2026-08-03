/* The Vercel function that every hosted request passes through.
 *
 * Worth testing on its own because it is the single point of failure for all
 * ten palikas, and because the interesting part — Apps Script answering a POST
 * with a 302 to a different host, where the real body lives — is invisible
 * until it is in production and wrong.
 *
 * Run:  node test/proxy.test.js                                              */
const path = require("path");
const { makeChecker } = require("./harness");

const { check, finish } = makeChecker();

const UPSTREAM_URL =
  "https://script.google.com/macros/s/AKfycbTESTdeploymentIDforUnitTests/exec";
process.env.APPS_SCRIPT_URL = UPSTREAM_URL;

const rpc = require(path.join(__dirname, "..", "api", "rpc.js"));
const health = require(path.join(__dirname, "..", "api", "health.js"));

/* --- fakes ---------------------------------------------------------------- */

/** A req that already has a parsed body, the common Vercel case. */
function req(body, method) {
  return {
    method: method || "POST",
    body: body,
    on() { throw new Error("stream should not be read when req.body is set"); }
  };
}

/** A req that only exposes a stream, the other Vercel case. */
function streamReq(text, method) {
  const listeners = {};
  const r = {
    method: method || "POST",
    on(ev, fn) { listeners[ev] = fn; return r; },
    destroy() { r.destroyed = true; }
  };
  setImmediate(() => {
    if (listeners.data) listeners.data(Buffer.from(text, "utf8"));
    if (listeners.end) listeners.end();
  });
  return r;
}

function res() {
  return {
    statusCode: 0, headers: {}, body: "",
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(s) { this.body = s === undefined ? "" : String(s); this.done = true; }
  };
}

/** Scripted responses for global.fetch, consumed in order. */
let script = [];
let seen = [];
global.fetch = function (url, init) {
  seen.push({ url: String(url), method: (init && init.method) || "GET", body: init && init.body });
  const next = script.shift();
  if (!next) return Promise.reject(new Error("no scripted response for " + url));
  if (next.throw) return Promise.reject(next.throw);
  return Promise.resolve({
    status: next.status || 200,
    headers: { get: k => (next.headers || {})[k.toLowerCase()] || null },
    text: () => Promise.resolve(next.body === undefined ? "" : next.body)
  });
};
function scriptFetch(list) { script = list.slice(); seen = []; }

const ok = JSON.stringify({ ok: true, data: { hello: "world" } });
const CALL = JSON.stringify({ fn: "apiBootstrap", args: [""] });

(async function main() {
  console.log("\n--- 1. Only POST is accepted ---");
  for (const m of ["GET", "PUT", "DELETE", "OPTIONS"]) {
    const r = res();
    scriptFetch([]);
    await rpc(req(CALL, m), r);
    check(m + " is refused with 405", r.statusCode === 405, r.statusCode);
    check(m + " never reaches Apps Script", seen.length === 0, seen.length);
  }
  {
    const r = res();
    scriptFetch([]);
    await rpc(req(CALL, "GET"), r);
    check("a refusal still names the allowed method", r.headers.allow === "POST", r.headers);
  }

  console.log("\n--- 2. Bad input is rejected before spending an Apps Script call ---");
  for (const [label, body] of [
    ["non-JSON", "hello"],
    ["a bare array", "[1,2,3]"],
    ["null", "null"],
    ["no fn", '{"args":[]}'],
    ["a non-string fn", '{"fn":7}']
  ]) {
    const r = res();
    scriptFetch([]);
    await rpc(req(body), r);
    check(label + " gives 400", r.statusCode === 400, r.statusCode + " " + r.body);
    check(label + " does not call upstream", seen.length === 0);
    check(label + " still answers with JSON", JSON.parse(r.body).ok === false);
  }

  console.log("\n--- 3. A normal call is forwarded and relayed back ---");
  {
    const r = res();
    scriptFetch([{ status: 200, body: ok }]);
    await rpc(req(CALL), r);
    check("status is 200", r.statusCode === 200, r.statusCode);
    check("the envelope is passed through untouched", r.body === ok, r.body);
    check("content-type is JSON", /application\/json/.test(r.headers["content-type"]));
    check("the answer is never cached", r.headers["cache-control"] === "no-store");
    check("it POSTed to the configured upstream",
      seen[0].url === UPSTREAM_URL && seen[0].method === "POST", seen[0]);
    check("the body reached Apps Script intact",
      JSON.parse(seen[0].body).fn === "apiBootstrap", seen[0].body);
  }

  console.log("\n--- 4. Apps Script's POST-then-302-to-another-host dance ---");
  {
    const contentUrl = "https://script.googleusercontent.com/macros/echo?user_content_key=abc";
    const r = res();
    scriptFetch([
      { status: 302, headers: { location: contentUrl } },
      { status: 200, body: ok }
    ]);
    await rpc(req(CALL), r);
    check("the redirect is followed", seen.length === 2, seen.length);
    check("the second hop goes to the content host", seen[1].url === contentUrl, seen[1].url);
    check("the second hop is a GET with no body",
      seen[1].method === "GET" && !seen[1].body, seen[1]);
    check("the real body is returned to the browser", r.body === ok, r.body);
    check("status is 200, not the 302", r.statusCode === 200, r.statusCode);
  }
  {
    const r = res();
    scriptFetch([
      { status: 302, headers: { location: "/relative/hop" } },
      { status: 200, body: ok }
    ]);
    await rpc(req(CALL), r);
    check("a relative Location is resolved against the current URL",
      seen[1].url === "https://script.google.com/relative/hop", seen[1].url);
  }
  {
    const r = res();
    scriptFetch(Array.from({ length: 8 }, () => (
      { status: 302, headers: { location: "https://script.googleusercontent.com/loop" } })));
    await rpc(req(CALL), r);
    check("a redirect loop gives up rather than hanging", r.statusCode === 504, r.statusCode);
    check("it stops after a handful of hops", seen.length <= 5, seen.length);
  }

  console.log("\n--- 5. Upstream trouble becomes a plain message, never raw HTML ---");
  {
    const r = res();
    scriptFetch([{ status: 200, body: "<!DOCTYPE html><html>Sorry, unable to open the file…</html>" }]);
    await rpc(req(CALL), r);
    check("an HTML reply gives 502", r.statusCode === 502, r.statusCode);
    check("no markup is relayed", !/DOCTYPE|<html/.test(r.body), r.body);
    check("the reply is still a usable envelope", JSON.parse(r.body).ok === false);
    check("the message is readable", /not responding correctly/i.test(JSON.parse(r.body).error));
  }
  {
    const r = res();
    const boom = new Error("The operation was aborted due to timeout");
    boom.name = "TimeoutError";
    scriptFetch([{ throw: boom }]);
    await rpc(req(CALL), r);
    check("a timeout gives 504", r.statusCode === 504, r.statusCode);
    check("the user is told to try again", /try again/i.test(JSON.parse(r.body).error),
      r.body);
  }
  {
    const r = res();
    scriptFetch([{ throw: new Error("getaddrinfo ENOTFOUND script.google.com") }]);
    await rpc(req(CALL), r);
    check("a DNS failure gives 504", r.statusCode === 504, r.statusCode);
    check("the internal error text does not leak", !/ENOTFOUND/.test(r.body), r.body);
  }

  console.log("\n--- 6. The body is read whichever way the runtime hands it over ---");
  {
    const r = res();
    scriptFetch([{ status: 200, body: ok }]);
    await rpc(streamReq(CALL), r);
    check("an unparsed stream is read", r.statusCode === 200, r.statusCode + " " + r.body);
    check("and forwarded correctly", JSON.parse(seen[0].body).fn === "apiBootstrap");
  }
  {
    const r = res();
    scriptFetch([{ status: 200, body: ok }]);
    await rpc(req({ fn: "apiBootstrap", args: [""] }), r);
    check("an already-parsed object body works too", r.statusCode === 200, r.body);
  }
  {
    const r = res();
    scriptFetch([{ status: 200, body: ok }]);
    await rpc(req(Buffer.from(CALL, "utf8")), r);
    check("a Buffer body works too", r.statusCode === 200, r.body);
  }
  {
    const r = res();
    scriptFetch([]);
    await rpc(streamReq('{"fn":"apiBootstrap","args":["' + "x".repeat(600 * 1024) + '"]}'), r);
    check("an oversized stream is cut off with 413", r.statusCode === 413, r.statusCode);
    check("nothing is forwarded upstream", seen.length === 0);
  }

  console.log("\n--- 7. The shared secret is added by the proxy, never by the page ---");
  {
    const r = res();
    scriptFetch([{ status: 200, body: ok }]);
    await rpc(req(CALL), r);
    check("no secret is sent when none is configured",
      !("secret" in JSON.parse(seen[0].body)), seen[0].body);
  }
  {
    const r = res();
    scriptFetch([{ status: 200, body: ok }]);
    await rpc(req(JSON.stringify({ fn: "apiBootstrap", args: [""], secret: "i-made-this-up" })), r);
    check("a client-supplied secret is stripped, not forwarded",
      !("secret" in JSON.parse(seen[0].body)), seen[0].body);
  }

  console.log("\n--- 8. Misconfiguration fails loudly at startup, not mysteriously later ---");
  {
    let threw = null;
    const saved = process.env.APPS_SCRIPT_URL;
    process.env.APPS_SCRIPT_URL = "https://example.com/not-apps-script";
    delete require.cache[require.resolve(path.join(__dirname, "..", "api", "_upstream.js"))];
    try { require(path.join(__dirname, "..", "api", "_upstream.js")); }
    catch (e) { threw = e; }
    process.env.APPS_SCRIPT_URL = saved;
    delete require.cache[require.resolve(path.join(__dirname, "..", "api", "_upstream.js"))];
    check("a URL that is not an Apps Script web app is rejected on import", !!threw);
    check("the error says what was expected", threw && /macros\/s/.test(threw.message), threw && threw.message);
  }

  console.log("\n--- 9. The health endpoint reports without giving the URL away ---");
  {
    const r = res();
    health({ method: "GET" }, r);
    const h = JSON.parse(r.body);
    check("it answers 200", r.statusCode === 200, r.statusCode);
    check("it names the service", h.service === "vbd-surveillance-proxy", h);
    check("it says which host is upstream", h.upstreamHost === "script.google.com", h);
    check("it does not print the full deployment id",
      !r.body.includes("AKfycbTESTdeploymentIDforUnitTests"), r.body);
    check("but shows enough to tell deployments apart", /…/.test(h.upstreamDeployment), h);
    check("it reports whether the shared secret is on", h.sharedSecret === "off", h);
    check("it is not indexable", /noindex/.test(r.headers["x-robots-tag"] || ""));
  }

  finish();
})().catch(err => {
  console.error("\nHARNESS ERROR: " + err.stack);
  process.exit(1);
});
