import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { OptionsClient, Overlay } from './support/driver';
import { launchExtension, type LaunchedExtension } from './support/extension';
import type { MockProviderServer } from './support/mock-provider-server';
import { MOCK_API_KEY } from './support/mock-providers';
import { extensionDir, fixturesDir, hasBuiltExtension } from './support/paths';
import { characterErrorRate } from './support/text';
import { expect, test } from './support/test';

/**
 * Lettering outside balloons and balloons drawn into each other, reported on 2026-11-20 (Noisering ch. 10 and 11).
 * Fixtures are original synthetic drawings from tests/fixtures/make-v049-fixtures.py:
 * - outlined-captions.png: three multi-line captions with black glyph interiors and a white outline over hatched,
 *   halftone and dark artwork, plus a white-outlined star and a hatched pillar that are artwork, not text.
 * - joined-balloons.png: a five-line balloon and a three-line balloon cut by the panel frame share one interior.
 *   The widest left line overlaps the right column's x range, as in the recording.
 * The whole image is selected with Select area, as the user did. Every host is routed in the browser and the provider
 * is the local mock, so only OCR output reaches it.
 */

const FLOW = Number(process.env.FLOW_TIMEOUT ?? 90_000);
const reader = 'https://reader.example/series/noise/chapter-11';
const cdn = 'https://img.reader.example';
const meta = JSON.parse(readFileSync(join(fixturesDir, 'v049-fixtures.json'), 'utf8')) as Record<string, {
  size: [number, number]; groups: Record<string, { text: string; boxes: [number, number, number, number][] }>;
  controls?: Record<string, [number, number, number, number]>;
}>;
const fixtures = {
  captions: { file: 'outlined-captions.png', width: 1266 },
  joined: { file: 'joined-balloons.png', width: 900 },
} as const;
const modes = ['conservative', 'constrained', 'normal'] as const;
const letters = (text: string) => text.toUpperCase().replace(/[^A-Z]/g, '');

test.skip(!hasBuiltExtension(), 'requires the unpacked extension');

let extension: LaunchedExtension | undefined;
test.afterEach(async () => { await extension?.dispose(); extension = undefined; });

async function open(mockProviders: MockProviderServer, kind: keyof typeof fixtures, mode: typeof modes[number]) {
  mockProviders.reset();
  extension = await launchExtension(extensionDir(), { mock: mockProviders,
    grantHosts: [reader, cdn, 'https://api-free.deepl.com'].map(url => new URL(url).origin + '/*') });
  const { file, width } = fixtures[kind];
  await extension.context.route(`${cdn}/${file}`, route => route.fulfill({ body: readFileSync(join(fixturesDir, file)),
    contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } }));
  await extension.context.route(reader, route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><style>body { margin: 0; background: #111 } img { display: block; margin: 20px }</style><img id="page" src="${cdn}/${file}" width="${width}">` }));
  const options = await OptionsClient.open(extension);
  await options.setSettings({ uiLanguage: 'en', enabled: true, provider: 'deepl', source: 'en', target: 'id', ocrLanguage: 'en',
    readingOrder: 'ttb', performance: 'wasm', prefetch: false, contextual: false, inpaintingMode: mode });
  await options.setCredential('deepl', MOCK_API_KEY);
  const page = await extension.context.newPage();
  await page.goto(reader);
  await expect.poll(() => page.locator('#page').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(meta[file].size[0]);
  expect((await options.activate(page)).ok).toBe(true);
  return { page, overlay: new Overlay(page), file };
}

/** Select area over the whole image, two pixels inside its edges. */
async function selectWhole(page: Page, overlay: Overlay) {
  await overlay.host.getByRole('button', { name: 'Select area', exact: true }).click();
  const box = (await page.locator('#page').boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2, { steps: 10 });
  await page.mouse.up();
}

/** Segments the provider received, matched one to one with the fixture groups by letter content. */
function matchGroups(mockProviders: MockProviderServer, file: string) {
  const sent = mockProviders.requests.flatMap(request => request.texts);
  const groups = Object.entries(meta[file].groups);
  const matches = groups.map(([name, group]) => {
    const scored = sent.map(text => ({ text, rate: characterErrorRate(letters(group.text), letters(text)) })).sort((a, b) => a.rate - b.rate);
    return { name, expected: group.text, best: scored[0]?.text, rate: scored[0]?.rate ?? 1 };
  });
  return { sent, matches };
}

function screenRegion(page: Page, image: { x: number; y: number; width: number }, natural: number, [x, y, w, h]: [number, number, number, number]) {
  const scale = image.width / natural;
  return page.screenshot({ clip: { x: image.x + x * scale, y: image.y + y * scale, width: w * scale, height: h * scale } });
}

for (const mode of modes) {
  test(`${mode}: outlined captions over artwork are translated as whole phrases and artwork stays`, async ({ mockProviders }) => {
    test.setTimeout(FLOW + 30_000);
    const { page, overlay, file } = await open(mockProviders, 'captions', mode);
    const image = (await page.locator('#page').boundingBox())!;
    const controls = Object.entries(meta[file].controls!);
    const before = await Promise.all(controls.map(([, box]) => screenRegion(page, image, meta[file].size[0], box)));
    await selectWhole(page, overlay);
    await expect(overlay.status).toHaveText(/^(Panel translated\.|Translated the areas that could be safely cleaned)/, { timeout: FLOW });
    const { sent, matches } = matchGroups(mockProviders, file);
    console.log(`${mode} captions:`, JSON.stringify({ status: await overlay.status.textContent(), sent }));
    // Each caption reaches the provider once, as one segment with every line.
    expect(sent, JSON.stringify(matches)).toHaveLength(3);
    for (const match of matches) expect(match.rate, JSON.stringify(match)).toBeLessThanOrEqual(0.15);
    await expect(overlay.status).toHaveText('Panel translated.');
    // Artwork controls are untouched on screen.
    const after = await Promise.all(controls.map(([, box]) => screenRegion(page, image, meta[file].size[0], box)));
    for (const [index, [name]] of controls.entries()) expect(after[index].equals(before[index]), `${name} changed`).toBe(true);
  });

  test(`${mode}: balloons drawn into each other keep their own lines`, async ({ mockProviders }) => {
    test.setTimeout(FLOW + 30_000);
    const { page, overlay, file } = await open(mockProviders, 'joined', mode);
    await selectWhole(page, overlay);
    await expect(overlay.status).toHaveText(/^(Panel translated\.|Translated the areas that could be safely cleaned)/, { timeout: FLOW });
    const { sent, matches } = matchGroups(mockProviders, file);
    console.log(`${mode} joined:`, JSON.stringify({ sent }));
    expect(sent, JSON.stringify(matches)).toHaveLength(2);
    for (const match of matches) expect(match.rate, JSON.stringify(match)).toBeLessThanOrEqual(0.1);
    await expect(overlay.status).toHaveText('Panel translated.');
  });
}
