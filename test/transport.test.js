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

  console.log("\n--- 5. Every handler answers over HTTP with no credential ---");
  check("bootstrap works unauthenticated", callFn("apiBootstrap").ok === true);
  check("the dashboard is reachable", callFn("apiDashboard", ["30", "all"]).ok === true);
  check("the line list is reachable", callFn("apiListCases", [{}]).ok === true);
  check("the data quality report is reachable", callFn("apiDataQuality").ok === true);
  /* The line list export carries patient names and is served to anyone. This is
     the sharpest edge of the open design, so it is asserted rather than assumed. */
  const openExport = callFn("apiExport", ["linelist", {}]);
  check("the line-list export is served to anyone", openExport.ok === true, openExport);
  check("login handlers are not reachable at all",
    callFn("apiLogin", ["Khandbari Municipality", "TESTME"]).code === "NO_SUCH_METHOD");
  check("nor is logout", callFn("apiLogout", [""]).code === "NO_SUCH_METHOD");

  console.log("\n--- 6. The static page boots straight into the app over fetch() ---");
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
  check("no sign-in gate rendered", !app.$("#gate-palika") && !app.$(".gate"));
  check("the app shell rendered instead", !!app.$(".masthead"), app.text().slice(0, 160));
  check("the palika selector lists all 10",
    !!app.$("#side-palika") && app.$("#side-palika").options.length === 10,
    app.$("#side-palika") && app.$("#side-palika").options.length);
  check("no login went over the wire",
    app.calledFns().indexOf("apiLogin") < 0, app.calledFns());
  check("the dashboard loaded straight away", app.calledFns().indexOf("apiDashboard") >= 0,
    app.calledFns());

  console.log("\n--- 7. The palika choice persists across a page load ---");
  app.setInput("#side-palika", "Panchkhapan Municipality");
  await app.settle(60);
  check("the selection took effect", /Panchkhapan/.test(app.text()), app.text().slice(0, 200));
  check("it was written to localStorage",
    app.win.localStorage.getItem("vbd.palika.v1") === "Panchkhapan Municipality",
    app.win.localStorage.getItem("vbd.palika.v1"));

  const app2 = startWebApp(server, { palika: "Panchkhapan Municipality" });
  await app2.settle(60);
  check("a fresh load comes back to the same palika",
    app2.$("#side-palika") && app2.$("#side-palika").value === "Panchkhapan Municipality",
    app2.$("#side-palika") && app2.$("#side-palika").value);
  check("and it still needed no credential", app2.calledFns().indexOf("apiLogin") < 0);

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

  /*
   * A three-file coupling that is invisible until a deploy fails, and did:
   * Vercel runs `npm run build` automatically whenever package.json has a
   * script by that exact name, whatever vercel.json says — `"buildCommand":
   * null` means "not specified", not "do not build". Our only build step
   * generates Apps Script files, needs scripts/, and .vercelignore removes
   * scripts/ from the deployment. So the build cannot succeed there and must
   * never be attempted. Naming it build:gas is what keeps Vercel out of it.
   */
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const vercelIgnore = fs.readFileSync(path.join(__dirname, "..", ".vercelignore"), "utf8");
  const ignoresScripts = /^\s*scripts\/\s*$/m.test(vercelIgnore);
  check("the Apps Script build step is not named 'build'",
    !pkg.scripts.build,
    "package.json has a `build` script; Vercel will run it on every deploy");
  check("...and it is still wired into npm test under its real name",
    !!pkg.scripts["build:gas"] && /build:gas/.test(pkg.scripts.test), pkg.scripts.test);
  check(".vercelignore keeps scripts/ out of the deployment", ignoresScripts);
  check("no npm script Vercel runs by default depends on an ignored path",
    !pkg.scripts.build && !pkg.scripts.vercelbuild, Object.keys(pkg.scripts).join(", "));

  console.log("\n--- 10b. The emblem ships to both hosting paths ---");
  /* The source logo is ~900 KB at 1920px and is drawn at 56px. It is resized and
     inlined by scripts/make-logo.py; these guard the two ways that goes wrong —
     someone committing the raw file, or the Apps Script shell forgetting to
     include it, which fails silently as a blank square. */
  const logoCss = fs.readFileSync(path.join(__dirname, "..", "public", "logo.css"), "utf8");
  check("logo.css defines .emblem as an inline PNG",
    /\.emblem\s*\{/.test(logoCss) && /data:image\/png;base64,/.test(logoCss));
  check("the inlined emblem stays small enough for a 3G phone",
    logoCss.length < 40 * 1024, Math.round(logoCss.length / 1024) + " KB");
  check("public/index.html loads it", /href="logo\.css"/.test(
    fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8")));
  check("the Apps Script shell includes it", /include\('Logo'\)/.test(
    fs.readFileSync(path.join(dir, "Index.html"), "utf8")));
  check("and the generated partial exists",
    fs.existsSync(path.join(dir, "Logo.html")));
  check("no raw megabyte PNG was committed into public/",
    !fs.existsSync(path.join(__dirname, "..", "public", "logo.png")));

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
