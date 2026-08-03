# Operations manual

For the district surveillance officer who owns this system day to day.

---

## Daily — around 5 PM

1. Open the web app — it opens straight onto the dashboard, no sign-in.
2. **Dashboard ▸ Reporting completeness · today.**
3. Press **Copy the list to call** and telephone the palikas listed under
   *Not yet reported*.
4. Remind them that a quiet day still needs a return — they should tick
   **Nothing to report today** rather than skip it.

A palika showing under *Not yet reported* has filed nothing at all. A palika
that filed a nil return counts as reported, which is the entire point of the
distinction.

## Weekly

**VBD Surveillance ▸ Data quality check** in the spreadsheet. It reports three
things:

| Finding | What it means | What to do |
|---|---|---|
| **Duplicate returns** | The same palika and date appear twice | Should be impossible through the app. If it happens, someone edited the sheet by hand — delete the wrong row |
| **Line list does not reconcile** | Declared positives ≠ line-listed cases | Ring the palika. Usually a case was deleted without correcting the daily figure |
| **Positives exceed tests** | Arithmetically impossible | Hand-edited data. Correct it |

Reconciliation gaps are the ones that matter. Every one is a case that either
exists and is not counted, or is counted and does not exist.

## Monthly

- Skim the **Audit** tab for edits and deletions you cannot account for. With no
  sign-in there is nothing to correlate them against, so an unexplained change
  is worth a phone call rather than a shrug.
- Check `Units.focal_person` and `phone` are current. Staff rotate.
- Export the line list and store a copy somewhere you control. Google is not a
  backup strategy you own.

## Annually (start of the fiscal year)

1. Update `Config ▸ fiscal_year`.
2. **Extend the Nepali calendar** — see below.
3. Consider archiving: copy the workbook, then delete rows older than two years
   from the working copy. Past roughly 20,000 rows the app gets noticeably slow.
4. Confirm the URL has not spread beyond current staff. It is the only control.

---

## Extending the Nepali calendar

**The seeded table ends at 2083-07 (starting 2026-10-18). From about 19 November
2026, Nepali dates will silently display as Gregorian dates instead.** Nothing
breaks and no data is lost — the app deliberately falls back rather than
guessing — but the display stops being useful.

To extend it:

1. Get an authoritative Nepali calendar (a printed patro, or the Nepal Calendar
   Determination Committee's published table). **Do not use a random website.**
2. For each Nepali month, note the Gregorian date on which day 1 falls.
3. Add one row per month to the **BS_Calendar** tab:

   | ad_start | bs_year | bs_month |
   |---|---|---|
   | 2026-11-17 | 2083 | 8 |
   | 2026-12-16 | 2083 | 9 |
   | … | | |

   `bs_month` is `1` for बैशाख through `12` for चैत.
4. Keep rows in ascending `ad_start` order.
5. Reload the web app — the conversion picks up immediately.

Doing a whole year at a time (12 rows) is a 10-minute job once a year.

---

## Access — the URL is the whole of it

There are no access codes. There is no sign-in. Whoever opens the link can read
every patient name and can add, edit or delete any case in any palika.

That means the URL is the only thing standing between the line list and the
public, so treat it the way you would have treated a password:

- Send it to focal persons individually, not to a group that outlives its
  members.
- Keep it out of printed material, notice boards and public documents.
- When a focal person leaves, there is **nothing to revoke**. If you need to cut
  someone off, the only lever is to publish a new deployment, which changes the
  URL, and redistribute it — see `HOSTING.md ▸ Deploying a change to the
  backend`.

**If patient confidentiality becomes a concern**, the fastest mitigation that
does not require re-adding logins is to stop the app showing names: the
spreadsheet keeps them, and the district reads them there, protected by the
Google account that owns the file.

Because there is no identity, the **Audit tab records what changed but not who
changed it** — every row is attributed to `open`. Use it for "when did this
number change", never for "who did this".

---

## Responding to what the data shows

The system is built around the fields that drive action:

- **`tole` clustering** — two or more cases in the same tole within a week is a
  response trigger. Palika-level counts are too coarse to act on.
- **Test positivity** = positives ÷ tests, per palika, over the selected period.
  Rising positivity with flat test numbers means transmission is increasing.
  Rising case counts with proportionally rising tests may just be more testing.
- **The 7-day average line** on the epidemic curve is what to read for trend.
  Daily bars are noisy — a single lab batch can double a day.
- **Reporting completeness** — before believing a fall in cases, check whether
  palikas simply stopped reporting.

---

## When something goes wrong

**A palika cannot get in** — there is nothing to sign into, so this is either
the wrong URL or no connection. Send them the link again and have them open
`/api/health` in the browser; if that returns JSON, the site is up.

**A palika is missing from the dropdown** — check `Units.active` is `TRUE` for
that row, then reload.

**Someone reports a wrong number** — they resubmit the same date. It overwrites.
No amendment workflow exists by design; correcting and resending is what field
staff actually do.

**A case was entered against the wrong palika, date or disease** — anyone may
edit it directly. The move is only accepted if the destination day
has already declared a positive with room for it, so raise that palika's count
on Daily numbers first. Afterwards the **origin** day is over-declared by one —
the confirmation message says so, and the weekly check lists it until you
correct that return too.

Anyone can move a case between palikas; the only check is that the destination
day has declared room for it.

**The date is closed for editing** — returns older than `allow_backdate_days`
(default 7) are locked. Raise the value in `Config` temporarily, let them
submit, then put it back.

**You need to recover something** — the spreadsheet has full version history:
**File ▸ Version history ▸ See version history**. Combined with the `Audit` tab
you can reconstruct what changed and when. Not *who* — there is no identity to
record.

---

## Running the tests

Any time the code changes, from the project root:

```bash
npm install     # once
npm test
```

This runs six suites — **381 checks**: syntax parsing, client/server contract
consistency, 69 backend logic tests, 65 data-integrity edge cases, 98 frontend
tests that drive the real UI in a headless DOM against the real backend, 17
covering what a reporter or admin sees before the database has been provisioned
at all, 69 covering the hosted path over JSON/HTTP, and 63 covering the Vercel
proxy.

They cannot catch everything — they do not run inside Google's actual runtime —
but a failure here is always a real problem.
