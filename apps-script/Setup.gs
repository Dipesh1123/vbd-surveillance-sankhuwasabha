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
    '1. Deploy ▸ New deployment ▸ Web app (Execute as: Me, Access: Anyone)\n' +
    '2. VBD Surveillance ▸ Show web app URL, and send it to every palika';
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
        focal_person: '', phone: '', active: true, updated_at: stamp
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

/**
 * ► RUN THIS ONE FIRST ◄
 *
 * One-shot provisioning for a command-line deployment: build the database and
 * print the web app URL. Run it once from the editor's Run button instead of
 * walking the spreadsheet menu.
 *
 * Deliberately NOT called "bootstrap" — that sat directly beside `apiBootstrap`
 * in the editor's function dropdown, and picking the wrong one gives a
 * confusing "Sheet Config is missing" error instead of setting anything up.
 */
function provisionEverything() {
  setupDatabase();
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { /* not deployed yet */ }

  console.log('\n=== PROVISIONING COMPLETE ===');
  console.log('Web app URL: ' + (url || '(deploy the web app, then run showWebAppUrl)'));
  console.log('There are no access codes. Anyone with that URL can read every');
  console.log('patient name and can add, edit or delete cases.');
  console.log('Next: set district_name, office_name and notice_text on the Config tab.');

  return { url: url };
}

/** Headless version of the menu item, for `clasp run`. */
function showWebAppUrl() {
  var url = ScriptApp.getService().getUrl() || '';
  console.log(url || 'Not deployed yet — Deploy > New deployment > Web app.');
  return url;
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
