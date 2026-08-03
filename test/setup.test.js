/* Regression test for a real incident: a reporter (or an admin who ran the
   wrong function) opened the web app before the database existed. Proves the
   actual rendered page — not just the API response — degrades gracefully and
   recovers once the real setup function runs.
   Run:  node test/setup.test.js apps-script                                  */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { globals } = require("./gasmock");
const { startApp, makeChecker } = require("./harness");

const dir = process.argv[2] || "apps-script";
const { check, finish } = makeChecker();

const GS_ORDER = ["Schema.gs", "Util.gs", "Repo.gs", "Setup.gs", "Auth.gs", "Api.gs", "Code.gs"];

// Deliberately skip setupDatabase() here — this simulates a brand-new,
// never-provisioned spreadsheet, which is exactly the state a fresh
// clasp create-script leaves behind.
const ctx = vm.createContext(Object.assign({}, globals));
for (const f of GS_ORDER) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
}
const server = { ctx, run: expr => vm.runInContext(expr, ctx) };

(async function main() {
  console.log("\n--- 1. A blank workbook does not crash the API ---");
  const boot = server.run("apiBootstrap('')");
  check("apiBootstrap succeeds (not a thrown sheet-missing error)", boot.ok === true, boot);
  check("it flags needsSetup", boot.ok && boot.data.needsSetup === true, boot.data);
  check("it lists every missing sheet", boot.ok && boot.data.missing.length === 6, boot.data.missing);

  console.log("\n--- 2. The actual rendered page shows a plain-language message ---");
  const app = startApp(dir, server, {});
  await app.settle(40);
  check("no crash reaching the DOM", app.errors.length === 0, app.errors.join(" | "));
  check("gate is NOT shown (there's nothing to sign into yet)", !app.$(".gate button[data-act='login-unit']"));
  check("the setup message is shown", /not ready yet/i.test(app.text()), app.text().slice(0, 200));
  check("it reassures the reporter, not just the admin",
    /nothing is wrong with your phone/i.test(app.text()));
  check("the admin gets the exact function name to run",
    app.D.body.innerHTML.includes("provisionEverything"));
  check("it explicitly warns against the wrong function",
    /do not run.{0,10}apiBootstrap/i.test(app.D.body.innerHTML.replace(/<[^>]+>/g, " ")));
  check("a retry control is offered", !!app.$('[data-act="retry-setup"]'));

  console.log("\n--- 3. Retry before setup still shows the same message (no false success) ---");
  app.click('[data-act="retry-setup"]');
  await app.settle(40);
  check("still shows not-ready after an early retry", /not ready yet/i.test(app.text()));
  check("bootstrap was called again (a real retry, not a no-op)",
    app.calls.filter(c => c === "apiBootstrap").length >= 2, app.calls);

  console.log("\n--- 4. Provisioning, then retry, recovers normally ---");
  const quiet = console.log;
  console.log = () => {};
  server.run("provisionEverything()");
  console.log = quiet;

  app.click('[data-act="retry-setup"]');
  await app.settle(60);
  check("gate now renders normally", !!app.$(".gate"), app.text().slice(0, 160));
  check("the not-ready message is gone", !/not ready yet/i.test(app.text()));
  check("palika sign-in is available", !!app.$("#gate-palika") && app.$("#gate-palika").options.length === 10);
  check("no leftover errors after recovery", app.errors.length === 0, app.errors.join(" | "));

  finish();
})().catch(err => {
  console.error("\nHARNESS ERROR: " + err.stack);
  process.exit(1);
});
