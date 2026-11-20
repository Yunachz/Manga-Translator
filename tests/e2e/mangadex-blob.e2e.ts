import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OptionsClient, Overlay } from './support/driver';
import { launchExtension, type LaunchedExtension } from './support/extension';
import { MOCK_API_KEY } from './support/mock-providers';
import { extensionDir, fixturesDir, hasBuiltExtension } from './support/paths';
import { expect, test } from './support/test';

/**
 * MangaDex renders pages from `blob:` URLs. A panel click must read those pixels from the page itself:
 * no second request for the image, no extra API call, and the visible-area capture stays a fallback.
 * The reader below makes real blobs with fetch and URL.createObjectURL and moves between pages like the
 * single-page reader. Every external host is routed inside the browser, so nothing reaches the live site.
 */
const dexId = 'f49c0d3e-ddb1-487b-9514-39f781b8a168';
const dex = 'https://mangadex.org/chapter/' + dexId;
const cdn = 'https://uploads.mangadex.org/data/abcd';
const pages = [cdn + '/p003.png', cdn + '/p004.png'];
const files = ['page-a.png', 'page-b.png'].map(file => readFileSync(join(fixturesDir, file)));
const grantHosts = [dex, cdn, 'https://api.mangadex.org', 'https://api-free.deepl.com'].map(url => new URL(url).origin + '/*');

const readerHtml = `<!doctype html><style>body { margin: 0 } main { width: 570px }</style>
<main><img id="reader" width="570"></main><button id="next">next</button>
<script>
  const pages = ${JSON.stringify(pages)};
  let current = 3;
  async function show(index) {
    const blob = await (await fetch(pages[index - 3])).blob();
    const image = document.getElementById('reader');
    const previous = image.src;
    image.src = URL.createObjectURL(blob);
    history.replaceState({}, '', '/chapter/${dexId}/' + index);
    if (previous.startsWith('blob:')) URL.revokeObjectURL(previous);
    current = index;
  }
  document.getElementById('next').onclick = () => show(current + 1);
  window.revokeCurrent = () => URL.revokeObjectURL(document.getElementById('reader').src);
  show(3);
</script>`;

test.skip(!hasBuiltExtension(), 'requires the unpacked extension');
let extension: LaunchedExtension;
let options: OptionsClient;
const requests: string[] = [];

test.beforeAll(async ({ mockProviders }) => {
  extension = await launchExtension(extensionDir(), { mock: mockProviders, grantHosts });
  const { context } = extension;
  context.on('request', request => {
    if (/uploads\.mangadex\.org|api\.mangadex\.org/.test(request.url())) requests.push(request.url());
  });
  for (const [index, src] of pages.entries()) {
    await context.route(src, route => route.fulfill({ body: files[index], contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' } }));
  }
  await context.route(dex + '/**', route => route.fulfill({ contentType: 'text/html', body: readerHtml }));
  await context.route('https://api.mangadex.org/**', route => route.fulfill({ status: 500 }));
  options = await OptionsClient.open(extension);
  await options.setSettings({ enabled: true, provider: 'deepl', source: 'en', target: 'id', ocrLanguage: 'en',
    readingOrder: 'ttb', performance: 'wasm', prefetch: false, uiLanguage: 'en' });
  await options.setCredential('deepl', MOCK_API_KEY);
});

test.afterAll(async () => { await extension?.dispose(); });
test.beforeEach(async () => { await options.clearCache(); });

async function open() {
  const page = await extension.context.newPage();
  await page.goto(dex + '/3');
  const image = page.locator('#reader');
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).src.startsWith('blob:https://mangadex.org/'))).toBe(true);
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete &&
    (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
  expect((await options.activate(page)).ok).toBe(true);
  return { page, image, overlay: new Overlay(page) };
}

test('a direct click translates the rendered blob without another image or API request', async () => {
  test.setTimeout(120_000);
  const { page, image, overlay } = await open();
  try {
    const before = requests.length;
    await image.click({ position: { x: 130, y: 190 } });
    await expect(overlay.patches).toHaveCount(1, { timeout: 60_000 });
    await expect(overlay.status).not.toContainText('available in the reader tab');
    expect(requests.slice(before)).toEqual([]);
  } finally {
    await page.close();
  }
});

test('a revoked blob is read from the decoded image', async () => {
  test.setTimeout(120_000);
  const { page, image, overlay } = await open();
  try {
    await page.evaluate(() => (window as unknown as { revokeCurrent(): void }).revokeCurrent());
    const before = requests.length;
    await image.click({ position: { x: 130, y: 190 } });
    await expect(overlay.patches).toHaveCount(1, { timeout: 60_000 });
    expect(requests.slice(before)).toEqual([]);
  } finally {
    await page.close();
  }
});

test('Select area on a blob crops the image instead of the screen capture', async () => {
  test.setTimeout(120_000);
  const { page, image, overlay } = await open();
  try {
    await overlay.button('Select area').click();
    const box = (await image.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 285, box.y + 285, { steps: 5 });
    await page.mouse.up();
    await expect(overlay.patches).toHaveCount(1, { timeout: 60_000 });
    await expect(overlay.button('Select visible area')).toHaveCount(0);
  } finally {
    await page.close();
  }
});

test('page navigation replaces the blob and each page gets its own result', async () => {
  test.setTimeout(120_000);
  const { page, image, overlay } = await open();
  try {
    await image.click({ position: { x: 130, y: 190 } });
    await expect(overlay.patches).toHaveCount(1, { timeout: 60_000 });
    await page.locator('#next').click();
    await expect.poll(() => page.url()).toContain('/4');
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete &&
      (element as HTMLImageElement).src.startsWith('blob:'))).toBe(true);
    await expect(overlay.patches).toHaveCount(0);
    await image.click({ position: { x: 130, y: 190 } });
    await expect(overlay.patches).toHaveCount(1, { timeout: 60_000 });
  } finally {
    await page.close();
  }
});
