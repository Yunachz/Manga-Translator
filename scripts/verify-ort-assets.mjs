// Check that installed onnxruntime-web ships the .mjs/.wasm pairs wxt.config.ts copies.
// Usage: npm run verify:ort
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const files = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
];

let failed = false;
for (const file of files) {
  try {
    const path = require.resolve(`onnxruntime-web/${file}`);
    if (!existsSync(path)) throw new Error('missing on disk');
    console.log(`ok   ${file}  ${(statSync(path).size / 1e6).toFixed(1)} MB`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${file}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
