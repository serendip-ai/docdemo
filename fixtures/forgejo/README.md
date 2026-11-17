# Forgejo fixture

- Image: `codeberg.org/forgejo/forgejo:16.0.5` (SQLite, install wizard skipped with `INSTALL_LOCK=true`, no volume)
- Docs: https://forgejo.org/docs/v16.0/ (the versioned docs that match the image)
- URL: http://localhost:3002 (bound to 127.0.0.1; container name `docdemo-forgejo`)
- Credentials (fake): `docdemo-admin` / `docdemo-admin-1` (site admin); `docdemo-user2` / `docdemo-user2-1`

## Scripts

- `./up.sh` removes any old container, starts a fresh one, waits for `/api/healthz` and seeds. Takes about 5 s once the image is pulled.
- `./auth.sh <out-file>` signs in over HTTP (`POST /user/login`) and writes a Playwright storage state with the `session` and `persistent` cookies. It checks that `/` renders the signed-in dashboard.
- `./down.sh` stops the container (it was started with `--rm`, so it is also removed).

## What up.sh seeds

- Users `docdemo-admin` (admin) and `docdemo-user2`, created with `forgejo admin user create`.
- Public repo `docdemo-admin/docdemo-repo` (branch `main`), with 3 commits: an initial README, "Expand README" and "Add hello.py". The blame case needs the history.
- Two generic packages owned by `docdemo-admin`: `docdemo-tool` 1.0.0, linked to `docdemo-repo`, and `docdemo-lib` 0.1.0, not linked.

## Quirks

- Forgejo listens on port 3002 inside the container too, and `migrations.ALLOW_LOCALNETWORKS=true`. That lets the pull-mirror case migrate from `http://localhost:3002/docdemo-admin/docdemo-repo.git`, the instance itself, with no external service.
- Registration, mail and SSH are disabled. The image still starts its internal sshd, but that port is not published.
- Login has no `_csrf` form field in 16.0; a plain form POST works.
- The Forgejo user guide is mostly prose. Only a few pages have numbered procedures (packages, repo-mirror, protection, blame), so all 9 cases use those. A prose case (Creating Labels) was dropped: the skill stops when a page has no procedure, so its expected outcome was ambiguous.
- The `#pushing-to-a-remote-repository` fragment also prints the GitHub, GitLab and Bitbucket subsections, each with its own numbered list. Only the first list (steps 1-5) is under test.
- Known real doc/UI differences found while building the fixture:
  - Protected tags: the doc says **Save**, but the button is **Add rule**.
  - Disable the Package Registry: the doc says **Enable Repository Packages Registry**, but in 16.0 it is **Enable package linking**, under Settings > Units.
