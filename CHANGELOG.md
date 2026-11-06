# Changelog

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
