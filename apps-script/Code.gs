/**
 * Code.gs — web app entry point.
 *
 * The whole frontend is served from HtmlService, which means:
 *   - no CORS, no API keys in the page, no separate hosting to pay for;
 *   - the browser talks to the server through google.script.run, so the
 *     spreadsheet is never exposed directly to the client.
 */

function doGet(e) {
  var page = HtmlService.createTemplateFromFile('Index');
  page.buildStamp = nowStamp();

  return page.evaluate()
    .setTitle('VBD Surveillance · Sankhuwasabha')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Lets Index.html pull in Styles.html and App.html at render time. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Optional daily digest. Attach a time-driven trigger (District office ▸
 * Triggers ▸ Add trigger ▸ dailyCompletenessDigest ▸ Day timer ▸ 5–6 PM) to get
 * a reminder listing the palikas that have not reported.
 */
function dailyCompletenessDigest() {
  var today = todayIso();
  var c = completenessFor_(readAll('Pulses'), today);
  if (!c.notReported.length) return;

  var to = configGet('digest_email', '');
  if (!to) return;

  var body =
    'Daily reporting completeness for ' + today + ' (' + adToBs(today, bsTable()) + ')\n\n' +
    c.reported.length + ' of ' + c.total + ' palikas have reported (' + c.pct + '%).\n\n' +
    'Not yet reported:\n' + c.notReported.map(function (n) { return '  • ' + n; }).join('\n') +
    '\n\n— ' + configGet('office_name', 'Health Office');

  MailApp.sendEmail(to, 'VBD reporting: ' + c.notReported.length + ' palika(s) outstanding', body);
  audit('SYSTEM', 'system', 'digest', today, c.notReported.length + ' outstanding');
}
