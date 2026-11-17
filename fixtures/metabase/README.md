# Metabase fixture

- Image: `metabase/metabase:v0.63.18.2` (open-source edition), container `docdemo-metabase`, bound to `127.0.0.1:3001` -> app URL http://localhost:3001
- Docs: https://www.metabase.com/docs/v0.63/ (all 10 cases fetch with method `html`; the site serves no `.md` pages)
- Credentials: `admin@docdemo.example` / `docdemo-admin-1` (fake, local only)
- Memory: JVM capped with `-Xmx1g`; startup plus seeding takes about 25 s

## Scripts

- `./up.sh` removes any old container, starts a fresh one (no volume, so every run starts clean), waits for `/api/health`, then runs `node seed.mjs`. The script fails if the seeded ids differ from the ones `cases.json` uses.
- `./auth.sh <out-file>` logs in through `POST /api/session` and writes a Playwright storage state with the `metabase.SESSION`, `metabase.DEVICE` and `metabase.TIMEOUT` cookies for `localhost`.
- `./down.sh` removes the container.

## What seed.mjs creates

- First-run setup through `/api/setup`, using the setup token from `/api/session/properties`. The admin is DocDemo Admin, the site name is DocDemo, and tracking is off.
- The built-in Sample Database (id 1). Metabase also adds its own "Examples" collection with the "E-commerce Insights" dashboard (ids 1 to 39).
- Collection **DocDemo Collection** (id 5, top level).
- Question **DocDemo Orders** (id 40): a raw Orders table. It has two extra description edits, so its History lists three versions.
- Question **DocDemo Orders by Category** (id 41): a bar chart of order count by Product -> Category.
- Dashboard **DocDemo Sales Dashboard** (id 2): both questions, plus text filters **Category** and **Vendor** that are connected to both cards through `Product ID`.
- The admin's `is_qbnewb` flag is cleared, so the one-time "It's okay to play around with saved questions" modal does not cover saved questions.

## Quirks

- Case start URLs use the ids above (`/question/40`, `/dashboard/2`). `up.sh` checks those ids.
- The dashboard URL picks up `?category=&vendor=` when it opens. This is normal.
- In dashboard edit mode, filter pills have no gear icon. Clicking a pill opens the sidebar with the tabs "Filter settings" and "Linked filters".
- The question menu is labeled "Move, trash, and more…" and the info button is "More info". "Turn into a model" is worded differently from the docs.
- Nothing is configured for email or Slack, so avoid alerts and subscriptions.
- Mantine switches (Freeze columns/rows, linked-filter toggles) hide the real `<input role=switch>`: `act click`/`check` on the named switch fails with ACTION_FAILED. Click the unnamed `aria-hidden` sibling (the switch track) instead.
- Leaving a dashboard with unsaved edits triggers a `beforeunload` dialog (a navigation will hang until `playwright-cli dialog-accept`).
