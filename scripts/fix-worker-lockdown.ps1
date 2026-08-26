$ErrorActionPreference = "Continue"
Write-Host "=== Paperclip External Adapter Streaming Fix ==="
Write-Host "Wraps unsafe Web Worker lockdown assignments in try/catch"
Write-Host "so the ui-parser worker doesn't crash on getter-only properties."
Write-Host ""

# --- 1. Locate the active Paperclip install ---
$proc = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -like "*paperclipai*dist*index.js*"
} | Select-Object -First 1

$cacheDir = $null
if ($proc -and $proc.CommandLine -match "_npx\\([0-9a-f]+)") {
    $cacheDir = $Matches[1]
    Write-Host "Detected running install: npx cache $cacheDir"
} else {
    Write-Host "Paperclip not running. Scanning npx cache for installs..."
    $candidates = Get-ChildItem "$env:USERPROFILE\AppData\Local\npm-cache\_npx" -Directory |
        Where-Object { Test-Path "$($_.FullName)\node_modules\paperclipai\package.json" }
    foreach ($c in $candidates) {
        $v = (Get-Content "$($c.FullName)\node_modules\paperclipai\package.json" | ConvertFrom-Json).version
        Write-Host "  $($c.Name) -> paperclipai $v"
    }
    $latest = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) {
        $cacheDir = $latest.Name
        Write-Host "Using most recent: $cacheDir"
    } else {
        Write-Host "ERROR: No Paperclip install found."; exit 1
    }
}

$uiDist = "$env:USERPROFILE\AppData\Local\npm-cache\_npx\$cacheDir\node_modules\@paperclipai\server\ui-dist\assets"
if (-not (Test-Path $uiDist)) {
    Write-Host "ERROR: ui-dist not found at $uiDist"; exit 1
}

# --- 2. Find the bundle file(s) ---
$bundles = Get-ChildItem $uiDist -Filter "index-*.js" | Where-Object {
    (Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue) -match "self\.caches\s*=\s*_undefined"
}
if (-not $bundles) {
    Write-Host "Already patched (no unpatched self.caches assignments found)."
    exit 0
}

# --- 3. Patch each bundle ---
foreach ($bundle in $bundles) {
    Write-Host "`nPatching: $($bundle.Name)"
    $c = Get-Content $bundle.FullName -Raw

    # Count unsafe assignments before patching
    $before = ([regex]::Matches($c, 'self\.\w+ = _undefined;')).Count
    Write-Host "  Unsafe assignments found: $before"

    # Wrap each bare `self.X = _undefined;` in try/catch
    # Skip ones already inside try/catch (they have "try {" prefix)
    $patched = [regex]::Replace($c,
        '(?<!try \{ )self\.(\w+) = _undefined;',
        'try { self.$1 = _undefined; } catch(e) {}'
    )

    $after = ([regex]::Matches($patched, 'self\.\w+ = _undefined;')).Count
    Write-Host "  Unsafe assignments after:  $after"

    if ($before -eq $after -and $before -gt 0) {
        Write-Host "  WARNING: replacement may not have applied correctly."
    }

    # Backup original
    Copy-Item $bundle.FullName "$($bundle.FullName).pre-adapter-fix" -Force

    # Write patched file (no BOM)
    [IO.File]::WriteAllText($bundle.FullName, $patched, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "  Patched OK (backup: .pre-adapter-fix)"
}

# --- 4. Also patch the worker template if served from a separate file ---
# Some versions serve the worker template from a dedicated file
$workerFiles = Get-ChildItem $uiDist -Filter "*worker*" -File -ErrorAction SilentlyContinue
foreach ($wf in $workerFiles) {
    $wc = Get-Content $wf.FullName -Raw -ErrorAction SilentlyContinue
    if ($wc -match "self\.caches\s*=\s*_undefined" -and $wc -notmatch "try \{ self\.caches") {
        $wc = [regex]::Replace($wc,
            '(?<!try \{ )self\.(\w+) = _undefined;',
            'try { self.$1 = _undefined; } catch(e) {}'
        )
        Copy-Item $wf.FullName "$($wf.FullName).pre-adapter-fix" -Force
        [IO.File]::WriteAllText($wf.FullName, $wc, (New-Object System.Text.UTF8Encoding($false)))
        Write-Output "  Also patched worker file: $($wf.Name)"
    }
}

Write-Host "`n=== Patch complete ==="
Write-Host "Restart Paperclip to pick up the fix:"
Write-Host "  Close Paperclip, then run: npx -y paperclipai@latest run --instance default"
Write-Host ""
Write-Host "The fix wraps each Web Worker lockdown assignment in try/catch"
Write-Host "so getter-only properties (like caches) don't crash the parser worker."
