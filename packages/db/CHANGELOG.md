# @tejika/db

## 0.5.0

### Minor Changes

- Move to enkaku 0.23 and `@hozon/node-sqlite` 0.3. Enkaku 0.23 brings kokuin 0.7, so a host using `@tejika/process` or `@tejika/server` must move its own enkaku packages to 0.23 too.

## 0.4.0

### Minor Changes

- Move to the @hozon/db 0.5 line (node-sqlite 0.2, store-log 0.4, store-telemetry 0.4). A different store definition under a taken name now throws.

## 0.2.0

### Minor Changes

- Update @hozon/db to 0.2 (store tables now carry the table prefix, e.g. hozon_<store>_*) and logtape to 2.4

## 0.1.0

### Patch Changes

- Add `@tejika/db` with `openLocalDatabase` for opening local hozon databases.
