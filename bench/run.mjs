#!/usr/bin/env node
// Accuracy benchmark: runs the real DocDemo skill (headless Claude Code, default permission mode)
// once per documented procedure, each on a freshly reset app, and writes a summary plus a sheet of
// every reported doc-vs-product mismatch for hand labeling.
//
//   node bench/run.mjs [--app grafana,metabase] [--case <id>] [--limit N] [--repeat N] [--dry-run]
//   node bench/run.mjs --mutants [--app grafana] [--case <case or mutant id>] [--no-controls]
//
// --mutants measures detection instead: each fixtures/<app>/mutants.json entry plants one error in
// the live doc (one find/replace), the edited doc is served from localhost, and the summary scores
// which planted errors were caught. Each mutated case also gets one control run on the unedited doc.
//
// Runs are sequential: the skill always drives the playwright-cli session "dd".

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sameFinding } from '../skills/docdemo/scripts/docdemo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    o[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const apps = opts.app ? String(opts.app).split(',') : null;
const repeat = Number(opts.repeat || 1);
const timeoutMin = Number(opts.timeout || 15);
const runId = String(opts['run-id'] || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
// Run folders live outside the repo: Claude Code treats files inside the plugin's own folder as
// sensitive and blocks the skill from writing there. Only the summary is copied into bench/runs/.
const outRoot = path.resolve(String(opts.out || path.join(os.tmpdir(), 'docdemo-bench', runId)));
const reportRoot = path.join(ROOT, 'bench', 'runs', runId);

// ---------- cases ----------

let cases = [];
for (const app of fs.readdirSync(FIXTURES).sort()) {
  const f = path.join(FIXTURES, app, 'cases.json');
  if (!fs.existsSync(f) || (apps && !apps.includes(app))) continue;
  for (const c of JSON.parse(fs.readFileSync(f, 'utf8'))) cases.push({ ...c, app });
}
// ---------- planted doc errors (--mutants) ----------

const known = {};      // case id -> anchors of steps with real mismatches (not false alarms)
const mutantsById = {};
let docServer = null;  // serves the edited docs; run name -> markdown
const servedDocs = new Map();

if (opts.mutants) {
  const byId = Object.fromEntries(cases.map(c => [c.id, c]));
  const mutated = [];
  for (const app of fs.readdirSync(FIXTURES).sort()) {
    const f = path.join(FIXTURES, app, 'mutants.json');
    if (!fs.existsSync(f) || (apps && !apps.includes(app))) continue;
    const spec = JSON.parse(fs.readFileSync(f, 'utf8'));
    Object.assign(known, spec.known || {});
    for (const m of spec.mutants) {
      if (!byId[m.case]) throw new Error(`${f}: mutant ${m.id} names unknown case ${m.case}`);
      mutated.push({ ...byId[m.case], id: m.id, case: m.case, mutant: m });
      mutantsById[m.id] = m;
    }
  }
  let sel = mutated, extra = [];
  if (opts.case) {
    // <case>-control selects only that case's control run
    const ids = String(opts.case).split(',');
    sel = sel.filter(m => ids.includes(m.id) || ids.includes(m.case));
    extra = ids.filter(i => i.endsWith('-control')).map(i => i.slice(0, -'-control'.length)).filter(i => byId[i]);
  }
  const controls = opts['no-controls'] ? [] : [...new Set([...extra, ...sel.map(m => m.case)])]
    .map(id => ({ ...byId[id], id: `${id}-control`, case: id, mutant: { id: 'control', type: 'control', anchors: [] } }));
  cases = [...controls, ...sel];
}
if (!opts.mutants && opts.case) { const ids = String(opts.case).split(','); cases = cases.filter(c => ids.includes(c.id)); }
if (opts.limit) cases = cases.slice(0, Number(opts.limit));
if (!cases.length) { console.error('no cases selected'); process.exit(1); }

if (opts.mutants) await prepareDocs(cases);

console.log(`${cases.length} case(s) x ${repeat} run(s) -> ${outRoot}`);
if (opts['dry-run']) {
  for (const c of cases) console.log(`  ${c.id}  ${c.mutant ? `[${c.mutant.type}] ` : ''}${c.docUrl}  ${c.appUrl}`);
  process.exit(0);
}

// Fetches each doc once with the skill's own helper, applies each mutant, and checks that every
// find string occurs exactly once, so a doc that changed upstream fails before any run is paid for.
async function prepareDocs(list) {
  const helper = path.join(ROOT, 'skills', 'docdemo', 'scripts', 'docdemo.mjs');
  const originals = {};
  for (const id of new Set(list.map(c => c.case))) {
    const dir = path.join(outRoot, '_docs', id);
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync('node', [helper, 'doc', '--url', list.find(c => c.case === id).docUrl, '--out', dir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`fetching the doc for ${id} failed:\n${(r.stderr || r.stdout).slice(-2000)}`);
    originals[id] = fs.readFileSync(path.join(dir, 'source.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n\n/, '');
  }
  const bad = [];
  for (const c of list) {
    let text = originals[c.case];
    if (c.mutant.find != null) {
      const n = text.split(c.mutant.find).length - 1;
      if (n !== 1) { bad.push(`${c.id}: find string occurs ${n} times in the current doc`); continue; }
      text = text.replace(c.mutant.find, () => c.mutant.replace);
    }
    servedDocs.set(c.id, text);
  }
  if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
  docServer = http.createServer((req, res) => {
    const body = servedDocs.get(decodeURIComponent(req.url.split('/')[1] || ''));
    if (body == null) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end(body);
  });
  await new Promise(r => docServer.listen(0, '127.0.0.1', r));
  const port = docServer.address().port;
  for (const c of list) c.docUrl = `http://127.0.0.1:${port}/${c.id}/index.md${new URL(c.docUrl).hash}`;
}

// ---------- helpers ----------

function sh(script, args = []) {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) throw new Error(`${path.relative(ROOT, script)} failed:\n${(r.stderr || r.stdout).slice(-2000)}`);
  return r.stdout;
}

function runSkill(dir, c) {
  const prompt = `/docdemo:docdemo ${c.docUrl} ${c.appUrl}`;
  // --add-dir lets the session run the plugin's helper even when the user's settings block reads
  // outside the working directory (permissions.blockReadsOutsideWorkingDirectories).
  const args = ['-p', '--plugin-dir', ROOT, '--add-dir', path.join(ROOT, 'skills', 'docdemo'),
    '--permission-mode', 'default', '--output-format', 'stream-json', '--verbose', prompt];
  return new Promise(resolve => {
    const out = fs.openSync(path.join(dir, 'run.jsonl'), 'w');
    const err = fs.openSync(path.join(dir, 'run.err'), 'w');
    const child = spawn('claude', args, { cwd: dir, stdio: ['ignore', out, err] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMin * 60_000);
    const t0 = Date.now();
    child.on('exit', code => {
      clearTimeout(timer);
      fs.closeSync(out); fs.closeSync(err);
      resolve({ code, started: t0, seconds: Math.round((Date.now() - t0) / 1000) });
    });
  });
}

function summarize(dir, c, exec) {
  let final = null, tools = 0;
  for (const line of fs.readFileSync(path.join(dir, 'run.jsonl'), 'utf8').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'assistant') tools += (e.message?.content || []).filter(x => x.type === 'tool_use').length;
    if (e.type === 'result') final = e;
  }
  // Only a demo this run made counts: a folder used again (--run-id, --out) can hold an older run's demo.
  const demoFile = path.join(dir, 'demo', 'demo.json'), indexFile = path.join(dir, 'demo', 'index.html');
  const fresh = file => fs.existsSync(file) && fs.statSync(file).mtimeMs >= exec.started;
  let demo = null;
  try { demo = fresh(demoFile) ? JSON.parse(fs.readFileSync(demoFile, 'utf8')) : null; } catch { /* half-written */ }
  if (demo && !(Date.parse(demo.generatedAt) >= exec.started - 1000)) demo = null;
  const built = Boolean(demo) && fresh(indexFile);
  const r = {
    id: c.id, app: c.app, difficulty: c.difficulty, docUrl: c.docUrl,
    exit: exec.code, seconds: exec.seconds,
    cost: final?.total_cost_usd ?? null, turns: final?.num_turns ?? null, toolCalls: tools,
    denials: (final?.permission_denials || []).map(d => d.tool_input?.command || d.tool_name),
    outcome: !demo ? 'no-demo' : !built ? 'not-built' : demo.status,
    report: final?.result ?? '',
  };
  if (demo) {
    const want = demo.doc.steps.filter(s => s.kind === 'action');
    r.docSteps = want.length;
    r.covered = want.filter(d => demo.steps.some(s => s.docStep === d.index && s.status === 'ok') &&
      !demo.steps.some(s => s.docStep === d.index && s.status === 'failed')).length;
    r.actions = demo.steps.filter(s => s.action && s.status === 'ok').length;
    r.findings = [
      ...demo.steps.filter(s => s.note).map(s => ({
        frame: s.n, docStep: s.docStep, status: s.status, instruction: s.instruction, note: s.note })),
      // findings recorded by answering a check (doc or setup verdicts)
      ...(demo.checks || []).filter(v => v.verdict === 'doc' || v.verdict === 'setup').map(v => ({
        frame: null, docStep: v.docStep, status: 'ok', instruction: `check ${v.kind} "${v.claim}"`, note: v.note })),
      // claims beyond the steps that the doc gets wrong (or that depend on setup): on no step, so always labeled by hand
      ...(demo.claims || []).filter(c => c.verdict === 'doc' || c.verdict === 'setup').map(c => ({
        frame: null, docStep: undefined, claimId: c.id, status: 'ok', instruction: `claim "${c.quote}"`, note: c.note })),
    ].map(f => ({ ...f, docText: f.docStep === undefined && f.instruction.startsWith('claim ') ? f.instruction
      : demo.doc.steps.find(d => d.index === f.docStep)?.text ?? '' }))
      // a finding noted twice on one doc step is labeled once, as report.md lists it once
      .filter((f, i, all) => !all.slice(0, i).some(e => e.docStep === f.docStep && e.claimId === f.claimId && sameFinding(e.note, f.note)));
    r.checks = (demo.checks || []).length;
    r.claims = (demo.claims || []).map(c => `${c.id} ${c.verdict || 'no verdict'}`);
  }
  return r;
}

// ---------- findings ----------

// A mismatch is a note in the skill's "doc says X; UI shows Y" form, or a failed step that neither the
// product itself ("product: ...") nor the way the instance is set up ("setup: ...") caused. Other notes
// (e.g. "Already signed in", "setup: ...", "wording: ...") are informational, as in the report.
const isMismatch = f => (f.status === 'failed' && !/^(?:product|setup):/i.test(f.note)) ||
  (/\bdoc says\b/i.test(f.note) && !/^(?:setup|product|wording):/i.test(f.note));
const norm = t => String(t).replace(/&amp;/g, '&').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const onStep = (f, anchors) => anchors.some(a => norm(f.docText).includes(norm(a)));

// ---------- run ----------

fs.mkdirSync(outRoot, { recursive: true });
const resultsFile = path.join(outRoot, 'results.jsonl');
const results = [];
let currentApp = null;

try {
  for (const c of cases) {
    for (let k = 1; k <= repeat; k++) {
      const name = repeat > 1 ? `${c.id}-r${k}` : c.id;
      const dir = path.join(outRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      process.stdout.write(`${name} ... `);
      let r;
      try {
        if (currentApp && currentApp !== c.app) sh(path.join(FIXTURES, currentApp, 'down.sh'));
        currentApp = c.app;
        sh(path.join(FIXTURES, c.app, 'up.sh'));                  // fresh state for every run
        const auth = path.join(FIXTURES, c.app, 'auth.sh');
        if (fs.existsSync(auth)) sh(auth, [path.join(dir, 'docdemo-auth.json')]);
        const exec = await runSkill(dir, c);
        r = summarize(dir, c, exec);
      } catch (e) {
        r = { id: c.id, app: c.app, outcome: 'harness-error', error: String(e.message || e) };
      }
      r.run = name;
      if (c.mutant) Object.assign(r, { case: c.case, mutant: c.mutant.id, mutantType: c.mutant.type }, score(r, c));
      results.push(r);
      fs.appendFileSync(resultsFile, JSON.stringify(r) + '\n');
      console.log(`${r.outcome}${r.docSteps ? ` ${r.covered}/${r.docSteps}` : ''}${r.cost != null ? ` $${r.cost.toFixed(2)}` : ''}${r.findings?.length ? ` ${r.findings.length} note(s)` : ''}`);
    }
  }
} finally {
  if (currentApp) try { sh(path.join(FIXTURES, currentApp, 'down.sh')); } catch { /* already down */ }
  docServer?.close();
  writeSummary(results);
}

// ---------- scoring planted errors ----------

// caught: a mismatch on a step containing an anchor; noted: only an informational note there;
// missed: nothing there. Other mismatches are "unexpected" unless they are on a known real one.
// A run that made no demo (the harness or the skill failed) is not scored: it says nothing about detection.
function score(r, c) {
  const fs_ = r.findings || [];
  const planted = c.mutant.anchors;
  const detection = c.mutant.type === 'control' || r.outcome === 'harness-error' || r.outcome === 'no-demo' ? null
    : fs_.some(f => isMismatch(f) && onStep(f, planted)) ? 'caught'
    : fs_.some(f => onStep(f, planted)) ? 'noted' : 'missed';
  const unexpected = fs_.filter(f => isMismatch(f) && !onStep(f, planted) && !onStep(f, known[c.case] || []));
  return { detection, unexpected };
}

// ---------- summary ----------

function writeSummary(rs) {
  const n = rs.length;
  const count = o => rs.filter(r => r.outcome === o).length;
  const cost = rs.reduce((a, r) => a + (r.cost || 0), 0);
  const all = rs.flatMap(r => (r.findings || []).map(f => ({ ...f, run: r.run, app: r.app })));
  const findings = all.filter(isMismatch), infos = all.filter(f => !isMismatch(f));
  const lines = [
    `# DocDemo accuracy benchmark: ${runId}`,
    '',
    `${n} runs: ${count('complete')} complete, ${count('partial')} partial (a step could not be performed as documented), ` +
      `${count('no-demo') + count('not-built')} without a demo, ${count('harness-error')} harness errors. ` +
      `Total cost $${cost.toFixed(2)}.`,
    '',
    '| Run | Outcome | Doc steps covered | Actions | Findings | Cost | Time | Permission denials |',
    '|---|---|---|---|---|---|---|---|',
    ...rs.map(r => `| ${r.run} | ${r.outcome} | ${r.docSteps != null ? `${r.covered}/${r.docSteps}` : ''} | ${r.actions ?? ''} | ` +
      `${r.findings?.length ?? ''} | ${r.cost != null ? '$' + r.cost.toFixed(2) : ''} | ${r.seconds ? Math.round(r.seconds / 60) + ' min' : ''} | ${r.denials?.length || ''} |`),
    '',
    '## Findings to label',
    '',
    'For each finding, mark it **real** (the doc and the product really differ), **false** (DocDemo was wrong),',
    'or **agent** (the run went wrong, e.g. it misread the page). Precision = real / (real + false).',
    '',
    '| # | Run | Doc step | Doc says | DocDemo reported | Label |',
    '|---|---|---|---|---|---|',
    ...findings.map((f, i) => `| ${i + 1} | ${f.run} | ${f.docStep ?? ''}${f.status === 'failed' ? ' (failed)' : ''} | ` +
      `${cell(f.docText)} | ${cell(f.note)} | real / false / agent |`),
    '',
    '## Informational notes (not counted)',
    '',
    ...infos.map(f => `- ${f.run}, doc step ${f.docStep ?? ''}: ${cell(f.note)}`),
    '',
    ...(rs.some(r => r.mutant) ? plantedLines(rs) : []),
    '## Runs without a complete demo',
    '',
    ...rs.filter(r => r.outcome !== 'complete').map(r => `- **${r.run}** (${r.outcome}): ${cell(r.error || r.report || '').slice(0, 600)}`),
    '',
  ];
  fs.writeFileSync(path.join(outRoot, 'summary.md'), lines.join('\n'));
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.copyFileSync(path.join(outRoot, 'summary.md'), path.join(reportRoot, 'summary.md'));
  fs.copyFileSync(resultsFile, path.join(reportRoot, 'results.jsonl'));
  console.log(`\n${path.relative(ROOT, path.join(reportRoot, 'summary.md'))}: ${count('complete')}/${n} complete, ${findings.length} mismatches to label, $${cost.toFixed(2)}`);
  console.log(`run folders (demos, transcripts): ${outRoot}`);
}

function plantedLines(rs) {
  const planted = rs.filter(r => r.mutant && r.mutant !== 'control');
  const n = k => planted.filter(r => r.detection === k).length;
  const types = [...new Set(planted.map(r => r.mutantType))];
  const unexpected = rs.flatMap(r => (r.unexpected || []).map(f => ({ ...f, run: r.run })));
  const spec = id => rs.find(r => r.mutant === id);
  return [
    '## Planted doc errors',
    '',
    `${planted.length} planted errors: ${n('caught')} caught, ${n('noted')} noted but not reported as a doc error, ` +
      `${n('missed')} missed, ${planted.filter(r => !r.detection).length} runs failed before scoring. ` +
      `By type: ${types.map(t => `${t} ${planted.filter(r => r.mutantType === t && r.detection === 'caught').length}/${planted.filter(r => r.mutantType === t).length}`).join(', ')}.`,
    '',
    '| Run | Type | Planted error | Result | What DocDemo said on the planted step |',
    '|---|---|---|---|---|',
    ...planted.map(r => {
      const anchors = mutantsById[r.mutant]?.anchors || [];
      const said = (r.findings || []).filter(f => onStep(f, anchors)).map(f => f.note).join(' / ');
      return `| ${r.run} | ${r.mutantType} | ${cell(mutantsById[r.mutant]?.why || '')} | ${r.detection || r.outcome} | ${cell(said)} |`;
    }),
    '',
    `### Unexpected mismatches (${unexpected.length}; label each real / false / agent)`,
    '',
    'Mismatches not on a planted step and not on a known real mismatch. A mismatch on a step next to the',
    'planted one may still be the planted error, reported one step early or late.',
    '',
    ...unexpected.map(f => `- ${f.run}, doc step ${f.docStep ?? ''}: "${cell(f.docText).slice(0, 120)}" -> ${cell(f.note)}`),
    '',
  ];
}

function cell(s) { return String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim(); }
