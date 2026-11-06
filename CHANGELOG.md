# Changelog

## 0.3.5

Native file transfer without Playwright/Puppeteer and without OS file dialogs:

- `download`: resolve a link/image/src or take a direct URL; authenticated and
  page-generated (`blob:`) files are fetched inside the guest page session
  (cookies included), then saved through the Desktop trusted
  `dshDesktop.fileActions.save` API (Downloads folder, de-duplicated names;
  `saveAs: true` opens the native Save dialog). Public URLs whose page-session
  fetch is blocked fall back to a native URL download. HTTP errors are refused
  instead of saving an error page.
- `upload`: the Host reads absolute local paths (8 MB per file, 12 MB total,
  MIME guessed from the extension), the guest builds `File` objects with
  `DataTransfer` and attaches them to `<input type=file>` (visible or hidden),
  labels, or replays dragenter/dragover/drop on drop zones. No OS dialog.
- New `allowUploads` config switch (default true) gates local file reads.
- `status` capabilities now report download/upload support and limits; tool
  schema, help, renderers, docs and both regression suites cover the new flows.
- Large-file live checks: 7.5 MB single upload and 2×5 MB upload round-trip with
  matching SHA-256; 10 MB guest-fetch download with matching SHA-256; 14 MB file
  over the guest cap falls back to the native URL save with matching SHA-256;
  9 MB single and 14 MB total uploads are refused with clear errors.

## 0.3.4

- `drag` accepts a mouse `button` (left, right or middle), matching drag-test
  pages that exercise every button. Verified against cps-check.com/cn/drag-test
  (Konva canvas): left, middle and right drags move the object by exactly the
  requested delta at zoom 1 and 1.25, and the object stays put after release.

## 0.3.3

- Fix the `viewport` result so a single-tab lookup returns the guest frame box
  (and scroll/url/title) at the top level; the 0.3.2 publish was blocked by the
  new client-harness assertion catching this missing field.

## 0.3.2

Major observation/action layer upgrade, modelled on mature browser-use workflows
but kept fully native to the DSH Electron guest:

- Observations: new `snapshot` action returns a compact semantic tree with
  short element refs; refs drive click/type/hover/... and expire with the next
  snapshot ([stale-ref]). `read` gained element-scoped `attrs`, `state`, `box`
  and semantic `interactive` modes.
- Actions: ref/selector/text/coordinate targets with explicit ambiguity errors
  ([ambiguous] plus candidates); click, dblclick, rightClick, hover, focus,
  clear, type (`fill` or real `keyboard` events), press (single combo or a
  sequence of combos), selectOption, check/uncheck, drag, scroll,
  scrollIntoView.
- Post-action observation: every state-changing action returns `observed`
  (URL/title/scroll changes, DOM mutation counts, new tabs, focus), so a second
  read is rarely needed.
- Waits: waitForSelector (visible/attached/hidden/detached), waitForLoadState,
  waitForURL, waitForNavigation; open/navigate/reload accept `waitUntil`.
- Screenshot clip regions; `help` returns the usage workflow; `batch` runs up
  to 25 page actions in one tool call (no nested batch, no screenshot steps).
- Tabs: list carries title/url/loading/zoom/viewport/mark and mounted/expanded
  state; open supports same-site `reuse`; show/hide expand or collapse the
  sidebar; zoom/viewport actions; finalize marks tabs deliverable/handoff.
- Host tool schemas, gate enforcement (batch steps are gated too), renderers and
  regression suites updated; device capabilities are reported by `status`.
- Local live-test fixes: `Mod+A` select-all fallback for synthetic key events,
  zoom-aware native input coordinates, `settleTab` waits for the real document
  instead of about:blank, guest CSS viewport vs guest frame box, batch steps
  now carry their action, snapshot trims checkbox/select noise.

## 0.2.11

- Fix the README hero image URL: the `main/...` raw path was cached as a 404
  right after the first push; the canonical `refs/heads/main/...` URL renders
  on GitHub and on the npm page.

## 0.2.10

- README is now just what the plugin does and its limits, with a hero diagram
  of the tool → native webview flow.
- The plugin page shows the same diagram as an official-style hero card above
  the settings form (localized heading/subtitle).

## 0.2.9

- Polished the official-style plugin page rhythm: field/row spacing, tertiary
  12px hints, the same input surface and radius the built-in settings pages
  use, and the shared form footer as the only save action.

## 0.2.8

- The plugin page now follows the official plugin-page style: the configuration
  form is built on the platform's shared settings primitives (`SettingsForm`,
  `Switch`), with the official footer save action, token-based typography and
  spacing, and a switch list plus allowlist field. A carrier without those
  primitives keeps the previous self-contained form as a fallback, and
  `sidebar_browser status` reports which path is active.

## 0.2.7

- Redrew the plugin icon in the official plugin style: a transparent 36x36
  gradient glyph (browser window, sidebar list, agent cursor) using the same
  palette and stroke language as the built-in plugin icons.
- Declared `icon` in `package.json`, the field the Plugin Manager reads for a
  plugin row, and added a GitHub-hosted 180px raster for storefront tiles.

## 0.2.6

- Publishing is now token-free: the publish workflow authenticates to npm with
  **Trusted Publishing (GitHub OIDC)**, publishes with provenance, and no
  longer needs the `NPM_TOKEN` secret (long-lived/bypass-2FA tokens are being
  deprecated by npm).

## 0.2.5

- Resilience: every awaited guest operation (page script, screenshot, native
  navigation) is now bounded by a deadline. A hung or unresponsive page becomes
  a normal command error and the bridge keeps polling, instead of blocking the
  page half until the plugin is reloaded.
- Update without restart: the Host entry is now a versioned file
  (`lib/entry-<version>.js` published through `package.json`'s `"."` export).
  A reinstalled newer version resolves a new module URL, so the running Host
  loads the new Host code after a Plugin Manager update instead of executing
  the previously cached module.

## 0.2.4

- Page actions no longer refuse while the guest still reports loading assets:
  readiness now follows the document's `readyState` (bounded to 5 s), so slow
  pages such as GitHub's login and 2FA screens stay controllable.

## 0.2.3

- Package entries moved to `lib/index.js` and `lib/client.js` (DSH package
  convention). A replaced install now resolves a fresh Host module generation,
  so a GitHub update can load new Host code without a manual restart.
- `sidebar_browser status` warns when the page half and the running Host half
  report different versions (`restart the Harness to load the installed Host code`).

## 0.2.2

- Plugin Manager configuration page: the bundle's row now has a **Configure**
  page under Plugins → bundle → row, with switches for `enabled`, `allowedHosts`,
  `allowEval`, `allowNativeInput`, a save/reset form and localized copy (en/zh).
- Config fields are declared `.volatile()`: edits apply to the running plugin
  immediately (tool visibility through a per-step condition, gates read live
  values) without restarting it.
- `status` diagnostics now report the configuration form state (`checks.configForm`).

## 0.2.1

- docs: document GitHub installation, the update flow, the release process, and the
  difference between GitHub-installed (remove + reinstall) and registry-installed
  (one-click Update) bundles. No behavioral change to the plugin tools.

## 0.2.0

- Initial public release.
- `sidebar_browser`: `status`, `list`, `open`, `navigate`, `reload`, `focus`, `close`
  for native right-sidebar browser tabs.
- `sidebar_page`: `read` (text / interactive / html), `click`, `type`, `press`,
  `scroll`, `wait`, `eval`, `screenshot`, driven through the native Electron
  `<webview>` guest (`executeJavaScript`, `capturePage`, `sendInputEvent`,
  `loadURL`, `reload`).
- Native Schemastery configuration: `enabled`, `allowedHosts`, `allowEval`,
  `allowNativeInput`.
- Startup self-check and `status` diagnostics (carrier, DOM contract, native API
  list, Harness release, host config, attachment availability).
- Page actions continue on the calling conversation's hidden sidebar tab while
  another conversation is on screen; layout actions and screenshots report when
  visibility is required.
- Dependency-free regression suites for both halves, GitHub Actions CI, npm
  publish workflow, and `scripts/set-version.mjs` version tooling.
