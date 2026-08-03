/* The hosted path, end to end.
 *
 * frontend.test.js proves the client works when Apps Script serves it and
 * google.script.run is available. This file proves the same client works when
 * it is a static file on Vercel and every call is JSON over HTTP — a different
 * transport, a different failure surface, and the one real users will be on.
 *
 * The server side here is the actual Rpc.gs dispatcher over the actual backend.
 * Nothing about the API is stubbed; only the network hop is.
 *
 * Run:  node test/transport.test.js apps-script                              */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { globals } = require("./gasmock");
const { startServer, startWebApp, makeChecker, API_NAMES } = require("./harness");

const dir = process.argv[2] || "apps-script";
const { check, finish } = makeChecker();

const server = startServer(dir, globals);
server.run(`
  ['U03','U05'].forEach(function (id) {
    var u = findByKey('Units','unit_id',id);
    var salt = randomToken(16);
    updateRowAt('Units', u._row, Object.assign({}, u, {
      code_hash: hashCode('TESTME', salt), code_salt: salt }));
  });
  var ds = randomToken(16);
  configSet('district_code_salt', ds);
  configSet('district_code_hash', hashCode('DISTRICT99', ds));
  resetCaches();
`);

/** Post a raw body straight at the dispatcher, bypassing the client. */
function post(body) {
  server.ctx.__e = { postData: { contents: body, type: "text/plain" } };
  return vm.runInContext("rpcDispatch_(__e)", server.ctx);
}
function callFn(fn, args) {
  return post(JSON.stringify({ fn: fn, args: args || [] }));
}

(async function main() {
  console.log("\n--- 1. The dispatcher rejects malformed and hostile requests ---");
  check("empty body is refused", post("").ok === false);
  check("non-JSON body is refused", post("not json at all").ok === false);
  check("a JSON scalar is refused", post('"hello"').ok === false);
  check("a missing fn is refused", post('{"args":[]}').ok === false);
  check("a non-string fn is refused", post('{"fn":123,"args":[]}').ok === false);
  check("non-array args are refused", post('{"fn":"apiBootstrap","args":"token"}').ok === false);
  check("an oversized body is refused",
    post('{"fn":"apiBootstrap","args":["' + "x".repeat(600 * 1024) + '"]}').ok === false);
  check("omitted args default to none", callFn("apiBootstrap").ok === true);

  console.log("\n--- 2. Only allowlisted handlers are reachable ---");
  /* The point of the allowlist. These are real functions in the same global
     scope, one HTTP request away from anyone who learns the URL. */
  for (const forbidden of ["provisionEverything", "setupDatabase", "issueAllCodes",
    "setDistrictCode", "dataQualityReport", "doGet", "configSet", "readAll"]) {
    const r = callFn(forbidden, []);
    check("refuses " + forbidden, r.ok === false && r.code === "NO_SUCH_METHOD", r);
  }
  check("refuses a name that does not exist at all",
    callFn("apiNoSuchThing", []).code === "NO_SUCH_METHOD");
  check("prototype keys are not treated as methods",
    callFn("constructor", []).code === "NO_SUCH_METHOD");
  check("toString is not dispatchable", callFn("toString", []).code === "NO_SUCH_METHOD");

  const allowed = vm.runInContext("Object.keys(RPC_METHODS)", server.ctx);
  check("every client-facing handler is allowlisted",
    API_NAMES.every(n => allowed.indexOf(n) >= 0),
    API_NAMES.filter(n => allowed.indexOf(n) < 0).join(", "));
  check("the allowlist adds nothing beyond them",
    allowed.every(n => API_NAMES.indexOf(n) >= 0),
    allowed.filter(n => API_NAMES.indexOf(n) < 0).join(", "));

  console.log("\n--- 3. doPost wraps the envelope as JSON for the wire ---");
  server.ctx.__e = { postData: { contents: JSON.stringify({ fn: "apiBootstrap", args: [""] }) } };
  const out = vm.runInContext("doPost(__e)", server.ctx);
  check("doPost returns a ContentService output", !!out && typeof out.getContent === "function");
  check("its mime type is JSON", out.getMimeType() === "application/json", out.getMimeType());
  const parsed = JSON.parse(out.getContent());
  check("its body parses as the envelope", parsed.ok === true && !!parsed.data, out.getContent().slice(0, 120));
  check("the payload survives JSON round-tripping intact",
    Array.isArray(parsed.data.units) && parsed.data.units.length === 10,
    parsed.data && parsed.data.units && parsed.data.units.length);

  console.log("\n--- 4. The shared secret, when configured, gates everything ---");
  check("calls pass while no secret is set", callFn("apiBootstrap", [""]).ok === true);
  vm.runInContext("PropertiesService.getScriptProperties().setProperty('api_shared_secret','s3cret')",
    server.ctx);
  check("a call with no secret is now refused",
    callFn("apiBootstrap", [""]).code === "FORBIDDEN");
  check("a call with the wrong secret is refused",
    post('{"fn":"apiBootstrap","args":[""],"secret":"nope"}').code === "FORBIDDEN");
  check("a call with the right secret passes",
    post('{"fn":"apiBootstrap","args":[""],"secret":"s3cret"}').ok === true);
  check("the secret gates the allowlist too, so it cannot be probed",
    post('{"fn":"provisionEverything","args":[]}').code === "FORBIDDEN");
  vm.runInContext("PropertiesService.getScriptProperties().deleteProperty('api_shared_secret')",
    server.ctx);
  check("removing it restores normal access", callFn("apiBootstrap", [""]).ok === true);

  console.log("\n--- 5. A real session works over HTTP, start to finish ---");
  const login = callFn("apiLogin", ["Khandbari Municipality", "TESTME"]);
  check("login succeeds", login.ok === true, login.error);
  const token = login.ok && login.data.token;
  check("a token comes back", !!token);
  check("bootstrap with that token reports a session",
    callFn("apiBootstrap", [token]).data.session !== null);
  check("a wrong code is still refused over HTTP",
    callFn("apiLogin", ["Madi Municipality", "NOPE12"]).ok === false);
  check("the dashboard is reachable", callFn("apiDashboard", [token, "30", "all"]).ok === true);
  check("logout is accepted", callFn("apiLogout", [token]).ok === true);
  check("the token is dead afterwards",
    callFn("apiDashboard", [token, "30", "all"]).code === "SESSION_EXPIRED");

  console.log("\n--- 6. The static page boots and signs in over fetch() ---");
  const app = startWebApp(server, {});
  await app.settle(60);
  check("no uncaught errors reaching the DOM", app.errors.length === 0, app.errors.join(" | "));
  check("it never touched google.script.run",
    typeof app.win.google === "undefined");
  check("the first call went to the configured proxy path",
    app.requests.length > 0 && app.requests[0].url === "/api/rpc",
    app.requests[0] && app.requests[0].url);
  check("it POSTs", app.requests[0].method === "POST", app.requests[0].method);
  check("Content-Type is text/plain, so no CORS preflight is triggered",
    /^text\/plain/.test((app.requests[0].headers || {})["Content-Type"] || ""),
    (app.requests[0].headers || {})["Content-Type"]);
  check("it bootstrapped", app.calledFns()[0] === "apiBootstrap", app.calledFns());
  check("the sign-in gate rendered", !!app.$("#gate-palika"));
  check("all 10 palikas are listed", app.$("#gate-palika").options.length === 10);

  app.setInput("#gate-palika", "Khandbari Municipality");
  app.setInput("#gate-code", "TESTME");
  app.click('[data-act="login-unit"]');
  await app.settle(60);
  check("signing in over HTTP works", !app.$("#gate-palika"), app.text().slice(0, 160));
  check("the palika name is on screen", /Khandbari/.test(app.text()), app.text().slice(0, 160));
  check("apiLogin went over the wire", app.calledFns().indexOf("apiLogin") >= 0, app.calledFns());
  check("the dashboard loaded straight after", app.calledFns().indexOf("apiDashboard") >= 0,
    app.calledFns());

  console.log("\n--- 7. A wrong code over HTTP fails the same way it does on Apps Script ---");
  const app2 = startWebApp(server, {});
  await app2.settle(60);
  app2.setInput("#gate-palika", "Panchkhapan Municipality");
  app2.setInput("#gate-code", "WRONGX");
  app2.click('[data-act="login-unit"]');
  await app2.settle(60);
  check("still on the gate", !!app2.$("#gate-palika"));
  check("the message says the code is wrong", /not correct/i.test(app2.text()),
    app2.text().slice(0, 200));
  check("the palika choice survived", app2.$("#gate-palika").value === "Panchkhapan Municipality");

  console.log("\n--- 8. Network failure is reported in plain language ---");
  const app3 = startWebApp(server, { offline: true });
  await app3.settle(60);
  check("an unreachable server does not throw into the page",
    app3.errors.length === 0, app3.errors.join(" | "));
  check("the user is told something they can act on",
    /could not|connection|try again|reach/i.test(app3.text()), app3.text().slice(0, 240));
  check("it does not show a raw fetch error", !/Failed to fetch/.test(app3.text()),
    app3.text().slice(0, 240));

  console.log("\n--- 9. A non-JSON reply (Google error page) is handled, not rendered ---");
  const app4 = startWebApp(server, { mangleReply: true });
  await app4.settle(60);
  check("no crash on an HTML reply", app4.errors.length === 0, app4.errors.join(" | "));
  check("Google's markup never reaches the screen", !/DOCTYPE|Google error page/.test(app4.text()),
    app4.text().slice(0, 240));
  check("the user still gets a readable message",
    /could not read|something went wrong|could not|try again/i.test(app4.text()),
    app4.text().slice(0, 240));

  console.log("\n--- 10. The proxy and the page agree on where the API lives ---");
  const cfg = fs.readFileSync(path.join(__dirname, "..", "public", "config.js"), "utf8");
  const apiUrl = (cfg.match(/apiUrl:\s*'([^']+)'/) || [])[1];
  check("config.js declares an apiUrl", !!apiUrl, apiUrl);
  check("it points at the bundled proxy", apiUrl === "/api/rpc", apiUrl);
  check("a function exists to serve it",
    fs.existsSync(path.join(__dirname, "..", "api", "rpc.js")));
  check("vercel.json does not rewrite that path out from under it",
    !/\"rewrites\"/.test(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8")));

  console.log("\n--- 11. The generated Apps Script copy is in step with public/ ---");
  const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const appHtml = fs.readFileSync(path.join(dir, "App.html"), "utf8");
  check("App.html is the wrapped form of app.js",
    appHtml === "<script>\n" + appJs.replace(/\n+$/, "") + "\n</script>\n");
  check("the client still supports both transports",
    /TRANSPORT\s*===\s*'gas'/.test(appJs) && /TRANSPORT\s*===\s*'http'|httpCall\(/.test(appJs));

  finish();
})().catch(err => {
  console.error("\nHARNESS ERROR: " + err.stack);
  process.exit(1);
});
