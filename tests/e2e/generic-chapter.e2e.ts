import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Page, Route } from '@playwright/test';
import type { ChapterStatus } from '../../src/core/chapter/ChapterRun';
import { OptionsClient, Overlay } from './support/driver';
import { launchExtension, type LaunchedExtension } from './support/extension';
import type { MockProviderServer } from './support/mock-provider-server';
import { MOCK_API_KEY } from './support/mock-providers';
import { extensionDir, fixturesDir, hasBuiltExtension } from './support/paths';
import { expect, test } from './support/test';

/**
 * A reader the extension has no special support for. Pages share one column, while logo, related covers, a
 * banner, a wide side image, a footer picture and lazy images further down must stay out. Every host is routed
 * inside the browser, so nothing reaches a real site.
 */
const reader = 'https://reader.example/read/ch-5?page=all';
const cdn = 'https://img.reader.example';
const witch = 'https://w2.secretsofthesilentwitch.online/chapters/33/';
const witchCdn = 'https://manga.xtdz.top/Secrets-of-the-Silent-Witch/033';
const [pageA, pageB] = ['page-a.png', 'page-b.png'].map(file => readFileSync(join(fixturesDir, file)));
const pageBytes = (index: number) => Buffer.concat([index % 2 ? pageA : pageB, Buffer.from(`page-${index}`)]);

function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const rows = Buffer.alloc((width + 1) * height, 0xdd);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const pages = [1, 2, 3].map(index => `${cdn}/page.png?index=${index}`);
const unrelated = {
  logo: [`${cdn}/logo.png`, solidPng(600, 180)],
  banner: [`${cdn}/banner.png`, solidPng(1456, 180)],
  cover: [`${cdn}/cover.png`, pageA],
  wide: [`${cdn}/side.png`, pageB],
  footer: [`${cdn}/footer.png`, pageA],
} as const;
const lazy = [4, 5, 6].map(index => `${cdn}/p${index}.png`);

const html = `<!doctype html><style>body { margin: 0 } main { width: 570px } img { display: block }</style>
<header><img src="${unrelated.logo[0]}" width="300"></header>
<aside><img src="${unrelated.cover[0]}" width="150"></aside>
<main>
  ${pages.map(src => `<img src="${src}" width="570">`).join('\n  ')}
  <img src="${unrelated.banner[0]}" width="570">
  <img src="${unrelated.wide[0]}" width="330">
  <img src="${pages[0]}" width="570">
  <div style="height: 9000px"></div>
  ${lazy.map(src => `<img src="${src}" width="570" loading="lazy">`).join('\n  ')}
</main>
<footer><img src="${unrelated.footer[0]}" width="570"></footer>`;

const grants = (...origins: string[]) => origins.map(url => new URL(url).origin + '/*').concat('https://api-free.deepl.com/*');

test.skip(!hasBuiltExtension(), 'requires the unpacked extension');

interface Seen { url: string; at: number }

async function launch(mockProviders: MockProviderServer,
  hosts: string[], seen: Seen[], latency = 0) {
  const extension = await launchExtension(extensionDir(), { mock: mockProviders, grantHosts: grants(...hosts) });
  const serve = (body: Buffer, status = 200) => async (route: Route) => {
    if (route.request().serviceWorker()) {
      seen.push({ url: route.request().url(), at: Date.now() });
      if (latency) await new Promise(resolve => setTimeout(resolve, latency));
    }
    return route.fulfill({ status, body, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } });
  };
  for (const [index, src] of [...pages, ...lazy].entries()) await extension.context.route(src, serve(pageBytes(index + 1)));
  for (const [src, body] of Object.values(unrelated)) await extension.context.route(src, serve(body));
  await extension.context.route(reader, route => route.fulfill({ contentType: 'text/html', body: html }));
  const options = await OptionsClient.open(extension);
  await options.setSettings({ enabled: true, provider: 'deepl', source: 'en', target: 'id', ocrLanguage: 'en',
    readingOrder: 'ttb', performance: 'wasm', prefetch: false, uiLanguage: 'en' });
  await options.setCredential('deepl', MOCK_API_KEY);
  return { extension, options };
}

async function chapter(options: OptionsClient, page: Page) {
  const tabId = await options.tabIdOf(page);
  const status = () => options.request<{ chapterAvailable?: boolean; chapterScope?: string; chapter?: ChapterStatus }>({ type: 'GET_TAB', tabId });
  return { tabId, status };
}

let extension: LaunchedExtension | undefined;
test.afterEach(async () => { await extension?.dispose(); extension = undefined; });

test('an unknown reader translates only its loaded page column and says so', async ({ mockProviders }) => {
  test.setTimeout(120_000);
  const seen: Seen[] = [];
  const launched = await launch(mockProviders, [reader, cdn], seen);
  extension = launched.extension;
  const page = await extension.context.newPage();
  await page.goto(reader);
  await expect.poll(() => page.locator('img').evaluateAll(images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length))
    .toBe(9);
  const { tabId, status } = await chapter(launched.options, page);
  expect(await status()).toMatchObject({ chapterAvailable: true, chapterScope: 'mounted' });
  await launched.options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
  await expect.poll(async () => (await status()).chapter, { timeout: 90_000 })
    .toMatchObject({ phase: 'completed', total: 3, processed: 3, translated: 3, failed: 0, scope: 'mounted' });
  expect(seen.map(item => item.url).sort()).toEqual([...pages].sort());
  expect(await page.evaluate(() => scrollY)).toBe(0);
  const overlay = new Overlay(page);
  await expect(overlay.host.locator('canvas[data-panel$="-1"]')).toHaveCount(1);
  await page.locator('main img').nth(1).scrollIntoViewIfNeeded();
  await expect(overlay.host.locator('canvas[data-panel$="-2"]')).toHaveCount(1);
});

test('a reader image on an origin without access pauses before any request to it', async ({ mockProviders }) => {
  test.setTimeout(60_000);
  const seen: Seen[] = [];
  const launched = await launch(mockProviders, [reader], seen);
  extension = launched.extension;
  const page = await extension.context.newPage();
  await page.goto(reader);
  const { tabId, status } = await chapter(launched.options, page);
  await launched.options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
  await expect.poll(async () => (await status()).chapter, { timeout: 30_000 })
    .toMatchObject({ phase: 'paused', pendingOrigin: cdn, processed: 0, scope: 'mounted' });
  await page.waitForTimeout(500);
  expect(seen).toEqual([]);
});

test('a page without manga images reports that and fetches nothing', async ({ mockProviders }) => {
  test.setTimeout(60_000);
  const seen: Seen[] = [];
  const launched = await launch(mockProviders, [reader, cdn], seen);
  extension = launched.extension;
  await launched.extension.context.route('https://reader.example/article', route => route.fulfill({ contentType: 'text/html',
    body: `<img src="${unrelated.banner[0]}" width="700"><img src="${unrelated.logo[0]}" width="200"><h1>News</h1>` }));
  const page = await extension.context.newPage();
  await page.goto('https://reader.example/article');
  const { tabId, status } = await chapter(launched.options, page);
  await launched.options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
  await expect.poll(async () => (await status()).chapter, { timeout: 30_000 }).toMatchObject({ phase: 'error' });
  expect((await status()).chapter?.message).toContain('Belum ada gambar halaman manga');
  expect(seen).toEqual([]);
});

test('a server that refuses the extension is asked at most twice and the reason is shown', async ({ mockProviders }) => {
  test.setTimeout(60_000);
  const seen: Seen[] = [];
  const launched = await launch(mockProviders, [reader, cdn], seen);
  extension = launched.extension;
  for (const [index, src] of pages.entries()) {
    await extension.context.unroute(src);
    await extension.context.route(src, route => {
      if (route.request().serviceWorker()) {
        seen.push({ url: route.request().url(), at: Date.now() });
        return route.fulfill({ status: 403, body: 'no' });
      }
      return route.fulfill({ body: pageBytes(index + 1), contentType: 'image/png' });
    });
  }
  const page = await extension.context.newPage();
  await page.goto(reader);
  const { tabId, status } = await chapter(launched.options, page);
  await launched.options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
  await expect.poll(async () => (await status()).chapter, { timeout: 30_000 })
    .toMatchObject({ phase: 'error', failed: 3, processed: 3 });
  expect((await status()).chapter?.message).toContain('menolak request dari extension (HTTP 401/403)');
  expect(seen).toHaveLength(2);
});

test('the next page is fetched while the current one is processed', async ({ mockProviders }) => {
  test.setTimeout(120_000);
  const latency = 600;
  const seen: Seen[] = [];
  const { extension: launched, options } = await launch(mockProviders, [witch, witchCdn], seen, latency);
  extension = launched;
  const sources = [1, 2, 3].map(index => `${witchCdn}/p00${index}.png`);
  for (const [index, src] of sources.entries()) {
    await launched.context.unroute(src).catch(() => undefined);
    await launched.context.route(src, async route => {
      if (route.request().serviceWorker()) {
        seen.push({ url: src, at: Date.now() });
        await new Promise(resolve => setTimeout(resolve, latency));
      }
      return route.fulfill({ body: pageBytes(index + 1), contentType: 'image/png' });
    });
  }
  await launched.context.route(witch, route => route.fulfill({ contentType: 'text/html',
    body: `<img width="570" src="${sources[0]}"><script type="application/json">${JSON.stringify({ images: sources })}</script>` }));
  const page = await launched.context.newPage();
  await page.goto(witch);
  const { tabId, status } = await chapter(options, page);
  const started = Date.now();
  await options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
  await expect.poll(async () => (await status()).chapter, { timeout: 90_000 }).toMatchObject({ phase: 'completed', total: 3 });
  const total = Date.now() - started;
  const at = (src: string) => seen.find(item => item.url === src)!.at;
  console.log(`chapter timing: total ${total} ms, p2 requested ${at(sources[1]) - at(sources[0])} ms after p1, p3 ${at(sources[2]) - at(sources[1])} ms after p2`);
  expect([...seen.map(item => item.url)].sort()).toEqual([...sources].sort());
  // Without lookahead the second request waits for the first page to finish, well beyond the fetch delay.
  expect(Math.abs(at(sources[1]) - at(sources[0]))).toBeLessThan(latency);
});
