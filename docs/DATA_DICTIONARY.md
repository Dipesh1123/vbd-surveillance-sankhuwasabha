# Data dictionary

Six sheets. `Schema.gs` is the authoritative definition — this document
explains *why* each field exists and how it is meant to be used. If the two ever
disagree, `Schema.gs` is right and this file needs updating.

Dates are stored as `yyyy-mm-dd` (Gregorian). Bikram Sambat is a display
conversion only; it is never stored, so the data stays sortable and comparable
with national reporting.

---

## The reporting model in one paragraph

A palika files **one `Pulses` row per day** — how many suspected cases were
seen, how many tests of each type were done, and **how many came back
positive**. Every one of those positives must then appear as a **`Cases` row**
with the patient's details. The system refuses to let the two drift apart. This
matters because the dashboard takes its *numerator* (cases) from the line list
and its *denominator* (tests) from the daily return; if they disagree, the test
positivity rate — the number that actually tells you whether an outbreak is
growing — becomes meaningless.

---

## Pulses — the daily aggregate return

One row per palika per day. Primary key `pulse_id`, natural key
`unit_id + report_date`. Re-submitting a date **overwrites** the row.

| Column | Type | Notes |
|---|---|---|
| `pulse_id` | text | `P-<unit_id>-<report_date>`, e.g. `P-U03-2026-08-01` |
| `report_date` | date | The day being reported on, not the day it was typed |
| `unit_id` | text | → `Units.unit_id` |
| `palika` | text | Denormalised for humans reading the sheet |
| `dengue_suspects` | int | Clinically suspected, whether or not tested |
| `dengue_ns1` | int | NS1 antigen tests done |
| `dengue_igm` | int | IgM tests done |
| `dengue_igg` | int | IgG tests done |
| `dengue_pcr` | int | PCR tests done |
| `dengue_positives` | int | **Declared positives.** Must equal the number of dengue `Cases` rows for this unit and date |
| `scrub_suspects` | int | |
| `scrub_rdt` | int | IgM RDT tests done |
| `scrub_elisa` | int | IgM ELISA tests done |
| `scrub_pcr` | int | PCR tests done |
| `scrub_positives` | int | Declared positives, same rule |
| `nil_report` | bool | `TRUE` = nothing seen, nothing tested. Forces every count to 0 |
| `remarks` | text | Free text — stockouts, referrals |
| `reporter` | text | Currently always `Focal person`; the unit is authenticated, not the individual |
| `submitted_at` | datetime | First submission. Preserved across edits |
| `updated_at` | datetime | Last edit |

**Total tests** for a disease is the sum of its test-type columns. It is
deliberately *not* stored — a stored total is one more thing that can go stale.

### Why `nil_report` exists

"No row" and "a row of zeros" mean completely different things in surveillance.
No row means the palika did not report and you must telephone them. A nil report
means they did report, and there was genuinely nothing. Without this
distinction, completeness figures are worthless.

---

## Cases — the positive-case line list

One row per confirmed positive case. **Contains PII.** Never share this tab,
never publish it, never paste it into a group chat.

| Column | Type | Notes |
|---|---|---|
| `case_id` | text | `C-0001`, sequential. Never reused, including after deletion |
| `disease` | text | `dengue` \| `scrub` |
| `unit_id` | text | → `Units.unit_id` |
| `palika` | text | Denormalised |
| `ward` | int | Ward number — the unit that vector control actually works in |
| `tole` | text | Settlement/cluster. **The most operationally useful field here** — two cases in one tole is a response trigger; two in one palika is not |
| `patient_name` | text | **PII.** Released by the API to anyone who asks — there is no authentication |
| `age` | int | |
| `age_unit` | text | `years` \| `months`. Infants are reported in months |
| `sex` | text | `Male` \| `Female` \| `Other` |
| `test_type` | text | Must be valid for the disease (see `Schema.gs ▸ DISEASES`) |
| `test_date` | date | **The epidemiological date.** Every curve and every range filter uses this, not the entry date |
| `outcome` | text | `treatment` | `recovered` | `died`. Anyone may set it |\| `recovered` \| `died`. District staff only |
| `reporter` | text | |
| `created_at` / `updated_at` | datetime | |
| `deleted` | bool | **Soft delete.** Rows are never physically removed |

### Why `test_date` and not the submission date

A specimen taken on Tuesday may be reported on Thursday. Building the epidemic
curve on the entry date would smear the outbreak by however long the lab took
and make the curve reflect laboratory logistics rather than transmission.

### Why deletes are soft

A deleted case is a change to a notifiable-disease count. The row stays with
`deleted = TRUE` so the audit trail stays complete. Deleting a case also leaves
that day's return declaring more positives than exist — the system says so
explicitly and the reporter must correct the daily figure too.

### Slots, and why edits are checked too

A case belongs to a **slot**: one `unit_id`, one `test_date`, one `disease`.
That slot is exactly what a daily return declares a positive count for.

So the quota is checked not only when a case is created, but whenever an edit
*moves* a case to a different slot — a corrected test date, a corrected disease,
or (district only) a corrected palika. Without that check, editing would be a
back door straight past reconciliation: the destination day would quietly hold
more cases than it declared, and the origin day would be left short, with
neither figure ever having been verified.

A permitted move still leaves the **origin** day over-declared by one. The
system says so in the confirmation message and the weekly data quality check
lists it until the daily return is corrected.

---

## Units — reporting units and their credentials

| Column | Type | Notes |
|---|---|---|
| `unit_id` | text | `U01`…`U10` |
| `palika` | text | Official English name. Used as the display key throughout |
| `palika_ne` | text | Devanagari name |
| `level_type` | text | `Municipality` \| `Rural Municipality` |
| `wards` | int | Reference for ward-number validation |
| `focal_person` / `phone` | text | Fill these in — this is your call list |
| `active` | bool | `FALSE` hides the unit everywhere without deleting history |


---

## Config — district settings

Plain `key` / `value` / `note`. Editable by a non-programmer. See
`DEPLOYMENT.md ▸ Step 4` for the keys that matter.


---

## BS_Calendar — Nepali calendar reference

| Column | Type | Notes |
|---|---|---|
| `ad_start` | date | The Gregorian date on which a Bikram Sambat month begins |
| `bs_year` | int | e.g. `2083` |
| `bs_month` | int | `1` = बैशाख … `12` = चैत |

**This is reference data, held deliberately in the sheet rather than in code.**
Bikram Sambat month lengths are irregular and are fixed each year by the Nepal
Calendar Determination Committee — they cannot be computed from a formula. Any
value hardcoded from memory would eventually be wrong, and a health office must
be able to correct the calendar without a programmer.

Dates outside the loaded table fall back to displaying the Gregorian date. A
correct English date is better than a confident wrong Nepali one.

**Seeded through 2083-07 (starts 2026-10-18), so conversion stops working around
19 November 2026.** See `OPERATIONS.md`.

---

## Audit — append-only trail

| Column | Notes |
|---|---|
| `ts` | Local timestamp |
| `actor` | `unit_id` or `DISTRICT` |
| `role` | `unit` \| `district` \| `admin` \| `system` |
| `action` | `login`, `login_failed`, `login_blocked`, `logout`, `save_pulse`, `update_pulse`, `save_case`, `update_case`, `delete_case`, `set_outcome`, `export`, `issue_codes`, `reset_code` |
| `entity_id` | The `pulse_id` or `case_id` touched |
| `detail` | Human-readable summary |

Audit writes never throw. A failure to log must not cost a health worker their
data entry — failures go to the execution log instead.

This sheet grows without bound. Archive it yearly.

---

## Validation rules

Enforced on the **server**, in `Api.gs ▸ validatePulse_()` and
`validateCase_()`, and mirrored in the browser so the reporter sees the same
message before pressing save. The browser copy is a courtesy; the server copy is
the rule.

| Condition | Level | Effect |
|---|---|---|
| declared positives > tests done | **error** | Save refused — arithmetically impossible |
| line-listed cases > declared positives | **error** | Save refused — the line list would inflate the count |
| line-listed cases < declared positives | warn | Save allowed; cases still owed |
| suspects < tests done | warn | Save allowed; probable data-entry slip |
| new case when line list already meets the declared count | **error** | Case refused; raise the daily figure first |
| editing a case onto a date/disease/palika with no room | **error** | Refused; the destination must declare the positive first |
| `test_date` in the future | **error** | Refused |
| `test_date` older than `allow_backdate_days` | **error** | Refused; district must reopen |
| test type not valid for the disease | **error** | Refused |
| age > 120 years, or > 24 months | **error** | Refused; likely a unit mix-up |

---

## Access control

There is none. Every row in this dictionary is readable and writable by anyone
who has the URL.

| | Anyone with the link |
|---|---|
| Dashboard (aggregates) | yes |
| Any palika's daily return | yes, read and write |
| Any palika's positive cases | yes, add, edit and delete |
| Patient names | yes, in full |
| Set outcome | yes |
| Export line list with names | yes |

`publicCase_()` used to mask `patient_name` for anyone without a district
session. It no longer masks anything, because there are no sessions to
distinguish. See `README.md ▸ Access model` for why, and `OPERATIONS.md` for
what to do if that becomes a problem.

The only remaining server-side protections are the reconciliation rules, the
date window, and the field validation above — all of which guard *data quality*,
not confidentiality.
