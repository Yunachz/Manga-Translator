// Offline preflight: required model files in public/models must match the
// pinned size and SHA-256 in scripts/model-sources.json. Optional models
// (entries with a "flag") are checked only when present.
// Usage: npm run models:verify   (also runs before build and zip)
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lock = JSON.parse(
  await readFile(new URL('./model-sources.json', import.meta.url), 'utf8'),
);
const modelsDir = fileURLToPath(new URL('../public/models/', import.meta.url));

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const problems = [];
const entries = [
  ...lock.models.map((m) => ({ file: m.file, bytes: m.bytes, sha256: m.sha256, optional: Boolean(m.flag) })),
  ...lock.dictionaries.map((d) => ({
    file: d.file,
    bytes: Buffer.byteLength(JSON.stringify(d.entries), 'utf8'),
    sha256: d.sha256,
    optional: false,
  })),
];

for (const entry of entries) {
  const path = join(modelsDir, entry.file);
  if (!existsSync(path)) {
    if (!entry.optional) problems.push(`${entry.file}: missing`);
    continue;
  }
  if (statSync(path).size !== entry.bytes) {
    problems.push(`${entry.file}: size ${statSync(path).size}, expected ${entry.bytes}`);
  } else if ((await sha256(path)) !== entry.sha256) {
    problems.push(`${entry.file}: SHA-256 mismatch`);
  } else {
    console.log(`ok   ${entry.file}`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  console.error('Run: npm run models:setup');
  process.exit(1);
}
