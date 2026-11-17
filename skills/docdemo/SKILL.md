---
name: docdemo
description: Turn a product documentation page (URL) into a clickable interactive demo by performing the documented procedure in a live instance of the web app (anything that runs in a browser) and capturing every step with a screenshot and hotspot. Use when the user gives a docs or help-center URL and wants a walkthrough, product tour, or interactive demo of it, or wants to check that a documented procedure still works. `login <app-url>` signs in to the app once, by hand, so later runs start signed in.
argument-hint: <doc-url> <app-url> | login <app-url>
arguments: [doc_url, app_url]
license: Apache-2.0
model: opus
effort: low
compatibility: Claude Code on a local machine. Requires Node 20+ and @playwright/cli 0.1.21 (npm i -g @playwright/cli@0.1.21), plus Google Chrome or `playwright-cli install-browser chromium`. The target app must be reachable from this machine (localhost is fine).
allowed-tools: Bash(playwright-cli --version) Bash(playwright-cli -s=dd snapshot) Bash(playwright-cli -s=dd screenshot) Bash(playwright-cli -s=dd dialog-accept) Bash(playwright-cli -s=dd dialog-dismiss) Bash(node "${CLAUDE_SKILL_DIR}/scripts/docdemo.mjs" *) Edit(./demo/**)
disallowed-tools: Read(./.env) Read(./.env.*) Read(./docdemo-auth.json)
---

# DocDemo

Preflight: !`playwright-cli --version 2>/dev/null || echo "MISSING playwright-cli: tell the user to run npm i -g @playwright/cli@0.1.21 and stop"`

Doc URL: $doc_url
App URL: $app_url

If the doc URL is the word `login`, only sign in: follow "Sign in by hand" below with the app URL, then stop.
If either is empty, stop and tell the user to run DocDemo again with a doc URL and an app URL (or `login` and
an app URL to sign in first).
Do not ask questions during the run, and keep text between commands to a few words or none: the user
reads the result at the end.

The helper is `node "${CLAUDE_SKILL_DIR}/scripts/docdemo.mjs"` (written `H` below). Always type the full
command exactly like that, with the quotes; shell variables do not persist between calls. Output goes to ./demo.
Run every command on its own, exactly as written: no `cd`, no `&&` chains, no pipes. Anything else
needs the user's permission and stalls the run.
The browser session is always `dd`. Change the page only through `H act`, never with playwright-cli
click/fill/goto, because `act` is what captures the demo. `open`, `act`, `note` and `signin` print the page's
snapshot when they finish: pick refs from that. Run `playwright-cli -s=dd snapshot` yourself only when no
snapshot was printed or the page changed on its own since (something was still loading), and
`playwright-cli -s=dd screenshot` when names are missing. If an action opens a browser dialog (a confirm),
`act` accepts it and says what it said; add `--dialog dismiss` to the `act` when the doc says to cancel it.
If a command says a browser dialog is open, answer it with `playwright-cli -s=dd dialog-accept` (or
`dialog-dismiss` when the doc says to cancel).

## 1. Read the doc

1. `H doc --url "$doc_url"` and read the printed text. If the URL has a #fragment, the helper prints that
   section; the procedure is there. A demo already in ./demo is moved to ./demo.prev-<date and time>.
   If `doc` fails (the folder holds other files, or the page could not be fetched), stop and tell the
   user what it printed. Never write demo/source.md yourself.
2. Find the documented procedure: the first numbered list under the linked heading (or on the page,
   when the URL has no #fragment). If the section holds more numbered lists (bulk variants, undo steps,
   mobile steps), leave them out; perform only the first. If the page has no procedure, stop and say so.
3. `doc` ends with an outline of the numbered lists (L1, L2, ...). `init --list <id>` (section 2) copies
   that list's items from the doc, verbatim, each as a step you perform (`action`). Pass only the exceptions:
   - `--kind 5=optional,7=reference`: `optional` ("Optionally, ..."), `reference` ("For more information,
     refer to ..."), `informational` (describes a result).
   - `--choose 2=a`: an item that offers alternatives ("Do one of the following") lists them as a, b, ...:
     the one you will perform.
   - `--select 2-6`: only to leave out items that are not steps (a prerequisite or a note written as an item).
4. If `init` refuses the list (it says why), or the procedure is not a numbered list, write
   `demo/steps.json` and pass `--steps demo/steps.json` instead of `--list`:
   `[{ "index": 1, "text": "Click **Dashboards** in the primary menu.", "kind": "action" }, ...]`
   - `text` is copied **exactly** from the doc. Markdown syntax may be kept or dropped (`**bold**`,
     `[link text](url)`, `&lt;`); the words may not change. Never paraphrase:
     `init` rejects text that is not a quote. When a step offers alternatives ("Do one of the
     following"), quote the one alternative you will perform.
   - `kind`: `action` (the reader does something in the UI), or one of the kinds above. Leave out
     prerequisites and notes that are not steps.

## 2. Open the app

1. `H init --title "<doc section title>" --doc-url "$doc_url" --app-url "$app_url" --list <id> --open`, with the id
   of the procedure's list (section 1, step 2) and the exceptions from section 1 (or `--steps demo/steps.json`
   instead of `--list`). Add `--headed` only if the user asked to watch. If the user named the product's
   version (for example "Grafana 13.2"), add `--app-version "<version>"`; never guess one. If init refuses `--list`, write
   demo/steps.json (section 1, step 4) and run it with `--steps demo/steps.json`; on a quote error with
   `--steps`, fix steps.json and run it again.
2. If it prints `SIGN-IN`, the app needs a signed-in session. Skip this when the documented procedure is
   itself about signing in.
   - If it also prints `CREDENTIALS`, sign in with them: in the printed snapshot, find the username or
     email field, the password field and the button that submits, then run
     `H signin --username-ref <ref> --password-ref <ref> --submit-ref <ref>`. For a sign-in split over two
     pages, run it once per page with the refs on that page. The helper types the values: never read
     `.env`, never print or type the values yourself. If the page still asks to sign in afterwards, run
     `H close` and stop, telling the user that the credentials in `.env` did not work.
   - Otherwise run `H close`, follow "Sign in by hand" below, then run `H open` again and carry on. If
     the page still asks to sign in, run `H close` and stop, telling the user the sign-in didn't take.
     Never ask for a password.

## 3. Perform each documented step in order

Only steps with kind `action` are performed. For each one:

1. Read the snapshot the previous command printed.
2. Decide the concrete UI actions (usually 1 to 3) that carry out this documented step, using refs
   from that snapshot only. Undocumented navigation is normal (expanding a menu section, closing a
   popup). Prefer mouse actions over keyboard shortcuts (click Run query rather than pressing
   Shift+Enter). When two elements share a name, pick the one in `main` or in the open dialog over the
   one in the banner.
   - When a step leaves a value to the reader that decides what the demo shows (a time range, "the
     incident period", "a recent deployment"), choose it from exact values, never by reading a chart's
     axis: before the `act` that sets it, read the start and end times of the events it is about from
     their tooltips or details (`H peek --ref <ref>` hovers an element and prints the page, recording
     nothing), from the URL, or from the app's API (`H get "/api/..."`, a read-only GET with the
     browser's session). Add a margin of 5 to 10 minutes before the first event and after the last.
   - After the value is set, check in the printed snapshot that the events are inside it, and write
     instructions only about events the snapshot shows.
3. Run ONE `H act` per action. Each prints the page's new snapshot: use its refs for the next action.
   - `H act --doc-step <n> --instruction "Click New" --expect "New" --ref e174 click`
   - `H act --doc-step <n> --instruction "Type \"DocDemo Folder\" in Name" --expect "Name" --ref e88 fill "DocDemo Folder"`
   - `fill` replaces the whole value, in code editors (Monaco, CodeMirror) too: no need to select the
     old text first. If it prints a WARNING about the editor, check the snapshot.
   - also `check`, `hover`, `select "<option>"` (native `<select>` elements only; for custom
     dropdowns click the control, then click the option in the new snapshot), or `--key Enter` (no ref)
     for a key
   - a value that starts with `--` goes after a `--` marker: `... --ref e88 fill -- "--verbose"`
   - `drag` for a step the doc says to drag (move a panel, reorder a list, select a range on a chart).
     Record it with `drag`, never as a note:
     - onto another element: `H act --doc-step <n> --instruction "Drag Milk onto Done" --expect "Milk" --ref e40 drag --to-ref e52`
     - across one element, such as a chart or a slider, where there is no ref for the end point:
       `H act --doc-step <n> --instruction "Drag across the bars to select a time range" --expect "Logs volume" --ref e61 drag --from 0.3,0.5 --to 0.7,0.5`
       `--from` and `--to` are x,y fractions of the element's box (0,0 is its top left; `--from` defaults to
       0.5,0.5). Use the ref of the smallest element that holds the drawing (the chart's canvas or image,
       not the whole panel), and pick points inside the plotted area, clear of axes, legends and the panel
       header. When the snapshot can't show where the data is, `playwright-cli -s=dd screenshot` first.
     - Check in the printed snapshot that the drag took effect (the panel moved, the time range changed).
       If it did not, try once more with other points; if it still has no effect, record that with `H fail`.
   `--instruction` is what the viewer reads: short, imperative, the value included for fills.
   `--expect` is the element's name as it appears in the snapshot (or its visible text). For a link with
   no name (an icon in a sidebar), use the path of its `/url`, such as `--expect "/explore"`.
4. If the UI is already in the documented state (nothing to do), record it instead:
   `H note --doc-step <n> --instruction "Dashboards is already open" --note "Already open in this version"`
5. If the message says the action already ran, or a WARNING says it ran, do not repeat it: continue from the
   page as it is now. A WARNING that it may not have reached the page says when it may be done again: follow
   it. Otherwise, if `act` prints STALE_REF, NO_BOX or REF_MISMATCH, it also prints a fresh snapshot: retry
   once with a ref from it. If it fails again, or the UI does not offer what the doc describes, record the
   discrepancy and go straight to section 4 (a failed step ends the demo):
   `H fail --doc-step <n> --instruction "Click Create" --note "doc says X; UI shows Y"`
6. If a step works but the UI differs from the doc (renamed button, a dialog that asks for input),
   add `--note "doc says X; UI shows Y"` to that `act`. Use "doc says" only when the doc is wrong for
   this version of the product; if the difference comes from how this instance is set up (a feature
   not configured, a free edition, a personal rather than an organization account, no existing
   data), write the note as `--note "setup: ..."` instead.
   - Note each finding once per doc step: when an earlier frame of the step already notes it (the
     missing Save button you noted on the act that showed it), leave `--note` out on later frames.
   - A plain confirmation (Yes, OK, Confirm) for an action the doc already describes is routine and
     often left out of docs: perform it with no note.
   - A vague reference is a doc error when the UI gives the element a name: "click the icon" for an
     icon with a label or tooltip, "the navigation bar" for a named tab. Note it with "doc says",
     naming what the UI shows.
   - Casual wording is not a doc error, but note it: when a step says what to do without naming the
     control ("Save your changes" for a button named **Save contact point**) and the control it means
     is obvious, add `--note "wording: the button is Save contact point"`.
   - Text the doc marks as UI text must match the UI exactly: a difference in capitalization ("New
     Team" for "New team") or wording ("Edit the dashboard" for "Edit dashboard") is a doc error.
   - Describing an icon by its look ("the pencil icon", "the three dots menu", "**…**") is fine when
     the icon looks like that, even if its tooltip gives it a name. A description that does not match
     the icon (a "paper clip" that is a chain link) is a doc error.

7. **Checks.** After each `act` or `note`, the helper prints "Checks for doc step N": every term the doc
   marks as UI text (bold, code, quotes) and every phrase about where something is ("in the navigation
   bar", "top right", "the gear icon"), with what the page showed. For location claims it lists where
   each element the step acted on sits: its role, its position on screen, the landmarks it is inside,
   and the other landmarks on the page. A term found exactly as written, as a whole name or line, passes;
   one that is only part of a longer label is OPEN, for you to judge. Answer every OPEN check of a step
   after its last action, on your next command (`act`, `note`, `fail` or `finish`): add `--claim`,
   `--verdict` and `--note` once per claim, before the action word and after the frame's own `--note`
   if it has one:
   `H act --doc-step <n+1> --instruction "Click Save" --expect "Save" --ref e88 --claim "<claim as printed>" --verdict <verdict> --note "..." --claim "<another>" --verdict <verdict> --note "..." click`
   (`H check --doc-step <n> --claim ... --verdict ... --note ...` records answers on their own.)
   - `doc`: the doc is wrong for this version; `--note "doc says X; UI shows Y"`
   - `setup`: the difference comes from how this instance is set up; `--note "setup: ..."`
   - `noted`: a frame note on this step already reports it (do not report it twice)
   - `ok`: the page matches the doc; say why (a menu item that appeared after a click, a location
     that matches the recorded landmarks)
   - `not-ui`: the marked text is not UI text (a role, a value to type, emphasis)
   Judge locations by the recorded landmarks and position: "in the navigation bar" is wrong for a tab
   outside the landmark the page names "Navigation bar"; "left-hand side" is wrong for an element on the
   right. The helper refuses the next doc step and `finish` while a check is open.

8. **Product errors.** `act` also prints the HTTP errors in the browser's network log: server errors
   (5xx), requests that failed, and pages that came back as an error, in full; 4xx responses from API
   calls in one line, because apps make such calls routinely. When the page shows an error (an error
   message, a crash page, a spinner that never ends) or an action has no effect, and the cause is the
   product rather than the doc, that is a product error, not a doc error:
   - if you cannot go on: `H fail --doc-step <n> --instruction "Click Save" --note "product: <what the page shows>"`
   - if you can: record it on this step with `H note --doc-step <n> --instruction "<what the page shows>" --note "product: ..."`
   The report lists every product error with its HTTP status from the network log. A 4xx with nothing
   wrong on the page is not a product error: carry on.

Use obviously fake demo data such as "DocDemo Folder". Never invent UI that is not in the snapshot.

## 4. Finish and report

1. **Claims beyond the steps.** Skip this when a step failed. Read the linked section again for sentences
   that are not steps but say what the product does: a default value, a limit, an order ("sorted by
   name"), what appears or changes after an action, what a setting or option does. Leave out concepts,
   prerequisites, and anything you could check only with data, permissions or time you don't have. If
   there are none, go on to 2. Otherwise check the ones a reader relies on most, three at most, and go on to 2
   only when each of them has a verdict:
   - A verdict rests on frames: the screens the run recorded. Each `act` frame is the screen before its
     action, so an action's result is on the next frame, and `H done` records the final screen. The snapshot
     a command prints is not a frame.
   - When recorded frames already settle every claim you picked, give them all in one command:
     `H claim --quote "<the sentence, copied exactly>" --verdict <verdict> --note "..." --frames 7` (one
     `--quote` per claim, each with its own `--verdict`, `--note` and `--frames`). If the screen that settles
     one is the page after the last step, run `H done` first, so it is a frame.
   - Otherwise: `H done` first (with the answers to any open checks, as `finish` would take them), so readers
     end on the result of the procedure; then one `H claim` with every claim you picked: with its verdict as
     above when recorded frames settle it, with only `--quote` when they don't. It prints each claim's id.
     Look only at the claims it printed without a verdict, with three actions at most per claim: sort, filter,
     open, hover, scroll, or type into a form without submitting it. Never save, submit, create, delete or
     change a setting to test a claim: a claim only saving would show is `unverified`. Record each screen with
     the claim's id: `H act --evidence <id> --instruction "Sort by Name" --ref e12 click` (it records the screen
     before the action, as `act` does), and `H note --evidence <id> --instruction "The list sorted by name"`
     for the result. Then answer those claims in one command:
     `H check --claim-id <id> --verdict <verdict> --note "..." [--frames E1,E2,7] --claim-id <id> ...`
   - What counts as evidence: a default is what a fresh page shows before you change a control (a value
     you set earlier in this run is not a default); a limit needs the boundary itself; what a setting
     does needs its effect, seen. A screenshot of a setting does not show what it does.
   - Verdicts:
     - `ok`: the frames show all of what the doc says; say what they show. When they show only part of it
       (the ID comes from the name, but no duplicate name was tried), the verdict is `unverified`
     - `doc`: under the conditions the doc describes, the app plainly does something else;
       `--note "doc says X; UI shows Y"`
     - `setup`: it depends on how this instance is set up; `--note "setup: ..."`
     - `unverified`: the frames can't settle it (conditions you can't see, a product error, only saving
       would show it); say why
   - If an evidence action fails, never use `H fail` or start this section again: keep the evidence you
     have, answer the claim `unverified` with the reason, and go on. Never repeat an action reported as
     already run.
2. `H finish` (if it reports a problem, fix what it names and run it again). To correct a frame's text
   afterwards, run `H amend --frame <n> --instruction "..."` (or `--note "..."`, `--clear-note`), with the
   frame number `act` printed; it builds again. Never edit demo.json, and never describe an outcome the
   screenshots do not show. A check's verdict is corrected with `H check`, then `H build`.
3. Tell the user: the path `demo/index.html`, the summary line `finish` printed, every failed or noted
   step, every doc or setup check, every claim's verdict, every product error with its HTTP status, and every frame to check; that `open demo/review.html`
   views the demo with DocDemo's notes, that `demo/index.html` is the copy for readers (no notes), that
   `demo/report.md` lists the discrepancies and the MDX form of the embed snippet, and the HTML embed snippet
   `finish` printed (in a code block). If the user said where the demo will be hosted, pass it to finish as
   `--embed-url <url>`.

## Sign in by hand

Used by `login <app-url>` and when a run reaches a sign-in page with no credentials in `.env`.

1. Tell the user, in two short sentences: a browser window is about to open at the app; sign in there the
   way they normally do (single sign-on and 2-factor are fine), then close the window, and DocDemo will keep
   the session.
2. Run `H login --url "<app-url>"` with the Bash timeout set to 600000 (10 minutes). It opens the window and
   waits until the user closes it.
3. If it warns that git does not ignore `docdemo-auth.json`, tell the user to add it to `.gitignore`. If the
   session is empty, they probably closed the window before signing in: stop and say so. In login-only mode,
   tell them runs started from this folder now begin signed in.

Never ask for the user's password, never type credentials into the app yourself, and never read
`docdemo-auth.json`: it holds the user's session cookies.
