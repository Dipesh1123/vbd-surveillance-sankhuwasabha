# Hosting guide — the split deployment

The app can be served two ways, from the same source. Both are supported and
both are live at once.

| | Address palikas use | Serves the page | Serves the data |
|---|---|---|---|
| **Hosted (primary)** | `https://<project>.vercel.app` | Vercel, static files from `public/` | Apps Script, via the proxy in `api/rpc.js` |
| **Direct (fallback)** | the script's `/exec` URL | Apps Script, via HtmlService | Apps Script, via `google.script.run` |

The spreadsheet is the database in both cases. Nothing about the data model,
the reconciliation rules or the (absent) access control changes between them.

---

## Why a proxy, and not just a fetch to Apps Script

This is the one genuinely awkward part of the architecture, and it is worth
understanding before changing anything.

An Apps Script web app **cannot set response headers and cannot answer an
OPTIONS request.** A browser on `vercel.app` calling `script.google.com` is a
cross-origin request, and any cross-origin request that is not a CORS *simple
request* begins with an OPTIONS preflight. Apps Script has no way to answer one,
so the call fails before it ever runs your code — and it fails in the browser
console, where no reporter will ever see it.

There are exactly two ways out:

1. **Keep every request "simple."** A POST whose `Content-Type` is
   `text/plain` skips the preflight. This works, and the client does send
   `text/plain` for precisely this reason. But the Apps Script URL is then
   visible to anyone who opens developer tools, and there is nowhere to put a
   shared secret, a timeout or a size limit.
2. **Make the request same-origin.** Route it through a function on the same
   host as the page. There is no preflight because there is no other origin.

This project does (2), and keeps (1) as well — belt and braces, so that
`public/config.js` can be repointed straight at `/exec` on a host with no
serverless functions (GitHub Pages, a departmental web server) and still work.

The proxy is deliberately dumb. It holds no state, does not
cache and does not interpret payloads. **All validation stays in Apps Script,
which is the only tier that can see the sheet.**

---

## The pieces

```
public/                 the site Vercel serves
  index.html            page shell
  config.js             where the browser sends API calls — the only knob
  app.js                the client application  (source of truth)
  styles.css            design tokens and layout (source of truth)
  logo.css              GENERATED — the emblem, resized and inlined

api/                    Vercel serverless functions
  _upstream.js          which Apps Script deployment to talk to
  rpc.js                the proxy every call passes through
  health.js             "is this wired up?" in one request

vercel.json             static root, cache and security headers
```

`apps-script/App.html` and `apps-script/Styles.html` are **generated** from
`public/app.js` and `public/styles.css` by `npm run build:gas`. Do not edit them —
edit `public/`. `npm test` runs the build first, so the tests always exercise
what would actually ship. `npm run check:build` fails if they are out of date.

### The emblem

`public/logo.css` is generated from `uploads/logo.png` by
`npm run build:logo` (Python + Pillow). Run it only when the source image
changes; the output is committed.

The source is 1920×1621 and about 900 KB, and the app draws it at 56 px. The
script resizes it to 128 px and quantises it to a 256-colour palette — 900 KB
down to 7.5 KB — then inlines it as a data URI. It is a data URI rather than an
`<img src="logo.png">` because HtmlService **cannot serve a binary file**, so
the `/exec` fallback would otherwise show a blank square. A stylesheet is the
one form both hosting paths can carry from a single source.

`Config ▸ logo_url` still overrides it if a district wants its own image.

**Do not rename `build:gas` to `build`.** Vercel runs `npm run build`
automatically whenever a script by that exact name exists, regardless of what
`vercel.json` says — `"buildCommand": null` means *"not specified"*, not *"do
not build"*. This build step generates Apps Script files, needs `scripts/`, and
`.vercelignore` deliberately keeps `scripts/` out of the deployment, so on
Vercel it can only fail. The first deploy of this project failed for exactly
that reason. `transport.test.js` now asserts the name, so the mistake is caught
locally instead of in a build log.

---

## Deploying a change to the frontend

```bash
npm test                 # builds, then runs every check
git push                 # Vercel deploys on push, if the repo is linked
npm run clasp:redeploy   # updates the /exec fallback to match
```

Do both. If you only push to Vercel, the direct URL quietly serves an older
build, and the two will disagree the next time someone compares them.

---

## Deploying a change to the backend

Backend changes (`*.gs`) only need `npm run clasp:redeploy`. Use **redeploy**,
never `clasp:deploy` — `deploy` mints a *new* `/exec` URL, and the proxy would
still be pointed at the old one. See `DEPLOYMENT.md ▸ Updating afterwards`.

If you ever do create a new deployment on purpose, update the URL in **both**
places:

- `api/_upstream.js` (the committed default), or
- the `APPS_SCRIPT_URL` environment variable in the Vercel project, which
  overrides it.

Then confirm with `curl https://<project>.vercel.app/api/health` — it prints the
last 8 characters of the deployment id the proxy is actually using.

---

## Configuration

Everything works with no configuration. These are the overrides.

| Where | Name | Default | What it does |
|---|---|---|---|
| Vercel env | `APPS_SCRIPT_URL` | the URL in `api/_upstream.js` | Which Apps Script deployment the proxy calls. Set this for a staging copy. |
| Vercel env | `API_SHARED_SECRET` | unset | See below. |
| Script property | `api_shared_secret` | unset | See below. |
| `public/config.js` | `apiUrl` | `/api/rpc` | Where the browser sends calls. Point at an `/exec` URL to run without a proxy. |

### The optional shared secret

Off by default, on purpose: a value required by the script but missing at the
proxy locks out all ten palikas at once.

When set, the script refuses any request that does not carry it, so knowing the
`/exec` URL is no longer enough to reach the API. The proxy adds it server-side;
it never reaches the browser, and a value supplied by a client is stripped
rather than forwarded.

To turn it on — **order matters**:

1. Set `API_SHARED_SECRET` in the Vercel project settings and redeploy.
2. Confirm the site still works.
3. *Then* add a script property `api_shared_secret` with the same value
   (Apps Script editor ▸ Project Settings ▸ Script Properties).

Doing it the other way round takes the system down between steps. To turn it
off, remove the **script property** first.

Note that this closes the direct-`/exec` fallback, since a static page has
nowhere safe to keep a secret.

---

## What the proxy does and does not protect

**Does:** hides the Apps Script URL from the browser; enforces a 512 KB body
limit and a 25-second timeout; refuses anything but POST; refuses malformed
calls before they cost an Apps Script invocation; and never relays a non-JSON
upstream reply — which matters because Apps Script answers with an HTML error
page when it is mid-deploy or out of quota, and forwarding that verbatim would
put Google's markup on a health worker's screen.

**Does not:** authenticate — and neither does anything behind it. There are no
access codes anywhere in this system any more (see `README.md ▸ Access model`),
so anyone who can POST to `/api/rpc` can read every patient name and can add,
edit or delete any case.

That makes the allowlist in `Rpc.gs` the only thing deciding what the outside
world can reach. Adding a function name to it publishes that function. Read it
before you extend it.

The one protection the proxy does still provide is keeping the Apps Script
`/exec` URL out of the browser, so the open API is at least reachable at only
one address you control rather than two.

---

## Verifying a deployment

```bash
curl -s https://<project>.vercel.app/api/health
```

Expect `"ok": true` and an `upstreamDeployment` ending in the same 8 characters
as your current `/exec` URL. Then, in a browser:

1. Open the site. The dashboard should render immediately, with no sign-in.
2. Pick a palika in the sidebar and open Daily numbers. It should load.
3. Open the direct `/exec` URL and confirm it shows the same build.

If the page loads but every action fails, check `/api/health` first — a mismatched
`upstreamDeployment` after a `clasp:deploy` is the most likely cause by a wide
margin.

---

## Cost and limits

Vercel's free tier covers this comfortably; the site is three static files and a
proxy that does no computation. The binding limits are Apps Script's, not
Vercel's — script runtime and daily quota — and they were already the limits
before this split existed.
