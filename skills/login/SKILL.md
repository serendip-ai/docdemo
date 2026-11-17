---
name: login
description: Sign in to a web app once so that DocDemo runs start signed in. Opens a browser window at the app, the user signs in by hand (SSO and 2-factor work), and the session is saved to ./docdemo-auth.json. Use when the user runs /docdemo:login, asks to sign in or log in for DocDemo, or a DocDemo run reported that the app shows a sign-in page.
argument-hint: <app-url>
arguments: [app_url]
license: Apache-2.0
compatibility: Claude Code on a local machine with a display. Requires Node 20+ and @playwright/cli 0.1.21, the same as /docdemo:docdemo.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/docdemo/scripts/docdemo.mjs" login *)
disallowed-tools: Read(./.env) Read(./.env.*) Read(./docdemo-auth.json)
---

# Sign in for DocDemo

App URL: $app_url

If it is empty, stop and tell the user to run `/docdemo:login <app-url>` (the address of the app's start or
sign-in page).

The helper is `node "${CLAUDE_PLUGIN_ROOT}/skills/docdemo/scripts/docdemo.mjs"` (written `H` below). Type the
full command exactly like that, with the quotes, and run each command on its own.

1. Tell the user, in two short sentences: a browser window is about to open at the app; sign in there the
   way they normally do (single sign-on and 2-factor are fine), then close that window, and DocDemo will
   keep the session.
2. Run `H login --url "$app_url"` with the Bash timeout set to 600000 (10 minutes). It opens the window and
   waits until the user closes it.
3. Tell the user what it printed, including any WARNING. If it warns that git does not ignore
   `docdemo-auth.json`, offer to add `docdemo-auth.json` to `.gitignore`. If the session is empty, they
   probably closed the window before signing in: offer to run this again. Otherwise tell them DocDemo
   runs started from this folder now begin signed in, and that if a run later reports a sign-in page, the
   session has expired and they can run `/docdemo:login` again.

Never ask for the user's password, never type credentials into the app, and never read
`docdemo-auth.json`: it holds the user's session cookies.
