# @tejika/env

## 0.5.2

### Patch Changes

- Add `expandHome(path)` and `readJSONFile(path, { default })` for config file loading. A missing
  file returns the default; any other read or parse failure throws an error naming the path.

## 0.5.0

### Minor Changes

- Add `getLogDir` to resolve the platform log directory, with a `LOG_DIR` env override
