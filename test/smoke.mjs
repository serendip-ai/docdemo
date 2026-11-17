// Smoke test: drives the helper against a local mini app with refs picked from real snapshots.
// No LLM involved. Needs playwright-cli on PATH. Run: npm test
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { forTests } from '../skills/docdemo/scripts/docdemo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'skills/docdemo/scripts/docdemo.mjs');
const PORT = Number(process.env.SMOKE_PORT) || 4173; // SMOKE_PORT and SMOKE_SESSION let two copies run side by side
const APP = `http://127.0.0.1:${PORT}/`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docdemo-smoke-'));
// A doc page whose anchor sits on a wrapper around the heading (as on elastic.co), with a markdown version.
const ANCHOR_HTML = '<main><div class="heading-wrapper" id="get-going"><h2><a class="headerlink" href="#get-going">Step 1: Load data</a></h2></div>' +
  '<ol><li>Click <strong>Add</strong>.</li></ol></main>';
const ANCHOR_MD = '# Guide\n\nThis guide loads sample data into the app, then explores it with a query and a chart.\n\n## Step 1: Load data\n\n' +
  '1. Click **Add**.\n\nThe data appears in the list after a few seconds.\n\n## Step 2: Explore\n\n1. Click **Explore**.\n';
// playwright-cli blocks file:// URLs, so serve the mini app over HTTP from a child process
// (the helper calls below are synchronous and would block an in-process server). /out/ serves built demos.
const server = spawn(process.execPath, ['-e', `
  const fs = require('fs'), http = require('http'), path = require('path');
  const work = ${JSON.stringify(work)};
  const page = fs.readFileSync(${JSON.stringify(path.join(ROOT, 'test/fixtures/mini-app/index.html'))});
  // A wrong password starting with "shown" is then shown as text, as a "show password" button would.
  const login = '<!doctype html><title>Sign in</title><form onsubmit="event.preventDefault();' +
    'if (this.pw.value === \\'s3cret-Pa55\\' && this.em.value === \\'demo@example.com\\') { document.cookie = \\'sid=ok; path=/\\'; ' +
    'document.title = \\'Signed in\\'; this.hidden = true; } else if (this.pw.value.startsWith(\\'shown\\')) this.pw.type = \\'text\\'">' +
    '<label>Email <input type=email name=em></label>' +
    '<label>Password <input type=password name=pw></label><button>Sign in</button></form>';
  // A settings form with a password (a data source's), in an app with navigation: not a sign-in page.
  const settings = '<!doctype html><title>Data source</title><nav><a href="/">Home</a> <a href="/settings">Settings</a></nav>' +
    '<main><form><label>User <input name=u></label><label>Password <input type=password name=p></label><button>Save &amp; test</button></form></main>';
  // The same, without navigation and with more fields (a database connection): still not a sign-in page.
  const settingsPlain = '<!doctype html><title>Connection</title><main><form><label>Host <input name=h></label><label>Port <input name=o></label>' +
    '<label>User <input name=u></label><label>Password <input type=password name=p></label><button>Save &amp; test</button></form></main>';
  const anchorHtml = ${JSON.stringify(ANCHOR_HTML)}, anchorMd = ${JSON.stringify(ANCHOR_MD)};
  const send = (r, status, type, body) => { r.writeHead(status, { 'content-type': type }); r.end(body); };
  http.createServer((q, r) => {
    // the product's API: saving fails, preferences are missing, and a late request fails upstream
    if (q.url === '/api/save') return send(r, 500, 'application/json', JSON.stringify({ message: 'disk full' }));
    if (q.url.startsWith('/api/prefs')) return send(r, 404, 'application/json', JSON.stringify({ message: 'no preferences' }));
    if (q.url === '/api/late') return send(r, 502, 'text/plain', 'upstream down');
    if (q.url.startsWith('/api/fail')) return send(r, 500, 'text/plain', 'failed');
    if (q.url.startsWith('/api/search')) return setTimeout(() => send(r, 200, 'application/json',
      JSON.stringify({ results: [new URL(q.url, 'http://x').searchParams.get('q') + ' results'] })), 300);
    if (q.url === '/api/redirect') { r.writeHead(302, { location: '/api/prefs' }); return r.end(); }
    if (q.url === '/api/token') return send(r, 200, 'application/json', JSON.stringify({ name: 'demo', token: 'tok-abc123' }));
    if (q.url === '/whoami') return send(r, 200, 'text/plain', 'Signed in as demo@example.com with s3cret-Pa55');
    if (q.url === '/slow') return setTimeout(() => send(r, 200, 'text/html', '<!doctype html><title>Slow report</title><h1>Slow report</h1>'), 8000);
    // an answer that starts at once and ends 2 s later, as a slow query's results stream in
    if (q.url === '/api/stream') { r.writeHead(200, { 'content-type': 'text/plain' }); r.flushHeaders(); return setTimeout(() => r.end('Streamed answer'), 2000); }
    if (q.url.startsWith('/docs/anchor.md')) return send(r, 200, 'text/markdown', anchorMd);
    // a doc whose markdown answers at once, and whose page (asked for the icon names in its HTML) never does
    if (q.url.startsWith('/docs/stall.md')) return send(r, 200, 'text/markdown', '# Tidy up\\n\\nThis guide tidies the notes list: it removes the drafts you no longer need and collapses ' +
      'the rest, so that the whole list fits on one screen again.\\n\\n1. Click the \\x60expand\\x60 icon.\\n2. Click **Delete draft**.\\n');
    if (q.url.startsWith('/docs/stall')) return;
    if (q.url.startsWith('/docs/anchor')) return send(r, 200, 'text/html', anchorHtml);
    if (q.url.startsWith('/out/')) {
      const f = path.join(work, decodeURIComponent(q.url.slice(5).split(/[?#]/)[0]));
      if (!f.startsWith(work) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.webp') ? 'image/webp' : 'application/octet-stream' });
      return r.end(fs.readFileSync(f));
    }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(q.url.startsWith('/login') ? login : q.url.startsWith('/settings-plain') ? settingsPlain : q.url.startsWith('/settings') ? settings : page);
  })
    .listen(${PORT}, '127.0.0.1', () => console.log('ready'));
`], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(res => server.stdout.once('data', res));
let failures = 0;

// Its own browser session, so the tests never take over a real DocDemo run (which uses "dd").
const SESSION = process.env.SMOKE_SESSION || 'dd-smoke';
const run = (cmd, args) => spawnSync(cmd, args, { cwd: work, encoding: 'utf8', env: { ...process.env, DOCDEMO_SESSION: SESSION } });
const H = (...args) => run('node', [HELPER, ...args]);
const snapshot = () => run('playwright-cli', [`-s=${SESSION}`, '--raw', 'snapshot']).stdout;
const ref = (snap, pattern) => {
  const m = snap.match(new RegExp(`${pattern}[^\\n]*\\[ref=([a-z0-9]+)\\]`, 'i'));
  if (!m) throw new Error(`no ref for ${pattern} in snapshot:\n${snap}`);
  return m[1];
};
const pad = n => String(n).padStart(3, '0');
const expect = (name, cond) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };
function check(name, r, wantStatus = 0) {
  const ok = r.status === wantStatus;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (exit ${r.status}, want ${wantStatus})\n${r.stdout}${r.stderr}`}`);
  return r;
}

try {
  // The parts that need no browser: term matching, secrets in what get prints, addresses get refuses, and
  // what a failed action's call log says.
  const { termOnPage, hideSecrets, endsOrDeletes, why } = forTests;
  // An action that reached the page is never done again, even when the line that says so is older than the
  // eight lines of the log that are kept (here: the click landed, then the page kept it waiting).
  const colored = s => `\x1b[2m${s}\x1b[22m`;
  const landed = why(new Error(['locator.click: Timeout 4000ms exceeded.', 'Call log:', `  - ${colored('waiting for locator(\'aria-ref=e12\')')}`,
    `  - ${colored('click action done')}`, ...Array.from({ length: 9 }, (_, i) => `  - ${colored(`waiting for the page, ${i + 1}`)}`)].join('\n')));
  expect('an action whose log says it ran counts as ran, however far back the log says so', landed.ran && landed.log.length === 8 &&
    !landed.log.some(l => l.includes('action done')) && landed.log[0] === 'waiting for the page, 2' && landed.message === 'locator.click: Timeout 4000ms exceeded.');
  expect('an action whose log never says it ran does not', !why(new Error('locator.click: Timeout 4000ms exceeded.\nCall log:\n  - waiting for locator(\'aria-ref=e12\')' +
    '\n  - element is not visible\n  - retrying click action, attempt #2')).ran);
  // A click that was still being performed when its time ran out reached the page; one Playwright tried again did not.
  const clickLog = (...lines) => why(new Error(['locator.click: Timeout 4000ms exceeded.', 'Call log:', '  - attempting click action',
    '  -     element is visible, enabled and stable', ...lines.map(l => `  - ${l}`)].join('\n')));
  expect('a click cut off while it was performed counts as ran, unless it was tried again (another element caught it, or it left the page)',
    clickLog('    performing click action').ran && !clickLog('    performing click action', '    <div class="toast"></div> intercepts pointer events',
      'retrying click action', '    waiting 20ms').ran && !clickLog('    performing click action', 'element was detached from the DOM, retrying',
      'waiting for locator(\'aria-ref=e18\')').ran && clickLog('    performing click action', '    <div class="toast"></div> intercepts pointer events',
      'retrying click action', '    performing click action').ran);
  expect('a click cut off while it was performed may not have reached the page; one the log calls done did',
    clickLog('    performing click action').maybe === true && clickLog('    performing click action', '    click action done').maybe === undefined);
  expect('the call log is read from each line\'s start, not from an element\'s text', !clickLog('locator resolved to <button>Stop performing click action</button>',
    '    waiting for element to be visible, enabled and stable').ran && !clickLog('locator resolved to <a>click action done</a>').ran);
  const maybeWarning = forTests.uncertainWarning({ maybe: true, message: 'Timeout 4000ms exceeded.' });
  expect('an action that may not have reached the page is never done again when it saves, and a result not shown yet is not a reason to',
    maybeWarning.includes('Never do it again if it saves, submits, creates or deletes something') &&
    maybeWarning.includes('only if the snapshot below shows the page just as it was before it') && !maybeWarning.includes('if it does not, do the action again'));
  const labels = ['C++', 'Name *', 'Save as…', 'Add ▾', '+ New', '.NET'];
  expect('a label\'s decoration is ignored, but C++ is not C and .NET is not NET', ['Name', 'Save as', 'Add', 'New', 'C++', '.NET']
    .every(term => termOnPage(term, labels).status === 'on the page') && termOnPage('C', labels).status !== 'on the page' && termOnPage('NET', labels).status !== 'on the page');
  expect('get hides secret fields in JSON, whatever their value, and keeps numbers exact',
    hideSecrets('{"id":12345678901234567890,"token":["tok-1"],"user":{"apiKey":"k-1","n":1.50}}') === '{"id":12345678901234567890,"token":"***","user":{"apiKey":"***","n":1.50}}');
  expect('get hides header lines, bearer tokens and secrets in URLs', hideSecrets('Authorization: Bearer tok-1\nX-Other: 1') === 'Authorization: ***\nX-Other: 1' &&
    !hideSecrets('then Authorization: Bearer tok-1 is sent').includes('tok-1') && hideSecrets('/callback?token=tok-1&next=/') === '/callback?token=***&next=/');
  expect('get refuses encoded and camel-case deletes, but not a count of deleted items',
    ['/api/items/%64elete?id=1', '/api/deleteUser', '/x?action=revoke', '/api/log-out'].every(u => endsOrDeletes(new URL(u, APP))) && !endsOrDeletes(new URL('/api/deleted-count', APP)));
  const hidden = spawnSync(process.execPath, ['--input-type=module', '-e', `import { forTests as t } from ${JSON.stringify(HELPER)};
    console.log(t.redact('textbox "Password": "pa\\\\"ss\\\\\\\\word" and pa"ss\\\\word'), JSON.stringify(t.redactValue({ ok: true, s: 'pa"ss\\\\word' })));`],
    { cwd: work, encoding: 'utf8', env: { ...process.env, DOCDEMO_PASSWORD: 'pa"ss\\word' } }).stdout;
  expect('the password is hidden as typed and as a quoted string shows it, and before JSON is written', hidden.trim() === 'textbox "Password": "***" and *** {"ok":true,"s":"***"}');

  fs.mkdirSync(path.join(work, 'demo'));
  fs.writeFileSync(path.join(work, 'demo/source.md'), `---\nurl: https://example.com/docs/notes\n---\n
# Add a note

1. Click **Add note** in the [header](#header).
2. Enter a *title* for the note.
3. Click **Save** &gt; done.

The note appears in the list.
`);
  const steps = [
    { index: 1, text: 'Click Add note in the header.', kind: 'action' },        // link syntax dropped
    { index: 2, text: 'Enter a title for the note.', kind: 'action' },          // *emphasis* dropped
    { index: 3, text: 'Click **Save** > done.', kind: 'action' },               // entity decoded
    { index: 4, text: 'The note appears in the list.', kind: 'informational' },
  ];
  fs.writeFileSync(path.join(work, 'demo/bad-steps.json'), JSON.stringify([{ index: 1, text: 'Press the add button', kind: 'action' }]));
  fs.writeFileSync(path.join(work, 'demo/steps.json'), JSON.stringify(steps));

  const init = ['init', '--title', 'Add a note', '--doc-url', 'https://example.com/docs/notes', '--app-url', APP];
  check('init rejects a paraphrased step', H(...init, '--steps', 'demo/bad-steps.json'), 6);
  fs.writeFileSync(path.join(work, 'demo/wrapped-steps.json'), JSON.stringify({ steps }));
  check('init rejects a malformed steps file with VALIDATION', H(...init, '--steps', 'demo/wrapped-steps.json'), 6);
  check('init refuses an empty --app-version', H(...init, '--steps', 'demo/steps.json', '--app-version', ' '), 1);
  check('init', H(...init, '--steps', 'demo/steps.json', '--app-version', '2.4.1'));
  check('open', H('open'));

  let snap = snapshot();
  check('act rejects a stale ref', H('act', '--doc-step', '1', '--instruction', 'x', '--ref', 'e99999', 'click'), 2);
  check('act rejects a mismatched name', H('act', '--doc-step', '1', '--instruction', 'x', '--expect', 'Delete', '--ref', ref(snap, 'button "Add note"'), 'click'), 4);
  const clicked = check('act click', H('act', '--doc-step', '1', '--instruction', 'Click Add note', '--expect', 'Add note', '--ref', ref(snap, 'button "Add note"'), 'click'));
  expect('act prints the next snapshot', /textbox "Note title"[^\n]*\[ref=/.test(clicked.stdout));
  snap = snapshot();
  const fillArgs = ['--doc-step', '2', '--instruction', 'Type "--Buy milk" as the title', '--expect', 'Note title', '--ref', ref(snap, 'textbox "Note title"')];
  const fill = ['act', ...fillArgs, 'fill', '--', '--Buy milk'];
  const title = () => JSON.parse(run('playwright-cli', [`-s=${SESSION}`, '--raw', 'eval', "() => document.getElementById('title').value"]).stdout);
  check('the next step is refused while a check is open', H(...fill), 1);
  check('check rejects a doc verdict without "doc says"', H('check', '--doc-step', '1', '--claim', 'in the header', '--verdict', 'doc', '--note', 'wrong place'), 1);
  check('check rejects an unknown claim', H('check', '--doc-step', '1', '--claim', 'in the footer', '--verdict', 'ok', '--note', 'x'), 1);
  check('act refuses a bad answer to a check', H('act', ...fillArgs, '--claim', 'in the header', '--verdict', 'doc', '--note', 'wrong place', 'fill', '--', '--Buy milk'), 1);
  check('act refuses a second --note after a claim', H('act', ...fillArgs, '--claim', 'in the header', '--verdict', 'ok', '--note', 'a', '--note', 'b', 'fill', '--', '--Buy milk'), 1);
  expect('a refused act did not act', title() === '');
  const answered = check('act answers the open check of the step before (value after --)',
    H('act', ...fillArgs, '--claim', 'in the header', '--verdict', 'ok', '--note', 'Add note is in the page header', 'fill', '--', '--Buy milk'));
  expect('act records the answer, then acts', answered.stdout.includes('recorded ok for place "in the header" (doc step 1)') && title() === '--Buy milk');
  snap = snapshot();
  check('act select', H('act', '--doc-step', '2', '--instruction', 'Choose Green as the color', '--expect', 'Color', '--ref', ref(snap, 'combobox "Color"'), 'select', 'g'));
  check('act key', H('act', '--doc-step', '3', '--instruction', 'Press Enter to save', '--key', 'Enter'));
  check('build refuses before done', H('build'), 6);
  check('done', H('done', '--instruction', 'The note is saved'));
  check('act refused after done', H('note', '--doc-step', '3', '--instruction', 'x'), 1);
  check('build', H('build'));

  const demo = JSON.parse(fs.readFileSync(path.join(work, 'demo/demo.json'), 'utf8'));
  const html = fs.readFileSync(path.join(work, 'demo/index.html'), 'utf8');
  expect('5 frames recorded', demo.steps.length === 5);
  expect('click frame has a hotspot inside the viewport', demo.steps[0].hotspot && demo.steps[0].hotspot.x + demo.steps[0].hotspot.width <= 1);
  expect('fill frame records the value', demo.steps[1].action.value === '--Buy milk');
  expect('select frame records the choices, their groups and the picked label', JSON.stringify(demo.steps[2].action.options) === '["Yellow",{"group":"Cool","options":["Green","Blue"]}]' &&
    demo.steps[2].action.picked === 'Green' && demo.steps[2].action.pickedGroup === 'Cool');
  const claims = demo.doc.steps.map(d => (d.claims || []).map(c => `${c.kind}:${c.text}`).join(','));
  expect('init extracts claims from the source markup', claims[0] === 'term:Add note,place:in the header' && claims[2] === 'term:Save');
  expect('the click records where the element sits', demo.steps[0].where?.within.includes('banner') && demo.steps[0].where.role === 'button');
  expect('the verdict is kept', demo.checks?.length === 1 && demo.checks[0].verdict === 'ok');
  expect('press frame has no hotspot', demo.steps[3].action.kind === 'press' && !demo.steps[3].hotspot);
  expect('screenshots exist', demo.steps.every(s => fs.existsSync(path.join(work, 'demo', s.image))));
  expect('screenshots are WebP', demo.steps.every(s => fs.readFileSync(path.join(work, 'demo', s.image)).subarray(8, 12).toString() === 'WEBP'));
  expect('report.md has an embed snippet for /demos/<slug>/', fs.readFileSync(path.join(work, 'demo/report.md'), 'utf8')
    .includes('<iframe src="/demos/add-a-note/index.html?embed" title="Interactive demo: Add a note"'));
  expect('index.html has the data inlined', html.includes('"title":"Add a note"') && !html.includes('/*__DEMO_DATA__*/null'));
  expect('the app really saved the note', /listitem[^\n]*--Buy milk/.test(snapshot()));
  expect('report.md says the product matched', fs.readFileSync(path.join(work, 'demo/report.md'), 'utf8').includes('No discrepancies'));
  // What a dashboard of many runs reads: which procedure, which doc wording, which product version, and the run's numbers.
  expect('demo.json names the procedure, hashes its doc steps and keeps the app version',
    demo.doc.id === 'example.com/docs/notes' && /^sha256:[0-9a-f]{64}$/.test(demo.doc.hash) && demo.app.version === '2.4.1');
  expect('build keeps the run\'s numbers in demo.json', JSON.stringify(demo.counts) === JSON.stringify({ documentedSteps: 3, verifiedSteps: 3, actions: 4, frames: 5,
    docMismatches: 0, productErrorSteps: 0, setupDifferences: 0, wording: 0, framesToCheck: 0, claims: { doc: 0, setup: 0, ok: 0, unverified: 0 } }));
  expect('the reader copy leaves out the id, hash, version and numbers', ['"hash":', '"counts":', '2.4.1', '"id":"example.com'].every(t => !html.includes(t)));
  expect('report.md gives the app version', fs.readFileSync(path.join(work, 'demo/report.md'), 'utf8').includes(`- App: ${APP} (version 2.4.1)`));
  const hashOf = steps => forTests.docHash(steps);
  expect('the doc hash changes with the doc\'s wording, not with its spacing',
    hashOf(demo.doc.steps) === demo.doc.hash && hashOf(demo.doc.steps.map(d => ({ ...d, text: ` ${d.text.replace(/ /g, '  ')} ` }))) === demo.doc.hash &&
    hashOf(demo.doc.steps.map((d, i) => i ? d : { ...d, text: d.text + '!' })) !== demo.doc.hash);

  // a moved demo (no .debug/) still builds: found terms are recorded in demo.json
  fs.cpSync(path.join(work, 'demo'), path.join(work, 'moved'), { recursive: true, filter: f => !f.includes('.debug') });
  const older = JSON.parse(fs.readFileSync(path.join(work, 'moved/demo.json'), 'utf8'));
  delete older.doc.id; delete older.doc.hash; delete older.counts;
  fs.writeFileSync(path.join(work, 'moved/demo.json'), JSON.stringify(older));
  check('build in a moved folder without .debug/', H('build', '--out', 'moved'));
  const filled = JSON.parse(fs.readFileSync(path.join(work, 'moved/demo.json'), 'utf8'));
  expect('build fills in the id, hash and numbers of a demo recorded before DocDemo kept them',
    filled.doc.id === demo.doc.id && filled.doc.hash === demo.doc.hash && filled.counts?.frames === 5);

  // report.md sorts notes into doc errors and setup differences
  const noted = structuredClone(demo);
  noted.steps[0].note = 'doc says Add note; UI shows New note';
  noted.steps[1].note = 'setup: titles are optional on this instance';
  fs.writeFileSync(path.join(work, 'demo/demo.json'), JSON.stringify(noted));
  const withUrl = check('build with --embed-url', H('build', '--embed-url', 'https://docs.example.com/demos/notes/'));
  expect('--embed-url fills in the snippet', withUrl.stdout.includes('src="https://docs.example.com/demos/notes/index.html?embed"'));
  const built = check('build with notes', H('build'));
  const readerHtml = fs.readFileSync(path.join(work, 'demo/index.html'), 'utf8');
  const reviewHtml = fs.readFileSync(path.join(work, 'demo/review.html'), 'utf8');
  expect('index.html leaves out notes, checks, the app URL and locators', !readerHtml.includes('doc says Add note') &&
    !readerHtml.includes('titles are optional') && !readerHtml.includes('page header') && !readerHtml.includes('127.0.0.1') &&
    !readerHtml.includes('"locator"') && !readerHtml.includes('"claims"') && readerHtml.includes('"instruction":"Click Add note"'));
  expect('review.html keeps the notes for the writer', reviewHtml.includes('doc says Add note') && reviewHtml.includes('titles are optional') &&
    built.stdout.includes('review.html'));
  const report = fs.readFileSync(path.join(work, 'demo/report.md'), 'utf8');
  expect('report.md lists the doc error with its step', report.includes('disagree in 1 place') &&
    /## The doc and the product disagree \(1\)\n\n- \*\*Step 1:\*\* Click Add note in the header\.\n  - doc says Add note/.test(report));
  expect('report.md lists the setup difference separately', /set up \(1\)\n\n- \*\*Step 2:\*\*[^\n]*\n  - titles are optional/.test(report));

  // a finding noted twice on one doc step, on two frames or as a frame note and a check, is listed once
  fs.cpSync(path.join(work, 'demo'), path.join(work, 'dupes'), { recursive: true, filter: f => !f.includes('.debug') });
  const dupes = structuredClone(noted);
  dupes.steps[0].note = 'doc says "Add note"; UI shows "New note"';
  dupes.steps[1].note = 'doc says Enter a title; UI shows a Note title field';
  dupes.steps[2].note = 'doc says to enter a title; UI shows the Note title field with a color list';
  dupes.checks = [...dupes.checks, { docStep: 1, claim: 'Add note', kind: 'term', verdict: 'doc', note: 'doc says Add note; UI shows New note' }];
  fs.writeFileSync(path.join(work, 'dupes/demo.json'), JSON.stringify(dupes));
  const dupBuilt = check('build with a finding noted twice', H('build', '--out', 'dupes'));
  const dupReport = fs.readFileSync(path.join(work, 'dupes/report.md'), 'utf8');
  expect('report.md lists a repeated finding once', /- \*\*Step 1:\*\*[^\n]*\n  - doc says "Add note"; UI shows "New note"\n- \*\*Step 2:\*\*[^\n]*\n  - doc says Enter a title; UI shows a Note title field\n\n/.test(dupReport));
  const dupReview = fs.readFileSync(path.join(work, 'dupes/review.html'), 'utf8');
  // (the player shows frame notes; a check's note is added to its step's last frame unless it repeats one)
  expect('review.html shows a repeated finding once', !dupReview.includes('with a color list') && !dupReview.includes('· doc says Add note') &&
    dupReview.includes('doc says Enter a title'));
  expect('build prints each finding once', (dupBuilt.stdout.match(/doc mismatch \(doc step 2\)/g) || []).length === 1);

  // icon names that "doc" recorded are left out of the step text readers see, and are not checked as UI terms
  fs.cpSync(path.join(work, 'demo'), path.join(work, 'icons'), { recursive: true, filter: f => !f.includes('.debug') });
  const iconSource = fs.readFileSync(path.join(work, 'demo/source.md'), 'utf8')
    .replace('\n---\n', '\nicons: play_filled, expand\n---\n')
    .replace('3. Click **Save** &gt; done.', '3. Click `play_filled` **Save** &gt; done, or the expand icon (`expand`).');
  fs.writeFileSync(path.join(work, 'icons/source.md'), iconSource);
  const iconDemo = structuredClone(noted);
  iconDemo.doc.steps[2].text = 'Click `play_filled` **Save** > done, or the expand icon (`expand`).';
  fs.writeFileSync(path.join(work, 'icons/demo.json'), JSON.stringify(iconDemo));
  check('build with icon names in the doc', H('build', '--out', 'icons'));
  const iconHtml = fs.readFileSync(path.join(work, 'icons/index.html'), 'utf8');
  expect('index.html shows the step without icon names', iconHtml.includes('"text":"Click **Save** > done, or the expand icon."') &&
    !iconHtml.includes('play_filled'));
  fs.mkdirSync(path.join(work, 'icons-init'));
  fs.writeFileSync(path.join(work, 'icons-init/source.md'), iconSource);
  fs.writeFileSync(path.join(work, 'icon-steps.json'), JSON.stringify([{ index: 1, text: iconDemo.doc.steps[2].text, kind: 'action' }]));
  check('init with icon names in the doc', H('init', '--out', 'icons-init', '--title', 'Icons', '--doc-url', 'https://example.com/docs/notes',
    '--app-url', APP, '--steps', 'icon-steps.json'));
  const iconClaims = JSON.parse(fs.readFileSync(path.join(work, 'icons-init/demo.json'), 'utf8')).doc.steps[0].claims.map(c => c.text);
  expect('init does not check icon names as UI terms', iconClaims.includes('Save') && !iconClaims.includes('play_filled') && !iconClaims.includes('expand'));

  // init --list: the doc steps from a numbered list in the outline "doc" prints, instead of a hand-written steps.json
  const listDoc = (out, source) => { fs.mkdirSync(path.join(work, out)); fs.writeFileSync(path.join(work, out, 'source.md'), source); };
  const initList = (out, ...a) => H('init', '--out', out, '--title', 'Lists', '--doc-url', 'https://example.com/docs/x', '--app-url', APP, ...a);
  const listed = out => JSON.parse(fs.readFileSync(path.join(work, out, 'demo.json'), 'utf8')).doc.steps;
  const rows = out => JSON.stringify(listed(out).map(s => [s.index, s.kind, s.text]));
  listDoc('nums', fs.readFileSync(path.join(work, 'demo/source.md'), 'utf8'));
  const fromList = check('init --list takes the doc steps from the numbered list', initList('nums', '--list', 'L1'));
  // the hand-written steps.json's fourth step is the sentence after the list, which is not an item
  expect('init --list gives the hand-written steps, quoted as the doc has them, with the same checks',
    rows('nums') === JSON.stringify([[1, 'action', 'Click **Add note** in the [header](#header).'], [2, 'action', 'Enter a *title* for the note.'],
      [3, 'action', 'Click **Save** &gt; done.']]) &&
    listed('nums').every((s, i) => s.index === steps[i].index && s.kind === steps[i].kind &&
      JSON.stringify(s.claims) === JSON.stringify(demo.doc.steps[i].claims.map(c => ({ kind: c.kind, text: c.text })))) &&
    fromList.stdout.includes('from L1:') && JSON.parse(fs.readFileSync(path.join(work, 'nums/steps.json'), 'utf8')).length === 3);
  listDoc('lists', `---\nurl: https://example.com/docs/agent#install-the-agent\n---\n
# Agent

1. Not in the section: the page's first list.

## Install the agent

To install the agent:

1. Open **Settings**.
2. Click **Agents**.

   \`\`\`
   1. Not a step: this is code
   \`\`\`

3. Do one of the following:
   - Click **Add agent**.
   - Press **A**.
4. Enter a name:
   1. Type the name.
   2. Press **Tab**.

\`\`\`
5. Not a step either
\`\`\`

5. Optionally, click **Test**.
6. Click **Save** to
   keep the agent.

> 1. Not a step: a note

To remove the agent:

1. Click **Remove**.
1. Click **Confirm**.

## Next steps

1. Not in the section either.
`);
  const unknownList = check('init --list refuses a list that is not in the outline', initList('lists', '--list', 'L3'), 1);
  expect('and prints the outline: lists in code, notes and other sections left out, a list that goes on after code kept whole, ' +
    'one written 1. 1. numbered 1, 2', unknownList.stderr.includes([
    'L1 after "To install the agent:"', '  1. Open **Settings**.', '  2. Click **Agents**.',
    '  3. Do one of the following: [alternatives: --choose 3=a or 3=b]', '      a. Click **Add agent**.', '      b. Press **A**.',
    '  4. Enter a name: [numbered sub-steps: to perform it, write steps.json]', '  5. Optionally, click **Test**.',
    '  6. Click **Save** to keep the agent.', 'L2 after "To remove the agent:"', '  1. Click **Remove**.', '  2. Click **Confirm**.'].join('\n')) &&
    !unknownList.stderr.includes('Not a step') && !unknownList.stderr.includes('Not in the section') && !unknownList.stderr.includes('\nL3'));
  const unchosen = check('init --list refuses alternatives with none chosen, and numbered sub-steps to perform', initList('lists', '--list', 'L1'), 6);
  expect('it says what to pass', unchosen.stderr.includes('item 3 offers alternatives (a, b): pass --choose 3=<letter>') &&
    unchosen.stderr.includes('item 4 has numbered sub-steps') && unchosen.stderr.includes('--steps') && !fs.existsSync(path.join(work, 'lists/demo.json')));
  check('init --list refuses an alternative the item does not offer', initList('lists', '--list', 'L1', '--choose', '3=c'), 1);
  check('init --list refuses --choose on an item without alternatives', initList('lists', '--list', 'L1', '--choose', '2=a'), 1);
  check('init --list refuses an item the list does not have', initList('lists', '--list', 'L1', '--select', '1-3,9'), 1);
  check('init --list refuses an unknown kind', initList('lists', '--list', 'L1', '--select', '1-2', '--kind', '2=maybe'), 1);
  check('init --list refuses a kind for an item left out', initList('lists', '--list', 'L1', '--select', '1-2', '--kind', '5=optional'), 1);
  check('init refuses --list with --steps', initList('lists', '--list', 'L1', '--steps', 'demo/steps.json'), 1);
  check('init --list with a chosen alternative, a kind and items left out',
    initList('lists', '--list', 'L1', '--select', '1-3,5-6', '--choose', '3=b', '--kind', '5=optional'));
  expect('the steps keep the doc\'s numbers and take the chosen alternative\'s text', rows('lists') === JSON.stringify([[1, 'action', 'Open **Settings**.'],
    [2, 'action', 'Click **Agents**.'], [3, 'action', 'Press **A**.'], [5, 'optional', 'Optionally, click **Test**.'], [6, 'action', 'Click **Save** to keep the agent.']]));
  listDoc('lists-2', fs.readFileSync(path.join(work, 'lists/source.md'), 'utf8'));
  check('init --list takes a list written 1. 1.', initList('lists-2', '--list', 'L2'));
  expect('as the reader sees them', rows('lists-2') === JSON.stringify([[1, 'action', 'Click **Remove**.'], [2, 'action', 'Click **Confirm**.']]));
  listDoc('lists-3', fs.readFileSync(path.join(work, 'lists/source.md'), 'utf8'));
  check('init --list takes an item with sub-steps that is not performed', initList('lists-3', '--list', 'L1', '--choose', '3=a', '--kind', '4=informational'));
  expect('as its own text', listed('lists-3')[3].text === 'Enter a name:' && listed('lists-3')[3].kind === 'informational');
  // a page converted from HTML: <ol><li> with an alternatives <ul> and a nested <ol>, and a real one (Drupal's)
  listDoc('lists-html', '---\nurl: https://example.com/docs/html#setup\nmethod: html\n---\n\n' + forTests.htmlToText('<main><h1>Guide</h1>' +
    '<h2 id="setup">Set up</h2><p>To set it up:</p><ol><li><p>Open <strong>Settings</strong>.</p></li>' +
    '<li>Do one of the following:<ul><li>Click <strong>Add</strong>.</li><li>Press A.</li></ul></li>' +
    '<li>Enter a name:<ol><li>Type it.</li><li>Press Tab.</li></ol></li><li>Click <strong>Save</strong>.</li></ol></main>'));
  check('init --list on a page converted from HTML', initList('lists-html', '--list', 'L1', '--choose', '2=b', '--kind', '3=informational'));
  expect('takes its items and alternatives', rows('lists-html') === JSON.stringify([[1, 'action', 'Open **Settings**.'], [2, 'action', 'Press A.'],
    [3, 'informational', 'Enter a name:'], [4, 'action', 'Click **Save**.']]));
  listDoc('lists-drupal', fs.readFileSync(path.join(ROOT, 'examples/drupal-regional-settings/source.md'), 'utf8'));
  check('init --list on Drupal\'s guide, converted from HTML', initList('lists-drupal', '--list', 'L1'));
  expect('gives the steps.json written by hand for it', rows('lists-drupal') ===
    JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/drupal-regional-settings/steps.json'), 'utf8')).map(s => [s.index, s.kind, s.text])));
  // doc prints the outline; an anchor that is not the heading's own is kept in source.md, so init reads the same section
  const outlined = check('doc prints an outline of the section\'s numbered lists', H('doc', '--out', 'nums-anchor', '--url', `${APP}docs/anchor#get-going`));
  expect('of the section only', outlined.stdout.includes('Numbered lists here (init --list <id>):\nL1 under "Step 1: Load data"\n  1. Click **Add**.') &&
    !outlined.stdout.includes('\nL2'));
  check('init --list reads the same section', initList('nums-anchor', '--list', 'L2'), 1);
  check('init --list L1 there', initList('nums-anchor', '--list', 'L1'));
  // CRLF line ends, steps nested under an alternative, a heading inside an item, numbered code indented four spaces, two
  // lists side by side, "Choose one:", spaces inside a code span, and a page's code block under a step
  listDoc('crlf', '---\r\nurl: https://example.com/docs/crlf#steps\r\n---\r\n\r\n# Guide\r\n\r\n## Steps\r\n\r\n1. Open **Settings**.\r\n2. Click **Save**.\r\n');
  check('init --list reads a doc with CRLF line ends', initList('crlf', '--list', 'L1'));
  expect('and takes every step', rows('crlf') === JSON.stringify([[1, 'action', 'Open **Settings**.'], [2, 'action', 'Click **Save**.']]));
  listDoc('deep', `---\nurl: https://example.com/docs/deep\n---\n
# Deep

1. Do one of the following:
   - Use the form:
     1. Click **Open**.
     2. Click **Save**.
   - Use the API.
2. Configure it:

   ### Options

   Set **Mode**.
3. Click **Done**.
`);
  const deep = check('init --list refuses steps nested under an alternative, and a heading inside an item', initList('deep', '--list', 'L1', '--choose', '1=a'), 6);
  expect('and says why, for both', (deep.stderr.match(/has lists or headings nested inside it/g) || []).length === 2);
  check('init --list takes the rest of that list', initList('deep', '--list', 'L1', '--select', '3'));
  expect('a heading inside an item does not end the list', rows('deep') === JSON.stringify([[3, 'action', 'Click **Done**.']]));
  listDoc('indented', `---\nurl: https://example.com/docs/indented\n---\n
# Indented

The output looks like this:

    1. Not a step
    2. Not a step either

1. Click **Run**.
`);
  check('init --list on a doc with numbered code indented four spaces', initList('indented', '--list', 'L1'));
  expect('leaves the code out', rows('indented') === JSON.stringify([[1, 'action', 'Click **Run**.']]));
  listDoc('adjacent', `---\nurl: https://example.com/docs/adjacent\n---\n
# Adjacent

1. Click **Create**.
2. Click **Save**.

1. Click **Undo**.
2. Click **Confirm**.
`);
  check('init --list on two lists side by side', initList('adjacent', '--list', 'L1'));
  expect('takes them as one: a Markdown list that starts again at 1 goes on, as readers see it', rows('adjacent') === JSON.stringify([[1, 'action', 'Click **Create**.'],
    [2, 'action', 'Click **Save**.'], [3, 'action', 'Click **Undo**.'], [4, 'action', 'Click **Confirm**.']]));
  listDoc('adjacent-html', '---\nurl: https://example.com/docs/adjacent-html\nmethod: html\n---\n\n' + forTests.htmlToText('<main><h1>Adjacent</h1>' +
    '<ol><li>Click <strong>Create</strong>.</li><li>Click <strong>Save</strong>.</li></ol><ol><li>Click <strong>Undo</strong>.</li></ol></main>'));
  check('init --list on two HTML lists side by side', initList('adjacent-html', '--list', 'L1'));
  expect('takes only the first', listed('adjacent-html').length === 2);
  listDoc('choose', `---\nurl: https://example.com/docs/choose\n---\n
# Choose

1. Choose one:
   - Click **Import**.
   - Click **Upload**.
2. Click **Done**, either now or after the upload ends.
   - The draft is kept.
3. Type \`a  b\` in **Name**.
`);
  check('init --list refuses "Choose one:" with none chosen', initList('choose', '--list', 'L1'), 6);
  check('init --list takes the alternative chosen', initList('choose', '--list', 'L1', '--choose', '1=b'));
  expect('"Choose one:" offers alternatives, "either" in a sentence does not, and a code span keeps its spaces', rows('choose') ===
    JSON.stringify([[1, 'action', 'Click **Upload**.'], [2, 'action', 'Click **Done**, either now or after the upload ends.'], [3, 'action', 'Type `a  b` in **Name**.']]));
  listDoc('html-code', '---\nurl: https://example.com/docs/html-code\nmethod: html\n---\n\n' + forTests.htmlToText('<main><h1>Query</h1>' +
    '<ol><li><p>Enter the following query:</p><pre><code>SELECT 1</code></pre></li><li>Click <strong>Run</strong>.</li></ol></main>'));
  check('init --list on a page with a code block under a step', initList('html-code', '--list', 'L1'));
  expect('the code is not part of the step\'s words, or a UI term', listed('html-code')[0].text === 'Enter the following query:' &&
    !listed('html-code').some(st => (st.claims || []).some(c => c.text.includes('SELECT'))));
  expect('it is the step\'s code block', JSON.stringify(forTests.docOutline(fs.readFileSync(path.join(work, 'html-code/source.md'), 'utf8'),
    listed('html-code'))[0].code) === JSON.stringify(['SELECT 1']));
  expect('an HTML page\'s code keeps its spaces, and a <pre> stays a block, as written', forTests.htmlToText('<main><p>Type <code>a  b</code> in the box.</p>' +
    '<pre><code>SELECT  1\n  FROM t;</code></pre></main>') === 'Type `a  b` in the box.\n\n```\nSELECT  1\n  FROM t;\n```');
  // numbers that go down do not end a Markdown list, and a code span on an item's next line is part of it; an HTML
  // comment ends a list; an HTML page's lists stay apart, even with the same numbers; "Choose an option:"; actions
  // listed under an item; an alternative with steps nested in it, in Markdown and HTML; a code span with a backtick
  listDoc('renumbered', `---\nurl: https://example.com/docs/renumbered\n---\n
# Renumbered

1. Click **Open**.
2. Click **Configure**.
1. Click
    \`Save\`

To finish:

5. Click **Close**.
1. Click **Exit**.
`);
  check('init --list on a list whose numbers go down', initList('renumbered', '--list', 'L1'));
  expect('takes it whole, numbered as readers see it, with the code span on the next line', rows('renumbered') ===
    JSON.stringify([[1, 'action', 'Click **Open**.'], [2, 'action', 'Click **Configure**.'], [3, 'action', 'Click `Save`']]));
  listDoc('renumbered-2', fs.readFileSync(path.join(work, 'renumbered/source.md'), 'utf8'));
  check('init --list on a list that starts at 5', initList('renumbered-2', '--list', 'L2'));
  expect('numbers it from 5', rows('renumbered-2') === JSON.stringify([[5, 'action', 'Click **Close**.'], [6, 'action', 'Click **Exit**.']]));
  listDoc('commented', `---\nurl: https://example.com/docs/commented\n---\n
# Commented

1. Click **Create**.
   <!-- the button is blue -->
2. Click **Save**.

<!-- -->

1. Click **Undo**.

<!--
1. Not a step
-->
`);
  const commented = check('init --list refuses a list the doc does not have (comments)', initList('commented', '--list', 'L9'), 1);
  expect('an HTML comment ends a list and is left out', commented.stderr.includes(['L1 under "Commented"', '  1. Click **Create**.', '  2. Click **Save**.',
    'L2 under "Commented"', '  1. Click **Undo**.'].join('\n')) && !commented.stderr.includes('Not a step') && !commented.stderr.includes('blue'));
  listDoc('adjacent-html-2', '---\nurl: https://example.com/docs/adjacent-html-2\nmethod: html\n---\n\n' + forTests.htmlToText('<main><h1>Apart</h1>' +
    '<ol><li>Click <strong>Create</strong>.</li></ol><ol><li>Click <strong>Undo</strong>.</li></ol>' +
    '<p>Then:</p><ol><li>Click <strong>Open</strong>.</li></ol><pre>log</pre><ol start="2"><li>Click <strong>Close</strong>.</li></ol></main>'));
  const apart = check('init --list refuses a list the doc does not have (HTML)', initList('adjacent-html-2', '--list', 'L9'), 1);
  expect('an HTML page\'s lists stay apart with the same numbers, and one that goes on after code is one list', apart.stderr.includes(['L1 under "Apart"',
    '  1. Click **Create**.', 'L2 under "Apart"', '  1. Click **Undo**.', 'L3 after "Then:"', '  1. Click **Open**.', '  2. Click **Close**.'].join('\n')));
  listDoc('options', `---\nurl: https://example.com/docs/options\n---\n
# Options

1. Choose an option:
   - Click **Import**.
   - Click **Upload**.
2. Do the following:
   - Click **Refresh**.
   - Click **Close**.
3. Choose what you want to do:
   - **Open in new tab**: opens a second tab.
   - **Download**: downloads it as JSON.
4. Type \`\` a  \`  b \`\` in **Name**.
`);
  const options = check('init --list refuses actions listed under an item', initList('options', '--list', 'L1', '--choose', '1=a'), 6);
  expect('and says which', options.stderr.includes('item 2 lists actions under it ("Click Refresh.")') && !/item [134]/.test(options.stderr));
  check('init --list takes the rest, with "Choose an option:" as alternatives', initList('options', '--list', 'L1', '--choose', '1=a', '--select', '1,3-4'));
  expect('an option named and described is not an action, and a code span with a backtick keeps its spaces', rows('options') ===
    JSON.stringify([[1, 'action', 'Click **Import**.'], [3, 'action', 'Choose what you want to do:'], [4, 'action', 'Type `` a  `  b `` in **Name**.']]));
  listDoc('deep-b', fs.readFileSync(path.join(work, 'deep/source.md'), 'utf8'));
  const deepOutline = check('init --list refuses a list the doc does not have (nested steps)', initList('deep-b', '--list', 'L9'), 1);
  expect('the outline marks the alternative with steps nested in it', deepOutline.stderr.includes(
    '      a. Use the form: [lists or headings nested inside: to perform it, write steps.json]\n      b. Use the API.'));
  check('init --list takes the alternative without nested steps', initList('deep-b', '--list', 'L1', '--choose', '1=b', '--select', '1,3'));
  expect('as the doc has it', rows('deep-b') === JSON.stringify([[1, 'action', 'Use the API.'], [3, 'action', 'Click **Done**.']]));
  listDoc('comments-2', `---\nurl: https://example.com/docs/comments-2\n---\n
# Comments

1. Click
   <!-- note --> **Save**.
2. Click **Open** <!--
3. Hidden
--> now.
3. Click **Done**.
4. Type \`<!--
   example -->\` in the editor.
5. Type \`example
   <!-- keep -->\` in the editor.
`);
  check('init --list on items with comments inside them', initList('comments-2', '--list', 'L1'));
  expect('a comment is left out and the text after it kept, a comment over lines hides what is in it, and one in code is code', rows('comments-2') ===
    JSON.stringify([[1, 'action', 'Click **Save**.'], [2, 'action', 'Click **Open** now.'], [3, 'action', 'Click **Done**.'], [4, 'action', 'Type `<!-- example -->` in the editor.'],
    [5, 'action', 'Type `example <!-- keep -->` in the editor.']]));
  listDoc('comments-3', fs.readFileSync(path.join(work, 'comments-2/source.md'), 'utf8'));
  fs.writeFileSync(path.join(work, 'comments-3-steps.json'), JSON.stringify([{ index: 4, text: 'Type `<!-- other -->` in the editor.', kind: 'action' }]));
  check('init refuses a step whose code differs from the doc\'s, even inside a comment', initList('comments-3', '--steps', 'comments-3-steps.json'), 6);
  fs.writeFileSync(path.join(work, 'comments-3-steps.json'), JSON.stringify([{ index: 1, text: '<!-- note -->', kind: 'action' }]));
  check('init refuses a step that is only a comment', initList('comments-3', '--steps', 'comments-3-steps.json'), 6);
  listDoc('comments-4', `---\nurl: https://example.com/docs/comments-4\n---\n
# Hidden

<!-- \` -->

<!-- Click **Delete**. -->

1. Press \\\` to open the console. <!--
2. Hidden action.
-->
3. Click \`Save\`.
`);
  fs.writeFileSync(path.join(work, 'comments-4-steps.json'), JSON.stringify([{ index: 1, text: 'Click **Delete**.', kind: 'action' }]));
  check('init refuses a step that is only in a comment, even with a backtick in another comment', initList('comments-4', '--steps', 'comments-4-steps.json'), 6);
  check('init --list after an escaped backtick', initList('comments-4', '--list', 'L1'));
  expect('a comment after an escaped backtick still hides what is in it', rows('comments-4') ===
    JSON.stringify([[1, 'action', 'Press \\` to open the console.'], [2, 'action', 'Click `Save`.']]));
  listDoc('comments-5', `---\nurl: https://example.com/docs/comments-5\n---\n
# Blocks

\`\`\`
\`\`\`\`text
<!-- x -->
1. Not a step
\`\`\`

1. Click **Save**.

<!--a--><!--b-->

1. Click **Close**.

Press \`
<!--
1. Delete it.
-->
Use \`

<!-- Draft
1. Delete everything.
`);
  const blocks = check('init --list refuses a list the doc does not have (blocks)', initList('comments-5', '--list', 'L9'), 1);
  expect('a fence closes only on a fence of its own, two comments on a line are a block, a code span ends with its block, ' +
    'and a comment that never closes hides the rest', blocks.stderr.includes(['L1 under "Blocks"', '  1. Click **Save**.', 'L2 under "Blocks"', '  1. Click **Close**.'].join('\n')) &&
    !/Not a step|Delete|\nL3/.test(blocks.stderr));
  listDoc('options-2', `---\nurl: https://example.com/docs/options-2\n---\n
# More options

1. Do the following:
   - Then click **Import**.
2. Configure it:
   - Enable caching.
3. Pick a mode:
   - Open: opens a tab.
   - \`Edit\`: opens the editor.
   - **Type** - Selects the data source.
4. Set it up:
   - Enter the following value: localhost.
5. Configure the time range:
   - Start time is inclusive.
   - **Search box**
6. Finish:
   - Before continuing, click **Save**.
7. Do the following:
   - Click Save
8. Do the following:
   - **Click** Save.
9. Do the following:
   - Click **Show advanced options**.
10. Do the following:
    - **Click** and drag.
11. Configure the end time:
    - **End time** is exclusive.
12. Configure the range:
    - **Start time** and **End time** are required.
13. Do this:
    - **Click** Show advanced options.
`);
  const options2 = check('init --list refuses actions after a word such as "Then" or "Before ...,", and verbs such as "Enable"', initList('options-2', '--list', 'L1'), 6);
  expect('or a short command, a verb in bold or a target that holds "Show", but not names, or what something is', options2.stderr.includes('item 1 lists actions under it ("Then click Import.")') &&
    options2.stderr.includes('item 2 lists actions under it ("Enable caching.")') && options2.stderr.includes('item 4 lists actions under it ("Enter the following value') &&
    options2.stderr.includes('item 6 lists actions under it ("Before continuing, click Save.")') && !/item [35]/.test(options2.stderr) &&
    ['item 7 lists actions under it ("Click Save")', 'item 8 lists actions under it ("Click Save.")', 'item 9 lists actions under it ("Click Show advanced options.")',
      'item 10 lists actions under it ("Click and drag.")', 'item 13 lists actions under it ("Click Show advanced options.")'].every(m => options2.stderr.includes(m)) &&
    !/item 1[12]\b/.test(options2.stderr));
  const mark = String.fromCharCode(0xe000), mark2 = String.fromCharCode(0xe001);
  const planted = forTests.htmlToText('<main><p>&#57344;7&#57344; stays</p><pre>print(&#39;&#57345;&#39;)</pre><p>Type <code>a  b\nc  d</code>.</p></main>');
  expect('text on a page cannot pass for DocDemo\'s own marks, and inline code over lines keeps its spaces', planted.includes(`${mark}7${mark} stays`) &&
    planted.includes(`print('${mark2}')`) && !planted.includes('<!--') && planted.includes('Type `a  b c  d`.'));
  listDoc('pre-alt', '---\nurl: https://example.com/docs/pre-alt\nmethod: html\n---\n\n' + forTests.htmlToText('<main><h1>Code</h1>' +
    '<ol><li>Do one of the following:<ul><li>Use the CLI:<pre><code>docdemo  run</code></pre></li><li>Use the API.</li></ul></li><li>Click <strong>Done</strong>.</li></ol></main>'));
  check('init --list on an alternative with a code block in it', initList('pre-alt', '--list', 'L1', '--choose', '1=b'));
  expect('the code stays in its alternative, and the next alternative is kept', rows('pre-alt') === JSON.stringify([[1, 'action', 'Use the API.'], [2, 'action', 'Click **Done**.']]) &&
    fs.readFileSync(path.join(work, 'pre-alt/source.md'), 'utf8').includes('   - Use the CLI:\n\n     ```\n     docdemo  run\n     ```'));
  listDoc('deep-html', '---\nurl: https://example.com/docs/deep-html\nmethod: html\n---\n\n' + forTests.htmlToText('<main><h1>Deep</h1>' +
    '<ol><li>Do one of the following:<ul><li>Use the form:<ol><li>Click <strong>Open</strong>.</li><li>Click <strong>Save</strong>.</li></ol></li>' +
    '<li>Use the API.</li></ul></li><li>Click <strong>Done</strong>.</li></ol></main>'));
  check('init --list refuses an HTML page\'s alternative with steps nested in it', initList('deep-html', '--list', 'L1', '--choose', '1=a'), 6);
  check('init --list takes its other alternative', initList('deep-html', '--list', 'L1', '--choose', '1=b'));
  expect('as the page has it', rows('deep-html') === JSON.stringify([[1, 'action', 'Use the API.'], [2, 'action', 'Click **Done**.']]));

  // drag: onto another element (native drag and drop), and a sweep across a chart
  fs.mkdirSync(path.join(work, 'drag'));
  fs.writeFileSync(path.join(work, 'drag/source.md'), `---\nurl: https://example.com/docs/board\n---\n
# Organize the board

1. Drag **Milk** to the **Done** column.
2. Click and drag across the bars in the chart to select a range.
`);
  fs.writeFileSync(path.join(work, 'drag-steps.json'), JSON.stringify([
    { index: 1, text: 'Drag **Milk** to the **Done** column.', kind: 'action' },
    { index: 2, text: 'Click and drag across the bars in the chart to select a range.', kind: 'action' },
  ]));
  check('init (drag demo)', H('init', '--out', 'drag', '--title', 'Organize the board', '--doc-url', 'https://example.com/docs/board',
    '--app-url', APP, '--steps', 'drag-steps.json'));
  check('open (drag demo)', H('open', '--out', 'drag'));
  snap = snapshot();
  const D = (...a) => H('act', '--out', 'drag', ...a);
  const cardRef = snap.match(/generic \[ref=(e\d+)\]: Milk/)?.[1], doneRef = ref(snap, 'region "Done"');
  check('drag needs --to or --to-ref', D('--doc-step', '1', '--instruction', 'x', '--ref', cardRef, 'drag'), 1);
  check('drag rejects --from outside the element', D('--doc-step', '1', '--instruction', 'x', '--ref', cardRef, 'drag', '--from', '1.5,0.5', '--to-ref', doneRef), 1);
  check('act drag onto another element', D('--doc-step', '1', '--instruction', 'Drag Milk onto Done', '--expect', 'Milk', '--ref', cardRef, 'drag', '--to-ref', doneRef));
  const evalPage = js => run('playwright-cli', [`-s=${SESSION}`, '--raw', 'eval', js]).stdout;
  expect('the card was dropped on Done', /true/.test(evalPage("() => document.getElementById('done').contains(document.getElementById('card'))")));
  const both = ['--claim', 'Milk', '--verdict', 'ok', '--note', 'on the page', '--claim', 'Done', '--verdict', 'ok', '--note', 'on the page'];
  check('check refuses a batch with an unknown claim, and records none of it', H('check', '--out', 'drag', '--doc-step', '1', ...both, '--claim', 'Bread', '--verdict', 'ok', '--note', 'x'), 1);
  expect('nothing of the refused batch was recorded', !JSON.parse(fs.readFileSync(path.join(work, 'drag/demo.json'), 'utf8')).checks);
  const batch = check('check answers several claims at once', H('check', '--out', 'drag', '--doc-step', '1', ...both));
  expect('check reports each answer', batch.stdout.includes('ok for term "Milk", ok for term "Done"'));
  // A text field with focus, whose blur redraws the chart (Grafana's query field): the drag must still work.
  run('playwright-cli', [`-s=${SESSION}`, 'click', ref(snapshot(), 'textbox "Filter"')]);
  expect('the filter has focus before the drag', /INPUT/.test(evalPage('() => document.activeElement.tagName')));
  snap = snapshot();
  check('act drag across a chart', D('--doc-step', '2', '--instruction', 'Drag across the bars', '--expect', 'Requests chart', '--ref', ref(snap, 'img "Requests chart"'),
    'drag', '--from', '0.3,0.5', '--to', '0.7,0.5'));
  expect('the brush selected a range', /Selected 3\d% to 7\d%/.test(evalPage("() => document.getElementById('range').textContent")));
  check('done (drag demo)', H('done', '--out', 'drag'));
  check('build (drag demo)', H('build', '--out', 'drag'));
  const dragDemo = JSON.parse(fs.readFileSync(path.join(work, 'drag/demo.json'), 'utf8'));
  const [d1, d2] = dragDemo.steps;
  expect('a drag onto an element records both ends and the target', d1.action.kind === 'drag' && d1.action.toRef === doneRef &&
    d1.action.from.x > 0 && d1.action.to.x > d1.action.from.x && d1.hotspot.width < 0.05);
  expect('a sweep records ends 40% of the chart apart, on one line', d2.action.from.y === d2.action.to.y &&
    Math.abs((d2.action.to.x - d2.action.from.x) / d2.box.width - 0.4) < 0.01);
  const dragHtml = fs.readFileSync(path.join(work, 'drag/index.html'), 'utf8');
  expect('index.html carries the drag ends but not the refs', dragHtml.includes('"kind":"drag"') && dragHtml.includes('"from":{') && !dragHtml.includes('"toRef"'));
  // the player: a drag from the dot to the ring performs the step; one that ends elsewhere does not; a click on the dot does
  run('playwright-cli', [`-s=${SESSION}`, 'goto', `${APP}out/drag/index.html#1`]);
  const at = sel => JSON.parse(JSON.parse(evalPage(`() => JSON.stringify((r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.querySelector('${sel}').getBoundingClientRect()))`)));
  const mouse = (...cmds) => cmds.forEach(c => run('playwright-cli', [`-s=${SESSION}`, ...c.map(String)]));
  const hash = () => evalPage('() => location.hash');
  const dot = at('#hot'), ring = at('#gEnd');
  mouse(['mousemove', dot.x, dot.y], ['mousedown'], ['mousemove', dot.x + 10, dot.y + 40], ['mousemove', dot.x + 20, dot.y + 80], ['mouseup']);
  expect('the player ignores a drag that misses the ring', hash().includes('#1'));
  mouse(['mousemove', dot.x, dot.y], ['mousedown'], ['mousemove', (dot.x + ring.x) / 2, (dot.y + ring.y) / 2], ['mousemove', ring.x, ring.y], ['mouseup']);
  expect('the player advances when the viewer drags to the ring', hash().includes('#2'));
  const dot2 = at('#hot');
  mouse(['mousemove', dot2.x, dot2.y], ['mousedown'], ['mouseup']);
  expect('a click on the dot performs a drag step too', hash().includes('#3'));

  // the reader copy: an intro and an outro, the doc's sections, a step's code block, frames that only get a
  // field ready folded into the typing, clickable steps, progress labels and a hint for a wrong value
  fs.mkdirSync(path.join(work, 'reader/assets'), { recursive: true });
  fs.writeFileSync(path.join(work, 'reader/source.md'), `---\nurl: https://example.com/docs/query\nfetchedFrom: https://example.com/docs/query\nfetchedAt: 2026-11-01T00:00:00Z\nmethod: md\n---\n
# Query the logs

## Open the editor

1. Click **Explore**.

## Run a query

1. Enter the following query:

   \`\`\`
   {job="app"} |= "error"
   \`\`\`

2. Click **Run query**.
`);
  const QUERY = '{job="app"} |= "error"', EDITOR = "getByRole('textbox', { name: 'Editor content' })", spot = { x: 0.1, y: 0.1, width: 0.2, height: 0.05 };
  const readerFrames = [
    { docStep: 1, instruction: 'Click Explore', action: { kind: 'click', ref: 'e1' }, hotspot: spot, locator: "getByRole('link', { name: 'Explore' })" },
    { docStep: 2, instruction: 'Click in the query editor', action: { kind: 'click', ref: 'e2' }, hotspot: spot, locator: EDITOR },
    { docStep: 2, instruction: 'Select the query', action: { kind: 'press', value: 'ControlOrMeta+a' } },
    { docStep: 2, instruction: 'Replace the query', action: { kind: 'fill', ref: 'e2', value: QUERY }, hotspot: spot, locator: EDITOR },
    { docStep: 2, instruction: 'Press Escape to close the suggestions', action: { kind: 'press', value: 'Escape' } },
    { docStep: 3, instruction: 'Click Run query', action: { kind: 'click', ref: 'e3' }, hotspot: spot, locator: "getByRole('button', { name: 'Run query' })" },
    { instruction: 'The logs with errors are listed' },
  ].map((fr, i) => ({ n: i + 1, ...fr, status: 'ok', image: `assets/${pad(i + 1)}.webp` }));
  for (const fr of readerFrames) fs.copyFileSync(path.join(work, 'demo/assets/001.webp'), path.join(work, 'reader', fr.image));
  const readerDemo = {
    version: 1, title: 'Query the logs', intro: 'You open the editor and run a query.', introNote: 'Recorded on a test app.',
    outro: 'You found the **errors**.', generatedAt: '2026-11-01T00:00:00Z', generator: { name: 'docdemo' },
    doc: { url: 'https://example.com/docs/query', fetchedAt: '2026-11-01T00:00:00Z', steps: [
      { index: 1, text: 'Click **Explore**.', kind: 'action' }, { index: 2, text: 'Enter the following query:', kind: 'action' },
      { index: 3, text: 'Click **Run query**.', kind: 'action' }] },
    app: { url: APP, viewport: { width: 1440, height: 900 } }, status: 'complete', steps: readerFrames,
  };
  fs.writeFileSync(path.join(work, 'reader/demo.json'), JSON.stringify({ ...readerDemo, intro: 42 }));
  check('build refuses an intro that is not text', H('build', '--out', 'reader'), 6);
  fs.writeFileSync(path.join(work, 'reader/demo.json'), JSON.stringify(readerDemo));
  const readerBuilt = check('build (reader copy features)', H('build', '--out', 'reader'));
  const data = file => JSON.parse(fs.readFileSync(path.join(work, 'reader', file), 'utf8').match(/const DEMO = (\{.*\});\n/)[1]);
  const reader = data('index.html'), review = data('review.html');
  expect('the reader copy folds the frames that only get the field ready, and says how many it has',
    reader.steps.map(fr => fr.instruction).join('|') === 'Click Explore|Replace the query|Click Run query|The logs with errors are listed' &&
    readerBuilt.stdout.includes('7 frames (4 in the reader copy)'));
  expect('the review copy keeps every frame and marks the folded ones', review.review === true && review.steps.length === 7 &&
    review.steps.filter(fr => fr.folded).map(fr => fr.n).join() === '2,3,5');
  expect('the reader copy has the intro, the outro, the sections and the code block', reader.intro === readerDemo.intro &&
    reader.outro === readerDemo.outro && reader.doc.steps.map(d => d.section).join('|') === 'Open the editor|Run a query|Run a query' &&
    JSON.stringify(reader.doc.steps[1].code) === JSON.stringify([QUERY]) && !reader.doc.steps[0].code && reader.review === undefined);
  run('playwright-cli', [`-s=${SESSION}`, 'goto', `${APP}out/reader/index.html`]);
  await new Promise(res => setTimeout(res, 500));
  const page = js => JSON.parse(evalPage(js));
  expect('the player opens on the intro, with Start focused', page("() => !document.getElementById('intro').hidden && document.activeElement.id === 'startBtn' && location.hash === '#intro'") &&
    page("() => document.getElementById('introNote').textContent") === 'Recorded on a test app.');
  run('playwright-cli', [`-s=${SESSION}`, 'press', 'Enter']);
  expect('Start goes to the first screen; the progress says screen and step', page("() => location.hash + ' ' + document.getElementById('progress').textContent") === '#1 Screen 1 of 4 · Step 1 of 3');
  expect('the steps are listed under the doc\'s headings, with the code to copy',
    page("() => [...document.querySelectorAll('.steps .section')].map(h => h.textContent).join('|')") === 'Open the editor|Run a query' &&
    page("() => document.querySelector('.codeblock code').textContent") === QUERY && page("() => !!document.querySelector('.codeblock .copy')"));
  page("() => { [...document.querySelectorAll('.jump')][2].click(); return true; }");
  expect('a step in the list goes to its first screen', page('() => location.hash') === '#3');
  page("() => { [...document.querySelectorAll('.jump')][1].click(); return true; }");
  page("() => { const t = document.getElementById('typein'); t.focus(); t.value = 'wrong'; return true; }");
  run('playwright-cli', [`-s=${SESSION}`, 'press', 'Enter']);
  expect('a wrong value shows what to type', page('() => location.hash') === '#2' &&
    page("() => !document.getElementById('hint').hidden && document.querySelector('#hint code').textContent") === QUERY);
  run('playwright-cli', [`-s=${SESSION}`, 'goto', `${APP}out/reader/index.html#end`]);
  expect('the reader copy ends with the outro, not the run\'s numbers', page("() => document.getElementById('endOutro').innerHTML") === 'You found the <strong>errors</strong>.' &&
    page("() => document.getElementById('endCounts').hidden"));
  run('playwright-cli', [`-s=${SESSION}`, 'goto', `${APP}out/reader/index.html#4`]);
  expect('the final frame shows its own text', page("() => document.getElementById('caption').textContent") === 'The logs with errors are listed');
  run('playwright-cli', [`-s=${SESSION}`, 'goto', `${APP}out/reader/review.html#2`]);
  expect('the review copy says which frames readers don\'t get', page("() => document.getElementById('caption').textContent").startsWith('Not in the reader copy'));

  // amend: corrects what a frame of a finished demo says, rebuilds, and keeps demo.json as it was
  fs.cpSync(path.join(work, 'reader'), path.join(work, 'amended'), { recursive: true });
  const A = (...a) => H('amend', '--out', 'amended', ...a);
  const amendedJson = () => fs.readFileSync(path.join(work, 'amended/demo.json'), 'utf8');
  const backups = () => fs.existsSync(path.join(work, 'amended/.debug/amend')) ? fs.readdirSync(path.join(work, 'amended/.debug/amend')) : [];
  const original = amendedJson();
  for (const [why, args] of [['a frame that does not exist', ['--frame', '8', '--instruction', 'x']], ['frame 0', ['--frame', '0', '--instruction', 'x']],
    ['a frame that is not a number', ['--frame', 'two', '--instruction', 'x']], ['an empty instruction', ['--frame', '4', '--instruction', '  ']],
    ['nothing to change', ['--frame', '4']], ['--note with --clear-note', ['--frame', '4', '--note', 'x', '--clear-note']],
    ['a change that changes nothing', ['--frame', '4', '--instruction', 'Replace the query']]])
    check(`amend refuses ${why}`, A(...args), 1);
  expect('a refused amend wrote nothing', amendedJson() === original && !backups().length);
  const amended = check('amend an instruction', A('--frame', '4', '--instruction', 'Replace the query with the error filter'));
  const after = JSON.parse(amendedJson()), before = JSON.parse(original);
  expect('amend changes only the instruction, and rebuilds the copies', after.steps[3].instruction === 'Replace the query with the error filter' &&
    JSON.stringify({ ...after, steps: after.steps.map(fr => ({ ...fr, instruction: '' })) }) === JSON.stringify({ ...before, steps: before.steps.map(fr => ({ ...fr, instruction: '' })) }) &&
    fs.readFileSync(path.join(work, 'amended/index.html'), 'utf8').includes('"instruction":"Replace the query with the error filter"'));
  expect('amend shows the change and keeps demo.json as it was', amended.stdout.includes('instruction: "Replace the query" -> "Replace the query with the error filter"') &&
    backups().length === 1 && fs.readFileSync(path.join(work, 'amended/.debug/amend', backups()[0]), 'utf8') === original);
  check('amend a note', A('--frame', '1', '--note', 'doc says Explore; UI shows Explore data'));
  const amendedReport = () => fs.readFileSync(path.join(work, 'amended/report.md'), 'utf8');
  expect('an amended note is a finding in report.md and review.html, not in index.html', amendedReport().includes('doc says Explore; UI shows Explore data') &&
    fs.readFileSync(path.join(work, 'amended/review.html'), 'utf8').includes('UI shows Explore data') &&
    !fs.readFileSync(path.join(work, 'amended/index.html'), 'utf8').includes('UI shows Explore data'));
  check('amend --clear-note', A('--frame', '1', '--clear-note'));
  expect('a cleared note leaves the report', !amendedReport().includes('Explore data') && backups().length === 3);
  check('amend the final frame\'s note', A('--frame', '7', '--note', 'doc says the logs are listed; UI shows a chart of them'));
  expect('a note on the final frame is a finding of the last doc step', /- \*\*Step 3:\*\*[^\n]*\n  - doc says the logs are listed; UI shows a chart of them/.test(amendedReport()));
  check('amend --clear-note on the final frame', A('--frame', '7', '--clear-note'));
  fs.renameSync(path.join(work, 'amended/assets/007.webp'), path.join(work, 'amended/007.webp'));
  const keptJson = amendedJson(), keptPage = fs.readFileSync(path.join(work, 'amended/index.html'), 'utf8');
  check('amend refuses a demo that does not build', A('--frame', '1', '--instruction', 'Open Explore'), 6);
  expect('a demo that does not build is left as it was', amendedJson() === keptJson && fs.readFileSync(path.join(work, 'amended/index.html'), 'utf8') === keptPage && backups().length === 5);
  fs.renameSync(path.join(work, 'amended/007.webp'), path.join(work, 'amended/assets/007.webp'));
  // a build that fails after the demo passed its checks (here: a player without its data slot) writes nothing
  const broken = path.join(work, 'broken-skill');
  fs.mkdirSync(path.join(broken, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(broken, 'assets'));
  fs.copyFileSync(HELPER, path.join(broken, 'scripts/docdemo.mjs'));
  fs.writeFileSync(path.join(broken, 'assets/player.html'), '<!doctype html><title>no data slot</title>');
  const brokenRun = (...a) => spawnSync('node', [path.join(broken, 'scripts/docdemo.mjs'), ...a, '--out', 'amended'], { cwd: work, encoding: 'utf8' });
  const amendedFiles = () => ['demo.json', 'index.html', 'review.html', 'report.md'].map(f => fs.readFileSync(path.join(work, 'amended', f), 'utf8')).join('\0');
  const beforeBroken = amendedFiles(), backupsBefore = backups().length;
  const brokenAmend = check('amend that fails while building the copies', brokenRun('amend', '--frame', '1', '--instruction', 'Open the Explore page'), 1);
  const brokenBuild = check('build that fails while building the copies', brokenRun('build'), 1);
  expect('a demo whose copies fail to build is left as it was, with no backup', amendedFiles() === beforeBroken && backups().length === backupsBefore &&
    [brokenAmend, brokenBuild].every(r => r.stderr.includes('player.html is missing the data token')));
  const stopped = JSON.parse(keptJson);
  Object.assign(stopped.steps[5], { status: 'failed', note: 'doc says Run query; UI shows Run' });
  stopped.status = 'partial';
  fs.writeFileSync(path.join(work, 'amended/demo.json'), JSON.stringify(stopped));
  check('amend keeps the note of the frame where the demo stopped', A('--frame', '6', '--clear-note'), 1);
  check('amend corrects the note of the frame where the demo stopped', A('--frame', '6', '--note', 'doc says Run query; UI shows Run (the button)'));
  const unfinished = JSON.parse(keptJson);
  unfinished.steps.pop();
  fs.writeFileSync(path.join(work, 'amended/demo.json'), JSON.stringify(unfinished));
  check('amend refuses a demo that is not finished', A('--frame', '1', '--instruction', 'x'), 1);

  // product errors: the HTTP errors in the network log, a code editor, a link with no name, init --open, finish
  fs.mkdirSync(path.join(work, 'errors'));
  fs.writeFileSync(path.join(work, 'errors/source.md'), `---\nurl: https://example.com/docs/drafts\n---\n
# Save a draft

1. Click **Save draft**.
2. Enter the query \`{job="new"} |= "x"\` in the editor.
3. Click the explore icon.
`);
  fs.writeFileSync(path.join(work, 'errors-steps.json'), JSON.stringify([
    { index: 1, text: 'Click **Save draft**.', kind: 'action' },
    { index: 2, text: 'Enter the query `{job="new"} |= "x"` in the editor.', kind: 'action' },
    { index: 3, text: 'Click the explore icon.', kind: 'action' },
  ]));
  const E = (...a) => H(...a, '--out', 'errors');
  const started = check('init --open', E('init', '--title', 'Save a draft', '--doc-url', 'https://example.com/docs/drafts', '--app-url', APP, '--steps', 'errors-steps.json', '--open'));
  expect('init --open opens the app and prints its snapshot', started.stdout.includes(`opened ${APP}`) && started.stdout.includes('button "Save draft" [ref='));
  snap = snapshot();
  const saved = check('act click (the server fails)', E('act', '--doc-step', '1', '--instruction', 'Click Save draft', '--expect', 'Save draft', '--ref', ref(snap, 'button "Save draft"'), 'click'));
  expect('act reports the HTTP 500 with its message, and the 404 as routine', saved.stdout.includes('HTTP 500 Internal Server Error: POST /api/save ("disk full")') &&
    /HTTP 404 Not Found: GET \/api\/prefs[^\n]*often routine/.test(saved.stdout));
  check('note a product error', E('note', '--doc-step', '1', '--instruction', 'Saving shows an error', '--note', 'product: saving fails; the page says "Could not save: disk full"'));
  run('playwright-cli', [`-s=${SESSION}`, 'eval', "() => fetch('/api/late', { method: 'POST' }).then(r => r.status)"]); // fails while the agent reads the page
  snap = snapshot();
  const typed = check('act fill into a code editor', E('act', '--doc-step', '2', '--instruction', 'Enter the query', '--expect', 'Editor content', '--ref', ref(snap, 'textbox "Editor content"'),
    '--note', 'wording: the editor is named Editor content', 'fill', '{job="new"} |= "x"'));
  expect('the code editor holds exactly the value, not the old text with the value after it',
    JSON.parse(evalPage("() => document.querySelector('#editor .view-lines').textContent.replace(/\\u00a0/g, ' ')")) === '{job="new"} |= "x"' && !typed.stdout.includes('WARNING'));
  expect('an HTTP error between two captures goes with the frame before', typed.stdout.includes('Since the previous action') && typed.stdout.includes('HTTP 502 Bad Gateway: POST /api/late'));
  snap = snapshot();
  const exploreRef = snap.match(/- link \[ref=([a-z0-9]+)\][^\n]*\n(?:[^\n]*\n)?\s*- \/url: \/explore/)?.[1];
  check('act rejects a link with no name that goes elsewhere', E('act', '--doc-step', '3', '--instruction', 'x', '--expect', '/dashboards', '--ref', exploreRef, 'click'), 4);
  check('act matches a link with no name by its URL', E('act', '--doc-step', '3', '--instruction', 'Click the explore icon', '--expect', '/explore', '--ref', exploreRef, 'click'));
  check('finish refuses while a check is open', E('finish'), 6);
  const finished = check('finish answers the open check, as the checks list prints it',
    E('finish', '--claim', 'place "the explore icon"', '--verdict', 'ok', '--note', 'the only icon link, to Explore'));
  expect('finish records the final frame, builds and closes the browser', /ok frame 5 \(done\)/.test(finished.stdout) && finished.stdout.includes('built ') &&
    finished.stdout.includes('the product returned errors in 1 step(s)') && finished.stdout.includes('closed the browser'));
  const errReport = fs.readFileSync(path.join(work, 'errors/report.md'), 'utf8');
  expect('report.md lists the product error with the HTTP errors of its step', errReport.includes('## The product returned errors (1)') &&
    /- \*\*Step 1:\*\* Click \*\*Save draft\*\*\.\n  - saving fails/.test(errReport) && errReport.includes('  - HTTP 500 Internal Server Error: POST /api/save ("disk full")') &&
    errReport.includes('  - HTTP 404 Not Found: GET /api/prefs ("no preferences")') && errReport.includes('  - HTTP 502 Bad Gateway: POST /api/late ("upstream down")'));
  expect('report.md does not count a product error or loose wording as a doc mismatch', errReport.includes('The doc matched the product at every documented step'));
  expect('report.md lists loose wording under its own heading', errReport.includes('## Wording to tighten (1)') &&
    /- \*\*Step 2:\*\* Enter the query[^\n]*\n  - the editor is named Editor content/.test(errReport));
  expect('finish prints the wording note with its label', finished.stdout.includes('wording (doc step 2): the editor is named Editor content'));
  expect('index.html leaves out the HTTP errors', !fs.readFileSync(path.join(work, 'errors/index.html'), 'utf8').includes('/api/save'));
  fs.cpSync(path.join(work, 'errors'), path.join(work, 'errors-more'), { recursive: true });
  const more = JSON.parse(fs.readFileSync(path.join(work, 'errors-more/demo.json'), 'utf8'));
  more.steps[0].httpNotKept = 3;
  fs.writeFileSync(path.join(work, 'errors-more/demo.json'), JSON.stringify(more));
  check('build with server errors beyond the ones a capture keeps', H('build', '--out', 'errors-more'));
  expect('report.md says how many more server errors there were', fs.readFileSync(path.join(work, 'errors-more/report.md'), 'utf8')
    .includes('  - and 3 more server error(s) or failed request(s), not kept'));

  // an element the page replaces before the click lands, a browser dialog, peek, get, and a term that is
  // only part of a longer label
  fs.mkdirSync(path.join(work, 'extra'));
  fs.writeFileSync(path.join(work, 'extra/source.md'), `---\nurl: https://example.com/docs/extra\n---\n
# Tidy up

1. Click **Ping**.
2. Click **Delete draft**, then confirm.
3. Click **Add**.
`);
  fs.writeFileSync(path.join(work, 'extra-steps.json'), JSON.stringify([
    { index: 1, text: 'Click **Ping**.', kind: 'action' },
    { index: 2, text: 'Click **Delete draft**, then confirm.', kind: 'action' },
    { index: 3, text: 'Click **Add**.', kind: 'action' },
  ]));
  const X = (...a) => H(...a, '--out', 'extra');
  const status = () => JSON.parse(evalPage("() => document.getElementById('status').textContent"));
  snap = X('init', '--title', 'Tidy up', '--doc-url', 'https://example.com/docs/extra', '--app-url', APP, '--steps', 'extra-steps.json', '--open').stdout;
  const t0 = Date.now();
  const pinged = check('act clicks an element the page replaced under the pointer', X('act', '--doc-step', '1', '--instruction', 'Click Ping', '--expect', 'Ping', '--ref', ref(snap, 'button "Ping"'), 'click'));
  expect('the click landed on the element that took its place, in one act', status() === 'Pinged' && pinged.stdout.includes('replaced the element') && Date.now() - t0 < 9000);
  const peeked = check('peek hovers to read a tooltip', X('peek', '--ref', ref(pinged.stdout, 'button "Last run"')));
  expect('peek prints what the hover shows and records nothing', peeked.stdout.includes('Started 2026-10-31 20:42:00 UTC') &&
    JSON.parse(fs.readFileSync(path.join(work, 'extra/demo.json'), 'utf8')).steps.length === 1);
  const got = check('get reads the app\'s API', X('get', '/api/prefs'));
  expect('get prints the status and the response', got.stdout.includes('GET /api/prefs: HTTP 404 Not Found (application/json)') && got.stdout.includes('"no preferences"'));
  check('get refuses another site', X('get', 'https://example.com/'), 1);
  check('get refuses another origin on the same machine', X('get', `http://localhost:${PORT}/api/prefs`), 1);
  check('get refuses an address that deletes something', X('get', '/api/drafts/delete?id=1'), 1);
  const redirected = check('get stops at a redirect', X('get', '/api/redirect'));
  expect('get says where a redirect points, without following it', redirected.stdout.includes('HTTP 302') &&
    redirected.stdout.includes('redirects to /api/prefs (not followed)') && !redirected.stdout.includes('no preferences'));
  const secret = check('get hides secret-looking fields', X('get', '/api/token'));
  expect('a token in the response is not printed', secret.stdout.includes('"token":"***"') && secret.stdout.includes('"name":"demo"') && !secret.stdout.includes('tok-abc123'));
  const cancelled = check('act --dialog dismiss cancels the confirm dialog the click opens', X('act', '--doc-step', '2', '--instruction', 'Click Delete draft, then Cancel',
    '--expect', 'Delete draft', '--ref', ref(peeked.stdout, 'button "Delete draft"'), '--dialog', 'dismiss', 'click'));
  expect('the dialog was dismissed and reported', status() === 'Pinged' && cancelled.stdout.includes('DocDemo dismissed it (Cancel)') &&
    JSON.parse(fs.readFileSync(path.join(work, 'extra/demo.json'), 'utf8')).steps[1].dialogs?.[0].answer === 'dismissed');
  check('act refuses an unknown --dialog answer', X('act', '--doc-step', '2', '--instruction', 'x', '--ref', 'e1', '--dialog', 'maybe', 'click'), 1);
  const deleted = check('act accepts the confirm dialog the click opens', X('act', '--doc-step', '2', '--instruction', 'Click Delete draft', '--expect', 'Delete draft',
    '--ref', ref(cancelled.stdout, 'button "Delete draft"'), 'click'));
  expect('the dialog was accepted and reported', status() === 'Deleted' && deleted.stdout.includes('browser dialog (confirm: "Delete this draft?")') &&
    JSON.parse(fs.readFileSync(path.join(work, 'extra/demo.json'), 'utf8')).steps[2].dialogs?.[0].message === 'Delete this draft?');
  expect('the app\'s own 500 is reported, not crowded out by 25 routine 404s from the app or 25 errors from another site',
    deleted.stdout.includes('HTTP 500 Internal Server Error: POST /api/save') && !deleted.stdout.includes('localhost') &&
    deleted.stdout.includes('(6 more HTTP errors from the app\'s site are not listed)'));
  const added = check('act on a longer label than the doc\'s term', X('act', '--doc-step', '3', '--instruction', 'Click Add note', '--expect', 'Add note',
    '--ref', ref(deleted.stdout, 'button "Add note"'), 'click'));
  expect('a term that is only part of a label stays open', /term "Add": only as part of a longer label \(UI: "Add note"\)\s+\[OPEN\]/.test(added.stdout));
  check('finish refuses while that check is open', X('finish'), 6);
  check('a later frame of the step answers its own check', X('note', '--doc-step', '3', '--instruction', 'The new note form is open',
    '--claim', 'Add', '--verdict', 'doc', '--note', 'doc says Add; UI shows Add note'));
  check('finish (extra demo)', X('finish'));
  expect('report.md lists the answer as a doc mismatch', fs.readFileSync(path.join(work, 'extra/report.md'), 'utf8').includes('doc says Add; UI shows Add note'));

  // a search that asks the server after the typing stops, an element replaced by one that sits elsewhere, and a
  // click that lands but whose page takes longer than the action's time: marked for a person to check
  fs.mkdirSync(path.join(work, 'later'));
  fs.writeFileSync(path.join(work, 'later/source.md'), `---\nurl: https://example.com/docs/later\n---\n
# Find and archive

1. Type **milk** in **Search**.
2. Click **Archive**.
3. Click **Slow report**.
`);
  fs.writeFileSync(path.join(work, 'later-steps.json'), JSON.stringify([
    { index: 1, text: 'Type **milk** in **Search**.', kind: 'action' },
    { index: 2, text: 'Click **Archive**.', kind: 'action' },
    { index: 3, text: 'Click **Slow report**.', kind: 'action' },
  ]));
  const Y = (...a) => H(...a, '--out', 'later');
  snap = Y('init', '--title', 'Find and archive', '--doc-url', 'https://example.com/docs/later', '--app-url', APP, '--steps', 'later-steps.json', '--open').stdout;
  const searched = check('act fill into a search that waits for the typing to stop', Y('act', '--doc-step', '1', '--instruction', 'Type milk in Search',
    '--expect', 'Search', '--ref', ref(snap, 'textbox "Search"'), 'fill', 'milk'));
  expect('the snapshot after the typing shows the results the search asked the server for', /listitem[^\n]*milk results/.test(searched.stdout));
  expect('a label no reader can see does not count as on the page', !fs.readFileSync(path.join(work, 'later/.debug/seen-001.json'), 'utf8').includes('Purge drafts') &&
    fs.readFileSync(path.join(work, 'later/.debug/seen-001.json'), 'utf8').includes('Search'));
  check('act refuses a mistyped option, even with a valid answer', Y('act', '--doc-step', '2', '--instruction', 'Click Archive', '--claim', 'milk', '--verdict', 'not-ui',
    '--note', 'the value to type', '--ref', ref(searched.stdout, 'button "Archive"'), '--dialog', 'maybe', 'click'), 1);
  expect('the answer of a refused act is not recorded', !JSON.parse(fs.readFileSync(path.join(work, 'later/demo.json'), 'utf8')).checks);
  const archived = check('act clicks an element the page replaced with one that sits elsewhere', Y('act', '--doc-step', '2', '--instruction', 'Click Archive',
    '--expect', 'Archive', '--claim', 'milk', '--verdict', 'not-ui', '--note', 'the value to type', '--ref', ref(searched.stdout, 'button "Archive"'), 'click'));
  const later = () => JSON.parse(fs.readFileSync(path.join(work, 'later/demo.json'), 'utf8'));
  const moved = JSON.parse(JSON.parse(evalPage("() => JSON.stringify(document.getElementById('archive').getBoundingClientRect())")));
  expect('the click landed on the moved element, and the screenshot and hotspot are where it moved to', status() === 'Archived' &&
    archived.stdout.includes('which sat elsewhere, so the screenshot was taken again') && Math.abs(later().steps[1].box.y * 900 - moved.y) < 3);
  const slow = check('act clicks a link whose page is slow to answer', Y('act', '--doc-step', '3', '--instruction', 'Click Slow report', '--expect', 'Slow report',
    '--ref', ref(archived.stdout, 'link "Slow report"'), 'click'));
  expect('the action is not repeated, and the frame is marked for a person to check', slow.stdout.includes('WARNING: the action ran') &&
    /Timeout/i.test(later().steps[2].uncertain || ''));
  check('finish (frames to check)', Y('finish'));
  const laterReport = fs.readFileSync(path.join(work, 'later/report.md'), 'utf8');
  expect('report.md lists the frame to check, and review.html marks it', laterReport.includes('## Frames to check (1)') &&
    /- \*\*Step 3:\*\*[^\n]*\n  - frame 3 \("Click Slow report"\): the action ran, but DocDemo could not confirm/.test(laterReport) &&
    fs.readFileSync(path.join(work, 'later/review.html'), 'utf8').includes('check: The action ran') &&
    !fs.readFileSync(path.join(work, 'later/index.html'), 'utf8').includes('could not confirm'));
  fs.cpSync(path.join(work, 'later'), path.join(work, 'later-maybe'), { recursive: true });
  const maybeDemo = JSON.parse(fs.readFileSync(path.join(work, 'later-maybe/demo.json'), 'utf8'));
  maybeDemo.steps[2].uncertain = 'it may not have reached the page: Timeout 4000ms exceeded.';
  fs.writeFileSync(path.join(work, 'later-maybe/demo.json'), JSON.stringify(maybeDemo));
  check('build with a frame whose action may not have reached the page', H('build', '--out', 'later-maybe'));
  const maybeReport = fs.readFileSync(path.join(work, 'later-maybe/report.md'), 'utf8');
  expect('report.md and review.html do not say that it ran, and give the reason once',
    maybeReport.includes('frame 3 ("Click Slow report"): DocDemo could not confirm that the action reached the page.') &&
    maybeReport.includes('not done twice. (Timeout 4000ms exceeded.)') && !maybeReport.includes('the action ran, but') &&
    fs.readFileSync(path.join(work, 'later-maybe/review.html'), 'utf8').includes('check: DocDemo could not confirm that the action reached the page'));

  // a capture waits for a request already on its way when it begins (its answer still arriving); a note leaves
  // a browser dialog to the agent; an element replaced by one that shows only later is waited for, and one whose
  // replacement never shows fails within the action's time; a capture a dialog left unfinished past the pick-up
  // time is not recorded, and the agent is told the action may have run
  fs.mkdirSync(path.join(work, 'busy'));
  fs.writeFileSync(path.join(work, 'busy/source.md'), `---\nurl: https://example.com/docs/busy\n---\n
# Wait for it

1. Point at **Last run**.
2. Click **Restock**.
`);
  fs.writeFileSync(path.join(work, 'busy-steps.json'), JSON.stringify([
    { index: 1, text: 'Point at **Last run**.', kind: 'action' },
    { index: 2, text: 'Click **Restock**.', kind: 'action' },
  ]));
  const B = (...a) => H(...a, '--out', 'busy');
  const busyFrames = () => JSON.parse(fs.readFileSync(path.join(work, 'busy/demo.json'), 'utf8')).steps.length;
  snap = B('init', '--title', 'Wait for it', '--doc-url', 'https://example.com/docs/busy', '--app-url', APP, '--steps', 'busy-steps.json', '--open').stdout;
  // (playwright-cli waits for the requests a command starts, so the page starts this one just after eval returns)
  evalPage("() => { setTimeout(() => { window.streamStarted = Date.now(); fetch('/api/stream').then(r => r.text())" +
    ".then(t => { document.getElementById('status').textContent = t; }); }, 100); return 1; }");
  check('act while an answer is on its way', B('act', '--doc-step', '1', '--instruction', 'Point at Last run', '--expect', 'Last run',
    '--ref', ref(snap, 'button "Last run"'), 'hover'));
  const hoverRun = JSON.parse(fs.readFileSync(path.join(work, 'busy/.debug/actions.jsonl'), 'utf8').trim().split('\n').at(-1)).result;
  expect('the capture began while the answer was on its way, and waited for it', hoverRun.ended - hoverRun.ms.total > JSON.parse(evalPage('() => window.streamStarted')) &&
    fs.readFileSync(path.join(work, 'busy/.debug/seen-001.json'), 'utf8').includes('Streamed answer'));
  evalPage("() => { setTimeout(() => { document.getElementById('status').textContent = confirm('Discard the draft?') ? 'Discarded' : 'Kept'; }, 0); return 1; }");
  const blocked = check('note while a browser dialog is open', B('note', '--doc-step', '1', '--instruction', 'The time of the last run shows'), 5);
  expect('the note records nothing and tells the agent to answer the dialog', busyFrames() === 1 &&
    blocked.stdout.includes('A browser dialog is open') && blocked.stdout.includes('Discard the draft?') && blocked.stdout.includes('dialog-dismiss'));
  run('playwright-cli', [`-s=${SESSION}`, 'dialog-dismiss']);
  expect('the note left the dialog open for the agent to answer', status() === 'Kept');
  // Restock is replaced, 0.3 s after the pointer reaches it, by a copy without a size that gets one 5 s later;
  // Reorder's copy never gets one
  evalPage(`() => {
    const main = document.querySelector('main');
    main.insertAdjacentHTML('afterbegin', '<p style="height: 40px"><button id="restock">Restock</button></p>');
    main.insertAdjacentHTML('beforeend', '<p style="height: 40px"><button id="reorder">Reorder</button></p>');
    for (const [id, grow] of [['restock', 5000], ['reorder', 0]]) document.getElementById(id).addEventListener('mouseover', function () {
      const b = this.cloneNode(true), spot = this.parentElement;
      b.style.cssText = 'height: 0; padding: 0; border: 0; overflow: hidden';
      b.onclick = () => { document.getElementById('status').textContent = id + 'ed'; };
      this.remove();
      setTimeout(() => spot.append(b), 300);
      if (grow) setTimeout(() => { b.style.cssText = ''; }, grow);
    }, { once: true });
    return 1; }`);
  const restocked = check('act clicks an element whose replacement shows only later', B('act', '--doc-step', '2', '--instruction', 'Click Restock', '--expect', 'Restock',
    '--ref', ref(snapshot(), 'button "Restock"'), 'click'));
  expect('the click waited for the replacement to show, then landed on it', status() === 'restocked' && restocked.stdout.includes('replaced the element') && busyFrames() === 2);
  const reorderAt = Date.now();
  const reordered = check('act on an element whose replacement never shows', B('act', '--doc-step', '2', '--instruction', 'Click Reorder', '--expect', 'Reorder',
    '--ref', ref(snapshot(), 'button "Reorder"'), 'click'), 5);
  expect('the act fails within its time, says why, and records nothing', Date.now() - reorderAt < 15000 && status() === 'restocked' && busyFrames() === 2 &&
    reordered.stderr.includes('the one that took its place (same role and name) did not show in time'));
  // a click that opens a dialog and then keeps the page busy for 4 s: its capture is not picked up within the
  // time allowed (1 s here, 45 s in a run)
  evalPage(`() => { document.getElementById('status').insertAdjacentHTML('afterend', ' <button id="purge">Purge all</button>');
    document.getElementById('purge').onclick = () => { if (confirm('Purge everything?')) {
      window.purges = (window.purges || 0) + 1; const t = Date.now(); while (Date.now() - t < 4000); document.getElementById('status').textContent = 'Purged'; } };
    return 1; }`);
  const purged = check('act whose capture is not picked up in time', spawnSync('node', [HELPER, 'act', '--doc-step', '2', '--instruction', 'Click Purge all',
    '--expect', 'Purge all', '--ref', ref(snapshot(), 'button "Purge all"'), 'click', '--out', 'busy'],
    { cwd: work, encoding: 'utf8', env: { ...process.env, DOCDEMO_SESSION: SESSION, DOCDEMO_PICK_UP_MS: '1000' } }), 5);
  expect('nothing is recorded, and the agent is told the action may have run', busyFrames() === 2 && !fs.existsSync(path.join(work, 'busy/assets/003.webp')) &&
    purged.stderr.includes('had not finished 1 s later, so nothing was recorded. The action may have run: do not repeat it.'));
  expect('the action ran once, and the next command works', status() === 'Purged' && JSON.parse(evalPage('() => window.purges')) === 1 &&
    check('note after it', B('note', '--doc-step', '2', '--instruction', 'Everything is purged')).status === 0 && busyFrames() === 3);

  // doc: an anchor that is not the heading's own, found through the page's HTML
  const anchored = check('doc finds a heading by the anchor on its wrapper', H('doc', '--out', 'anchor', '--url', `${APP}docs/anchor#get-going`));
  expect('doc prints the section the anchor points at', anchored.stdout.includes('#get-going (the heading "Step 1: Load data")') &&
    anchored.stdout.includes('1. Click **Add**.') && !anchored.stdout.includes('Click **Explore**'));
  // doc: the page (asked for the icon names in its HTML) never answers; the markdown is used after 8 s at most
  const askedAt = Date.now();
  const stalled = check('doc whose page never answers', H('doc', '--out', 'stall', '--url', `${APP}docs/stall`));
  expect('doc stops waiting for the page and prints the markdown, with no icon names', Date.now() - askedAt < 12000 &&
    stalled.stdout.includes('1. Click the `expand` icon.') && !/^icons:/m.test(fs.readFileSync(path.join(work, 'stall/source.md'), 'utf8')));

  // doc keeps a recorded demo it would replace: it moves it beside the new one
  fs.cpSync(path.join(work, 'errors'), path.join(work, 'again'), { recursive: true });
  const again = check('doc in a folder with a recorded demo', H('doc', '--out', 'again', '--url', `${APP}docs/anchor#get-going`));
  const kept = fs.readdirSync(work).find(d => d.startsWith('again.prev-'));
  expect('the recorded demo is kept as <out>.prev-<time>', kept && again.stdout.includes('kept the previous demo in ') && again.stdout.includes(kept) &&
    fs.existsSync(path.join(work, kept, 'demo.json')) && fs.existsSync(path.join(work, kept, 'assets')) &&
    fs.existsSync(path.join(work, 'again/source.md')) && !fs.existsSync(path.join(work, 'again/demo.json')));

  // doc deletes only what a run that recorded nothing leaves; a demo.json that does not parse, or a file in assets/
  // that DocDemo did not name, is moved aside too
  const ownSource = fs.readFileSync(path.join(work, 'errors/source.md'), 'utf8').replace('url: https://example.com/docs/drafts\n',
    'url: https://example.com/docs/drafts\nfetchedFrom: https://example.com/docs/drafts\nfetchedAt: 2026-11-01T00:00:00Z\nmethod: md\n');
  for (const [dir, files] of [['nothing', { 'demo.json': JSON.stringify({ generator: { name: 'docdemo' }, steps: [] }), 'steps.json': '[]', '.debug/clock.json': '{}' }],
    ['broken', { 'demo.json': '{"generator": {"name": "docdemo"}, "steps": [' }], ['mixed', { 'demo.json': JSON.stringify({ steps: [] }), 'assets/logo.png': 'png' }],
    ['noted', { 'demo.json': JSON.stringify({ steps: [] }), '.debug/clock.json': '{}', '.debug/review-notes.md': 'keep me' }],
    ['shot-dir', { 'demo.json': JSON.stringify({ steps: [] }), 'assets/001.png/x': '' }]]) {
    for (const [f, text] of Object.entries({ 'source.md': ownSource, ...files })) {
      fs.mkdirSync(path.dirname(path.join(work, dir, f)), { recursive: true });
      fs.writeFileSync(path.join(work, dir, f), text);
    }
    check(`doc in a folder with ${{ nothing: 'a run that recorded nothing', broken: 'a demo.json that does not parse', mixed: 'a file DocDemo did not name in assets/',
      noted: 'a file DocDemo did not write in .debug/', 'shot-dir': 'a folder named like a screenshot' }[dir]}`,
      H('doc', '--out', dir, '--url', `${APP}docs/anchor#get-going`));
  }
  const prev = d => fs.readdirSync(work).filter(x => x.startsWith(`${d}.prev-`));
  expect('a run that recorded nothing is cleared, not kept', !prev('nothing').length && !fs.existsSync(path.join(work, 'nothing/steps.json')));
  expect('a demo.json that does not parse is kept', prev('broken').length === 1 && fs.existsSync(path.join(work, prev('broken')[0], 'demo.json')));
  expect('a file in assets/ that DocDemo did not name is kept', prev('mixed').length === 1 && fs.existsSync(path.join(work, prev('mixed')[0], 'assets/logo.png')));
  expect('a file DocDemo did not write in .debug/, or a folder in assets/, is kept', prev('noted').length === 1 &&
    fs.readFileSync(path.join(work, prev('noted')[0], '.debug/review-notes.md'), 'utf8') === 'keep me' && prev('shot-dir').length === 1);

  // claims beyond the steps: sentences that are not steps, checked after "done" with evidence frames readers never get
  fs.mkdirSync(path.join(work, 'claims'));
  fs.writeFileSync(path.join(work, 'claims/source.md'), `---\nurl: https://example.com/docs/ping\n---\n
# Ping the server

1. Click **Ping**.

The status line then reads Pinged. Pinging twice changes nothing. Saving a draft keeps it. Pings are logged for a week.
Ping is the first button.
`);
  fs.writeFileSync(path.join(work, 'claims-steps.json'), JSON.stringify([{ index: 1, text: 'Click **Ping**.', kind: 'action' }]));
  const C = (...a) => H(...a, '--out', 'claims');
  const claimsDemo = () => JSON.parse(fs.readFileSync(path.join(work, 'claims/demo.json'), 'utf8'));
  snap = C('init', '--title', 'Ping', '--doc-url', 'https://example.com/docs/ping', '--app-url', APP, '--steps', 'claims-steps.json', '--open').stdout;
  const notYet = check('done refuses while a documented step has no frame', C('done'), 6);
  expect('and records nothing, so the step can still be recorded', notYet.stderr.includes('doc step 1 (action) has no frame') && claimsDemo().steps.length === 0);
  check('act (claims demo)', C('act', '--doc-step', '1', '--instruction', 'Click Ping', '--expect', 'Ping', '--ref', ref(snap, 'button "Ping"'), 'click'));
  check('claim refuses text that is not in the doc', C('claim', '--quote', 'The status line turns green.'), 6);
  const claimed = check('claim records sentences of the doc', C('claim', '--quote', 'The status line then reads Pinged.', '--quote', 'Pinging twice changes nothing.'));
  expect('claim prints their ids', claimed.stdout.includes('claim c1: "The status line then reads Pinged."') && claimed.stdout.includes('claim c2:'));
  check('claim refuses a claim it already has', C('claim', '--quote', 'Pinging twice changes nothing.'), 6);
  check('claim records more', C('claim', '--quote', 'Saving a draft keeps it.', '--quote', 'Pings are logged for a week.'));
  check('an evidence frame waits for the final frame', C('note', '--evidence', 'c1', '--instruction', 'The status line'), 1);
  const early = check('finish refuses while a claim has no verdict', C('finish'), 6);
  expect('and records no final frame', early.stderr.includes('claim c1 ("The status line then reads Pinged.") has no verdict') &&
    claimsDemo().steps.length === 1);
  check('done (claims demo)', C('done', '--instruction', 'The status line reads Pinged'));
  const ev1 = check('note --evidence records an evidence frame', C('note', '--evidence', 'c1', '--instruction', 'The status line reads Pinged'));
  evalPage("() => fetch('/api/late', { method: 'POST' }).then(r => r.status)"); // fails between two captures, after E1
  const ev2 = check('act --evidence acts and records one', C('act', '--evidence', 'c2', '--instruction', 'Click Ping again', '--expect', 'Ping',
    '--ref', ref(ev1.stdout, 'button "Ping"'), 'click'));
  const ev3 = check('note --evidence records the result', C('note', '--evidence', 'c2', '--instruction', 'The status line after a second ping'));
  check('act --evidence on an action the app fails', C('act', '--evidence', 'c3', '--instruction', 'Click Save draft', '--expect', 'Save draft',
    '--ref', ref(ev3.stdout, 'button "Save draft"'), 'click'));
  evalPage("() => fetch('/api/late', { method: 'POST' }).then(r => r.status)"); // fails, and then the next capture fails too
  const failedEv = C('act', '--evidence', 'c4', '--instruction', 'Click the log', '--ref', 'e9999', 'click');
  expect('a failed evidence capture leaves the errors that came before it with the capture before, since no capture may follow',
    failedEv.status === 2 && claimsDemo().claims[2].evidence.at(-1).http?.some(e => e.status === 502) && !claimsDemo().claims[3].evidence.length &&
    !claimsDemo().claims[3].http);
  evalPage("() => Promise.all([...Array(21).keys()].map(n => fetch('/api/fail?n=' + n, { method: 'POST' }))).then(() => 21)");
  const mismatched = C('act', '--evidence', 'c4', '--instruction', 'Click the log', '--expect', 'Log', '--ref', ref(failedEv.stdout, 'button "Ping"'), 'click');
  const e4 = claimsDemo().claims[2].evidence.at(-1);
  expect('a capture that finds another element keeps the errors that came before it, and counts the ones it could not keep',
    mismatched.status === 4 && e4.http.filter(e => e.url.includes('/api/fail')).length === 20 && e4.httpNotKept === 1 && !claimsDemo().claims[3].evidence.length);
  // a capture that throws part-way (its screenshot cannot be written) still keeps the errors that came before it
  evalPage("() => fetch('/api/fail?n=thrown', { method: 'POST' }).then(r => r.status)");
  fs.chmodSync(path.join(work, 'claims/evidence'), 0o555);
  const thrown = C('note', '--evidence', 'c4', '--instruction', 'The log');
  fs.chmodSync(path.join(work, 'claims/evidence'), 0o755);
  expect('a capture that throws part-way keeps the errors that came before it', thrown.status === 5 &&
    claimsDemo().claims[2].evidence.at(-1).http.some(e => e.url.includes('/api/fail?n=thrown')) && !claimsDemo().claims[3].evidence.length);
  const cd = claimsDemo();
  expect('evidence frames are numbered apart from the demo\'s frames, with screenshots in evidence/', ev1.stdout.includes('ok evidence E1 for claim c1 (note) evidence/e01.webp') &&
    ev2.stdout.includes('ok evidence E2 for claim c2 (act)') && ['e01', 'e02', 'e03', 'e04'].every(n => fs.existsSync(path.join(work, `claims/evidence/${n}.webp`))) &&
    fs.readdirSync(path.join(work, 'claims/assets')).length === 2 && cd.steps.length === 2 && cd.claims[1].evidence[0].action.kind === 'click');
  expect('an HTTP error between two evidence frames goes with the one before, not the next claim', ev2.stdout.includes('Since the previous capture') &&
    cd.claims[0].evidence[0].http?.some(e => e.status === 502) && !cd.claims[1].evidence.some(e => e.http?.length) &&
    cd.claims[2].evidence[0].http?.some(e => e.status === 500));
  check('an evidence frame is not a doc step', C('note', '--evidence', 'c1', '--doc-step', '1', '--instruction', 'x'), 1);
  check('check refuses a frame the claim does not have', C('check', '--claim-id', 'c1', '--verdict', 'ok', '--note', 'Reads Pinged', '--frames', 'E2'), 1);
  check('check refuses a doc verdict without "doc says"', C('check', '--claim-id', 'c2', '--verdict', 'doc', '--note', 'It changed'), 1);
  check('check refuses an ok verdict with no evidence', C('check', '--claim-id', 'c4', '--verdict', 'ok', '--note', 'Logged'), 1);
  check('check refuses a batch with an unknown claim', C('check', '--claim-id', 'c1', '--verdict', 'ok', '--note', 'Reads Pinged', '--claim-id', 'c9', '--verdict', 'ok', '--note', 'x'), 1);
  expect('and records none of it', claimsDemo().claims.every(c => !c.verdict));
  const verdicts = check('check records verdicts on claims', C('check', '--claim-id', 'c1', '--verdict', 'ok', '--note', 'The status line reads Pinged',
    '--claim-id', 'c2', '--verdict', 'unverified', '--note', 'A second ping shows nothing new to compare', '--frames', 'E3,2',
    '--claim-id', 'c3', '--verdict', 'unverified', '--note', 'Saving failed with HTTP 500',
    '--claim-id', 'c4', '--verdict', 'unverified', '--note', 'Nothing in the app shows how long pings are kept'));
  expect('the verdicts rest on the evidence frames, or the ones given', verdicts.stdout.includes('ok for claim c1 (frames E1)') &&
    verdicts.stdout.includes('unverified for claim c2 (frames E3, 2)') && verdicts.stdout.includes('unverified for claim c3 (frames E4)') &&
    verdicts.stdout.includes('unverified for claim c4;') && verdicts.stdout.includes('every claim has a verdict'));
  const claimsBuilt = check('finish (claims demo)', C('finish'));
  expect('finish lists the errors the app returned while claims were checked', claimsBuilt.stdout.includes('product error (claim c3): E4: HTTP 500 Internal Server Error: POST /api/save') &&
    claimsBuilt.stdout.includes('product error (claim c3): E4: HTTP 502') && claimsBuilt.stdout.includes('the product returned errors while 2 claim(s) were checked'));
  const claimsReport = fs.readFileSync(path.join(work, 'claims/report.md'), 'utf8');
  expect('report.md counts the errors a failed capture could not keep', claimsReport.includes('E4: and 1 more server error(s) or failed request(s), not kept'));
  expect('report.md lists the claims with their evidence', claimsReport.includes('## Claims beyond the steps (4)') &&
    claimsReport.includes('- **Matches the doc:** "The status line then reads Pinged."') &&
    claimsReport.includes('E1 "The status line reads Pinged" ([screenshot](evidence/e01.webp))') &&
    claimsReport.includes('[screen 2](review.html#2)') && claimsReport.includes('  - The product returned an error at E4: HTTP 500') &&
    claimsReport.includes('  - The product returned an error at E1: HTTP 502') && claimsReport.indexOf('Matches the doc') < claimsReport.indexOf('Not verified') &&
    claimsReport.includes('claims beyond the steps: 1 matches the doc, 3 not verified') && claimsReport.includes('The product returned errors while 2 claim(s) were checked.'));
  const readerCopy = fs.readFileSync(path.join(work, 'claims/index.html'), 'utf8');
  expect('the reader copy has no claims or evidence', !readerCopy.includes('Pinging twice') && !readerCopy.includes('evidence/'));
  check('open (claims demo, to view review.html)', C('open'));
  run('playwright-cli', [`-s=${SESSION}`, 'goto', `${APP}out/claims/review.html#end`]);
  await new Promise(res => setTimeout(res, 300));
  // c3's evidence frame holds two server errors of its own, the 20 of the 21 that a failed capture kept, the count of the one it
  // did not, and the one before the capture that threw
  expect('review.html lists the claims on its last screen, with the errors found while checking them', JSON.parse(evalPage(
    "() => JSON.stringify([...document.querySelectorAll('#endClaims .claim')].map(c => [c.querySelector('strong').textContent, c.querySelectorAll('img').length, " +
    "c.querySelectorAll('button').length, [...c.querySelectorAll('strong')].filter(s => s.textContent.startsWith('Product error')).length]))")) ===
    JSON.stringify([['Matches the doc: ', 1, 0, 1], ['Not verified: ', 1, 1, 0], ['Not verified: ', 1, 0, 24], ['Not verified: ', 0, 0, 0]]));
  expect('a screen a claim cites opens from there', JSON.parse(evalPage("() => { document.querySelector('#endClaims .claim button').click(); return location.hash; }")) === '#2');
  C('close');
  check('a claim\'s verdict can be corrected', C('check', '--claim-id', 'c2', '--verdict', 'doc', '--note', 'doc says nothing changes; UI shows Pinged again', '--frames', 'E3'));
  const rebuilt = check('build (corrected claim)', C('build'));
  const correctedReport = fs.readFileSync(path.join(work, 'claims/report.md'), 'utf8');
  expect('a claim the doc gets wrong counts as a place where the doc and the product disagree', rebuilt.stdout.includes('1 place(s) where the doc and the product disagree') &&
    rebuilt.stdout.includes('claim c2, doc mismatch ("Pinging twice changes nothing."): doc says nothing changes') &&
    correctedReport.indexOf('Doc mismatch') < correctedReport.indexOf('Matches the doc'));
  check('claim refuses a verdict at once without the frames it rests on', C('claim', '--quote', 'Ping is the first button.', '--verdict', 'ok', '--note', 'It is'), 6);
  const atOnce = check('claim takes its verdict at once when a recorded frame shows it', C('claim', '--quote', 'Ping is the first button.',
    '--verdict', 'ok', '--note', 'Ping is the first button on the page', '--frames', '1'));
  check('build (a claim answered at once)', C('build'));
  expect('and report.md lists it with the frame', atOnce.stdout.includes('claim c5: "Ping is the first button.": ok (frames 1)') &&
    fs.readFileSync(path.join(work, 'claims/report.md'), 'utf8').includes('- **Matches the doc:** "Ping is the first button."\n  - Ping is the first button on the page\n  - Evidence: [screen 1](review.html#1)'));
  const claimsJson = fs.readFileSync(path.join(work, 'claims/demo.json'), 'utf8');
  const withClaims = (f, code, name) => {
    const d = JSON.parse(claimsJson);
    f(d);
    fs.writeFileSync(path.join(work, 'claims/demo.json'), JSON.stringify(d));
    check(name, C('build'), code);
  };
  withClaims(d => { d.claims[0].quote = 'The status line turns green.'; }, 6, 'build refuses a claim that is not a quote of the doc');
  withClaims(d => { d.claims = {}; }, 6, 'build refuses claims that are not a list, without crashing');
  withClaims(d => { d.claims = [null]; }, 6, 'build refuses a claim that is not an object');
  withClaims(d => { d.claims[0].note = ''; }, 6, 'build refuses a verdict without a note');
  withClaims(d => { d.claims[0].frames = []; d.claims[0].evidence = []; }, 6, 'build refuses an ok verdict without evidence');
  withClaims(d => { d.claims[0].evidence[0].http = {}; }, 6, 'build refuses evidence whose errors are not a list, without crashing');
  withClaims(d => { d.claims[0].evidence[0].http = [null]; }, 6, 'build refuses evidence with an error that is not one, without crashing');
  withClaims(d => { d.steps[0].http = [{ url: '/api/save' }]; }, 6, 'build refuses a frame with an error that has no method or status');
  withClaims(d => { d.claims[0].quote = ' '; }, 6, 'build refuses an empty quote');
  withClaims(d => { d.claims[0].quote = '<!-- note -->'; }, 6, 'build refuses a quote that is only a comment');
  fs.writeFileSync(path.join(work, 'claims/demo.json'), claimsJson);
  check('doc in a folder with claims', H('doc', '--out', 'claims', '--url', `${APP}docs/anchor#get-going`));
  const claimsKept = fs.readdirSync(work).find(d => d.startsWith('claims.prev-'));
  expect('the evidence is kept with the demo', claimsKept && fs.existsSync(path.join(work, claimsKept, 'evidence/e04.webp')));

  // a file that is not JSON (a .env) is refused without quoting it
  fs.mkdirSync(path.join(work, 'leak'));
  fs.writeFileSync(path.join(work, 'leak/source.md'), fs.readFileSync(path.join(work, 'demo/source.md')));
  fs.writeFileSync(path.join(work, 'leak/not-json'), 'SECRET_TOKEN=abc123\n');
  const leak = check('init refuses a steps file that is not JSON', H('init', '--out', 'leak', '--title', 'x', '--doc-url', 'https://example.com/docs/notes',
    '--app-url', APP, '--steps', 'leak/not-json'), 6);
  expect('the refusal does not quote the file', !/abc123|SECRET/.test(leak.stdout + leak.stderr));

  // build rejects tampered demo.json
  const bad = structuredClone(demo);
  bad.steps[0].status = 'error';
  bad.steps[1].image = '../elsewhere.png';
  fs.writeFileSync(path.join(work, 'demo/demo.json'), JSON.stringify(bad));
  check('build rejects a bad status and an image outside assets/', H('build'), 6);
  const badDrag = structuredClone(dragDemo);
  delete badDrag.steps[1].action.to;
  fs.writeFileSync(path.join(work, 'drag/demo.json'), JSON.stringify(badDrag));
  check('build rejects a drag without an end', H('build', '--out', 'drag'), 6);
  const badNote = structuredClone(demo);
  badNote.steps[0].note = { text: 'doc says Add' };
  badNote.checks = [{ claim: 'Add note', verdict: 'doc', docStep: 1 }];
  fs.writeFileSync(path.join(work, 'demo/demo.json'), JSON.stringify(badNote));
  const badNoteRun = check('build rejects a note that is not text, and a verdict without a note', H('build'), 6);
  expect('it says where, instead of failing on them while building', badNoteRun.stderr.includes('frame 1: note must be text') &&
    badNoteRun.stderr.includes('check on "Add note" has a bad verdict, doc step or note') && !badNoteRun.stderr.includes('unexpected error'));
  fs.writeFileSync(path.join(work, 'demo/demo.json'), JSON.stringify(demo));

  // a sign-in page is reported when a run opens the app
  fs.mkdirSync(path.join(work, 'signin'));
  fs.copyFileSync(path.join(work, 'demo/source.md'), path.join(work, 'signin/source.md'));
  check('init (app behind a sign-in page)', H('init', '--title', 'Add a note', '--doc-url', 'https://example.com/docs/notes',
    '--app-url', `${APP}login`, '--steps', 'demo/steps.json', '--out', 'signin'));
  const opened = check('open shows the sign-in page', H('open', '--out', 'signin'));
  expect('open reports SIGN-IN and points to login', /SIGN-IN:[^\n]*no saved session/.test(opened.stdout) && opened.stdout.includes(`login --url ${APP}login`));

  // a password field in a settings form, in an app with navigation, is not a sign-in page
  fs.mkdirSync(path.join(work, 'settings'));
  fs.copyFileSync(path.join(work, 'demo/source.md'), path.join(work, 'settings/source.md'));
  check('init (a settings page with a password field)', H('init', '--title', 'Add a note', '--doc-url', 'https://example.com/docs/notes',
    '--app-url', `${APP}settings`, '--steps', 'demo/steps.json', '--out', 'settings'));
  const settingsOpened = check('open the settings page', H('open', '--out', 'settings'));
  expect('open does not call it a sign-in page', !settingsOpened.stdout.includes('SIGN-IN') && settingsOpened.stdout.includes('textbox "Password"'));

  fs.mkdirSync(path.join(work, 'settings-plain'));
  fs.copyFileSync(path.join(work, 'demo/source.md'), path.join(work, 'settings-plain/source.md'));
  check('init (a settings form with a password, on a page without navigation)', H('init', '--title', 'Add a note', '--doc-url', 'https://example.com/docs/notes',
    '--app-url', `${APP}settings-plain`, '--steps', 'demo/steps.json', '--out', 'settings-plain'));
  const plainOpened = check('open the settings page without navigation', H('open', '--out', 'settings-plain'));
  expect('open does not call a four-field settings form a sign-in page', !plainOpened.stdout.includes('SIGN-IN') && plainOpened.stdout.includes('textbox "Host"'));

  // signin: credentials from ./.env are typed by the helper and never printed or written anywhere else
  fs.writeFileSync(path.join(work, '.env'), 'OTHER=1\nDOCDEMO_USERNAME=demo@example.com\nDOCDEMO_PASSWORD="s3cret-Pa55"  # test account\n');
  const withCreds = check('open with credentials in .env', H('open', '--out', 'signin'));
  expect('open offers signin instead of login', /CREDENTIALS: DOCDEMO_USERNAME \(\.env\), DOCDEMO_PASSWORD \(\.env\)/.test(withCreds.stdout) && !withCreds.stdout.includes('login --url'));
  snap = snapshot();
  const signin = check('signin', H('signin', '--username-ref', ref(snap, 'textbox "Email"'), '--password-ref', ref(snap, 'textbox "Password"'), '--submit-ref', ref(snap, 'button "Sign in"')));
  expect('signin signed in', /Signed in/.test(run('playwright-cli', [`-s=${SESSION}`, 'eval', '() => document.title']).stdout) && !/password field is still visible/.test(signin.stdout));
  const leaked = spawnSync('grep', ['-rl', 's3cret-Pa55', work], { encoding: 'utf8' }).stdout.trim().split('\n').filter(f => f && !f.endsWith('/.env'));
  expect('the password appears in no output and no file but .env', !signin.stdout.includes('s3cret') && !withCreds.stdout.includes('s3cret') && leaked.length === 0);
  const shown = check('get a page that shows the password as text', H('get', '/whoami', '--out', 'signin'));
  expect('the password is hidden in what get prints', shown.stdout.includes('with ***') && !shown.stdout.includes('s3cret'));
  // a failed sign-in leaves no password on the page for a snapshot to show
  check('open the sign-in page again', H('open', '--out', 'signin'));
  fs.writeFileSync(path.join(work, '.env'), 'DOCDEMO_USERNAME=demo@example.com\nDOCDEMO_PASSWORD=wrong-Pa55\n');
  snap = snapshot();
  check('signin refuses to type the password into a text box', H('signin', '--password-ref', ref(snap, 'textbox "Email"'), '--submit-ref', ref(snap, 'button "Sign in"')), 1);
  expect('nothing was typed into the text box', !snapshot().includes('wrong-Pa55'));
  check('signin refuses a password without a submit', H('signin', '--password-ref', ref(snap, 'textbox "Password"')), 1);
  const failed = check('signin with a wrong password', H('signin', '--username-ref', ref(snap, 'textbox "Email"'), '--password-ref', ref(snap, 'textbox "Password"'), '--submit-ref', ref(snap, 'button "Sign in"')));
  expect('a failed signin says so and clears the password', /password field is still visible/.test(failed.stdout) && !snapshot().includes('wrong-Pa55'));
  // a password the page then shows as text (a "show password" button) is cleared too
  check('open the sign-in page for a password shown as text', H('open', '--out', 'signin'));
  fs.writeFileSync(path.join(work, '.env'), 'DOCDEMO_USERNAME=demo@example.com\nDOCDEMO_PASSWORD=shown-Pa55\n');
  snap = snapshot();
  check('signin where the page shows the password as text', H('signin', '--username-ref', ref(snap, 'textbox "Email"'), '--password-ref', ref(snap, 'textbox "Password"'), '--submit-ref', ref(snap, 'button "Sign in"')));
  expect('the password shown as text was cleared', !snapshot().includes('shown-Pa55') &&
    JSON.parse(run('playwright-cli', [`-s=${SESSION}`, '--raw', 'eval', "() => document.querySelector('input[name=pw]').type"]).stdout) === 'text');
  fs.writeFileSync(path.join(work, '.env'), 'DOCDEMO_USERNAME=demo@example.com\nDOCDEMO_PASSWORD=wrong-Pa55\n');
  // the password is cleared even when the submit click fails
  check('open the sign-in page once more', H('open', '--out', 'signin'));
  snap = snapshot();
  const passwordValue = () => run('playwright-cli', [`-s=${SESSION}`, 'eval', "() => document.querySelector('input[type=password]').value"]).stdout;
  check('signin with a submit that cannot be clicked', H('signin', '--username-ref', ref(snap, 'textbox "Email"'), '--password-ref', ref(snap, 'textbox "Password"'), '--submit-ref', 'e99999'), 5);
  expect('the password was cleared after the failed click', !passwordValue().includes('wrong-Pa55'));
  // credentials are never typed on another origin (localhost is not 127.0.0.1)
  run('playwright-cli', [`-s=${SESSION}`, 'goto', `http://localhost:${PORT}/login`]);
  snap = snapshot();
  const elsewhere = check('signin refuses a sign-in form on another origin', H('signin', '--username-ref', ref(snap, 'textbox "Email"'), '--password-ref', ref(snap, 'textbox "Password"'), '--submit-ref', ref(snap, 'button "Sign in"')), 1);
  expect('nothing was typed on the other origin', /not on the app's origin/.test(elsewhere.stderr + elsewhere.stdout) &&
    !run('playwright-cli', [`-s=${SESSION}`, 'eval', "() => document.querySelector('input[type=email]').value"]).stdout.includes('demo@example.com') &&
    !passwordValue().includes('wrong-Pa55'));
  // a page whose fields cannot be checked for the password (its own code throws when one is read): the browser
  // is closed rather than left showing what may be the password
  check('open the sign-in page for a field that cannot be checked', H('open', '--out', 'signin'));
  evalPage("() => { Object.defineProperty(document.querySelector('input[type=password]'), 'value', { get() { throw new Error('locked'); }, set() {}, configurable: true }); return 1; }");
  snap = snapshot();
  const unchecked = check('signin where the page cannot be checked', H('signin', '--username-ref', ref(snap, 'textbox "Email"'), '--password-ref', ref(snap, 'textbox "Password"'),
    '--submit-ref', ref(snap, 'button "Sign in"'), '--out', 'signin'), 5);
  expect('signin closes the browser and says so', unchecked.stderr.includes('signin could not clear the password from the page, so the browser was closed') &&
    /is not open/.test(Object.values(run('playwright-cli', [`-s=${SESSION}`, 'snapshot'])).join('')) && !unchecked.stdout.includes('wrong-Pa55'));
  check('signin without the value set fails', spawnSync('node', [HELPER, 'signin', '--password-ref', 'e1'], { cwd: path.join(work, 'signin'), encoding: 'utf8', env: { ...process.env, DOCDEMO_SESSION: SESSION } }), 1);
  fs.rmSync(path.join(work, '.env'));

  // login: a window opens, the user signs in (here: a cookie is set) and closes it; the session is kept
  const env = { ...process.env, DOCDEMO_SESSION: SESSION, DOCDEMO_LOGIN_HEADLESS: '1' };
  const L = (...args) => spawnSync('node', [HELPER, ...args], { cwd: work, encoding: 'utf8', env });
  check('login --save without a window fails', L('login', '--save', '--state', 'auth.json'), 1);
  const tmpBefore = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('docdemo-login-')).length;
  // A shim logs the helper's playwright-cli commands: state-save opens a page per off-tab origin, which blinks.
  const shim = path.join(work, 'shim'), pwLog = path.join(work, 'pw.log');
  fs.mkdirSync(shim);
  const realPw = spawnSync('sh', ['-c', 'command -v playwright-cli'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(shim, 'playwright-cli'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(pwLog)}\nexec ${JSON.stringify(realPw)} "$@"\n`, { mode: 0o755 });
  const waiting = spawn('node', [HELPER, 'login', '--url', `${APP}login`, '--state', 'auth.json'],
    { cwd: work, env: { ...env, PATH: `${shim}${path.delimiter}${env.PATH}` } });
  let loginOut = '';
  waiting.stdout.on('data', d => { loginOut += d; });
  const loginExit = new Promise(res => waiting.on('exit', res));
  const loginSession = [`-s=${SESSION}-login`];
  // Wait until the helper says its window is open (commands sent while it starts can reach another browser).
  for (let i = 0; i < 120 && !loginOut.includes('Waiting for it to be closed'); i++) await new Promise(res => setTimeout(res, 250));
  run('playwright-cli', [...loginSession, 'eval', "() => (document.cookie = 'sid=abc123; path=/', localStorage.setItem('stack', 'yes'))"]);
  await new Promise(res => setTimeout(res, 3000)); // copies are taken about every 1.5 s; wait for several
  // like a stack that sends you to its sign-in site: the first origin is no longer in any tab
  const signInSite = APP.replace('127.0.0.1', 'localhost');
  run('playwright-cli', [...loginSession, 'goto', `${signInSite}login`]);
  run('playwright-cli', [...loginSession, 'eval', "() => localStorage.setItem('site', 'yes')"]);
  await new Promise(res => setTimeout(res, 3000));
  run('playwright-cli', [...loginSession, 'close']); // the user closes the window
  const code = await loginExit;
  expect('login exits when the window is closed', code === 0);
  const auth = JSON.parse(fs.readFileSync(path.join(work, 'auth.json'), 'utf8'));
  expect('the session is saved with its cookie', auth.cookies.some(c => c.name === 'sid' && c.value === 'abc123') && loginOut.includes('1 cookie'));
  const stored = o => auth.origins.find(x => x.origin === o.replace(/\/$/, ''))?.localStorage.map(i => i.name).join();
  expect('the session keeps localStorage of an origin the window left', stored(APP) === 'stack' && stored(signInSite) === 'site');
  const helperCmds = fs.readFileSync(pwLog, 'utf8');
  expect('login waits without state-save (no hidden pages, no blinking)', helperCmds.includes('run-code') && !helperCmds.includes('state-save'));
  expect('the session file is owner-only', (fs.statSync(path.join(work, 'auth.json')).mode & 0o077) === 0);
  expect('login leaves no session copies in the temp folder', fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('docdemo-login-')).length === tmpBefore);

  // macOS: closing the window closes the page but the browser keeps running, and run-code then hands
  // the helper a fresh blank page. That must count as closed, not keep a blank window coming back.
  const closePage = path.join(work, 'close-page.js');
  fs.writeFileSync(closePage, 'async page => { for (const p of page.context().pages()) await p.close(); return "closed"; }');
  const waiting2 = spawn('node', [HELPER, 'login', '--url', `${APP}login`, '--state', 'auth2.json', '--wait', '60'], { cwd: work, env });
  let loginOut2 = '';
  waiting2.stdout.on('data', d => { loginOut2 += d; });
  const loginExit2 = new Promise(res => waiting2.on('exit', res));
  for (let i = 0; i < 120 && !loginOut2.includes('Waiting for it to be closed'); i++) await new Promise(res => setTimeout(res, 250));
  run('playwright-cli', [...loginSession, 'eval', "() => (document.cookie = 'sid=def456; path=/')"]);
  await new Promise(res => setTimeout(res, 2500));
  const t2 = Date.now();
  run('playwright-cli', [...loginSession, '--raw', 'run-code', `--filename=${closePage}`]); // the user closes the window only
  const code2 = await Promise.race([loginExit2, new Promise(res => setTimeout(() => res('timeout'), 20000))]);
  if (code2 === 'timeout') waiting2.kill();
  expect('login exits when only the window closes (browser still running)', code2 === 0 && Date.now() - t2 < 15000);
  const auth2 = fs.existsSync(path.join(work, 'auth2.json')) ? JSON.parse(fs.readFileSync(path.join(work, 'auth2.json'), 'utf8')) : { cookies: [] };
  expect('that session is saved too', auth2.cookies.some(c => c.name === 'sid' && c.value === 'def456'));
  expect('and the login browser is shut down', !/-login:\s*\n\s*- status: open/.test(run('playwright-cli', ['list']).stdout));

  // doc must not clear a folder DocDemo did not create
  fs.mkdirSync(path.join(work, 'mine'));
  fs.writeFileSync(path.join(work, 'mine/notes.txt'), 'keep me');
  check('doc refuses to clear a foreign folder', H('doc', '--out', 'mine', '--url', 'https://grafana.com/docs/grafana/v13.2/visualizations/dashboards/create-manage-playlists/'), 1);
  expect('foreign folder untouched', fs.readFileSync(path.join(work, 'mine/notes.txt'), 'utf8') === 'keep me');
  // a website is index.html and assets/ too: names alone don't make a folder ours
  fs.mkdirSync(path.join(work, 'site/assets'), { recursive: true });
  fs.writeFileSync(path.join(work, 'site/index.html'), '<h1>my site</h1>');
  fs.writeFileSync(path.join(work, 'site/assets/app.css'), 'h1 {}');
  check('doc refuses to clear a website folder', H('doc', '--out', 'site', '--url', 'https://grafana.com/docs/grafana/v13.2/visualizations/dashboards/create-manage-playlists/'), 1);
  expect('website folder untouched', fs.existsSync(path.join(work, 'site/index.html')) && fs.existsSync(path.join(work, 'site/assets/app.css')));
} catch (e) {
  failures++;
  console.error(e);
} finally {
  run('playwright-cli', [`-s=${SESSION}`, 'close']);
  run('playwright-cli', [`-s=${SESSION}-login`, 'close']);
  server.kill();
}

console.log(failures ? `\n${failures} failure(s); workspace kept at ${work}` : `\nall passed (${work})`);
if (!failures) fs.rmSync(work, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
