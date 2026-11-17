#!/usr/bin/env bash
# Write a Playwright storage-state JSON signed in as the seeded admin: auth.sh <out-file>
set -euo pipefail
OUT="${1:?usage: auth.sh <out-file>}"
URL="${METABASE_URL:-http://localhost:${PORT:-3001}}"
node - "$URL" "$OUT" <<'JS'
const [base, out] = process.argv.slice(2);
const res = await fetch(base + '/api/session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin@docdemo.example', password: 'docdemo-admin-1' }),
});
if (!res.ok) { console.error(`login failed: ${res.status} ${await res.text()}`); process.exit(1); }
const host = new URL(base).hostname;
const cookies = res.headers.getSetCookie().map(line => {
  const [pair, ...attrs] = line.split(';').map(s => s.trim());
  const eq = pair.indexOf('=');
  const c = { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: host, path: '/', expires: -1,
    httpOnly: false, secure: false, sameSite: 'Lax' };
  for (const a of attrs) {
    const [k, v] = a.split('=');
    const key = k.toLowerCase();
    if (key === 'httponly') c.httpOnly = true;
    else if (key === 'secure') c.secure = true;
    else if (key === 'path') c.path = v;
    else if (key === 'max-age') c.expires = Math.floor(Date.now() / 1000) + Number(v);
    else if (key === 'expires' && c.expires === -1) c.expires = Math.floor(Date.parse(v) / 1000);
    else if (key === 'samesite') c.sameSite = v[0].toUpperCase() + v.slice(1).toLowerCase();
  }
  return c;
});
if (!cookies.some(c => c.name === 'metabase.SESSION')) { console.error('no metabase.SESSION cookie'); process.exit(1); }
const fs = await import('node:fs');
fs.writeFileSync(out, JSON.stringify({ cookies, origins: [] }, null, 2));
console.log(`wrote ${out}`);
JS
