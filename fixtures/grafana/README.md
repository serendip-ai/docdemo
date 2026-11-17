# Grafana fixture

- **Image:** `grafana/grafana:13.2.2` (OSS), container `docdemo-grafana`, bound to `127.0.0.1:3000` only. No volume, so `up.sh` always starts clean.
- **Docs:** https://grafana.com/docs/grafana/v13.2/ (serves markdown at `<path>.md`, so `docdemo doc` uses method `md`). Dashboard pages live under `/visualizations/dashboards/`; the old `/dashboards/` paths 301 there.
- **Credentials:** `admin` / `docdemo-admin-1` (server admin, org Admin). Seeded second user: `dana` / `docdemo-user-1` ("Dana Demo", Viewer). All fake.

## Scripts

- `up.sh` removes any old container, starts a fresh one, waits for `/api/health` and a working admin login, then seeds through the HTTP API. Prints the URL.
- `auth.sh <out-file>` logs in with `POST /login` and converts the `grafana_session` / `grafana_session_expiry` cookies into a Playwright storage-state JSON. It takes under a second and needs no browser.
- `down.sh` stops the container (`--rm` removes it).

## Seeded state

- Provisioned (`provisioning/`): TestData data source `docdemo-testdata` (default); dashboards "CPU overview" and "Request latency", tagged `docdemo`. They are provisioned, so the UI cannot save changes to them.
- Seeded by `up.sh`: user `dana`; team "DocDemo Team" (admin is its team Admin); dashboard "DocDemo Sandbox" (uid `docdemo-sandbox`, tag `docdemo`, one TestData panel "Sandbox traffic"). The sandbox is a normal dashboard and can be saved, so the library panel and variable cases use it.

## Quirks

- Anonymous access is off. With anonymous Admin (the old setup), `/api/user/teams` and `/api/user/stars` return 401 and an "Unauthorized" toast appears on first load. Signed in with `auth.sh`'s state, both return 200 and no toast appears.
- The UI uses the dark theme even though DocDemo asks for a light color scheme, because Grafana's default theme is dark.
- Add member (13.2.2): the first dropdown in the Add member panel, labelled "Role to add new permission to", picks the member type ("User"). The user picker only appears after that. Typing a name into the first dropdown finds nothing.
- Nothing needs email, OAuth or external services. For the contact point case, use a Webhook with a dummy `127.0.0.1` URL and do not test it.
- Doc-vs-UI mismatches confirmed by the independent check on 13.2.2: create team step 5 (there is no Save after Create), custom variable step 4 (there is no Preview button; the preview is live), contact point steps 1 and 3 (the nav item is "Alerting", not "Alerts & IRM", and there is no Alertmanager dropdown), and playlist step 3 (an empty instance shows "Create playlist", not "New playlist"). Details are in each case's `notes`.
- Not included: annotations. You have to click a data point on a canvas, and ref-based `act` cannot target it reliably.
