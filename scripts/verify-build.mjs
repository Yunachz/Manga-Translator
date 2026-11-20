// Assert the built manifest and ORT assets match packaging policy.
// Usage: npm run build && npm run verify:build [-- .output/chrome-mv3]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? '.output/chrome-mv3');
const manifestPath = join(outDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`No manifest at ${manifestPath}. Run npm run build first.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const errors = [];
const check = (cond, msg) => {
  if (!cond) errors.push(msg);
};
const sameSet = (a = [], b = []) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

check(manifest.manifest_version === 3, 'manifest_version must be 3');
check(manifest.minimum_chrome_version === '116', 'minimum_chrome_version must be 116');
check(
  sameSet(manifest.permissions, ['activeTab', 'scripting', 'storage', 'offscreen']),
  `permissions mismatch: ${JSON.stringify(manifest.permissions)}`,
);
check(
  sameSet(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']),
  `optional_host_permissions mismatch: ${JSON.stringify(manifest.optional_host_permissions)}`,
);
check(!manifest.host_permissions?.length, 'host_permissions must be empty');
check(!manifest.content_scripts?.length, 'content_scripts must not be auto-registered');
check(
  manifest.content_security_policy?.extension_pages ===
    "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  `CSP mismatch: ${JSON.stringify(manifest.content_security_policy)}`,
);

for (const file of [
  'ort/ort-wasm-simd-threaded.jsep.mjs',
  'ort/ort-wasm-simd-threaded.jsep.wasm',
  'ort/ort-wasm-simd-threaded.mjs',
  'ort/ort-wasm-simd-threaded.wasm',
]) {
  check(existsSync(join(outDir, file)), `missing ${file}`);
}

if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  process.exit(1);
}
console.log(`ok   ${manifestPath}`);
