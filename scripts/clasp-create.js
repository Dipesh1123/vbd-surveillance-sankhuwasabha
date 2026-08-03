#!/usr/bin/env node
/*
 * Create the spreadsheet and its bound Apps Script project in one step.
 *
 * `clasp create` pulls the project's default manifest down over rootDir, which
 * would silently replace our appsscript.json — losing the OAuth scopes and the
 * web app access settings, so the very first deployment would be wrong in a way
 * that is tedious to diagnose. This wrapper puts ours back afterwards.
 */
const fs = require("fs");
const path = require("path");
const { clasp } = require("./clasp-bin");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "apps-script", "appsscript.json");
const TITLE = process.argv[2] || "VBD Surveillance — Sankhuwasabha";

if (fs.existsSync(path.join(ROOT, ".clasp.json"))) {
  console.error("A .clasp.json already exists — this project is already linked.");
  console.error("Use `npm run clasp:push` to update it, or delete .clasp.json to start over.");
  process.exit(1);
}

const ours = fs.readFileSync(MANIFEST, "utf8");
JSON.parse(ours); // fail loudly here rather than after a half-done create

console.log("Creating the spreadsheet and bound script project…");
try {
  clasp(["create-script", "--type", "sheets", "--title", TITLE, "--rootDir", "apps-script"],
    { cwd: ROOT, capture: false });
} catch (e) {
  if (e.notInstalled) { console.error("\n" + e.message); process.exit(1); }
  console.error("\nclasp create-script failed. Are you logged in?");
  console.error("  npm run clasp:login   (then  npm run clasp:whoami  to confirm)");
  process.exit(1);
}

const now = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, "utf8") : "";
if (now !== ours) {
  fs.writeFileSync(MANIFEST, ours, "utf8");
  console.log("Restored our appsscript.json (clasp had replaced it with the default).");
}

/*
 * `clasp create-script` writes its own .clasp.json with
 * "scriptExtensions": [".js", ".gs"]. That ordering means a later `clasp pull`
 * writes .gs files back down as .js — creating a confusing duplicate of every
 * source file (Setup.js next to Setup.gs, identical content, different name)
 * without deleting or touching the original. We hit exactly this once already.
 * Force .gs as the only recognised extension so pull can't do that again.
 */
const claspJsonPath = path.join(ROOT, ".clasp.json");
if (fs.existsSync(claspJsonPath)) {
  const cfg = JSON.parse(fs.readFileSync(claspJsonPath, "utf8"));
  if (JSON.stringify(cfg.scriptExtensions) !== JSON.stringify([".gs"])) {
    cfg.scriptExtensions = [".gs"];
    fs.writeFileSync(claspJsonPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    console.log("Set scriptExtensions to [\".gs\"] only (clasp defaults to .js first, which " +
      "makes `clasp pull` write duplicate .js files alongside our .gs source).");
  }
}

console.log("\nNext:");
console.log("  1. npm run clasp:push       — upload the code");
console.log("  2. npm run clasp:open       — open the editor, run `provisionEverything`, authorise");
console.log("  3. npm run clasp:deploy     — publish the web app");
