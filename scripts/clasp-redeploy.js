#!/usr/bin/env node
/*
 * Update the EXISTING web app deployment instead of minting a new one.
 *
 * `clasp create-deployment` with no arguments creates a brand new deployment
 * with a brand new URL. The palikas keep using the old link and never see the
 * fix — the single most common way an Apps Script update appears to "not work".
 * This script finds the deployment already in use and updates that.
 */
const path = require("path");
const fs = require("fs");
const { clasp } = require("./clasp-bin");

const ROOT = path.resolve(__dirname, "..");
const description = process.argv[2] || "update";

if (!fs.existsSync(path.join(ROOT, ".clasp.json"))) {
  console.error("No .clasp.json — this project is not linked to a script yet.");
  console.error("  npm run clasp:create      (or copy .clasp.json.example and fill in the ID)");
  process.exit(1);
}

let raw;
try {
  raw = clasp(["list-deployments", "--json"], { cwd: ROOT });
} catch (e) {
  if (e.notInstalled) { console.error(e.message); process.exit(1); }
  console.error("Could not list deployments. Are you logged in?");
  console.error("  npm run clasp:login   (then  npm run clasp:whoami  to confirm)");
  process.exit(1);
}

/* The JSON shape has moved between clasp versions, so pull IDs out defensively
   rather than trusting one particular nesting. */
let deployments = [];
try {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed.deployments || parsed.results || []);
  deployments = list.map(d => ({
    id: d.deploymentId || d.id || (d.deploymentConfig && d.deploymentConfig.deploymentId),
    version: (d.deploymentConfig && d.deploymentConfig.versionNumber) || d.versionNumber,
    description: (d.deploymentConfig && d.deploymentConfig.description) || d.description || ""
  })).filter(d => d.id);
} catch (e) {
  // Fall back to scraping IDs out of the plain-text listing.
  deployments = [...raw.matchAll(/\b(AKfyc[A-Za-z0-9_-]{20,})\b/g)]
    .map(m => ({ id: m[1], version: undefined, description: "" }));
}

// A deployment with no version number is the @HEAD dev deployment; it always
// serves the latest save and is not the one reporters are using.
const real = deployments.filter(d => d.version !== undefined && d.version !== null);

if (!real.length) {
  console.error("No versioned deployment found yet.");
  console.error("Create the first one with:  npm run clasp:deploy");
  process.exit(1);
}

if (real.length > 1) {
  console.error("More than one deployment exists — refusing to guess which one your palikas use:\n");
  real.forEach(d => console.error("  " + d.id + "   v" + d.version + "   " + d.description));
  console.error("\nUpdate the right one explicitly:");
  console.error('  clasp redeploy <DEPLOYMENT_ID> -d "' + description + '"');
  process.exit(1);
}

const target = real[0];
console.log("Updating deployment " + target.id + " (was v" + target.version + ")…");
try {
  console.log(clasp(["update-deployment", target.id, "-d", description], { cwd: ROOT }));
} catch (e) {
  console.error("Redeploy failed:\n" + (e.stdout || "") + (e.stderr || ""));
  process.exit(1);
}
console.log("Done — the existing web app URL now serves the new version.");
