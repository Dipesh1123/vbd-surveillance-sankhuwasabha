# VBD Surveillance — Sankhuwasabha

Daily dengue and scrub typhus reporting for Health Office Sankhuwasabha, Koshi
Province. Ten palikas file a daily return from a phone; the district gets a
live dashboard, a reconciled line list, and an audit trail.

**Three tiers, no servers to run:**

| Tier | Technology |
|---|---|
| Frontend | Static single-page app on Vercel — plain HTML/CSS/JS, no framework, no build step |
| Backend | Google Apps Script (`.gs`) — validation, aggregation, exports |
| Database | Google Sheets — six tabs, defined in `Schema.gs` |

The frontend talks to the backend as a JSON API through a same-origin proxy
(`api/rpc.js`). That proxy exists because an Apps Script web app cannot answer a
CORS preflight — see [`docs/HOSTING.md`](docs/HOSTING.md) before changing it.

The same app is **also** served directly by Apps Script at its own `/exec` URL,
from generated copies of the same source, so the district is not left with
nothing if the hosted site is unreachable.

---

## Getting started

- **Hosting and the two URLs** → [`docs/HOSTING.md`](docs/HOSTING.md)
- **Deploying it** → [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- **Running it** → [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- **The schema** → [`docs/DATA_DICTIONARY.md`](docs/DATA_DICTIONARY.md)

```bash
npm install
npm test        # 381 checks — see the list below
```

Deploying from the command line with `clasp` is supported — see
[the clasp route](docs/DEPLOYMENT.md#appendix-the-clasp-route). It automates
everything except the one-time Google authorisation, which no tool can.

**Edit `public/`, not `apps-script/*.html`.** `apps-script/App.html` and
`Styles.html` are generated from `public/app.js` and `public/styles.css` by
`npm run build:gas`, which `npm test` runs first. Two hand-maintained copies of a
1,500-line client would drift within a week.

---

## Layout

```
public/                 the site Vercel serves — EDIT THIS
  index.html            page shell
  config.js             where the browser sends API calls
  app.js                the client application
  styles.css            design tokens and layout

api/                    Vercel serverless functions
  _upstream.js          which Apps Script deployment to talk to
  rpc.js                same-origin proxy — the reason CORS is not a problem
  health.js             one-request deployment check

apps-script/            pushed by clasp
  Schema.gs             every sheet and column, in one place
  Util.gs               dates, Bikram Sambat, coercion, error shaping
  Repo.gs               the only code that touches SpreadsheetApp
  Setup.gs              provisioning and the data quality report
  Api.gs                everything the browser may ask for
  Rpc.gs                doPost — the JSON API, with its allowlist (the only gate)
  Code.gs               doGet, the daily digest trigger
  Index.html            page shell for the direct /exec fallback
  Styles.html           GENERATED from public/styles.css
  App.html              GENERATED from public/app.js
  appsscript.json       manifest and OAuth scopes

test/                   runs on Node, not in Google
  gasmock.js            mock Apps Script runtime (sheets, cache, properties, locks)
  harness.js            shared jsdom wiring for both transports
  backend.test.js       69 logic tests
  edge.test.js          65 data-integrity edge cases
  frontend.test.js      98 UI tests in jsdom against the real backend
  setup.test.js         17 tests: first-run state before the database exists
  transport.test.js     69 tests: the hosted path — the client over JSON/HTTP
  proxy.test.js         63 tests: the Vercel function, redirects and failures
  syntax.check.js       parses every .gs and inline script
  contract.check.js     client calls vs server functions vs the RPC allowlist

scripts/
  build-gas-html.js     regenerates the Apps Script HTML from public/
  clasp-create.js       creates the Sheet + script without losing our manifest
  clasp-redeploy.js     updates the existing web app instead of minting a new URL

vercel.json             static root, cache and security headers
docs/
Dengue Scrub Reporting.dc.html    the original approved design prototype
```

The `.dc.html` prototype is kept as the visual reference. It is not deployed —
it carries mock data and a design-time runtime. The production UI reproduces its
layout and design tokens exactly.

---

## The one rule the system enforces

A palika's daily return declares **how many positives** it found. Every declared
positive must appear on the line list as a named case. The system will not let
the two drift:

- declaring more positives than tests done → **refused**
- line-listing more cases than declared → **refused**
- line-listing fewer → allowed, but flagged as still owed
- adding a case beyond the declared count → **refused**, with instructions
- *editing* a case onto a date, disease or palika with no room → **refused**
  (otherwise editing is a back door around every rule above)

This exists because the dashboard's numerator (cases) and denominator (tests)
come from different places. If they disagree, test positivity — the figure that
tells you whether an outbreak is growing — stops meaning anything.

The rules live in `Api.gs ▸ validatePulse_()` and are enforced **server-side**.
The browser runs the same logic so the reporter sees the message before
submitting, but the client copy is only a courtesy.

---

## Access model — there isn't one

**The system has no authentication.** No codes, no sessions, no roles. Anyone
who has the URL can do anything the app can do:

- read every patient's name, age, ward and tole
- file or overwrite any palika's daily return
- add, edit or delete any case, including death outcomes

This was a deliberate decision by the district. Access codes were suppressing
reporting at palikas where staff share a device and forget them, and reporting
completeness was judged to matter more than confidentiality. It is a real
trade, not an oversight, and it is written down here so nobody has to guess
later whether the missing checks were intentional.

What follows from it:

- **The URL is the only secret.** Treat it the way you would have treated the
  access codes. It should not go in a public document or a group chat that
  outlives the people in it.
- **The audit trail records what changed, never who.** Every row is attributed
  to `open`. It can tell you a case was deleted at 16:42; it cannot tell you by
  whom.
- **A wrong palika is now a data risk.** Nothing stops a reporter filing under
  the wrong palika except the selector in the sidebar, which is why it is a
  standing control rather than something buried in a form.
- **The reconciliation rules carry more weight than before.** They are the only
  remaining automatic check on whether the numbers make sense.

If this ever needs reversing, the removal is one commit — see the history for
`Auth.gs`, which held the sessions, roles and lockout.

---

## What this will not do

Stated plainly so nobody is surprised later:

- **It is not built for scale.** Ten palikas and a few thousand rows a year is
  comfortable. Past roughly 20,000 rows it gets slow and needs archiving; past a
  few years, or beyond one district, it needs a real database.
- **Patient names sit on Google servers outside Nepal, behind no login.** Confirm
  this against your data policy before entering real data.
- **The Nepali calendar needs feeding.** Month lengths are set annually by the
  Nepal Calendar Determination Committee and cannot be computed. The seeded
  table ends **19 November 2026**, after which dates display as Gregorian until
  someone extends the `BS_Calendar` tab. This is a deliberate fallback, not a
  bug — see `docs/OPERATIONS.md`.
- **Tests do not run inside Google's runtime.** They run against a mock, so they
  catch logic errors, not platform quirks. Work through the verification
  checklist in `docs/DEPLOYMENT.md` after deploying.
- **There is no offline mode.** A reporter with no signal cannot submit.
- **The hosted site adds a third party to the chain.** Vercel now sits between
  the reporter and Google. Patient data passes through it in transit — it is
  never stored there — and if Vercel is down, palikas must fall back to the
  `/exec` URL. Keep that URL somewhere the district can find it.
