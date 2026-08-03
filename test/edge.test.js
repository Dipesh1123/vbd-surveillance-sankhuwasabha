/* Data-integrity edge cases: the awkward paths that routine testing misses.
   Run:  node test/edge.test.js apps-script                                   */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { globals, lockControl } = require("./gasmock");

const dir = process.argv[2] || "apps-script";
const order = ["Schema.gs", "Util.gs", "Repo.gs", "Setup.gs", "Auth.gs", "Api.gs", "Code.gs"];
const ctx = vm.createContext(Object.assign({}, globals));
for (const f of order) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
const run = e => vm.runInContext(e, ctx);

const quiet = console.log;
console.log = () => {};
run("setupDatabase()");
console.log = quiet;

let pass = 0, fail = 0;
const failed = [];
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + label); }
  else { fail++; failed.push(label); console.log("  FAIL  " + label + (extra !== undefined ? "  -> " + String(extra).slice(0, 300) : "")); }
}

/* --- sign in as one palika and as the district --------------------------- */
run(`
  var u = findByKey('Units','unit_id','U03'); var s1 = randomToken(16);
  updateRowAt('Units', u._row, Object.assign({}, u, { code_hash: hashCode('AAA111', s1), code_salt: s1 }));
  var ds = randomToken(16);
  configSet('district_code_salt', ds); configSet('district_code_hash', hashCode('DIST', ds));
  configSet('allow_backdate_days', '7');
  resetCaches();
`);
run(`var TOK = apiLogin('Khandbari Municipality','AAA111').data.token;`);
run(`var DTOK = apiLoginDistrict('DIST').data.token;`);
const TODAY = run("todayIso()");
const YESTERDAY = run(`addDays(${JSON.stringify(TODAY)}, -1)`);
run(`var TODAY = ${JSON.stringify(TODAY)}, YDAY = ${JSON.stringify(YESTERDAY)};`);

console.log("\n--- 1. Set up a balanced day ---");
run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date:TODAY,
  dengue_suspects:5, dengue_ns1:4, dengue_positives:2, scrub_rdt:2, scrub_positives:0 })`);
const a = run(`apiSaveCase(TOK, { palika:'Khandbari Municipality', disease:'dengue',
  patient_name:'Case One', age:30, age_unit:'years', sex:'Male', ward:1,
  test_type:'NS1', test_date:TODAY })`);
const b = run(`apiSaveCase(TOK, { palika:'Khandbari Municipality', disease:'dengue',
  patient_name:'Case Two', age:31, age_unit:'years', sex:'Female', ward:2,
  test_type:'NS1', test_date:TODAY })`);
check("two cases entered", a.data.saved && b.data.saved);
const bal = run("apiGetPulse(TOK,'Khandbari Municipality',TODAY)");
check("day is balanced (2 of 2)", bal.data.issues.dengue.level === null, bal.data.issues.dengue);
run(`var CASE1 = ${JSON.stringify(a.data.case_id)};`);

console.log("\n--- 2. Moving a case to a day with no declared positives ---");
run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date:YDAY,
  dengue_ns1:3, dengue_positives:0 })`);
const moved = run(`apiSaveCase(TOK, { case_id:CASE1, palika:'Khandbari Municipality',
  disease:'dengue', patient_name:'Case One', age:30, age_unit:'years', sex:'Male',
  ward:1, test_type:'NS1', test_date:YDAY })`);
check("edit onto an unbacked day is refused", moved.ok && moved.data.saved === false, moved);
check("refusal explains the reason",
  moved.ok && !moved.data.saved && /declare|positives/i.test(moved.data.message || ""),
  moved.ok && moved.data.message);
const yday = run("apiGetPulse(TOK,'Khandbari Municipality',YDAY)");
check("yesterday was not corrupted", yday.data.issues.dengue.entered === 0, yday.data.issues.dengue);
const still = run("apiGetPulse(TOK,'Khandbari Municipality',TODAY)");
check("today still balanced", still.data.issues.dengue.level === null, still.data.issues.dengue);

console.log("\n--- 3. Moving a case to a day that HAS room ---");
run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date:YDAY,
  dengue_ns1:3, dengue_positives:1 })`);
const moved2 = run(`apiSaveCase(TOK, { case_id:CASE1, palika:'Khandbari Municipality',
  disease:'dengue', patient_name:'Case One', age:30, age_unit:'years', sex:'Male',
  ward:1, test_type:'NS1', test_date:YDAY })`);
check("edit onto a backed day is allowed", moved2.ok && moved2.data.saved === true, moved2);
check("yesterday now has the case",
  run("apiGetPulse(TOK,'Khandbari Municipality',YDAY)").data.issues.dengue.entered === 1);
check("today now short by one",
  run("apiGetPulse(TOK,'Khandbari Municipality',TODAY)").data.issues.dengue.level === "warn");

console.log("\n--- 4. Changing disease without room is refused ---");
const swap = run(`apiSaveCase(TOK, { case_id:CASE1, palika:'Khandbari Municipality',
  disease:'scrub', patient_name:'Case One', age:30, age_unit:'years', sex:'Male',
  ward:1, test_type:'IgM RDT', test_date:YDAY })`);
check("disease swap with no scrub declared is refused", swap.ok && swap.data.saved === false, swap);

console.log("\n--- 5. Editing in place (no slot change) still works ---");
const inPlace = run(`apiSaveCase(TOK, { case_id:CASE1, palika:'Khandbari Municipality',
  disease:'dengue', patient_name:'Case One Renamed', age:33, age_unit:'years',
  sex:'Male', ward:7, test_type:'IgM', test_date:YDAY })`);
check("same-slot edit allowed", inPlace.ok && inPlace.data.saved === true, inPlace);
check("changes persisted",
  run("readAll('Cases').some(function(c){return c.patient_name==='Case One Renamed' && c.ward===7;})"));
check("no duplicate created",
  run("readAll('Cases').filter(function(c){return !c.deleted;}).length") === 2,
  run("readAll('Cases').filter(function(c){return !c.deleted;}).length"));

console.log("\n--- 6. Cross-palika move refused for a unit session ---");
const cross = run(`apiSaveCase(TOK, { case_id:CASE1, palika:'Madi Municipality',
  disease:'dengue', patient_name:'Case One Renamed', age:33, age_unit:'years',
  sex:'Male', ward:7, test_type:'IgM', test_date:YDAY })`);
check("unit cannot move a case to another palika",
  cross.ok === false && cross.code === "NOT_YOUR_PALIKA", cross);

console.log("\n--- 7. Injection and escaping ---");
run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date:TODAY,
  dengue_suspects:5, dengue_ns1:4, dengue_positives:2, remarks:'=HYPERLINK("http://evil","x")' })`);
const remark = run(`findByKey('Pulses','pulse_id', pulseId('U03', TODAY)).remarks`);
check("formula in remarks is neutralised", remark.charAt(0) === "'", JSON.stringify(remark));

const xss = run(`apiSaveCase(TOK, { palika:'Khandbari Municipality', disease:'dengue',
  patient_name:'<img src=x onerror=alert(1)>', age:20, age_unit:'years', sex:'Other',
  ward:1, test_type:'NS1', test_date:TODAY })`);
check("case with markup in the name saves", xss.ok && xss.data.saved === true, xss);
const csvOut = run("apiExport(DTOK,'linelist',{})").data.csv;
check("CSV quotes the dangerous cell", /"?<img src=x onerror=alert\(1\)>"?/.test(csvOut));
check("CSV export contains no raw newline injection", csvOut.split(/\r\n/).length >= 2);

const uni = run(`apiSaveCase(DTOK, { palika:'Khandbari Municipality', disease:'scrub',
  patient_name:'सविना राई', age:22, age_unit:'years', sex:'Female', ward:3,
  tole:'तुम्लिङटार', test_type:'IgM RDT', test_date:TODAY })`);
check("Devanagari name rejected without a declared scrub positive",
  uni.ok && uni.data.saved === false, uni);
run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date:TODAY,
  dengue_suspects:5, dengue_ns1:4, dengue_positives:2, scrub_rdt:2, scrub_positives:1 })`);
const uni2 = run(`apiSaveCase(DTOK, { palika:'Khandbari Municipality', disease:'scrub',
  patient_name:'सविना राई', age:22, age_unit:'years', sex:'Female', ward:3,
  tole:'तुम्लिङटार', test_type:'IgM RDT', test_date:TODAY })`);
check("Devanagari name saves once declared", uni2.ok && uni2.data.saved === true, uni2);
check("Devanagari round-trips intact",
  run("readAll('Cases').some(function(c){return c.patient_name==='सविना राई';})"));

console.log("\n--- 8. Age validation ---");
const oldAge = run(`apiSaveCase(TOK, { palika:'Khandbari Municipality', disease:'dengue',
  patient_name:'Too Old', age:130, age_unit:'years', sex:'Male', ward:1,
  test_type:'NS1', test_date:TODAY })`);
check("age over 120 years refused", oldAge.ok && oldAge.data.saved === false && !!oldAge.data.errors.age,
  oldAge.ok && oldAge.data.errors);
const badMonths = run(`apiSaveCase(TOK, { palika:'Khandbari Municipality', disease:'dengue',
  patient_name:'Bad Months', age:36, age_unit:'months', sex:'Male', ward:1,
  test_type:'NS1', test_date:TODAY })`);
check("36 months refused (use years)", badMonths.ok && badMonths.data.saved === false && !!badMonths.data.errors.age);
const zeroAge = run(`apiSaveCase(TOK, { palika:'Khandbari Municipality', disease:'dengue',
  patient_name:'Newborn', age:0, age_unit:'months', sex:'Female', ward:1,
  test_type:'NS1', test_date:TODAY })`);
check("age 0 months is a valid answer, not a missing one",
  zeroAge.ok && !(zeroAge.data.errors && zeroAge.data.errors.age),
  zeroAge.ok && zeroAge.data.errors);

console.log("\n--- 9. Sheet resilience ---");
run(`
  var sh = sheetFor('Pulses');
  sh.appendRow([]);                       // a blank row, as a human deletion leaves
  invalidateTable('Pulses');
`);
check("blank rows are skipped, not parsed",
  run("readAll('Pulses').every(function(p){return !!p.pulse_id;})"));
const dq = run("dataQualityReport()");
check("data quality still runs over a dirty sheet", typeof dq.pulseCount === "number", dq.pulseCount);

console.log("\n--- 10. BS calendar boundary ---");
check("date inside the table converts to Devanagari", /[ऀ-ॿ]/.test(run("adToBs('2026-08-01', bsTable())")),
  run("adToBs('2026-08-01', bsTable())"));
check("date past the table falls back to Gregorian",
  run("adToBs('2027-06-01', bsTable())") === "2027-06-01",
  run("adToBs('2027-06-01', bsTable())"));
check("date before the table falls back to Gregorian",
  run("adToBs('2020-01-01', bsTable())") === "2020-01-01",
  run("adToBs('2020-01-01', bsTable())"));
check("empty date returns empty", run("adToBs('', bsTable())") === "");

console.log("\n--- 11. Backdating window ---");
run("configSet('allow_backdate_days','0'); resetCaches();");
const unlimited = run(`apiSavePulse(TOK, { palika:'Khandbari Municipality',
  report_date: addDays(TODAY,-60), dengue_ns1:1, dengue_positives:0 })`);
check("0 means no backdate limit", unlimited.ok && unlimited.data.saved === true, unlimited);
run("configSet('allow_backdate_days','7'); resetCaches();");

console.log("\n--- 12. Pagination ---");
run(`
  apiSavePulse(DTOK, { palika:'Madi Municipality', report_date:TODAY,
    dengue_ns1:80, dengue_positives:60 });
  for (var i = 0; i < 60; i++) {
    apiSaveCase(DTOK, { palika:'Madi Municipality', disease:'dengue',
      patient_name:'Bulk ' + i, age:20, age_unit:'years', sex:'Male', ward:1,
      test_type:'NS1', test_date:TODAY });
  }
`);
const p0 = run("apiListCases(DTOK, { scope:'Madi Municipality', page:0, perPage:50 })");
check("page 0 returns 50 rows", p0.data.rows.length === 50, p0.data.rows.length);
check("total is 60", p0.data.total === 60, p0.data.total);
check("2 pages reported", p0.data.pages === 2, p0.data.pages);
const p1 = run("apiListCases(DTOK, { scope:'Madi Municipality', page:1, perPage:50 })");
check("page 1 returns the remaining 10", p1.data.rows.length === 10, p1.data.rows.length);
const ids0 = new Set(p0.data.rows.map(r => r.case_id));
check("pages do not overlap", p1.data.rows.every(r => !ids0.has(r.case_id)));
check("perPage is capped at 200",
  run("apiListCases(DTOK, { scope:'Madi Municipality', page:0, perPage:9999 }).data.perPage") === 200);

console.log("\n--- 13. Unit isolation on the line list ---");
const mine = run("apiListCases(TOK, {})");
check("unit sees only its own palika",
  mine.data.rows.every(r => r.palika === "Khandbari Municipality"),
  [...new Set(mine.data.rows.map(r => r.palika))]);
check("unit cannot widen scope to another palika",
  run("apiListCases(TOK, { scope:'Madi Municipality' })").data.rows
    .every(r => r.palika === "Khandbari Municipality"));
check("unit search cannot match another palika's patient by name",
  run("apiListCases(TOK, { query:'Bulk' })").data.total === 0,
  run("apiListCases(TOK, { query:'Bulk' })").data.total);

console.log("\n--- 14. Case IDs are never reused ---");
// Madi's declared count is exactly consumed by the bulk load above, so make
// room for the two cases this section needs.
run(`apiSavePulse(DTOK, { palika:'Madi Municipality', report_date:TODAY,
  dengue_ns1:80, dengue_positives:62 })`);
const before = run("readAll('Cases').length");
const doomed = run(`apiSaveCase(DTOK, { palika:'Madi Municipality', disease:'dengue',
  patient_name:'To Delete', age:44, age_unit:'years', sex:'Male', ward:1,
  test_type:'NS1', test_date:TODAY })`);
run(`apiDeleteCase(DTOK, ${JSON.stringify(doomed.data.case_id)})`);
const next = run(`apiSaveCase(DTOK, { palika:'Madi Municipality', disease:'dengue',
  patient_name:'After Delete', age:45, age_unit:'years', sex:'Male', ward:1,
  test_type:'NS1', test_date:TODAY })`);
check("new case does not reuse the deleted ID",
  next.data.case_id !== doomed.data.case_id, { deleted: doomed.data.case_id, next: next.data.case_id });
check("soft-deleted row retained", run("readAll('Cases').length") === before + 2);

console.log("\n--- 15. Lock contention (the 5 PM deadline crush) ---");
const acquiredBefore = lockControl.acquired;
lockControl.failNext = true;
const busy = run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date:TODAY,
  dengue_ns1:1, dengue_positives:0 })`);
check("contended write is refused, not silently dropped", busy.ok === false, busy);
check("message tells the reporter to retry", /busy|try again/i.test(busy.error || ""), busy.error);
check("it is classed as a user error, not a fault", busy.code === "INVALID", busy.code);
check("no lock was leaked", lockControl.acquired === acquiredBefore, {
  before: acquiredBefore, after: lockControl.acquired });

const okAfter = run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date:TODAY,
  dengue_suspects:5, dengue_ns1:4, dengue_positives:2, scrub_rdt:2, scrub_positives:1 })`);
check("the retry succeeds", okAfter.ok && okAfter.data.saved === true, okAfter);
check("every acquired lock was released", lockControl.acquired === lockControl.released,
  { acquired: lockControl.acquired, released: lockControl.released });

console.log("\n--- 16. Headless provisioning (clasp / editor Run button) ---");
// The mock's SpreadsheetApp.getUi() throws, exactly like a script running
// without a spreadsheet window. Anything below that survives is headless-safe.
check("getUi() really does throw in this context", (() => {
  try { run("SpreadsheetApp.getUi()"); return false; } catch (e) { return true; }
})());

let boot;
try { boot = run("provisionEverything()"); } catch (e) { boot = { error: e.message }; }
check("provisionEverything() runs with no UI available", boot && !boot.error, boot && boot.error);
check("it issued a code for every palika", boot && boot.codes && boot.codes.length === 10,
  boot && boot.codes && boot.codes.length);
check("codes are plaintext exactly once, in the return value",
  boot && boot.codes && boot.codes.every(c => /^[A-Z0-9]{6}$/.test(c.code)),
  boot && boot.codes && boot.codes[0]);
check("a district code was generated", boot && typeof boot.districtCode === "string" &&
  boot.districtCode.length >= 6, boot && boot.districtCode);
check("nothing plaintext was written to the sheet",
  run("readAll('Units').every(function(u){ return !u.code_hash || u.code_hash.length === 64; })"));

const issuedCode = boot.codes.find(c => c.unit_id === "U03").code;
const headlessLogin = run(`apiLogin('Khandbari Municipality', ${JSON.stringify(issuedCode)})`);
check("a headlessly-issued palika code actually signs in", headlessLogin.ok === true, headlessLogin);
const headlessDistrict = run(`apiLoginDistrict(${JSON.stringify(boot.districtCode)})`);
check("the headlessly-set district code signs in", headlessDistrict.ok === true, headlessDistrict);

check("setDistrictCode rejects a short code", (() => {
  const r = run("(function(){ try { setDistrictCode('abc'); return 'no throw'; } " +
    "catch (e) { return e.message; } })()");
  return /at least 6/.test(r);
})());
check("provisionEverything is idempotent — data survives a second run",
  (() => {
    const casesBefore = run("readAll('Cases').length");
    run("provisionEverything()");
    return run("readAll('Cases').length") === casesBefore;
  })());

console.log("\n--- 17. The exact failure a user hit: wrong function, then the fix ---");
// Regression test for a real incident: an admin ran apiBootstrap (the web
// page's data-loading call) instead of the setup function, against a blank
// spreadsheet, and got a raw "Sheet Config is missing" stack trace.
run(`
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = book().getSheetByName(name);
    if (sh) book().sheets.splice(book().sheets.indexOf(sh), 1);
  });
  resetCaches();
`);
check("confirms the workbook is genuinely blank", run("missingSheets().length") === 6, run("missingSheets()"));

const beforeFix = run("apiBootstrap('')");
check("apiBootstrap no longer throws on a blank workbook", beforeFix.ok === true, beforeFix);
check("it reports needsSetup instead of crashing",
  beforeFix.ok && beforeFix.data.needsSetup === true, beforeFix.data);
check("it lists exactly which sheets are missing",
  beforeFix.ok && beforeFix.data.missing.length === 6, beforeFix.ok && beforeFix.data.missing);

check("provisionEverything and apiBootstrap are two distinct functions",
  run("typeof provisionEverything") === "function" && run("typeof apiBootstrap") === "function");
check("their names no longer collide in a function-name sort", (() => {
  const names = ["apiBootstrap", "provisionEverything"].sort();
  // The old pairing was apiBootstrap / bootstrap — alphabetically adjacent in
  // any function-picker. Confirm the new name no longer sits next to it.
  return names[0] !== "apiBootstrap" || names[1] !== "bootstrap";
})());

run("provisionEverything()");
const afterFix = run("apiBootstrap('')");
check("after running the real setup function, apiBootstrap works normally",
  afterFix.ok === true && !afterFix.data.needsSetup, afterFix);

console.log("\n========================================");
console.log("  " + pass + " passed, " + fail + " failed");
if (failed.length) console.log("  failed: " + failed.join("; "));
console.log("========================================");
process.exit(fail ? 1 : 0);
