// Seed a fresh Metabase (run by up.sh): first-run setup, then DocDemo content used by cases.json.
// Usage: node seed.mjs <base-url>
const B = process.argv[2] || 'http://localhost:3001';
const EMAIL = 'admin@docdemo.example';
const PASSWORD = 'docdemo-admin-1';
let session = null;

async function api(method, path, body) {
  const res = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(session ? { 'X-Metabase-Session': session } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const props = await api('GET', '/api/session/properties');
if (!props['has-user-setup']) {
  await api('POST', '/api/setup', {
    token: props['setup-token'],
    user: { first_name: 'DocDemo', last_name: 'Admin', email: EMAIL, password: PASSWORD, password_confirm: PASSWORD },
    prefs: { site_name: 'DocDemo', site_locale: 'en', allow_tracking: false },
  });
}
session = (await api('POST', '/api/session', { username: EMAIL, password: PASSWORD })).id;

// Wait for the Sample Database to be synced (fields present).
let meta;
for (let i = 0; i < 60; i++) {
  const dbs = (await api('GET', '/api/database')).data;
  const sample = dbs.find(d => d.is_sample);
  if (sample) {
    meta = await api('GET', `/api/database/${sample.id}/metadata`);
    if (meta.tables.some(t => t.name === 'PRODUCTS' && t.fields.length > 5)) break;
  }
  await new Promise(r => setTimeout(r, 1000));
}
if (!meta) throw new Error('Sample Database not found');
const DB = meta.id;
const table = n => meta.tables.find(t => t.name === n);
const field = (t, f) => table(t).fields.find(x => x.name === f).id;
const ORDERS = table('ORDERS').id;
const PRODUCT_ID = field('ORDERS', 'PRODUCT_ID');
const CATEGORY = field('PRODUCTS', 'CATEGORY');
const VENDOR = field('PRODUCTS', 'VENDOR');

// Don't show the "what's new" / onboarding popups to the demo browser.
for (const [k, v] of [['show-sdk-embed-terms', false], ['dismissed-onboarding-sidebar-link', true]]) {
  try { await api('PUT', `/api/setting/${k}`, { value: v }); } catch { /* setting may not exist in this version */ }
}

// Dismiss the one-time "It's okay to play around with saved questions" modal for the admin.
const me = await api('GET', '/api/user/current');
if (me.is_qbnewb) await api('PUT', `/api/user/${me.id}/modal/qbnewb`);

const coll = await api('POST', '/api/collection', { name: 'DocDemo Collection', description: 'Seeded by the DocDemo fixture', parent_id: null });

const legacy = query => ({ database: DB, type: 'query', query });
const ordersCard = await api('POST', '/api/card', {
  name: 'DocDemo Orders', display: 'table', visualization_settings: {}, collection_id: coll.id,
  dataset_query: legacy({ 'source-table': ORDERS }),
});
// Two edits so the question has several revisions in its history.
await api('PUT', `/api/card/${ordersCard.id}`, { description: 'All orders (first revision)' });
await api('PUT', `/api/card/${ordersCard.id}`, { description: 'All orders from the Sample Database' });

const byCategory = await api('POST', '/api/card', {
  name: 'DocDemo Orders by Category', display: 'bar', visualization_settings: {}, collection_id: coll.id,
  dataset_query: legacy({
    'source-table': ORDERS,
    aggregation: [['count']],
    breakout: [['field', CATEGORY, { 'source-field': PRODUCT_ID }]],
  }),
});

const dash = await api('POST', '/api/dashboard', { name: 'DocDemo Sales Dashboard', collection_id: coll.id });
const parameters = [
  { id: 'dd0cat01', name: 'Category', slug: 'category', type: 'string/=', sectionId: 'string' },
  { id: 'dd0ven01', name: 'Vendor', slug: 'vendor', type: 'string/=', sectionId: 'string' },
];
const map = (card) => [
  { parameter_id: 'dd0cat01', card_id: card, target: ['dimension', ['field', CATEGORY, { 'base-type': 'type/Text', 'source-field': PRODUCT_ID }], { 'stage-number': 0 }] },
  { parameter_id: 'dd0ven01', card_id: card, target: ['dimension', ['field', VENDOR, { 'base-type': 'type/Text', 'source-field': PRODUCT_ID }], { 'stage-number': 0 }] },
];
await api('PUT', `/api/dashboard/${dash.id}`, {
  parameters,
  dashcards: [
    { id: -1, card_id: byCategory.id, row: 0, col: 0, size_x: 12, size_y: 6, parameter_mappings: map(byCategory.id), visualization_settings: {} },
    { id: -2, card_id: ordersCard.id, row: 0, col: 12, size_x: 12, size_y: 6, parameter_mappings: map(ordersCard.id), visualization_settings: {} },
  ],
});

console.log(JSON.stringify({ collection: coll.id, ordersCard: ordersCard.id, byCategoryCard: byCategory.id, dashboard: dash.id }));
