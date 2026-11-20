import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Model assets and the unpacked build.
 *
 * - public/models: byte count and SHA-256 against scripts/model-sources.json. Needs `node scripts/setup-models.mjs`.
 * - build output: runs only when `.output/chrome-mv3/manifest.json` exists (override with MANGA_EXTENSION_DIR).
 *   Checks that the packaged models are byte-identical to the source models and that everything the
 *   manifest and HTML pages reference is present.
 */

const root = resolve(__dirname, '../..');
const lock = JSON.parse(readFileSync(join(root, 'scripts/model-sources.json'), 'utf8')) as {
  models: { file: string; bytes: number; sha256: string; flag?: string }[];
  dictionaries: { file: string; count: number; sha256: string; entries: string[] }[];
};
const modelsDir = join(root, 'public/models');
const buildDir = resolve(process.env.MANGA_EXTENSION_DIR ?? join(root, '.output/chrome-mv3'));
const hasBuild = existsSync(join(buildDir, 'manifest.json'));

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const required = lock.models.filter(model => !model.flag);

describe('source model assets (public/models)', () => {
  it('lists the four PP-OCRv5 graphs and three dictionaries as required', () => {
    expect(required.map(model => model.file).sort()).toEqual(['det.onnx', 'rec-cjk.onnx', 'rec-en.onnx', 'rec-ko.onnx']);
    expect(lock.dictionaries.map(dictionary => dictionary.file).sort()).toEqual(['rec-cjk.json', 'rec-en.json', 'rec-ko.json']);
  });

  it.each(required.map(model => [model.file, model] as const))('%s matches its pinned size and SHA-256', (file, model) => {
    const path = join(modelsDir, file);
    expect(existsSync(path), `${file} missing: run "node scripts/setup-models.mjs"`).toBe(true);
    expect(statSync(path).size).toBe(model.bytes);
    expect(sha256(path)).toBe(model.sha256);
  });

  it.each(lock.dictionaries.map(dictionary => [dictionary.file, dictionary] as const))('%s is the locked ordered array', (file, dictionary) => {
    const path = join(modelsDir, file);
    expect(existsSync(path), `${file} missing: run "node scripts/setup-models.mjs"`).toBe(true);
    const bytes = readFileSync(path);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(dictionary.sha256);
    const entries = JSON.parse(bytes.toString('utf8')) as unknown;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toEqual(dictionary.entries);
    expect((entries as string[]).length).toBe(dictionary.count);
  });

  it.each(lock.dictionaries.map(dictionary => [dictionary.file, dictionary] as const))('%s has unique, non-empty string entries and no bare ASCII space', (_file, dictionary) => {
    expect(new Set(dictionary.entries).size).toBe(dictionary.entries.length);
    for (const entry of dictionary.entries) {
      expect(typeof entry).toBe('string');
      expect(entry).not.toBe('');
      expect(entry).not.toBe(' '); // the recognizer appends its own space class; the CTC decoder maps overflow to ' '
    }
  });

  it('keeps ideographic space distinct from ASCII space in the CJK dictionary', () => {
    const cjk = lock.dictionaries.find(dictionary => dictionary.file === 'rec-cjk.json')!;
    expect(cjk.entries).toContain('\u3000');
    expect(cjk.entries).not.toContain(' ');
  });

  it('covers the characters in the fixture bubbles', () => {
    const cjk = new Set(lock.dictionaries.find(dictionary => dictionary.file === 'rec-cjk.json')!.entries);
    const en = new Set(lock.dictionaries.find(dictionary => dictionary.file === 'rec-en.json')!.entries);
    for (const char of '行こう！星が見える。船が来た！波が高い。') expect(cjk.has(char), `cjk: ${char}`).toBe(true);
    for (const char of 'THE LIGHT IS ON.WAITFORME!OVERHERE!'.replace(/ /g, '')) expect(en.has(char), `en: ${char}`).toBe(true);
  });

  it('has a locked HTTPS source pinned to an exact revision for every graph', () => {
    const models = lock.models as unknown as { file: string; url: string }[];
    for (const model of models) expect(model.url, model.file).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//);
  });
});

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)]);
}

describe.runIf(hasBuild)('packaged build', () => {
  interface Manifest {
    manifest_version: number;
    background?: { service_worker?: string };
    action?: { default_popup?: string; default_icon?: Record<string, string> | string };
    options_ui?: { page?: string };
    options_page?: string;
    icons?: Record<string, string>;
  }
  const readManifest = () => JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8')) as Manifest;

  it('is a manifest v3 build', () => {
    expect(readManifest().manifest_version).toBe(3);
  });

  it.each(required.map(model => [model.file, model] as const))('packages %s byte-identical to the source model', (file, model) => {
    const path = join(buildDir, 'models', file);
    expect(existsSync(path), `${file} not packaged`).toBe(true);
    expect(statSync(path).size).toBe(model.bytes);
    expect(sha256(path)).toBe(model.sha256);
  });

  it.each(lock.dictionaries.map(dictionary => [dictionary.file, dictionary] as const))('packages %s byte-identical', (file, dictionary) => {
    const path = join(buildDir, 'models', file);
    expect(existsSync(path), `${file} not packaged`).toBe(true);
    expect(sha256(path)).toBe(dictionary.sha256);
  });

  it('packages no model that the lock does not know about', () => {
    const dir = join(buildDir, 'models');
    const known = new Set([...lock.models.map(model => model.file), ...lock.dictionaries.map(dictionary => dictionary.file)]);
    for (const file of readdirSync(dir)) expect(known.has(file), `unexpected packaged file models/${file}`).toBe(true);
  });

  it('ships the optional panel and LaMa graphs only if they were staged on purpose', () => {
    for (const model of lock.models.filter(item => item.flag)) {
      expect(existsSync(join(buildDir, 'models', model.file)), model.file).toBe(existsSync(join(modelsDir, model.file)));
    }
  });

  it('ships ORT runtime pairs with valid WASM binaries and ES modules next to them', () => {
    const wasm = listFiles(join(buildDir, 'ort')).filter(file => file.endsWith('.wasm'));
    expect(wasm.length).toBeGreaterThan(0);
    for (const file of wasm) {
      const head = readFileSync(file).subarray(0, 4);
      expect([...head], relative(buildDir, file)).toEqual([0x00, 0x61, 0x73, 0x6d]);
      const loader = file.replace(/\.wasm$/, '.mjs');
      expect(existsSync(loader), `${relative(buildDir, loader)} missing`).toBe(true);
      expect(statSync(loader).size).toBeGreaterThan(1000);
    }
  });

  it('has every file the manifest references', () => {
    const manifest = readManifest();
    const referenced = [
      manifest.background?.service_worker, manifest.action?.default_popup, manifest.options_ui?.page, manifest.options_page,
      ...Object.values(manifest.icons ?? {}),
      ...(typeof manifest.action?.default_icon === 'object' ? Object.values(manifest.action.default_icon) : []),
    ].filter((value): value is string => typeof value === 'string');
    for (const file of referenced) expect(existsSync(join(buildDir, file)), `manifest references missing ${file}`).toBe(true);
  });

  it('has every script and stylesheet that the packaged HTML pages reference', () => {
    const pages = listFiles(buildDir).filter(file => file.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const html = readFileSync(page, 'utf8');
      for (const [, , target] of [...html.matchAll(/<(script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)]) {
        if (/^(https?:|data:|#)/.test(target)) {
          expect(/^https?:/.test(target), `${relative(buildDir, page)} loads remote ${target}`).toBe(false);
          continue;
        }
        const resolved = target.startsWith('/') ? join(buildDir, target) : resolve(dirname(page), target);
        expect(existsSync(resolved), `${relative(buildDir, page)} -> ${target}`).toBe(true);
      }
    }
  });

  it('loads no code from remote hosts in any packaged HTML page (extension_pages CSP)', () => {
    for (const page of listFiles(buildDir).filter(file => file.endsWith('.html'))) {
      expect(readFileSync(page, 'utf8'), relative(buildDir, page)).not.toMatch(/<script[^>]+src="https?:/);
    }
  });

  it('keeps the package at a sane size', () => {
    const total = listFiles(buildDir).reduce((sum, file) => sum + statSync(file).size, 0);
    const modelBytes = required.reduce((sum, model) => sum + model.bytes, 0);
    expect(total).toBeGreaterThan(modelBytes);
    expect(total).toBeLessThan(modelBytes + 150 * 1024 * 1024);
  });
});

describe.skipIf(hasBuild)('packaged build (not built)', () => {
  it.skip(`no manifest at ${buildDir}; run "npm run build" to enable the packaged-asset checks`, () => undefined);
});
