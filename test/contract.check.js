// Cross-check client<->server contract and internal helper references.
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
const gsFiles = fs.readdirSync(dir).filter(f => f.endsWith(".gs"));
const serverSrc = gsFiles.map(f => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
const app = fs.readFileSync(path.join(dir, "App.html"), "utf8");

// 1. Server function names
const serverFns = new Set();
for (const m of serverSrc.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)) serverFns.add(m[1]);

// 2. Client rpc('name', ...), gasCall/httpCall('name', ...), google.script.run.name(...)
const called = new Set();
for (const m of app.matchAll(/\brpc\(\s*'([A-Za-z0-9_$]+)'/g)) called.add(m[1]);
for (const m of app.matchAll(/\b(?:gasCall|httpCall)\(\s*'([A-Za-z0-9_$]+)'/g)) called.add(m[1]);
for (const m of app.matchAll(/google\.script\.run\.([A-Za-z0-9_$]+)\s*\(/g)) called.add(m[1]);

console.log("=== Client -> Server RPC contract ===");
let bad = 0;
[...called].sort().forEach(fn => {
  const ok = serverFns.has(fn);
  if (!ok) bad++;
  console.log((ok ? "  OK   " : "  MISS ") + fn);
});

// 3. Server-side internal calls -> are they defined anywhere?
const BUILTINS = new Set(["if","for","while","switch","catch","function","return","typeof","new",
  "String","Number","Object","Array","Math","JSON","Date","Boolean","parseInt","parseFloat","isNaN",
  "console","SpreadsheetApp","Utilities","CacheService","LockService","ScriptApp","HtmlService",
  "ContentService","MailApp","Error","RegExp","Promise","Set","Map","decodeURIComponent","encodeURIComponent"]);
const internal = new Set();
for (const m of serverSrc.matchAll(/\b([a-z][A-Za-z0-9_$]*_?)\s*\(/g)) internal.add(m[1]);

console.log("\n=== Undefined server-side helpers (excluding builtins/methods) ===");
let undef = [];
[...internal].sort().forEach(fn => {
  if (BUILTINS.has(fn)) return;
  if (serverFns.has(fn)) return;
  // ignore things that are clearly method calls (preceded by a dot) everywhere
  const bare = new RegExp("(^|[^.\\w])" + fn.replace(/\$/g, "\\$") + "\\s*\\(", "m");
  if (!bare.test(serverSrc)) return;
  undef.push(fn);
});
undef.forEach(f => console.log("  ? " + f));
if (!undef.length) console.log("  (none)");

// 4. data-act handlers declared vs handled in App.html
const acts = new Set();
for (const m of app.matchAll(/data-act="([a-z-]+)"/g)) acts.add(m[1]);
const handled = new Set();
for (const m of app.matchAll(/act === '([a-z-]+)'/g)) handled.add(m[1]);
console.log("\n=== data-act coverage ===");
let actBad = 0;
[...acts].sort().forEach(a => {
  const ok = handled.has(a);
  if (!ok) actBad++;
  console.log((ok ? "  OK   " : "  MISS ") + a);
});
const unused = [...handled].filter(h => !acts.has(h));
if (unused.length) console.log("  (handled but never emitted: " + unused.join(", ") + ")");

// 5. data-field values vs handlers
const fields = new Set();
for (const m of app.matchAll(/data-field="([a-z-]+)"/g)) fields.add(m[1]);
const fhandled = new Set();
for (const m of app.matchAll(/field === '([a-z-]+)'/g)) fhandled.add(m[1]);
console.log("\n=== data-field coverage ===");
[...fields].sort().forEach(f => {
  console.log((fhandled.has(f) ? "  OK   " : "  MISS ") + f);
  if (!fhandled.has(f)) actBad++;
});

/*
 * 6. The HTTP transport's allowlist.
 *
 * Rpc.gs will only dispatch names listed in RPC_METHODS. A handler that exists
 * and is called but was never added to that list works perfectly from the
 * script's own /exec URL and fails for every palika on the hosted site — the
 * kind of split-brain bug that costs an afternoon. Check both directions.
 */
const rpcSrc = fs.readFileSync(path.join(dir, "Rpc.gs"), "utf8");
const block = rpcSrc.match(/var\s+RPC_METHODS\s*=\s*\{([\s\S]*?)\}\s*;/);
if (!block) {
  console.log("\n=== RPC_METHODS allowlist ===");
  console.log("  MISS  could not find RPC_METHODS in Rpc.gs");
  bad++;
} else {
  const allow = new Set();
  for (const m of block[1].matchAll(/([A-Za-z0-9_$]+)\s*:\s*true/g)) allow.add(m[1]);

  console.log("\n=== RPC_METHODS allowlist ===");
  [...allow].sort().forEach(fn => {
    const ok = serverFns.has(fn);
    if (!ok) bad++;
    console.log((ok ? "  OK   " : "  MISS ") + fn + (ok ? "" : "  (allowlisted but no such server function)"));
  });
  [...called].sort().forEach(fn => {
    if (allow.has(fn)) return;
    bad++;
    console.log("  MISS " + fn + "  (client calls it, but Rpc.gs will not dispatch it over HTTP)");
  });
}

const problems = bad + actBad;
console.log("\n" + (problems ? "PROBLEMS FOUND: " + problems : "Contract is consistent."));
process.exit(problems ? 1 : 0);
