# DocDemo report: Create a playlist

- Doc: https://grafana.com/docs/grafana/v13.2/visualizations/dashboards/create-manage-playlists/#create-a-playlist
- App: http://localhost:3000/
- Run: 2026-10-04T01:21:46.752Z
- Result: complete: 11 actions across 7 of 7 documented steps, 12 frames

No discrepancies: the product matched every documented step DocDemo performed.

## Differences that depend on how this app is set up (1)

- **Step 3:** Click **New playlist**.
  - no playlists exist yet, so the empty-state page shows a Create playlist button instead of New playlist

## Put this demo on a doc page

Host `index.html` and the `assets/` folder with your doc site or on any static host. Nothing else in
this folder is needed, so this report stays private. Then paste this where the demo should appear,
with `src` pointing to where `index.html` is served:

```html
<iframe src="/demos/create-a-playlist/index.html?embed" title="Interactive demo: Create a playlist" width="100%" height="560" style="width:100%;height:auto;aspect-ratio:4/3;border:0" loading="lazy"></iframe>
```

In MDX pages (Docusaurus, Mintlify, ReadMe), use this form instead:

```jsx
<iframe src="/demos/create-a-playlist/index.html?embed" title="Interactive demo: Create a playlist" width="100%" height="560" style={{ width: '100%', height: 'auto', aspectRatio: '4/3', border: 0 }} loading="lazy" />
```
