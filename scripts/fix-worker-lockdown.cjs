const fs = require("fs");
const path = require("path");

const uiDist = path.join(
  process.env.USERPROFILE,
  "AppData", "Local", "npm-cache", "_npx",
  "0aa74679bec75e15",
  "node_modules", "@paperclipai", "server", "ui-dist", "assets"
);

// Find bundle files that need patching
const bundles = fs.readdirSync(uiDist)
  .filter(f => f.match(/^index-.*\.js$/))
  .map(f => path.join(uiDist, f))
  .filter(f => {
    const c = fs.readFileSync(f, "utf8");
    return c.includes("self.caches=_undefined") || c.includes("self.caches = _undefined");
  });

if (bundles.length === 0) {
  console.log("Already patched or nothing to patch.");
  process.exit(0);
}

for (const bundle of bundles) {
  console.log("Patching:", path.basename(bundle));

  // Read as UTF-8 (Node handles this natively)
  let c = fs.readFileSync(bundle, "utf8");

  // Count unsafe assignments
  const unsafe = /self\.\w+\s*=\s*_undefined;/g;
  const before = (c.match(unsafe) || []).length;
  console.log("  Unsafe assignments:", before);

  // Backup
  fs.copyFileSync(bundle, bundle + ".pre-adapter-fix");

  // Wrap each bare assignment in try/catch
  // Handle both `self.X=_undefined;` and `self.X = _undefined;` (minified vs formatted)
  c = c.replace(
    /(?<!try\s*\{\s*)self\.(\w+)\s*=\s*_undefined\s*;/g,
    (match, propName) => {
      return `try{self.${propName}=_undefined}catch(e){}`;
    }
  );

  // Verify
  const after = (c.match(/self\.\w+\s*=\s*_undefined;/g) || []).filter(
    s => !s.startsWith("try{")
  ).length;

  console.log("  After patching, unwrapped:", after);

  // Write back as UTF-8 (no BOM) - Node preserves all multi-byte chars
  fs.writeFileSync(bundle, c, "utf8");
  console.log("  Patched OK (backup: .pre-adapter-fix)");
}

// Also check worker files
const workerFiles = fs.readdirSync(uiDist)
  .filter(f => f.includes("worker") && f.endsWith(".js"))
  .map(f => path.join(uiDist, f))
  .filter(f => {
    try { return fs.readFileSync(f, "utf8").includes("self.caches"); } catch { return false; }
  });

for (const wf of workerFiles) {
  let wc = fs.readFileSync(wf, "utf8");
  if (wc.includes("self.caches=_undefined") || wc.includes("self.caches = _undefined")) {
    fs.copyFileSync(wf, wf + ".pre-adapter-fix");
    wc = wc.replace(
      /(?<!try\s*\{\s*)self\.(\w+)\s*=\s*_undefined\s*;/g,
      "try{self.$1=_undefined}catch(e){}"
    );
    fs.writeFileSync(wf, wc, "utf8");
    console.log("Worker file patched:", path.basename(wf));
  }
}

console.log("\nDone. Restart Paperclip to pick up the fix.");
