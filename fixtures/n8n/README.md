# n8n fixture

- **Image:** `docker.n8n.io/n8nio/n8n:2.40.6` (the `stable`/`latest` tag on 2026-09-24), container `docdemo-n8n`, `127.0.0.1:5678`, no volume (SQLite inside the container, so `up.sh` always starts fresh).
- **Docs:** docs.n8n.io (the GitBook site, restructured under `/build/...`, `/administer/...`), which tracks the current stable release. Fetched 2026-09-24.
- **Sign-in:** owner `admin@docdemo.local` / `DocDemo-admin-1` (fake). `auth.sh <out>` logs in over `POST /rest/login` and writes the `n8n-auth` cookie as Playwright storage state; it takes about a second.
- **Edition:** Community (no license). There are no team projects, variables, debug in editor, named versions or custom execution filters. Only the last 24 hours of workflow history are kept.

## Scripts

- `up.sh`: removes any old container, starts a new one, waits for `/healthz/readiness`, then runs `seed.mjs`. Takes about 15 seconds.
- `seed.mjs`: sets up the owner with `/rest/owner/setup`, then seeds these (fixed IDs, so cases can link to them directly):
  - tags `docdemo-sales`, `docdemo-reports`, `docdemo-ops`
  - `DocDemoSample001` **DocDemo Sample**: Manual trigger → Edit Fields. Tagged sales. Has 2 versions.
  - `DocDemoSchedule1` **DocDemo Weekly Report**: Schedule Trigger (weekly, Monday 09:00 UTC) → Edit Fields. Tagged reports. Never published.
  - `DocDemoFlaky0001` **DocDemo Flaky Job**: Manual trigger → Stop and Error. Tagged ops. Has 4 manual executions: 2 succeeded (from an earlier version) and 2 errored.
  - `DocDemoLeadSync1` **DocDemo Lead Sync**: Manual trigger → Edit Fields. Tagged sales.
- `auth.sh <out-file>`: writes the storage state. Needs a running, seeded instance.
- `down.sh`: stops and removes the container.

## Known quirks

- `/` redirects to `/assistant`, an n8n Assistant promo page. That's why cases start at `/home/workflows` (the Overview page) instead.
- `/workflow/new` creates an empty workflow right away and redirects to `/workflow/<id>?new=true`.
- Templates are turned off (`N8N_TEMPLATES_ENABLED=false`) because they need internet access. Telemetry, the personalization survey and version checks are also off.
- The workflow header has two **More actions** buttons. The one next to the workflow name holds Rename, Edit description and tags, Settings and Version history. The one next to **Publish** holds publish options.
- The docs pages come back as Markdown (`method: md`). GitBook headings look like `## Title <a href="#x" id="x"></a>`, and the helper's `#fragment` matcher doesn't recognize that form. So `doc` prints `no heading matched`, then prints the whole page. The procedure is still in the output.
- The container runs with `GENERIC_TIMEZONE=Etc/UTC`. With plain `UTC`, the workflow Settings modal showed "Default - Default Timezone not valid".
- An error workflow can only be chosen in another workflow's **Settings > Error Workflow** after it is **published**. Until then the option is disabled with the tooltip "Not published...". The docs don't mention this (see `n8n-error-workflow`).
- `n8n-restore-version` starts on `/workflow/DocDemoSample001/history`, the view that section assumes. The older version sits in a collapsed "1 version" group.
- Tags you add through **Edit description and tags** don't show next to the workflow name in the header (the docs say they do).
