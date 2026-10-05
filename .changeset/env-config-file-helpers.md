---
"@tejika/env": minor
---

Add `expandHome(path)` and `readJSONFile(path, { default })` for config file loading. A missing
file returns the default; any other read or parse failure throws an error naming the path.
