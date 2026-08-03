/*
 * The Apps Script web app this site talks to.
 *
 * Files under api/ whose name starts with an underscore are not routed as
 * endpoints, so this is a shared module rather than a public URL.
 *
 * The URL is a default, not a secret — it is only an address, and every call
 * behind it still needs an access code. Committing it means a fresh clone
 * deploys and works with no configuration. Override it per-environment by
 * setting APPS_SCRIPT_URL in the Vercel project settings, which is what you
 * want when you cut a new deployment of the script (the /exec URL changes) or
 * when you run a separate test copy.
 *
 * API_SHARED_SECRET is optional and off by default. If you set it here AND set
 * a script property of the same name (api_shared_secret) in the Apps Script
 * project, the script stops answering anyone who has not got it — so knowing
 * the /exec URL is no longer enough. Set it in the script FIRST and this one
 * SECOND, or every palika is locked out in between.
 */
const DEFAULT_URL =
  "https://script.google.com/macros/s/AKfycbxAQUubcBNEIQYooiyd6EZzj-4KrXMjOPjvSxpUMPb_g9wH1TBEz2PREnVH-JVcgk2Wtg/exec";

const url = (process.env.APPS_SCRIPT_URL || DEFAULT_URL).trim();

if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/(exec|dev)$/.test(url)) {
  // Fail at import time. A typo'd URL that only shows up as a confusing runtime
  // error is worse than a function that refuses to start.
  throw new Error(
    "APPS_SCRIPT_URL does not look like an Apps Script web app URL " +
      "(expected https://script.google.com/macros/s/<id>/exec): " + url
  );
}

module.exports = {
  url,
  secret: (process.env.API_SHARED_SECRET || "").trim()
};
