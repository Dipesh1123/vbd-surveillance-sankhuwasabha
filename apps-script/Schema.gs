/**
 * Schema.gs — single source of truth for the spreadsheet database.
 *
 * Every sheet, column, type and validation rule is declared here. Setup.gs builds
 * the workbook from this file; Repo.gs reads and writes through it. If you need a
 * new field, add it here and re-run "VBD Surveillance ▸ Set up / repair database"
 * from the spreadsheet menu — existing data is preserved and the new column is
 * appended.
 *
 * Types: 'text' | 'int' | 'bool' | 'date' (yyyy-mm-dd) | 'datetime' (ISO 8601)
 */

var SCHEMA = {

  /* ------------------------------------------------------------------ *
   * Units — the reporting master list. One row per palika (local level).
   * Also holds the hashed access code each focal person logs in with.
   * ------------------------------------------------------------------ */
  Units: {
    key: 'unit_id',
    frozen: 1,
    columns: [
      { name: 'unit_id',        type: 'text', width: 90,  note: 'Primary key, e.g. U01' },
      { name: 'palika',         type: 'text', width: 240, note: 'Official English name' },
      { name: 'palika_ne',      type: 'text', width: 160, note: 'Nepali name (Devanagari)' },
      { name: 'level_type',     type: 'text', width: 150, note: 'Municipality | Rural Municipality' },
      { name: 'wards',          type: 'int',  width: 70,  note: 'Number of wards' },
      { name: 'focal_person',   type: 'text', width: 160 },
      { name: 'phone',          type: 'text', width: 120 },
      { name: 'active',         type: 'bool', width: 70 },
      { name: 'updated_at',     type: 'datetime', width: 160 }
    ]
  },

  /* ------------------------------------------------------------------ *
   * Pulses — the daily aggregate return. Exactly one row per palika per
   * report_date. This is the denominator table (tests done, suspects) and
   * carries the declared positive count that the line list must reconcile to.
   * ------------------------------------------------------------------ */
  Pulses: {
    key: 'pulse_id',
    frozen: 1,
    naturalKey: ['unit_id', 'report_date'],
    columns: [
      { name: 'pulse_id',         type: 'text', width: 160, note: 'P-<unit_id>-<report_date>' },
      { name: 'report_date',      type: 'date', width: 110 },
      { name: 'unit_id',          type: 'text', width: 80 },
      { name: 'palika',           type: 'text', width: 220 },

      { name: 'dengue_suspects',  type: 'int', width: 90 },
      { name: 'dengue_ns1',       type: 'int', width: 80 },
      { name: 'dengue_igm',       type: 'int', width: 80 },
      { name: 'dengue_igg',       type: 'int', width: 80 },
      { name: 'dengue_pcr',       type: 'int', width: 80 },
      { name: 'dengue_positives', type: 'int', width: 100, note: 'Declared positives — must equal rows in Cases for this unit/date/disease' },

      { name: 'scrub_suspects',   type: 'int', width: 90 },
      { name: 'scrub_rdt',        type: 'int', width: 80 },
      { name: 'scrub_elisa',      type: 'int', width: 80 },
      { name: 'scrub_pcr',        type: 'int', width: 80 },
      { name: 'scrub_positives',  type: 'int', width: 100 },

      { name: 'nil_report',       type: 'bool', width: 80,  note: 'TRUE = nothing to report that day (still counts as reported)' },
      { name: 'remarks',          type: 'text', width: 280 },
      { name: 'reporter',         type: 'text', width: 140 },
      { name: 'submitted_at',     type: 'datetime', width: 160 },
      { name: 'updated_at',       type: 'datetime', width: 160 }
    ]
  },

  /* ------------------------------------------------------------------ *
   * Cases — the positive-case line list. Contains PII (patient name); this
   * sheet must never be shared publicly and the API only releases names to
   * a district-level session.
   * ------------------------------------------------------------------ */
  Cases: {
    key: 'case_id',
    frozen: 1,
    columns: [
      { name: 'case_id',      type: 'text', width: 110, note: 'Primary key, e.g. C-2083-0417' },
      { name: 'disease',      type: 'text', width: 100, note: 'dengue | scrub' },
      { name: 'unit_id',      type: 'text', width: 80 },
      { name: 'palika',       type: 'text', width: 220 },
      { name: 'ward',         type: 'int',  width: 70 },
      { name: 'tole',         type: 'text', width: 170, note: 'Settlement / cluster — drives outbreak response' },
      { name: 'patient_name', type: 'text', width: 190, note: 'PII — never published' },
      { name: 'age',          type: 'int',  width: 70 },
      { name: 'age_unit',     type: 'text', width: 80, note: 'years | months' },
      { name: 'sex',          type: 'text', width: 80, note: 'Male | Female | Other' },
      { name: 'test_type',    type: 'text', width: 110 },
      { name: 'test_date',    type: 'date', width: 110, note: 'Epidemiological date — all curves are built on this' },
      { name: 'outcome',      type: 'text', width: 120, note: 'treatment | recovered | died' },
      { name: 'reporter',     type: 'text', width: 140 },
      { name: 'created_at',   type: 'datetime', width: 160 },
      { name: 'updated_at',   type: 'datetime', width: 160 },
      { name: 'deleted',      type: 'bool', width: 80, note: 'Soft delete — rows are never physically removed' }
    ]
  },

  /* ------------------------------------------------------------------ *
   * Config — district settings a non-programmer can edit.
   * ------------------------------------------------------------------ */
  Config: {
    key: 'key',
    frozen: 1,
    columns: [
      { name: 'key',   type: 'text', width: 220 },
      { name: 'value', type: 'text', width: 420 },
      { name: 'note',  type: 'text', width: 420 }
    ]
  },

  /* ------------------------------------------------------------------ *
   * BS_Calendar — Bikram Sambat month-start reference data.
   *
   * Deliberately stored as data, not code: the Nepali calendar has irregular
   * month lengths that are fixed by the Nepal Calendar Determination
   * Committee, so a health office must be able to extend this table each
   * year WITHOUT a developer. One row = the AD date on which a BS month
   * starts. Dates outside the table fall back to showing the AD date.
   * ------------------------------------------------------------------ */
  BS_Calendar: {
    key: 'ad_start',
    frozen: 1,
    columns: [
      { name: 'ad_start', type: 'date', width: 120, note: 'AD date of BS month day 1' },
      { name: 'bs_year',  type: 'int',  width: 90 },
      { name: 'bs_month', type: 'int',  width: 90, note: '1 = Baisakh … 12 = Chaitra' }
    ]
  },

  /* ------------------------------------------------------------------ *
   * Audit — append-only trail. Every write to Pulses and Cases lands here.
   * ------------------------------------------------------------------ */
  Audit: {
    key: null,
    frozen: 1,
    columns: [
      { name: 'ts',        type: 'datetime', width: 170 },
      { name: 'actor',     type: 'text', width: 150, note: 'unit_id or DISTRICT' },
      { name: 'role',      type: 'text', width: 100 },
      { name: 'action',    type: 'text', width: 130, note: 'login | save_pulse | save_case | delete_case | set_outcome | export' },
      { name: 'entity_id', type: 'text', width: 150 },
      { name: 'detail',    type: 'text', width: 520 },
      { name: 'ip_hint',   type: 'text', width: 120 }
    ]
  }
};

/** Disease definitions — mirrored by the frontend. */
var DISEASES = {
  dengue: {
    key: 'dengue',
    label: 'Dengue',
    labelLower: 'dengue',
    labelNe: 'डेंगु',
    accent: '#c8102e',
    accentSoft: '#f2b6c1',
    tint: '#fdf2f4',
    /* [column suffix, display label] */
    fields: [['ns1', 'NS1'], ['igm', 'IgM'], ['igg', 'IgG'], ['pcr', 'PCR']],
    testTypes: ['NS1', 'IgM', 'IgG', 'PCR']
  },
  scrub: {
    key: 'scrub',
    label: 'Scrub typhus',
    labelLower: 'scrub typhus',
    labelNe: 'स्क्रब टाइफस',
    accent: '#003893',
    accentSoft: '#b8c5e2',
    tint: '#f1f4fb',
    fields: [['rdt', 'IgM RDT'], ['elisa', 'IgM ELISA'], ['pcr', 'PCR']],
    testTypes: ['IgM RDT', 'IgM ELISA', 'PCR']
  }
};

var OUTCOMES = {
  treatment: { label: 'Under treatment', labelNe: 'उपचाररत', bg: '#fdf7ea', border: '#f0e0bd', color: '#8a5b0f' },
  recovered: { label: 'Recovered',       labelNe: 'निको भएको', bg: '#eef5f0', border: '#cfe3d7', color: '#1c5e42' },
  died:      { label: 'Died',            labelNe: 'मृत्यु',     bg: '#fdf0f1', border: '#f6d5d8', color: '#b3261e' }
};

/** The 10 local levels of Sankhuwasabha district, Koshi Province. */
var SEED_UNITS = [
  ['U01', 'Chainpur Municipality',            'चैनपुर नगरपालिका',            'Municipality',       11],
  ['U02', 'Dharmadevi Municipality',          'धर्मदेवी नगरपालिका',          'Municipality',        9],
  ['U03', 'Khandbari Municipality',           'खाँदबारी नगरपालिका',          'Municipality',       11],
  ['U04', 'Madi Municipality',                'मादी नगरपालिका',              'Municipality',        9],
  ['U05', 'Panchkhapan Municipality',         'पाँचखपन नगरपालिका',           'Municipality',        9],
  ['U06', 'Bhotkhola Rural Municipality',     'भोटखोला गाउँपालिका',          'Rural Municipality',  5],
  ['U07', 'Chichila Rural Municipality',      'चिचिला गाउँपालिका',           'Rural Municipality',  5],
  ['U08', 'Makalu Rural Municipality',        'मकालु गाउँपालिका',            'Rural Municipality',  6],
  ['U09', 'Sabhapokhari Rural Municipality',  'सभापोखरी गाउँपालिका',         'Rural Municipality',  6],
  ['U10', 'Silichong Rural Municipality',     'सिलीचोङ गाउँपालिका',          'Rural Municipality',  5]
];

/**
 * Seed BS calendar rows. These are the month starts the reporting prototype was
 * validated against. EXTEND THIS TABLE each Nepali year — one row per month.
 */
var SEED_BS_CALENDAR = [
  ['2025-04-14', 2082, 1],  ['2025-05-15', 2082, 2],  ['2025-06-15', 2082, 3],
  ['2025-07-17', 2082, 4],  ['2025-08-17', 2082, 5],  ['2025-09-17', 2082, 6],
  ['2025-10-18', 2082, 7],  ['2025-11-17', 2082, 8],  ['2025-12-16', 2082, 9],
  ['2026-01-15', 2082, 10], ['2026-02-13', 2082, 11], ['2026-03-15', 2082, 12],
  ['2026-04-14', 2083, 1],  ['2026-05-15', 2083, 2],  ['2026-06-15', 2083, 3],
  ['2026-07-17', 2083, 4],  ['2026-08-17', 2083, 5],  ['2026-09-17', 2083, 6],
  ['2026-10-18', 2083, 7]
];

var SEED_CONFIG = [
  ['district_name',      'Sankhuwasabha',                     'Shown in the masthead'],
  ['district_name_ne',   'संखुवासभा',                          'Nepali district name'],
  ['province',           'Koshi Province',                    ''],
  ['office_name',        'Health Office Sankhuwasabha',       'Reporting office'],
  ['fiscal_year',        '२०८२/८३',                            'Shown in the top utility bar'],
  ['notice_text',        'Submit the daily return before 5:00 PM. Positive cases must be line-listed the same day.', 'Red notice strip on every screen'],
  ['logo_url',           '',                                  'Public image URL for the Nepal emblem. Leave blank to use the built-in mark.'],
  ['digest_email',       '',                                  'Optional. Address that receives the 5 PM "who has not reported" email.'],
  ['allow_backdate_days', '7',                                'How many days back a palika may still submit/edit a return'],
  ['timezone',           'Asia/Kathmandu',                    '']
];
