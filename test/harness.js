/* Shared bootstrap: run the real backend and the real frontend together.
   Used by frontend-side test files so the jsdom wiring lives in one place. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const API_NAMES = ["apiBootstrap", "apiLogin", "apiLoginDistrict", "apiLogout", "apiGetPulse",
  "apiSavePulse", "apiListCases", "apiSaveCase", "apiDeleteCase", "apiSetOutcome",
  "apiDashboard", "apiExport", "apiDataQuality"];

const GS_ORDER = ["Schema.gs", "Util.gs", "Repo.gs", "Setup.gs", "Auth.gs", "Api.gs", "Rpc.gs", "Code.gs"];

/** Load the .gs files into a fresh context and provision the workbook. */
function startServer(dir, globals) {
  const ctx = vm.createContext(Object.assign({}, globals));
  for (const f of GS_ORDER) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
  }
  const quiet = console.log;
  console.log = () => {};
  vm.runInContext("setupDatabase()", ctx);
  console.log = quiet;
  return { ctx, run: expr => vm.runInContext(expr, ctx) };
}

/** Render Index.html the way HtmlService would, then run App.html inside it. */
function startApp(dir, server, opts) {
  const o = opts || {};
  const include = n => fs.readFileSync(path.join(dir, n + ".html"), "utf8");

  let html = fs.readFileSync(path.join(dir, "Index.html"), "utf8")
    .replace(/<\?!=\s*include\('Styles'\);\s*\?>/, include("Styles"))
    .replace(/<\?!=\s*include\('App'\);\s*\?>/, include("App"))
    .replace(/<\?!=\s*JSON\.stringify\(buildStamp\)\s*\?>/, JSON.stringify("test-build"));

  if (/<\?/.test(html)) {
    throw new Error("unresolved Apps Script scriptlet after templating:\n" +
      (html.match(/.{0,80}<\?.{0,80}/s) || [""])[0]);
  }

  const dom = new JSDOM(html, {
    runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.test/"
  });
  const win = dom.window;
  const errors = [];
  win.addEventListener("error", e => errors.push(String(e.message)));

  // Seed a stored session before the app boots, to mimic a page reload.
  if (o.session) win.sessionStorage.setItem("vbd.session.v1", JSON.stringify(o.session));

  const calls = [];
  function runner(success, failure) {
    const api = {
      withSuccessHandler: fn => runner(fn, failure),
      withFailureHandler: fn => runner(success, fn)
    };
    API_NAMES.forEach(name => {
      api[name] = function () {
        calls.push(name);
        let res;
        try {
          server.ctx.__args = JSON.parse(JSON.stringify(Array.prototype.slice.call(arguments)));
          res = JSON.parse(JSON.stringify(vm.runInContext(`${name}.apply(null, __args)`, server.ctx)));
        } catch (e) {
          if (failure) return failure(e);
          throw e;
        }
        if (success) success(res);
      };
    });
    return api;
  }
  win.google = { script: { run: runner(null, null) } };
  win.navigator.clipboard = { writeText: () => Promise.resolve() };
  win.print = () => {};
  if (o.blockDownloads !== false) {
    win.URL.createObjectURL = () => { throw new Error("blocked by sandbox"); };
  }

  const D = win.document;
  win.eval([...D.querySelectorAll("script")].map(s => s.textContent).join("\n"));

  const $ = sel => D.querySelector(sel);
  const $$ = sel => [...D.querySelectorAll(sel)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  return {
    win, D, calls, errors,
    $, $$,
    settle: async (ms = 0) => { await sleep(ms); await sleep(0); },
    click(target) {
      const el = typeof target === "string" ? $(target) : target;
      if (!el) throw new Error("click: no element for " + target);
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    },
    setInput(target, value) {
      const el = typeof target === "string" ? $(target) : target;
      if (!el) throw new Error("setInput: no element for " + target);
      el.focus();
      el.value = value;
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
    },
    /* Rendered output only — never the inline <script> source, which also
       lives in <body> and would otherwise match its own string literals. */
    text: () => ["#root", "#toast-host", "#modal-host"]
      .map(s => { const e = $(s); return e ? e.textContent : ""; })
      .join(" ").replace(/\s+/g, " "),
    navTo(label) {
      const span = $$(".nav .en").find(e => e.textContent.trim() === label);
      if (!span) throw new Error("no nav item " + label);
      span.closest("button").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    },
    toastText: () => ($(".toast") ? $(".toast").textContent : "")
  };
}

/**
 * Boot the *statically hosted* frontend — public/index.html as a browser would
 * assemble it — with fetch() wired to the real Rpc.gs dispatcher on the real
 * backend. This is the Vercel path end to end, minus the network hop and the
 * proxy's own error handling.
 *
 * There is no `google` global here on purpose. If the client ever reaches for
 * google.script.run on this path, the test should fail rather than quietly
 * paper over it.
 */
function startWebApp(server, opts) {
  const o = opts || {};
  const pub = path.resolve(__dirname, "..", "public");
  const readPub = n => fs.readFileSync(path.join(pub, n), "utf8");

  // jsdom's "outside-only" mode never fetches src=, so inline what the browser
  // would have loaded, in the same order.
  let html = readPub("index.html")
    .replace(/<link rel="stylesheet" href="styles\.css">/,
      () => "<style>\n" + readPub("styles.css") + "\n</style>")
    .replace(/<script src="([^"]+)"><\/script>/g,
      (_, src) => "<script>\n" + readPub(src) + "\n</script>");

  if (/<script src=|href="styles\.css"/.test(html)) {
    throw new Error("a local asset in public/index.html was not inlined by the harness");
  }

  const dom = new JSDOM(html, {
    runScripts: "outside-only", pretendToBeVisual: true, url: "https://vbd.test/"
  });
  const win = dom.window;
  const errors = [];
  win.addEventListener("error", e => errors.push(String(e.message)));
  if (o.session) win.sessionStorage.setItem("vbd.session.v1", JSON.stringify(o.session));

  /* fetch() straight into rpcDispatch_. Everything crosses the boundary as
     JSON text, exactly as it would over the wire — which is what makes this
     worth running: a value that survives google.script.run but not
     JSON.stringify would show up here and nowhere else. */
  const requests = [];
  win.fetch = function (url, init) {
    const opt = init || {};
    requests.push({ url: String(url), method: opt.method, headers: opt.headers, body: opt.body });

    if (o.offline) return Promise.reject(new win.Error("Failed to fetch"));

    let text;
    try {
      server.ctx.__e = { postData: { contents: String(opt.body), type: "text/plain" } };
      text = JSON.stringify(vm.runInContext("rpcDispatch_(__e)", server.ctx));
    } catch (e) {
      return Promise.reject(e);
    }
    if (o.mangleReply) text = "<!DOCTYPE html><html>Google error page</html>";

    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(text)
    });
  };

  win.navigator.clipboard = { writeText: () => Promise.resolve() };
  win.print = () => {};
  if (o.blockDownloads !== false) {
    win.URL.createObjectURL = () => { throw new Error("blocked by sandbox"); };
  }

  const D = win.document;
  win.eval([...D.querySelectorAll("script")].map(s => s.textContent).join("\n"));

  const $ = sel => D.querySelector(sel);
  const $$ = sel => [...D.querySelectorAll(sel)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  return {
    win, D, requests, errors, $, $$,
    settle: async (ms = 0) => { await sleep(ms); await sleep(0); },
    click(target) {
      const el = typeof target === "string" ? $(target) : target;
      if (!el) throw new Error("click: no element for " + target);
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    },
    setInput(target, value) {
      const el = typeof target === "string" ? $(target) : target;
      if (!el) throw new Error("setInput: no element for " + target);
      el.focus();
      el.value = value;
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
    },
    text: () => ["#root", "#toast-host", "#modal-host"]
      .map(s => { const e = $(s); return e ? e.textContent : ""; })
      .join(" ").replace(/\s+/g, " "),
    navTo(label) {
      const span = $$(".nav .en").find(e => e.textContent.trim() === label);
      if (!span) throw new Error("no nav item " + label);
      span.closest("button").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    },
    toastText: () => ($(".toast") ? $(".toast").textContent : ""),
    /** Names of the handlers called over HTTP so far, in order. */
    calledFns: () => requests.map(r => { try { return JSON.parse(r.body).fn; } catch (e) { return "?"; } })
  };
}

/** Tiny assertion recorder shared by the test files. */
function makeChecker() {
  const state = { pass: 0, fail: 0, failed: [] };
  return {
    state,
    check(label, cond, extra) {
      if (cond) { state.pass++; console.log("  PASS  " + label); }
      else {
        state.fail++; state.failed.push(label);
        console.log("  FAIL  " + label + (extra !== undefined ? "  -> " + String(extra).slice(0, 300) : ""));
      }
    },
    finish() {
      console.log("\n========================================");
      console.log("  " + state.pass + " passed, " + state.fail + " failed");
      if (state.failed.length) console.log("  failed: " + state.failed.join("; "));
      console.log("========================================");
      process.exit(state.fail ? 1 : 0);
    }
  };
}

module.exports = { startServer, startApp, startWebApp, makeChecker, API_NAMES };
