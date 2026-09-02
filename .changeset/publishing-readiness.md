---
"@tejika/env": minor
"@tejika/log": minor
"@tejika/process": minor
"@tejika/server": minor
"@tejika/cli": minor
"@tejika/ui": minor
"@tejika/test": minor
---

Publishing readiness. Every package now ships a LICENSE, declares
`engines.node >=24`, and exposes a `types`/`default` conditional exports map;
tarballs no longer ship dangling declaration maps. `@tejika/cli` and
`@tejika/ui` now declare `react` and `ink` as peer dependencies (`react ^19`,
`ink ^7`) instead of regular dependencies, so a consumer app resolves a single
React instance.

The `engines.node >=24` floor is why every package takes a minor bump: it
raises the supported-runtime floor for pre-1.0 packages.
