#!/usr/bin/env node
// DocDemo helper: the deterministic half of DocDemo. Claude (via the skill) decides what to do;
// this script fetches the doc, captures every action, validates the result and builds the player.
// Zero dependencies. Drives the browser through playwright-cli (session "dd").

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.4.0';
const SESSION = process.env.DOCDEMO_SESSION || 'dd'; // the skill always uses dd; override for parallel tooling
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');
const DOC_KINDS = ['action', 'optional', 'reference', 'informational'];
const ACTIONS = ['click', 'fill', 'select', 'check', 'hover', 'drag'];
const EXIT = { OK: 0, USAGE: 1, STALE_REF: 2, NO_BOX: 3, REF_MISMATCH: 4, ACTION_FAILED: 5, VALIDATION: 6 };

class Fail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new Fail(code, message); };

// ---------- args ----------

// opts keeps the last value of each option; seq keeps every option in order, for commands that take
// a group of options more than once (check: --claim, --verdict, --note per claim).
function parseArgs(argv) {
  const opts = {}, pos = [], seq = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; } // everything after -- is positional
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) opts[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
      else opts[k] = true;
      seq.push([k, opts[k]]);
    } else pos.push(a);
  }
  return { opts, pos, seq };
}

const need = (opts, key) => {
  if (opts[key] === undefined || opts[key] === true) fail('USAGE', `missing --${key}`);
  return String(opts[key]);
};

// ---------- files ----------

function readJSON(f) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { fail('USAGE', `cannot read ${f}`); }
  // Only where the error is: V8's message also quotes the start of the file, which may not be JSON at all (.env).
  try { return JSON.parse(text); } catch (e) {
    fail('VALIDATION', `${f} is not valid JSON${e.message.match(/ at position \d+(?: \(line \d+ column \d+\))?/)?.[0] || ''}`);
  }
}
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const pad3 = n => String(n).padStart(3, '0');
// A numeric entity outside Unicode (&#1114112;) stays as written instead of crashing.
const codePoint = (n, asWritten) => { try { return String.fromCodePoint(n); } catch { return asWritten; } };

function paths(opts) {
  const out = path.resolve(String(opts.out || 'demo'));
  return {
    out,
    demo: path.join(out, 'demo.json'),
    source: path.join(out, 'source.md'),
    assets: path.join(out, 'assets'),
    evidence: path.join(out, 'evidence'),
    debug: path.join(out, '.debug'),
  };
}

function loadDemo(p) {
  if (!fs.existsSync(p.demo)) fail('USAGE', `no ${p.demo}; run "docdemo init" first`);
  return readJSON(p.demo);
}

// ---------- playwright-cli ----------

function pw(args, { allowFail = false, session = SESSION } = {}) {
  const r = spawnSync('playwright-cli', [`-s=${session}`, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) fail('USAGE', `cannot run playwright-cli (${r.error.code}). Install it: npm i -g @playwright/cli@0.1.21`);
  if (r.status !== 0 && !allowFail) fail('ACTION_FAILED', (r.stderr || r.stdout).trim().split('\n').slice(0, 8).join('\n'));
  return r;
}

function playwrightVersion() {
  try {
    const bin = spawnSync('which', ['playwright-cli'], { encoding: 'utf8' }).stdout.trim();
    const root = path.dirname(fs.realpathSync(bin));
    const cli = readJSON(path.join(root, 'package.json')).version;
    const core = readJSON(path.join(root, 'node_modules', 'playwright-core', 'package.json')).version;
    return { driver: `@playwright/cli@${cli}`, playwright: core };
  } catch {
    return { driver: '@playwright/cli', playwright: 'unknown' };
  }
}

// Lossy WebP at this quality keeps UI text crisp at about 40% of the PNG size.
const SHOT_QUALITY = 85;
// How long an action first waits for its element. The rest of its 10 s goes to a second try, on the same
// element if it is still there, or on the one that took its place (see captureCode).
const FIRST_TRY = 4000;

// Log lines that mean the action reached the page: it must not be done a second time. (A fill's own line
// comes before it waits for the field, so it says nothing.)
const RAN = /^\s*(?:\w+ action done|selected specified option|navigated to|waiting for scheduled navigations)/m;
// What went wrong with an action, without terminal colors: the first line, and the end of Playwright's call
// log, which says why it waited. Whether the action ran is read from the whole log: a line that says so, or an
// action still being performed when its time ran out (its input reached the page, which kept it from finishing:
// a click that opens a dialog and then keeps the page busy). One that Playwright tried again (another element
// caught its input, or its element left the page) did not run. The capture's page-side code is built with this
// function's own text (and RAN), so the test suite can check it in Node.
const why = e => {
  const [message, ...rest] = String(e?.message || e).replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const log = rest.map(x => x.trim()).filter(x => x.startsWith('- ')).map(x => x.slice(2));
  const performing = log.findLastIndex(x => /^\s*performing \w+ action\s*$/.test(x));
  const cut = performing >= 0 && !log.slice(performing + 1).some(x => /intercepts pointer events\s*$|(?:^\s*|, )retrying\b/.test(x));
  const done = RAN.test(log.join('\n'));
  return { message, log: log.slice(-8).map(x => x.slice(0, 200)), ran: done || cut, ...(!done && cut ? { maybe: true } : {}) };
};

// Page-side capture code. One run-code call: settle, resolve, verify, measure, screenshot, act, settle, and
// the page's snapshot for the agent's next command. It also watches the page's network traffic, as the
// browser's network tab shows it: to wait for the requests an action starts, and to report the ones that
// failed. Errors that arrived after `since` (the end of the previous capture), while the agent was reading
// the page, are reported too; only those from the app's own site (`site`), which are the product's.
// `terms` is false when the doc step has no UI term left to look for, which skips reading the page's text.
// `dialog` says how to answer a browser dialog the action opens: accept (OK) or dismiss (Cancel).
function captureCode({ ref, expect, img, action, value, key, from, to, toRef, since = 0, terms = true, timeout = 10000, site = '', token = '', dialog = 'accept' }) {
  const C = JSON.stringify;
  const acts = Boolean(key || action);
  const dismiss = dialog === 'dismiss';
  const shoot = `await page.screenshot({ path: ${C(img)}, type: 'webp', quality: ${SHOT_QUALITY}, animations: 'disabled', caret: 'hide' });`;
  // Playwright waits until these are possible on their element, so they can be tried again on another one.
  const retryable = Boolean(ref) && ['click', 'fill', 'select', 'check', 'hover'].includes(action);
  // A drag is real mouse input (down, a short move to start it, a stepped move, up), so canvas brushes
  // and native drag and drop both register it. The pauses let charts that track the pointer once per
  // animation frame (uPlot in Grafana) see where the drag starts and ends.
  const perform = key ? `await page.keyboard.press(${C(key)});`
    : action === 'click' ? `await l.click({ timeout: wait });`
    : action === 'fill' ? `if (editor) await fillEditor(${C(value ?? '')}, wait); else await l.fill(${C(value ?? '')}, { timeout: wait });`
    : action === 'select' ? `await l.selectOption(${C(value ?? '')}, { timeout: wait });`
    : action === 'check' ? `await l.check({ timeout: wait });`
    : action === 'hover' ? `await l.hover({ timeout: wait });`
    : action === 'drag' ? `const [a, b] = [drag.from, drag.to], len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      await page.mouse.move(a.x, a.y, { steps: 4 });
      await page.waitForTimeout(150);
      await page.mouse.down();
      await page.waitForTimeout(50);
      await page.mouse.move(a.x + (b.x - a.x) / len * 8, a.y + (b.y - a.y) / len * 8, { steps: 2 });
      for (let i = 1; i <= 12; i++) {
        await page.mouse.move(a.x + (b.x - a.x) * i / 12, a.y + (b.y - a.y) * i / 12, { steps: 2 });
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(150);
      await page.mouse.up();`
    : '';
  return `async page => {
  const t0 = Date.now(), inflight = new Map(), failed = [], ms = {}, dialogs = [];
  const PAGE_LOAD = /^(document|xhr|fetch)$/;
  let asked = 0; // when the page last asked its server for something
  const onRequest = r => { inflight.set(r, Date.now()); if (PAGE_LOAD.test(r.resourceType())) asked = Date.now(); };
  const onFinished = r => inflight.delete(r);
  const onFailed = r => { inflight.delete(r); failed.push({ r, failure: r.failure()?.errorText || 'failed' }); };
  const onResponse = resp => {
    if (resp.status() < 400) return;
    const r = resp.request();
    failed.push({ r, resp, body: PAGE_LOAD.test(r.resourceType()) ? resp.text().catch(() => '') : null });
  };
  // A browser dialog (confirm(), "Leave this page?") stops the page until it is answered. One the action opens is
  // answered as the command says (OK, unless --dialog dismiss), as a reader would to go on, and the agent is told
  // what it said. A capture without an action leaves a dialog to the agent.
  const onDialog = d => {
    dialogs.push({ type: d.type(), message: d.message().replace(/\\s+/g, ' ').trim().slice(0, 300), answer: ${C(dismiss ? 'dismissed' : 'accepted')} });
    d.${dismiss ? 'dismiss' : 'accept'}().catch(() => {});
  };
  page.on('request', onRequest); page.on('requestfinished', onFinished); page.on('requestfailed', onFailed); page.on('response', onResponse);
  ${acts ? "page.on('dialog', onDialog);" : ''}
  // Requests already on their way when the capture began (a query the last action started, or its answer still
  // arriving) are waited for too: a request has ended when it has a responseEnd time.
  for (const r of await page.requests().catch(() => []))
    if (!r.failure() && r.timing().responseEnd < 0 && PAGE_LOAD.test(r.resourceType())) inflight.set(r, r.timing().startTime > 0 ? r.timing().startTime : Date.now());
  const RAN = ${RAN};
  const why = ${why};
  try {
  // Set once the capture can report its HTTP errors, so that one that throws part-way still says which came before.
  let httpSoFar = null;
  const res = await (async () => {
  // Settled: the page's own requests that are on their way have loaded (a request still open after 3 s is a
  // long poll, which never ends), and then the DOM did not change for q ms. A request the page made in that
  // time (a search that starts when the typing stops) is waited for once more. At most cap ms.
  const settle = async (q, cap) => {
    const end = Date.now() + cap;
    await page.waitForLoadState('domcontentloaded', { timeout: cap }).catch(() => {});
    const loading = () => [...inflight].some(([r, at]) => Date.now() - at < 3000 && PAGE_LOAD.test(r.resourceType()));
    for (let round = 0; round < 2 && Date.now() < end; round++) {
      while (loading() && Date.now() < end) await page.waitForTimeout(50);
      const before = asked;
      await page.evaluate(([q, left]) => new Promise(res => {
        let t; const fin = () => { mo.disconnect(); res(); };
        const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(fin, q); });
        mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        t = setTimeout(fin, q); setTimeout(fin, left);
      }), [q, Math.max(q, end - Date.now())]).catch(() => {});
      if (asked === before && !loading()) break;
    }
  };
  // The page was settled when the agent read it; this only lets a late change land before the screenshot.
  await settle(300, 1000);
  ms.before = Date.now() - t0;
  // HTTP errors that arrived since the previous capture ended.
  const gap = [];
  for (const r of ${since ? 'await page.requests().catch(() => [])' : '[]'}) {
    const resp = r.existingResponse?.() || null, failure = r.failure()?.errorText, tm = r.timing();
    const at = tm.startTime + Math.max(0, tm.responseStart);
    if ((resp ? resp.status() >= 400 : failure) && at >= ${Number(since)} && at < t0)
      gap.push({ r, resp, failure, gap: true, body: resp && /^(document|xhr|fetch)$/.test(r.resourceType()) ? resp.text().catch(() => '') : null });
  }
  // The app site's errors, each once, at most 20 with what their responses say: server errors, failed requests
  // and error pages first, so that routine 4xx responses cannot crowd them out. How many more there were is counted.
  const siteOf = ${siteOf};
  const hostOf = ${hostOf};
  const site = ${C(site)};
  let more = 0, moreSerious = 0, moreSeriousGap = 0;
  const report = list => {
    // One error per request (a response that failed and the failure after it are one), then the same error of
    // requests alike once (a URL asked for again), keeping the most serious: an error page over a failed fetch.
    const byRequest = new Map(), alike = new Map();
    for (const e of list) {
      if (/ERR_ABORTED|cancel/i.test(e.failure || '') || (site && siteOf(hostOf(e.r.url())) !== site)) continue;
      const had = byRequest.get(e.r);
      if (!had || (!had.resp && e.resp)) byRequest.set(e.r, e);
    }
    for (const e of byRequest.values()) {
      let nav = false;
      try { nav = e.r.isNavigationRequest() && e.r.frame() === page.mainFrame(); } catch {}
      const id = [e.r.method(), e.r.url(), e.resp ? e.resp.status() : e.failure].join(' ');
      if (!alike.has(id) || (nav && !alike.get(id).nav)) alike.set(id, { ...e, nav });
    }
    const keep = [...alike.values()];
    const grave = e => !e.resp || e.resp.status() >= 500 || e.nav;
    const kept = [...keep.filter(grave), ...keep.filter(e => !grave(e))].slice(0, 20);
    more = keep.length - kept.length;
    // Serious errors not kept, by where they belong: before this capture (the previous frame's) or during it.
    const dropped = keep.filter(e => grave(e) && !kept.includes(e));
    moreSerious = dropped.filter(e => !e.gap).length;
    moreSeriousGap = dropped.filter(e => e.gap).length;
    return Promise.all(kept.map(async e => {
      const nav = e.nav;
      const body = e.body ? await Promise.race([e.body, page.waitForTimeout(1000).then(() => '')]).catch(() => '') : '';
      return { method: e.r.method(), url: e.r.url(), type: e.r.resourceType(), nav, ...(e.gap ? { gap: true } : {}),
        ...(e.resp ? { status: e.resp.status(), statusText: e.resp.statusText() } : { failure: e.failure }),
        ...(body ? { body: String(body).slice(0, 2000) } : {}) };
    }));
  };
  // Everything a reader could see or a screen reader could announce, to check the doc's UI terms: the lines
  // of text, the labels, and the name of each control, tab, heading and option on its own, so a term can be
  // told apart from a longer label that holds it.
  const seen = () => page.evaluate(() => {
    const out = new Set();
    const shown = el => el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0;
    const add = v => { v = (v || '').replace(/\\s+/g, ' ').trim(); if (v && v.length <= 120) out.add(v); };
    // Names first: on a very long page the lines of text are what gets cut.
    let n = 0;
    for (const el of document.querySelectorAll('button,a,label,legend,summary,option,th,h1,h2,h3,h4,h5,h6,input[type=button],input[type=submit],' +
        '[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=treeitem],' +
        '[role=heading],[role=columnheader],[role=checkbox],[role=radio],[role=switch]')) {
      if (++n > 2000) break;
      if (shown(el)) add(el.innerText || el.value);
    }
    // Labels of elements that are on the page, not of hidden ones (a closed menu's items).
    for (const el of document.querySelectorAll('[aria-label],[title],[alt],[placeholder]'))
      if (shown(el)) for (const a of ['aria-label', 'title', 'alt', 'placeholder']) add(el.getAttribute(a));
    for (const el of document.querySelectorAll('[aria-labelledby]'))
      if (shown(el)) add(el.getAttribute('aria-labelledby').split(/\\s+/).map(id => document.getElementById(id)?.innerText || '').join(' '));
    for (const line of (document.body?.innerText || '').split('\\n')) add(line);
    return [...out].slice(0, 5000);
  }).catch(() => []);
  const seenBefore = ${terms ? 'await seen()' : '[]'};
  let box = null, display = null, locator = null, name = null, where = null, options = null, picked = null, drag = null, editor = null, typed = null;
  let l = null, nl = null, retried = false, moved = false, uncertain = null;
  // An element's accessible name or, without one, its visible text or value.
  const NAME = el => {
    const t = s => (s || '').replace(/\\s+/g, ' ').trim();
    const by = el.getAttribute('aria-labelledby');
    return t(el.getAttribute('aria-label')) ||
      (by ? t(by.split(/\\s+/).map(id => document.getElementById(id)?.innerText).join(' ')) : '') ||
      t([...(el.labels || [])].map(x => x.innerText).join(' ')) ||
      t(el.getAttribute('alt')) || t(el.getAttribute('title')) || t(el.getAttribute('placeholder')) ||
      t(el.innerText) || t(el.value);
  };
  // The HTTP errors so far, and how many of them were not kept: every result carries both, a failed capture's too.
  const httpOf = async () => {
    const http = await report([...gap, ...failed]);
    return { http, ...(more ? { httpMore: more } : {}), ...(moreSerious ? { httpMoreSerious: moreSerious } : {}), ...(moreSeriousGap ? { httpMoreSeriousGap: moreSeriousGap } : {}) };
  };
  // A capture that stops before anything ran still says which HTTP errors came before it, so none is lost when no
  // capture follows (after "done", an evidence frame may be the last one).
  const early = async e => ({ ...e, ...await httpOf() });
  httpSoFar = httpOf;
  ${ref ? `
  l = page.locator('aria-ref=' + ${C(ref)});
  if (await l.count() !== 1) return await early({ error: 'STALE_REF' });
  // Every look at the element is bounded: one the app removes in the meantime must not stall the capture.
  const ev = (fn, arg) => l.evaluate(fn, arg, { timeout: 2000 });${action === 'fill' ? `
  const EDITOR = '.monaco-editor, .cm-editor, .CodeMirror, .ace_editor';` : ''}
  // Where the element is once scrolled into view: its box, a box big enough to point at, and where it sits
  // among the page's landmarks. Done again for an element that takes its place before the action.
  const measure = async () => {
    const unscrolled = await l.boundingBox({ timeout: 2000 });
    await l.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    box = await l.boundingBox({ timeout: 2000 });
    if (box && unscrolled && (box.x !== unscrolled.x || box.y !== unscrolled.y)) {
      await page.waitForTimeout(150); // let sticky headers and lazy content follow the scroll
      box = await l.boundingBox({ timeout: 2000 });
    }
    if (!box || box.width * box.height === 0) return false;
    display = box;
    if (box.width < 16 || box.height < 16) {
      display = await ev(el => {
        for (let e = el.parentElement, i = 0; e && i < 5; e = e.parentElement, i++) {
          const r = e.getBoundingClientRect();
          if (r.width >= 16 && r.height >= 16) return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return null;
      }) || { x: box.x + box.width / 2 - 12, y: box.y + box.height / 2 - 12, width: 24, height: 24 };
    }
    // Where the element sits: its role, the landmarks around it, and the other landmarks on the page.
    where = await ev(el => {
      const t = v => (v || '').replace(/\\s+/g, ' ').trim();
      const nameOf = e => t(e.getAttribute('aria-label')) ||
        t((e.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map(id => document.getElementById(id)?.innerText || '').join(' '));
      const IMPLICIT = { NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', HEADER: 'banner', FOOTER: 'contentinfo',
        FORM: 'form', DIALOG: 'dialog', A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', MENU: 'menu', TABLE: 'table' };
      const roleOf = e => e.getAttribute('role') ||
        (e.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button' }[e.type] || 'textbox') : IMPLICIT[e.tagName]) || '';
      const label = e => nameOf(e) ? roleOf(e) + ' "' + nameOf(e) + '"' : roleOf(e);
      const KEEP = /^(navigation|main|complementary|banner|contentinfo|dialog|alertdialog|menu|menubar|tablist|toolbar|tree|listbox|search|form|region)$/;
      const within = [];
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (KEEP.test(roleOf(e))) within.unshift(label(e));
      const elsewhere = [...document.querySelectorAll('nav,header,aside,[role=navigation],[role=banner],[role=complementary],[role=toolbar],[role=tablist],[role=menubar]')]
        .filter(e => !e.contains(el) && e.getBoundingClientRect().width > 0).map(label).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 12);
      return { role: roleOf(el) || el.tagName.toLowerCase(), within, elsewhere };
    });
    return true;
  };
  try {
  name = await ev(NAME);
  // Accept the accessible name or the visible text: models often quote what they see. A link with neither
  // (an icon in a sidebar) can be named by its target, the /url the snapshot shows.
  const text = await ev(el => (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim());
  const href = await ev(el => el.closest('a[href]')?.getAttribute('href') || '');
  const want = ${C(expect || '')}.toLowerCase();
  // Snapshot names can repeat an element's text ("dana dana"), so containment either way counts.
  const same = v => v && (v.toLowerCase().includes(want) || (v.length >= 3 && want.includes(v.toLowerCase())));
  if (want && (name || text || href) && ![name, text, href].some(same))
    return await early({ error: 'REF_MISMATCH', name: name || text || href });${action === 'drag' ? `
  // A text field that still has focus (a query editor after Shift+Enter) loses it on the drag's mousedown,
  // and apps react to that: Grafana runs the query again and redraws the chart under the pointer, which
  // drops the drag. Take the focus away first, as clicking elsewhere would, and let the page finish.
  const blurred = await ev(el => {
    const a = document.activeElement;
    if (!a || a === document.body || el.contains(a)) return false;
    if (!(a.isContentEditable || a.tagName === 'TEXTAREA' ||
      (a.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(a.type)))) return false;
    a.blur();
    return true;
  });
  if (blurred) {
    await settle(300, 4000);
    if (await l.count() !== 1) return await early({ error: 'STALE_REF', message: 'the page redrew when the focused field lost focus; nothing was dragged' });
  }` : ''}
  if (!await measure()) return await early({ error: 'NO_BOX', name });
  nl = await l.normalize();
  locator = nl.toString();${action === 'drag' ? `
  // Both ends in viewport pixels: a point in the element (fractions of its box), and either another
  // point in it or the middle of the drop target. Checked before the screenshot, so nothing has run yet.
  const at = (r, f) => ({ x: r.x + r.width * f[0], y: r.y + r.height * f[1] });
  let end = ${to ? `at(box, ${C(to)})` : 'null'};${toRef ? `
  const t = page.locator('aria-ref=' + ${C(toRef)});
  if (await t.count() !== 1) return await early({ error: 'STALE_REF', message: 'the --to-ref target is not on the page; take a new snapshot' });
  const tb = await t.boundingBox({ timeout: 2000 });
  if (!tb || tb.width * tb.height === 0) return await early({ error: 'NO_BOX', message: 'the --to-ref target has no size on the page' });
  end = at(tb, [0.5, 0.5]);` : ''}
  const vw = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const inView = q => q.x >= 0 && q.y >= 0 && q.x <= vw.width && q.y <= vw.height;
  drag = { from: at(box, ${C(from)}), to: end };
  if (!inView(drag.from) || !inView(drag.to)) return await early({ error: 'NO_BOX', message: 'an end of the drag is outside the visible page; nothing ran' });` : ''}${action === 'select' ? `
  // A native dropdown's choices, so the player can offer the same list to pick from: labels, and
  // { group, options } for an <optgroup> (time zones grouped by region, for example).
  options = await ev(el => {
    if (!(el instanceof HTMLSelectElement) || el.multiple || el.options.length > 500) return null;
    const labels = list => [...list].filter(o => o instanceof HTMLOptionElement && !o.disabled && !o.hidden).map(o => o.label.trim());
    return [...el.children].flatMap(c => c instanceof HTMLOptGroupElement
      ? (c.disabled || !labels(c.children).length ? [] : [{ group: c.label.trim(), options: labels(c.children) }])
      : labels([c]));
  }).catch(() => null);` : ''}${action === 'fill' ? `
  // Code editors (Monaco, CodeMirror, Ace) keep their text in a model of their own, behind a hidden
  // textarea: fill() types into that, which adds to the text (Kibana's ES|QL box) or lets the editor close
  // a bracket a second time (Grafana's query box). Select everything as a person would, paste the value
  // over it, and read back what the editor holds; if that is not the value, the editor's own API sets it.
  editor = await ev((el, sel) => el.closest(sel)?.className.match(/monaco-editor|cm-editor|CodeMirror|ace_editor/)?.[0] || null, EDITOR);` : ''}
  } catch (e) {
    // The app replaced or removed the element while it was measured: nothing has run yet.
    if (await l.count().catch(() => 0) !== 1) return await early({ error: 'STALE_REF', message: 'the element left the page before anything ran' });
    throw e;
  }${action === 'fill' ? `
  const editorText = (el, [sel, set]) => {
    const root = el.closest(sel);
    if (!root) return { text: null };
    const content = root.querySelector('.cm-content');
    const cm6 = content && (content.cmView?.rootView?.view || content.cmView?.view);
    const monaco = root.classList.contains('monaco-editor') &&
      window.monaco?.editor?.getEditors?.().find(e => e.getDomNode?.() === root || e.getContainerDomNode?.()?.contains(root));
    const api = root.CodeMirror || root.env?.editor || monaco || null; // CodeMirror 5, Ace, Monaco
    if (typeof set === 'string') {
      if (api?.setValue) api.setValue(set);
      else if (cm6?.dispatch) cm6.dispatch({ changes: { from: 0, to: cm6.state.doc.length, insert: set } });
      else return { text: null };
    }
    if (api?.getValue) return { text: api.getValue() };
    if (cm6?.state) return { text: cm6.state.doc.toString() };
    // No API in reach: the rendered lines, top to bottom (editors render only the lines in view).
    const lines = [...root.querySelectorAll('.view-lines > .view-line, .cm-line, .ace_line')]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return { text: lines.map(x => x.textContent).join('\\n') };
  };
  const fillEditor = async (value, wait) => {
    const norm = s => String(s ?? '').replace(/\\r\\n?/g, '\\n').replace(/\\u00a0/g, ' ').replace(/[ \\t]+$/gm, '').trimEnd();
    await l.focus({ timeout: wait });
    await page.keyboard.press('ControlOrMeta+a');
    const pasted = await page.evaluate(v => {
      const data = new DataTransfer();
      data.setData('text/plain', v);
      const e = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(e);
      return e.defaultPrevented;
    }, value);
    if (!pasted) await page.keyboard.insertText(value);
    await page.waitForTimeout(50);
    let got = await l.evaluate(editorText, [EDITOR, null]).catch(() => ({ text: null })), api = false;
    if (got.text !== null && norm(got.text) !== norm(value)) {
      const set = await l.evaluate(editorText, [EDITOR, value]).catch(() => ({ text: null }));
      if (set.text !== null) { got = set; api = true; }
    }
    typed = { editor, text: got.text, ok: got.text === null ? null : norm(got.text) === norm(value), ...(api ? { api } : {}) };
  };` : ''}` : ''}
  const shot = Date.now();
  ${shoot}
  ms.screenshot = Date.now() - shot;
  const acted = Date.now();
  const act = async wait => { ${perform} };
  const failure = async ({ ran, ...w }) => ({ error: l && await l.count().catch(() => 0) !== 1 ? 'STALE_REF' : 'ACTION_FAILED', ...w, name, ...await httpOf() });${retryable ? `
  // The app can replace the element after the agent read the page (a table re-rendering when a slow query
  // lands): its ref then finds nothing, and the action would wait out its whole time. So the first try is
  // short. Then the action goes on with the same element if it is still there (not ready yet), or with the
  // one that now has its role and name, if there is exactly one. An action that reached the page is never
  // done again.
  let w = null;
  for (let attempt = 1; ; attempt++) {
    const left = ${timeout} - (Date.now() - acted);
    // Playwright reads a timeout of 0 as no timeout at all: with the time used up, the action has failed.
    if (left < 250) return await failure(w || { message: 'the action ran out of time', log: [] });
    w = null;
    if (await l.count().catch(() => 0) !== 1) w = { message: 'the element left the page', log: [] };
    else {
      // A list that recycles its rows can show something else in the same element: act only on what was measured.
      const now = await l.evaluate(NAME, null, { timeout: 1000 }).catch(() => null);
      if (now !== null && now !== name)
        return await early({ error: 'STALE_REF', message: 'the element changed to "' + now.slice(0, 80) + '" before anything ran', name });
      try { await act(attempt === 1 ? Math.min(${FIRST_TRY}, left) : left); break; } catch (e) { w = why(e); }
    }
    if (w.ran) { uncertain = w; break; }
    if (attempt > 1 || left <= ${FIRST_TRY}) return await failure(w);
    if (await l.count().catch(() => 0) === 1) continue;
    const now = await nl.count().catch(() => 0) === 1 ? await nl.evaluate(NAME, null, { timeout: 2000 }).catch(() => null) : null;
    if (now === null || now !== name) return await failure(w);
    l = nl;
    retried = true;
    // The new element can still be hidden for a moment, and can sit elsewhere (a list sorted again): wait for it
    // within the time left, measure it, and take the screenshot again if it moved.
    const was = box;
    await l.waitFor({ state: 'visible', timeout: Math.max(1, ${timeout} - (Date.now() - acted) - 500) }).catch(() => {});
    if (!await measure().catch(() => false))
      return await failure({ ...w, message: 'the page replaced the element, and the one that took its place (same role and name) did not show in time' });
    if (['x', 'y', 'width', 'height'].some(k => Math.abs(box[k] - was[k]) > 1)) { ${shoot} moved = true; }
  }` : `
  try { await act(${timeout}); } catch (e) {
    const w = why(e);
    if (!w.ran) return await failure(w);
    uncertain = w;
  }`}
  ms.action = Date.now() - acted;
  if (options) picked = await l.evaluate(el => {
    const o = el.selectedOptions[0];
    return o ? { label: o.label.trim(), group: o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label.trim() : null } : null;
  }, null, { timeout: 2000 }).catch(() => null);
  const after = Date.now();
  // Typing waits longer for the page to go quiet: a search box asks the server once the typing has stopped.
  ${acts ? `await settle(${action === 'fill' ? 600 : 300}, 4000);` : ''}
  ms.after = Date.now() - after;
  const seenAll = ${terms ? '[...new Set([...seenBefore, ...await seen()])]' : '[]'};
  const net = await httpOf();
  ms.total = Date.now() - t0;
  return { box, display, locator, name, where, options, picked, drag, typed, ...net,
    ...(retried ? { retried } : {}), ...(moved ? { moved } : {}), ...(uncertain ? { uncertain } : {}), ms, ended: Date.now(), seen: seenAll };
  })().catch(async e => ({ error: 'ACTION_FAILED', ...why(e), ...await httpSoFar?.().catch(() => ({})) }));
  // The page as the agent acts on it next, so it needs no snapshot command of its own.
  const snap = Date.now();
  res.snapshot = await page.ariaSnapshot({ mode: 'ai' }).catch(() => '');
  res.title = await page.title().catch(() => '');
  res.url = page.url();
  ms.snapshot = Date.now() - snap;
  if (dialogs.length) res.dialogs = dialogs;
  const json = JSON.stringify(res);
  // A dialog makes playwright-cli answer before this code ends: the helper then picks the result up here.
  page.__docdemo = { token: ${C(token)}, json };
  return json;
  } finally {
    page.off('request', onRequest); page.off('requestfinished', onFinished); page.off('requestfailed', onFailed); page.off('response', onResponse);
    page.off('dialog', onDialog);
  }
}`;
}

// When the last capture (or open, or signin) ended, so the next capture also reports the HTTP errors
// that arrived in between; and the errors of an action that failed, for the frame recorded next.
const clockFile = p => path.join(p.debug, 'clock.json');
function readClock(p) {
  try { return JSON.parse(fs.readFileSync(clockFile(p), 'utf8')); } catch { return {}; }
}
function writeClock(p, ended, pending = [], notKept) {
  fs.mkdirSync(p.debug, { recursive: true });
  writeJSON(clockFile(p), { ended, pending, ...(notKept?.late || notKept?.own ? { notKept } : {}) });
}
// Serious HTTP errors a capture did not keep (it keeps 20): `late` ones came before it, after the previous frame.
const addNotKept = (a = {}, res = {}) => ({ late: (a.late || 0) + (res.httpMoreSeriousGap || 0), own: (a.own || 0) + (res.httpMoreSerious || 0) });

// What `run-code --raw` printed: the code's JSON result, which playwright-cli prints as a JSON string.
function parseResult(stdout) {
  try {
    let v = JSON.parse(String(stdout).trim());
    if (typeof v === 'string') v = JSON.parse(v);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

// Runs page-side code that leaves its result on the page object under `token` as well as returning it.
// A browser dialog makes playwright-cli answer as soon as it opens, before the code ends (a capture answers
// the dialog and goes on): the result is then picked up with a second call, which waits for the code to end.
// A capture ends well within PICK_UP; one that has not by then is `pending`: it may still act.
const PICK_UP = Number(process.env.DOCDEMO_PICK_UP_MS) || 45000; // DOCDEMO_PICK_UP_MS is for the test suite only
function runPageCode(p, name, code, token) {
  const file = path.join(p.debug, `${name}.js`);
  fs.writeFileSync(file, code);
  const r = pw(['--raw', 'run-code', `--filename=${file}`], { allowFail: true });
  let res = parseResult(r.stdout), pending = false;
  if (!res && r.status === 0 && !String(r.stdout).trim()) {
    const pick = path.join(p.debug, 'pick-up.js');
    fs.writeFileSync(pick, `async page => {
  for (let i = 0; i < ${PICK_UP / 100} && page.__docdemo?.token !== ${JSON.stringify(token)}; i++) await page.waitForTimeout(100);
  return page.__docdemo?.token === ${JSON.stringify(token)} ? page.__docdemo.json : JSON.stringify({ pending: true });
}`);
    res = parseResult(pw(['--raw', 'run-code', `--filename=${pick}`], { allowFail: true }).stdout);
    if (res?.pending) { res = null; pending = true; }
  }
  return { r, res, pending };
}

// A frame's screenshot goes in assets/; an evidence frame's (E2) in evidence/, as e02.webp.
function runCapture(p, frameNo, spec, appUrl, { dir = p.assets, name = pad3(frameNo) } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(p.debug, { recursive: true });
  const img = path.join(dir, `${name}.webp`);
  const clock = readClock(p);
  let site = '';
  try { site = siteOf(new URL(appUrl).hostname); } catch {}
  const token = `${name}-${process.pid}-${Date.now()}`;
  const { r, res: got, pending } = runPageCode(p, `capture-${name}`, captureCode({ ...spec, img, since: clock.ended || 0, site, token }), token);
  if (pending) {
    fs.rmSync(img, { force: true });
    printSnapshot();
    fail('ACTION_FAILED', `ACTION_FAILED: the page opened a browser dialog, and the capture had not finished ${PICK_UP / 1000} s later, so ` +
      'nothing was recorded. The action may have run: do not repeat it. Go on from the page as the snapshot above shows it.');
  }
  const res = got || { error: 'ACTION_FAILED', message: (r.stderr || r.stdout).trim().split('\n').slice(0, 6).join('\n') };
  const { seen = [], snapshot, ...logged } = res;
  fs.writeFileSync(path.join(p.debug, `seen-${name}.json`), JSON.stringify(redactValue(seen)));
  fs.appendFileSync(path.join(p.debug, 'actions.jsonl'),
    JSON.stringify(redactValue({ at: new Date().toISOString(), frame: frameNo, spec, result: logged })) + '\n');
  if (res.dialogs) console.log(dialogLines(res.dialogs));
  if (!res.error && !fs.existsSync(img)) Object.assign(res, { error: 'ACTION_FAILED', message: `screenshot was not written to ${img}` });
  if (res.error) {
    fs.rmSync(img, { force: true });
    // The action ran and failed: the server may have failed with it. Its errors go with the next frame.
    const errs = httpErrors(res.http, appUrl);
    if (res.http) writeClock(p, Date.now(), [...(clock.pending || []), ...errs.map(e => spec.claim ? { ...e, claim: spec.claim } : e)], addNotKept(clock.notKept, res));
    const detail = (res.message ? `: ${res.message}` : '') + (res.name ? ` (element is named "${res.name}")` : '');
    // Playwright's call log says why an action waited: not visible, not stable, another element in the way.
    const log = res.log?.length ? `\n${res.log.map(x => `  - ${x}`).join('\n')}` : '';
    if (errs.length) console.log(httpReport(errs, appUrl).join('\n'));
    printPage(res);
    fail(res.error, `${res.error}${detail}${log}`);
  }
  writeClock(p, res.ended || Date.now());
  res.http = [...(clock.pending || []), ...httpErrors(res.http, appUrl)];
  res.notKept = addNotKept(clock.notKept, res);
  return res;
}

const dialogLines = list => list.map(d => `The page opened a browser dialog (${d.type}${d.message ? `: "${d.message}"` : ''}); ` +
  (d.answer === 'dismissed' ? 'DocDemo dismissed it (Cancel), as --dialog dismiss says.' : 'DocDemo accepted it (OK), as a reader would to go on.')).join('\n');

// Long URLs are cut (Grafana keeps whole queries in them); what is left tells links apart.
const cutUrls = s => s.replace(/^(\s*- (?:\/url:|Page URL:) )(.{120}).+$/gm, '$1$2…');

// The page after a command, as `playwright-cli snapshot` prints it, from the snapshot the command's own
// page code took: the agent needs no call of its own to see it.
function printPage({ url = '', title = '', snapshot = '' }, hide = redact) {
  if (!snapshot.includes('[ref=')) return printSnapshot(hide);
  console.log(hide(cutUrls(`\n### Page\n- Page URL: ${url}\n- Page Title: ${title}\n### Snapshot\n\`\`\`yaml\n${snapshot}\n\`\`\``)));
}

// The page now, from `playwright-cli snapshot`: for commands whose page code could not take one.
function printSnapshot(hide = redact) {
  const r = pw(['snapshot'], { allowFail: true });
  const out = String(r.stdout || '').trim();
  // A dialog that opened on its own (not during an act, which answers it) blocks the page and every snapshot.
  const modal = out.match(/### Modal state\n([\s\S]*?)(?:\n###|$)/)?.[1].trim();
  if (modal) return console.log(hide(`\nA browser dialog is open: ${modal.replace(/^- /gm, '')}\n`) +
    `Answer it with playwright-cli -s=${SESSION} dialog-accept (or dialog-dismiss, when the doc says to cancel), then run playwright-cli -s=${SESSION} snapshot.`);
  if (r.status !== 0 || !out.includes('[ref=')) return console.log(`\n(no snapshot; run playwright-cli -s=${SESSION} snapshot)`);
  console.log(hide('\n' + cutUrls(out)));
}

// ---------- HTTP errors ----------

// The app's own site: its requests are the product's, while analytics and CDNs elsewhere are not.
// The last two labels of the host name (three for co.uk-style names); an IP address or localhost as is.
const siteOf = host => /^[\d.]+$|^\[|^[^.]+$/.test(host) ? host
  : host.split('.').slice(/\.(?:co|com|org|net|gov|edu|ac)\.[a-z]{2}$/i.test(host) ? -3 : -2).join('.');
// A URL's host name, lowercased, without the URL class (page-side code has none).
const hostOf = url => (String(url).match(/^[a-z][\w+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i)?.[1] || '').toLowerCase();

// The errors that matter, from what a capture saw on the network: the app site's responses with status
// 400 or more and its requests that failed, other than ones the page itself cancelled.
function httpErrors(list, appUrl) {
  if (!Array.isArray(list) || !list.length) return [];
  let site;
  try { site = siteOf(new URL(appUrl).hostname); } catch { return []; }
  const out = [];
  for (const e of list) {
    let host;
    try { host = new URL(e.url).hostname; } catch { continue; }
    if (siteOf(host) !== site || (!e.failure && !(e.status >= 400)) || /ERR_ABORTED|cancel/i.test(e.failure || '')) continue;
    const entry = { method: e.method, url: hideSecrets(redact(String(e.url).slice(0, 500))), ...(e.status ? { status: e.status, statusText: e.statusText || '' } : { failure: e.failure }),
      type: e.type, ...(e.nav ? { nav: true } : {}), ...(e.gap ? { gap: true } : {}) };
    const message = httpMessage(e.body ?? e.message);
    if (message) entry.message = hideSecrets(redact(message));
    const same = out.find(x => sameHttp(x, entry));
    if (!same) out.push(entry);
    else if (entry.nav) same.nav = true;
  }
  return out;
}

const clip = (v, n = 160) => { v = String(v || '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v; };

// What an error response says, in a line: a JSON API's message, or an HTML error page's title.
function httpMessage(body) {
  const s = String(body || '').trim();
  if (!s) return '';
  try {
    // The first message-like field, nearest the top: APIs nest them ({"results":{"A":{"error":"..."}}}).
    let level = [JSON.parse(s)];
    for (let depth = 0; depth < 5 && level.length; depth++) {
      for (const o of level) if (typeof o === 'string' && depth) return clip(o);
      const next = [];
      for (const o of level.filter(o => o && typeof o === 'object')) {
        for (const k of ['message', 'error', 'detail', 'title', 'reason', 'errors']) if (o[k] !== undefined) next.push(o[k]);
        next.push(...Object.values(o).filter(v => v && typeof v === 'object'));
      }
      level = next;
    }
    return '';
  } catch {}
  const title = s.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '');
  if (title) return clip(decode(title));
  return s.startsWith('<') ? '' : clip(s.split('\n')[0]);
}

// A server error, a request that failed, or an error page in place of the page itself: the product failed.
// A 4xx from an API call alone is often routine (a check for something that is not there).
const serious = e => Boolean(e.failure || e.status >= 500 || e.nav);

function httpLine(e, appUrl) {
  let where = e.url;
  try { const u = new URL(e.url); if (u.origin === new URL(appUrl).origin) where = u.pathname + u.search; } catch {}
  return `${e.status ? `HTTP ${e.status}${e.statusText ? ` ${e.statusText}` : ''}` : `request failed (${e.failure})`}: ` +
    `${e.method} ${clip(where, 150)}${e.message ? ` ("${e.message}")` : ''}`;
}

// What the agent reads after a command: server errors in full, routine-looking 4xx responses in one line.
function httpReport(errs, appUrl, label = 'HTTP errors in the browser\'s network log') {
  if (!errs.length) return [];
  const bad = errs.filter(serious), other = errs.filter(e => !serious(e));
  const out = [];
  if (bad.length) out.push(`${label}:`, ...bad.map(e => `  ${httpLine(e, appUrl)}`),
    'If the page shows an error or the step did not take effect, the product failed: record it (see "Product errors" in the skill).');
  if (other.length) out.push(`${bad.length ? 'Also' : label}: ${other.map(e => httpLine(e, appUrl)).join('; ')} (4xx responses are often routine)`);
  return out;
}

const sameHttp = (x, e) => x.method === e.method && x.url === e.url && x.status === e.status && x.failure === e.failure;
// Two lists of errors as one, each error once; an error page anywhere makes the error serious.
const mergeHttp = (a = [], b = []) => {
  const out = a.map(e => ({ ...e }));
  for (const e of b) {
    const same = out.find(x => sameHttp(x, e));
    if (!same) out.push(e);
    else if (e.nav) same.nav = true;
  }
  return out;
};

// ---------- frames ----------

const round4 = n => Math.round(n * 10000) / 10000;

function toRect(r, vp, padPx = 0) {
  const clamp = (v, max) => Math.min(max, Math.max(0, v));
  const x = clamp(r.x - padPx, vp.width), y = clamp(r.y - padPx, vp.height);
  const x2 = clamp(r.x + r.width + padPx, vp.width), y2 = clamp(r.y + r.height + padPx, vp.height);
  if (x2 <= x || y2 <= y) return null; // entirely outside the viewport
  return { x: round4(x / vp.width), y: round4(y / vp.height), width: round4((x2 - x) / vp.width), height: round4((y2 - y) / vp.height) };
}

// A drag starts at --from in the element (fractions of its box, default the middle) and ends at --to
// in the same element (a sweep, as on a chart) or at the middle of --to-ref (a drop target).
function dragSpec(opts) {
  const frac = (key, dflt) => {
    if (opts[key] === undefined) return dflt;
    const m = String(opts[key]).match(/^\s*([\d.]+)\s*,\s*([\d.]+)\s*$/);
    const xy = m && [Number(m[1]), Number(m[2])];
    if (!xy || !xy.every(v => Number.isFinite(v) && v >= 0 && v <= 1))
      fail('USAGE', `--${key} must be x,y fractions of the element's box between 0 and 1, like 0.2,0.5`);
    return xy;
  };
  const toRef = opts['to-ref'] === undefined ? undefined : need(opts, 'to-ref');
  if (toRef !== undefined && !/^[a-z0-9]+$/i.test(toRef)) fail('USAGE', `--to-ref must look like e123, got "${toRef}"`);
  if ((toRef === undefined) === (opts.to === undefined)) fail('USAGE', 'drag needs --to x,y (a point in the same element) or --to-ref <ref> (the drop target), not both');
  return { from: frac('from', [0.5, 0.5]), ...(toRef ? { toRef } : { to: frac('to') }) };
}

function guardAppend(demo, cmd, docStep) {
  const last = demo.steps.at(-1);
  if (last && last.docStep === undefined) fail('USAGE', 'the demo is finished ("done" was recorded); run "build"');
  if (last && last.status === 'failed' && cmd !== 'done') fail('USAGE', 'a step already failed; only "done" is allowed now');
  if (docStep !== undefined && !Number.isInteger(docStep)) fail('USAGE', '--doc-step must be an integer');
  if (docStep !== undefined && !demo.doc.steps.some(s => s.index === docStep))
    fail('USAGE', `--doc-step ${docStep} is not in steps.json (have ${demo.doc.steps.map(s => s.index).join(', ')})`);
}

// An act's options, checked and put in the form the capture takes.
function actSpec(opts, pos) {
  const dialog = opts.dialog === undefined ? 'accept' : String(opts.dialog);
  if (!['accept', 'dismiss'].includes(dialog)) fail('USAGE', '--dialog must be accept (OK, the default) or dismiss (Cancel)');
  if (opts.key !== undefined) return { key: need(opts, 'key'), dialog };
  const [kind, value] = pos;
  if (!ACTIONS.includes(kind)) fail('USAGE', `action must be one of ${ACTIONS.join('|')} (or use --key)`);
  if ((kind === 'fill' || kind === 'select') && value === undefined) fail('USAGE', `${kind} needs a value`);
  const ref = need(opts, 'ref');
  if (!/^[a-z0-9]+$/i.test(ref)) fail('USAGE', `--ref must look like e123, got "${ref}"`);
  const drag = kind === 'drag' ? dragSpec(opts) : {};
  // A /url cut short in the printed snapshot ends in "…": the part before it is what to match.
  const expect = typeof opts.expect === 'string' ? opts.expect.replace(/…$/, '') : '';
  return { ref, expect, action: kind, value, ...drag, dialog };
}

function frameCommand(cmd, opts, pos, seq = []) {
  const p = paths(opts);
  const demo = loadDemo(p);
  const n = demo.steps.length + 1;
  const docStep = cmd === 'done' ? undefined : Number(need(opts, 'doc-step'));
  guardAppend(demo, cmd, docStep);
  const { answers, note } = claimAnswers(seq);
  if (cmd === 'fail' && !note) fail('USAGE', 'missing --note');
  const step = { n };
  if (docStep !== undefined) step.docStep = docStep;
  step.instruction = cmd === 'done' ? String(opts.instruction || 'Done') : need(opts, 'instruction');
  step.image = `assets/${pad3(n)}.webp`;
  // The command's own options are checked before anything is recorded: a mistyped act records no answers.
  const spec = cmd === 'act' ? actSpec(opts, pos) : {};
  // Answers to the checks of this or earlier steps can come with this command, which saves a turn of their own.
  if (answers.length) answerWith(p, demo, answers, docStep);
  // Nothing can be recorded after "done", so it needs what finish needs: a frame for every documented step
  // and an answer to every check. Claims beyond the steps are checked after it.
  if (cmd === 'done') {
    const errs = unfinished(demo, p, { claims: false });
    if (errs.length) fail('VALIDATION', `${errs.join('\n')}\nThe final frame was not recorded: fix these, then run done again.`);
  }
  if (docStep !== undefined || cmd === 'done') {
    const earlier = checkedSteps(demo).filter(k => cmd === 'done' || k < docStep).flatMap(k => openClaims(p, demo, k).map(c => ({ k, c })));
    if (earlier.length && cmd !== 'fail')
      fail('USAGE', `answer the open checks of earlier steps first${answers.length ? ' (the answers given were recorded)' : ''}:\n` +
        earlier.map(({ k, c }) => `  doc step ${k}: ${c.kind} "${c.text}": ${c.status}`).join('\n') + `\n${CHECK_USAGE}`);
  }
  // The page's text is read for the doc's UI terms only while one of this step's terms is unconfirmed.
  const d = demo.doc.steps.find(s => s.index === docStep);
  const terms = (cmd === 'act' || cmd === 'note') && Boolean(d?.claims?.some(c => c.kind === 'term' && !c.onPage &&
    !(demo.checks || []).some(v => v.docStep === docStep && v.claim.toLowerCase() === c.text.toLowerCase())));

  let res;
  try {
    res = runCapture(p, n, { ...spec, terms }, demo.app.url);
    if (spec.key) step.action = { kind: 'press', value: spec.key };
    else if (cmd === 'act') {
      const vp = demo.app.viewport;
      // A drag's hotspot is where it starts; the element's box still says where the element sits.
      step.hotspot = res.drag ? toRect({ x: res.drag.from.x - 16, y: res.drag.from.y - 16, width: 32, height: 32 }, vp) : toRect(res.display, vp, 4);
      step.box = toRect(res.box, vp) || undefined;
      if (!step.hotspot) {
        fs.rmSync(path.join(p.out, step.image), { force: true });
        writeClock(p, res.ended || Date.now(), res.http, res.notKept); // the action ran: its HTTP errors go with the next frame
        printPage(res);
        fail('NO_BOX', 'NO_BOX (the element was outside the visible page, so there is nothing to point at; the action already ran, so continue from the page as it is now)');
      }
      step.action = { kind: spec.action, ref: spec.ref, ...(spec.value !== undefined ? { value: spec.value } : {}) };
      if (res.drag) {
        const pt = q => ({ x: round4(q.x / vp.width), y: round4(q.y / vp.height) });
        Object.assign(step.action, { from: pt(res.drag.from), to: pt(res.drag.to), ...(spec.toRef ? { toRef: spec.toRef } : {}) });
      }
      if (res.picked && hasOption(res.options, res.picked.label, res.picked.group))
        Object.assign(step.action, { options: res.options, picked: res.picked.label, ...(res.picked.group ? { pickedGroup: res.picked.group } : {}) });
      step.locator = res.locator;
      if (res.where) step.where = { ...res.where, position: position(step.box || step.hotspot) };
    }
  } catch (e) {
    // Answers given with a command that then failed stay recorded: given again, one can match another step's claim.
    if (answers.length && e instanceof Fail) e.message += '\n(The check answers given with this command were recorded: leave them out when you run it again.)';
    throw e;
  }
  step.status = cmd === 'fail' ? 'failed' : 'ok';
  if (typeof note === 'string') step.note = note;
  if (cmd === 'fail') demo.status = 'partial';
  if (res.dialogs) step.dialogs = res.dialogs;
  // An action that ran but did not end cleanly is marked for a person to check, in review.html and report.md.
  if (res.uncertain) step.uncertain = uncertainText(res.uncertain);
  // Serious errors beyond the 20 a capture keeps: counted on the frame they belong to, as the kept ones are.
  const prevFrame = demo.steps.at(-1);
  if (res.notKept.late && prevFrame) prevFrame.httpNotKept = (prevFrame.httpNotKept || 0) + res.notKept.late;
  if (res.notKept.own + (prevFrame ? 0 : res.notKept.late)) step.httpNotKept = res.notKept.own + (prevFrame ? 0 : res.notKept.late);
  // HTTP errors that arrived before this capture began came after the previous frame's action.
  const strip = list => list.map(({ gap, ...e }) => e);
  const late = strip(res.http.filter(e => e.gap)), mine = strip(res.http.filter(e => !e.gap));
  if (late.length) {
    const prev = demo.steps.at(-1);
    if (prev) prev.http = mergeHttp(prev.http, late);
    else demo.openHttp = mergeHttp(demo.openHttp, late);
  }
  if (mine.length) step.http = mine;

  demo.steps.push(step);
  if (docStep !== undefined) recordFoundTerms(p, demo, docStep);
  writeJSON(p.demo, demo);
  const where = step.locator ? ` via ${step.locator}` : '';
  console.log(`ok frame ${n} (${cmd}) ${step.image}${where}`);
  if (res.retried) console.log('The page replaced the element before the action; DocDemo acted on the element that took its place (same role and name)' +
    (res.moved ? ', which sat elsewhere, so the screenshot was taken again.' : '.'));
  if (res.uncertain) console.log(`${uncertainWarning(res.uncertain)} The report asks a person to check this frame.`);
  const earlier = step.note && demo.steps.find(f => f !== step && f.docStep === docStep && f.note && sameFinding(f.note, step.note));
  if (earlier) console.log(`This note repeats the finding on frame ${earlier.n}; the report lists it once. Note each finding once per step.`);
  const lines = [...httpReport(late, demo.app.url, 'Since the previous action, HTTP errors in the browser\'s network log'), ...httpReport(mine, demo.app.url)];
  if (lines.length) console.log(lines.join('\n'));
  if (res.httpMore) console.log(`(${res.httpMore} more HTTP errors from the app's site are not listed)`);
  typedWarning(res);
  if (docStep !== undefined && cmd !== 'fail') printClaims(p, demo, docStep);
  if (cmd === 'act' || cmd === 'note') printPage(res);
  else console.log(`now at ${res.url}`);
}

// ---------- doc ----------

function htmlToText(html) {
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html;
  // Page chrome is dropped, but a <header> inside the extracted article often holds the title.
  const chrome = main === html ? 'script|style|nav|header|footer|aside|noscript|svg|form' : 'script|style|nav|footer|aside|noscript|svg|form';
  const lists = [], cols = []; // numbering for nested <ol>/<ul>, and the column each one's item text starts at
  const headingIds = []; // a heading's id ends its line as {#id}, so a #fragment can name it
  // Code is set aside and put back at the end as written: a <pre> as a fenced block, indented to sit in the list item
  // it is in, and inline code as a code span. Where a list ends, an HTML comment says so, as in Markdown, so two lists
  // side by side stay two. The marks that hold their places carry a random tag, so no text on a page can pass for one.
  const mark = String.fromCharCode(0xe000) + Math.random().toString(36).slice(2), kept = [];
  const keep = (kind, text = '') => `${mark}${kind}${kept.push(text) - 1}${mark}`;
  let s = main
    .replace(new RegExp(`<(${chrome})\\b[\\s\\S]*?<\\/\\1>`, 'gi'), '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => keep('p', code))
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => keep('c', code))
    .replace(/<h([1-6])\b([^>]*)>/gi, (_, n, attrs) => (headingIds.push(attrs.match(/\bid="([^"]+)"/)?.[1]), '\n\n' + '#'.repeat(+n) + ' '))
    .replace(/<\/h[1-6]>/gi, () => { const id = headingIds.shift(); return (id ? ` {#${id}}` : '') + '\n\n'; })
    .replace(new RegExp(`<(\\/?)(ol|ul|li)\\b([^>]*)>|${mark}p\\d+${mark}`, 'gi'), (m, close, tag, attrs) => {
      if (!tag) return `\n\n${' '.repeat(cols[lists.length - 1] || 0)}${m}\n\n`; // a <pre>, in the item it is in
      tag = tag.toLowerCase();
      if (tag !== 'li') {
        if (close) { lists.pop(); return lists.length ? '\n' : `\n\n${keep('e')}\n\n`; }
        lists.push(tag === 'ol' ? Number(attrs.match(/start="?(\d+)/i)?.[1] || 1) : null);
        return '\n';
      }
      if (close) return '';
      const top = lists.length - 1, indent = '   '.repeat(Math.max(0, top));
      const marker = top >= 0 && lists[top] !== null ? `${lists[top]++}. ` : '- ';
      cols[top] = indent.length + marker.length;
      return `\n${indent}${marker}`;
    })
    .replace(/<(strong|b)\b[^>]*>/gi, '**').replace(/<\/(strong|b)>/gi, '**')
    .replace(/<(br|\/p|\/div|\/tr|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–' };
  const ent = t => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === '#' ? codePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1), m) : named[e.toLowerCase()] ?? m);
  const code = c => ent(c.replace(/<br\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''));
  const fenced = (c, indent) => {
    c = code(c).replace(/^\n+|\s+$/g, '');
    const f = '`'.repeat(Math.max(2, ...(c.match(/`+/g) || []).map(r => r.length)) + 1);
    return [f, ...c.split('\n'), f].map(l => indent + l).join('\n');
  };
  const span = c => {
    c = code(c).replace(/\n/g, ' ');
    const f = '`'.repeat(Math.max(0, ...(c.match(/`+/g) || []).map(r => r.length)) + 1);
    return f.length > 1 ? `${f} ${c} ${f}` : `${f}${c}${f}`;
  };
  // Spaces are collapsed outside code; a list item keeps the indent that says how deep it is, and a <pre> the one
  // that puts it in its item.
  return ent(s).split('\n').map(l => { const lead = l.match(/^[ \t]*/)[0]; return lead + l.slice(lead.length).replace(/[ \t]+/g, ' ').replace(/\s+$/, ''); })
    .map(l => /^\s+(\d+\.|-) /.test(l) || l.trimStart().startsWith(`${mark}p`) ? l : l.trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim()
    .replace(new RegExp(`( *)${mark}([pce])(\\d+)${mark}`, 'g'), (_, indent, kind, i) =>
      kind === 'p' ? fenced(kept[i], indent) : indent + (kind === 'c' ? span(kept[i]) : '<!-- -->'));
}

// Every fetch of the doc has a deadline, so a slow doc site cannot stall the run. Fetches that are no
// longer needed are stopped, so the command does not wait for them either.
const DOC_TIMEOUT = 15000, ICON_WAIT = 8000;
const fetching = new Set();
const get = (url, headers) => {
  const ctrl = new AbortController();
  fetching.add(ctrl);
  setTimeout(() => ctrl.abort(new Error(`no answer in ${DOC_TIMEOUT / 1000} s`)), DOC_TIMEOUT).unref();
  return fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
};
const stopFetching = () => { for (const c of fetching) c.abort(); fetching.clear(); };
const isMarkdown = (type, body) => /markdown/i.test(type) || (/text\/plain/i.test(type) && !body.trimStart().startsWith('<'));

async function fetchDoc(url) {
  const u = new URL(url);
  u.hash = '';
  const base = u.toString();
  const candidates = [];
  if (!/\.md$/i.test(u.pathname)) {
    if (u.pathname.endsWith('/')) {
      const v = new URL(base); v.pathname = u.pathname.replace(/\/$/, '') + '.md'; candidates.push(v.toString());
      const w = new URL(base); w.pathname = u.pathname + 'index.md'; candidates.push(w.toString());
    } else {
      const v = new URL(base); v.pathname = u.pathname + '.md'; candidates.push(v.toString());
    }
  }
  const headers = { 'user-agent': `docdemo/${VERSION}`, accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8' };
  // The page itself is asked for at the same time: it is the fallback, and its HTML names the icons.
  const page = get(base, headers).then(async r => ({ r, body: await r.text() })).catch(error => ({ error }));
  // The page's HTML only adds icon names (see iconNames), so markdown waits for it 8 s at most: from
  // the page asked for already, or, if that came back as markdown too, with a request for HTML.
  const md = async (text, from) => {
    let html = null;
    if (/`[\w-]+`/.test(text)) {
      const late = new Promise(res => setTimeout(res, ICON_WAIT, null).unref());
      const pg = await Promise.race([page, late]);
      if (pg?.r?.ok) html = /html/i.test(pg.r.headers.get('content-type') || '') ? pg.body : await Promise.race([pageHtml(base, headers), late]) || null;
    }
    stopFetching();
    return { text, method: 'md', from, icons: html ? iconNames(html) : [], ...(html ? { html } : {}) };
  };
  // The markdown versions are asked for all at once; the first in this order that answers with markdown
  // wins, without waiting for the ones after it.
  const tries = candidates.map(c => get(c, headers).then(async r => {
    const body = await r.text();
    return r.ok && isMarkdown(r.headers.get('content-type') || '', body) ? { body, from: c } : null;
  }).catch(() => null)); // try the next candidate
  for (const t of tries) {
    const hit = await t;
    if (hit) return md(hit.body, hit.from);
  }
  const pg = await page;
  stopFetching();
  if (pg.error) fail('USAGE', `GET ${base} failed: ${pg.error.message}`);
  if (!pg.r.ok) fail('USAGE', `GET ${base} returned ${pg.r.status}`);
  // Some sites answer the page URL itself with markdown (content negotiation), and a .md URL is markdown.
  if (isMarkdown(pg.r.headers.get('content-type') || '', pg.body)) return md(pg.body, base);
  return { text: htmlToText(pg.body), method: 'html', from: base, icons: [], html: pg.body };
}

const pageHtml = (url, headers) => get(url, { ...headers, accept: 'text/html' }).then(r => r.ok ? r.text() : '').catch(() => '');

// Some doc sites (Elastic's) render an inline icon on the page but keep only its name in their markdown,
// as a code span such as `play_filled`. The page's HTML labels each icon, so read the names from there.
const iconNames = html => [...new Set([...html.matchAll(/aria-label="Icon for ([\w-]+)"/g)].map(m => m[1]))].sort();

// The heading a #fragment points at in the page's HTML, for sites whose anchors are not the heading's
// slug and not in their markdown: the heading with that id, the heading just inside or after the element
// with that id or name (Elastic wraps each heading in <div id="get-your-data-in">), or the heading whose
// own link is #fragment.
function fragmentHeading(html, fragment) {
  const id = esc(fragment).replace(/"/g, '');
  const heading = '<h([1-6])\\b[^>]*>([\\s\\S]*?)<\\/h\\1>';
  for (const re of [
    new RegExp(`<h([1-6])\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/h\\1>`, 'i'),
    new RegExp(`\\b(?:id|name)=["']${id}["'][^>]*>(?:\\s*<(?!h[1-6]\\b)[^>]*>)*?\\s*${heading}`, 'i'),
    new RegExp(`<h([1-6])\\b[^>]*>((?:(?!<\\/h[1-6]>)[\\s\\S])*?href=["']#${id}["'](?:(?!<\\/h[1-6]>)[\\s\\S])*?)<\\/h\\1>`, 'i'),
  ]) {
    const m = html.match(re);
    const text = m && decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return null;
}

// The icon names "doc" recorded in source.md's front matter.
const sourceIcons = text =>
  new Set(text.match(/^---\n[\s\S]*?\n---\n/)?.[0].match(/^icons: (.+)$/m)?.[1].split(/,\s*/) || []);

// Readers see the page, where those names are icons: "select `play_filled` **Run**" reads "select **Run**"
// and "the expand icon (`expand`)" reads "the expand icon". Only these two patterns, so a name that is
// also ordinary code elsewhere in the text stays.
const withoutIconNames = (text, icons) => !icons.size ? text :
  text.replace(/ ?\(`([\w-]+)`\)|`([\w-]+)` (?=\*\*|__)/g, (m, a, b) => icons.has(a || b) ? '' : m);

const slug = s => s.toLowerCase().replace(/[*_`[\]()]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

// A heading matches a #fragment by its slug or by an explicit id: GitBook appends
// <a href="#x" id="x"></a>, Hugo and Docusaurus use {#x}.
function headingMatches(line, fragment) {
  const ids = [...line.matchAll(/\bid="([^"]+)"|\{#([^}\s]+)\}/g)].map(m => m[1] || m[2]);
  const title = line.replace(/^#+\s*/, '').replace(/<[^>]*>/g, '').replace(/\{#[^}]*\}/g, '');
  return ids.includes(fragment) || slug(title) === slug(fragment);
}

function section(text, fragment) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^#{1,6}\s/.test(l) && headingMatches(l, fragment));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

// What "doc" printed of source.md: the section the URL's #fragment names (or the heading "doc" found for it
// in the page's HTML), else the whole page. "init --list" reads its lists from the same text.
function printedSection(source) {
  source = source.replace(/\r\n?/g, '\n');
  const m = source.match(/^---\n([\s\S]*?)\n---\n/);
  const front = m?.[1] || '', text = m ? source.slice(m[0].length) : source;
  let fragment = '';
  try { fragment = decodeURIComponent(new URL(front.match(/^url: (.+)$/m)?.[1]).hash.slice(1)); } catch {}
  const heading = front.match(/^heading: (.+)$/m)?.[1];
  return (fragment && (section(text, fragment) || (heading && section(text, heading)))) || text.trim();
}

// The numbered lists in a doc's text, in order: L1, L2, ... Items are numbered as readers see them (a list
// written 1. 1. 1. reads 1, 2, 3), and a list that goes on with the next number after something interrupts it
// (a code block, a table, a paragraph) is the same list. An item's text is its first paragraph. The sub-items
// of an item that offers alternatives ("Do one of the following:") are its alternatives a, b, ...; other
// numbered sub-items are sub-steps. A list in fenced code is code, and a list in a note (> 1.) is not a step.
const NUMBERED = /^(\s*)(\d{1,9})[.)](?:\s+(.*))?$/, BULLET = /^(\s*)[-*+]\s+(.*)$/, FENCE = /^\s*(`{3,}|~{3,})/;
const closesFence = (line, fence) => new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(line);
const PROMISES = /\b(?:one|any|either) of (?:the following|these)\b|\b(?:choose|pick|select) (?:one|either)\b/i;
const OFFERS = new RegExp(`${PROMISES.source}|\\beither\\b[^.]*:$|\\b(?:choose|pick|select) (?:an?|the|your) (?:option|method|way)\\b[^.]*:$`, 'i');
// A sub-item that is an action of its own ("Click **Import**.", "Then enable caching."), under an item that only
// leads into its sub-items ("Do the following:"): the item's text alone would leave the actions out. One that names an
// option or a part of the UI ("**Type** - Selects ...", "`Edit`: ...", "Open: opens a tab", "Search box") or says what
// something is ("Start time is inclusive.") is not. When in doubt it counts as an action: the item is then refused and
// written in steps.json, while one taken for a description would lose its actions.
// Words an action can come after: "Then click", "Optionally, select", "If asked, enter", "Before continuing, click".
const LEAD = /^(?:(?:then|next|now|finally|first|also|optionally|afterwards?|again)\b,?\s*|(?:if|when|whenever|once|after|before|while|until|unless|to|in|on|from|under|at|for|as|with|without|using|by|via|within|depending on|instead of)\b[^,]{0,60},\s*)+/i;
const ACTION = /^(?:click|double-click|right-click|select|choose|pick|enter|type|open|go|navigate|press|tap|check|uncheck|clear|toggle|enable|disable|drag|upload|import|export|download|add|remove|delete|save|fill|set|turn|switch|expand|collapse|scroll|hover|copy|paste|run|start|stop|restart|install|create|edit|rename|search|close|submit|confirm|apply|connect|configure|define|specify|provide|attach|assign|invite|grant|log|sign|write|insert|move)\b/i;
function isAction(t) {
  t = t.trim();
  // A name in bold or code that a label, a description or nothing follows: "**Type** - Selects ...", "`Edit`: ..."
  if (/^(?:\*\*[^*]+\*\*|__[^_]+__|`[^`]+`)(?:\s*$|\s*[:–—.,]|\s+-\s)/.test(t) || /^(?:\*\*|__)[^*_]+:(?:\*\*|__)/.test(t)) return false;
  const s = bare(t).replace(LEAD, '');
  if (!ACTION.test(s)) return false;
  const label = s.match(/^([^:–—]+?)\s*(?:[:–—]|\s-)\s/)?.[1];
  if (label && !/\s/.test(label)) return false; // one word naming an option: "Open: opens a tab"
  // What something is ("Start time is inclusive.", "**Start** and **End** are required."): its verb is lowercase, so
  // "**Click** Show advanced options." is an action, and a bold word after a verb ("Click **Show** ...") is its target.
  const name = '(?:\\*\\*[^*]+\\*\\*|__[^_]+__|`[^`]+`)';
  return !new RegExp(`^(?:${name}(?:\\s*,\\s*${name})*(?:,?\\s+(?:and|or)\\s+${name})?|[A-Za-z][\\w'-]*(?:\\s+[A-Za-z][\\w'-]*)?)\\s+` +
    '(?:is|are|was|were|has|have|can|cannot|will|must|should|shows?|appears?|means|lets?|gives?|returns?|contains?|uses?|includes?)\\b')
    .test(t.replace(LEAD, ''));
}
// Text with f applied outside its code spans: a code span is kept as written (`a  b`), whatever its backticks (`` a ` b ``).
function outsideCode(t, f) {
  let out = '', at = 0;
  for (const m of t.matchAll(/(?<!`)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g)) { out += f(t.slice(at, m.index)) + m[0]; at = m.index + m[0].length; }
  return out + f(t.slice(at));
}
// An item's words as the doc has them: whitespace is collapsed outside code spans only.
const collapse = t => outsideCode(t, s => s.replace(/\s+/g, ' '));
// A doc's text with its HTML comments read as Markdown reads them. One in a fenced block or a code span, or after a
// backslash, is text (a backtick opens a code span only if the same run of backticks closes it in the paragraph). One
// on lines of its own is a block: it is kept as `mark` on one line (a block ends a paragraph, and outside an item a
// list). Any other is left out, and the text around it joined, so what follows it stays part of its paragraph.
function stripComments(text, mark) {
  let out = '', i = 0, fence = null;
  const paraEnd = from => { const r = /\n[ \t]*\n/g; r.lastIndex = from; return r.exec(text)?.index ?? text.length; };
  // Where a code span must close: a blank line, or a line that begins another block (a heading, a fence, a note, a
  // list item, or a comment, unless it closes on that line with text after it).
  const blockEnd = from => {
    const r = /\n(?=[ \t]*(?:\n|$|<!--(?![^\n]*?-->[ \t]*[^\s<])|#{1,6}\s|`{3,}|~{3,}|>|\d{1,9}[.)](?:\s|$)|[-*+]\s))/g;
    r.lastIndex = from;
    return r.exec(text)?.index ?? text.length;
  };
  while (i < text.length) {
    if (i === 0 || text[i - 1] === '\n') {
      const eol = text.indexOf('\n', i), next = eol < 0 ? text.length : eol + 1, line = text.slice(i, next);
      const opens = !fence && (line.match(FENCE) || line.match(/^\s*(?:\d{1,9}[.)]|[-*+])\s+(`{3,}|~{3,})/));
      if (fence || opens) {
        if (opens) fence = opens[1]; else if (closesFence(line, fence)) fence = null;
        out += line; i = next; continue;
      }
    }
    const c = text[i];
    if (c === '\\' && /[!-/:-@[-`{-~]/.test(text[i + 1] || '')) { out += text.slice(i, i + 2); i += 2; continue; }
    if (c === '`') {
      const run = text.slice(i).match(/^`+/)[0], close = new RegExp(`(?<!\`)${run}(?!\`)`, 'g');
      close.lastIndex = i + run.length;
      const m = close.exec(text), to = m && m.index < blockEnd(i) ? m.index + run.length : i + run.length;
      out += text.slice(i, to); i = to; continue;
    }
    if (text.startsWith('<!--', i)) {
      const from = text.lastIndexOf('\n', i - 1) + 1, lead = text.slice(from, i), end = text.indexOf('-->', i + 4);
      const block = !lead.trim();
      // A block comment that never closes goes on to the end of the doc, as in Markdown (not one deep in an item).
      if (end < 0 && block && lead.length <= 3) { out += mark; i = text.length; continue; }
      if (end >= 0 && (block || end < paraEnd(i))) {
        const eol = text.indexOf('\n', end + 3), after = eol < 0 ? text.length : eol;
        // More comments after it on its line keep it a block.
        if (block && !text.slice(end + 3, after).replace(/<!--[\s\S]*?-->/g, '').trim()) { out += mark; i = after; continue; }
        i = end + 3; continue;
      }
    }
    out += c; i++;
  }
  return out;
}
function numberedLists(text) {
  const lists = [];
  const width = s => s.replace(/\t/g, '    ').length;
  // open: the items (and sub-items) a line may still belong to, by the column their content starts at
  let list = null, broken = false, open = [], para = null, fence = null, before = null, heading = '';
  const add = (o, line) => { const t = collapse(line.trim()); o.text = o.text ? `${o.text} ${t}` : t; }; // (a no-break space too)
  // Something inside an item that init --list does not take apart (a list under an alternative or a sub-item, a
  // heading): the alternative it is in, or else the item, is marked, and refused as an action.
  const deep = () => { const at = open[1]?.child || open[0]?.item; if (at) at.deep = true; };
  const within = indent => { while (open.length && indent < open.at(-1).content) open.pop(); return open.length > 0; };
  for (const line of stripComments(text.replace(/\r\n?/g, '\n'), '<!---->').split('\n')) {
    if (fence) { if (closesFence(line, fence)) fence = null; continue; }
    if (!line.trim()) { para = null; continue; }
    const indent = width(line.match(/^\s*/)[0]);
    const inside = () => within(indent);
    // A comment on lines of its own (stripComments left it as <!---->) ends a paragraph, and outside an item the list,
    // as in Markdown (DocDemo writes one where an HTML page's list ends).
    if (/^\s*<!---->\s*$/.test(line)) { para = null; if (!inside()) broken = true; continue; }
    // Indented code (four spaces, not in an item, not going on with a paragraph) is code, even when it is numbered.
    if (indent >= 4 && !para && !inside()) { broken = true; continue; }
    if (/^\s*#{1,6}\s/.test(line) && inside()) { deep(); para = null; continue; } // a heading inside an item
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      list = null; open = []; para = null; before = null;
      heading = bare(line.replace(/^\s*#+\s*/, '').replace(/\s*\{#[^}]*\}\s*$/, '').replace(/\s+#+\s*$/, ''));
      continue;
    }
    const fenced = line.match(FENCE);
    if (fenced) { para = null; if (!inside()) broken = true; fence = fenced[1]; continue; }
    const num = line.match(NUMBERED), bul = !num && line.match(BULLET);
    if (num || bul) {
      while (open.length && indent <= open.at(-1).indent) open.pop();
      const lead = line.match(/^(\s*(?:\d{1,9}[.)]|[-*+]))(\s*)/);
      const content = width(lead[1]) + (lead[2].length > 4 || !lead[2].length ? 1 : lead[2].length);
      const rest = (num ? num[3] : bul[2]) || '';
      if (open.length) { // under an item: an alternative or sub-step of a top-level item, or deeper
        const parent = open.at(-1).item;
        const child = parent ? { numbered: !!num, text: '' } : null;
        if (child) { parent.children.push(child); add(child, rest); } else deep();
        open.push({ indent, content, child });
        para = child;
        continue;
      }
      if (bul) { broken = true; open = [{ indent, content }]; para = null; continue; } // a bulleted list
      const written = num[2];
      const n = list && !broken ? list.last + 1 : Number(written);
      if (!list || (broken && n !== list.last + 1)) {
        const label = before ? `after "${clip(bare(before.text), 60)}"` : heading ? `under "${clip(heading, 60)}"` : '';
        list = { id: `L${lists.length + 1}`, label, items: [] };
        lists.push(list);
      }
      const item = { n, written, text: '', children: [] };
      add(item, rest);
      list.items.push(item);
      list.last = n;
      broken = false;
      before = null;
      open = [{ indent, content, item }];
      para = item;
      continue;
    }
    const block = /^\s*(?:>|\|)/.test(line); // a note or a table row starts its own block
    if (para && !block) { add(para, line); continue; }
    para = null;
    if (inside()) continue; // a later paragraph, note, code or image of an item
    broken = true;
    if (!block) { para = { text: '' }; add(para, line); before = para; }
  }
  for (const l of lists) for (const it of l.items) {
    const offers = it.children.length > 0 && OFFERS.test(bare(it.text));
    it.alts = offers ? it.children.map((c, i) => ({ letter: String.fromCharCode(97 + i), text: c.text, ...(c.deep ? { deep: true } : {}) })) : [];
    if (!offers && it.children.some(c => c.deep)) it.deep = true; // what is nested in a sub-item is nested in the item
    it.substeps = !offers && it.children.some(c => c.numbered);
    it.details = offers ? 0 : it.children.filter(c => !c.numbered).length;
    it.actionBelow = !offers && !it.substeps && /:$/.test(bare(it.text)) ? it.children.find(c => isAction(c.text))?.text : undefined;
    it.noOptions = !it.children.length && PROMISES.test(bare(it.text));
  }
  return lists;
}

// The outline "doc" prints after the text: each list's items as the doc numbers them, for "init --list".
function listOutline(lists) {
  if (!lists.length) return 'No numbered list here: write demo/steps.json and run init with --steps.';
  const out = ['Numbered lists here (init --list <id>):'];
  for (const l of lists) {
    out.push(`${l.id}${l.label ? ` ${l.label}` : ''}`);
    for (const it of l.items) {
      const flag = it.alts.length ? ` [alternatives: --choose ${it.alts.map(a => `${it.n}=${a.letter}`).join(' or ')}]`
        : it.substeps ? ' [numbered sub-steps: to perform it, write steps.json]'
        : it.deep ? ' [lists or headings nested inside: to perform it, write steps.json]'
        : it.actionBelow ? ' [actions listed under it: to perform it, write steps.json]'
        : it.noOptions ? ' [no options listed under it: to perform it, write steps.json]'
        : it.details ? ` [+${it.details} sub-item${it.details > 1 ? 's' : ''}]` : '';
      out.push(`  ${String(it.n).padStart(it.written.length, '0')}. ${clip(it.text, 70) || '(no text)'}${flag}`);
      for (const a of it.alts) out.push(`      ${a.letter}. ${clip(a.text, 70) || '(no text)'}${a.deep ? ' [lists or headings nested inside: to perform it, write steps.json]' : ''}`);
    }
  }
  return out.join('\n');
}

// Files DocDemo itself writes into an output folder. Anything else means the folder is not ours.
const OWN_FILES = new Set(['demo.json', 'source.md', 'steps.json', 'index.html', 'review.html', 'report.md', 'assets', 'evidence', '.debug', '.gitignore', '.playwright-cli']);

// A folder is ours only if DocDemo's own demo.json or source.md is in it: names alone are not enough,
// since any small website is just index.html and assets/.
function isOurOutput(p) {
  try { if (readJSON(p.demo)?.generator?.name === 'docdemo') return true; } catch {}
  try { return /^---\nurl: .*\nfetchedFrom: .*\nfetchedAt: .*\nmethod: /.test(fs.readFileSync(p.source, 'utf8')); } catch { return false; }
}

const stampOf = d => (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

// The files DocDemo and playwright-cli write in .debug/ (and playwright-cli in .playwright-cli/), and amend's
// copies of demo.json in .debug/amend/.
const WORK_FILE = /^(?:actions\.jsonl|cli\.config\.json|clock\.json|(?:capture-(?:\d{3}|e\d{2,})|settle|pick-up|peek|get)\.js|seen-(?:\d{3}|e\d{2,})\.json|(?:page|console)-[\dTZ.:-]+\.(?:yml|log))$/;
const AMEND_FILE = /^demo-\d{8}-\d{6}-frame-\d{3}(?:-\d+)?\.json$/;
const onlyOurs = (dir, files, subdirs = {}) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).every(e => e.isFile() ? files.test(e.name)
      : e.isDirectory() && subdirs[e.name] && onlyOurs(path.join(dir, e.name), subdirs[e.name]));
  } catch { return false; }
};

// Whether an output folder holds only what a run that recorded nothing leaves: the fetched source.md, steps.json,
// a demo.json without frames, screenshots DocDemo named, and DocDemo's and playwright-cli's own work files.
function nothingRecorded(p, demo) {
  try {
    const at = Object.fromEntries(fs.readdirSync(p.out, { withFileTypes: true }).map(e => [e.name, e]));
    if (['index.html', 'review.html', 'report.md', 'evidence'].some(n => at[n])) return false;
    if (!['source.md', 'steps.json', 'demo.json', '.gitignore'].every(n => !at[n] || at[n].isFile())) return false;
    if (at['demo.json'] && !(Array.isArray(demo?.steps) && !demo.steps.length)) return false;
    if (at.assets && !(at.assets.isDirectory() && onlyOurs(p.assets, /^\d{3}\.(?:webp|png)$/))) return false;
    if (at['.debug'] && !(at['.debug'].isDirectory() && onlyOurs(p.debug, WORK_FILE, { amend: AMEND_FILE }))) return false;
    if (at['.playwright-cli'] && !(at['.playwright-cli'].isDirectory() && onlyOurs(path.join(p.out, '.playwright-cli'), WORK_FILE))) return false;
    return true;
  } catch { return false; }
}

// A new run starts in an empty folder. Only what a run that recorded nothing leaves is deleted (see
// nothingRecorded). Anything else is never deleted: a recorded demo (its notes may have been edited by hand), a
// demo.json that does not parse, built pages, a file DocDemo did not write. The folder is moved beside it, to
// <out>.prev-<when it was recorded>. Returns that path.
function clearOutput(p) {
  if (!fs.existsSync(p.out)) return null;
  const entries = fs.readdirSync(p.out);
  if (!entries.length) return null;
  const foreign = entries.filter(f => !OWN_FILES.has(f));
  if (foreign.length || !isOurOutput(p))
    fail('USAGE', `${p.out} exists and was not created by DocDemo` +
      (foreign.length ? ` (it contains ${foreign.slice(0, 3).join(', ')})` : '') + '; pass --out <new folder>');
  let demo = null;
  try { demo = JSON.parse(fs.readFileSync(p.demo, 'utf8')); } catch {}
  if (!nothingRecorded(p, demo)) {
    const stamp = stampOf(new Date(demo?.generatedAt || (fs.existsSync(p.demo) ? fs.statSync(p.demo).mtime : Date.now())));
    let keep = `${p.out}.prev-${stamp}`;
    for (let i = 2; fs.existsSync(keep); i++) keep = `${p.out}.prev-${stamp}-${i}`;
    fs.renameSync(p.out, keep);
    return keep;
  }
  for (const f of entries) fs.rmSync(path.join(p.out, f), { recursive: true, force: true });
  return null;
}

async function docCommand(opts) {
  const p = paths(opts);
  const url = need(opts, 'url');
  const { text, method, from, icons, html } = await fetchDoc(url);
  if (text.trim().length < 200)
    fail('USAGE', `fetched only ${text.trim().length} characters from ${from}. Ask the user to save the page text as ${p.source}, then continue from "init". Do not write that file yourself.`);
  const kept = clearOutput(p);
  fs.mkdirSync(p.out, { recursive: true });
  if (kept) console.log(`kept the previous ${fs.existsSync(path.join(kept, 'demo.json')) ? 'demo' : 'run\'s files'} in ${kept}`);
  const fragment = decodeURIComponent(new URL(url).hash.slice(1));
  let sec = fragment ? section(text, fragment) : null, heading = null;
  // An anchor that is not the heading's own (Elastic's #get-your-data-in for "Step 1: Load sample data"):
  // the page's HTML says which heading it belongs to. source.md keeps it, for "init --list".
  if (fragment && !sec) {
    const pageUrl = new URL(url);
    pageUrl.hash = '';
    const page = html ?? await pageHtml(pageUrl, { 'user-agent': `docdemo/${VERSION}` });
    heading = page && fragmentHeading(page, fragment);
    if (heading) sec = section(text, heading);
  }
  const front = `---\nurl: ${url}\nfetchedFrom: ${from}\nfetchedAt: ${new Date().toISOString()}\nmethod: ${method}\n` +
    (icons.length ? `icons: ${icons.join(', ')}\n` : '') + (heading && sec ? `heading: ${heading}\n` : '') + '---\n\n';
  fs.writeFileSync(p.source, front + text.trim() + '\n');
  console.log(`saved ${p.source} (${method}, ${text.length} chars)`);
  if (fragment && sec) console.log(`\nThe URL points at #${fragment}${heading ? ` (the heading "${heading}")` : ''}. That section:\n\n${sec}`);
  else {
    if (fragment) console.log(`(no heading matched #${fragment}; showing the whole page)`);
    console.log('\n' + text.trim());
  }
  console.log('\n' + listOutline(numberedLists(printedSection(fs.readFileSync(p.source, 'utf8')))));
}

// ---------- citation check ----------

// Real inline HTML tags only, so placeholders like <playlist name> survive.
const INLINE_HTML = /<\/?(?:a|img|br|span|div|p|sup|sub|kbd|em|strong|b|i|u|code|small|mark|del|ins|figure|figcaption|picture|source|svg|path)\b[^>]*>/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: '—', ndash: '–' };
const normalize = s => stripComments(s, ' ')            // HTML comments, which readers do not see (not those in code)
  .replace(INLINE_HTML, ' ')                             // inline HTML such as <img> (before entities are decoded)
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === '#' ? codePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1), m) : ENTITIES[e.toLowerCase()] ?? m)
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                // images
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')            // links keep their text
  .replace(/\\([\\`*_{}[\]()#+\-.!%<>])/g, '$1')
  .replace(/\*\*|__|`/g, '')
  .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,:;!?]|$)/g, '$1$2') // *emphasis*
  .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ')
  .trim().toLowerCase();

function citationErrors(docSteps, sourceText) {
  const hay = normalize(sourceText);
  return docSteps.filter(s => { const n = normalize(s.text); return !n || !hay.includes(n); })
    .map(s => `doc step ${s.index} is not a verbatim quote of source.md: "${s.text.slice(0, 80)}"`);
}

function checkDocSteps(steps) {
  const errs = [];
  if (!Array.isArray(steps) || !steps.length) return ['steps must be a non-empty array'];
  steps.forEach((s, i) => {
    if (!Number.isInteger(s.index) || s.index < 1) errs.push(`steps[${i}].index must be an integer >= 1`);
    if (typeof s.text !== 'string' || !s.text.trim()) errs.push(`steps[${i}].text must be non-empty`);
    if (!DOC_KINDS.includes(s.kind)) errs.push(`steps[${i}].kind must be one of ${DOC_KINDS.join('|')}`);
  });
  if (new Set(steps.map(s => s.index)).size !== steps.length) errs.push('doc step indexes must be unique');
  if (!steps.some(s => s.kind === 'action')) errs.push('no doc step has kind "action"');
  return errs;
}

// ---------- checks: the doc's UI terms and locations against the page ----------

// A claim is something a step says about the UI that the page can confirm or contradict: a term the
// doc marks up as UI text (bold, code, quotes) or a phrase about where something is.
const PLACES = [
  /\b(?:in|on|from|at|under|to)\s+the\s+(?:[\w-]+\s+){0,3}?(?:navigation bar|nav bar|sidebar|side bar|toolbar|menu bar|top bar|tab bar|header(?: bar)?|footer|banner|(?:side|main|primary|left-side|left-hand|right-hand|drop-?down|context|user|account) menu|drop-?down|panel|navigation)\b/gi,
  /\b(?:(?:top|bottom|upper|lower)[ -](?:left|right)(?: corner)?|(?:left|right)-hand side|(?:left|right) side|(?:top|bottom) of the (?:screen|page|window))\b/gi,
  /\b(?:the\s+)?(?:[\w-]+\s+)?icon\b/gi,
  /\b(?:three[- ]dots?|ellipsis|kebab|hamburger|…)\s+(?:menu|button|icon)\b/gi,
];
const TERMS = [/\*\*([^*]+?)\*\*/g, /__([^_]+?)__/g, /`([^`]+?)`/g, /“([^”]+?)”/g, /"([^"\n]{1,60}?)"/g];
const decode = v => v.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? codePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1), m) : ENTITIES[e.toLowerCase()] ?? m);
const bare = v => decode(v).replace(/[*_`“”"]/g, '').replace(/\s+/g, ' ').trim();

function claimsFor(step, sourceLines, icons = new Set()) {
  const norm = normalize(step.text);
  // The step text may have dropped markup, so read the markup from the source lines it quotes.
  const raw = sourceLines.filter(l => { const n = normalize(l); return n.length >= 8 && (norm.includes(n) || n.includes(norm)); }).join('\n') || step.text;
  const out = [], add = (kind, text) => {
    text = bare(text).replace(/^[+\s]+|[.,:;\s]+$/g, '');
    if (!/[\p{L}\p{N}…]/u.test(text) || text.length > 60) return;
    if (kind === 'term' && !norm.includes(normalize(text))) return; // an alternative the run does not perform
    if (!out.some(c => c.kind === kind && c.text.toLowerCase() === text.toLowerCase())) out.push({ kind, text });
  };
  // Quotes and bold inside a code span are code (`{job="new"}`), not UI text of their own.
  const noCode = raw.replace(/`[^`]*`/g, ' ');
  for (const re of TERMS) for (const m of (re.source.startsWith('`') ? raw : noCode).matchAll(re))
    if (!(re.source.startsWith('`') && icons.has(m[1]))) add('term', m[1]);
  const plain = bare(step.text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')); // links read as their text
  for (const re of PLACES) for (const m of plain.matchAll(re)) add('place', m[0]);
  return out;
}

const esc = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A label without what decorates its words: "Name *", "Name:", "Save as…", "Add ▾", "Next >", "+ New" and an icon
// glyph around a name are Name, Save as, Add, Next and New. Only decoration: "C++" stays C++, ".NET" stays .NET.
const DECO_START = /^[\s\p{So}\p{Co}+*•·‹«<←]+/u, DECO_END = /(?:[\s\p{So}\p{Co}*:：…›»>→]|\.{3})+$/u;
const ends = v => v.replace(DECO_START, '').replace(DECO_END, '') || v;
// A term passes on its own only as a whole name or line on the page. A term that is only part of a longer
// one ("Save" for a button named "Save contact point") is left for the agent to judge.
function termOnPage(term, seen) {
  const t = ends(term);
  if (seen.some(v => ends(v) === t)) return { status: 'on the page' };
  const ci = seen.find(v => ends(v).toLowerCase() === t.toLowerCase());
  if (ci) return { status: 'differs in case', ui: ends(ci) };
  const word = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(t)})($|[^\\p{L}\\p{N}])`, 'ui');
  const longer = seen.filter(v => word.test(v)).sort((a, b) => a.length - b.length)[0];
  if (longer) return longer.length <= 60 ? { status: 'only as part of a longer label', ui: longer } : { status: 'only in a sentence on the page', ui: clip(longer, 80) };
  const words = w => new Set(w.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const want = words(term);
  let best = null, score = 0;
  for (const v of seen) {
    if (v.length > 60) continue;
    const got = words(v), shared = [...want].filter(w => got.has(w)).length;
    const sc = shared / (want.size + got.size - shared || 1);
    if (sc > score) { score = sc; best = v; }
  }
  return { status: 'not on the page', ...(best ? { closest: best } : {}) };
}

const seenFor = (p, demo, docStep) => demo.steps.filter(f => f.docStep === docStep).flatMap(f => {
  try { return JSON.parse(fs.readFileSync(path.join(p.debug, `seen-${pad3(f.n)}.json`), 'utf8')); } catch { return []; }
});

const position = b => b && `${b.y + b.height / 2 < 1 / 3 ? 'top' : b.y + b.height / 2 > 2 / 3 ? 'bottom' : 'middle'}-` +
  `${b.x + b.width / 2 < 1 / 3 ? 'left' : b.x + b.width / 2 > 2 / 3 ? 'right' : 'center'}`;

// Every claim of a performed doc step, with what the page showed. A term found as written passes
// on its own; everything else needs a verdict from "check". With { open: true } only whether each claim
// is still open is worked out, which needs no page text once a term is found or answered.
function claimReport(p, demo, docStep, { open: onlyOpen = false } = {}) {
  const d = demo.doc.steps.find(s => s.index === docStep);
  if (!d?.claims?.length) return [];
  let seen = null;
  const pageText = () => seen ??= seenFor(p, demo, docStep);
  const frames = demo.steps.filter(f => f.docStep === docStep && f.where);
  return d.claims.map(c => {
    const verdict = (demo.checks || []).find(v => v.docStep === docStep && v.claim.toLowerCase() === c.text.toLowerCase());
    if (c.kind === 'term') {
      if (onlyOpen && (c.onPage || verdict)) return { ...c, open: false, verdict };
      const r = c.onPage ? { status: 'on the page' } : termOnPage(c.text, pageText());
      return { ...c, ...r, open: !verdict && r.status !== 'on the page', verdict };
    }
    return { ...c, status: frames.length ? 'judge it by where the elements were' : 'no element was clicked for this step', open: !verdict, verdict };
  });
}

const ANSWER = '--claim "<claim>" --verdict ok|doc|setup|noted|not-ui --note "..."';
const CHECK_USAGE = `Add ${ANSWER} for each open check to your next command (the next doc step's first act, note or fail, or finish), ` +
  `before the action word and after the command's own --note; or answer them on their own: H check --doc-step <n> ${ANSWER} [...]`;

function printClaims(p, demo, docStep) {
  const rep = claimReport(p, demo, docStep);
  if (!rep.length) return;
  console.log(`\nChecks for doc step ${docStep}:`);
  for (const c of rep) {
    const extra = c.ui ? ` (UI: "${c.ui}")` : c.closest ? ` (closest: "${c.closest}")` : '';
    const v = c.verdict ? ` -> ${c.verdict.verdict}${c.verdict.note ? `: ${c.verdict.note}` : ''}` : c.open ? '  [OPEN]' : '';
    console.log(`  ${c.kind} "${c.text}": ${c.status}${extra}${v}`);
  }
  // Where each element this step acted on sits, once for all of the step's location claims.
  const frames = demo.steps.filter(f => f.docStep === docStep && f.where);
  if (frames.length && rep.some(c => c.kind === 'place' && c.open)) {
    console.log('  where the elements were:');
    for (const f of frames)
      console.log(`    ${f.instruction}: ${f.where.role} at ${f.where.position}, ${f.where.within.length ? `inside ${f.where.within.join(' > ')}` : 'inside no landmark'}`);
    const others = frames.at(-1).where.elsewhere;
    if (others.length) console.log(`    other landmarks on the page: ${others.join(', ')}`);
  }
  if (rep.some(c => c.open))
    console.log(`After this step's last action, answer each OPEN check on your next command: add ${ANSWER} per check, before the action word.`);
}

// Marks terms found as written in demo.json itself, so a demo folder can be rebuilt (say, with
// --embed-url) after it is moved or .debug/ is deleted. `only` limits it to one doc step.
function recordFoundTerms(p, demo, only) {
  for (const k of new Set(demo.steps.map(f => f.docStep).filter(n => n !== undefined && (only === undefined || n === only)))) {
    const d = demo.doc.steps.find(s => s.index === k);
    const todo = (d?.claims || []).filter(c => c.kind === 'term' && !c.onPage);
    if (!todo.length) continue;
    const seen = seenFor(p, demo, k);
    for (const c of todo) if (termOnPage(c.text, seen).status === 'on the page') c.onPage = true;
  }
}

const openClaims = (p, demo, docStep) => claimReport(p, demo, docStep, { open: true }).filter(c => c.open);

// Doc steps that were performed and must have their checks answered: not the failed one, none after it.
function checkedSteps(demo) {
  const failed = demo.steps.find(f => f.status === 'failed');
  return [...new Set(demo.steps.filter(f => f.docStep !== undefined && f.status === 'ok').map(f => f.docStep))]
    .filter(n => !failed || n !== failed.docStep);
}

const VERDICTS = ['ok', 'doc', 'setup', 'noted', 'not-ui'];

// The answers to checks among a command's options: each --claim takes the --verdict and --note after it.
// A --note before the first --claim is the command's own (a frame's note).
function claimAnswers(seq) {
  const answers = [];
  let note;
  for (const [k, v] of seq) {
    if (k === 'claim') answers.push({ claim: v });
    else if ((k === 'verdict' || k === 'note') && answers.length) {
      if (answers.at(-1)[k] !== undefined)
        fail('USAGE', `the claim "${answers.at(-1).claim}" has two --${k} options${k === 'note' ? '; a frame\'s own --note goes before the first --claim' : ''}`);
      answers.at(-1)[k] = v;
    } else if (k === 'verdict') fail('USAGE', '--verdict must come after the --claim it answers');
    else if (k === 'note') note = v;
  }
  return { answers, note };
}

// The claim as written, or as the checks list prints it: term "New Team".
const claimText = claim => typeof claim === 'string' ? claim.trim().replace(/^(?:term|place)\s+(?=")/i, '').replace(/^"([\s\S]*)"$/, '$1') : '';

// Checks every answer for one doc step; the errors say what to fix.
function checkAnswers(demo, docStep, answers) {
  const d = demo.doc.steps.find(s => s.index === docStep);
  const errs = [], seen = new Set();
  const found = answers.map(({ claim, verdict, note }) => {
    claim = claimText(claim);
    const c = (d?.claims || []).find(x => x.text.toLowerCase() === claim.toLowerCase());
    const say = m => errs.push(`"${claim}": ${m}`);
    note = typeof note === 'string' ? note.trim() : '';
    if (!c) say(`doc step ${docStep} has no such claim; its claims are: ${(d?.claims || []).map(x => `"${x.text}"`).join(', ') || 'none'}`);
    else if (seen.has(c.text.toLowerCase())) say('answered twice in this command');
    if (c) seen.add(c.text.toLowerCase());
    if (!VERDICTS.includes(verdict)) say(`--verdict must be one of ${VERDICTS.join('|')}`);
    else if (!note) say('every verdict needs --note: the finding for doc/setup, a short reason otherwise');
    else if (verdict === 'doc' && !/\bdoc says\b/i.test(note)) say('--verdict doc needs a note in the form "doc says X; UI shows Y"');
    else if (verdict === 'setup' && !/^setup:/i.test(note)) say('--verdict setup needs a note starting with "setup:"');
    else if (verdict === 'noted' && !demo.steps.some(f => f.docStep === docStep && f.note))
      say(`"noted" means a frame of doc step ${docStep} already carries the finding, but none has a note`);
    return { c, verdict, note };
  });
  return { found, errs };
}

function recordAnswers(demo, docStep, found) {
  for (const { c, verdict, note } of found) {
    demo.checks = (demo.checks || []).filter(v => !(v.docStep === docStep && v.claim.toLowerCase() === c.text.toLowerCase()));
    demo.checks.push({ docStep, claim: c.text, kind: c.kind, verdict, note });
  }
}

// Answers given with another command (act, note, fail, done, finish), for that command's doc step or an
// earlier one: each goes to the step that has the claim open; failing that, to the command's own step if
// it has the claim, or to the one step that has it. All are checked before any is recorded.
function answerWith(p, demo, answers, current) {
  const steps = checkedSteps(demo).filter(k => current === undefined || k <= current);
  const open = new Map(steps.map(k => [k, openClaims(p, demo, k)]));
  const groups = new Map();
  for (const a of answers) {
    const text = claimText(a.claim).toLowerCase();
    const has = list => steps.filter(k => list(k).some(c => c.text.toLowerCase() === text));
    let ks = has(k => open.get(k));
    if (!ks.length) {
      ks = has(k => demo.doc.steps.find(s => s.index === k)?.claims || []);
      if (ks.includes(current)) ks = [current];
    }
    if (ks.length !== 1)
      fail('USAGE', `nothing was recorded: ${ks.length ? `"${claimText(a.claim)}" is a claim of doc steps ${ks.join(' and ')}; answer it with H check --doc-step <n>`
        : `no doc step performed so far has the claim "${claimText(a.claim)}"`}`);
    groups.set(ks[0], [...(groups.get(ks[0]) || []), a]);
  }
  const checked = [...groups].map(([k, list]) => ({ k, ...checkAnswers(demo, k, list) }));
  const errs = checked.flatMap(g => g.errs.map(e => `doc step ${g.k}: ${e}`));
  if (errs.length) fail('USAGE', `nothing was recorded:\n${errs.map(e => `  ${e}`).join('\n')}`);
  for (const g of checked) recordAnswers(demo, g.k, g.found);
  writeJSON(p.demo, demo);
  console.log(`recorded ${checked.flatMap(g => g.found.map(({ c, verdict }) => `${verdict} for ${c.kind} "${c.text}" (doc step ${g.k})`)).join(', ')}`);
}

// One command answers any number of a doc step's claims: each --claim takes the --verdict and --note
// after it. All are checked before any is recorded.
function checkCommand(opts, seq) {
  const p = paths(opts);
  const demo = loadDemo(p);
  const docStep = Number(need(opts, 'doc-step'));
  if (!demo.doc.steps.some(s => s.index === docStep)) fail('USAGE', `--doc-step ${docStep} is not in steps.json`);
  const { answers, note } = claimAnswers(seq);
  if (note !== undefined) fail('USAGE', '--note must come after the --claim it answers');
  if (!answers.length) fail('USAGE', `missing --claim\n${CHECK_USAGE}`);
  const { found, errs } = checkAnswers(demo, docStep, answers);
  if (errs.length) fail('USAGE', `nothing was recorded:\n${errs.map(e => `  ${e}`).join('\n')}`);
  recordAnswers(demo, docStep, found);
  writeJSON(p.demo, demo);
  const left = openClaims(p, demo, docStep);
  console.log(`recorded ${found.map(({ c, verdict }) => `${verdict} for ${c.kind} "${c.text}"`).join(', ')} (doc step ${docStep}); ` +
    (left.length ? `still open: ${left.map(c => `${c.kind} "${c.text}"`).join(', ')}` : 'no open checks left on this step'));
}

// ---------- claims beyond the steps ----------

// A doc says more than its steps do: a default, a limit, an order, what a setting does, what appears after an
// action. `claim` records such a sentence (a quote of source.md, as a step's text is), evidence frames record
// what the app showed when it was checked (act and note with --evidence, after "done"), and check --claim-id
// gives the verdict and the frames it rests on. Evidence frames are not steps: readers never get them, and
// their screenshots go in evidence/, not assets/.
const CLAIM_VERDICTS = ['ok', 'doc', 'setup', 'unverified'];
const CLAIM_USAGE = `H check --claim-id <id> --verdict ${CLAIM_VERDICTS.join('|')} --note "..." [--frames E1,7]`;
const claimOf = (demo, id) => (demo.claims || []).find(c => c.id === String(id).trim().toLowerCase());
const claimIds = demo => demo.claims?.length ? `the claims are ${demo.claims.map(c => c.id).join(', ')}` : 'record one with H claim --quote "..."';
const claimQuoteErrors = (claims, sourceText) => {
  const hay = normalize(sourceText);
  return claims.filter(c => { const n = normalize(c.quote); return !n || !hay.includes(n); }).map(c => `claim ${c.id} is not a verbatim quote of source.md: "${clip(c.quote, 80)}"`);
};

// claim --quote "..." [--verdict ... --note ... --frames 7] [--quote ...]: a claim the frames the procedure recorded
// already settle can take its verdict at once (saving the done, evidence and check commands); the others get theirs
// with check --claim-id after their evidence frames. All are checked before any is recorded.
function claimCommand(opts, seq) {
  const p = paths(opts);
  const demo = loadDemo(p);
  const groups = [];
  for (const [k, v] of seq) {
    if (k === 'quote') groups.push({ quote: typeof v === 'string' ? v.trim() : '' });
    else if (k === 'verdict' || k === 'note' || k === 'frames') {
      if (!groups.length) fail('USAGE', `--${k} must come after the --quote it answers`);
      if (groups.at(-1)[k] !== undefined) fail('USAGE', `a claim has two --${k} options`);
      groups.at(-1)[k] = v;
    }
  }
  if (!groups.length) fail('USAGE', 'missing --quote "<a sentence of the doc, copied exactly>"');
  if (!fs.existsSync(p.source)) fail('USAGE', `no ${p.source}; run "docdemo doc" first`);
  const hay = normalize(fs.readFileSync(p.source, 'utf8')), have = (demo.claims || []).map(c => normalize(c.quote));
  const errs = [];
  demo.claims ??= [];
  const added = groups.map((g, i) => {
    const q = g.quote, say = m => errs.push(`"${clip(q, 60)}": ${m}`);
    if (!q) errs.push('--quote needs text');
    else if (q.length > 400) say('quote one or two sentences (400 characters at most)');
    else if (!normalize(q) || !hay.includes(normalize(q))) say('not a verbatim quote of source.md; copy the doc\'s words exactly, as for steps.json');
    else if (have.includes(normalize(q)) || groups.slice(0, i).some(x => normalize(x.quote) === normalize(q))) say('already a claim');
    const c = { id: `c${demo.claims.length + i + 1}`, quote: q, evidence: [] };
    if (g.verdict !== undefined || g.note !== undefined || g.frames !== undefined) {
      if (g.frames === undefined && g.verdict !== 'unverified')
        say('a verdict given with the claim rests on frames the procedure recorded: give them with --frames <n>, or record evidence first');
      const frames = verdictFrames(demo, c, g.frames, say);
      const note = typeof g.note === 'string' ? g.note.trim() : '';
      if (frames) verdictErrors(g.verdict, note, frames).forEach(e => say(e.replace('<id>', c.id)));
      Object.assign(c, { verdict: g.verdict, note, frames: frames || [] });
    }
    return c;
  });
  if (errs.length) fail('VALIDATION', `nothing was recorded:\n${errs.map(e => `  ${e}`).join('\n')}`);
  demo.claims.push(...added);
  writeJSON(p.demo, demo);
  for (const c of added) console.log(`claim ${c.id}: "${clip(c.quote, 120)}"${c.verdict ? `: ${c.verdict}${c.frames.length ? ` (frames ${c.frames.join(', ')})` : ''}` : ''}`);
  if (added.some(c => !c.verdict))
    console.log(`After H done, record what the app shows with H act or H note --evidence <id> --instruction "...", then answer with ${CLAIM_USAGE}`);
}

// An action that did not end cleanly: one Playwright logged as done, or one still being performed when its time ran
// out, which may or may not have reached the page. Neither is done again by DocDemo.
const MAYBE = 'it may not have reached the page: ';
const uncertainText = u => clip(`${u.maybe ? MAYBE : ''}${u.message}`, 200);
// A result that does not show yet is no proof that the action did not run: it may still be on its way.
const uncertainWarning = u => u.maybe
  ? `WARNING: the action was still being performed when its time ran out (${u.message}), so it may or may not have reached the page, ` +
    'and its result may still be on its way. Never do it again if it saves, submits, creates or deletes something. Do any other action ' +
    'again only if the snapshot below shows the page just as it was before it; otherwise go on from the page as it is.'
  : `WARNING: the action ran, but then: ${u.message}. Do not do it again; look at the snapshot below and go on from the page as it is.`;
const typedWarning = res => res.typed?.ok === false && console.log(`WARNING: the code editor holds ${JSON.stringify(clip(res.typed.text, 300))}, ` +
  'not the value typed. Look at it in the snapshot below; fill it again, or record the difference with --note on the next act.');

// An act or note that records an evidence frame for a claim instead of a frame of the demo. It comes after the
// final frame, so readers end on the procedure's result, not on what checking a claim left on the screen.
function evidenceCommand(cmd, opts, pos) {
  const p = paths(opts);
  const demo = loadDemo(p);
  if (cmd !== 'act' && cmd !== 'note')
    fail('USAGE', `${cmd} does not take --evidence: record what the app shows with act or note --evidence, and the verdict with ${CLAIM_USAGE}`);
  if (opts['doc-step'] !== undefined) fail('USAGE', 'an evidence frame is not a doc step: give --evidence <claim id> or --doc-step, not both');
  if (opts.claim !== undefined || opts.note !== undefined)
    fail('USAGE', 'an evidence frame takes no --claim or --note: what it shows goes in the verdict, with H check --claim-id');
  const c = claimOf(demo, need(opts, 'evidence'));
  if (!c) fail('USAGE', `no claim "${opts.evidence}"; ${claimIds(demo)}`);
  if (!demo.steps.length || demo.steps.at(-1).docStep !== undefined)
    fail('USAGE', 'record the demo\'s final frame first, with H done: readers end on the result of the documented procedure, and evidence frames come after it');
  const k = demo.claims.reduce((n, x) => n + x.evidence.length, 0) + 1;
  const frame = { id: `E${k}`, instruction: need(opts, 'instruction'), image: `evidence/e${String(k).padStart(2, '0')}.webp` };
  const spec = cmd === 'act' ? actSpec(opts, pos) : {};
  let res;
  try {
    res = runCapture(p, frame.id, { ...spec, terms: false, claim: c.id }, demo.app.url, { dir: p.evidence, name: path.basename(frame.image, '.webp') });
  } catch (e) {
    const clock = readClock(p);
    if (clock.pending?.length || clock.notKept) {
      const before = demo.claims.flatMap(x => x.evidence).sort((a, b) => a.id.slice(1) - b.id.slice(1)).at(-1) || demo.steps.at(-1);
      for (const { gap, claim, ...x } of clock.pending || []) {
        const at = (!gap && claimOf(demo, claim)) || before;
        at.http = mergeHttp(at.http, [x]);
      }
      // So do the counts of errors not kept: those from before the capture go with the capture before, the rest with the claim.
      if (clock.notKept?.late) before.httpNotKept = (before.httpNotKept || 0) + clock.notKept.late;
      if (clock.notKept?.own) c.httpNotKept = (c.httpNotKept || 0) + clock.notKept.own;
      writeJSON(p.demo, demo);
      writeClock(p, clock.ended || Date.now());
    }
    throw e;
  }
  if (spec.key) frame.action = { kind: 'press', value: spec.key };
  else if (cmd === 'act') frame.action = { kind: spec.action, ref: spec.ref, ...(spec.value !== undefined ? { value: spec.value } : {}) };
  if (res.dialogs) frame.dialogs = res.dialogs;
  if (res.uncertain) frame.uncertain = uncertainText(res.uncertain);
  // An HTTP error goes with the capture it arrived during: one from before this capture began, with the previous
  // capture (the last evidence frame, or the final frame); one a failed capture left behind, with that capture's claim.
  const prev = demo.claims.flatMap(x => x.evidence).sort((a, b) => a.id.slice(1) - b.id.slice(1)).at(-1) || demo.steps.at(-1);
  const mine = [], late = [];
  for (const { gap, claim, ...e } of res.http) {
    const other = claim && claim !== c.id && claimOf(demo, claim);
    if (other) { const at = other.evidence.at(-1) || other; at.http = mergeHttp(at.http, [e]); }
    else (gap ? late : mine).push(e);
  }
  if (late.length) prev.http = mergeHttp(prev.http, late);
  if (res.notKept.late) prev.httpNotKept = (prev.httpNotKept || 0) + res.notKept.late;
  if (mine.length) frame.http = mine;
  if (res.notKept.own) frame.httpNotKept = res.notKept.own;
  c.evidence.push(frame);
  writeJSON(p.demo, demo);
  console.log(`ok evidence ${frame.id} for claim ${c.id} (${cmd}) ${frame.image}`);
  if (res.uncertain) console.log(uncertainWarning(res.uncertain));
  typedWarning(res);
  const lines = [...httpReport(late, demo.app.url, 'Since the previous capture, HTTP errors in the browser\'s network log'), ...httpReport(mine, demo.app.url)];
  if (lines.length) console.log(lines.join('\n'));
  if (res.httpMore) console.log(`(${res.httpMore} more HTTP errors from the app's site are not listed)`);
  printPage(res);
}

// The verdicts on claims: each --claim-id takes the --verdict, --note and --frames after it.
function claimVerdicts(seq) {
  const out = [];
  for (const [k, v] of seq) {
    if (k === 'claim-id') out.push({ id: v });
    else if (k === 'verdict' || k === 'note' || k === 'frames') {
      if (!out.length) fail('USAGE', `--${k} must come after the --claim-id it answers`);
      if (out.at(-1)[k] !== undefined) fail('USAGE', `claim ${out.at(-1).id} has two --${k} options`);
      out.at(-1)[k] = v;
    } else if (k === 'claim' || k === 'doc-step')
      fail('USAGE', 'answer claims (--claim-id) and a doc step\'s checks (--doc-step with --claim) with separate check commands');
  }
  return out;
}

// The frames a verdict rests on: --frames lists the claim's evidence frames (E2) and frames of the demo (7), as
// act and review.html number them; without it, every evidence frame of the claim. null when one is unknown.
function verdictFrames(demo, c, given, say) {
  if (given === undefined) return c.evidence.map(e => e.id);
  const out = [];
  for (const f of String(given === true ? '' : given).split(',').map(s => s.trim()).filter(Boolean)) {
    const ev = c.evidence.find(e => e.id.toLowerCase() === f.toLowerCase());
    if (ev) out.push(ev.id);
    else if (/^\d+$/.test(f) && +f >= 1 && +f <= demo.steps.length) out.push(+f);
    else {
      say(`--frames: "${f}" is neither an evidence frame of ${c.id} (${c.evidence.map(e => e.id).join(', ') || 'it has none'}) nor a frame of the demo (1 to ${demo.steps.length})`);
      return null;
    }
  }
  return [...new Set(out)];
}

// What a verdict on a claim needs; check --claim-id and build both hold a claim to it.
function verdictErrors(verdict, note, frames) {
  if (!CLAIM_VERDICTS.includes(verdict)) return [`--verdict must be one of ${CLAIM_VERDICTS.join('|')}`];
  if (typeof note !== 'string' || !note.trim()) return ['every verdict needs --note: what the evidence shows, or for unverified why it could not be checked'];
  if (verdict === 'doc' && !/\bdoc says\b/i.test(note)) return ['--verdict doc needs a note in the form "doc says X; UI shows Y"'];
  if (verdict === 'setup' && !/^setup:/i.test(note.trim())) return ['--verdict setup needs a note starting with "setup:"'];
  if (verdict !== 'unverified' && !frames.length)
    return [`--verdict ${verdict} needs evidence: record what the app shows with H act or H note --evidence <id>, or give --frames <n> for a frame ` +
      'of the demo that shows it; if the app can\'t show it, the verdict is unverified'];
  return [];
}

// check --claim-id: the verdict on one or more claims. All are checked before any is recorded.
function claimCheckCommand(opts, seq) {
  const p = paths(opts);
  const demo = loadDemo(p);
  const answers = claimVerdicts(seq);
  const errs = [], found = [];
  for (const a of answers) {
    const say = m => errs.push(`claim ${a.id}: ${m}`);
    const c = claimOf(demo, a.id);
    if (!c) { say(`no such claim; ${claimIds(demo)}`); continue; }
    if (found.some(f => f.c === c)) { say('answered twice in this command'); continue; }
    const note = typeof a.note === 'string' ? a.note.trim() : '';
    const frames = verdictFrames(demo, c, a.frames, say);
    if (frames) verdictErrors(a.verdict, note, frames).forEach(e => say(e.replace('<id>', c.id)));
    found.push({ c, verdict: a.verdict, note, frames });
  }
  if (!answers.length) fail('USAGE', `missing --claim-id\n${CLAIM_USAGE}`);
  if (errs.length) fail('USAGE', `nothing was recorded:\n${errs.map(e => `  ${e}`).join('\n')}`);
  for (const { c, verdict, note, frames } of found) Object.assign(c, { verdict, note, frames });
  writeJSON(p.demo, demo);
  const left = demo.claims.filter(c => !c.verdict);
  console.log(`recorded ${found.map(f => `${f.verdict} for claim ${f.c.id}${f.frames.length ? ` (frames ${f.frames.join(', ')})` : ''}`).join(', ')}; ` +
    (left.length ? `no verdict yet: ${left.map(c => c.id).join(', ')}` : 'every claim has a verdict'));
}

// ---------- init / open / close ----------

// "init --list L1 [--select 1-4,6] [--kind 5=optional] [--choose 2=a]": the doc steps from a list in the outline
// "doc" printed, each the item's text as the doc has it (or the chosen alternative's). Every item is an action
// unless --kind says otherwise. What init cannot take as written (alternatives with none chosen, sub-steps,
// options it cannot find) is refused, never guessed.
function stepsFromList(source, opts) {
  const lists = numberedLists(printedSection(source));
  const list = lists.find(l => l.id === String(opts.list).toUpperCase());
  if (!list) fail('USAGE', `--list ${opts.list} is not a list in the outline "doc" printed:\n${listOutline(lists)}`);
  const items = new Map(list.items.map(it => [it.n, it]));
  const number = (v, flag) => { if (!/^\d+$/.test(v)) fail('USAGE', `${flag}: "${v}" is not an item number`); return Number(v); };
  const item = (n, flag) => items.get(n) ||
    fail('USAGE', `${flag}: ${list.id} has no item ${n} (its items are ${list.items.map(it => it.n).join(', ')})`);
  let picked = list.items.map(it => it.n);
  if (opts.select !== undefined) {
    const flag = `--select ${opts.select}`;
    picked = [];
    for (const part of String(opts.select).split(',')) {
      const [a, b = a] = part.split('-').map(v => number(v.trim(), flag));
      if (b < a) fail('USAGE', `${flag}: ${part} counts down`);
      for (let n = a; n <= b; n++) if (item(n, flag) && !picked.includes(n)) picked.push(n);
    }
    picked.sort((x, y) => x - y);
  }
  const pairs = key => {
    const m = new Map(), flag = `--${key} ${opts[key]}`;
    if (opts[key] === undefined) return m;
    for (const part of String(opts[key]).split(',')) {
      const [n, v] = part.split('=').map(x => x.trim());
      const k = number(n, flag);
      if (!v) fail('USAGE', `${flag}: write each as <item>=<${key === 'kind' ? 'kind' : 'letter'}>`);
      if (m.has(k)) fail('USAGE', `${flag}: item ${k} is named twice`);
      item(k, flag);
      if (!picked.includes(k)) fail('USAGE', `${flag}: item ${k} is not selected`);
      m.set(k, v.toLowerCase());
    }
    return m;
  };
  const kinds = pairs('kind'), choices = pairs('choose');
  for (const [n, k] of kinds) if (!DOC_KINDS.includes(k)) fail('USAGE', `--kind ${n}=${k}: a kind is ${DOC_KINDS.join(', ')}`);
  for (const [n, c] of choices) {
    const alts = items.get(n).alts;
    if (!alts.length) fail('USAGE', `--choose ${n}=${c}: item ${n} offers no alternatives`);
    if (!alts.some(a => a.letter === c)) fail('USAGE', `--choose ${n}=${c}: item ${n} offers ${alts.map(a => a.letter).join(', ')}`);
  }
  const errs = [];
  const steps = picked.map(n => {
    const it = items.get(n), kind = kinds.get(n) || 'action', pick = choices.get(n);
    const alt = pick && it.alts.find(a => a.letter === pick);
    const text = alt ? alt.text : it.text;
    if (kind === 'action' && (it.deep || alt?.deep))
      errs.push(`item ${n}${alt?.deep ? ` (alternative ${pick})` : ''} has lists or headings nested inside it, which init --list does not take apart: write demo/steps.json for this procedure and run init with --steps`);
    else if (kind === 'action' && !pick) {
      if (it.alts.length) errs.push(`item ${n} offers alternatives (${it.alts.map(a => a.letter).join(', ')}): pass --choose ${n}=<letter> ` +
        `for the one you will perform, or --kind ${n}=<kind> if it is not performed`);
      else if (it.substeps) errs.push(`item ${n} has numbered sub-steps, which init --list does not split: write demo/steps.json for this procedure and run init with --steps`);
      else if (it.actionBelow) errs.push(`item ${n} lists actions under it ("${clip(bare(it.actionBelow), 50)}"), which init --list does not take apart: ` +
        'write demo/steps.json for this procedure and run init with --steps');
      else if (it.noOptions) errs.push(`item ${n} says "one of the following" but lists no options under it: write demo/steps.json and run init with --steps`);
    }
    if (!text) errs.push(`item ${n}${pick || ''} has no text of its own: leave it out with --select, or write demo/steps.json`);
    return { index: n, text, kind };
  });
  if (errs.length) fail('VALIDATION', errs.join('\n'));
  return steps;
}

// What tells runs of one procedure apart over time, for a dashboard of many runs: a stable id for the
// procedure (from the doc URL unless --id gives one, since pages get renamed), a hash of its steps as the doc
// words them (so a later run shows whether the doc changed since it was verified), and the product's version.
function procedureId(url) {
  try { const u = new URL(url); return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.hash}`; } catch { return String(url); }
}
const docHash = steps => 'sha256:' + crypto.createHash('sha256')
  .update(steps.map(s => `${s.index}. ${String(s.text).replace(/\s+/g, ' ').trim()}`).join('\n')).digest('hex');
const DOC_HASH = /^sha256:[0-9a-f]{64}$/;
function optionText(opts, key) {
  if (opts[key] === undefined) return undefined;
  const v = String(opts[key]).trim();
  if (!v || opts[key] === true) fail('USAGE', `--${key} needs text`);
  return v;
}

function initCommand(opts) {
  const p = paths(opts);
  if (fs.existsSync(p.demo))
    fail('USAGE', `${p.demo} already exists${opts.open ? '; to open the app for it, run "open"' : ''}; to start over, run "doc" again`);
  if (!fs.existsSync(p.source)) fail('USAGE', `no ${p.source}; run "docdemo doc" first`);
  const id = optionText(opts, 'id'), appVersion = optionText(opts, 'app-version');
  const fromList = opts.list !== undefined;
  if (fromList && opts.steps !== undefined) fail('USAGE', 'pass --list or --steps, not both');
  if (!fromList && opts.steps === undefined) fail('USAGE', 'missing --list <id> (from the outline "doc" printed) or --steps <steps.json>');
  const source = fs.readFileSync(p.source, 'utf8');
  const steps = fromList ? stepsFromList(source, opts) : readJSON(path.resolve(need(opts, 'steps')));
  let errs = checkDocSteps(steps);
  if (!errs.length) errs = citationErrors(steps, source);
  if (errs.length) fail('VALIDATION', errs.join('\n') + (fromList ? '\nWrite demo/steps.json (copy doc text exactly) and run init with --steps.'
    : '\nFix steps.json (copy doc text exactly) and run init again.'));
  if (fromList) fs.writeFileSync(path.join(p.out, 'steps.json'),
    `[\n${steps.map(s => `  ${JSON.stringify({ index: s.index, text: s.text, kind: s.kind })}`).join(',\n')}\n]\n`);
  const cfg = readJSON(path.join(ASSETS, 'cli.config.json'));
  const vp = cfg.browser.contextOptions.viewport;
  const fetchedAt = source.match(/^fetchedAt: (.+)$/m)?.[1] || new Date().toISOString();
  const lines = source.split('\n'), icons = sourceIcons(source);
  for (const s of steps) if (s.kind !== 'reference') s.claims = claimsFor(s, lines, icons);
  const demo = {
    version: 1,
    title: need(opts, 'title'),
    generatedAt: new Date().toISOString(),
    generator: { name: 'docdemo', version: VERSION, ...playwrightVersion() },
    doc: { id: id || procedureId(need(opts, 'doc-url')), url: need(opts, 'doc-url'), fetchedAt, hash: docHash(steps), steps },
    app: { url: need(opts, 'app-url'), ...(appVersion ? { version: appVersion } : {}), viewport: { width: vp.width, height: vp.height } },
    status: 'complete',
    steps: [],
  };
  fs.mkdirSync(p.out, { recursive: true });
  writeJSON(p.demo, demo);
  fs.writeFileSync(path.join(p.out, '.gitignore'), '.debug/\n.playwright-cli/\n');
  const actions = steps.filter(s => s.kind === 'action').length;
  console.log(`initialized ${p.demo}: ${steps.length} doc steps (${actions} to perform)${fromList ? `, from ${String(opts.list).toUpperCase()}:` : ''}`);
  if (fromList) for (const s of steps) console.log(`  doc step ${s.index} (${s.kind}): ${clip(s.text, 100)}`);
  for (const s of steps.filter(s => s.claims?.length))
    console.log(`  doc step ${s.index} claims: ${s.claims.map(c => `${c.kind} "${c.text}"`).join(', ')}`);
  if (opts.open) openCommand(opts); // one command instead of two
}

// Page code that waits until the page settles: until no request of the page is loading (one open for 3 s is
// a long poll, which never ends) and the DOM has not changed for `quiet` ms; at most `cap` ms. A page that
// navigates while it is watched (a sign-in that redirects) is watched again. Apps that poll never go
// network-idle, so that is never waited for.
const settleCode = (quiet, cap) => `{
  const end = Date.now() + ${cap};
  const loading = async () => (await page.requests().catch(() => [])).some(r => !r.failure() && r.timing().responseEnd < 0 &&
    /^(document|xhr|fetch|script|stylesheet)$/.test(r.resourceType()) && Date.now() - r.timing().startTime < 3000);
  for (let tries = 0; tries < 3 && Date.now() < end; tries++) {
    try {
      await page.waitForLoadState('load', { timeout: Math.max(1, end - Date.now()) }).catch(() => {});
      for (let idle = 0; idle < 5 && Date.now() < end; await page.waitForTimeout(100)) idle = await loading() ? 0 : idle + 1;
      await page.evaluate(([q, left]) => new Promise(res => {
        let t; const fin = () => { mo.disconnect(); res(); };
        const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(fin, q); });
        mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        t = setTimeout(fin, q); setTimeout(fin, left);
      }), [${quiet}, Math.max(${quiet}, end - Date.now())]);
      break;
    } catch { /* the page navigated while it was watched: watch the new one */ }
  }
}`;

// Whether the page asks to sign in, for page.evaluate: a visible password field that is for signing in
// (marked current-password, or with a Sign in / Log in / Continue / Next button, or, on a page without
// navigation, in a form of three fields at most), not one in a settings form (a data source's password,
// with its host, port and user). Also how many are visible.
const signInForm = String(() => {
  const shown = el => el.getClientRects().length > 0;
  const visible = [...document.querySelectorAll('input[type=password]')].filter(shown);
  const nav = [...document.querySelectorAll('nav,[role=navigation]')].some(shown);
  const forSignIn = el => {
    const ac = el.getAttribute('autocomplete') || '';
    if (/current-password/i.test(ac)) return true;
    if (/new-password/i.test(ac)) return false;
    const scope = el.form || el.closest('form,[role=form],[role=dialog],main') || document.body;
    if ([...scope.querySelectorAll('button,input[type=submit],input[type=button],[role=button]')]
      .some(b => /^((sign|log)[\s-]?(in|on)\b|login$|continue$|next$)/i.test((b.innerText || b.value || '').trim()))) return true;
    const fields = [...scope.querySelectorAll('input,select,textarea')]
      .filter(f => shown(f) && !/^(hidden|submit|button|reset|checkbox|radio|image)$/i.test(f.type || ''));
    return !nav && fields.length <= 3;
  };
  return { passwords: visible.length, signInForm: visible.some(forSignIn) };
});

function openCommand(opts) {
  const p = paths(opts);
  const demo = loadDemo(p);
  fs.mkdirSync(p.debug, { recursive: true });
  // The config also turns off playwright-cli's own pause after every command (timeouts.settle) and the
  // snapshot it writes after a page opens (snapshot.mode): the helper's page code settles the page itself,
  // watching its requests, and takes the one snapshot the agent reads.
  const cfg = readJSON(path.join(ASSETS, 'cli.config.json'));
  cfg.outputDir = p.debug;
  const state = typeof opts.state === 'string' ? path.resolve(opts.state)
    : fs.existsSync(AUTH_FILE) ? path.resolve(AUTH_FILE) : null;
  if (state) {
    if (!fs.existsSync(state)) fail('USAGE', `no storage state at ${state}`);
    cfg.browser.contextOptions.storageState = state;
  }
  const cfgFile = path.join(p.debug, 'cli.config.json');
  writeJSON(cfgFile, cfg);
  pw(['close'], { allowFail: true });
  const launch = () => pw(['open', `--config=${cfgFile}`, ...(opts.headed ? ['--headed'] : []), demo.app.url], { allowFail: true });
  // Google Chrome is the default; without it, fall back to Playwright's own Chromium.
  if (opts.browser === 'chromium') cfg.browser.browserName = 'chromium';
  writeJSON(cfgFile, cfg);
  let r = launch();
  if (r.status !== 0 && !cfg.browser.browserName && /distribution 'chrome' is not found|chrome.*not found/i.test(r.stderr + r.stdout)) {
    cfg.browser.browserName = 'chromium';
    writeJSON(cfgFile, cfg);
    pw(['close'], { allowFail: true });
    r = launch();
  }
  if (r.status !== 0 || /### Error/.test(r.stdout)) {
    const msg = (r.stderr + r.stdout).trim().split('\n').filter(l => /error|not found|install/i.test(l)).slice(0, 4).join('\n');
    fail('ACTION_FAILED', `could not open ${demo.app.url}\n${msg}\nIf no browser is installed: playwright-cli install-browser chromium`);
  }
  // Let single-page apps finish booting so the first snapshot is not a loading screen (at most 8 s).
  // The HTTP errors of the page load are kept for the report: the app site's, with what the first five say.
  let site = '';
  try { site = siteOf(new URL(demo.app.url).hostname); } catch {}
  const token = `open-${process.pid}-${Date.now()}`;
  const { res: settled } = runPageCode(p, 'settle', `async page => {
  ${settleCode(500, 8000)}
  const siteOf = ${siteOf};
  const hostOf = ${hostOf};
  const site = ${JSON.stringify(site)};
  const http = [];
  for (const r of await page.requests().catch(() => [])) {
    const resp = r.existingResponse?.() || null, failure = r.failure()?.errorText;
    if (!(resp ? resp.status() >= 400 : failure) || (site && siteOf(hostOf(r.url())) !== site)) continue;
    let nav = false;
    try { nav = r.isNavigationRequest() && r.frame() === page.mainFrame(); } catch {}
    const body = resp && http.length < 5 && /^(document|xhr|fetch)$/.test(r.resourceType())
      ? await Promise.race([resp.text(), page.waitForTimeout(500).then(() => '')]).catch(() => '') : '';
    http.push({ method: r.method(), url: r.url(), type: r.resourceType(), nav, ...(body ? { body: body.slice(0, 2000) } : {}),
      ...(resp ? { status: resp.status(), statusText: resp.statusText() } : { failure }) });
  }
  const res = { url: page.url(), ended: Date.now(), http, ...await page.evaluate(${signInForm}).catch(() => ({})),
    title: await page.title().catch(() => ''), snapshot: await page.ariaSnapshot({ mode: 'ai' }).catch(() => '') };
  page.__docdemo = { token: ${JSON.stringify(token)}, json: JSON.stringify(res) };
  return JSON.stringify(res);
}`, token);
  const at = { url: demo.app.url, passwords: 0, ...settled };
  writeClock(p, at.ended || Date.now());
  const loadErrors = httpErrors(at.http, demo.app.url);
  if (loadErrors.length) demo.openHttp = loadErrors; else delete demo.openHttp;
  writeJSON(p.demo, demo);
  console.log(`opened ${at.url} in session "${SESSION}"`);
  if (state) console.log(`(signed in with ${state})`);
  const lines = httpReport(loadErrors, demo.app.url, 'While the app loaded, HTTP errors in the browser\'s network log');
  if (lines.length) console.log(lines.join('\n'));
  let signIn = false;
  let urlPath = '';
  try { urlPath = new URL(at.url).pathname; } catch {}
  if (at.signInForm || /\/(log-?in|sign-?in|sso|saml|oauth2?|auth)(\/|\?|$)/i.test(urlPath)) {
    console.log(state
      ? `SIGN-IN: the app shows a sign-in page even though a saved session was loaded; it has probably expired.`
      : `SIGN-IN: the app shows a sign-in page and there is no saved session (docdemo-auth.json).`);
    const { from } = readCredentials();
    if (from.username || from.password) {
      console.log(`CREDENTIALS: ${Object.entries(from).map(([k, src]) => `${CRED_KEYS[k]} (${src})`).join(', ')}. ` +
        `Unless the documented procedure is about signing in, sign in with "signin" (the helper types the values).`);
      if (Object.values(from).includes('.env')) warnIfNotIgnored(path.resolve('.env'));
    } else {
      signIn = true;
      console.log(`Unless the documented procedure is about signing in, run "close", stop, and tell the user to run ` +
        `/docdemo:login ${demo.app.url}${state ? ' again' : ''}, then run DocDemo again.`);
    }
  }
  if (!signIn) printPage(at);
}

// ---------- peek and get: read what the page does not print, without recording ----------

// Hovers an element to read what only a hover shows (a tooltip, a chart point's exact time) and prints the
// page. No frame is recorded: a hover the doc asks for is an act.
function peekCommand(opts) {
  const p = paths(opts);
  loadDemo(p);
  const ref = need(opts, 'ref');
  if (!/^[a-z0-9]+$/i.test(ref)) fail('USAGE', `--ref must look like e123, got "${ref}"`);
  fs.mkdirSync(p.debug, { recursive: true });
  const token = `peek-${process.pid}-${Date.now()}`;
  const { res } = runPageCode(p, 'peek', `async page => {
  const l = page.locator('aria-ref=' + ${JSON.stringify(ref)});
  let error = null;
  if (await l.count() !== 1) error = 'STALE_REF';
  else await l.hover({ timeout: 4000 }).catch(e => { error = String(e.message || e).split('\\n')[0]; });
  // Tooltips open after a short delay; then wait until the page stops changing (at most 1.5 s).
  if (!error) await page.waitForTimeout(300).then(() => page.evaluate(() => new Promise(res => {
    let t; const fin = () => { mo.disconnect(); res(); };
    const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(fin, 200); });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    t = setTimeout(fin, 200); setTimeout(fin, 1200);
  }))).catch(() => {});
  const res = { error, url: page.url(), title: await page.title().catch(() => ''), snapshot: await page.ariaSnapshot({ mode: 'ai' }).catch(() => '') };
  page.__docdemo = { token: ${JSON.stringify(token)}, json: JSON.stringify(res) };
  return JSON.stringify(res);
}`, token);
  if (!res) { printSnapshot(); fail('ACTION_FAILED', 'peek could not read the page; take a new snapshot'); }
  printPage(res);
  if (res.error === 'STALE_REF') fail('STALE_REF', 'STALE_REF: that ref is not on the page; pick one from the snapshot above');
  if (res.error) fail('ACTION_FAILED', `peek: ${res.error}`);
  console.log(`\nhovered ${ref} to read the page; nothing was recorded`);
}

// A read-only GET to the app's own origin with the browser's session: exact values a page only draws (an
// event's start and end, the points of a chart). Prints the status and the start of the response, with the
// test account's password and the values of secret-looking fields (tokens, keys) hidden. A redirect is not
// followed: where it points is printed, to get next if it is on the app's origin too.
function getCommand(opts, pos) {
  const p = paths(opts);
  const demo = loadDemo(p);
  const target = pos[0] ?? need(opts, 'url');
  let u, app;
  try { app = new URL(demo.app.url); u = new URL(target, app); } catch { fail('USAGE', `"${target}" is not a URL or a path on the app`); }
  if (!/^https?:$/.test(u.protocol)) fail('USAGE', 'get reads only http(s) addresses');
  if (endsOrDeletes(u)) fail('USAGE', 'get does not open addresses that end the session or delete something (log out, delete, revoke), even with GET');
  fs.mkdirSync(p.debug, { recursive: true });
  const token = `get-${process.pid}-${Date.now()}`;
  // The origin the page is on counts as the app's too: the app URL can redirect to another one.
  const { res } = runPageCode(p, 'get', `async page => {
  let res;
  const at = await page.evaluate(() => location.origin).catch(() => null);
  if (${JSON.stringify(u.origin)} !== ${JSON.stringify(app.origin)} && ${JSON.stringify(u.origin)} !== at) res = { error: 'NOT_APP', at };
  else try {
    const r = await page.request.get(${JSON.stringify(u.href)}, { timeout: 15000, maxRedirects: 0 });
    res = { status: r.status(), statusText: r.statusText(), type: r.headers()['content-type'] || '', location: r.headers()['location'] || '',
      body: (await r.text().catch(() => '')).slice(0, 100000) };
  } catch (e) { res = { error: String(e.message || e).split('\\n')[0] }; }
  page.__docdemo = { token: ${JSON.stringify(token)}, json: JSON.stringify(res) };
  return JSON.stringify(res);
}`, token);
  if (!res) fail('ACTION_FAILED', 'get could not run in the browser session; is the app open? (run "open")');
  if (res.error === 'NOT_APP')
    fail('USAGE', `get reads only from the app's origin (${app.origin}${res.at && res.at !== app.origin ? ` or the page's, ${res.at}` : ''})`);
  if (res.error) fail('ACTION_FAILED', `GET ${u.pathname}${u.search} failed: ${res.error}`);
  const where = u.origin === app.origin ? u.pathname + u.search : u.href;
  const LIMIT = 8000;
  const text = hideSecrets(redact(res.body));
  const body = text.length > LIMIT ? `${text.slice(0, LIMIT)}\n… (${text.length - LIMIT} more characters)` : text;
  const moved = res.status >= 300 && res.status < 400 && res.location ? `\nredirects to ${hideSecrets(redact(res.location))} (not followed)` : '';
  console.log(`GET ${where}: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${res.type ? ` (${res.type.split(';')[0]})` : ''}${moved}\n${body}`);
}

// The values of fields whose names say they are secret. In JSON, each such field's whole value, whatever it is
// (numbers elsewhere are kept exactly as written); in other text, "key": "value" and key=value pairs (also in
// URLs), header lines (Authorization: Bearer …) and the token after Bearer or Basic.
const SECRET_NAME = '[\\w.-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|authorization|cookie|session[-_]?(?:id|key))[\\w.-]*';
const SECRET_KEY = new RegExp(`^${SECRET_NAME}$`, 'i');
const SECRET_HEADER = /^(\s*(?:proxy-)?(?:authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*).+$/gim;
const SECRET_FIELD = new RegExp(`(["']?)(${SECRET_NAME})\\1(\\s*[:=]\\s*)(` +
  `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\[(?:\\s*"(?:[^"\\\\]|\\\\.)*"\\s*,?)*\\s*\\]|(?:bearer|basic|token|digest)\\s+[^\\s,;&}\\]]+|(?![{[])[^\\s,;&}\\]]+)`, 'gi');
function hideSecrets(text) {
  const t = String(text);
  if (typeof JSON.rawJSON === 'function' && /^\s*[{[]/.test(t)) {
    try {
      const hide = v => Array.isArray(v) ? v.map(hide) : v && typeof v === 'object' && !JSON.isRawJSON(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '***' : hide(x)])) : v;
      return JSON.stringify(hide(JSON.parse(t, (k, v, c) => typeof v === 'number' && c?.source ? JSON.rawJSON(c.source) : v)));
    } catch { /* not JSON after all */ }
  }
  return t.replace(SECRET_HEADER, '$1***').replace(SECRET_FIELD, (m, q, k, sep, v) => `${q}${k}${q}${sep}${/^["']/.test(v) ? `${v[0]}***${v[0]}` : '***'}`);
}

// Whether a GET would end the session or delete something: a word of the path or the query, decoded, such as
// /logout, /api/items/delete, /api/deleteUser or ?action=revoke ("deleted-count" is not such a word).
const ENDS_OR_DELETES = new Set(['logout', 'logoff', 'signout', 'delete', 'destroy', 'remove', 'purge', 'revoke', 'unsubscribe']);
function endsOrDeletes(u) {
  const decode = v => { for (let i = 0; i < 2; i++) try { v = decodeURIComponent(v); } catch { break; } return v; };
  const parts = [...u.pathname.split('/').map(decode), ...[...u.searchParams].flat().map(decode)];
  return parts.some(v => /(?:^|[^a-z])(?:log|sign)[\s_-]?(?:out|off)(?:[^a-z]|$)/i.test(v) ||
    v.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).some(w => ENDS_OR_DELETES.has(w)));
}

// ---------- login ----------

// Sign in by hand, once: a visible browser opens at the app, the user signs in (SSO and 2-factor work,
// and nobody types a password for them) and closes the window. While the window is open the session is
// copied every second, so closing it keeps the signed-in state. One blocking command, so a skill can
// run it without a second permission prompt. It uses its own browser session and never disturbs a run.
const LOGIN_SESSION = `${SESSION}-login`;
const AUTH_FILE = 'docdemo-auth.json';
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function loginCommand(opts) {
  const file = path.resolve(String(typeof opts.state === 'string' ? opts.state : AUTH_FILE));
  const lpw = (args, o = {}) => pw(args, { ...o, session: LOGIN_SESSION });
  const saveTo = f => {
    const r = lpw(['state-save', f], { allowFail: true });
    return r.status === 0 && !/### Error/.test(r.stdout) && fs.existsSync(f);
  };
  if (opts.save) { // save now without waiting for the window to close (scripts and tests)
    const tmp = `${file}.tmp`;
    fs.rmSync(tmp, { force: true });
    if (!saveTo(tmp)) fail('USAGE', 'no sign-in window is open. Run "login --url <app-url>" first.');
    lpw(['close'], { allowFail: true });
    return finishLogin(tmp, file);
  }

  const url = need(opts, 'url');
  if (!/^https?:\/\//i.test(url)) fail('USAGE', `--url must start with http:// or https:// (got "${url}")`);
  const waitSec = Number(opts.wait || 570); // stays under a 10-minute tool timeout
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docdemo-login-'));
  try { // the folder briefly holds copies of the session: always remove it
    const cfg = readJSON(path.join(ASSETS, 'cli.config.json'));
    cfg.outputDir = dir;
    if (opts.browser === 'chromium') cfg.browser.browserName = 'chromium';
    const cfgFile = path.join(dir, 'cli.config.json');
    writeJSON(cfgFile, cfg);
    lpw(['close'], { allowFail: true });
    // DOCDEMO_LOGIN_HEADLESS is for the test suite only; a person needs the visible window.
    const headed = process.env.DOCDEMO_LOGIN_HEADLESS ? [] : ['--headed'];
    const launch = () => lpw(['open', `--config=${cfgFile}`, ...headed, url], { allowFail: true });
    let r = launch();
    if (r.status !== 0 && !cfg.browser.browserName && /distribution 'chrome' is not found|chrome.*not found/i.test(r.stderr + r.stdout)) {
      cfg.browser.browserName = 'chromium';
      writeJSON(cfgFile, cfg);
      r = launch();
    }
    if (r.status !== 0 || /### Error/.test(r.stdout))
      fail('ACTION_FAILED', `could not open ${url}\n${(r.stderr + r.stdout).trim().split('\n').slice(0, 4).join('\n')}`);

    console.log(`The sign-in window is open at ${url}. Waiting for it to be closed...`);
    // Not state-save: it opens a hidden page for each origin no tab shows (a stack that redirected to
    // its sign-in site), and in the visible window that blinks and takes focus away from paste.
    // This reads the cookies and the open tabs' localStorage only, and keeps what earlier reads saw.
    const readCode = path.join(dir, 'read.js'), latest = path.join(dir, 'latest.json');
    fs.writeFileSync(readCode, `async page => {
  const context = page.context();
  const origins = await Promise.all(context.pages().map(p => p.evaluate(() => ({ origin: location.origin,
    localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })) })).catch(() => null)));
  return JSON.stringify({ cookies: await context.cookies(), origins: origins.filter(o => o && o.origin !== 'null') });
}`);
    const read = () => {
      const r = lpw(['--raw', 'run-code', `--filename=${readCode}`], { allowFail: true });
      try { const st = JSON.parse(JSON.parse(r.stdout.trim())); return r.status === 0 && Array.isArray(st.cookies) ? st : null; }
      catch { return null; }
    };
    const storage = new Map(); // origin -> its localStorage, the latest read wins
    let saved = false, timedOut = true;
    for (const until = Date.now() + waitSec * 1000; Date.now() < until; sleep(1000)) {
      const st = read();
      if (!st) { timedOut = false; break; } // the window was closed
      // A read that races the window closing can come back empty: never let it replace a real session.
      if (saved && !st.cookies.length && !st.origins.length && !isEmptyState(latest)) continue;
      for (const o of st.origins) storage.set(o.origin, o.localStorage);
      const origins = [...storage].filter(([, ls]) => ls.length).map(([origin, localStorage]) => ({ origin, localStorage }));
      writeJSON(latest, { cookies: st.cookies, origins });
      saved = true;
    }
    if (timedOut) lpw(['close'], { allowFail: true });
    if (!saved) fail('USAGE', 'the sign-in window closed before anything could be saved. Run login again.');
    if (timedOut) console.log(`The sign-in window was open for ${Math.round(waitSec / 60)} minutes, so DocDemo closed it.`);
    finishLogin(latest, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isEmptyState(f) {
  try {
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    return !(st.cookies || []).length && !(st.origins || []).some(o => o.localStorage?.length);
  } catch { return true; }
}

function finishLogin(from, file) {
  // Copy rather than rename: the temp folder can be on another filesystem (tmpfs /tmp on Linux).
  fs.writeFileSync(file, fs.readFileSync(from), { mode: 0o600 });
  fs.rmSync(from, { force: true });
  try { fs.chmodSync(file, 0o600); } catch {} // session cookies: owner-only, also when the file existed
  const st = readJSON(file);
  const cookies = st.cookies || [];
  const domains = [...new Set(cookies.map(c => String(c.domain).replace(/^\./, '')))];
  console.log(`saved the session to ${file} (${cookies.length} cookie${cookies.length === 1 ? '' : 's'}` +
    `${domains.length ? ` for ${domains.join(', ')}` : ''})`);
  if (!cookies.length && !(st.origins || []).some(o => o.localStorage?.length))
    console.log('WARNING: the saved session is empty. Were you signed in before closing the window? Run login again.');
  warnIfNotIgnored(file);
  console.log('DocDemo runs started from this folder now begin signed in. If a run reports a sign-in page later, ' +
    'the session has expired: run login again.');
}

// ---------- signin ----------

// Signs in with a test account's credentials from the environment or ./.env. Claude picks the fields
// from the snapshot; only this script reads the values, types them, and keeps them out of every output.
// Nothing is recorded as a demo frame.
const CRED_KEYS = { username: 'DOCDEMO_USERNAME', password: 'DOCDEMO_PASSWORD' };

function readCredentials() {
  const dotenv = {};
  if (fs.existsSync('.env')) {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?(DOCDEMO_USERNAME|DOCDEMO_PASSWORD)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const quoted = m[2].match(/^(["'])(.*?)\1(\s+#.*)?$/);
      dotenv[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '');
    }
  }
  const values = {}, from = {};
  for (const [k, name] of Object.entries(CRED_KEYS)) {
    if (process.env[name]) { values[k] = process.env[name]; from[k] = 'environment'; }
    else if (dotenv[name]) { values[k] = dotenv[name]; from[k] = '.env'; }
  }
  return { values, from };
}

// The test account's password never appears in what the helper prints or keeps in .debug/: an app can show it
// as text after the sign-in. Values shorter than 4 characters are left alone, as they would hide ordinary text.
let secretForms;
const redact = text => {
  // As typed, and as it appears inside a quoted string (a snapshot's YAML escapes " and \).
  secretForms ??= (secret => secret.length >= 4 ? [...new Set([secret, JSON.stringify(secret).slice(1, -1)])] : [])(readCredentials().values.password || '');
  return secretForms.reduce((t, v) => t.split(v).join('***'), String(text));
};
// The same for a value about to be written as JSON: every string in it, before it is serialized.
const redactValue = v => typeof v === 'string' ? redact(v) : Array.isArray(v) ? v.map(redactValue)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x)])) : v;

function signinCommand(opts) {
  const { values } = readCredentials();
  const fills = [];
  for (const k of ['username', 'password']) {
    const ref = opts[`${k}-ref`];
    if (ref === undefined) continue;
    if (!values[k]) fail('USAGE', `${CRED_KEYS[k]} is not set in the environment or in ./.env`);
    fills.push([String(ref), values[k], k]);
  }
  const submit = opts['submit-ref'] === undefined ? null : String(opts['submit-ref']);
  if (!fills.length && !submit) fail('USAGE', 'give --username-ref, --password-ref and/or --submit-ref (refs from the latest snapshot)');
  // A typed password is never left on the page, where a snapshot would show it.
  if (opts['password-ref'] !== undefined && !submit) fail('USAGE', '--password-ref needs --submit-ref');
  for (const ref of [...fills.map(f => f[0]), submit].filter(Boolean))
    if (!/^[a-z0-9]+$/i.test(ref)) fail('USAGE', `"${ref}" is not a snapshot ref (like e12)`);
  const hide = t => Object.values(values).reduce((acc, v) => acc.split(v).join('***'), String(t));
  // Credentials are typed only on the app's own origin: a redirect to another host never receives them.
  const origin = new URL(loadDemo(paths(opts)).app.url).origin;

  // The values reach the browser only through this owner-only file, deleted right after the call.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docdemo-signin-'));
  const file = path.join(dir, 'signin.js');
  fs.writeFileSync(file, `async page => {
  const at = ref => page.locator('aria-ref=' + ref);
  const origin = ${JSON.stringify(origin)};
  // The page, and the frame of every field typed into, must be on the app's origin.
  // (run-code has no URL global, so the page itself reports its origin)
  const pageOrigin = await page.evaluate(() => location.origin).catch(() => null);
  if (pageOrigin !== origin) return JSON.stringify({ error: 'WRONG_ORIGIN', at: pageOrigin });
  ${fills.map(([ref]) => `{ const o = await at(${JSON.stringify(ref)}).evaluate(() => location.origin, null, { timeout: 5000 }).catch(() => null);
    if (o !== origin) return JSON.stringify({ error: 'WRONG_ORIGIN', at: o }); }`).join('\n  ')}
  // The password only goes into a real password field, which shows dots: typed into an ordinary text box,
  // it would be readable in the next snapshot.
  ${fills.filter(f => f[2] === 'password').map(([ref]) => `if (!await at(${JSON.stringify(ref)}).evaluate(e => e instanceof HTMLInputElement && e.type === 'password', null, { timeout: 5000 }).catch(() => false))
    return JSON.stringify({ error: 'NOT_PASSWORD_FIELD' });`).join('\n  ')}
  const secret = ${JSON.stringify(values.password || '\u0000')};
  // The fields of a frame, shadow roots included, that hold the password, whatever their type is now (a
  // "show password" button makes the field a text box): a snapshot would show it. With clear, they are
  // emptied through the element's own value setter, with input and change events, so a framework follows.
  const holding = ([secret, clear]) => {
    const all = (root, out = []) => {
      for (const el of root.querySelectorAll('*')) { if (el.matches('input, textarea')) out.push(el); if (el.shadowRoot) all(el.shadowRoot, out); }
      return out;
    };
    const found = all(document).filter(el => el.value === secret);
    if (clear) for (const el of found) {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (set) set.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return found.filter(el => el.value === secret).length;
  };
  let failed = null;
  try {
    ${fills.map(([ref, v]) => `await at(${JSON.stringify(ref)}).fill(${JSON.stringify(v)}, { timeout: 5000 });`).join('\n    ')}
    ${submit ? `await at(${JSON.stringify(submit)}).click({ timeout: 5000 });
    ${settleCode(500, 8000)}` : ''}
  } catch (e) {
    failed = String(e && e.message || e).split('\\n')[0];
  } finally {
    // Clear the password from the page, in every frame, whether or not the sign-in worked.
    for (const frame of page.frames()) await frame.evaluate(holding, [secret, true]).catch(() => {});
  }
  // Then no field may hold it. A frame that cannot be checked (it is navigating) is tried again; one that still
  // cannot be counts as holding it, and the browser is closed rather than risk a snapshot that shows it.
  let left = 0;
  for (const frame of page.frames()) {
    let found = null;
    for (let i = 0; i < 3 && found === null; i++) {
      if (frame.isDetached()) { found = 0; break; } // gone, and what it held with it
      found = await frame.evaluate(holding, [secret, false]).catch(() => null);
      if (found === null) await page.waitForTimeout(300);
    }
    left += found ?? 1;
  }
  if (left) return JSON.stringify({ error: 'NOT_CLEARED' });
  if (failed) return JSON.stringify({ error: 'FAILED', message: failed });
  const passwords = await page.locator('input[type=password]:visible').count().catch(() => 0);
  return JSON.stringify({ url: page.url(), passwords });
}`, { mode: 0o600 });
  let r;
  try { r = pw(['--raw', 'run-code', `--filename=${file}`], { allowFail: true }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
  let res;
  try { res = JSON.parse(JSON.parse(String(r.stdout).trim())); } catch {
    // The page could not be checked, so it may still hold the password: close the browser before anyone looks.
    if (values.password && opts['password-ref'] !== undefined) pw(['close'], { allowFail: true });
    fail('ACTION_FAILED', `signin failed${values.password && opts['password-ref'] !== undefined ? ' and the browser was closed, in case the password was still on the page' : ''}. ` +
      `Take a new snapshot and check the refs.\n` +
      hide((r.stderr || r.stdout || '').trim().split('\n').filter(l => !/fill\(/.test(l)).slice(0, 3).join('\n')));
  }
  if (res.error === 'WRONG_ORIGIN')
    fail('USAGE', `the sign-in form is not on the app's origin (${origin}${res.at ? `; it is on ${hide(res.at)}` : ''}). Nothing was typed. ` +
      `Credentials from .env are only typed on the app's own origin: tell the user to sign in once with /docdemo:login instead.`);
  if (res.error === 'NOT_PASSWORD_FIELD')
    fail('USAGE', '--password-ref must point at a password field (an input whose text shows as dots). Nothing was typed.');
  if (res.error === 'NOT_CLEARED') {
    pw(['close'], { allowFail: true });
    fail('ACTION_FAILED', 'signin could not clear the password from the page, so the browser was closed. Run "open" again; ' +
      'if this repeats, tell the user to sign in once with /docdemo:login instead.');
  }
  if (res.error === 'FAILED')
    fail('ACTION_FAILED', `signin failed: ${hide(res.message)}\nThe password was cleared from the page. Take a new snapshot and check the refs.`);
  // The sign-in's own requests (a 401 for a first try, say) are not the product's errors.
  writeClock(paths(opts), Date.now());
  console.log(`signin done; now at ${hide(res.url)}`);
  if (res.passwords) console.log('A password field is still visible: the sign-in needs another step, or the credentials did not work.');
  printSnapshot(hide); // a failed or two-page sign-in still shows the username
}

// Session cookies must not end up in a commit.
function warnIfNotIgnored(file) {
  const cwd = path.dirname(file);
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' });
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== 'true') return;
  const ignored = spawnSync('git', ['check-ignore', '-q', file], { cwd });
  if (ignored.status !== 0)
    console.log(`WARNING: ${path.basename(file)} holds ${path.basename(file) === '.env' ? 'your credentials' : 'your session cookies'} ` +
      `and git does not ignore it. Add it to .gitignore so it is never committed.`);
}

// ---------- build ----------

const okRect = r => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
  r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.0001 && r.y + r.height <= 1.0001;
const okPoint = q => q && [q.x, q.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1);

// A recorded dropdown's choices hold the picked label: at the top level, or in the named group.
function hasOption(options, label, group) {
  if (!Array.isArray(options) || typeof label !== 'string') return false;
  const ok = options.every(o => typeof o === 'string' ||
    (o && typeof o.group === 'string' && Array.isArray(o.options) && o.options.every(x => typeof x === 'string')));
  return ok && (group == null ? options.includes(label) : options.some(o => o.group === group && o.options.includes(label)));
}

// What still has to be recorded before a run can end: a documented step without a frame, an open check.
function unfinished(demo, p, { claims = true } = {}) {
  const errs = [];
  const failed = demo.steps.find(s => s.status === 'failed');
  const covered = new Set(demo.steps.map(s => s.docStep));
  for (const d of demo.doc.steps) {
    if (d.kind !== 'action' || covered.has(d.index)) continue;
    if (failed && d.index > failed.docStep) continue; // never reached
    errs.push(`doc step ${d.index} (action) has no frame; record it with act, note or fail`);
  }
  for (const k of checkedSteps(demo))
    for (const c of openClaims(p, demo, k)) errs.push(`doc step ${k}: open check on ${c.kind} "${c.text}" (${c.status}); answer it with --claim on finish, or with "check"`);
  for (const c of claims && Array.isArray(demo.claims) ? demo.claims : [])
    if (c && !c.verdict) errs.push(`claim ${c.id} ("${clip(c.quote, 60)}") has no verdict: after H done, record what the app shows with H act or H note ` +
      `--evidence ${c.id}, then ${CLAIM_USAGE.replace('<id>', c.id)} (unverified, with the reason, when the app can't show it)`);
  return errs;
}

// HTTP errors as DocDemo records them, each { method, url, status } or { method, url, failure }: the report reads them.
const httpList = v => v === undefined || (Array.isArray(v) && v.every(e => e && typeof e === 'object' && typeof e.method === 'string' &&
  typeof e.url === 'string' && (Number.isInteger(e.status) || typeof e.failure === 'string')));

function validate(demo, p) {
  if (!demo || typeof demo !== 'object' || !demo.doc || !Array.isArray(demo.doc.steps) || !Array.isArray(demo.steps) ||
      !demo.app?.viewport || typeof demo.title !== 'string')
    return ['demo.json must have title, doc.steps[], app.viewport and steps[]'];
  const errs = checkDocSteps(demo.doc.steps);
  if (errs.length) return errs;
  if (demo.doc.id !== undefined && (typeof demo.doc.id !== 'string' || !demo.doc.id.trim())) errs.push('doc.id must be text');
  if (demo.doc.hash !== undefined && !DOC_HASH.test(demo.doc.hash)) errs.push('doc.hash must be "sha256:" and 64 hex digits');
  if (demo.app.version !== undefined && (typeof demo.app.version !== 'string' || !demo.app.version.trim())) errs.push('app.version must be text');
  const claims = demo.claims ?? [];
  const list = v => v === undefined || Array.isArray(v), count = v => v === undefined || Number.isInteger(v);
  if (!Array.isArray(claims) || claims.some(c => !c || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.quote !== 'string' ||
      !c.quote.trim() || !Array.isArray(c.evidence) || !list(c.frames) || !httpList(c.http) || !count(c.httpNotKept) ||
      c.evidence.some(e => !e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.instruction !== 'string' || !e.instruction.trim() ||
        !httpList(e.http) || !count(e.httpNotKept) || (e.uncertain !== undefined && typeof e.uncertain !== 'string'))))
    return ['claims must be a list of { id, quote, evidence: [{ id, image, ... }], verdict, note, frames: [] }'];
  if (new Set(claims.map(c => c.id)).size !== claims.length) return ['claim ids must be unique'];
  const docIdx = new Set(demo.doc.steps.map(s => s.index));
  const steps = demo.steps;
  if (!steps.length) errs.push('no frames recorded');
  if (!httpList(demo.openHttp)) errs.push('openHttp must list { method, url, status or failure }');
  steps.forEach((s, i) => {
    const at = `frame ${i + 1}`;
    if (!s || typeof s !== 'object') return errs.push(`${at}: not an object`);
    if (s.status !== 'ok' && s.status !== 'failed') errs.push(`${at}: status must be "ok" or "failed"`);
    if (typeof s.instruction !== 'string' || !s.instruction) errs.push(`${at}: missing instruction`);
    if (s.note !== undefined && typeof s.note !== 'string') errs.push(`${at}: note must be text`);
    if (!httpList(s.http) || !count(s.httpNotKept)) errs.push(`${at}: http must list { method, url, status or failure }, and httpNotKept be a number`);
    if (typeof s.image !== 'string' || !/^assets\/[\w.-]+\.(png|jpe?g|svg|webp)$/i.test(s.image)) {
      errs.push(`${at}: image must be a file inside assets/`);
      return;
    }
    if (s.action && !['press', ...ACTIONS].includes(s.action.kind)) errs.push(`${at}: unknown action kind "${s.action.kind}"`);
    if (s.hotspot && !okRect(s.hotspot)) errs.push(`${at}: hotspot must lie within 0..1 with a positive size`);
    if (s.action?.kind === 'drag' && ![s.action.from, s.action.to].every(okPoint)) errs.push(`${at}: a drag needs action.from and action.to, points within 0..1`);
    if (s.action?.options !== undefined && !hasOption(s.action.options, s.action.picked, s.action.pickedGroup))
      errs.push(`${at}: action.options must list labels and { group, options } groups, and include action.picked (in action.pickedGroup)`);
    if (s.n !== i + 1) errs.push(`${at}: n is ${s.n}, expected ${i + 1}`);
    if (s.docStep !== undefined && !docIdx.has(s.docStep)) errs.push(`${at}: docStep ${s.docStep} is not a doc step`);
    if (s.docStep === undefined && i !== steps.length - 1) errs.push(`${at}: only the final "done" frame may omit docStep`);
    if (!fs.existsSync(path.join(p.out, s.image))) errs.push(`${at}: missing image ${s.image}`);
    if (s.status === 'ok' && s.action && s.action.kind !== 'press' && !s.hotspot) errs.push(`${at}: action frame without hotspot`);
    if (s.status === 'failed' && i !== steps.length - 2) errs.push(`${at}: a failed frame must be the last frame before "done"`);
  });
  const last = steps.at(-1);
  if (last && last.docStep !== undefined) errs.push('the demo has no final frame; run "done" first');
  const failed = steps.find(s => s.status === 'failed');
  if ((demo.status === 'partial') !== Boolean(failed)) errs.push(`status is "${demo.status}" but ${failed ? 'a frame failed' : 'no frame failed'}`);
  errs.push(...unfinished(demo, p));
  for (const v of demo.checks || [])
    if (!VERDICTS.includes(v.verdict) || !docIdx.has(v.docStep) || typeof v.note !== 'string')
      errs.push(`check on "${v.claim}" has a bad verdict, doc step or note`);
  for (const c of claims) {
    if (c.verdict !== undefined) errs.push(...verdictErrors(c.verdict, c.note, c.frames || []).map(e => `claim ${c.id}: ${e.replace('<id>', c.id)}`));
    for (const e of c.evidence) {
      if (typeof e.image !== 'string' || !/^evidence\/e\d{2,}\.(?:png|jpe?g|webp)$/i.test(e.image)) errs.push(`claim ${c.id}: an evidence image must be a file inside evidence/`);
      else if (!fs.existsSync(path.join(p.out, e.image))) errs.push(`claim ${c.id}: missing image ${e.image}`);
    }
    for (const f of c.frames || [])
      if (!(Number.isInteger(f) ? f >= 1 && f <= steps.length : c.evidence.some(e => e.id === f))) errs.push(`claim ${c.id}: frame ${f} does not exist`);
  }
  for (const k of READER_TEXTS)
    if (demo[k] !== undefined && (typeof demo[k] !== 'string' || !demo[k].trim() || demo[k].length > 2000))
      errs.push(`${k} must be text of 1 to 2000 characters`);
  if (fs.existsSync(p.source)) {
    const source = fs.readFileSync(p.source, 'utf8');
    errs.push(...citationErrors(demo.doc.steps, source), ...claimQuoteErrors(claims, source));
  } else errs.push(`missing ${p.source}`);
  return errs;
}

// Texts a writer can add to demo.json for readers: `intro` and `introNote` on a screen before the first
// frame, `outro` on the last one (what the reader accomplished).
const READER_TEXTS = ['intro', 'introNote', 'outro'];

// Where each doc step sits in the doc: the heading it is under (`section`), and the code blocks that are
// part of it when its text points at them ("enter the following query:"). Both come from source.md as the
// doc has them, so they are quotes too. A step is looked for after the one before it.
function docOutline(sourceText, docSteps) {
  const lines = sourceText.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const norm = lines.map(l => normalize(l));
  const starts = [];
  let joined = '';
  for (const n of norm) { starts.push(joined.length); joined += n + ' '; }
  const lineAt = pos => { let i = 0; while (i + 1 < starts.length && starts[i + 1] <= pos) i++; return i; };
  const ITEM = /^\s*(?:\d+[.)]|[-*+])\s/, HEADING = /^(#{1,6})\s+(.*)$/;
  let from = 0;
  return docSteps.map(d => {
    const want = normalize(d.text);
    let at = want ? joined.indexOf(want, from) : -1;
    if (at < 0 && want) at = joined.indexOf(want.slice(0, 40), from);
    if (at < 0) return {};
    from = at + want.length;
    const first = lineAt(at), last = lineAt(at + Math.max(0, want.length - 1));
    let section;
    for (let i = first; i >= 0 && !section; i--) {
      const h = lines[i].match(HEADING);
      if (h && h[1].length > 1) section = bare(h[2].replace(/\s*\{#[^}]*\}\s*$/, '').replace(/\s+#+\s*$/, ''));
    }
    // Code inside the step's own list item: fenced blocks (an HTML page's <pre> becomes one), and lines that are a
    // code span on their own (what a <pre> became in source.md files fetched before 1.4.0), up to the next list
    // item or heading.
    const code = [];
    if (/\bfollowing\b|:\s*$/i.test(bare(d.text))) {
      for (let i = last + 1; i < lines.length && !ITEM.test(lines[i]) && !HEADING.test(lines[i]); i++) {
        const fence = lines[i].match(/^\s*(`{3,}|~{3,})/);
        if (fence) {
          const body = [];
          for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
          const indent = Math.min(...body.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length));
          code.push(body.map(l => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n').trim());
          continue;
        }
        const span = lines[i].match(/^\s*`([^`]+)`\s*$/);
        if (span) code.push(span[1]);
      }
    }
    return { ...(section ? { section } : {}), ...(code.length ? { code } : {}) };
  });
}

// Frames that only get a field ready for the typing right after them (a click into the field, selecting
// its text) or put away what the typing opened (Escape on an autocomplete list), within one doc step. The
// reader copy leaves them out: the typing frame's screenshot already shows the field just before the
// typing, and `fill` replaces the field's text in the player too. Frames with a note are kept.
const SELECT_ALL = /^(?:ControlOrMeta|Control|Meta)\+a$/i;
function foldedFrames(demo) {
  const f = demo.steps, out = new Set();
  const plain = s => s && s.status === 'ok' && !s.note && !s.dialogs && s.docStep !== undefined;
  const fills = s => s && s.status === 'ok' && s.action?.kind === 'fill';
  const sameStep = (a, b) => a.docStep === b?.docStep;
  const selects = s => plain(s) && s.action?.kind === 'press' && SELECT_ALL.test(String(s.action.value));
  const docText = k => demo.doc.steps.find(d => d.index === k)?.text || '';
  f.forEach((s, i) => {
    if (!plain(s) || !s.action) return;
    const kind = s.action.kind;
    if (selects(s) && fills(f[i + 1]) && sameStep(s, f[i + 1])) out.add(i);
    else if (kind === 'click' && s.locator) {
      const fill = fills(f[i + 1]) ? f[i + 1] : selects(f[i + 1]) && sameStep(s, f[i + 1]) && fills(f[i + 2]) ? f[i + 2] : null;
      if (fill && sameStep(s, fill) && fill.locator === s.locator) out.add(i);
    } else if (kind === 'press' && /^Escape$/i.test(String(s.action.value)) && fills(f[i - 1]) && sameStep(f[i - 1], s) &&
      !/\besc(?:ape)?\b/i.test(docText(s.docStep))) out.add(i);
  });
  return out;
}

// index.html is what readers get, so it carries only what the player shows them. The notes, checks,
// claims, app URL, locators and refs stay in demo.json, review.html and report.md, which are not published.
function readerDemo(demo, folded = new Set()) {
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
  return {
    title: demo.title,
    status: demo.status,
    ...pick(demo, READER_TEXTS),
    doc: { ...pick(demo.doc, ['url', 'title']), steps: demo.doc.steps.map(d => pick(d, ['index', 'text', 'kind', 'section', 'code'])) },
    app: pick(demo.app, ['viewport']),
    steps: demo.steps.filter((f, i) => !folded.has(i)).map(f => ({
      ...pick(f, ['docStep', 'instruction', 'image', 'hotspot', 'status']),
      ...(f.action ? { action: pick(f.action, ['kind', 'value', 'options', 'picked', 'pickedGroup', 'from', 'to']) } : {}),
    })),
  };
}

// Validates a demo and renders what build writes: the reader copy, the review copy and report.md. Nothing is
// written here, so a demo that does not validate leaves the folder as it was.
function renderDemo(p, demo, opts = {}) {
  const errs = validate(demo, p);
  if (errs.length) fail('VALIDATION', errs.join('\n'));
  const player = fs.readFileSync(path.join(ASSETS, 'player.html'), 'utf8');
  const TOKEN = '/*__DEMO_DATA__*/null';
  if (!player.includes(TOKEN)) fail('USAGE', 'player.html is missing the data token');
  // Findings from checks, and the product's HTTP errors, are shown on the last frame of their doc step.
  const findings = reportFindings(demo);
  const shown = structuredClone(demo);
  const kept = []; // each finding once in the review copy too: on the first frame that notes it
  const repeats = (k, note) => kept.some(e => e.docStep === k && sameFinding(e.note, note));
  for (const f of shown.steps.filter(f => f.note && f.docStep !== undefined)) {
    if (f.status !== 'failed' && repeats(f.docStep, f.note)) delete f.note;
    else kept.push({ docStep: f.docStep, note: f.note });
  }
  const addNote = (f, note) => { if (f) f.note = f.note ? `${f.note} · ${note}` : note; };
  const lastOf = k => k ? shown.steps.filter(s => s.docStep === k).at(-1) : shown.steps[0];
  for (const v of (demo.checks || []).filter(v => v.verdict === 'doc' || v.verdict === 'setup')) {
    if (repeats(v.docStep, v.note)) continue;
    kept.push({ docStep: v.docStep, note: v.note });
    addNote(lastOf(v.docStep), v.note);
  }
  for (const f of findings.product.filter(f => f.http)) addNote(lastOf(f.docStep), f.http);
  for (const f of shown.steps.filter(f => f.uncertain)) addNote(f, `check: ${uncertainNote(f.uncertain).replace(/^the/, 'The')}`);
  if (findings.claims.length) shown.claims = findings.claims;
  const page = d => player.replace(TOKEN, () =>
    JSON.stringify(d).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
  const source = fs.readFileSync(p.source, 'utf8');
  const icons = sourceIcons(source), outline = docOutline(source, demo.doc.steps);
  const display = d => ({ ...d, doc: { ...d.doc, steps: d.doc.steps.map((s, i) => ({ ...s, ...outline[i], text: withoutIconNames(s.text, icons) })) } });
  // The review copy keeps every recorded frame, and marks the ones readers don't get; it also shows the run's numbers.
  const folded = foldedFrames(demo);
  for (const i of folded) shown.steps[i].folded = true;
  shown.review = true;

  const actions = demo.steps.filter(s => s.action).length;
  const want = demo.doc.steps.filter(s => s.kind === 'action');
  const covered = want.filter(d => demo.steps.some(s => s.docStep === d.index && s.status === 'ok') &&
    !demo.steps.some(s => s.docStep === d.index && s.status === 'failed')).length;
  const claims = (demo.claims || []).filter(c => c.verdict);
  const claimCounts = CLAIM_ORDER.map(v => [v, claims.filter(c => c.verdict === v).length]).filter(([, n]) => n)
    .map(([v, n]) => `${n} ${CLAIM_LABEL[v].toLowerCase()}`).join(', ');
  const summary = `${demo.status}: ${actions} actions across ${covered} of ${want.length} documented steps, ${demo.steps.length} frames` +
    (folded.size ? ` (${demo.steps.length - folded.size} in the reader copy)` : '') +
    (claims.length ? `; claims beyond the steps: ${claimCounts}` : '');
  const snippet = embedSnippet(demo, opts['embed-url']);
  // The run's numbers, kept in demo.json, so runs can be compared without reading every frame.
  const counts = {
    documentedSteps: want.length, verifiedSteps: covered, actions, frames: demo.steps.length,
    docMismatches: mismatchCount(findings), productErrorSteps: productSteps(findings),
    setupDifferences: new Set(findings.setup.map(f => f.docStep)).size, wording: new Set(findings.wording.map(f => f.docStep)).size,
    framesToCheck: findings.uncertain.length + findings.claims.reduce((n, c) => n + c.problems.uncertain.length, 0),
    claims: Object.fromEntries(CLAIM_ORDER.map(v => [v, claims.filter(c => c.verdict === v).length])),
  };
  return {
    files: {
      'index.html': page(readerDemo(display(demo), folded)),
      'review.html': page(display(shown)),
      'report.md': reportMarkdown(demo, summary, findings, snippet),
    },
    summary, findings, snippet, counts,
  };
}

// Puts the run's numbers in demo.json, and the procedure's id and doc hash in a demo recorded before DocDemo kept them.
function recordRun(demo, built) {
  demo.doc.id ??= procedureId(demo.doc.url);
  demo.doc.hash ??= docHash(demo.doc.steps);
  demo.counts = built.counts;
}

const writeBuild = (p, built) => { for (const [name, text] of Object.entries(built.files)) fs.writeFileSync(path.join(p.out, name), text); };

function printBuild(p, { summary, findings, snippet }) {
  const mismatches = mismatchCount(findings);
  console.log(`built ${path.join(p.out, 'index.html')} (for readers) and ${path.join(p.out, 'review.html')} (with DocDemo's notes, for you)`);
  console.log(summary);
  const errored = productSteps(findings), claimErrors = findings.claims.filter(c => c.problems.http.length).length;
  const toCheck = findings.uncertain.length + findings.claims.reduce((n, c) => n + c.problems.uncertain.length, 0);
  console.log(`report ${path.join(p.out, 'report.md')}: ${mismatches ? `${mismatches} place(s) where the doc and the product disagree`
    : errored || claimErrors ? 'the doc matched the product' : 'the product matched the doc'}${errored ? `; the product returned errors in ${errored} step(s)` : ''}` +
    (claimErrors ? `; the product returned errors while ${claimErrors} claim(s) were checked` : '') +
    (toCheck ? `; ${toCheck} frame(s) to check before publishing` : ''));
  // Each finding once, as report.md lists it.
  const label = { failed: 'FAILED', product: 'product error', doc: 'doc mismatch', setup: 'setup', wording: 'wording', other: 'note', uncertain: 'check this frame' };
  for (const [k, list] of Object.entries(findings).filter(([k]) => k !== 'claims'))
    for (const f of list) console.log(`${label[k]} (${f.docStep ? `doc step ${f.docStep}` : 'opening the app'}): ${f.note || f.http}`);
  for (const c of findings.claims) {
    console.log(`claim ${c.id}, ${CLAIM_LABEL[c.verdict].toLowerCase()} ("${clip(c.quote, 80)}"): ${c.note}`);
    for (const x of c.problems.http) console.log(`product error (claim ${c.id}): ${x}`);
    for (const x of c.problems.uncertain) console.log(`check this frame (claim ${c.id}): ${x}`);
  }
  console.log(`\nTo put the demo on a doc page, host index.html and assets/ (nothing else in ${p.out} is needed) and paste:\n` +
    `HTML:\n${snippet.html}\nMDX (Docusaurus, Mintlify, ReadMe):\n${snippet.mdx}`);
}

function buildCommand(opts) {
  const p = paths(opts);
  const demo = loadDemo(p);
  const before = JSON.stringify(demo);
  recordFoundTerms(p, demo); // fills in demos recorded before terms were kept in demo.json
  const built = renderDemo(p, demo, opts);
  recordRun(demo, built);
  if (JSON.stringify(demo) !== before) writeJSON(p.demo, demo);
  writeBuild(p, built);
  printBuild(p, built);
}

// Corrects what a frame of a finished demo says: its instruction (what readers read) or its note (a finding,
// for review.html and report.md). Nothing else about the frame can change: its action and value, screenshot,
// hotspot and the checks' verdicts stay as recorded (a verdict is corrected with "check"). Nothing is
// written unless the corrected demo builds, and demo.json as it was is kept in .debug/amend/.
function amendCommand(opts) {
  const p = paths(opts);
  const demo = loadDemo(p);
  if (!Array.isArray(demo.steps) || !demo.steps.length || demo.steps.at(-1).docStep !== undefined)
    fail('USAGE', 'amend corrects a finished demo: run "finish" (or "done" and "build") first');
  const frames = demo.steps.length;
  const k = Number(need(opts, 'frame'));
  if (!Number.isInteger(k) || k < 1 || k > frames)
    fail('USAGE', `--frame must be a frame number from 1 to ${frames}, as review.html numbers them ("Screen 7 of ${frames}")`);
  const given = key => opts[key] !== undefined;
  if (!given('instruction') && !given('note') && !given('clear-note')) fail('USAGE', 'give --instruction "...", --note "..." or --clear-note');
  if (given('note') && given('clear-note')) fail('USAGE', 'give --note or --clear-note, not both');
  const text = key => {
    const v = need(opts, key).trim();
    if (!v) fail('USAGE', `--${key} needs text`);
    return v;
  };
  const next = structuredClone(demo), f = next.steps[k - 1];
  if (given('instruction')) f.instruction = text('instruction');
  if (given('note')) f.note = text('note');
  if (given('clear-note')) {
    if (f.status === 'failed') fail('USAGE', `frame ${k} is where the demo stopped, and its note says why: correct it with --note instead`);
    delete f.note;
  }
  const was = demo.steps[k - 1];
  const changed = ['instruction', 'note'].filter(key => was[key] !== f[key]);
  if (!changed.length) fail('USAGE', `frame ${k} already says that; nothing was changed`);
  recordFoundTerms(p, next);
  const built = renderDemo(p, next, opts);
  recordRun(next, built);
  const dir = path.join(p.debug, 'amend');
  fs.mkdirSync(dir, { recursive: true });
  const name = `demo-${stampOf(new Date())}-frame-${pad3(k)}`;
  let kept = path.join(dir, `${name}.json`);
  for (let i = 2; fs.existsSync(kept); i++) kept = path.join(dir, `${name}-${i}.json`);
  fs.copyFileSync(p.demo, kept);
  writeJSON(p.demo, next);
  writeBuild(p, built);
  console.log(`amended frame ${k}:`);
  for (const key of changed) console.log(`  ${key}: ${was[key] === undefined ? '(none)' : JSON.stringify(was[key])} -> ${f[key] === undefined ? '(none)' : JSON.stringify(f[key])}`);
  console.log(`(demo.json as it was is kept in ${kept})`);
  printBuild(p, built);
}

// The iframe for a doc page, as HTML and as MDX (where style must be a JSX object). Without --embed-url,
// src assumes the folder is served at /demos/<slug>/. aspect-ratio keeps the frame in proportion at any
// column width; height="560" is the fallback for sites that strip the style attribute.
function embedSnippet(demo, embedUrl) {
  const slug = demo.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'demo';
  const base = embedUrl ? String(embedUrl).replace(/\/(index\.html)?$/, '') : `/demos/${slug}`;
  const attr = v => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const common = `src="${attr(base)}/index.html?embed" title="${attr(`Interactive demo: ${demo.title}`)}" width="100%" height="560"`;
  return {
    html: `<iframe ${common} style="width:100%;height:auto;aspect-ratio:4/3;border:0" loading="lazy"></iframe>`,
    mdx: `<iframe ${common} style={{ width: '100%', height: 'auto', aspectRatio: '4/3', border: 0 }} loading="lazy" />`,
  };
}

// ---------- duplicate findings ----------

// A finding is often noted twice on one doc step: on the act where the agent sees it, and again on a
// later frame of the step ("doc says click Save" after Create, then on the page Create opened). Two
// "doc says" notes are one finding when they are about the same words (one note's words contain the
// other's, at least two of them, without case, punctuation and small words) and what they say the UI
// shows shares a word. Other notes are the same only when their text is.
const SMALL_WORDS = new Set('a an the to of in on at for from by it its is are be that this then when after before and or with you your there'.split(' '));
const wordsOf = v => new Set((String(v || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => !SMALL_WORDS.has(w)));
const plainNote = v => String(v || '').replace(/^(?:setup|product|wording):\s*/i, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function sameFinding(a, b) {
  const doc = v => String(v || '').match(/\bdoc says\b([\s\S]*?)(?:;|\bUI shows\b|$)([\s\S]*)/i);
  const x = doc(a), y = doc(b);
  if (!x || !y) return plainNote(a) === plainNote(b);
  const [p, q] = [wordsOf(x[1]), wordsOf(y[1])];
  const [small, big] = p.size <= q.size ? [p, q] : [q, p];
  if (!small.size || ![...small].every(w => big.has(w)) || (small.size < big.size && small.size < 2)) return plainNote(a) === plainNote(b);
  const [u, v] = [wordsOf(x[2]), wordsOf(y[2])];
  return !u.size || !v.size || [...u].some(w => v.has(w));
}

// The findings of a list in order, without the ones that repeat an earlier finding of the same doc step.
const uniqueFindings = list => list.filter((f, i) => !f.note ||
  !list.slice(0, i).some(e => e.note && e.docStep === f.docStep && sameFinding(e.note, f.note)));

// Doc steps where the doc and the product disagree (a step the product itself failed is not one).
const mismatchCount = f => new Set([...f.failed, ...f.doc].map(x => x.docStep)).size + f.claims.filter(c => c.verdict === 'doc').length;
const productSteps = f => new Set(f.product.map(x => x.docStep)).size;

// What a frame whose action ran but did not end cleanly (an error after the click landed) asks of a person.
// One that was still being performed when its time ran out may not have reached the page at all.
const uncertainNote = u => u.startsWith(MAYBE)
  ? 'DocDemo could not confirm that the action reached the page. Check that the next frame shows its result, and that it was not done twice.'
  : 'the action ran, but DocDemo could not confirm that it finished. Check that the next frame shows its result.';
const uncertainWhy = u => u.startsWith(MAYBE) ? u.slice(MAYBE.length) : u;

// Sorts frame notes, check verdicts and the product's HTTP errors into what report.md lists.
function reportFindings(demo) {
  const out = { failed: [], product: [], doc: [], setup: [], wording: [], other: [], uncertain: [] };
  // A note on the final frame is about the last documented step, as that frame's HTTP errors are.
  let last;
  for (const s of demo.steps) {
    if (s.docStep !== undefined) last = s.docStep;
    const docStep = s.docStep ?? last;
    if (!s.note || docStep === undefined) continue;
    const note = s.note.replace(/^(?:setup|product|wording):\s*/i, '');
    const stopped = v => s.status === 'failed' ? `The demo stopped here: ${v}` : v;
    // A step the product, or the way this instance is set up, did not let DocDemo perform is not a doc error.
    if (/^product:/i.test(s.note)) out.product.push({ docStep, note: stopped(note) });
    else if (/^setup:/i.test(s.note)) out.setup.push({ docStep, note: stopped(note) });
    else out[s.status === 'failed' ? 'failed' : /^wording:/i.test(s.note) ? 'wording'
      : /doc says/i.test(s.note) ? 'doc' : 'other'].push({ docStep, note });
  }
  for (const v of (demo.checks || []).filter(v => v.verdict === 'doc' || v.verdict === 'setup'))
    out[v.verdict].push({ docStep: v.docStep, note: v.note.replace(/^setup:\s*/i, '') });
  // HTTP errors from the browser's network log: server errors, failed requests and error pages at every
  // step (0 is opening the app); 4xx responses from API calls only where a note says the product failed.
  // The final frame's errors came after the last action.
  // A capture keeps 20 errors at most, the serious ones first; how many more serious ones there were is said too.
  const blamed = new Set(out.product.map(f => f.docStep)), byStep = new Map([[0, demo.openHttp || []]]), notKept = new Map();
  let k = 0;
  for (const f of demo.steps) {
    if (f.docStep !== undefined) k = f.docStep;
    if (f.http?.length) byStep.set(k, mergeHttp(byStep.get(k), f.http));
    if (f.httpNotKept) notKept.set(k, (notKept.get(k) || 0) + f.httpNotKept);
    if (f.uncertain) out.uncertain.push({ docStep: k, note: `frame ${f.n} ("${clip(f.instruction, 80)}"): ${uncertainNote(f.uncertain)} (${uncertainWhy(f.uncertain)})` });
  }
  for (const [n, list] of byStep)
    for (const e of list) if (serious(e) || blamed.has(n)) out.product.push({ docStep: n, http: httpLine(e, demo.app.url) });
  for (const [n, more] of notKept) out.product.push({ docStep: n, http: `and ${more} more server error(s) or failed request(s), not kept` });
  for (const [group, list] of Object.entries(out)) out[group] = uniqueFindings(list.sort((a, b) => a.docStep - b.docStep));
  // Claims beyond the steps, with a verdict: the doc's errors first, then what depends on setup, what matched, what was not verified.
  out.claims = (demo.claims || []).filter(c => c.verdict).sort((a, b) => CLAIM_ORDER.indexOf(a.verdict) - CLAIM_ORDER.indexOf(b.verdict))
    .map(c => ({ ...c, problems: claimProblems(demo, c) }));
  return out;
}

// What went wrong while a claim was checked: the app's errors (the serious ones, as at the steps; and errors a capture
// that failed left with the claim itself) and actions that ran but did not end cleanly. Never put on a doc step.
function claimProblems(demo, c) {
  const errors = ({ id, http = [], httpNotKept }) => [...http.filter(serious).map(x => `${id}: ${httpLine(x, demo.app.url)}`),
    ...(httpNotKept ? [`${id}: and ${httpNotKept} more server error(s) or failed request(s), not kept`] : [])];
  return {
    http: [...c.evidence.flatMap(errors), ...errors(c)],
    uncertain: c.evidence.filter(e => e.uncertain).map(e => `${e.id} ("${clip(e.instruction, 80)}"): ${uncertainNote(e.uncertain)} (${uncertainWhy(e.uncertain)})`),
  };
}
const CLAIM_ORDER = ['doc', 'setup', 'ok', 'unverified'];
const CLAIM_LABEL = { doc: 'Doc mismatch', setup: 'Depends on setup', ok: 'Matches the doc', unverified: 'Not verified' };

// Each claim with its verdict, the note, and the frames it rests on: evidence frames link to their screenshots,
// the demo's own frames to their screen in review.html. Errors the app returned while a claim was checked go with it.
function claimSection(demo, claims) {
  if (!claims.length) return [];
  const entry = c => {
    const ev = new Map(c.evidence.map(e => [e.id, e]));
    const frames = (c.frames || []).map(f => ev.has(f) ? `${f} "${clip(ev.get(f).instruction, 80)}" ([screenshot](${ev.get(f).image}))` : `[screen ${f}](review.html#${f})`);
    return [`- **${CLAIM_LABEL[c.verdict]}:** "${c.quote.replace(/\s+/g, ' ')}"`, `  - ${c.note}`,
      ...(frames.length ? [`  - Evidence: ${frames.join('; ')}`] : []),
      ...c.problems.http.map(x => `  - The product returned an error at ${x}`), ...c.problems.uncertain.map(x => `  - Check ${x}`)].join('\n');
  };
  return [`## Claims beyond the steps (${claims.length})`, '',
    'Sentences of the doc that are not steps, checked in the app. Their screenshots are in `evidence/`, which readers never get.', '',
    ...claims.map(entry), ''];
}

function reportMarkdown(demo, summary, findings, snippet) {
  const stepText = n => (demo.doc.steps.find(d => d.index === n)?.text || '').replace(/\s+/g, ' ');
  // One entry per doc step, with each of its notes under it.
  const section = (heading, list, intro) => {
    const steps = [...new Set(list.map(f => f.docStep))];
    return steps.length ? [`## ${heading} (${steps.length})`, '', ...(intro ? [intro, ''] : []), ...steps.map(n =>
      `- **${n ? `Step ${n}:** ${stepText(n)}` : `Opening the app** (${demo.app.url})`}\n` +
      list.filter(f => f.docStep === n).map(f => `  - ${f.note || f.http}`).join('\n')), ''] : [];
  };
  const mismatches = mismatchCount(findings), errored = productSteps(findings), claimErrors = findings.claims.filter(c => c.problems.http.length).length;
  return [
    `# DocDemo report: ${demo.title}`,
    '',
    `- Doc: ${demo.doc.url}`,
    `- App: ${demo.app.url}${demo.app.version ? ` (version ${demo.app.version})` : ''}`,
    `- Run: ${demo.generatedAt}`,
    `- Result: ${summary}`,
    '',
    (mismatches ? `The doc and the product disagree in ${mismatches} place(s).` : errored || claimErrors
      ? 'The doc matched the product at every documented step DocDemo performed.'
      : 'No discrepancies: the product matched every documented step DocDemo performed.') +
      (errored ? ` The product returned errors in ${errored} step(s).` : '') +
      (claimErrors ? ` The product returned errors while ${claimErrors} claim(s) were checked.` : ''),
    '',
    ...section('The demo stopped here', findings.failed),
    ...section('The product returned errors', findings.product,
      'The HTTP errors are from the browser\'s network log while DocDemo performed the step.'),
    ...section('The doc and the product disagree', findings.doc),
    ...section('Differences that depend on how this app is set up', findings.setup),
    ...section('Wording to tighten', findings.wording,
      'Not doc errors: these steps work as written, but don\'t use the labels the UI shows.'),
    ...section('Other notes', findings.other),
    ...claimSection(demo, findings.claims),
    ...section('Frames to check', findings.uncertain, 'Check these frames in `review.html` before you publish the demo.'),
    '## Put this demo on a doc page',
    '',
    'Host `index.html` and the `assets/` folder with your doc site or on any static host. Nothing else in',
    'this folder is needed, so this report stays private. Then paste this where the demo should appear,',
    'with `src` pointing to where `index.html` is served:',
    '',
    '```html',
    snippet.html,
    '```',
    '',
    'In MDX pages (Docusaurus, Mintlify, ReadMe), use this form instead:',
    '',
    '```jsx',
    snippet.mdx,
    '```',
    '',
  ].join('\n');
}

// done, build and close in one command, at the end of a run. Nothing is recorded while a documented
// step has no frame or a check is open, so the run can still be completed; run it again after a fix.
function finishCommand(opts, seq = []) {
  const p = paths(opts);
  const demo = loadDemo(p);
  if (!demo.steps.length || demo.steps.at(-1).docStep !== undefined) {
    const { answers, note } = claimAnswers(seq);
    if (answers.length) answerWith(p, demo, answers, undefined);
    const errs = unfinished(demo, p);
    if (errs.length) fail('VALIDATION', `${errs.join('\n')}\nThe final frame was not recorded: fix these, then run finish again.`);
    frameCommand('done', opts, [], note === undefined ? [] : [['note', note]]);
  }
  buildCommand(opts);
  pw(['close'], { allowFail: true });
  console.log('closed the browser');
}

// ---------- main ----------

const HELP = `docdemo ${VERSION}: turn a documented procedure into a clickable demo

  docdemo doc   --url <doc-url>                         fetch the doc into <out>/source.md, print it and an outline
                                                        of its numbered lists (L1, L2, ...)
  docdemo init  --title T --doc-url U --app-url A --list L1 [--select 1-4,6] [--kind 5=optional] [--choose 2=a] [--open]
                [--id <procedure-id>] [--app-version V]
                                                        the doc steps from a list in that outline, verbatim
                                                        (or --steps <steps.json> instead of --list);
                                                        --open: also run "open", with the same options
  docdemo open  [--headed] [--state auth.json] [--browser chromium]   open the app in the playwright-cli session
                                                        ("dd", or $DOCDEMO_SESSION) and print its snapshot
  docdemo act   --doc-step N --instruction "..." --ref e12 [--expect "Name"] <click|fill|select|check|hover> [value]
  docdemo act   --doc-step N --instruction "..." --ref e12 [--expect "Name"] drag [--from x,y] --to x,y
                                                        sweep within the element (x,y: fractions of its box)
  docdemo act   --doc-step N --instruction "..." --ref e12 [--expect "Name"] drag [--from x,y] --to-ref e34
                                                        drag the element onto another one
  docdemo act   --doc-step N --instruction "..." --key Enter
                                                        act also takes --dialog dismiss: answer a browser dialog
                                                        the action opens with Cancel instead of OK
  docdemo note  --doc-step N --instruction "..." [--note "..."]
  docdemo fail  --doc-step N --instruction "..." --note "doc says X; UI shows Y"
  docdemo check --doc-step N --claim "..." --verdict ok|doc|setup|noted|not-ui --note "..." [--claim ... --verdict ... --note ...]
  docdemo claim --quote "..." [--verdict ... --note "..." --frames 7] [--quote ...]
                                                        record sentences of the doc that are not steps (a default, a
                                                        limit, an order, what a setting does) as claims c1, c2, ...;
                                                        with the verdict when recorded frames already show it
  docdemo act|note --evidence c1 --instruction "..." [act's options]
                                                        after done: record what the app shows for a claim (E1, E2, ...);
                                                        readers never get these frames
  docdemo check --claim-id c1 --verdict ok|doc|setup|unverified --note "..." [--frames E1,7] [--claim-id ...]
                                                        the verdict on a claim, and the frames it rests on
  docdemo peek  --ref e12                               hover an element to read what it shows (a tooltip, an exact
                                                        time) and print the page; nothing is recorded
  docdemo get   <path or URL>                           a read-only GET to the app's origin with the browser's
                                                        session; prints the status and the response (secrets hidden)
  docdemo done  [--instruction "..."]
  docdemo build [--embed-url <url>]                      validate and write <out>/index.html and report.md
                                                        (--embed-url: where the folder will be hosted, for the snippet)
  docdemo finish [--instruction "..."] [--embed-url <url>]   done, build and close in one command
  docdemo amend --frame N [--instruction "..."] [--note "..." | --clear-note] [--embed-url <url>]
                                                        correct what a frame of a finished demo says, and build again
                                                        (N as review.html numbers the screens)
  docdemo close
  docdemo login --url <app-url> [--state file] [--wait seconds] [--browser chromium]
                                                        open a visible browser; the user signs in and closes it;
                                                        the session is kept in ./docdemo-auth.json
  docdemo login --save [--state file]                  keep the session now, without waiting for the window
  docdemo signin [--username-ref e1] [--password-ref e2] [--submit-ref e3]
                                                        sign in with DOCDEMO_USERNAME / DOCDEMO_PASSWORD from the
                                                        environment or ./.env (values are never printed)

act and note print the page's snapshot afterwards, and any HTTP errors from the browser's network log.
act, note, fail, done and finish also take --claim "..." --verdict ... --note "..." groups, which answer the checks
of the doc steps performed so far (a frame's own --note goes before the first --claim).
All commands accept --out <dir> (default ./demo). Put values that start with -- after a -- marker.
Exit codes: 0 ok, 1 usage, 2 STALE_REF, 3 NO_BOX, 4 REF_MISMATCH, 5 ACTION_FAILED, 6 VALIDATION.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { opts, pos, seq } = parseArgs(rest);
  switch (cmd) {
    case 'doc': return docCommand(opts);
    case 'init': return initCommand(opts);
    case 'open': return openCommand(opts);
    case 'act': case 'note': case 'fail': case 'done':
      return opts.evidence !== undefined ? evidenceCommand(cmd, opts, pos) : frameCommand(cmd, opts, pos, seq);
    case 'check': return seq.some(([k]) => k === 'claim-id') ? claimCheckCommand(opts, seq) : checkCommand(opts, seq);
    case 'claim': return claimCommand(opts, seq);
    case 'build': return buildCommand(opts);
    case 'amend': return amendCommand(opts);
    case 'finish': return finishCommand(opts, seq);
    case 'peek': return peekCommand(opts);
    case 'get': return getCommand(opts, pos);
    case 'login': return loginCommand(opts);
    case 'signin': return signinCommand(opts);
    case 'close': pw(['close'], { allowFail: true }); return console.log('closed');
    case '--version': case '-v': return console.log(VERSION);
    case undefined: case 'help': case '--help': case '-h': return console.log(HELP);
    default: fail('USAGE', `unknown command "${cmd}"\n\n${HELP}`);
  }
}

// For the smoke test's checks of the parts that need no browser.
export const forTests = { termOnPage, hideSecrets, endsOrDeletes, redact, redactValue, htmlToText, why, docOutline, uncertainWarning, numberedLists, listOutline, docHash };

// Run as a command; importing this file (the benchmark and the smoke test do) runs nothing.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => {
  const code = e instanceof Fail ? e.code : 'USAGE';
  console.error(`${code}\n${e instanceof Fail ? e.message : `unexpected error: ${e.stack || e}`}`);
  process.exit(EXIT[code] ?? 5);
});
