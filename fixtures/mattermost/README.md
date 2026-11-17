# Mattermost fixture

- **Image:** `mattermost/mattermost-preview:11.11.1` (Team Edition 11.11.1 plus bundled PostgreSQL 14, one container). amd64 only, so on Apple silicon it runs under emulation: about 45 s from `up.sh` to a seeded instance, about 500 MB RAM.
- **URL:** http://localhost:8065 (bound to 127.0.0.1). Container `docdemo-mattermost`, started with `--rm` and no volume, so `up.sh` always starts clean.
- **Docs:** docs.mattermost.com, which has only one (latest) version. It documents behavior up to v11.10 and v11.11 ("from v11.8" and similar), so it matches this image. Pages are fetched as HTML (`method: html`); the site serves no `.md`.
- **Credentials:** `admin` / `docdemo-admin-1` (system admin). Second user: `jordan.lee` / `docdemo-user-1`.

## Scripts

- `up.sh`: removes any old container and its volume, starts a new one, waits for `/api/v4/system/ping` and `mmctl --local`, then seeds the data. Prints the URL.
- `auth.sh <out-file>`: logs in as admin through `POST /api/v4/users/login` (with `X-Requested-With: XMLHttpRequest`, or Mattermost sets no cookies). It writes the `MMAUTHTOKEN`, `MMUSERID` and `MMCSRF` cookies plus localStorage `__landingPageSeen__=true` as a Playwright storage state. Without that key, deep links such as `/docdemo/channels/project-alpha` land on the "open in desktop app?" page.
- `down.sh`: removes the container.

## Seed data (up.sh)

- Config set with env vars: local mode on; tutorial, onboarding flow, admin and user notices, security alerts and diagnostics off. Env-set settings are read-only in the System Console, and no case touches them.
- Calls and Agents (AI) plugins disabled. Playbooks is disabled by default in the image.
- Team `docdemo` ("DocDemo Team") with admin and jordan.lee.
- Channels: `project-alpha` "Project Alpha" (admin and jordan.lee) and `design-reviews` "Design Reviews" (jordan.lee only, so admin can browse and join it).
- Posts by admin: two in Town Square, and two in Project Alpha. One of the Project Alpha posts was edited from "Launch date is March 3." to "Launch date is March 10.", so it has edit history.
- Admin's sidebar has a custom category "Launch Work" that holds Project Alpha.
- Admin preferences that turn off first-run tours, tips, the onboarding checklist and the drafts and app-bar tour tips.

## Known quirks

- A blue "We need your permission to show notifications in the browser." bar is always at the top, because headless Chrome's notification permission is "default". It can be closed and does not block anything.
- Team Edition has no license, so custom user groups (Professional) cannot be tested and are not a case. Custom emoji needs a file upload, which the helper cannot do, so it is not a case either.
- Most end-user pages have Web/Desktop and Mobile tabs. The HTML text shows both numbered lists one after the other, with the Web/Desktop list first, and headings can repeat. A `#fragment` resolves to the first match, which is Web/Desktop.
- The HTML-to-text conversion drops inline icons, so some doc sentences read "select the next to ...".
- Hover-only controls: a message's `more` button and a sidebar category's `... category options` button appear only while hovered.
- On System Console > Permissions > System Scheme, the checkboxes are divs with no checkbox role, so their state is not in the accessibility snapshot.
