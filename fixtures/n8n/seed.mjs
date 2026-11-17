#!/usr/bin/env node
// Seed a fresh n8n instance for the DocDemo benchmark: owner account, tags, sample workflows
// (fixed IDs so cases.json can deep-link to them), a few workflow versions and executions.
// Usage: node seed.mjs [baseUrl]   Called by up.sh; safe to call only on a fresh instance.
const BASE = process.argv[2] || 'http://localhost:5678';
const OWNER = { email: 'admin@docdemo.local', firstName: 'Doc', lastName: 'Demo', password: 'DocDemo-admin-1' };
let cookie = '';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  const auth = set.find((c) => c.startsWith('n8n-auth='));
  if (auth) cookie = auth.split(';')[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text).data : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MANUAL = 'When clicking ‘Execute workflow’';
const manual = { id: 'dd-manual', name: MANUAL, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} };
const setNode = (name, value, x = 220) => ({
  id: `dd-set-${x}`, name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [x, 0],
  parameters: { assignments: { assignments: [{ id: 'dd-a1', name: 'greeting', value, type: 'string' }] }, options: {} },
});
const link = (from, to) => ({ [from]: { main: [[{ node: to, type: 'main', index: 0 }]] } });

async function main() {
  await api('POST', '/rest/owner/setup', OWNER);
  // Skip the "tell us about yourself" survey if the instance still asks for it.
  await api('POST', '/rest/me/survey', { version: 'v4', personalization_survey_submitted_at: new Date().toISOString(), personalization_survey_n8n_version: 'docdemo' }).catch(() => {});

  const tag = {};
  for (const name of ['docdemo-sales', 'docdemo-reports', 'docdemo-ops']) tag[name] = (await api('POST', '/rest/tags', { name })).id;

  // 1. DocDemo Sample: Manual trigger -> Edit Fields. Used by tag, settings, pin-data, history cases.
  const sample = await api('POST', '/rest/workflows', {
    id: 'DocDemoSample001', name: 'DocDemo Sample', tags: [tag['docdemo-sales']],
    nodes: [manual, setNode('Edit Fields', 'Hello from DocDemo')], connections: link(MANUAL, 'Edit Fields'),
    settings: { executionOrder: 'v1' },
  });
  // A second version so workflow history has something to restore.
  await api('PATCH', `/rest/workflows/${sample.id}`, {
    versionId: sample.versionId, nodes: [manual, setNode('Edit Fields', 'Hello again from DocDemo')],
    connections: link(MANUAL, 'Edit Fields'),
  });

  // 2. DocDemo Weekly Report: Schedule trigger -> Edit Fields, never published (publish case).
  await api('POST', '/rest/workflows', {
    id: 'DocDemoSchedule1', name: 'DocDemo Weekly Report', tags: [tag['docdemo-reports']],
    nodes: [
      { id: 'dd-sched', name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0],
        parameters: { rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 9, triggerAtMinute: 0 }] } } },
      setNode('Build report', 'Weekly report'),
    ],
    connections: link('Schedule Trigger', 'Build report'), settings: { executionOrder: 'v1' },
  });

  // 3. DocDemo Flaky Job: two successful runs, then a Stop and Error node and two failed runs.
  const flaky = await api('POST', '/rest/workflows', {
    id: 'DocDemoFlaky0001', name: 'DocDemo Flaky Job', tags: [tag['docdemo-ops']],
    nodes: [manual, setNode('Edit Fields', 'ok')], connections: link(MANUAL, 'Edit Fields'),
    settings: { executionOrder: 'v1' },
  });
  const run = (id) => api('POST', `/rest/workflows/${id}/run`, { triggerToStartFrom: { name: MANUAL } });
  await run(flaky.id); await sleep(700); await run(flaky.id); await sleep(700);
  await api('PATCH', `/rest/workflows/${flaky.id}`, {
    versionId: flaky.versionId,
    nodes: [manual, { id: 'dd-stop', name: 'Stop and Error', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [220, 0],
      parameters: { errorMessage: 'DocDemo simulated failure' } }],
    connections: link(MANUAL, 'Stop and Error'),
  });
  await run(flaky.id); await sleep(700); await run(flaky.id);

  // 4. A second sales workflow so tag filtering shows more than one match.
  await api('POST', '/rest/workflows', {
    id: 'DocDemoLeadSync1', name: 'DocDemo Lead Sync', tags: [tag['docdemo-sales']],
    nodes: [manual, setNode('Edit Fields', 'leads')], connections: link(MANUAL, 'Edit Fields'),
    settings: { executionOrder: 'v1' },
  });

  // Wait for the manual runs to be persisted.
  for (let i = 0; i < 20; i++) {
    const ex = await api('GET', '/rest/executions?filter=' + encodeURIComponent(JSON.stringify({ workflowId: flaky.id })));
    const rows = ex.results ?? ex;
    if (rows.length >= 4 && rows.every((r) => r.status !== 'running' && r.status !== 'new')) {
      console.log(`seeded: 4 workflows, 3 tags, ${rows.length} executions (${rows.map((r) => r.status).join(', ')})`);
      return;
    }
    await sleep(500);
  }
  throw new Error('executions did not finish');
}

main().catch((e) => { console.error(`seed failed: ${e.message}`); process.exit(1); });
