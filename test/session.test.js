/* Two user journeys the main frontend suite does not cover:
     - reloading the page with a stored session (and with a dead one)
     - the district role entering data on behalf of a palika
   Run:  node test/session.test.js apps-script                                */
const { globals } = require("./gasmock");
const { startServer, startApp, makeChecker } = require("./harness");

const dir = process.argv[2] || "apps-script";
const { check, finish } = makeChecker();

const server = startServer(dir, globals);
const { run } = server;

run(`
  ['U03','U04'].forEach(function (id) {
    var u = findByKey('Units','unit_id',id); var s = randomToken(16);
    updateRowAt('Units', u._row, Object.assign({}, u, {
      code_hash: hashCode('AAA111', s), code_salt: s }));
  });
  var ds = randomToken(16);
  configSet('district_code_salt', ds); configSet('district_code_hash', hashCode('DIST', ds));
  resetCaches();
`);
const TODAY = run("todayIso()");

(async function main() {

  /* ------------------------------------------------------------------ */
  console.log("\n--- 1. Reload with a live session goes straight back in ---");
  const login = run("apiLogin('Khandbari Municipality','AAA111')");
  check("api login ok", login.ok === true, login);
  const stored = { unit: { token: login.data.token, unit_id: "U03", palika: "Khandbari Municipality" }, district: null };

  const a = startApp(dir, server, { session: stored });
  await a.settle(30);
  check("no sign-in gate after reload", !a.$(".gate"), a.text().slice(0, 120));
  check("shell restored", !!a.$(".masthead"));
  check("landed on the dashboard", /District dashboard/.test(a.text()));
  check("correct palika restored", /Khandbari Municipality/.test(a.text()));
  check("line list still locked (unit token only)", (() => {
    a.navTo("Line list");
    return /Line list is locked/.test(a.text());
  })());

  /* ------------------------------------------------------------------ */
  console.log("\n--- 2. Reload with a dead session falls back to the gate ---");
  run(`apiLogout(${JSON.stringify(login.data.token)})`);
  const b = startApp(dir, server, { session: stored });
  await b.settle(30);
  check("gate shown for an expired token", !!b.$(".gate"), b.text().slice(0, 120));
  check("stale session cleared from storage",
    !b.win.sessionStorage.getItem("vbd.session.v1"),
    b.win.sessionStorage.getItem("vbd.session.v1"));
  check("no crash on a dead token", b.errors.length === 0, b.errors.join(" | "));

  /* ------------------------------------------------------------------ */
  console.log("\n--- 3. Garbage in sessionStorage does not break boot ---");
  const c = startApp(dir, server, {});
  c.win.sessionStorage.setItem("vbd.session.v1", "{not json");
  const c2 = startApp(dir, server, {});
  c2.win.sessionStorage.setItem("vbd.session.v1", "{not json");
  await c2.settle(30);
  check("app still boots to the gate", !!c2.$(".gate"));
  check("no unhandled error from corrupt storage", c2.errors.length === 0, c2.errors.join(" | "));

  /* ------------------------------------------------------------------ */
  console.log("\n--- 4. District signs in ---");
  const d = startApp(dir, server, {});
  await d.settle(30);
  d.click('[data-act="gate-tab"][data-tab="district"]');
  await d.settle();
  check("district tab shows one code box", !!d.$("#gate-code") && !d.$("#gate-palika"));
  d.setInput("#gate-code", "DIST");
  d.click('[data-act="login-district"]');
  await d.settle(40);
  check("district signed in", !!d.$(".masthead"), d.text().slice(0, 120));
  check("utility bar identifies the district", /District office/.test(d.text()));
  check("line list unlocked immediately", (() => {
    d.navTo("Line list");
    return !/Line list is locked/.test(d.text());
  })());

  /* ------------------------------------------------------------------ */
  console.log("\n--- 5. District enters a daily return for a chosen palika ---");
  d.navTo("Daily numbers");
  await d.settle(40);
  check("palika selector offered (not a locked field)", !!d.$("#d-palika"), d.text().slice(0, 200));
  check("selector lists every palika", d.$("#d-palika").options.length === 10,
    d.$("#d-palika").options.length);

  d.setInput("#d-palika", "Madi Municipality");
  await d.settle(40);
  check("switched to the chosen palika", /Madi Municipality/.test(d.text()));

  d.setInput("#f-dengue_ns1", "5");
  d.setInput("#f-dengue_suspects", "9");
  d.setInput("#f-dengue_positives", "1");
  d.click('[data-act="save-pulse"]');
  await d.settle(40);
  check("return saved for that palika", !!d.$(".toast.ok"), d.toastText());
  const madi = run(`JSON.stringify(findByKey('Pulses','pulse_id', pulseId('U04', ${JSON.stringify(TODAY)})))`);
  check("row written against Madi's unit_id", madi && madi !== "null", madi);
  const madiRow = madi && madi !== "null" ? JSON.parse(madi) : {};
  check("stored under the right palika", madiRow.palika === "Madi Municipality", madiRow.palika);
  check("dengue NS1 stored as 5", madiRow.dengue_ns1 === 5, madiRow.dengue_ns1);
  check("Khandbari untouched",
    run(`findByKey('Pulses','pulse_id', pulseId('U03', ${JSON.stringify(TODAY)})) === null`));

  /* ------------------------------------------------------------------ */
  console.log("\n--- 6. District line-lists the case it just declared ---");
  d.navTo("Positive cases");
  await d.settle(40);
  check("palika carried across to the case form", /Madi Municipality/.test(d.text()));
  check("quota reflects Madi's declaration", /1 of 1 declared dengue positive still to enter/.test(d.text()),
    (d.text().match(/\d+ of \d+ declared[^.]*\./) || [])[0]);
  d.setInput("#c-name", "Indira Magar");
  d.setInput("#c-age", "27");
  d.setInput("#c-sex", "Female");
  d.setInput("#c-ward", "6");
  d.setInput("#c-test", "NS1");
  d.click('[data-act="save-case"]');
  await d.settle(40);
  check("case saved", /added to the line list/.test(d.toastText()), d.toastText());
  check("case attributed to Madi",
    run("readAll('Cases').some(function(c){return c.patient_name==='Indira Magar' && c.unit_id==='U04';})"));

  /* ------------------------------------------------------------------ */
  console.log("\n--- 7. A unit cannot see the district's other-palika data ---");
  const relog = run("apiLogin('Khandbari Municipality','AAA111')");
  const e = startApp(dir, server, {
    session: { unit: { token: relog.data.token, unit_id: "U03", palika: "Khandbari Municipality" }, district: null }
  });
  await e.settle(40);
  e.navTo("Line list");
  await e.settle(40);
  check("Khandbari sees the padlock, not Madi's patient", /Line list is locked/.test(e.text()));
  check("Madi's patient name is absent from the page source",
    !e.D.body.innerHTML.includes("Indira Magar"));

  /* ------------------------------------------------------------------ */
  console.log("\n--- 8. Hygiene across every window opened ---");
  [a, b, c2, d, e].forEach((app, i) => {
    check("window " + (i + 1) + ": no unhandled errors", app.errors.length === 0, app.errors.join(" | "));
  });
  check("no [object Object] rendered anywhere",
    ![a, b, c2, d, e].some(app => /\[object Object\]/.test(app.text())));

  finish();
})().catch(err => {
  console.error("\nHARNESS ERROR: " + err.stack);
  process.exit(1);
});
