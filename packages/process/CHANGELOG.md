# @tejika/process

## 0.7.0

### Minor Changes

- Move to enkaku 0.23 and `@hozon/node-sqlite` 0.3. Enkaku 0.23 brings kokuin 0.7, so a host using `@tejika/process` or `@tejika/server` must move its own enkaku packages to 0.23 too.

## 0.6.0

### Minor Changes

- Update @enkaku dependencies to 0.22 (OpenTelemetry v3)

## 0.5.3

### Patch Changes

- Update @logtape and @enkaku dependencies

## 0.5.0

### Minor Changes

- `spawnDaemon` now defaults its log path to `<logDir>/daemon.log` instead of `<dataDir>/daemon.log`, and creates the log directory owner-only (0700)

### Patch Changes

- Updated dependencies:
  - @tejika/env@0.5.0
