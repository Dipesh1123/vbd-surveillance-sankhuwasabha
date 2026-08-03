/*
 * Locate and invoke clasp in a way that works on Windows.
 *
 * Node 20.12 / 22 / 24 refuse to execFileSync() a `.cmd` shim (the fix for
 * CVE-2024-27980), so the obvious `execFileSync('clasp.cmd', …)` dies with
 * EINVAL on Windows. Using { shell: true } instead would work, but then every
 * argument goes through cmd.exe quoting — and our project title contains spaces
 * and an em dash, which is exactly the sort of thing that mangles.
 *
 * So: find clasp's real JavaScript entry point and run it with the current
 * node binary. No shim, no shell, no quoting surprises.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let cachedEntry;

function globalNodeModules() {
  try {
    return execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      shell: process.platform === "win32"   // safe: no spaces in these args
    }).trim();
  } catch (e) {
    return null;
  }
}

/** Absolute path to clasp's entry .js, or null if clasp is not installed. */
function findClaspEntry() {
  if (cachedEntry !== undefined) return cachedEntry;

  const roots = [];
  const g = globalNodeModules();
  if (g) roots.push(g);
  roots.push(path.resolve(__dirname, "..", "node_modules"));

  for (const root of roots) {
    const pkgPath = path.join(root, "@google", "clasp", "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch (e) { continue; }

    // "bin" is either a string or { clasp: "..." }
    const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin && (pkg.bin.clasp || Object.values(pkg.bin)[0]));
    if (!rel) continue;

    const entry = path.join(root, "@google", "clasp", rel);
    if (fs.existsSync(entry)) {
      cachedEntry = entry;
      return entry;
    }
  }

  cachedEntry = null;
  return null;
}

/**
 * Run clasp. Returns stdout.
 * @param {string[]} args
 * @param {{cwd?: string, capture?: boolean}} opts
 */
function clasp(args, opts) {
  const o = opts || {};
  const entry = findClaspEntry();
  if (!entry) {
    const err = new Error(
      "clasp is not installed.\n  npm install -g @google/clasp"
    );
    err.notInstalled = true;
    throw err;
  }
  return execFileSync(process.execPath, [entry, ...args], {
    cwd: o.cwd || process.cwd(),
    encoding: "utf8",
    stdio: o.capture === false ? "inherit" : ["ignore", "pipe", "pipe"]
  });
}

module.exports = { clasp, findClaspEntry };
