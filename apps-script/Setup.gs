/**
 * Setup.gs — provisioning and administration.
 *
 * Run "Set up / repair database" once after binding the script to a new
 * spreadsheet. It is idempotent and non-destructive: existing sheets keep their
 * data, missing sheets are created, missing columns are appended to the right.
 */

/** Spreadsheet menu — the district admin's whole control panel. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('VBD Surveillance')
    .addItem('Set up / repair database', 'setupDatabase')
    .addSeparator()
    .addItem('Issue access codes for all palikas', 'menuIssueAllCodes')
    .addItem('Reset one palika access code…', 'menuResetUnitCode')
    .addItem('Reset district (line-list) access code…', 'menuResetDistrictCode')
    .addSeparator()
    .addItem('Show web app URL', 'menuShowUrl')
    .addItem('Data quality check', 'menuDataQuality')
    .addToUi();
}

/* --------------------------------------------------------- provisioning -- */

/**
 * Create or repair every sheet declared in SCHEMA.
 * Safe to run repeatedly.
 */
function setupDatabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);
  var created = [], repaired = [];

  Object.keys(SCHEMA).forEach(function (name) {
    var def = SCHEMA[name];
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      created.push(name);
    }

    var wanted = def.columns.map(function (c) { return c.name; });
    var lastCol = sh.getLastColumn();
    var existing = lastCol > 0
      ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); })
      : [];

    if (!existing.length) {
      sh.getRange(1, 1, 1, wanted.length).setValues([wanted]);
    } else {
      // Append any column the schema has gained since this workbook was built.
      var missing = wanted.filter(function (w) { return existing.indexOf(w) === -1; });
      if (missing.length) {
        sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
        repaired.push(name + ' (+' + missing.join(', +') + ')');
      }
    }

    styleSheet_(sh, def);
  });

  resetCaches();
  seedReferenceData_();
  orderSheets_(ss);

  var msg = 'Database ready.\n\n' +
    (created.length ? 'Created: ' + created.join(', ') + '\n' : '') +
    (repaired.length ? 'Repaired: ' + repaired.join('; ') + '\n' : '') +
    '\nNext steps:\n' +
    '1. VBD Surveillance ▸ Issue access codes for all palikas\n' +
    '2. VBD Surveillance ▸ Reset district (line-list) access code\n' +
    '3. Deploy ▸ New deployment ▸ Web app (Execute as: Me, Access: Anyone)';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
}

/** Header formatting, freezing, column widths, protection of the audit trail. */
function styleSheet_(sh, def) {
  var n = def.columns.length;
  var head = sh.getRange(1, 1, 1, n);
  head.setBackground('#003893')
      .setFontColor('#ffffff')
      .setFontWeight('bold')
      .setVerticalAlignment('middle')
      .setWrap(true);
  sh.setFrozenRows(def.frozen || 1);
  sh.setRowHeight(1, 34);

  def.columns.forEach(function (c, i) {
    if (c.width) sh.setColumnWidth(i + 1, c.width);
    if (c.note) sh.getRange(1, i + 1).setNote(c.note);
  });

  // Keep the PII column visually flagged so nobody screenshots it by accident.
  if (sh.getName() === 'Cases') {
    var idx = {};
    def.columns.forEach(function (c, i) { idx[c.name] = i + 1; });
    if (idx.patient_name) {
      sh.getRange(1, idx.patient_name).setBackground('#8f1a2b').setNote('PII — never publish or share this column.');
    }
  }
}

/** Put the sheets in a sensible left-to-right order for a human reader. */
function orderSheets_(ss) {
  ['Pulses', 'Cases', 'Units', 'Config', 'BS_Calendar', 'Audit'].forEach(function (name, i) {
    var sh = ss.getSheetByName(name);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
  var first = ss.getSheetByName('Pulses');
  if (first) ss.setActiveSheet(first);
}

/** Seed Units, Config and BS_Calendar only when they are empty. */
function seedReferenceData_() {
  var uSheet = sheetFor('Units');
  if (uSheet.getLastRow() < 2) {
    var stamp = nowStamp();
    var rows = SEED_UNITS.map(function (u) {
      return toRowArray('Units', {
        unit_id: u[0], palika: u[1], palika_ne: u[2], level_type: u[3], wards: u[4],
        focal_person: '', phone: '', code_hash: '', code_salt: '', active: true, updated_at: stamp
      });
    });
    uSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }

  var cSheet = sheetFor('Config');
  if (cSheet.getLastRow() < 2) {
    var crows = SEED_CONFIG.map(function (c) {
      return toRowArray('Config', { key: c[0], value: c[1], note: c[2] });
    });
    cSheet.getRange(2, 1, crows.length, crows[0].length).setValues(crows);
  }

  var bSheet = sheetFor('BS_Calendar');
  if (bSheet.getLastRow() < 2) {
    var brows = SEED_BS_CALENDAR.map(function (b) {
      return toRowArray('BS_Calendar', { ad_start: b[0], bs_year: b[1], bs_month: b[2] });
    });
    bSheet.getRange(2, 1, brows.length, brows[0].length).setValues(brows);
  }

  resetCaches();
}

/* -------------------------------------------------------- access codes --- */

/**
 * Generate a fresh 6-character code for every palika.
 * The plain codes are shown ONCE in a dialog — they are stored only as hashes,
 * so if the district loses the list it must re-issue rather than look them up.
 */
function menuIssueAllCodes() {
  var ui = SpreadsheetApp.getUi();
  var confirm = ui.alert(
    'Issue new access codes',
    'This replaces the access code of EVERY palika. Anyone using an old code will be locked out.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  var issued = issueAllCodes();
  ui.alert(
    'Access codes — copy these now',
    'These are shown only once. Distribute them to each focal person by phone or in person.\n\n' +
      issued.map(function (i) { return i.palika + '  →  ' + i.code; }).join('\n') +
      '\n\nThe spreadsheet stores only a one-way hash, so they cannot be recovered later.',
    ui.ButtonSet.OK
  );
}

function menuResetUnitCode() {
  var ui = SpreadsheetApp.getUi();
  var names = palikaNames();
  var prompt = ui.prompt(
    'Reset one palika code',
    'Type the palika number:\n\n' + names.map(function (n, i) { return (i + 1) + '. ' + n; }).join('\n'),
    ui.ButtonSet.OK_CANCEL
  );
  if (prompt.getSelectedButton() !== ui.Button.OK) return;

  var pick = parseInt(prompt.getResponseText(), 10);
  if (isNaN(pick) || pick < 1 || pick > names.length) { ui.alert('That is not one of the numbers listed.'); return; }

  var target = names[pick - 1];
  var u = findByKey('Units', 'palika', target);
  if (!u) { ui.alert('Palika not found.'); return; }

  var code = newAccessCode_();
  var salt = randomToken(16);
  updateRowAt('Units', u._row, Object.assign({}, u, {
    code_hash: hashCode(code, salt), code_salt: salt, updated_at: nowStamp()
  }));
  resetCaches();
  audit('DISTRICT', 'admin', 'reset_code', u.unit_id, 'code reset for ' + target);
  ui.alert('New code for ' + target, code + '\n\nShown once — write it down now.', ui.ButtonSet.OK);
}

/** The district code gates the line list and outcome screens, i.e. all PII. */
function menuResetDistrictCode() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt(
    'District (line-list) access code',
    'This code unlocks patient names. Give it only to district surveillance staff.\n\n' +
      'Type a new code (6–24 characters), or leave blank to have one generated:',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  var typed = res.getResponseText().trim();
  if (typed && typed.length < 6) { ui.alert('Too short — use at least 6 characters.'); return; }

  var code = setDistrictCode(typed);
  ui.alert('District access code set', code + '\n\nShown once — store it securely.', ui.ButtonSet.OK);
}

/* ------------------------------------------------- headless equivalents --- */

/*
 * The three functions below do the same work as the menu items but never touch
 * SpreadsheetApp.getUi(), which throws when there is no spreadsheet window.
 * That makes them runnable from the Apps Script editor's Run button, from a
 * time-driven trigger, or from `clasp run` — so a deployment driven from the
 * command line does not have to stop and open a browser tab to finish.
 *
 * They print the new codes to the execution log. TREAT THAT LOG AS SECRET
 * until the codes have been distributed, then clear it.
 */

/**
 * Issue a fresh access code to every active palika.
 * @return {Array<{unit_id: string, palika: string, code: string}>}
 */
function issueAllCodes() {
  var issued = [];
  readAll('Units').forEach(function (u) {
    if (!u.unit_id) return;
    var code = newAccessCode_();
    var salt = randomToken(16);
    updateRowAt('Units', u._row, Object.assign({}, u, {
      code_hash: hashCode(code, salt), code_salt: salt, updated_at: nowStamp()
    }));
    issued.push({ unit_id: u.unit_id, palika: u.palika, code: code });
  });
  resetCaches();
  audit('DISTRICT', 'admin', 'issue_codes', '', issued.length + ' palika codes reissued');

  console.log('=== PALIKA ACCESS CODES (shown once) ===');
  issued.forEach(function (i) { console.log('  ' + i.palika + '  ->  ' + i.code); });
  console.log('=== distribute these, then clear this log ===');
  return issued;
}

/**
 * Set the district (line-list) code that unlocks patient names.
 * @param {string=} code Leave empty to generate one.
 * @return {string} the plaintext code — the only time it is ever available.
 */
function setDistrictCode(code) {
  code = String(code || '').trim();
  if (!code) code = newAccessCode_() + '-' + newAccessCode_();
  if (code.length < 6) throw userError('District code must be at least 6 characters.');

  var salt = randomToken(16);
  configSet('district_code_salt', salt);
  configSet('district_code_hash', hashCode(code, salt));
  resetCaches();
  audit('DISTRICT', 'admin', 'reset_district_code', '', 'district line-list code changed');

  console.log('=== DISTRICT ACCESS CODE (shown once) ===');
  console.log('  ' + code);
  return code;
}

/**
 * ► RUN THIS ONE FIRST ◄
 *
 * One-shot provisioning for a command-line deployment: build the database,
 * issue every code, and print the web app URL. Run it once from the editor's
 * Run button instead of walking the spreadsheet menu.
 *
 * Deliberately NOT called "bootstrap" — that sat directly beside `apiBootstrap`
 * in the editor's function dropdown, and picking the wrong one gives a
 * confusing "Sheet Config is missing" error instead of setting anything up.
 */
function provisionEverything() {
  setupDatabase();
  var codes = issueAllCodes();
  var district = setDistrictCode('');
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { /* not deployed yet */ }

  console.log('\n=== PROVISIONING COMPLETE ===');
  console.log('Web app URL: ' + (url || '(deploy the web app, then run showWebAppUrl)'));
  console.log('District code: ' + district);
  console.log('Palika codes: ' + codes.length + ' issued (listed above)');
  console.log('Next: set district_name, office_name and notice_text on the Config tab.');

  return { url: url, districtCode: district, codes: codes };
}

/** Headless version of the menu item, for `clasp run`. */
function showWebAppUrl() {
  var url = ScriptApp.getService().getUrl() || '';
  console.log(url || 'Not deployed yet — Deploy > New deployment > Web app.');
  return url;
}

/** Codes avoid look-alike characters (0/O, 1/I) — they get read out over the phone. */
function newAccessCode_() {
  var chars = 'ACDEFGHJKLMNPQRTUVWXY34679';
  var out = '';
  for (var i = 0; i < 6; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/* ---------------------------------------------------------- admin info --- */

function menuShowUrl() {
  var url = ScriptApp.getService().getUrl();
  var ui = SpreadsheetApp.getUi();
  if (!url) {
    ui.alert('Not deployed yet', 'Deploy ▸ New deployment ▸ Web app, then run this again.', ui.ButtonSet.OK);
    return;
  }
  ui.alert('Reporting web app', url + '\n\nSend this link to every palika focal person.', ui.ButtonSet.OK);
}

/**
 * Data quality report — the check a surveillance officer should run weekly.
 * Finds the three failure modes that actually bite in routine reporting:
 * duplicate returns, line list not reconciling to declared positives, and
 * positives exceeding tests.
 */
function menuDataQuality() {
  var report = dataQualityReport();
  var lines = [];

  lines.push('Rows: ' + report.pulseCount + ' daily returns, ' + report.caseCount + ' cases.');
  lines.push('');

  if (report.duplicates.length) {
    lines.push('DUPLICATE RETURNS (' + report.duplicates.length + ') — same palika and date twice:');
    report.duplicates.slice(0, 15).forEach(function (d) { lines.push('  • ' + d); });
  } else {
    lines.push('No duplicate daily returns.');
  }
  lines.push('');

  if (report.mismatches.length) {
    lines.push('LINE LIST DOES NOT RECONCILE (' + report.mismatches.length + '):');
    report.mismatches.slice(0, 20).forEach(function (m) { lines.push('  • ' + m); });
    if (report.mismatches.length > 20) lines.push('  … and ' + (report.mismatches.length - 20) + ' more');
  } else {
    lines.push('Every declared positive has a matching line-list entry.');
  }
  lines.push('');

  if (report.overTests.length) {
    lines.push('POSITIVES EXCEED TESTS (' + report.overTests.length + '):');
    report.overTests.slice(0, 15).forEach(function (m) { lines.push('  • ' + m); });
  } else {
    lines.push('No return declares more positives than tests.');
  }

  try {
    SpreadsheetApp.getUi().alert('Data quality check', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    console.log(lines.join('\n'));
  }
}

function dataQualityReport() {
  var pulses = readAll('Pulses');
  var cases = readAll('Cases').filter(function (c) { return !c.deleted; });

  var seen = {}, duplicates = [];
  pulses.forEach(function (p) {
    var k = p.unit_id + '|' + p.report_date;
    if (seen[k]) duplicates.push(p.palika + ' on ' + p.report_date);
    seen[k] = true;
  });

  // Count line-list rows per unit/date/disease once, then compare.
  var counted = {};
  cases.forEach(function (c) {
    var k = c.unit_id + '|' + c.test_date + '|' + c.disease;
    counted[k] = (counted[k] || 0) + 1;
  });

  var mismatches = [], overTests = [];
  pulses.forEach(function (p) {
    Object.keys(DISEASES).forEach(function (dk) {
      var d = DISEASES[dk];
      var declared = toInt(p[dk + '_positives']);
      var entered = counted[p.unit_id + '|' + p.report_date + '|' + dk] || 0;
      var tests = d.fields.reduce(function (a, f) { return a + toInt(p[dk + '_' + f[0]]); }, 0);

      if (declared !== entered) {
        mismatches.push(p.palika + ' ' + p.report_date + ' ' + d.label +
          ': declared ' + declared + ', line list has ' + entered);
      }
      if (declared > tests) {
        overTests.push(p.palika + ' ' + p.report_date + ' ' + d.label +
          ': ' + declared + ' positive vs ' + tests + ' tests');
      }
    });
  });

  return {
    pulseCount: pulses.length,
    caseCount: cases.length,
    duplicates: duplicates,
    mismatches: mismatches,
    overTests: overTests
  };
}
