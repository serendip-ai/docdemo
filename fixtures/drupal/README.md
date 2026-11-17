# Drupal fixture

- **Image:** `drupal:11.4.8-apache` (standard install profile, SQLite inside the container), container `docdemo-drupal`, bound to `127.0.0.1:3003`, so the app URL is http://localhost:3003. Native arm64 and amd64.
- **Docs:** the Drupal User Guide, https://www.drupal.org/docs/user_guide/en/ (fetched as HTML; the site serves no `.md`). Headings carry ids such as `#s-configuring-default-regional-settings`.
- **Credentials:** `admin` / `docdemo-admin-1` (fake, local only).

## Scripts

- `up.sh` removes any old container, starts a fresh one, waits for Apache, then installs Drupal with `core/scripts/dr install standard --site-name 'DocDemo Site'`. It takes about 6 seconds once the image is pulled.
- `auth.sh <out-file>` signs in through the login form (it reads `form_build_id` from `/user/login` first) and writes the `SESS…` cookie as a Playwright storage state. It checks that `/admin/config` returns 200.
- `down.sh` stops the container (it was started with `--rm`, so it is also removed).

## Quirks

- The image keeps `vendor/` in `/opt/drupal`, but `core/scripts/dr` looks for it next to `web/`. `up.sh` links `web/vendor` to `../vendor` before installing.
- Drupal builds its forms from native HTML controls, so its settings pages use native `<select>` elements. They exercise the player's pick-from-list steps, including `<optgroup>` groups (the time zone list is grouped by region).
- Drupal 11 replaced the Toolbar's **Manage** tray with the **Administrative sidebar** (Navigation module), but the User Guide still says "In the Manage administrative menu".
- Doc/UI differences confirmed on 11.4.8: Regional settings step 1 says **Regional and language**; the menu says **Region and language**.
