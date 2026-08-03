/**
 * api/health.js — "is the site wired up correctly?" in one request.
 *
 * Deliberately does not touch the spreadsheet. This answers whether the proxy
 * is running and what it is pointed at; whether the database is provisioned is
 * apiBootstrap's job, and the app already reports that on screen.
 *
 * The upstream URL is reduced to its host and the last few characters of the
 * deployment id — enough to tell two deployments apart when you are on the
 * phone to the district office, not enough to be a working endpoint.
 */
const UPSTREAM = require("./_upstream");

module.exports = function handler(req, res) {
  const id = (UPSTREAM.url.match(/\/macros\/s\/([^/]+)\//) || [])[1] || "";

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.end(JSON.stringify({
    ok: true,
    service: "vbd-surveillance-proxy",
    upstreamHost: new URL(UPSTREAM.url).host,
    upstreamDeployment: id ? "…" + id.slice(-8) : "(unset)",
    sharedSecret: UPSTREAM.secret ? "configured" : "off",
    time: new Date().toISOString()
  }, null, 2));
};
