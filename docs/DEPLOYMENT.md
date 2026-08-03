# Deployment guide

Setting up the VBD Surveillance reporting system from nothing. Allow about
40 minutes. You need one Google account that will **own** the data — use an
office account, not a personal one, because whoever owns it owns the patient
line list.

---

## Before you start

| You need | Why |
|---|---|
| A Google account for the health office | Owns the spreadsheet and runs the web app |
| The 10 palika names confirmed | Seeded in `Schema.gs` — edit before first run if a name has changed |
| A phone list of focal persons | You will read access codes out to them |

> **Data governance note.** Patient names will be stored on Google servers
> outside Nepal. Confirm this is acceptable under your office's data policy
> *before* entering real patient data. If it is not, the same code can run
> against a self-hosted database, but that is a different deployment.

---

## Step 1 — Create the spreadsheet

1. Go to <https://sheets.new>.
2. Rename it something unambiguous, e.g.
   `VBD Surveillance — Sankhuwasabha (LIVE)`.
3. **File ▸ Settings ▸ Time zone**: set to `(GMT+05:45) Kathmandu`.
   The setup script also does this, but set it by hand so the sheet is right
   even if setup is never run.

## Step 2 — Attach the script

1. In the spreadsheet: **Extensions ▸ Apps Script**.
2. Delete the empty `Code.gs` that Google creates.
3. Create each file below and paste in the matching contents from
   `apps-script/`. **The names must match exactly.**

   | Add as | From |
   |---|---|
   | Script file `Schema` | `apps-script/Schema.gs` |
   | Script file `Util` | `apps-script/Util.gs` |
   | Script file `Repo` | `apps-script/Repo.gs` |
   | Script file `Setup` | `apps-script/Setup.gs` |
   | Script file `Auth` | `apps-script/Auth.gs` |
   | Script file `Api` | `apps-script/Api.gs` |
   | Script file `Code` | `apps-script/Code.gs` |
   | HTML file `Index` | `apps-script/Index.html` |
   | HTML file `Styles` | `apps-script/Styles.html` |
   | HTML file `App` | `apps-script/App.html` |

   *Add a script file:* the **+** next to "Files" ▸ **Script**.
   *Add an HTML file:* the **+** ▸ **HTML**. Apps Script appends `.gs` / `.html`
   itself — type only `Schema`, `Index`, and so on.

4. Show the manifest: **Project Settings** (gear) ▸ tick
   **Show "appsscript.json" manifest file in editor**.
5. Open `appsscript.json` and replace its contents with
   `apps-script/appsscript.json`.
6. **Save** (Ctrl+S).

### Faster alternative: clasp

See **[the clasp route](#appendix-the-clasp-route)** at the end of this
document. It replaces steps 1, 2, 3, 5 and 6 with four commands — but **not**
step 4 (Config) and not the one-time browser authorisation, which no tool can
automate.

## Step 3 — Build the database

1. Go back to the **spreadsheet** tab and reload the page (F5).
2. A **VBD Surveillance** menu appears next to Help.
   *If it does not:* reload again — the menu is added by `onOpen`, which only
   runs on a fresh load of the spreadsheet.
3. **VBD Surveillance ▸ Set up / repair database**.
4. Google asks for authorisation the first time:
   **Review permissions** ▸ pick the office account ▸ **Advanced** ▸
   **Go to (project name) (unsafe)** ▸ **Allow**.
   The "unsafe" warning appears for every unverified in-house script; it means
   Google has not reviewed it, not that something is wrong.
5. Run the menu item again if the authorisation prompt interrupted it.

You should now have six tabs: **Pulses, Cases, Units, Config, BS_Calendar,
Audit**, with `Units` pre-filled with the 10 palikas.

This step is safe to re-run at any time. It never deletes data — it only adds
missing sheets and missing columns.

## Step 4 — Set the district settings

Open the **Config** tab and edit the `value` column:

| Key | Set it to |
|---|---|
| `district_name` / `district_name_ne` | Your district |
| `office_name` | e.g. `Health Office Sankhuwasabha` |
| `fiscal_year` | e.g. `२०८२/८३` |
| `notice_text` | The red banner every reporter sees. Change it during an outbreak. |
| `allow_backdate_days` | How many days back a palika may still edit. Default `7`. |
| `session_hours` | How long a sign-in lasts. Default `10`. |
| `logo_url` | Optional. A public image URL for the emblem; blank uses a built-in mark. |
| `digest_email` | Optional. Gets the 5 PM "who has not reported" email. |

Do **not** hand-edit `district_code_hash` or `district_code_salt` — the menu
manages those.

## Step 5 — Issue access codes

1. **VBD Surveillance ▸ Issue access codes for all palikas**.
2. A dialog lists every palika and its 6-character code.
   **Copy this list now.** Codes are stored only as a one-way hash, so nobody —
   including you — can look them up later. If you lose one, reissue it.
3. **VBD Surveillance ▸ Reset district (line-list) access code**. Leave the box
   blank to have one generated. This code unlocks **patient names**; give it
   only to district surveillance staff.

## Step 6 — Publish the web app

1. In the Apps Script editor: **Deploy ▸ New deployment**.
2. Gear icon ▸ **Web app**.
3. Set:
   - **Description**: `v1`
   - **Execute as**: **Me** (the office account)
   - **Who has access**: **Anyone**
4. **Deploy**, then copy the **Web app URL**.

> **"Anyone" does not mean unprotected.** It means a visitor does not need a
> Google account — necessary because focal persons often have none. The app
> shows nothing but a sign-in box until a valid access code is entered. It must
> be set this way for palika staff to reach it at all.

Test the URL yourself, then send it to the focal persons with their codes.
`VBD Surveillance ▸ Show web app URL` will print it again later.

## Step 7 — Optional: the 5 PM reminder

1. Put an address in `Config ▸ digest_email`.
2. Apps Script editor ▸ **Triggers** (alarm clock) ▸ **Add trigger**:
   - Function: `dailyCompletenessDigest`
   - Event source: **Time-driven**
   - Type: **Day timer**, **5pm to 6pm**
3. Save and authorise.

---

## Updating the app later

Edit the files, then **Deploy ▸ Manage deployments ▸** (pencil) **▸ Version:
New version ▸ Deploy**. The URL stays the same.

If you only press Save and not Deploy, reporters keep seeing the old version.
That is the single most common mistake with Apps Script.

---

## Verification checklist

Run through this before announcing the system:

- [ ] Open the web app URL in a private window — a sign-in box appears
- [ ] A wrong code is refused and says how many attempts remain
- [ ] A correct palika code signs in and shows the dashboard
- [ ] Daily numbers: entering 6 NS1 + 2 IgM shows **Total tests 8**
- [ ] Entering 9 positives against 8 tests blocks the submit button
- [ ] Submitting writes a row to the **Pulses** tab
- [ ] Positive cases refuses a third case when only 2 were declared
- [ ] Line list shows the padlock until the district code is entered
- [ ] With the district code, patient names appear
- [ ] A second palika's code cannot see the first palika's cases
- [ ] The **Audit** tab has a row for each of the above

---

## Troubleshooting

**"VBD Surveillance" menu missing** — reload the spreadsheet. If it still does
not appear, open the script editor and run `onOpen` once by hand.

**`Sheet "Pulses" is missing`** (or `Config`, or any other sheet name) — the
database has not been built yet. Run *VBD Surveillance ▸ Set up / repair
database* from the spreadsheet menu, or `provisionEverything` from the editor.
**Do not run `apiBootstrap`** — it looks similar in the function list but is a
different function; it loads the web page's data and assumes the database
already exists. If a reporter opens the link before setup is done, the page
now shows a plain-language "not ready yet" message instead of this error.

**Reporters see a stale version** — you saved but did not deploy a new version.

**"Too many wrong codes"** — the lockout is 15 minutes. To clear it now, reissue
that palika's code.

**Everything is slow** — check how many rows are in `Cases` and `Pulses`. Past
roughly 20,000 rows, archive completed fiscal years to a separate workbook.

**Nepali dates show as `2026-11-25`** — the BS calendar table has run out.
See `OPERATIONS.md ▸ Extending the Nepali calendar`.

---

## Appendix: the clasp route

`clasp` is Google's command-line tool for Apps Script. It automates most of the
above, but be clear about the boundary before you start.

### What clasp can and cannot do

| Step | clasp? |
|---|---|
| Create the spreadsheet + bound script | **yes** — `clasp create --type sheets` |
| Upload all 11 files | **yes** — `clasp push` |
| Publish the web app with the right access settings | **yes** — `clasp deploy` reads them from `appsscript.json` |
| Build the database and issue codes | **yes, via `provisionEverything()`** — but something has to invoke it |
| **Grant the OAuth consent** | **no. Never.** |
| Fill in the Config tab | no — it is your district's content |

**The authorisation cannot be automated, by clasp or anything else.** The first
time any function runs, Google shows an interactive consent screen — including
the *"Google hasn't verified this app"* warning that needs **Advanced ▸ Go to
(project) (unsafe)**. That is a deliberate security boundary. Budget one browser
visit.

> `clasp run` can execute functions from the terminal, but it needs a standard
> GCP project, the Apps Script API switched on, and your own OAuth client
> credentials. For a one-off district deployment that is more work than clicking
> **Run** once in the editor. It is worth it only if you are deploying to many
> districts.

### The commands

> Written for **clasp v3** (`clasp --version` ≥ 3.0). v3 renamed several
> commands — `clasp open` no longer exists, and `clasp deployments` /
> `clasp redeploy` are now aliases of `list-deployments` / `update-deployment`.
> The `npm run` scripts below use the correct names, so prefer them over typing
> clasp directly.

```bash
npm install -g @google/clasp
npm run clasp:login        # browser opens once — authorise clasp itself
npm run clasp:whoami       # confirms which account you are on

npm run clasp:create       # creates the Sheet + script, keeps our manifest
npm run clasp:status       # optional — lists exactly what will be uploaded
npm run clasp:push         # runs the full test suite, then uploads

npm run clasp:open         # Apps Script editor opens
```

In the editor that just opened:

1. Choose **`provisionEverything`** from the function dropdown and press **Run**.
   > ⚠️ **Do not run `apiBootstrap`.** It sits nearby alphabetically but is a
   > different thing entirely — it's what the web page calls to *load* its
   > data, and it needs the database to already exist. Running it first
   > produces `Sheet "Config" is missing` and sets nothing up. If you see that
   > error, you ran the wrong one — run `provisionEverything` instead.
2. Authorise when prompted (**Advanced ▸ Go to … (unsafe) ▸ Allow**).
3. Press **Run** again if the prompt interrupted it.
4. Open **Execution log**. It prints every palika code and the district code.
   **Copy them now** — they are stored only as hashes and are never shown again.
   Then clear the log, because it is sitting in a browser tab containing live
   credentials.

Then publish and finish:

```bash
npm run clasp:deploy       # tests, push, then create the web app deployment
```

Finally, open the spreadsheet and fill in the **Config** tab (Step 4 above), and
work through the [verification checklist](#verification-checklist).

### What `provisionEverything()` does

It is the headless equivalent of walking the menu — safe to re-run, and it never
destroys data:

- `setupDatabase()` — creates any missing sheet or column
- `issueAllCodes()` — a fresh code for every palika, printed to the log
- `setDistrictCode('')` — generates the line-list code, printed to the log
- prints the web app URL if one has been deployed

Because it reissues **every** code, only run it again if you actually intend to
lock out everyone holding an old one.

### Updating afterwards — use redeploy, not deploy

```bash
npm run clasp:redeploy      # tests, push, then UPDATE the existing web app
```

**This distinction matters more than it looks.** `clasp create-deployment`
(a.k.a. `clasp deploy`) with no arguments mints a *brand new* deployment with a
*brand new URL*. Your palikas keep opening the old link and never see the fix —
the single most common way an Apps Script update appears to do nothing.

`npm run clasp:redeploy` finds the deployment already in use and updates that,
so the URL your focal persons have saved keeps working. If it finds more than
one it refuses to guess and lists them, so you can be explicit:

```bash
npm run clasp:deployments               # copy the deployment ID
clasp redeploy <DEPLOYMENT_ID> -d "v2"
```

Use `npm run clasp:deploy` **only for the very first publish.**

### Files clasp pushes

`.clasp.json` sets `"rootDir": "apps-script"`, so only the ten source files and
the manifest are uploaded. `test/`, `docs/`, `scripts/` and `node_modules/`
never reach the Apps Script project. `.claspignore` enforces the same thing
belt-and-braces.

`.clasp.json` itself is git-ignored because it contains your script ID; a
template is in `.clasp.json.example` if you need to link an existing project by
hand.

### If you ever run `clasp pull`

`npm run clasp:create` sets `"scriptExtensions": [".gs"]` in `.clasp.json` so
that pulling writes files back with the extension we actually use. **If you
link the project by hand instead** (copying `.clasp.json.example`), make sure
that key is present and reads `[".gs"]` — clasp's own default is
`[".js", ".gs"]`, and with that ordering a `pull` writes every source file
twice: `Setup.js` appears next to `Setup.gs`, byte-identical, and just sits
there as clutter that can drift out of sync if someone edits the wrong one.
It's harmless to the deployed app (Apps Script keys a file by name, not
extension, so both resolve to the same remote file), but it will confuse the
next person who opens the folder. Delete the `.js` twins and fix the setting
if you see this.

### If the editor's function dropdown looks stale

The list of runnable functions is normally rebuilt on save/push, but the
browser tab can hang on to an old list — especially if it was open before the
push happened. If a function you know you pushed isn't showing up:

1. **Close the tab and reopen it from the URL** — a hard refresh (Ctrl+Shift+R)
   is usually enough, but a full close/reopen is the reliable fix.
2. Confirm the code really is there before assuming otherwise: open the file in
   the left-hand file list and scroll to it, or use `clasp pull` and check the
   pulled copy (see above) matches what you expect.
3. The dropdown can also be a *searchable* list, not just a short menu — if the
   project has many functions across many files, type part of the name instead
   of scrolling.
