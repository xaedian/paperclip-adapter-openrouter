# Upstream bug: external adapters cannot load on native Windows

Applies to Paperclip v2026.817.0 (`@paperclipai/server/dist/adapters/plugin-loader.js`).

## Complete runbook (patch + install, ~2 min, one restart whenever suits you)

Step 1 - patch the installed loader copy (safe any time; dormant until restart):

```powershell
$f = "$env:USERPROFILE\AppData\Local\npm-cache\_npx\43414d9b790239bb\node_modules\@paperclipai\server\dist\adapters\plugin-loader.js"
Copy-Item $f "$f.bak"
$c = Get-Content $f -Raw
$c = $c -replace 'import fs from "node:fs";', ('import fs from "node:fs";' + "`r`n" + 'import { pathToFileURL } from "node:url";')
$c = $c -replace 'await import\(modulePath\)', 'await import(pathToFileURL(modulePath).href)'
$c = $c -replace 'const fileUrl = `file://\$\{modulePath\}`;', 'const fileUrl = pathToFileURL(modulePath).href;'
Set-Content $f $c -NoNewline
Select-String -Path $f -Pattern "pathToFileURL"   # expect 3 hits
```

Step 2 - restart Paperclip at your leisure (this is the only downtime).

Step 3 - install the adapter (no rebuild needed; repo already built):

```powershell
$body = @{ packageName = "C:\Users\darre\projects\paperclip-adapter-openrouter"; isLocalPath = $true } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/adapters/install" -Method POST -ContentType "application/json" -Body $body
# expect: type=openrouter, requiresRestart=false
```

Or via UI: Settings -> Instance -> Adapters -> Install Adapter -> Local path.

Step 4 - verify:

```powershell
(Invoke-RestMethod "http://127.0.0.1:3100/api/adapters") | Where-Object type -eq "openrouter"
```

Then hire an agent with adapter type OpenRouter and set its API key
(config `apiKey`, a `{{SECRET_REF}}`, or server env `OPENROUTER_API_KEY`).

Notes:
- The npx cache dir (`43414d9b790239bb`) changes when paperclipai is upgraded
  or pruned - re-locate the file via
  `Get-ChildItem "$env:USERPROFILE\AppData\Local\npm-cache\_npx" -Recurse -Filter plugin-loader.js`
  and re-apply (or skip entirely once upstream ships the fix).
- If the POST reports `requiresRestart: true` you re-installed over an
  existing record; one more restart picks it up.

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
