import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'wxt';

/**
 * ONNX Runtime Web 1.31 runtime files copied verbatim into the extension
 * package under `ort/`. Extension pages cannot load code from a CDN
 * (CSP `script-src 'self'`), so every .mjs/.wasm pair ORT may request at
 * runtime must ship locally.
 *
 * Variant -> import entry that requests it (verified in dist/*.min.mjs):
 *   jsep      `onnxruntime-web`          (WebGPU + WASM EPs, default entry)
 *   wasm      `onnxruntime-web/wasm`     (CPU-only WASM EP)
 *   asyncify  `onnxruntime-web/webgpu`   (WebGPU via Asyncify)
 *   jspi      `onnxruntime-web/jspi`     (WebGPU via JSPI)
 *
 * Default ships `jsep` (actual WebGPU variant) plus `wasm` (CPU fallback).
 * Override with e.g. `ORT_VARIANTS=jsep,wasm,asyncify npm run build`.
 */
const ORT_VARIANT_FILES: Record<string, string[]> = {
  wasm: ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'],
  jsep: ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'],
  asyncify: [
    'ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
  ],
  jspi: ['ort-wasm-simd-threaded.jspi.mjs', 'ort-wasm-simd-threaded.jspi.wasm'],
};

const ortVariants = (process.env.ORT_VARIANTS ?? 'jsep,wasm')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const icons = { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' };

for (const variant of ortVariants) {
  if (!(variant in ORT_VARIANT_FILES)) {
    throw new Error(
      `Unknown ORT_VARIANTS entry "${variant}". Valid: ${Object.keys(ORT_VARIANT_FILES).join(', ')}`,
    );
  }
}

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  manifestVersion: 3,
  // Chromium only; Firefox/Safari targets are out of scope.
  browser: 'chrome',

  manifest: {
    name: 'Manga Translator',
    description: 'Translate manga pages in the browser with local ONNX models.',
    minimum_chrome_version: '116',
    icons,
    action: { default_icon: { 16: icons[16], 32: icons[32] } },
    permissions: ['activeTab', 'scripting', 'storage', 'offscreen'],
    // No required hosts. Reader origins are requested at runtime by the user.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },

  // Resolve `onnxruntime-web` to its extern-wasm build (ort.min.mjs). The
  // default bundled build inlines a hashed copy of the 29 MB jsep .wasm next
  // to the .mjs we already ship under ort/. `wasmPaths` points at ort/.
  // Setting `conditions` replaces Vite's defaults, so re-add them.
  vite: () => ({
    define: {
      __MANGA_PANEL_MODEL__: JSON.stringify(existsSync(resolve('public/models/panel.onnx'))),
      __MANGA_LAMA_MODEL__: JSON.stringify(existsSync(resolve('public/models/lama.onnx'))),
    },
    resolve: {
      conditions: [...defaultClientConditions, 'onnxruntime-web-use-extern-wasm'],
    },
  }),

  hooks: {
    // Ship local ORT .mjs/.wasm assets (build, zip, and dev) via copy.
    'build:publicAssets': (wxt, files) => {
      const require = createRequire(`${wxt.config.root}/package.json`);
      for (const variant of ortVariants) {
        for (const file of ORT_VARIANT_FILES[variant] ?? []) {
          files.push({
            // Resolved through the package `exports` map; throws if missing.
            absoluteSrc: require.resolve(`onnxruntime-web/${file}`),
            relativeDest: `ort/${file}`,
          });
        }
      }
    },

    // Enforce manifest policy after WXT merges entrypoint-derived fields.
    'build:manifestGenerated': (wxt, manifest) => {
      // Runtime-registered content scripts make WXT add their `matches` to
      // host_permissions. Hosts must stay optional-only.
      if (manifest.host_permissions?.length) {
        wxt.logger.warn(
          `Removing required host_permissions: ${manifest.host_permissions.join(', ')}`,
        );
      }
      delete manifest.host_permissions;
      // No static content-script auto-registration.
      delete manifest.content_scripts;
    },
  },
});
