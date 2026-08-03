/*
 * Where the browser sends its API calls. Kept out of app.js so that moving the
 * backend never means touching application code.
 *
 * '/api/rpc' is the same-origin proxy that ships with this site (api/rpc.js).
 * Same-origin is not a detail: an Apps Script web app cannot answer a CORS
 * preflight or set response headers, so a proxy is what lets this page live on
 * a different host from the script at all. It also keeps the Apps Script URL
 * out of the browser's network tab.
 *
 * Hosting somewhere with no serverless functions (GitHub Pages, a plain file
 * server)? Point apiUrl straight at the Apps Script /exec URL instead. That
 * path works — the client sends text/plain so the request stays a CORS "simple
 * request" and never needs a preflight — but the URL becomes visible to anyone
 * who opens developer tools, and the optional shared secret cannot be used.
 */
window.VBD_CONFIG = {
  apiUrl: '/api/rpc'
};
