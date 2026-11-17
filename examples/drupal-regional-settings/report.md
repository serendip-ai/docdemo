# DocDemo report: Configuring default Regional settings

- Doc: https://www.drupal.org/docs/user_guide/en/config-basic.html#s-configuring-default-regional-settings
- App: http://localhost:3003/
- Run: 2026-10-09T01:53:59.934Z
- Result: complete: 8 actions across 3 of 3 documented steps, 9 frames

The doc and the product disagree in 1 place(s).

## The doc and the product disagree (1)

- **Step 1:** In the Manage administrative menu, navigate to Configuration > Regional and language > Regional settings (admin/config/regional/settings).
  - doc says Regional and language; UI shows Region and language
  - doc says the Manage administrative menu; Drupal 11 shows an Administrative sidebar

## Put this demo on a doc page

Host `index.html` and the `assets/` folder with your doc site or on any static host. Nothing else in
this folder is needed, so this report stays private. Then paste this where the demo should appear,
with `src` pointing to where `index.html` is served:

```html
<iframe src="/demos/configuring-default-regional-settings/index.html?embed" title="Interactive demo: Configuring default Regional settings" width="100%" height="560" style="width:100%;height:auto;aspect-ratio:4/3;border:0" loading="lazy"></iframe>
```

In MDX pages (Docusaurus, Mintlify, ReadMe), use this form instead:

```jsx
<iframe src="/demos/configuring-default-regional-settings/index.html?embed" title="Interactive demo: Configuring default Regional settings" width="100%" height="560" style={{ width: '100%', height: 'auto', aspectRatio: '4/3', border: 0 }} loading="lazy" />
```
