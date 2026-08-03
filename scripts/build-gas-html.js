#!/usr/bin/env node
/*
 * Generate the Apps Script HTML files from the static frontend.
 *
 * The app is served two ways: as static files on Vercel (public/), and straight
 * from HtmlService at the script's own /exec URL. Those need the same code, and
 * the reliable way to get that is to keep one copy and generate the other —
 * two hand-maintained copies of a 1,500-line client would drift within a week,
 * and the drift would show up as "it works for me" between two people looking
 * at different URLs.
 *
 * So: public/ is the source, apps-script/App.html and apps-script/Styles.html
 * are build output. Edit the former. `npm test` runs this first, so the tests
 * always run against freshly generated files.
 *
 * apps-script/Index.html stays hand-written. It is a different document from
 * public/index.html — scriptlets and include() instead of <script src> — and
 * it is short and stable enough that generating it would add machinery for no
 * benefit. The checks below keep the two shells honest about the parts that
 * actually have to agree.
 *
 *   node scripts/build-gas-html.js           write the files
 *   node scripts/build-gas-html.js --check   fail if they are out of date
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CHECK = process.argv.includes("--check");

const HOST_ELEMENTS = ["id=\"root\"", "id=\"toast-host\"", "id=\"modal-host\""];

const OUTPUTS = [
  { from: "public/app.js", to: "apps-script/App.html", tag: "script" },
  { from: "public/styles.css", to: "apps-script/Styles.html", tag: "style" }
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

let failures = 0;
let written = 0;

/* A literal </script> inside the JS would close the wrapper early and dump the
   rest of the application into the page as text. Same for </style>. Nothing in
   this codebase does it today; this is here so nobody discovers it in
   production after adding an innocent-looking string. */
for (const o of OUTPUTS) {
  const src = read(o.from);
  const closer = "</" + o.tag + ">";
  if (src.toLowerCase().includes(closer)) {
    console.error("ERROR  " + o.from + " contains a literal " + closer +
      ", which would break out of the wrapper in " + o.to + ".");
    failures++;
    continue;
  }

  const out = "<" + o.tag + ">\n" + src.replace(/\n+$/, "") + "\n" + closer + "\n";
  const existing = fs.existsSync(path.join(ROOT, o.to)) ? read(o.to) : null;

  if (existing === out) {
    console.log("ok     " + o.to + " (unchanged)");
    continue;
  }
  if (CHECK) {
    console.error("STALE  " + o.to + " does not match " + o.from + " — run: npm run build:gas");
    failures++;
    continue;
  }
  fs.writeFileSync(path.join(ROOT, o.to), out, "utf8");
  written++;
  console.log("wrote  " + o.to + "  (" + Buffer.byteLength(out) + " bytes from " + o.from + ")");
}

/* The client renders into three fixed elements. If a shell drops one, the app
   half-works in a way that is tedious to trace back to the HTML. */
for (const shell of ["public/index.html", "apps-script/Index.html"]) {
  const html = read(shell);
  for (const el of HOST_ELEMENTS) {
    if (!html.includes(el)) {
      console.error("ERROR  " + shell + " is missing an element with " + el + ".");
      failures++;
    }
  }
}

/* HtmlService evaluates <? ?> anywhere in the file, including inside comments —
   a lesson this project learned the hard way. Generated files must not contain
   any, because their source is plain JavaScript that nobody expects to be
   templated. */
for (const o of OUTPUTS) {
  const out = path.join(ROOT, o.to);
  if (fs.existsSync(out) && /<\?/.test(fs.readFileSync(out, "utf8"))) {
    console.error("ERROR  " + o.to + " contains '<?', which HtmlService would try to evaluate.");
    failures++;
  }
}

/* The Apps Script page must not load config.js: served from HtmlService there
   is no proxy to call, and google.script.run is the right transport. The client
   picks that up on its own, but a stray <script src> here would 404 loudly. */
if (read("apps-script/Index.html").includes("config.js")) {
  console.error("ERROR  apps-script/Index.html references config.js, which only exists for static hosting.");
  failures++;
}

if (failures) {
  console.error("\n" + failures + " problem(s). Nothing was deployed.");
  process.exit(1);
}
console.log(CHECK ? "\nGenerated files are up to date."
                  : "\nBuild complete" + (written ? " (" + written + " file(s) updated)." : " (no changes)."));
