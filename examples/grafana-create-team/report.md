# DocDemo report: Create a Grafana Team

- Doc: https://grafana.com/docs/grafana/v13.2/administration/team-management/configure-grafana-teams/#create-a-grafana-team
- App: http://localhost:3000/
- Run: 2026-10-04T01:28:53.403Z
- Result: complete: 8 actions across 5 of 5 documented steps, 11 frames

The doc and the product disagree in 2 place(s).

## The doc and the product disagree (2)

- **Step 3:** Click **New Team**.
  - doc says "New Team"; UI shows "New team"
- **Step 5:** Click **Save**. You can now add a Team member.
  - doc says to click Save after Create; UI shows no Save button on the New team page, it shows "Team created successfully." with an "Open team details" link

## Differences that depend on how this app is set up (1)

- **Step 1:** Sign in to Grafana as an `org administrator` or `team administrator`.
  - the demo session is already signed in as the Grafana admin user

## Put this demo on a doc page

Host `index.html` and the `assets/` folder with your doc site or on any static host. Nothing else in
this folder is needed, so this report stays private. Then paste this where the demo should appear,
with `src` pointing to where `index.html` is served:

```html
<iframe src="/demos/create-a-grafana-team/index.html?embed" title="Interactive demo: Create a Grafana Team" width="100%" height="560" style="width:100%;height:auto;aspect-ratio:4/3;border:0" loading="lazy"></iframe>
```

In MDX pages (Docusaurus, Mintlify, ReadMe), use this form instead:

```jsx
<iframe src="/demos/create-a-grafana-team/index.html?embed" title="Interactive demo: Create a Grafana Team" width="100%" height="560" style={{ width: '100%', height: 'auto', aspectRatio: '4/3', border: 0 }} loading="lazy" />
```
