import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const lock = JSON.parse(await readFile(new URL('./model-sources.json', import.meta.url), 'utf8'));
const outputDir = fileURLToPath(new URL('../public/models/', import.meta.url));
const options = new Set(process.argv.slice(2));
const optionalFlags = lock.models.flatMap(({ flag }) => flag ? [flag] : []);
const supportedOptions = new Set(['--help', ...optionalFlags]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function matchesFile(path, expectedBytes, expectedHash) {
  let current;
  try {
    current = await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!current.isFile() || current.size !== expectedBytes) return false;

  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === expectedHash;
}

async function stageFile(path, write) {
  const temporary = join(dirname(path), `.${randomUUID()}.part`);
  try {
    await write(temporary);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function installModel(model) {
  const path = join(outputDir, model.file);
  if (await matchesFile(path, model.bytes, model.sha256)) {
    console.log(`Verified ${model.file}`);
    return;
  }

  await stageFile(path, async (temporary) => {
    const signal = AbortSignal.timeout(120_000);
    const response = await fetch(model.url, { signal });
    if (!response.ok || !response.body) {
      throw new Error(`${model.file} download returned HTTP ${response.status}`);
    }

    const hash = createHash('sha256');
    let size = 0;
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > model.bytes) {
          callback(new Error(`${model.file} exceeded its pinned byte count`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temporary, { flags: 'wx' }), { signal });
    if (size !== model.bytes || hash.digest('hex') !== model.sha256) {
      throw new Error(`${model.file} failed its pinned byte count or SHA-256 check`);
    }
  });
  console.log(`Installed ${model.file}`);
}

async function installDictionary(dictionary) {
  const { file, count, entries } = dictionary;
  if (entries.length !== count || new Set(entries).size !== count ||
      entries.some((entry) => typeof entry !== 'string' || entry === '' || entry === ' ')) {
    throw new Error(`${file} contains invalid dictionary entries`);
  }
  const utf8 = Buffer.from(JSON.stringify(entries), 'utf8');
  if (sha256(utf8) !== dictionary.sha256) throw new Error(`${file} failed its pinned SHA-256 check`);

  const path = join(outputDir, file);
  if (await matchesFile(path, utf8.length, dictionary.sha256)) {
    console.log(`Verified ${file}`);
    return;
  }
  await stageFile(path, (temporary) => writeFile(temporary, utf8, { flag: 'wx' }));
  console.log(`Installed ${file}`);
}

try {
  const unknown = [...options].find((flag) => !supportedOptions.has(flag));
  if (unknown) throw new Error(`Unknown option ${unknown}`);

  if (options.has('--help')) {
    console.log(`Usage: node scripts/setup-models.mjs ${optionalFlags.map((flag) => `[${flag}]`).join(' ')}`);
  } else {
    await mkdir(outputDir, { recursive: true });
    for (const model of lock.models) {
      if (!model.flag || options.has(model.flag)) await installModel(model);
    }
    for (const dictionary of lock.dictionaries) await installDictionary(dictionary);
  }
} catch (error) {
  console.error(`Model setup failed: ${error.message}`);
  process.exitCode = 1;
}
