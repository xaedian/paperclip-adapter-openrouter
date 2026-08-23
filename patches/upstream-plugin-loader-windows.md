# Upstream bug: external adapters cannot load on native Windows

Applies to Paperclip v2026.817.0 (`@paperclipai/server/dist/adapters/plugin-loader.js`).

## Local hotfix (dormant until the next server restart)

The running process keeps the broken module in memory; patching the files on
disk changes nothing until restart. After any restart, retry
`POST /api/adapters/install` (or the Adapter Manager UI) and it works.

Apply to the installed copy:

```powershell
$f = "$env:USERPROFILE\AppData\Local\npm-cache\_npx\43414d9b790239bb\node_modules\@paperclipai\server\dist\adapters\plugin-loader.js"
# 1. add import
(Get-Content $f -Raw) `
  -replace 'import fs from "node:fs";', "import fs from `"node:fs`";`r`nimport { pathToFileURL } from `"node:url`";" `
  | Set-Content $f -NoNewline
# 2. fix load path
(Get-Content $f -Raw) -replace 'await import\(modulePath\)', 'await import(pathToFileURL(modulePath).href)' | Set-Content $f -NoNewline
# 3. fix reload cache-bust URL base
(Get-Content $f -Raw) -replace 'const fileUrl = `file://\$\{modulePath\}`;', 'const fileUrl = pathToFileURL(modulePath).href;' | Set-Content $f -NoNewline
```

A backup of the original is kept at `plugin-loader.js.orig-windows-bug`.
The npx cache may be replaced when paperclipai is upgraded or its cache is
pruned - re-apply (or upgrade to a version containing the upstream fix).

## Upstream report draft

plugin-loader.js fails on native Windows with:

    Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file,
    data, and node are supported by the default ESM loader. On Windows,
    absolute paths must be valid file:// URLs. Received protocol 'c:'

Two problems:

1. `loadExternalAdapterPackage()` calls `await import(modulePath)` where
   `modulePath` is a raw Windows path (e.g. `C:\...\dist\index.js`).
   Node's ESM loader requires a `file://` URL here on Windows.

2. `reloadExternalAdapter()` builds `const fileUrl = \`file://${modulePath}\``
   which produces `file://C:\Users\...` - wrong scheme authority and
   backslashes - so runtime reload is also broken on Windows.

Both paths are exercised by `POST /api/adapters/install`, the Adapter
Manager UI, and startup registration from ~/.paperclip/adapter-plugins.json,
so *no* external adapter can be installed or loaded on native Windows hosts.

Repro: Paperclip v2026.817.0 on Windows (npx install), POST /api/adapters/install
with { "packageName": "<abs windows path>", "isLocalPath": true } -> 500
ERR_UNSUPPORTED_ESM_URL_SCHEME. Same for npm-package installs.

Suggested fix (verified working locally against v2026.817.0):

--- a/server/src/adapters/plugin-loader.ts
+++ b/server/src/adapters/plugin-loader.ts
@@
 import fs from "node:fs";
 import path from "node:path";
+import { pathToFileURL } from "node:url";
@@
-    const mod = await import(modulePath);
+    const mod = await import(pathToFileURL(modulePath).href);
@@
-    const fileUrl = `file://${modulePath}`;
+    const fileUrl = pathToFileURL(modulePath).href;

`pathToFileURL` normalises drive letters, slashes, and percent-encodes
special characters, producing e.g. `file:///C:/Users/me/pkg/dist/index.js`.
