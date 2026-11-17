# DocDemo

**Turn a how-to doc into a clickable demo of your product, and find out where the doc is wrong.**

DocDemo is a Claude Code skill. Give it a documented procedure and your app's URL, and it follows the steps
in a real browser. You get:

- **A demo your readers can click through.** Each screen quotes the doc step it comes from. The demo is a
  small web page you can embed on the doc page.
- **A list of where the doc and the product disagree.** A renamed button, a moved menu, a step that no
  longer works: each one with its step and what the product shows instead.

[![A DocDemo demo of Grafana's "Create a playlist" doc, clicking and typing through each step](docs/demo.gif)](https://serendip-ai.github.io/docdemo/grafana-create-playlist/)

[Click through this demo](https://serendip-ai.github.io/docdemo/grafana-create-playlist/), made from
Grafana's [Create a playlist](https://grafana.com/docs/grafana/v13.2/visualizations/dashboards/create-manage-playlists/#create-a-playlist)
doc with one command, or see [all examples](https://serendip-ai.github.io/docdemo/).

## How it works

After a one-time setup, you type one command in Claude Code: `/docdemo`, the link to a procedure, and the
address of your test site.

```
/docdemo https://docs.example.com/projects/#create-a-project https://staging.example.com
```

DocDemo follows the procedure and gives you a clickable demo and a report of every place where the doc and
the product disagree. In our benchmark, we planted 39 errors in docs for Grafana, Forgejo and Metabase, and
DocDemo reported 38 of them. See [how we measured it](docs/GUIDE.md#how-well-it-works).

## What you need

- **A Mac.** Linux works too, with slightly different steps (see the note under step 3). Windows doesn't
  work yet.
- **Claude Code, running on your computer.** You can use the Claude desktop app (a local session in its
  Code tab), the Claude Code extension for VS Code, or Claude Code in the terminal. Cloud and remote (SSH)
  sessions don't work, because DocDemo opens a browser on your computer.
- **A Claude plan or API account.** DocDemo itself is free, but each run uses Claude: a short procedure
  costs roughly $0.40 to $0.80 at API prices, or counts toward your Claude plan's usage.
- **Google Chrome.** If you don't have it, install it from [google.com/chrome](https://www.google.com/chrome/).
- **About 15 minutes,** once. You may need your Mac's password. On a work laptop that doesn't let you
  install apps, ask your IT team to do steps 3 and 4 for you.

## Set up DocDemo

You do this once, whichever way you use Claude Code. You'll type a few commands into the Mac's Terminal app.
Copy each command exactly, paste it, and press **Return**.

**Step 1. Open Terminal.** Press **⌘ Space**, type `Terminal`, and press **Return**. A window opens with a
blinking cursor. That's where you paste the commands below. (If you use VS Code, you can choose
**Terminal > New Terminal** there instead.)

**Step 2. Check whether you have Node.js.** DocDemo needs it. Paste this and press **Return**:

```
node --version
```

If you see `v20` or a higher number, such as `v22.11.0`, skip to step 4. If you see `command not found`, or
a number lower than `v20`, go to step 3.

**Step 3. Install Node.js** (only if step 2 told you to).

<details>
<summary>How to install Node.js on a Mac</summary>

1. Go to [nodejs.org](https://nodejs.org/) and click the download button marked **LTS**.
2. Open the file you downloaded (it ends in `.pkg`) and click through the installer: **Continue**,
   **Agree**, **Install**. Enter your Mac's password when it asks.
3. Quit Terminal (**⌘Q**) and open it again, so that it picks up the new installation. If you're using
   VS Code's terminal, quit VS Code and open it again instead.
4. Repeat step 2. You should now see a version number.

</details>

<details>
<summary>On Linux</summary>

Install Node.js 20 or later with your distribution's package manager or from [nodejs.org](https://nodejs.org/),
then continue with step 4. Steps 4 to 7 are the same in your Linux terminal, except that where step 4
mentions your Mac's password, it's your Linux account's password, and in "Make a demo", open the `demo`
folder with your file manager instead of Finder.

</details>

**Step 4. Install the browser tool DocDemo uses.** Paste this and press **Return**:

```
npm install -g @playwright/cli@0.1.21
```

It takes up to a minute. To check that it worked, paste `playwright-cli --version`. You should see
`0.1.21`.

<details>
<summary>If you see <code>EACCES</code> or <code>permission denied</code></summary>

Paste this instead, press **Return**, and type your Mac's password. Nothing appears on screen while you
type the password; that's normal. Press **Return** when you're done.

```
sudo npm install -g @playwright/cli@0.1.21
```

</details>

**Step 5. Download DocDemo.** Paste this and press **Return**:

```
git clone https://github.com/serendip-ai/docdemo ~/.claude/docdemo
```

<details>
<summary>If a window asks you to install "command line developer tools"</summary>

Click **Install** and wait until it finishes (a few minutes). Then paste the command from step 5 again.

</details>

**Step 6. Add DocDemo to Claude Code.** Paste this and press **Return**:

```
mkdir -p ~/.claude/skills && ln -s ~/.claude/docdemo/skills/docdemo ~/.claude/skills/docdemo
```

On success, the command prints nothing.

<details>
<summary>If you see <code>File exists</code></summary>

Something called `docdemo` is already in your Claude Code skills folder. To see what it is, paste:

```
ls -l ~/.claude/skills/docdemo
```

If the line ends with `.claude/docdemo/skills/docdemo`, DocDemo is already added: go to step 7. If it
ends with anything else, it's an older or different copy. Move it out of the way (this keeps it, in
`~/.claude/docdemo-old`), then paste the command from step 6 again:

```
mv ~/.claude/skills/docdemo ~/.claude/docdemo-old
```

</details>

**Step 7. Check that Claude Code sees it.** Start a new Claude Code session and type `/docdemo`. You should
see **docdemo** in the list that appears. If you don't, quit Claude Code (the desktop app or VS Code) and
open it again.

You're set up. To get a newer version of DocDemo later, paste `git -C ~/.claude/docdemo pull` into the
terminal.

## Make a demo

**Use a test or staging site and an account with no private data.** DocDemo performs real actions, so
anything the procedure creates, changes or deletes really happens, and your readers will see the
screenshots. Use it only with sites you're authorized to test, and check your organization's policy before
letting Claude read internal content: Claude reads every page DocDemo opens.

1. **Make a folder for your demos.** DocDemo saves each demo in a folder called `demo` inside the folder
   Claude Code is working in. Keep demos out of your docs project: create an empty folder (for example
   `DocDemo demos` in your Documents folder) and start Claude Code there:
   - **Claude desktop app:** in the Code tab, start a local session and choose the folder with the project
     folder control, before your first message.
   - **VS Code:** choose **File > Open Folder** and pick the folder, then open Claude Code.
   - **Terminal:** paste `cd ~/Documents/"DocDemo demos"` and press **Return**, then type `claude`.
2. **Ask for a demo.** In Claude Code, type `/docdemo`, then the link to the doc, then the address of your
   test site, with a space between them:

   ```
   /docdemo https://docs.example.com/projects/#create-a-project https://staging.example.com
   ```

   If the doc page has more than one procedure, link to the heading of the one you want (the part of the
   link that starts with `#`). Claude may ask your permission to run DocDemo's commands: allow them.
3. **Sign in if it asks.** If your test site needs a sign-in, a Chrome window opens at the site. Sign in
   there yourself, then close the window. DocDemo doesn't record what you type into the sign-in form. It
   saves only the session the site creates (its cookies and stored data), in a file called
   `docdemo-auth.json` in your demos folder, so later runs start signed in. That file works like a key to
   your test account: don't share it or add it to a repository.
4. **Look at the result.** A short procedure takes a minute or two. Claude then tells you what it found.
   Open the new `demo` folder in Finder (in VS Code, right-click it in the file list and choose **Reveal in
   Finder**), then:
   - double-click `review.html` to see the demo with DocDemo's notes on each problem it found;
   - open `report.md` for the list of places where the doc and the product disagree;
   - `index.html` (with the `assets` folder) is the copy for your readers.

## Learn more

The [guide](docs/GUIDE.md) covers putting a demo on your doc site (Hugo, Docusaurus, ReadMe and others),
reading the report, how DocDemo works, and what it can't do yet.

Bug reports and feedback are welcome in [Issues](https://github.com/serendip-ai/docdemo/issues). If DocDemo
saves you time, you can [buy me a coffee](https://buymeacoffee.com/docdemo).

## License

Copyright 2026 Serendip AI. Licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE) for
third-party material. DocDemo is an independent project, not affiliated with the makers of any product named
here; see the guide's [notices](docs/GUIDE.md#notices).
