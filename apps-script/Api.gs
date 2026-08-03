/**
 * Api.gs — everything the browser is allowed to ask the server to do.
 *
 * All handlers return { ok: true, data } or { ok: false, error } via guard_().
 * All handlers that touch PII call requireDistrict(). All handlers that write
 * take the document lock.
 *
 * The reconciliation rules in validatePulse_() are the heart of the system: the
 * aggregate daily return and the individual line list must agree, because the
 * dashboard counts cases from the line list while the testing denominator comes
 * from the return. If the two drift, the positivity rate becomes meaningless.
 */

/* ------------------------------------------------------------ bootstrap -- */

/**
 * Everything the client needs to draw its shell: config, palika list, calendar,
 * and — if a session is supplied — that session's identity.
 */
function apiBootstrap(token) {
  return guard_(function () {
    // A reporter who opens the link before the district has finished setting up
    // should see an explanation, not a stack trace about a missing sheet.
    var missing = missingSheets();
    if (missing.length) {
      return { needsSetup: true, missing: missing, today: todayIso() };
    }

    var cfg = config();
    var bs = bsTable();
    var today = todayIso();

    var session = null;
    try {
      var s = requireSession(token);
      session = { role: s.role, unit_id: s.unit_id, palika: s.palika };
    } catch (e) { /* not signed in — that is fine */ }

    return {
      today: today,
      todayBs: adToBs(today, bs),
      todayBsLong: adToBsLong(today, bs),
      bsTable: bs,
      session: session,
      diseases: DISEASES,
      outcomes: OUTCOMES,
      units: units().map(function (u) {
        return {
          unit_id: u.unit_id, palika: u.palika, palika_ne: u.palika_ne,
          level_type: u.level_type, wards: u.wards
        };
      }),
      config: {
        district_name: cfg.district_name || 'Sankhuwasabha',
        district_name_ne: cfg.district_name_ne || 'संखुवासभा',
        province: cfg.province || 'Koshi Province',
        office_name: cfg.office_name || 'Health Office',
        fiscal_year: cfg.fiscal_year || '',
        notice_text: cfg.notice_text || '',
        logo_url: cfg.logo_url || '',
        allow_backdate_days: toInt(cfg.allow_backdate_days || 7)
      }
    };
  });
}

/* ------------------------------------------------------- daily returns --- */

/**
 * Fetch one palika's return for one date, plus the live reconciliation state
 * (how many positives are declared vs how many cases are actually line-listed).
 */
function apiGetPulse(token, palika, reportDate) {
  return guard_(function () {
    var s = requireSession(token);
    var unit = requireWritableUnit(s, palika);
    var date = toIsoDate(reportDate) || todayIso();

    var pulse = findByKey('Pulses', 'pulse_id', pulseId(unit.unit_id, date));
    var counts = caseCountsFor_(unit.unit_id, date);

    return {
      unit_id: unit.unit_id,
      palika: unit.palika,
      report_date: date,
      report_date_bs: adToBs(date, bsTable()),
      pulse: pulse ? stripRowMeta_(pulse) : null,
      entered: counts,
      issues: validatePulse_(pulse || {}, counts)
    };
  });
}

/**
 * Create or replace a palika's daily return. Re-submitting the same date
 * overwrites — that is intentional: the field workflow is "correct and resend",
 * not "file an amendment".
 */
function apiSavePulse(token, payload) {
  return guard_(function () {
    var s = requireSession(token);
    payload = payload || {};
    var unit = requireWritableUnit(s, payload.palika);
    var date = toIsoDate(payload.report_date);
    if (!date) throw userError('Report date is required.');

    assertDateWindow_(date);

    return withLock(function () {
      var counts = caseCountsFor_(unit.unit_id, date);
      var candidate = buildPulseRow_(unit, date, payload);
      var issues = validatePulse_(candidate, counts);

      var blocking = Object.keys(issues).filter(function (k) { return issues[k].level === 'error'; });
      if (blocking.length) {
        return { saved: false, issues: issues, entered: counts, message: issues[blocking[0]].message };
      }

      var id = pulseId(unit.unit_id, date);
      var existing = findByKey('Pulses', 'pulse_id', id);
      candidate.pulse_id = id;
      candidate.submitted_at = existing ? (existing.submitted_at || nowStamp()) : nowStamp();
      candidate.updated_at = nowStamp();

      upsertByKey('Pulses', 'pulse_id', candidate);

      audit(unit.unit_id, s.role, existing ? 'update_pulse' : 'save_pulse', id,
        'dengue tests ' + issues.dengue.tests + ', scrub tests ' + issues.scrub.tests +
        ', declared ' + candidate.dengue_positives + '/' + candidate.scrub_positives);

      return {
        saved: true,
        updated: !!existing,
        pulse: candidate,
        entered: counts,
        issues: validatePulse_(candidate, counts),
        message: (existing ? 'Updated ' : 'Saved ') + date +
          ' — dengue ' + issues.dengue.tests + ' tests, scrub typhus ' + issues.scrub.tests + ' tests.'
      };
    });
  });
}

/** Assemble a clean, fully-typed Pulses row from whatever the browser sent. */
function buildPulseRow_(unit, date, p) {
  var nil = toBool(p.nil_report);
  var row = {
    pulse_id: pulseId(unit.unit_id, date),
    report_date: date,
    unit_id: unit.unit_id,
    palika: unit.palika,
    nil_report: nil,
    remarks: toText(p.remarks, 400),
    reporter: toText(p.reporter, 80) || 'Focal person'
  };
  Object.keys(DISEASES).forEach(function (dk) {
    // A nil return is authoritative: it zeroes every count rather than trusting
    // whatever was left in the form. If the palika really did line-list a case
    // that day, validatePulse_ will refuse the save and say so.
    row[dk + '_suspects'] = nil ? 0 : toInt(p[dk + '_suspects']);
    row[dk + '_positives'] = nil ? 0 : toInt(p[dk + '_positives']);
    DISEASES[dk].fields.forEach(function (f) {
      row[dk + '_' + f[0]] = nil ? 0 : toInt(p[dk + '_' + f[0]]);
    });
  });
  return row;
}

/** How many line-list rows exist per disease for this unit/date. */
function caseCountsFor_(unitId, date) {
  var out = {};
  Object.keys(DISEASES).forEach(function (k) { out[k] = 0; });
  readAll('Cases').forEach(function (c) {
    if (c.deleted) return;
    if (c.unit_id !== unitId || c.test_date !== date) return;
    if (out[c.disease] === undefined) return;
    out[c.disease]++;
  });
  return out;
}

/**
 * The reconciliation rules. Mirrored byte-for-byte in the client so the reporter
 * sees the same message before they press save — but the server is the authority.
 *
 *   error : declared positives exceed tests done          (arithmetically impossible)
 *   error : more cases line-listed than declared          (line list would inflate counts)
 *   warn  : fewer cases line-listed than declared         (cases still owed)
 *   warn  : suspects fewer than tests                     (probable data-entry slip)
 */
function validatePulse_(pulse, entered) {
  var out = {};
  Object.keys(DISEASES).forEach(function (dk) {
    var d = DISEASES[dk];
    var tests = d.fields.reduce(function (a, f) { return a + toInt(pulse[dk + '_' + f[0]]); }, 0);
    var suspects = toInt(pulse[dk + '_suspects']);
    var declared = toInt(pulse[dk + '_positives']);
    var have = toInt((entered || {})[dk]);

    var level = null, message = '';
    if (declared > tests) {
      level = 'error';
      message = 'Positives (' + declared + ') cannot exceed tests done (' + tests + ').';
    } else if (have > declared) {
      level = 'error';
      message = have + ' ' + d.labelLower + ' case' + (have === 1 ? '' : 's') +
        ' already on the line list for this date, but only ' + declared + ' positive' +
        (declared === 1 ? '' : 's') + ' declared. Raise the number or delete the extra case' +
        (have - declared === 1 ? '' : 's') + '.';
    } else if (have < declared) {
      level = 'warn';
      message = 'Declared ' + declared + ' positive' + (declared === 1 ? '' : 's') + ' but ' +
        have + ' case' + (have === 1 ? '' : 's') + ' entered — add ' + (declared - have) +
        ' more on the Positive cases screen.';
    } else if (tests > 0 && suspects < tests) {
      level = 'warn';
      message = 'Suspects (' + suspects + ') is fewer than tests done (' + tests +
        '). You can still save, but check the figures.';
    }

    out[dk] = {
      tests: tests, suspects: suspects, declared: declared,
      entered: have, remaining: declared - have,
      level: level, message: message
    };
  });
  return out;
}

/** Reject dates in the future or older than the district's editing window. */
function assertDateWindow_(date) {
  var today = todayIso();
  if (date > today) throw userError('You cannot report for a future date.');
  var limit = toInt(configGet('allow_backdate_days', '7'));
  if (limit > 0 && daysBetween(date, today) > limit) {
    throw userError('That date is more than ' + limit + ' days old and is closed for editing. ' +
      'Ask the district office to reopen it.');
  }
}

/* ------------------------------------------------------------ line list -- */

/**
 * The line list. Patient names are returned ONLY to a district session; a unit
 * session gets its own palika's rows with the name masked.
 */
function apiListCases(token, filters) {
  return guard_(function () {
    var s = requireSession(token);
    var f = filters || {};
    var isDistrict = s.role === 'district';

    var rows = readAll('Cases').filter(function (c) { return !c.deleted; });

    // A unit may only ever see its own palika.
    if (!isDistrict) {
      rows = rows.filter(function (c) { return c.unit_id === s.unit_id; });
    } else if (f.scope && f.scope !== 'all') {
      rows = rows.filter(function (c) { return c.palika === f.scope; });
    }

    if (f.disease && f.disease !== 'all') rows = rows.filter(function (c) { return c.disease === f.disease; });
    if (f.from) rows = rows.filter(function (c) { return c.test_date >= f.from; });
    if (f.to) rows = rows.filter(function (c) { return c.test_date <= f.to; });
    if (f.outcome && f.outcome !== 'all') rows = rows.filter(function (c) { return (c.outcome || 'treatment') === f.outcome; });

    if (f.query) {
      var q = String(f.query).trim().toLowerCase();
      rows = rows.filter(function (c) {
        return (isDistrict && String(c.patient_name).toLowerCase().indexOf(q) >= 0) ||
               String(c.tole || '').toLowerCase().indexOf(q) >= 0 ||
               String(c.case_id).toLowerCase().indexOf(q) >= 0;
      });
    }

    rows.sort(function (a, b) {
      if (a.test_date !== b.test_date) return a.test_date < b.test_date ? 1 : -1;
      return a.case_id < b.case_id ? 1 : -1;
    });

    var total = rows.length;
    var page = Math.max(0, toInt(f.page));
    var perPage = Math.min(200, Math.max(10, toInt(f.perPage) || 50));
    var slice = rows.slice(page * perPage, page * perPage + perPage);

    var bs = bsTable();
    return {
      total: total,
      page: page,
      perPage: perPage,
      pages: Math.max(1, Math.ceil(total / perPage)),
      canSeeNames: isDistrict,
      rows: slice.map(function (c) { return publicCase_(c, isDistrict, bs); })
    };
  });
}

/** Shape a case for the wire, masking PII unless the caller is district. */
function publicCase_(c, withNames, bs) {
  return {
    case_id: c.case_id,
    disease: c.disease,
    unit_id: c.unit_id,
    palika: c.palika,
    ward: c.ward,
    tole: c.tole,
    patient_name: withNames ? c.patient_name : '••••••',
    age: c.age,
    age_unit: c.age_unit,
    sex: c.sex,
    test_type: c.test_type,
    test_date: c.test_date,
    test_date_bs: adToBs(c.test_date, bs),
    outcome: c.outcome || 'treatment',
    reporter: c.reporter,
    created_at: c.created_at
  };
}

function stripRowMeta_(row) {
  var out = {};
  Object.keys(row).forEach(function (k) { if (k !== '_row') out[k] = row[k]; });
  return out;
}

/**
 * Add or edit a positive case.
 * A new case is refused unless the daily return has declared room for it — this
 * is what keeps the line list and the aggregate return in step.
 */
function apiSaveCase(token, payload) {
  return guard_(function () {
    var s = requireSession(token);
    var p = payload || {};
    var unit = requireWritableUnit(s, p.palika);

    var errors = validateCase_(p);
    if (Object.keys(errors).length) {
      return { saved: false, errors: errors, message: 'Fill the highlighted fields before saving.' };
    }

    var disease = String(p.disease);
    if (!DISEASES[disease]) throw userError('Unknown disease.');

    var testDate = toIsoDate(p.test_date) || todayIso();
    assertDateWindow_(testDate);

    if (DISEASES[disease].testTypes.indexOf(String(p.test_type)) === -1) {
      throw userError('That test type is not valid for ' + DISEASES[disease].label + '.');
    }

    return withLock(function () {
      var all = readAll('Cases');
      var editing = p.case_id ? all.filter(function (c) { return c.case_id === p.case_id && !c.deleted; })[0] : null;
      if (p.case_id && !editing) throw userError('That case no longer exists.');
      if (editing && s.role !== 'district' && editing.unit_id !== s.unit_id) throw userError('NOT_YOUR_PALIKA');

      /*
       * A case belongs to a "slot": one unit, one date, one disease. That slot
       * is what the daily return declares a positive count for.
       *
       * The quota therefore has to be checked for a NEW case *and* for an edit
       * that MOVES a case to a different slot — changing the test date, the
       * disease, or (district only) the palika. Without this, editing was a
       * back door straight past the reconciliation rule: the destination day
       * would silently hold more cases than it declared, and the origin day
       * would be left short, with neither figure ever having been checked.
       *
       * The row being moved still counts at its old slot while we look, so the
       * destination count below correctly excludes it.
       */
      var movedSlot = !!editing && (
        editing.test_date !== testDate ||
        editing.disease !== disease ||
        editing.unit_id !== unit.unit_id
      );

      if (!editing || movedSlot) {
        var pulse = findByKey('Pulses', 'pulse_id', pulseId(unit.unit_id, testDate));
        var declared = pulse ? toInt(pulse[disease + '_positives']) : 0;
        var have = caseCountsFor_(unit.unit_id, testDate)[disease];
        if (have >= declared) {
          var where = unit.palika + ' on ' + testDate;
          return {
            saved: false,
            quota: { declared: declared, entered: have, moved: movedSlot },
            message: declared
              ? 'The daily return for ' + where + ' declares ' + declared + ' ' +
                DISEASES[disease].labelLower + ' positive' + (declared === 1 ? '' : 's') +
                ' and ' + have + ' are already entered. Raise the count on Daily numbers ' +
                (movedSlot ? 'for that date before moving this case here.' : 'before adding another.')
              : 'No ' + DISEASES[disease].labelLower + ' positives are declared for ' + where +
                '. Enter the count on Daily numbers first' +
                (movedSlot ? ' before moving this case there.' : '.')
          };
        }
      }

      var now = nowStamp();
      var row = {
        case_id: editing ? editing.case_id : nextCaseId(all.map(function (c) { return c.case_id; })),
        disease: disease,
        unit_id: unit.unit_id,
        palika: unit.palika,
        ward: toInt(p.ward),
        tole: toText(p.tole, 120),
        patient_name: toText(p.patient_name, 120),
        age: toInt(p.age),
        age_unit: p.age_unit === 'months' ? 'months' : 'years',
        sex: ['Male', 'Female', 'Other'].indexOf(String(p.sex)) >= 0 ? String(p.sex) : '',
        test_type: toText(p.test_type, 40),
        test_date: testDate,
        outcome: OUTCOMES[p.outcome] ? p.outcome : (editing ? editing.outcome : 'treatment'),
        reporter: toText(p.reporter, 80) || 'Focal person',
        created_at: editing ? editing.created_at : now,
        updated_at: now,
        deleted: false
      };

      if (editing) updateRowAt('Cases', editing._row, row);
      else insertRow('Cases', row);

      audit(unit.unit_id, s.role, editing ? 'update_case' : 'save_case', row.case_id,
        DISEASES[disease].label + ' ward ' + row.ward + ' ' + testDate +
        (movedSlot ? ' (moved from ' + editing.palika + '/' + editing.disease + '/' + editing.test_date + ')' : ''));

      // Moving a case leaves its origin day declaring one more positive than it
      // now holds. Say so, or the district finds it in the weekly check instead.
      var movedNote = movedSlot
        ? ' The daily return for ' + editing.palika + ' on ' + editing.test_date +
          ' now declares one more ' + DISEASES[editing.disease].labelLower +
          ' positive than it holds — correct it on Daily numbers.'
        : '';

      return {
        saved: true,
        updated: !!editing,
        moved: movedSlot,
        case_id: row.case_id,
        message: editing
          ? 'Saved changes to ' + row.case_id + '.' + movedNote
          : row.case_id + ' added to the line list.'
      };
    });
  });
}

function validateCase_(f) {
  var e = {};
  if (!toText(f.patient_name, 120)) e.patient_name = 'Patient name is required.';
  if (!String(f.age === 0 ? '0' : (f.age || '')).trim()) e.age = 'Age is required.';
  if (['Male', 'Female', 'Other'].indexOf(String(f.sex)) === -1) e.sex = 'Select sex.';
  if (!String(f.ward || '').trim() || toInt(f.ward) < 1) e.ward = 'Ward number is required.';
  if (!String(f.test_type || '').trim()) e.test_type = 'Select the test type.';

  var age = toInt(f.age);
  if (f.age_unit === 'years' && age > 120) e.age = 'Check the age — over 120 years.';
  if (f.age_unit === 'months' && age > 24) e.age = 'Use years once the child is over 24 months.';
  return e;
}

/** Soft delete — the row stays in the sheet with deleted = TRUE for audit. */
function apiDeleteCase(token, caseId) {
  return guard_(function () {
    var s = requireSession(token);
    return withLock(function () {
      var c = findByKey('Cases', 'case_id', caseId);
      if (!c || c.deleted) throw userError('That case no longer exists.');
      if (s.role !== 'district' && c.unit_id !== s.unit_id) throw userError('NOT_YOUR_PALIKA');

      updateRowAt('Cases', c._row, Object.assign(stripRowMeta_(c), {
        deleted: true, updated_at: nowStamp()
      }));
      audit(c.unit_id, s.role, 'delete_case', c.case_id, 'soft deleted');

      return {
        deleted: true,
        case_id: c.case_id,
        message: c.case_id + ' removed from the line list. The daily return for ' +
          c.test_date + ' now declares more positives than are entered — correct it on Daily numbers.'
      };
    });
  });
}

/** Outcome is a district-level clinical judgement, so district session only. */
function apiSetOutcome(token, caseId, outcome) {
  return guard_(function () {
    var s = requireDistrict(token);
    if (!OUTCOMES[outcome]) throw userError('Unknown outcome.');
    return withLock(function () {
      var c = findByKey('Cases', 'case_id', caseId);
      if (!c || c.deleted) throw userError('That case no longer exists.');
      updateRowAt('Cases', c._row, Object.assign(stripRowMeta_(c), {
        outcome: outcome, updated_at: nowStamp()
      }));
      audit('DISTRICT', s.role, 'set_outcome', c.case_id, outcome);
      return { case_id: c.case_id, outcome: outcome };
    });
  });
}

/* ------------------------------------------------------------ dashboard -- */

/**
 * Aggregate figures for the public dashboard. Contains no patient-level data,
 * so any signed-in role may call it.
 *
 * @param {string} range 'today' | '7' | '30' | 'all'
 * @param {string} scope palika name or 'all'
 */
function apiDashboard(token, range, scope) {
  return guard_(function () {
    requireSession(token);

    var pulses = readAll('Pulses');
    var cases = readAll('Cases').filter(function (c) { return !c.deleted; });
    var today = todayIso();
    var bs = bsTable();

    var names = (scope && scope !== 'all') ? [scope] : palikaNames();
    var inScope = {};
    names.forEach(function (n) { inScope[n] = true; });

    // Window of dates the "range" columns cover.
    var from;
    if (range === 'today') from = today;
    else if (range === 'all') from = '0000-01-01';
    else from = addDays(today, -(toInt(range) || 30) + 1);

    var boards = Object.keys(DISEASES).map(function (dk) {
      return buildBoard_(dk, pulses, cases, inScope, names, from, today, bs, range);
    });

    return {
      today: today,
      range: range || '30',
      rangeLabel: rangeLabel_(range),
      scope: scope || 'all',
      boards: boards,
      completeness: completenessFor_(pulses, today)
    };
  });
}

function rangeLabel_(range) {
  if (range === 'today') return 'today';
  if (range === 'all') return 'all data to date';
  return 'last ' + (toInt(range) || 30) + ' days';
}

function buildBoard_(dk, pulses, cases, inScope, names, from, today, bs, range) {
  var d = DISEASES[dk];
  var testsOf = function (p) {
    return d.fields.reduce(function (a, f) { return a + toInt(p[dk + '_' + f[0]]); }, 0);
  };

  var rows = names.map(function (name) {
    var mine = pulses.filter(function (p) { return p.palika === name; });
    var cs = cases.filter(function (c) { return c.palika === name && c.disease === dk; });
    var reportedToday = mine.some(function (p) { return p.report_date === today; });

    return {
      palika: name,
      palikaShort: shortName(name),
      reported: reportedToday,
      testsRange: mine.filter(function (p) { return p.report_date >= from && p.report_date <= today; })
                      .reduce(function (a, p) { return a + testsOf(p); }, 0),
      testsCum: mine.reduce(function (a, p) { return a + testsOf(p); }, 0),
      posRange: cs.filter(function (c) { return c.test_date >= from && c.test_date <= today; }).length,
      posCum: cs.length
    };
  });

  var total = ['testsRange', 'testsCum', 'posRange', 'posCum'].reduce(function (o, k) {
    o[k] = rows.reduce(function (a, r) { return a + r[k]; }, 0);
    return o;
  }, {});

  // Epidemic curve: always at least 14 days so the shape is readable, by test date.
  var span = (range === 'all')
    ? Math.max(14, Math.min(120, daysBetween(earliestDate_(cases, pulses, today), today) + 1))
    : Math.max(14, range === 'today' ? 14 : (toInt(range) || 30));
  var curveFrom = addDays(today, -span + 1);
  var days = dateRange(curveFrom, today);

  var perDay = days.map(function (day) {
    return cases.filter(function (c) {
      return c.disease === dk && c.test_date === day && inScope[c.palika];
    }).length;
  });

  return {
    key: dk,
    label: d.label,
    labelNe: d.labelNe,
    accent: d.accent,
    accentSoft: d.accentSoft,
    rows: rows,
    total: total,
    curve: {
      days: days,
      daysBs: days.map(function (x) { return adToBs(x, bs); }),
      counts: perDay
    }
  };
}

function earliestDate_(cases, pulses, fallback) {
  var min = fallback;
  cases.forEach(function (c) { if (c.test_date && c.test_date < min) min = c.test_date; });
  pulses.forEach(function (p) { if (p.report_date && p.report_date < min) min = p.report_date; });
  return min;
}

/** Which palikas have filed today's return — the district's 4 PM phone list. */
function completenessFor_(pulses, date) {
  var all = palikaNames();
  var done = {};
  pulses.forEach(function (p) { if (p.report_date === date) done[p.palika] = true; });
  var reported = all.filter(function (n) { return done[n]; });
  var missing = all.filter(function (n) { return !done[n]; });
  return {
    date: date,
    total: all.length,
    reported: reported,
    notReported: missing,
    pct: all.length ? Math.round(reported.length / all.length * 100) : 0
  };
}

/* -------------------------------------------------------------- exports -- */

/**
 * Server-side CSV generation. Returning text (not a file) keeps the download in
 * the browser and avoids needing Drive scopes. District-only for anything with
 * names on it.
 */
function apiExport(token, what, opts) {
  return guard_(function () {
    var s = requireSession(token);
    var o = opts || {};
    var bs = bsTable();
    var lines = [];
    var filename;

    if (what === 'pulses') {
      filename = 'daily-returns-' + todayIso() + '.csv';
      var pcols = SCHEMA.Pulses.columns.map(function (c) { return c.name; });
      lines.push(csvLine(pcols.concat(['report_date_bs'])));
      readAll('Pulses')
        .filter(function (p) { return !o.scope || o.scope === 'all' || p.palika === o.scope; })
        .sort(function (a, b) { return a.report_date < b.report_date ? 1 : -1; })
        .forEach(function (p) {
          lines.push(csvLine(pcols.map(function (c) { return p[c]; }).concat([adToBs(p.report_date, bs)])));
        });

    } else if (what === 'summary') {
      filename = 'palika-summary-' + todayIso() + '.csv';
      var dash = apiDashboard(token, o.range || '30', o.scope || 'all');
      if (!dash.ok) throw userError(dash.error);
      lines.push(csvLine(['Disease', 'Palika', 'Tests (' + dash.data.rangeLabel + ')',
        'Tests cumulative', 'Positive (' + dash.data.rangeLabel + ')', 'Cases cumulative']));
      dash.data.boards.forEach(function (b) {
        b.rows.forEach(function (r) {
          lines.push(csvLine([b.label, r.palika, r.testsRange, r.testsCum, r.posRange, r.posCum]));
        });
        lines.push(csvLine([b.label, 'TOTAL', b.total.testsRange, b.total.testsCum, b.total.posRange, b.total.posCum]));
      });

    } else if (what === 'linelist') {
      // Patient names leave the system only for district staff.
      requireDistrict(token);
      filename = 'line-list-' + todayIso() + '.csv';
      lines.push(csvLine(['case_id', 'disease', 'palika', 'ward', 'tole', 'patient_name',
        'age', 'age_unit', 'sex', 'test_type', 'test_date', 'test_date_bs', 'outcome', 'reporter']));
      readAll('Cases')
        .filter(function (c) { return !c.deleted; })
        .filter(function (c) { return !o.scope || o.scope === 'all' || c.palika === o.scope; })
        .filter(function (c) { return !o.disease || o.disease === 'all' || c.disease === o.disease; })
        .sort(function (a, b) { return a.test_date < b.test_date ? 1 : -1; })
        .forEach(function (c) {
          lines.push(csvLine([c.case_id, DISEASES[c.disease] ? DISEASES[c.disease].label : c.disease,
            c.palika, c.ward, c.tole, c.patient_name, c.age, c.age_unit, c.sex,
            c.test_type, c.test_date, adToBs(c.test_date, bs), c.outcome, c.reporter]));
        });

    } else {
      throw userError('Unknown export.');
    }

    audit(s.unit_id || 'DISTRICT', s.role, 'export', what, lines.length - 1 + ' rows');
    return { filename: filename, csv: lines.join('\r\n') };
  });
}

/* ------------------------------------------------- district admin views -- */

/** The weekly data-quality report, exposed to the district screen. */
function apiDataQuality(token) {
  return guard_(function () {
    requireDistrict(token);
    return dataQualityReport();
  });
}
