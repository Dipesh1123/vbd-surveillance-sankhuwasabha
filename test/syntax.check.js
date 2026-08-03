// Syntax-check Apps Script .gs files by copying them to .js and using vm compile.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => /\.(gs|js)$/.test(f));
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  try {
    new vm.Script(src, { filename: f });
    console.log("OK   " + f);
  } catch (e) {
    bad++;
    console.log("FAIL " + f + "  -> " + e.message);
  }
}
// Also validate any .html files' inline <script> blocks
const htmls = fs.readdirSync(dir).filter(f => /\.html$/.test(f));
for (const f of htmls) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  const blocks = [...src.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!blocks.length) { console.log("--   " + f + " (no inline script)"); continue; }
  let i = 0, ok = true;
  for (const b of blocks) {
    i++;
    // Apps Script templating scriptlets are not valid standalone JS.
    if (/<\?/.test(b[1])) { console.log("SKIP " + f + " block " + i + " (contains Apps Script scriptlet)"); continue; }
    try { new vm.Script(b[1], { filename: f + "#" + i }); }
    catch (e) { ok = false; bad++; console.log("FAIL " + f + " block " + i + " -> " + e.message); }
  }
  if (ok) console.log("OK   " + f + " (" + blocks.length + " script block(s))");
}
console.log(bad ? "\n" + bad + " FILE(S) FAILED" : "\nAll files parsed cleanly.");
process.exit(bad ? 1 : 0);
