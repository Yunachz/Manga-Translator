import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(here, '../../..');
export const fixturesDir = resolve(repoRoot, 'tests/fixtures');

/**
 * Directory holding the unpacked MV3 build. WXT writes `.output/chrome-mv3` by default.
 * Override with MANGA_EXTENSION_DIR when the build lands elsewhere.
 */
export function extensionDir(): string {
  return resolve(process.env.MANGA_EXTENSION_DIR ?? resolve(repoRoot, '.output/chrome-mv3'));
}

export function hasBuiltExtension(dir = extensionDir()): boolean {
  return existsSync(resolve(dir, 'manifest.json'));
}
