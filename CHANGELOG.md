# Changelog

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
