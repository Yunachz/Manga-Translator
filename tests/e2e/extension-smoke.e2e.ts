import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { OptionsClient, Overlay, copy } from './support/driver';
import { launchExtension, readManifest, type LaunchedExtension } from './support/extension';
import { MOCK_API_KEY, providerHosts } from './support/mock-providers';
import { loadOracle, viewportPoint } from './support/oracle';
import { extensionDir, fixturesDir, hasBuiltExtension } from './support/paths';
import { characterErrorRate } from './support/text';
import { expect, test } from './support/test';

/**
 * Integrated smoke of the unpacked build in a persistent Chromium profile.
 *
 * What is real: the packaged service worker, offscreen document, inference worker, ONNX Runtime WASM,
 * PP-OCRv5 models, classical panel detection, provider adapters, typesetting and the reader overlay.
 * What is mocked: provider HTTP. Provider hostnames resolve to a local HTTPS mock, all other external
 * hosts fail to resolve, and the only secret is a sentinel string the mock accepts.
 *
 * Host access: Chromium cannot automate the optional-permission prompt (it hangs headless), so tests
 * that need access run a temporary COPY of the build with `host_permissions` added. The "as packaged"
 * tests use the build untouched.
 */

const oracle = loadOracle();
const pageA = oracle.pages['page-a.png'];
const pageB = oracle.pages['page-b.png'];
const panel = (page: typeof pageA, id: string) => page.panels.find(item => item.id === id)!;
const providerHostPatterns = Object.keys(providerHosts).map(host => `https://${host}/*`);
const FLOW_TIMEOUT = Number(process.env.FLOW_TIMEOUT ?? 120_000);

const buildPresent = hasBuiltExtension();
test.skip(!buildPresent, `no unpacked build at ${extensionDir()}; run "npm run build" or set MANGA_EXTENSION_DIR`);

async function readerPage(ext: LaunchedExtension, origin: string, path = '/reader.html'): Promise<Page> {
  const page = await ext.context.newPage();
  await page.goto(origin + path);
  await page.waitForLoadState('load');
  return page;
}

/** Page rectangle of a normalized `[left, top, width, height]` box on an image element, in the current viewport. */
async function regionClip(page: Page, selector: string, bounds: [number, number, number, number]) {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + bounds[0] * box.width, y: box.y + bounds[1] * box.height, width: bounds[2] * box.width, height: bounds[3] * box.height };
}

async function clickAt(page: Page, point: { x: number; y: number }) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
}

test.describe('as packaged (no host access granted)', () => {
  let ext: LaunchedExtension;
  test.beforeAll(async ({ mockProviders }) => {
    ext = await launchExtension(extensionDir(), { mock: mockProviders });
  });
  test.afterAll(async () => { await ext?.dispose(); });

  test('manifest in the browser matches the packaging policy', async () => {
    const manifest = await readManifest(ext);
    const onDisk = JSON.parse(readFileSync(join(extensionDir(), 'manifest.json'), 'utf8')) as typeof manifest;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe(onDisk.version);
    expect([...(manifest.permissions ?? [])].sort()).toEqual(['activeTab', 'offscreen', 'scripting', 'storage']);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.content_scripts ?? []).toEqual([]);
    expect(manifest.optional_host_permissions ?? []).toEqual(expect.arrayContaining(['https://*/*', 'http://*/*']));
    expect(manifest.content_security_policy?.extension_pages).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    expect(manifest.content_security_policy?.extension_pages).not.toMatch(/(?<!wasm-)unsafe-eval/);
  });

  test('service worker starts and the trusted pages load without console errors', async () => {
    const options = await OptionsClient.open(ext);
    await expect(options.page.locator('body')).not.toBeEmpty();
    const popup = await ext.context.newPage();
    await popup.goto(`chrome-extension://${ext.id}/popup.html`);
    await expect(popup.locator('body')).not.toBeEmpty();
    await popup.close();
    await options.page.close();
    expect(ext.errors).toEqual([]);
  });

  test('refuses to activate a reader tab it has no access to, and leaves the page untouched', async ({ fixtureServer }) => {
    const options = await OptionsClient.open(ext);
    await options.setSettings({ enabled: true });
    const reader = await readerPage(ext, fixtureServer.origin);
    const reply = await options.activate(reader);
    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.error.code).toBe('IMAGE_UNSUPPORTED');
    await expect(new Overlay(reader).host).toHaveCount(0);
    await reader.close();
    await options.page.close();
  });

  test('ignores UI requests from a page that is not an extension document', async ({ fixtureServer }) => {
    const reader = await readerPage(ext, fixtureServer.origin);
    const outcome = await reader.evaluate(() => typeof (globalThis as { chrome?: { runtime?: unknown } }).chrome?.runtime?.constructor);
    expect(['undefined', 'object', 'function']).toContain(outcome);
    // The reader cannot reach the background settings API: there is no runtime.sendMessage to the extension from a web page.
    const exposed = await reader.evaluate(() => Boolean((globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime?.sendMessage));
    expect(exposed).toBe(false);
    await reader.close();
  });
});

test.describe('integrated flow (host access granted via build copy)', () => {
  test.describe.configure({ mode: 'serial' });
  let ext: LaunchedExtension;
  let options: OptionsClient;

  test.beforeAll(async ({ mockProviders }) => {
    ext = await launchExtension(extensionDir(), { mock: mockProviders, grantHosts: ['http://127.0.0.1/*', ...providerHostPatterns] });
    options = await OptionsClient.open(ext);
    await options.setSettings({ uiLanguage: 'id', enabled: true, provider: 'deepl', source: 'auto', target: 'id', performance: 'wasm', prefetch: false, contextual: false });
    await options.setCredential('deepl', MOCK_API_KEY);
  });

  test.afterAll(async () => {
    await ext?.dispose();
  });

  test.beforeEach(async ({ mockProviders }) => {
    mockProviders.reset();
    await options.clearCache();
    await options.setSettings({ provider: 'deepl' });
    await options.setCredential('deepl', MOCK_API_KEY);
  });

  async function activated(origin: string, path?: string) {
    const reader = await readerPage(ext, origin, path);
    const reply = await options.activate(reader);
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    const overlay = new Overlay(reader);
    await expect(overlay.status).toHaveText(copy.idle);
    return { reader, overlay };
  }

  test('activation shows the overlay, deactivation removes its effect, and the reader controls still work', async ({ fixtureServer }) => {
    const { reader, overlay } = await activated(fixtureServer.origin);
    await expect(overlay.host).toBeVisible();
    await expect(reader.locator('html')).toHaveClass(/manga-translate-mode/);

    await reader.locator('#queue-page-b').click({ force: true }); // reader page keeps working while armed
    await reader.reload();
    await options.activate(reader, false);
    await expect(reader.locator('html')).not.toHaveClass(/manga-translate-mode/);
    await reader.close();
  });

  test('in-page anchor navigation keeps the reader active', async ({ fixtureServer }) => {
    // Regression: chrome.tabs.onUpdated fires {status:'loading'} for fragment navigation, which used to clear the tab state.
    const { reader, overlay } = await activated(fixtureServer.origin);
    await reader.getByRole('link', { name: 'Go to picture reader' }).click();
    await reader.waitForTimeout(500);
    expect((await options.tabStatus(await options.tabIdOf(reader))).active).toBe(true);
    await expect(overlay.host).toBeVisible();
    await reader.close();
  });

  test('ja bubble: click -> local OCR -> mocked translation -> typeset patch aligned to the panel', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    const { reader, overlay } = await activated(fixtureServer.origin);
    const a1 = panel(pageA, 'A1');
    const a2 = panel(pageA, 'A2');
    const point = await viewportPoint(reader, '#plain-page', a1.click);
    const neighbourBefore = await reader.screenshot({ clip: await regionClip(reader, '#plain-page', a2.bounds) });
    const targetBefore = await reader.screenshot({ clip: await regionClip(reader, '#plain-page', a1.bounds) });

    await clickAt(reader, point);
    await expect(overlay.status).toHaveText(copy.done, { timeout: FLOW_TIMEOUT });
    await expect(overlay.patches).toHaveCount(1);

    // OCR: one segment with the baked-in text, sent to the selected provider only.
    expect(mockProviders.requests).toHaveLength(1);
    const [request] = mockProviders.requests;
    expect(request).toMatchObject({ provider: 'deepl', authorized: true });
    const ocr = request.texts.join(' ');
    test.info().annotations.push({ type: 'ocr-ja', description: `${JSON.stringify(ocr)} vs ${JSON.stringify(a1.text)}` });
    expect(characterErrorRate(a1.text, ocr)).toBeLessThanOrEqual(0.25);

    // Patch sits on the clicked panel and nowhere else.
    const image = (await reader.locator('#plain-page').boundingBox())!;
    const patch = (await overlay.patches.first().boundingBox())!;
    const [left, top, width, height] = a1.bounds;
    expect(patch.x).toBeCloseTo(image.x + left * image.width, -1);
    expect(patch.y).toBeCloseTo(image.y + top * image.height, -1);
    expect(Math.abs(patch.width - width * image.width)).toBeLessThan(0.03 * image.width);
    expect(Math.abs(patch.height - height * image.height)).toBeLessThan(0.03 * image.height);
    await expect(overlay.patches.first()).toHaveAttribute('data-panel', /.+/);

    // Pixels: panel A1 changed, panel A2 untouched.
    const neighbourAfter = await reader.screenshot({ clip: await regionClip(reader, '#plain-page', a2.bounds) });
    const targetAfter = await reader.screenshot({ clip: await regionClip(reader, '#plain-page', a1.bounds) });
    expect(neighbourAfter.equals(neighbourBefore)).toBe(true);
    expect(targetAfter.equals(targetBefore)).toBe(false);

    await reader.close();
  });

  test('en bubble through the same path, and the plain image keeps its other panels', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    const { reader, overlay } = await activated(fixtureServer.origin);
    const a2 = panel(pageA, 'A2');
    await clickAt(reader, await viewportPoint(reader, '#plain-page', a2.click));
    await expect(overlay.status).toHaveText(copy.done, { timeout: FLOW_TIMEOUT });
    const ocr = mockProviders.requests[0].texts.join(' ');
    test.info().annotations.push({ type: 'ocr-en', description: `${JSON.stringify(ocr)} vs ${JSON.stringify(a2.text)}` });
    expect(characterErrorRate(a2.text, ocr)).toBeLessThanOrEqual(0.25);
    await expect(overlay.patches).toHaveCount(1);
    await reader.close();
  });

  test('original/translation toggle hides and restores the patch', async ({ fixtureServer }) => {
    test.setTimeout(FLOW_TIMEOUT);
    const { reader, overlay } = await activated(fixtureServer.origin);
    const a1 = panel(pageA, 'A1');
    await clickAt(reader, await viewportPoint(reader, '#plain-page', a1.click));
    await expect(overlay.status).toHaveText(copy.done, { timeout: FLOW_TIMEOUT });
    await expect(overlay.patches).toBeVisible();
    // Leave the image before the baseline so the hover outline does not enter the pixel comparison.
    await reader.mouse.move(8, 8);
    await reader.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const clip = await regionClip(reader, '#plain-page', a1.bounds);
    const translated = await reader.screenshot({ clip });

    await overlay.button(copy.showOriginal).click();
    await expect(overlay.patches).toBeHidden();
    await expect(overlay.button(copy.showTranslation)).toBeVisible();
    const original = await reader.screenshot({ clip });
    expect(original.equals(translated)).toBe(false);

    await overlay.button(copy.showTranslation).click();
    await expect(overlay.patches).toBeVisible();
    expect((await reader.screenshot({ clip })).equals(translated)).toBe(true);
    await reader.close();
  });

  test('a click in a gutter reports no panel and offers manual selection without calling the provider', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    const { reader, overlay } = await activated(fixtureServer.origin);
    const gutter = pageA.outsidePanels.find(item => item.position.includes('horizontal'))!;
    await clickAt(reader, await viewportPoint(reader, '#plain-page', gutter.click));
    await expect(overlay.status).toContainText(copy.noPanel, { timeout: FLOW_TIMEOUT });
    await expect(overlay.button('Pilih area')).toBeVisible();
    await expect(overlay.patches).toHaveCount(0);
    expect(mockProviders.requests).toEqual([]);
    await reader.close();
  });

  test('Select area stays available after success and a short drag can be retried on another panel', async ({ fixtureServer }) => {
    test.setTimeout(FLOW_TIMEOUT);
    const { reader, overlay } = await activated(fixtureServer.origin);
    const selectArea = overlay.host.getByRole('button', { name: 'Pilih area', exact: true });
    const selector = '#plain-page';
    await clickAt(reader, await viewportPoint(reader, selector, panel(pageA, 'A2').click));
    await expect(overlay.patches).toHaveCount(1);
    await selectArea.click();
    await clickAt(reader, await viewportPoint(reader, selector, panel(pageA, 'A4').click));
    await expect(overlay.status).toContainText('Seret kotak yang lebih besar');
    await viewportPoint(reader, selector, [0.27, 0.68]);
    const region = await regionClip(reader, selector, [0.08, 0.51, 0.38, 0.32]);
    await reader.mouse.move(region.x, region.y);
    await reader.mouse.down();
    await reader.mouse.move(region.x + region.width, region.y + region.height, { steps: 6 });
    expect(await reader.evaluate(() => window.getSelection()?.toString())).toBe('');
    await reader.mouse.up();
    await expect(overlay.patches).toHaveCount(2, { timeout: FLOW_TIMEOUT });
    await expect(selectArea).toBeVisible();
    const covered = await viewportPoint(reader, selector, panel(pageA, 'A4').click);
    await reader.mouse.move(covered.x, covered.y);
    await expect(reader.locator('html')).toHaveClass(/manga-translate-covered/);
    await reader.close();
  });

  test('a full overlapping selection after Show original translates the next dialogue and preserves previous pixels', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    const { reader, overlay } = await activated(fixtureServer.origin);
    try {
      const selector = '#plain-page';
      const left = panel(pageA, 'A2'), right = panel(pageA, 'A1');
      await clickAt(reader, await viewportPoint(reader, selector, left.click));
      await expect(overlay.patches).toHaveCount(1);
      const first = overlay.patches.first();
      const originalPatch = await first.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
      await overlay.button(copy.showOriginal).click();
      await expect(first).toBeHidden();
      await overlay.host.getByRole('button', { name: 'Pilih area', exact: true }).click();
      await viewportPoint(reader, selector, [0.5, 0.25]);
      const bounds: [number, number, number, number] = [0.06, 0.05, 0.83, 0.40];
      const area = await regionClip(reader, selector, bounds);
      await reader.mouse.move(area.x, area.y);
      await reader.mouse.down();
      await reader.mouse.move(area.x + area.width, area.y + area.height, { steps: 8 });
      await reader.mouse.up();
      await expect(overlay.patches).toHaveCount(2, { timeout: FLOW_TIMEOUT });
      await expect(first).toBeVisible();
      expect(await first.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(originalPatch);
      expect(await overlay.patches.last().evaluate((canvas: HTMLCanvasElement, [x, y]) =>
        canvas.getContext('2d')!.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data[3],
        [(left.click[0] - bounds[0]) / bounds[2], (left.click[1] - bounds[1]) / bounds[3]])).toBe(0);
      expect(mockProviders.requests).toHaveLength(2);
      expect(mockProviders.requests[1].texts).toHaveLength(1);
      expect(characterErrorRate(right.text, mockProviders.requests[1].texts[0])).toBeLessThanOrEqual(0.25);
    } finally { await reader.close(); }
  });

  test('touching bubbles are sent to the provider as separate dialogue segments', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    const reader = await ext.context.newPage();
    await reader.goto(fixtureServer.origin + '/reader.html');
    const png = await reader.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 520;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#727272';
      context.fillRect(0, 0, 800, 520);
      for (const [padding, color] of [[6, '#111'], [0, '#fff']] as const) {
        context.fillStyle = color;
        for (const x of [237, 559]) {
          context.beginPath();
          context.ellipse(x, 262, 178 + padding, 132 + padding, 0, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.fillStyle = '#111';
      context.font = 'bold 34px sans-serif';
      context.textAlign = 'center';
      context.fillText('TAKE THE', 237, 250);
      context.fillText('FIRST SHOT', 237, 300);
      context.fillText('I AM READY', 559, 275);
      return canvas.toDataURL().split(',')[1];
    });
    const path = fixtureServer.origin + '/touching-dialogue.png';
    const route = (request: import('@playwright/test').Route) =>
      request.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') });
    await ext.context.route(path, route);
    try {
      await reader.locator('#plain-page').evaluate((image: HTMLImageElement, src) => {
        image.src = src;
        return image.decode();
      }, path);
      expect((await options.activate(reader)).ok).toBe(true);
      const overlay = new Overlay(reader);
      await overlay.host.getByRole('button', { name: 'Pilih area', exact: true }).click();
      await viewportPoint(reader, '#plain-page', [0.5, 0.5]);
      const box = await regionClip(reader, '#plain-page', [0.03, 0.13, 0.93, 0.75]);
      await reader.mouse.move(box.x, box.y);
      await reader.mouse.down();
      await reader.mouse.move(box.x + box.width, box.y + box.height, { steps: 8 });
      await reader.mouse.up();
      await expect(overlay.patches).toHaveCount(1, { timeout: FLOW_TIMEOUT });
      expect(mockProviders.requests).toHaveLength(1);
      expect(mockProviders.requests[0].texts).toHaveLength(2);
      expect(mockProviders.requests[0].texts.some(text => characterErrorRate('TAKE THE FIRST SHOT', text) < 0.25)).toBe(true);
      expect(mockProviders.requests[0].texts.some(text => characterErrorRate('I AM READY', text) < 0.25)).toBe(true);
    } finally {
      await ext.context.unroute(path, route);
      await reader.close();
    }
  });

  test('provider rate limit is reported, nothing is drawn, and retry succeeds', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    mockProviders.setScenario('deepl', { kind: 'error', status: 429, retryAfterSeconds: 1 });
    const { reader, overlay } = await activated(fixtureServer.origin);
    await clickAt(reader, await viewportPoint(reader, '#plain-page', panel(pageA, 'A1').click));
    await expect(overlay.status).toContainText(copy.rateLimited, { timeout: FLOW_TIMEOUT });
    await expect(overlay.patches).toHaveCount(0);
    expect(mockProviders.requests).toHaveLength(1);

    mockProviders.setScenario('deepl', { kind: 'success' });
    await overlay.button(copy.retry).click();
    await expect(overlay.status).toHaveText(copy.done, { timeout: FLOW_TIMEOUT });
    await expect(overlay.patches).toHaveCount(1);
    expect(mockProviders.requests).toHaveLength(2);
    await reader.close();
  });

  test('malformed provider JSON is rejected without drawing', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    mockProviders.setScenario('deepl', { kind: 'malformed' });
    const { reader, overlay } = await activated(fixtureServer.origin);
    await clickAt(reader, await viewportPoint(reader, '#plain-page', panel(pageA, 'A1').click));
    await expect(overlay.status).not.toHaveText(/^(Menunggu|Mengambil|Menentukan|Memotong|Mendeteksi|Membaca|Mengurutkan|Menerjemahkan)/, { timeout: FLOW_TIMEOUT });
    await expect(overlay.status).not.toHaveText(copy.done);
    await expect(overlay.patches).toHaveCount(0);
    await reader.close();
  });

  test('a wrong key is reported as unauthorized and is never accepted', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    await options.setCredential('deepl', 'not-the-mock-key');
    const { reader, overlay } = await activated(fixtureServer.origin);
    await clickAt(reader, await viewportPoint(reader, '#plain-page', panel(pageA, 'A1').click));
    await expect(overlay.status).toContainText('API key', { timeout: FLOW_TIMEOUT });
    expect(mockProviders.requests.map(request => request.authorized)).toEqual([false]);
    await expect(overlay.patches).toHaveCount(0);
    await reader.close();
  });

  test('Cancel button stops a delayed request and discards its late answer', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    mockProviders.setScenario('deepl', { kind: 'delay', ms: 6_000 });
    const { reader, overlay } = await activated(fixtureServer.origin);
    await clickAt(reader, await viewportPoint(reader, '#plain-page', panel(pageA, 'A1').click));
    await expect(overlay.status).toHaveText(copy.translating, { timeout: FLOW_TIMEOUT });
    await overlay.button(copy.cancel).click();
    await expect(overlay.status).toHaveText(copy.cancelled);
    await reader.waitForTimeout(7_000);
    await expect(overlay.status).toHaveText(copy.cancelled);
    await expect(overlay.patches).toHaveCount(0);
    await reader.close();
  });

  test('Escape cancels the active job', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    mockProviders.setScenario('deepl', { kind: 'delay', ms: 6_000 });
    const { reader, overlay } = await activated(fixtureServer.origin);
    await clickAt(reader, await viewportPoint(reader, '#plain-page', panel(pageA, 'A1').click));
    await expect(overlay.status).toHaveText(copy.translating, { timeout: FLOW_TIMEOUT });
    await reader.keyboard.press('Escape');
    await expect(overlay.status).toHaveText(copy.cancelled);
    await expect(overlay.patches).toHaveCount(0);
    await reader.close();
  });

  test('picture source swap during a pending job: the old answer never renders on the new source, and B works', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT * 2);
    mockProviders.setScenario('deepl', { kind: 'delay', ms: 5_000 });
    const { reader, overlay } = await activated(fixtureServer.origin);
    await reader.locator('#picture-reader').scrollIntoViewIfNeeded(); // not the anchor link: see the hash-navigation test
    await expect(reader.locator('#picture-page')).toHaveJSProperty('complete', true);
    await clickAt(reader, await viewportPoint(reader, '#picture-page', panel(pageA, 'A3').click));    await expect(overlay.status).toHaveText(copy.translating, { timeout: FLOW_TIMEOUT });

    await reader.evaluate(() => (document.getElementById('queue-page-b') as HTMLButtonElement).click());
    await expect(reader.locator('#picture-status')).toHaveText('Page B loaded');
    expect(await reader.locator('#picture-page').evaluate((img: HTMLImageElement) => img.currentSrc)).toMatch(/\/page-b\.png$/);
    expect(await reader.locator('#picture-page').getAttribute('src')).toBe('./page-a.png?fallback');

    await reader.waitForTimeout(6_000); // let the stale response arrive
    await expect(overlay.patches).toHaveCount(0);

    mockProviders.setScenario('deepl', { kind: 'success' });
    const b1 = panel(pageB, 'B1');
    await clickAt(reader, await viewportPoint(reader, '#picture-page', b1.click));
    await expect(overlay.status).toHaveText(copy.done, { timeout: FLOW_TIMEOUT });
    await expect(overlay.patches).toHaveCount(1);
    const last = mockProviders.requests.at(-1)!;
    test.info().annotations.push({ type: 'ocr-b1', description: `${JSON.stringify(last.texts.join(' '))} vs ${JSON.stringify(b1.text)}` });
    expect(characterErrorRate(b1.text, last.texts.join(' '))).toBeLessThanOrEqual(0.25);

    // The plain image still answers as page A.
    await reader.evaluate(() => window.scrollTo(0, 0));
    await clickAt(reader, await viewportPoint(reader, '#plain-page', panel(pageA, 'A1').click));
    await expect(overlay.patches).toHaveCount(2, { timeout: FLOW_TIMEOUT });
    await reader.close();
  });

  test('cross-origin image without granted access: reports the origin and sends nothing to the provider', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    // The reader page gets the bytes through Playwright routing. The extension's own fetch is not routed, and its
    // network cannot resolve this host, so it behaves like an origin the user has not granted.
    const imageOrigin = 'http://cdn.manga-fixture.test';
    const bytes = readFileSync(join(fixturesDir, 'page-a.png'));
    await ext.context.route(`${imageOrigin}/**`, route => route.fulfill({ contentType: 'image/png', body: bytes }));
    await ext.context.route(`${fixtureServer.origin}/cross.html`, route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>cross</title><img id="x" src="${imageOrigin}/page-a.png" width="1000" height="1200" style="display:block;width:100%">`,
    }));
    const { reader, overlay } = await activated(fixtureServer.origin, '/cross.html');
    await expect.poll(() => reader.locator('#x').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1000);
    await clickAt(reader, await viewportPoint(reader, '#x', panel(pageA, 'A1').click));
    await expect(overlay.status).toContainText(copy.imagePermission, { timeout: FLOW_TIMEOUT });
    expect(mockProviders.requests).toEqual([]);
    const status = await options.tabStatus(await options.tabIdOf(reader));
    expect(status.pendingOrigin).toBe(imageOrigin);
    await expect(overlay.patches).toHaveCount(0);
    await reader.close();
  });

  for (const provider of ['gemini', 'openai', 'google', 'deepl', 'azure'] as const) {
    test(`options connection test for ${provider} succeeds against the mock`, async ({ mockProviders }) => {
      await options.setSettings({ provider, source: 'ja', target: 'en' });
      await options.setCredential(provider, MOCK_API_KEY);
      const reply = await options.testProvider(provider);
      expect(reply.ok, JSON.stringify(reply)).toBe(true);
      expect(mockProviders.requests).toHaveLength(1);
      expect(mockProviders.requests[0]).toMatchObject({ provider, authorized: true });
      await options.setSettings({ provider: 'deepl', source: 'auto', target: 'id' });
    });
  }

  test('only the selected provider is contacted, and only over the mocked hosts', async ({ fixtureServer, mockProviders }) => {
    test.setTimeout(FLOW_TIMEOUT);
    await options.setSettings({ provider: 'openai' });
    await options.setCredential('openai', MOCK_API_KEY);
    const { reader, overlay } = await activated(fixtureServer.origin);
    await clickAt(reader, await viewportPoint(reader, '#plain-page', panel(pageA, 'A1').click));
    await expect(overlay.status).toHaveText(copy.done, { timeout: FLOW_TIMEOUT });
    expect(new Set(mockProviders.requests.map(request => request.provider))).toEqual(new Set(['openai']));
    expect(mockProviders.requests[0].ids).toHaveLength(1);
    // Nothing the browser itself requested left loopback or the extension, except mocked provider hosts.
    for (const url of ext.requestUrls) {
      if (/^(chrome-extension:|http:\/\/127\.0\.0\.1[:/]|data:|blob:|about:)/.test(url)) continue;
      if (new URL(url).host === 'cdn.manga-fixture.test') continue; // answered by Playwright routing, never resolved
      expect(Object.keys(providerHosts), url).toContain(new URL(url).host);
    }
    await reader.close();
  });
});

test('HTTP 403: the single Select area action falls back to visible pixels', async ({ fixtureServer, mockProviders }) => {
  test.setTimeout(FLOW_TIMEOUT);
  fixtureServer.reset();
  mockProviders.reset();
  // Chrome's capture API also accepts all URLs in this disposable profile. Release still uses activeTab.
  const ext = await launchExtension(extensionDir(), { mock: mockProviders, grantHosts: ['<all_urls>'] });
  try {
    const options = await OptionsClient.open(ext);
    await options.setSettings({ uiLanguage: 'id', enabled: true, provider: 'deepl', source: 'en', ocrLanguage: 'en',
      target: 'id', performance: 'wasm', prefetch: false });
    await options.setCredential('deepl', MOCK_API_KEY);
    await ext.context.route(fixtureServer.origin + '/protected-reader.html', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><img id="page" src="/protected.png" width="800" height="960" style="display:block">' +
        '<a id="reader-cover" href="/reader.html" style="position:fixed;inset:0"></a>',
    }));
    const reader = await readerPage(ext, fixtureServer.origin, '/protected-reader.html');
    const image = reader.locator('#page');
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1000);
    expect((await options.activate(reader)).ok).toBe(true);
    const overlay = new Overlay(reader);
    await expect(overlay.status).toHaveText(copy.idle);
    const point = await viewportPoint(reader, '#page', panel(pageA, 'A2').click);
    expect(await reader.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point)).toBe('reader-cover');
    await clickAt(reader, point);
    await expect(overlay.status).toContainText('HTTP 403');
    expect(mockProviders.requests).toHaveLength(0);
    await expect(overlay.button('Pilih area')).toHaveCount(1);
    await overlay.button('Pilih area').click();
    const start = await viewportPoint(reader, '#page', [0.06, 0.05]);
    const end = await viewportPoint(reader, '#page', [0.48, 0.45]);
    const denied = fixtureServer.requests.filter(path => path === '/protected.png').length;
    await reader.mouse.move(start.x, start.y);
    await reader.mouse.down();
    await reader.mouse.move(end.x, end.y, { steps: 6 });
    await reader.mouse.up();
    await expect(overlay.status).toHaveText(copy.done, { timeout: FLOW_TIMEOUT });
    const patch = (await overlay.patches.first().boundingBox())!;
    expect(patch.x).toBeCloseTo(start.x, -1);
    expect(patch.y).toBeCloseTo(start.y, -1);
    expect(Math.abs(patch.width - (end.x - start.x))).toBeLessThan(3);
    expect(Math.abs(patch.height - (end.y - start.y))).toBeLessThan(3);
    expect(mockProviders.requests).toHaveLength(1);
    const capturedText = mockProviders.requests[0].texts.join(' ');
    expect(characterErrorRate(panel(pageA, 'A2').text, capturedText), `Capture OCR: ${capturedText}`).toBeLessThanOrEqual(0.25);
    expect(fixtureServer.requests.filter(path => path === '/protected.png')).toHaveLength(denied + 1);
    await overlay.button(copy.showOriginal).click();
    await expect(overlay.patches).toBeHidden();

    await expect(overlay.host.getByRole('button', { name: 'Pilih area', exact: true })).toHaveCount(1);
    await overlay.host.getByRole('button', { name: 'Pilih area', exact: true }).click();
    await viewportPoint(reader, '#page', panel(pageA, 'A4').click);
    const next = await regionClip(reader, '#page', panel(pageA, 'A4').bounds);
    await reader.mouse.move(next.x, next.y);
    await reader.mouse.down();
    await reader.mouse.move(next.x + next.width, next.y + next.height, { steps: 6 });
    await reader.mouse.up();
    await expect(overlay.patches).toHaveCount(2, { timeout: FLOW_TIMEOUT });
    await expect(overlay.patches.last()).toBeVisible();
    expect(mockProviders.requests).toHaveLength(2);
    expect(characterErrorRate(panel(pageA, 'A4').text, mockProviders.requests[1].texts.join(' '))).toBeLessThanOrEqual(0.25);
    expect(fixtureServer.requests.filter(path => path === '/protected.png')).toHaveLength(denied + 2);
  } finally { await ext.dispose(); }
});
