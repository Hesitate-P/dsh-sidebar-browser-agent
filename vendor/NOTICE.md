# Vendored third-party code

The plugin ships two MIT-licensed packages from the DeepSeek Harness repository
so a profile-linked install works without module resolution from the profile:

| Directory | Package | Version | Source |
| --- | --- | --- | --- |
| `schemastery/` | `@deepseek-ai/schemastery` | 3.19.0 | https://github.com/deepseek-ai/deepseek-harness (vendor/schemastery) |
| `cosmokit/` | `@deepseek-ai/cosmokit` | 1.9.0 | https://github.com/deepseek-ai/deepseek-harness (vendor/cosmokit) |

Local changes: `schemastery/index.mjs` imports `../cosmokit/index.js` instead of
the bare `@deepseek-ai/cosmokit` specifier. No other edits. Both packages keep
their own `LICENSE` file (MIT, Copyright (c) 2021-present Shigma).

They are used only by the Host half to declare the native plugin Config schema.
