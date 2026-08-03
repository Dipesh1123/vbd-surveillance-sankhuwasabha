/* End-to-end exercise of the VBD backend against the Apps Script mock. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { globals, cacheControl, counters } = require("./gasmock");

const dir = process.argv[2];
const order = ["Schema.gs", "Util.gs", "Repo.gs", "Setup.gs", "Api.gs", "Rpc.gs", "Code.gs"];

const ctx = vm.createContext(Object.assign({}, globals));
for (const f of order) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  vm.runInContext(src, ctx, { filename: f });
}

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}
function run(expr) { return vm.runInContext(expr, ctx); }

console.log("\n--- 1. Provision the workbook ---");
run("setupDatabase()");
const sheetNames = run("book().sheets.map(s => s.name)");
check("all six sheets exist",
  ["Units", "Pulses", "Cases", "Config", "BS_Calendar", "Audit"].every(n => sheetNames.includes(n)), sheetNames);
check("10 palikas seeded", run("units().length") === 10, run("units().length"));
check("BS calendar seeded", run("bsTable().length") > 0);
check("config seeded", run("configGet('district_name','')") === "Sankhuwasabha");

console.log("\n--- 2. Idempotent re-run ---");
run("setupDatabase()");
check("still 10 palikas after re-run", run("units().length") === 10, run("units().length"));
check("Pulses still empty", run("readAll('Pulses').length") === 0);

console.log("\n--- 3. There is no authentication to get past ---");
/* The system was deliberately opened up: no codes, no sessions, no roles. These
   assert that the machinery is really gone rather than merely bypassed, because
   a half-removed permission check is worse than none — it reads as protection
   that is not there. */
check("no login handler exists", run("typeof apiLogin") === "undefined");
check("no district login handler exists", run("typeof apiLoginDistrict") === "undefined");
check("no logout handler exists", run("typeof apiLogout") === "undefined");
check("no session resolver exists", run("typeof requireSession") === "undefined");
check("no district gate exists", run("typeof requireDistrict") === "undefined");
check("Units carries no code columns",
  run("SCHEMA.Units.columns.filter(function(c){return /code_/.test(c.name);}).length") === 0);
check("Config seeds no district code",
  run("SEED_CONFIG.filter(function(r){return /district_code/.test(r[0]);}).length") === 0);

console.log("\n--- 4. Bootstrap ---");
const boot = run("apiBootstrap()");
check("bootstrap ok", boot.ok === true, boot);
check("bootstrap reports no session at all", boot.ok && boot.data.session === undefined, boot.data);
check("bootstrap still lists every palika", boot.ok && boot.data.units.length === 10);
check("BS date renders in Devanagari", boot.ok && /[ऀ-ॿ]/.test(boot.data.todayBs), boot.ok && boot.data.todayBs);

const today = run("todayIso()");
run(`var TODAY = ${JSON.stringify(today)};`);

console.log("\n--- 5. Reconciliation: positives cannot exceed tests ---");
const over = run(`apiSavePulse({ palika:'Khandbari Municipality', report_date:TODAY,
  dengue_ns1:2, dengue_suspects:5, dengue_positives:9 })`);
check("save refused", over.ok && over.data.saved === false, over);
check("error names the rule", over.ok && /cannot exceed tests/.test(over.data.message), over.ok && over.data.message);

console.log("\n--- 6. Valid daily return ---");
const good = run(`apiSavePulse({ palika:'Khandbari Municipality', report_date:TODAY,
  dengue_suspects:12, dengue_ns1:6, dengue_igm:2, dengue_positives:2,
  scrub_suspects:4, scrub_rdt:3, scrub_positives:1, remarks:'RDT stock low' })`);
check("saved", good.ok && good.data.saved === true, good);
check("dengue tests summed to 8", good.ok && good.data.issues.dengue.tests === 8, good.ok && good.data.issues.dengue.tests);
check("warns that cases are still owed",
  good.ok && good.data.issues.dengue.level === "warn" && /add 2 more/.test(good.data.issues.dengue.message),
  good.ok && good.data.issues.dengue.message);
check("one Pulses row written", run("readAll('Pulses').length") === 1);

console.log("\n--- 7. Line-list quota enforcement ---");
const mkCase = (name, disease, tt) => run(`apiSaveCase({ palika:'Khandbari Municipality',
  disease:'${disease}', patient_name:'${name}', age:24, age_unit:'years', sex:'Female',
  ward:3, tole:'Tumlingtar', test_type:'${tt}', test_date:TODAY })`);
const c1 = mkCase("Sabina Rai", "dengue", "NS1");
check("first dengue case accepted", c1.ok && c1.data.saved === true, c1);
const c2 = mkCase("Hari Limbu", "dengue", "IgM");
check("second dengue case accepted", c2.ok && c2.data.saved === true, c2);
const c3 = mkCase("Gita Sherpa", "dengue", "NS1");
check("third case blocked by quota", c3.ok && c3.data.saved === false, c3);
check("quota message explains why", c3.ok && /already entered/.test(c3.data.message), c3.ok && c3.data.message);

console.log("\n--- 8. Validation of case fields ---");
const badCase = run(`apiSaveCase({ palika:'Khandbari Municipality', disease:'scrub',
  patient_name:'', age:'', sex:'', ward:'', test_type:'', test_date:TODAY })`);
check("empty case rejected", badCase.ok && badCase.data.saved === false, badCase);
check("all five fields flagged", badCase.ok && Object.keys(badCase.data.errors).length === 5,
  badCase.ok && badCase.data.errors);
const wrongTest = run(`apiSaveCase({ palika:'Khandbari Municipality', disease:'scrub',
  patient_name:'X Y', age:30, sex:'Male', ward:1, test_type:'NS1', test_date:TODAY })`);
check("dengue test type refused for scrub", wrongTest.ok === false && /not valid/.test(wrongTest.error), wrongTest);

console.log("\n--- 9. Reconciliation now balanced ---");
const after = run("apiGetPulse('Khandbari Municipality',TODAY)");
check("dengue reconciled (2 of 2)",
  after.ok && after.data.issues.dengue.entered === 2 && after.data.issues.dengue.declared === 2, after);
check("no dengue warning left", after.ok && after.data.issues.dengue.level === null,
  after.ok && after.data.issues.dengue);
check("scrub still owes 1", after.ok && after.data.issues.scrub.level === "warn");

console.log("\n--- 10. Any palika may be written to ---");
/* Deliberate: with nobody identified, "your own palika" has no meaning. This
   is the single largest behavioural change from removing authentication — a
   mistyped palika is now a data-integrity risk with no technical control
   behind it, only the standing selector in the UI. */
const foreign = run(`apiSavePulse({ palika:'Madi Municipality', report_date:TODAY, dengue_ns1:1 })`);
check("writing another palika is allowed", foreign.ok === true && foreign.data.saved === true, foreign);
const nosuch = run(`apiSavePulse({ palika:'Nowhere Municipality', report_date:TODAY, dengue_ns1:1 })`);
check("but a palika that does not exist is still refused",
  nosuch.ok === false && /Select a palika/.test(nosuch.error), nosuch);

console.log("\n--- 11. Patient names are returned to everyone ---");
const list = run("apiListCases({})");
check("every palika's rows are visible", list.ok && list.data.total === 2, list);
check("names are not masked", list.ok && list.data.rows[0].patient_name !== "••••••",
  list.ok && list.data.rows[0].patient_name);
check("a real name comes back", list.ok && /Rai|Limbu/.test(list.data.rows[0].patient_name),
  list.ok && list.data.rows[0].patient_name);
check("canSeeNames true", list.ok && list.data.canSeeNames === true);
const exportOpen = run("apiExport('linelist',{})");
check("the line list export is open", exportOpen.ok === true, exportOpen);
check("and it carries names", exportOpen.ok && /Rai|Limbu/.test(exportOpen.data.csv));
const setOut = run(`apiSetOutcome(${JSON.stringify(c1.data.case_id)}, 'recovered')`);
check("anyone may set an outcome", setOut.ok === true, setOut);
check("the data quality report is open", run("apiDataQuality()").ok === true);

console.log("\n--- 13. Dashboard ---");
const dash = run("apiDashboard('30','all')");
check("dashboard ok", dash.ok === true, dash);
check("two disease boards", dash.ok && dash.data.boards.length === 2);
const dengueBoard = dash.ok && dash.data.boards.find(b => b.key === "dengue");
/* 9, not 8: section 10 wrote a Madi return with one NS1 test, which it is now
   allowed to do. The extra test is the cross-palika write showing up here. */
check("dengue tests total 9", dengueBoard && dengueBoard.total.testsRange === 9, dengueBoard && dengueBoard.total);
check("dengue positives total 2", dengueBoard && dengueBoard.total.posRange === 2, dengueBoard && dengueBoard.total);
check("curve has one point per day", dengueBoard && dengueBoard.curve.counts.length === dengueBoard.curve.days.length);
check("completeness 2 of 10", dash.ok && dash.data.completeness.reported.length === 2 &&
  dash.data.completeness.total === 10, dash.ok && dash.data.completeness);

console.log("\n--- 14. Soft delete ---");
const del = run(`apiDeleteCase(${JSON.stringify(c2.data.case_id)})`);
check("delete ok", del.ok === true, del);
const afterDel = run("apiListCases({})");
check("row hidden after delete", afterDel.ok && afterDel.data.total === 1, afterDel);
check("row physically retained for audit",
  run("readAll('Cases').length") === 2, run("readAll('Cases').length"));

console.log("\n--- 15. Data quality report ---");
const dq = run("dataQualityReport()");
check("no duplicate returns", dq.duplicates.length === 0, dq.duplicates);
check("detects the now-unbalanced dengue count", dq.mismatches.some(m => /Dengue/.test(m)), dq.mismatches);

console.log("\n--- 16. Date window ---");
const future = run(`apiSavePulse({ palika:'Khandbari Municipality', report_date: addDays(TODAY, 1) })`);
check("future date refused", future.ok === false && /future/.test(future.error), future);
const old = run(`apiSavePulse({ palika:'Khandbari Municipality', report_date: addDays(TODAY, -30) })`);
check("stale date refused", old.ok === false && /closed for editing/.test(old.error), old);

console.log("\n--- 17. Exports ---");
const exp = run("apiExport('linelist',{})");
check("line list CSV produced", exp.ok && /patient_name/.test(exp.data.csv), exp.ok && exp.data.filename);
const sum = run("apiExport('summary',{range:'30',scope:'all'})");
check("summary CSV produced", sum.ok && /Dengue/.test(sum.data.csv));
check("CSV escapes the remark field",
  run("apiExport('pulses',{})").data.csv.indexOf("RDT stock low") >= 0);

console.log("\n--- 18. Calls keep working; nothing expires ---");
/* There is no session, so there is nothing to time out. The point of this check
   is that repeated calls stay successful — the old suite proved a token died
   here, and its absence should be asserted rather than merely deleted. */
const again = run("apiGetPulse('Khandbari Municipality',TODAY)");
check("a later call still succeeds", again.ok === true, again);
check("no session state accumulates in Properties",
  run("Object.keys(PropertiesService.getScriptProperties().getProperties()).filter(function(k){return /^sess_|^try_/.test(k);}).length") === 0);

console.log("\n--- 19. Audit trail ---");
const auditRows = run("readAll('Audit').length");
check("audit trail populated", auditRows > 8, auditRows);
/* Worth stating plainly: the audit trail still records what changed and when,
   but with no identity it can no longer record WHO. Every row is 'open'. */
check("writes are attributed to the open role",
  run("readAll('Audit').filter(function(a){return a.role === 'open';}).length") > 0,
  run("readAll('Audit').map(function(a){return a.role;}).join(',')"));

console.log("\n--- 20. A cache eviction changes nothing ---");
cacheControl.enabled = false;               // simulate Google evicting the cache
const survived = run("apiGetPulse('Khandbari Municipality',TODAY)");
cacheControl.enabled = true;
check("still works after eviction", survived.ok === true, survived);

console.log("\n--- 23. Read amplification ---");
run("resetCaches();");
counters.getValues = 0;
run(`apiSaveCase({ palika:'Khandbari Municipality', disease:'scrub',
  patient_name:'Pemba Sherpa', age:41, age_unit:'years', sex:'Male', ward:2,
  tole:'Num', test_type:'IgM RDT', test_date:TODAY })`);
const reads = counters.getValues;
console.log("      full-sheet reads for one case save: " + reads);
check("case save stays under 8 sheet reads", reads < 8, reads);

console.log("\n--- 24. Memo does not serve stale data after a write ---");
const beforeCount = run("readAll('Cases').filter(function(c){return !c.deleted;}).length");
run(`insertRow('Cases', { case_id:'C-9999', disease:'dengue', unit_id:'U03',
  palika:'Khandbari Municipality', ward:1, patient_name:'Memo Test', age:20,
  age_unit:'years', sex:'Other', test_type:'NS1', test_date:TODAY, deleted:false });`);
const afterCount = run("readAll('Cases').filter(function(c){return !c.deleted;}).length");
check("read after write sees the new row", afterCount === beforeCount + 1, { beforeCount, afterCount });

console.log("\n--- 25. Nil report ---");
const nil = run(`apiSavePulse({ palika:'Panchkhapan Municipality', report_date:TODAY, nil_report:true })`);
check("nil return accepted", nil.ok && nil.data.saved === true, nil);
check("nil flag persisted", nil.ok && nil.data.pulse.nil_report === true, nil.ok && nil.data.pulse.nil_report);
const dash2 = run("apiDashboard('30','all')");
check("nil report counts toward completeness",
  dash2.ok && dash2.data.completeness.reported.indexOf('Panchkhapan Municipality') >= 0,
  dash2.ok && dash2.data.completeness.reported);

console.log("\n========================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("========================================");
process.exit(fail ? 1 : 0);
