import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Route } from '@playwright/test';
import type { ChapterStatus } from '../../src/core/chapter/ChapterRun';
import { OptionsClient, Overlay } from './support/driver';
import { launchExtension, type LaunchedExtension } from './support/extension';
import type { MockProviderServer } from './support/mock-provider-server';
import { MOCK_API_KEY } from './support/mock-providers';
import { loadOracle } from './support/oracle';
import { extensionDir, fixturesDir, hasBuiltExtension } from './support/paths';
import { expect, test } from './support/test';

/**
 * Generic page admission. Neither page uses markup the extension could know: no reader classes, no
 * nav/aside/header wrappers around the decoys. All hosts are answered by Playwright routing.
 *
 * - An article with one standalone portrait picture must not start any automatic fetch (prefetch or chapter),
 *   while a click on it in translate mode is still the user's explicit choice.
 * - Promo pictures with the same rendered width as the pages, in a separate box next to the reader column,
 *   must not be added to the page list.
 */

const FLOW = Number(process.env.FLOW_TIMEOUT ?? 90_000);
const article = 'https://news.example/2026/11/20/interview';
const reader = 'https://reader.example/read/series-9/ch-12';
const cdn = 'https://media.example';
const portrait = `${cdn}/uploads/2026/11/key-visual.png`;
const pages = [1, 2, 3].map(index => `${cdn}/scans/series-9/12/${String(index).padStart(3, '0')}.png`);
const promos = [1, 2].map(index => `${cdn}/assets/campaign/${index}.png`);
const oracle = loadOracle();
const panelA = (id: string) => oracle.pages['page-a.png'].panels.find(item => item.id === id)!;
const [pageA, pageB] = ['page-a.png', 'page-b.png'].map(file => readFileSync(join(fixturesDir, file)));
const done = /^(Panel translated\.|Translated the areas that could be safely cleaned|Panel loaded from cache\.)/;

const articleHtml = `<!doctype html><meta charset="utf-8"><style>body { margin: 0; font: 16px/1.5 serif } .story { width: 640px; margin: 24px }</style>
<div class="story"><h1>An interview with the artist</h1>
<p>The artist talks about the new series, the studio and the next volume.</p>
<img src="${portrait}" width="420" alt="">
<p>${'Long article text. '.repeat(40)}</p></div>`;

const readerHtml = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0 } .layout { display: flex; gap: 24px; align-items: flex-start } .column img { display: block; width: 570px }
  .box img { display: block; width: 570px; margin-bottom: 12px }
</style><div class="layout">
  <div class="column">${pages.map(src => `<img src="${src}" alt="">`).join('')}</div>
  <div class="box">${promos.map(src => `<a href="/campaign"><img src="${src}" alt=""></a>`).join('')}</div>
</div>`;

interface Seen { url: string; extension: boolean }

function fromExtension(request: Request): boolean {
  if (request.serviceWorker()) return true;
  try { return request.frame().url().startsWith('chrome-extension://'); } catch { return true; }
}

async function launch(mockProviders: MockProviderServer, prefetch: boolean) {
  mockProviders.reset();
  const seen: Seen[] = [];
  const extension = await launchExtension(extensionDir(), { mock: mockProviders,
    grantHosts: [article, reader, cdn, 'https://api-free.deepl.com'].map(url => new URL(url).origin + '/*') });
  const serve = (body: Buffer) => async (route: Route) => {
    seen.push({ url: route.request().url(), extension: fromExtension(route.request()) });
    await route.fulfill({ body, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } });
  };
  await extension.context.route(portrait, serve(pageA));
  for (const [index, src] of pages.entries()) await extension.context.route(src, serve(Buffer.concat([index % 2 ? pageB : pageA, Buffer.from(`p${index}`)])));
  for (const src of promos) await extension.context.route(src, serve(Buffer.concat([pageB, Buffer.from(src)])));
  await extension.context.route(article, route => route.fulfill({ contentType: 'text/html', body: articleHtml }));
  await extension.context.route(reader, route => route.fulfill({ contentType: 'text/html', body: readerHtml }));
  const options = await OptionsClient.open(extension);
  await options.setSettings({ uiLanguage: 'en', enabled: true, provider: 'deepl', source: 'en', target: 'id', ocrLanguage: 'en',
    readingOrder: 'ttb', performance: 'wasm', prefetch, contextual: false });
  await options.setCredential('deepl', MOCK_API_KEY);
  return { extension, options, seen };
}

const extensionUrls = (seen: Seen[]) => seen.filter(item => item.extension).map(item => item.url);

test.skip(!hasBuiltExtension(), 'requires the unpacked extension');

let extension: LaunchedExtension | undefined;
test.afterEach(async () => { await extension?.dispose(); extension = undefined; });

test('a standalone portrait in an article starts no automatic fetch but stays available to an explicit click', async ({ mockProviders }) => {
  test.setTimeout(FLOW + 60_000);
  const launched = await launch(mockProviders, true);
  extension = launched.extension;
  const page = await extension.context.newPage();
  await page.goto(article);
  await expect.poll(() => page.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1000);
  const tabId = await launched.options.tabIdOf(page);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const image = page.locator('img');
  const box = (await image.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(2500);
  expect(extensionUrls(launched.seen), 'prefetch').toEqual([]);
  await launched.options.send({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
  await page.waitForTimeout(4000);
  const status = await launched.options.request<{ chapter?: ChapterStatus }>({ type: 'GET_TAB', tabId });
  test.info().annotations.push({ type: 'observed', description: JSON.stringify(status.chapter ?? null) });
  expect(extensionUrls(launched.seen), 'automatic chapter').toEqual([]);
  expect(mockProviders.requests).toHaveLength(0);
  // Explicit choice: clicking a panel on the portrait in translate mode.
  const overlay = new Overlay(page);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const [x, y] = panelA('A2').click;
  await page.mouse.move(box.x + x * box.width, box.y + y * box.height);
  await page.mouse.click(box.x + x * box.width, box.y + y * box.height);
  await expect(overlay.status).toHaveText(done, { timeout: FLOW });
  expect(extensionUrls(launched.seen)).toEqual([portrait]);
});

test('same-width promo pictures in a separate box do not displace the reader pages', async ({ mockProviders }) => {
  test.setTimeout(FLOW * 2);
  const launched = await launch(mockProviders, true);
  extension = launched.extension;
  const page = await extension.context.newPage();
  await page.goto(reader);
  await expect.poll(() => page.locator('img').evaluateAll(images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length)).toBe(5);
  const tabId = await launched.options.tabIdOf(page);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const promo = (await page.locator('.box img').first().boundingBox())!;
  await page.mouse.move(promo.x + promo.width / 2, promo.y + promo.height / 2);
  await page.waitForTimeout(2500);
  expect(extensionUrls(launched.seen).filter(url => promos.includes(url)), 'promo prefetch').toEqual([]);
  await launched.options.request({ type: 'SET_TAB', tabId, active: false });
  await launched.options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
  const status = () => launched.options.request<{ chapter?: ChapterStatus }>({ type: 'GET_TAB', tabId });
  await expect.poll(async () => (await status()).chapter?.phase, { timeout: FLOW * 1.5 }).toMatch(/completed|error|stopped/);
  test.info().annotations.push({ type: 'observed', description: JSON.stringify((await status()).chapter) });
  expect((await status()).chapter).toMatchObject({ phase: 'completed', total: 3, processed: 3, failed: 0 });
  expect(extensionUrls(launched.seen).filter(url => promos.includes(url)), 'promo fetched').toEqual([]);
  expect([...new Set(extensionUrls(launched.seen))].sort()).toEqual([...pages].sort());
});
