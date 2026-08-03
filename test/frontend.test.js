/* Drives the REAL frontend (Index/Styles/App.html) in jsdom against the REAL
   backend (.gs files) via a google.script.run shim. This is the closest thing
   to a deployed run that can be done off-platform. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");
const { globals } = require("./gasmock");

const dir = process.argv[2];

/* ---- 1. Boot the server side ------------------------------------------- */
const order = ["Schema.gs", "Util.gs", "Repo.gs", "Setup.gs", "Api.gs", "Rpc.gs", "Code.gs"];
const server = vm.createContext(Object.assign({}, globals));
for (const f of order) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), server, { filename: f });
}
const srv = expr => vm.runInContext(expr, server);

const quiet = console.log;
console.log = () => {};              // silence setup chatter
srv("setupDatabase()");
console.log = quiet;

// Nothing to set up: there are no codes to issue and no session to establish.
const TODAY = srv("todayIso()");

/* ---- 2. Build the page exactly as HtmlService would -------------------- */
function include(name) { return fs.readFileSync(path.join(dir, name + ".html"), "utf8"); }
let indexHtml = fs.readFileSync(path.join(dir, "Index.html"), "utf8");
indexHtml = indexHtml
  .replace(/<\?!=\s*include\('Styles'\);\s*\?>/, include("Styles"))
  .replace(/<\?!=\s*include\('App'\);\s*\?>/, include("App"))
  .replace(/<\?!=\s*JSON\.stringify\(buildStamp\)\s*\?>/, JSON.stringify("test-build"));

if (/<\?/.test(indexHtml)) {
  console.error("FATAL: unresolved Apps Script scriptlet remains after templating.");
  console.error(indexHtml.match(/.{0,80}<\?.{0,80}/s));
  process.exit(1);
}

const dom = new JSDOM(indexHtml, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.test/" });
const win = dom.window;
const D = win.document;

const errors = [];
win.addEventListener("error", e => errors.push(String(e.message)));

/* ---- 3. google.script.run shim ---------------------------------------- */
const API_NAMES = ["apiBootstrap", "apiLogin", "apiLoginDistrict", "apiLogout", "apiGetPulse",
  "apiSavePulse", "apiListCases", "apiSaveCase", "apiDeleteCase", "apiSetOutcome",
  "apiDashboard", "apiExport", "apiDataQuality"];
const calls = [];

function makeRunner(success, failure) {
  const api = {
    withSuccessHandler(fn) { return makeRunner(fn, failure); },
    withFailureHandler(fn) { return makeRunner(success, fn); }
  };
  API_NAMES.forEach(name => {
    api[name] = function () {
      calls.push(name);
      let res;
      try {
        // Round-trip through JSON exactly like google.script.run does, so a
        // value the real transport could not carry fails here too.
        server.__args = JSON.parse(JSON.stringify(Array.prototype.slice.call(arguments)));
        res = JSON.parse(JSON.stringify(vm.runInContext(`${name}.apply(null, __args)`, server)));
      } catch (e) {
        if (failure) return failure(e);
        throw e;
      }
      if (success) success(res);
    };
  });
  return api;
}
win.google = { script: { run: makeRunner(null, null) } };
win.navigator.clipboard = { writeText: () => Promise.resolve() };
win.print = () => {};
// Force the blocked-download path so the fallback is what actually gets tested.
win.URL.createObjectURL = () => { throw new Error("blocked by sandbox"); };

/* ---- 4. Run the app --------------------------------------------------- */
const appScript = [...D.querySelectorAll("script")].map(s => s.textContent).join("\n");
try {
  win.eval(appScript);
} catch (e) {
  console.error("FATAL: app script threw on load:\n" + e.stack);
  process.exit(1);
}

/* ---- 5. Helpers ------------------------------------------------------- */
let pass = 0, fail = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + label); }
  else {
    fail++;
    failures.push(label);
    console.log("  FAIL  " + label + (extra !== undefined ? "  -> " + String(extra).slice(0, 300) : ""));
  }
}
const $ = sel => D.querySelector(sel);
const $$ = sel => [...D.querySelectorAll(sel)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Let promises resolve and any queued timers fire. */
const settle = async (ms = 0) => { await sleep(ms); await sleep(0); };

function click(target) {
  const el = typeof target === "string" ? $(target) : target;
  if (!el) throw new Error("click: no element for " + target);
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
}
function setInput(target, value) {
  const el = typeof target === "string" ? $(target) : target;
  if (!el) throw new Error("setInput: no element for " + target);
  el.focus();                        // mirror a real user, so focus assertions mean something
  el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
}
function toggle(target, checked) {
  const el = $(target);
  el.checked = checked;
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
}
/* Only the rendered app, never the inline <script> source that also lives in
   <body> — otherwise assertions match the application's own source text. */
const text = () => ["#root", "#toast-host", "#modal-host"]
  .map(s => { const e = $(s); return e ? e.textContent : ""; })
  .join(" ").replace(/\s+/g, " ");
const textIn = sel => { const e = $(sel); return e ? e.textContent.replace(/\s+/g, " ") : ""; };
function navTo(label) {
  const span = $$(".nav .en").find(e => e.textContent.trim() === label);
  if (!span) throw new Error("no nav item " + label);
  click(span.closest("button"));
}
function btn(needle) {
  return $$("button").find(b => b.textContent.toLowerCase().includes(needle.toLowerCase()));
}
const toastText = () => ($(".toast") ? $(".toast").textContent : "");

/* ---- 6. The run ------------------------------------------------------- */
(async function main() {
  await settle();

  console.log("\n--- A. Page loads straight into the app, with no sign-in ---");
  check("no unresolved template tags in DOM", !D.body.innerHTML.includes("<?"));
  check("no sign-in gate is rendered", !$(".gate"), D.body.innerHTML.slice(0, 160));
  check("no access-code field anywhere", !$("#gate-code") && !$("#unlock-code"));
  check("app shell rendered immediately", !!$(".masthead"), text().slice(0, 160));
  check("bootstrap was called", calls.includes("apiBootstrap"));
  check("no login call was ever made",
    !calls.includes("apiLogin") && !calls.includes("apiLoginDistrict"), calls.join(","));
  check("emblem fallback rendered", !!$("svg"));
  check("Nepali script renders", /[ऀ-ॿ]/.test(text()));

  console.log("\n--- B. The palika is chosen, not authenticated ---");
  check("palika selector lists all 10 units",
    $("#side-palika") && $("#side-palika").options.length === 10,
    $("#side-palika") && $("#side-palika").options.length);
  setInput("#side-palika", "Panchkhapan Municipality");
  await settle(30);
  check("choosing a palika takes effect", /Panchkhapan Municipality/.test(text()),
    text().slice(0, 200));
  check("the choice is remembered for next time",
    win.localStorage.getItem("vbd.palika.v1") === "Panchkhapan Municipality",
    win.localStorage.getItem("vbd.palika.v1"));

  console.log("\n--- C. Back to the palika the rest of this run uses ---");
  setInput("#side-palika", "Khandbari Municipality");
  await settle(30);
  check("app shell still rendered", !!$(".masthead"), text().slice(0, 160));
  check("sidebar nav present", $$(".nav button").length >= 5, $$(".nav button").length);
  check("dashboard is the landing view", /District dashboard/.test(text()));
  check("selected palika shown", /Khandbari Municipality/.test(text()));
  check("no session was stored", !win.sessionStorage.getItem("vbd.session.v1"));

  console.log("\n--- D. Dashboard renders ---");
  check("dengue board present", /Dengue/.test(text()));
  check("scrub board present", /Scrub typhus/.test(text()));
  check("epidemic curve bars drawn", $$(".curve .bar").length > 0, $$(".curve .bar").length);
  check("7-day average polyline drawn", !!$(".curve svg polyline"));
  check("polyline points are numeric",
    $(".curve svg polyline") && /^[\d.,\s]+$/.test($(".curve svg polyline").getAttribute("points")),
    $(".curve svg polyline") && $(".curve svg polyline").getAttribute("points").slice(0, 50));
  check("completeness starts at 0 of 10", /0 \/ 10/.test(text()), (text().match(/\d+ \/ 10/) || [])[0]);
  check("all 10 palikas flagged not reported", $$(".chip.no").length === 10, $$(".chip.no").length);
  check("no NaN anywhere on the dashboard", !/NaN/.test(text()));
  check("no undefined leaked into the markup", !/undefined/.test(text()));

  console.log("\n--- E. Daily numbers screen ---");
  navTo("Daily numbers");
  await settle(20);
  check("daily form rendered", /Daily numbers · both diseases/.test(text()));
  check("dengue inputs present", !!$("#f-dengue_ns1") && !!$("#f-dengue_igm"));
  check("scrub inputs present", !!$("#f-scrub_rdt") && !!$("#f-scrub_elisa"));
  check("nil-report checkbox present", !!$("#d-nil"));
  /* The palika is now a free choice on the form rather than a locked field.
     That is the trade being made: nothing stops a reporter filing for the wrong
     palika except reading the selector, so it has to be visible and correct. */
  check("palika is a selector, not a locked field", !!$("#d-palika") && !$('input[disabled]'));
  check("it is set to the palika in use", $("#d-palika").value === "Khandbari Municipality",
    $("#d-palika").value);

  console.log("\n--- F. Live reconciliation while typing ---");
  setInput("#f-dengue_ns1", "6");
  setInput("#f-dengue_igm", "2");
  check("total tests updates live to 8", $('[data-tot="dengue"]').textContent === "8",
    $('[data-tot="dengue"]').textContent);
  setInput("#f-dengue_positives", "9");
  check("error when positives exceed tests", /cannot exceed tests done/.test(text()));
  check("submit disabled while blocked", $('[data-act="save-pulse"]').disabled === true);
  setInput("#f-dengue_positives", "2");
  check("error clears when corrected", !/cannot exceed tests done/.test(text()));
  check("submit re-enabled", $('[data-act="save-pulse"]').disabled === false);
  check("warns 2 cases are still owed", /add 2 more/.test(text()), (text().match(/Declared[^.]*\./) || [])[0]);
  check("focus is not stolen while typing", D.activeElement === $("#f-dengue_positives"),
    D.activeElement && D.activeElement.id);

  console.log("\n--- G. Nil report toggles the counts off ---");
  toggle("#d-nil", true);
  await settle();
  check("count inputs disabled", $("#f-dengue_ns1").disabled === true);
  check("reconciliation warning cleared", !/add 2 more/.test(text()));
  toggle("#d-nil", false);
  await settle();
  check("inputs re-enabled", $("#f-dengue_ns1").disabled === false);
  check("typed values survived the toggle", $("#f-dengue_ns1").value === "6", $("#f-dengue_ns1").value);

  console.log("\n--- H. Submit the daily return ---");
  setInput("#f-dengue_suspects", "12");
  setInput("#f-scrub_rdt", "3");
  setInput("#f-scrub_positives", "1");
  setInput("#d-remarks", "RDT stock low");
  click('[data-act="save-pulse"]');
  await settle(30);
  check("success toast shown", !!$(".toast.ok"), toastText());
  check("status flipped to Submitted", /Submitted/.test(text()));
  const rawRow = srv(`JSON.stringify(findByKey('Pulses','pulse_id', pulseId('U03', ${JSON.stringify(TODAY)})))`);
  check("row written to the Pulses sheet", rawRow && rawRow !== "null");
  const saved = rawRow && rawRow !== "null" ? JSON.parse(rawRow) : {};
  check("dengue NS1 stored as 6", saved.dengue_ns1 === 6, saved.dengue_ns1);
  check("dengue positives stored as 2", saved.dengue_positives === 2, saved.dengue_positives);
  check("remarks stored", saved.remarks === "RDT stock low", saved.remarks);
  check("nil_report stored false", saved.nil_report === false, saved.nil_report);

  console.log("\n--- I. Positive cases screen and quota ---");
  navTo("Positive cases");
  await settle(20);
  check("case form rendered", /Add a positive case/.test(text()));
  check("quota says 2 remain", /2 of 2 declared dengue positives still to enter/.test(text()),
    (text().match(/\d+ of \d+ declared[^.]*\./) || [])[0]);
  setInput("#c-name", "Sabina Rai");
  setInput("#c-age", "24");
  setInput("#c-sex", "Female");
  setInput("#c-ward", "3");
  setInput("#c-tole", "Tumlingtar");
  setInput("#c-test", "NS1");
  click('[data-act="save-case"]');
  await settle(30);
  check("first case saved", /added to the line list/.test(toastText()), toastText());
  check("form cleared after save", $("#c-name").value === "", $("#c-name").value);
  check("quota now shows 1 remaining", /1 of 2 declared dengue positives still to enter/.test(text()),
    (text().match(/\d+ of \d+ declared[^.]*\./) || [])[0]);

  console.log("\n--- J. Field validation ---");
  click('[data-act="save-case"]');
  await settle(20);
  check("empty form refused", !!$(".toast.err"), toastText());
  check("name flagged", !!$("#c-name.err"));
  check("sex flagged", !!$("#c-sex.err"));
  check("ward flagged", !!$("#c-ward.err"));
  check("inline error text shown", /required/i.test(text()));

  console.log("\n--- K. Quota enforced at the boundary ---");
  setInput("#c-name", "Hari Limbu");
  setInput("#c-age", "31");
  setInput("#c-sex", "Male");
  setInput("#c-ward", "4");
  setInput("#c-test", "IgM");
  click('[data-act="save-case"]');
  await settle(30);
  check("second case saved", /added to the line list/.test(toastText()), toastText());
  check("quota reports all entered", /All 2 declared dengue positives/.test(text()),
    (text().match(/All \d+ declared[^.]*\./) || [])[0]);
  setInput("#c-name", "Gita Sherpa");
  setInput("#c-age", "19");
  setInput("#c-sex", "Female");
  setInput("#c-ward", "5");
  setInput("#c-test", "NS1");
  click('[data-act="save-case"]');
  await settle(30);
  check("third case refused", !!$(".toast.err"), toastText());
  check("refusal explains the fix", /Raise the count on Daily numbers/.test(toastText()), toastText());
  check("still only 2 cases stored",
    srv("readAll('Cases').filter(function(c){return !c.deleted;}).length") === 2,
    srv("readAll('Cases').filter(function(c){return !c.deleted;}).length"));

  console.log("\n--- L/M. The line list opens directly, names and all ---");
  navTo("Line list");
  await settle(40);
  check("no lock panel", !/is locked/.test(text()), text().slice(0, 160));
  check("no unlock input", !$("#unlock-code"));
  check("line list table rendered", !!$("table"), text().slice(0, 160));
  check("real patient names visible", /Sabina Rai/.test(text()));
  check("second case listed", /Hari Limbu/.test(text()));
  check("no name is masked", !/••••/.test(text()));
  check("each row has edit and delete", $$('[data-act="edit-case"]').length === 2,
    $$('[data-act="edit-case"]').length);

  console.log("\n--- N. Line list search ---");
  setInput("#ll-q", "Sabina");
  await settle(600);
  check("search narrows the list", /Sabina Rai/.test(text()) && !/Hari Limbu/.test(text()),
    (text().match(/Sabina|Hari/g) || []).join(","));
  check("search box keeps focus after the reload", D.activeElement && D.activeElement.id === "ll-q",
    D.activeElement && D.activeElement.id);
  click('[data-act="ll-reset"]');
  await settle(40);
  check("reset restores both rows", /Hari Limbu/.test(text()) && /Sabina Rai/.test(text()));

  console.log("\n--- O. Edit a case round-trips ---");
  click($$('[data-act="edit-case"]')[0]);
  await settle(30);
  check("switched to the case form in edit mode", /Edit case C-/.test(text()), text().slice(0, 140));
  check("form pre-filled", !!$("#c-name") && $("#c-name").value.length > 0, $("#c-name") && $("#c-name").value);
  const original = $("#c-name").value;
  setInput("#c-name", original + " Kumari");
  click('[data-act="save-case"]');
  await settle(30);
  check("edit saved", /Saved changes/.test(toastText()), toastText());
  check("edit did not create a third case",
    srv("readAll('Cases').filter(function(c){return !c.deleted;}).length") === 2,
    srv("readAll('Cases').filter(function(c){return !c.deleted;}).length"));
  check("new name persisted",
    srv("readAll('Cases').some(function(c){return /Kumari/.test(c.patient_name);})"));

  console.log("\n--- P. Outcome screen ---");
  navTo("Outcome");
  await settle(40);
  check("outcome screen rendered", /Under treatment/.test(text()));
  check("outcome buttons present", $$('[data-act="set-outcome"]').length >= 3,
    $$('[data-act="set-outcome"]').length);
  const recovered = $$('[data-act="set-outcome"]').find(b => b.getAttribute("data-outcome") === "recovered");
  click(recovered);
  await settle(40);
  check("outcome persisted to the sheet",
    srv("readAll('Cases').filter(function(c){return c.outcome==='recovered';}).length") === 1,
    srv("readAll('Cases').filter(function(c){return c.outcome==='recovered';}).length"));

  console.log("\n--- Q. CSV export falls back when download is blocked ---");
  navTo("Dashboard");
  await settle(40);
  click(btn("Download summary"));
  await settle(40);
  check("fallback panel opened", !!$("#csv-dump"), $("#modal-host").innerHTML.slice(0, 100));
  check("CSV content present", $("#csv-dump") && /Dengue/.test($("#csv-dump").value),
    $("#csv-dump") && $("#csv-dump").value.slice(0, 60));
  check("CSV has a header row", $("#csv-dump") && /^Disease,Palika/.test($("#csv-dump").value));
  click('[data-act="csv-close"]');
  await settle();
  check("fallback closes", !$("#csv-dump"));

  console.log("\n--- R. Dashboard reflects the entered data ---");
  click(btn("All"));
  await settle(40);
  check("completeness now 1 of 10", /1 \/ 10/.test(text()), (text().match(/\d+ \/ 10/) || [])[0]);
  check("Khandbari shown as reported", $$(".chip.ok").length === 1, $$(".chip.ok").length);
  check("dengue positives counted on the board", /Cumulative cases/.test(text()));
  check("still no NaN after real data", !/NaN/.test(text()));

  console.log("\n--- S. District scope switch ---");
  setInput("#dash-scope", "Khandbari Municipality");
  await settle(40);
  check("scope bar shows the palika", /Khandbari Municipality/.test(textIn(".scopebar")),
    textIn(".scopebar"));
  check("clear-scope button offered", !!$('[data-act="clear-scope"]'));
  click('[data-act="clear-scope"]');
  await settle(40);
  check("back to whole district", /Sankhuwasabha District/.test(text()));

  console.log("\n--- T. There is nothing to sign out of ---");
  check("no sign-out control is offered", !$('[data-act="signout"]'));
  check("nothing was ever put in sessionStorage",
    !win.sessionStorage.getItem("vbd.session.v1"));
  check("only the palika choice is persisted",
    win.localStorage.getItem("vbd.palika.v1") === "Khandbari Municipality",
    win.localStorage.getItem("vbd.palika.v1"));

  console.log("\n--- U. Hygiene ---");
  check("no unhandled window errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  check("no literal [object Object] rendered", !/\[object Object\]/.test(text()));

  console.log("\n========================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  if (failures.length) console.log("  failed: " + failures.join("; "));
  console.log("========================================");
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error("\nHARNESS ERROR: " + e.stack);
  process.exit(1);
});
