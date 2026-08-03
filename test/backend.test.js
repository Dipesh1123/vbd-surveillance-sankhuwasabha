/* End-to-end exercise of the VBD backend against the Apps Script mock. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { globals, cacheControl, counters } = require("./gasmock");

const dir = process.argv[2];
const order = ["Schema.gs", "Util.gs", "Repo.gs", "Setup.gs", "Auth.gs", "Api.gs", "Code.gs"];

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

console.log("\n--- 3. Issue a code and log in ---");
run(`
  var u = findByKey('Units','unit_id','U03');
  var salt = randomToken(16);
  updateRowAt('Units', u._row, Object.assign({}, u, { code_hash: hashCode('TESTME', salt), code_salt: salt }));
  resetCaches();
`);
const badLogin = run("apiLogin('Khandbari Municipality','WRONG')");
check("wrong code rejected", badLogin.ok === false, badLogin);
const login = run("apiLogin('Khandbari Municipality','TESTME')");
check("correct code accepted", login.ok === true, login);
check("session carries the palika", login.ok && login.data.palika === "Khandbari Municipality");
run(`var TOK = ${JSON.stringify(login.data.token)};`);

console.log("\n--- 4. Bootstrap ---");
const boot = run("apiBootstrap(TOK)");
check("bootstrap ok", boot.ok === true, boot);
check("bootstrap has session", boot.ok && boot.data.session && boot.data.session.role === "unit");
check("BS date renders in Devanagari", boot.ok && /[ऀ-ॿ]/.test(boot.data.todayBs), boot.ok && boot.data.todayBs);

const today = run("todayIso()");
run(`var TODAY = ${JSON.stringify(today)};`);

console.log("\n--- 5. Reconciliation: positives cannot exceed tests ---");
const over = run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date:TODAY,
  dengue_ns1:2, dengue_suspects:5, dengue_positives:9 })`);
check("save refused", over.ok && over.data.saved === false, over);
check("error names the rule", over.ok && /cannot exceed tests/.test(over.data.message), over.ok && over.data.message);

console.log("\n--- 6. Valid daily return ---");
const good = run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date:TODAY,
  dengue_suspects:12, dengue_ns1:6, dengue_igm:2, dengue_positives:2,
  scrub_suspects:4, scrub_rdt:3, scrub_positives:1, remarks:'RDT stock low' })`);
check("saved", good.ok && good.data.saved === true, good);
check("dengue tests summed to 8", good.ok && good.data.issues.dengue.tests === 8, good.ok && good.data.issues.dengue.tests);
check("warns that cases are still owed",
  good.ok && good.data.issues.dengue.level === "warn" && /add 2 more/.test(good.data.issues.dengue.message),
  good.ok && good.data.issues.dengue.message);
check("one Pulses row written", run("readAll('Pulses').length") === 1);

console.log("\n--- 7. Line-list quota enforcement ---");
const mkCase = (name, disease, tt) => run(`apiSaveCase(TOK, { palika:'Khandbari Municipality',
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
const badCase = run(`apiSaveCase(TOK, { palika:'Khandbari Municipality', disease:'scrub',
  patient_name:'', age:'', sex:'', ward:'', test_type:'', test_date:TODAY })`);
check("empty case rejected", badCase.ok && badCase.data.saved === false, badCase);
check("all five fields flagged", badCase.ok && Object.keys(badCase.data.errors).length === 5,
  badCase.ok && badCase.data.errors);
const wrongTest = run(`apiSaveCase(TOK, { palika:'Khandbari Municipality', disease:'scrub',
  patient_name:'X Y', age:30, sex:'Male', ward:1, test_type:'NS1', test_date:TODAY })`);
check("dengue test type refused for scrub", wrongTest.ok === false && /not valid/.test(wrongTest.error), wrongTest);

console.log("\n--- 9. Reconciliation now balanced ---");
const after = run("apiGetPulse(TOK,'Khandbari Municipality',TODAY)");
check("dengue reconciled (2 of 2)",
  after.ok && after.data.issues.dengue.entered === 2 && after.data.issues.dengue.declared === 2, after);
check("no dengue warning left", after.ok && after.data.issues.dengue.level === null,
  after.ok && after.data.issues.dengue);
check("scrub still owes 1", after.ok && after.data.issues.scrub.level === "warn");

console.log("\n--- 10. Cross-palika write is refused ---");
const foreign = run(`apiSavePulse(TOK, { palika:'Madi Municipality', report_date:TODAY, dengue_ns1:1 })`);
check("cannot write another palika", foreign.ok === false && foreign.code === "NOT_YOUR_PALIKA", foreign);

console.log("\n--- 11. PII gating ---");
const list = run("apiListCases(TOK, {})");
check("unit sees its own rows", list.ok && list.data.total === 2, list);
check("names masked for unit role", list.ok && list.data.rows[0].patient_name === "••••••",
  list.ok && list.data.rows[0].patient_name);
check("canSeeNames false", list.ok && list.data.canSeeNames === false);
const exportDenied = run("apiExport(TOK,'linelist',{})");
check("unit cannot export the line list", exportDenied.ok === false && exportDenied.code === "DISTRICT_ONLY", exportDenied);
const outcomeDenied = run(`apiSetOutcome(TOK, ${JSON.stringify(c1.data ? c1.data.case_id : "")}, 'recovered')`);
check("unit cannot set outcome", outcomeDenied.ok === false && outcomeDenied.code === "DISTRICT_ONLY", outcomeDenied);

console.log("\n--- 12. District session ---");
run(`
  var dsalt = randomToken(16);
  configSet('district_code_salt', dsalt);
  configSet('district_code_hash', hashCode('DISTRICT99', dsalt));
  resetCaches();
`);
const dlogin = run("apiLoginDistrict('DISTRICT99')");
check("district login works", dlogin.ok === true, dlogin);
run(`var DTOK = ${JSON.stringify(dlogin.ok ? dlogin.data.token : "")};`);
const dlist = run("apiListCases(DTOK, {})");
check("district sees real names", dlist.ok && dlist.data.rows[0].patient_name !== "••••••",
  dlist.ok && dlist.data.rows[0].patient_name);
check("district canSeeNames true", dlist.ok && dlist.data.canSeeNames === true);
const setOut = run(`apiSetOutcome(DTOK, ${JSON.stringify(c1.data.case_id)}, 'recovered')`);
check("district sets outcome", setOut.ok === true, setOut);

console.log("\n--- 13. Dashboard ---");
const dash = run("apiDashboard(DTOK,'30','all')");
check("dashboard ok", dash.ok === true, dash);
check("two disease boards", dash.ok && dash.data.boards.length === 2);
const dengueBoard = dash.ok && dash.data.boards.find(b => b.key === "dengue");
check("dengue tests total 8", dengueBoard && dengueBoard.total.testsRange === 8, dengueBoard && dengueBoard.total);
check("dengue positives total 2", dengueBoard && dengueBoard.total.posRange === 2, dengueBoard && dengueBoard.total);
check("curve has one point per day", dengueBoard && dengueBoard.curve.counts.length === dengueBoard.curve.days.length);
check("completeness 1 of 10", dash.ok && dash.data.completeness.reported.length === 1 &&
  dash.data.completeness.total === 10, dash.ok && dash.data.completeness);

console.log("\n--- 14. Soft delete ---");
const del = run(`apiDeleteCase(DTOK, ${JSON.stringify(c2.data.case_id)})`);
check("delete ok", del.ok === true, del);
const afterDel = run("apiListCases(DTOK,{})");
check("row hidden after delete", afterDel.ok && afterDel.data.total === 1, afterDel);
check("row physically retained for audit",
  run("readAll('Cases').length") === 2, run("readAll('Cases').length"));

console.log("\n--- 15. Data quality report ---");
const dq = run("dataQualityReport()");
check("no duplicate returns", dq.duplicates.length === 0, dq.duplicates);
check("detects the now-unbalanced dengue count", dq.mismatches.some(m => /Dengue/.test(m)), dq.mismatches);

console.log("\n--- 16. Date window ---");
const future = run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date: addDays(TODAY, 1) })`);
check("future date refused", future.ok === false && /future/.test(future.error), future);
const old = run(`apiSavePulse(TOK, { palika:'Khandbari Municipality', report_date: addDays(TODAY, -30) })`);
check("stale date refused", old.ok === false && /closed for editing/.test(old.error), old);

console.log("\n--- 17. Exports ---");
const exp = run("apiExport(DTOK,'linelist',{})");
check("line list CSV produced", exp.ok && /patient_name/.test(exp.data.csv), exp.ok && exp.data.filename);
const sum = run("apiExport(DTOK,'summary',{range:'30',scope:'all'})");
check("summary CSV produced", sum.ok && /Dengue/.test(sum.data.csv));
check("CSV escapes the remark field",
  run("apiExport(DTOK,'pulses',{})").data.csv.indexOf("RDT stock low") >= 0);

console.log("\n--- 18. Session expiry ---");
run("apiLogout(TOK)");
const expired = run("apiGetPulse(TOK,'Khandbari Municipality',TODAY)");
check("logged-out token rejected", expired.ok === false && expired.code === "SESSION_EXPIRED", expired);

console.log("\n--- 19. Audit trail ---");
const auditRows = run("readAll('Audit').length");
check("audit trail populated", auditRows > 8, auditRows);

console.log("\n--- 20. Session survives a cache eviction ---");
const relogin = run("apiLogin('Khandbari Municipality','TESTME')");
check("re-login ok", relogin.ok === true, relogin);
run(`var TOK2 = ${JSON.stringify(relogin.ok ? relogin.data.token : "")};`);
cacheControl.enabled = false;               // simulate Google evicting the cache
const survived = run("apiGetPulse(TOK2,'Khandbari Municipality',TODAY)");
cacheControl.enabled = true;
check("still signed in after eviction", survived.ok === true, survived);

console.log("\n--- 21. Expiry is enforced from the payload, not the cache ---");
run(`
  var k = sessionKey_(TOK2);
  var s = JSON.parse(PropertiesService.getScriptProperties().getProperty(k));
  s.expires = Date.now() - 1000;            // backdate it
  PropertiesService.getScriptProperties().setProperty(k, JSON.stringify(s));
  CacheService.getScriptCache().remove(k);
`);
const expiredNow = run("apiGetPulse(TOK2,'Khandbari Municipality',TODAY)");
check("expired session rejected", expiredNow.ok === false && expiredNow.code === "SESSION_EXPIRED", expiredNow);
check("expired token purged from durable store",
  run("PropertiesService.getScriptProperties().getProperty(sessionKey_(TOK2))") === null);

console.log("\n--- 22. Lockout is durable and cannot be reset by eviction ---");
run("clearAttempts_('unit:U03');");
for (let i = 0; i < 8; i++) run("apiLogin('Khandbari Municipality','NOPE')");
cacheControl.enabled = false;
const locked = run("apiLogin('Khandbari Municipality','TESTME')");
cacheControl.enabled = true;
check("locked out even with the right code", locked.ok === false && /Too many wrong codes/.test(locked.error), locked);
run("clearAttempts_('unit:U03');");
const afterClear = run("apiLogin('Khandbari Municipality','TESTME')");
check("login works once the lockout is cleared", afterClear.ok === true, afterClear);
run(`var TOK3 = ${JSON.stringify(afterClear.ok ? afterClear.data.token : "")};`);

console.log("\n--- 23. Read amplification ---");
run("resetCaches();");
counters.getValues = 0;
run(`apiSaveCase(TOK3, { palika:'Khandbari Municipality', disease:'scrub',
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
run("clearAttempts_('unit:U05');");
run(`
  var u5 = findByKey('Units','unit_id','U05');
  var s5 = randomToken(16);
  updateRowAt('Units', u5._row, Object.assign({}, u5, { code_hash: hashCode('NILNIL', s5), code_salt: s5 }));
  resetCaches();
`);
const nilLogin = run("apiLogin('Panchkhapan Municipality','NILNIL')");
run(`var NTOK = ${JSON.stringify(nilLogin.ok ? nilLogin.data.token : "")};`);
const nil = run(`apiSavePulse(NTOK, { palika:'Panchkhapan Municipality', report_date:TODAY, nil_report:true })`);
check("nil return accepted", nil.ok && nil.data.saved === true, nil);
check("nil flag persisted", nil.ok && nil.data.pulse.nil_report === true, nil.ok && nil.data.pulse.nil_report);
const dash2 = run("apiDashboard(NTOK,'30','all')");
check("nil report counts toward completeness",
  dash2.ok && dash2.data.completeness.reported.indexOf('Panchkhapan Municipality') >= 0,
  dash2.ok && dash2.data.completeness.reported);

console.log("\n========================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("========================================");
process.exit(fail ? 1 : 0);
