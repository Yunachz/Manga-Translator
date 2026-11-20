import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { BrowserContext, Page, Request, Route } from '@playwright/test';
import type { ChapterStatus } from '../../src/core/chapter/ChapterRun';
import { OptionsClient, Overlay } from './support/driver';
import { launchExtension, type LaunchedExtension } from './support/extension';
import type { MockProviderServer } from './support/mock-provider-server';
import { MOCK_API_KEY } from './support/mock-providers';
import { loadOracle } from './support/oracle';
import { extensionDir, fixturesDir, hasBuiltExtension } from './support/paths';
import { characterErrorRate } from './support/text';
import { expect, test } from './support/test';

/**
 * Canvas reader regressions modelled on the Comic Action (GigaViewer) episode layout observed on 2026-11-20:
 * `.js-viewer-content` holds 43 `.js-page-area` slots, five of them mount `canvas.page-image.js-page-image`
 * at 844 × 1200, two slots hold `.js-page-ad`, and the series cover `img.js-series-header-image` sits outside
 * the viewer. Every page is drawn from the repository's own synthetic fixtures (tests/fixtures/page-*.png).
 * All hosts are answered by Playwright routing inside the browser, so nothing reaches comic-action.com.
 *
 * `tainted`: page images come from a CDN origin without CORS, so `getImageData` throws SecurityError.
 * `readable`: the same images are requested with `crossOrigin = "anonymous"` and an ACAO header.
 */

const FLOW = Number(process.env.FLOW_TIMEOUT ?? 90_000);
const episode = 'https://comic-action.com/episode/12207421984539831863';
const cdn = 'https://cdn-ak-img.comic-action.com';
const generic = 'https://reader.example/viewer/background-page';
const oracle = loadOracle();
const panelA = (id: string) => oracle.pages['page-a.png'].panels.find(item => item.id === id)!;
const [pageA, pageB] = ['page-a.png', 'page-b.png'].map(file => readFileSync(join(fixturesDir, file)));
const pageSources = [1, 2, 3, 4, 5].map(index => `${cdn}/public/page/${index}-3a9f.png`);
const coverSrc = `${cdn}/public/series-thumbnail/cover-1000x1200.png`;
const promoSrc = `${cdn}/public/ad/promo-844x1200.png`;
const promoTailSrc = `${cdn}/public/ad/promo-tail-844x1200.png`;
const done = /^(Panel translated\.|Translated the areas that could be safely cleaned|Panel loaded from cache\.)/;

function solidPng(width: number, height: number, shade = 0xdd): Buffer {
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
  const rows = Buffer.alloc((width + 1) * height, shade);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** Fixture page bytes are 1000 × 1200. The reader letterboxes them into an 844 × 1200 canvas. */
const letterbox = { scale: 0.844, top: (1200 - 1200 * 0.844) / 2 };
const canvasPoint = ([x, y]: [number, number]): [number, number] => [x, (letterbox.top + y * 1200 * letterbox.scale) / 1200];
const canvasBounds = ([x, y, width, height]: [number, number, number, number]): [number, number, number, number] =>
  [x, (letterbox.top + y * 1200 * letterbox.scale) / 1200, width, (height * 1200 * letterbox.scale) / 1200];

type Mode = 'tainted' | 'readable';

/**
 * `icon` is the page-turn arrow markup: `span` (an empty icon element), `svg` (inline SVG with a path child) or `none`.
 * Open the episode with `?icon=svg`, or set CANVAS_ICON for a whole run.
 */
type Badge = 'middle' | 'bottom';
/** Opaque floating badge over page 1, away from panel A2: a reader promo sticker. Its box is in viewer pixels. */
const badges: Record<Badge, { left: number; top: number; width: number; height: number }> = {
  middle: { left: 460, top: 300, width: 90, height: 36 },
  bottom: { left: 700, top: 520, width: 90, height: 36 },
};

function gigaViewer(mode: Mode, icon: 'span' | 'svg' | 'none' = 'span', badge?: Badge): string {
  const sticker = badge ? `<div class="floating-badge" style="position: absolute; z-index: 3; left: ${badges[badge].left}px; top: ${badges[badge].top}px; width: ${badges[badge].width}px; height: ${badges[badge].height}px; background: #e33; color: #fff; font: bold 16px sans-serif; display: flex; align-items: center; justify-content: center">NEW</div>` : '';
  const arrow = (d: string, name: string) => icon === 'none' ? '' : icon === 'svg'
    ? `<svg viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="#888" stroke-width="2"/></svg>`
    : `<span class="icon ${name}"></span>`;
  // Slot order follows the reader: slot 0 is page 1 on the right of the first spread.
  const slots: string[] = [];
  const mounted = [0, 1, 2, 4, 5];
  for (let slot = 0; slot < 43; slot++) {
    if (mounted.includes(slot)) {
      const page = mounted.indexOf(slot) + 1;
      slots.push(`<div class="js-page-area page-area" data-slot="${slot}"><canvas class="page-image js-page-image" data-page="${page}" width="844" height="1200"></canvas></div>`);
    } else if (slot === 3 || slot === 42) {
      slots.push(`<div class="js-page-area page-area" data-slot="${slot}"><div class="js-page-ad page-ad"><a href="#promo" class="promo-link"><img alt="" src="${slot === 3 ? promoSrc : promoTailSrc}"></a></div></div>`);
    } else {
      slots.push(`<div class="js-page-area page-area" data-slot="${slot}"></div>`);
    }
  }
  return `<!doctype html><meta charset="utf-8"><title>Episode fixture</title>
<style>
  body { margin: 0; font: 14px sans-serif; background: #fff }
  .series-header { position: absolute; left: 904px; top: 16px; width: 260px }
  .series-header img { width: 260px; display: block }
  .js-viewer { position: absolute; left: 16px; top: 16px; width: 844px; height: 600px; overflow: hidden; background: #222 }
  .js-viewer-content { position: relative; width: 844px; height: 600px }
  .track { position: absolute; top: 0; right: 0; display: flex; flex-direction: row-reverse }
  .js-page-area { width: 422px; height: 600px; flex: none; position: relative }
  .js-page-area canvas { width: 100%; height: 100%; display: block; pointer-events: none }
  .js-slide-backward, .js-slide-forward { position: absolute; top: 0; bottom: 0; width: 240px; z-index: 2; background: transparent;
    display: flex; align-items: center; justify-content: center }
  .js-slide-backward { left: 0 } .js-slide-forward { right: 0 }
  .js-slide-backward svg, .js-slide-forward svg, .js-slide-backward .icon, .js-slide-forward .icon { width: 28px; height: 28px; opacity: .6; display: block;
    border: solid #888; border-width: 0 0 2px 2px }
  .js-page-ad img { width: 422px; height: 600px; display: block }
</style>
<div class="series-header"><div class="js-series-header-image-wrapper">
  <img class="series-header-image js-series-header-image" alt="cover" src="${coverSrc}" onclick="document.body.dataset.coverClicked = 'yes'">
</div><h1>Episode fixture</h1></div>
<div class="js-viewer viewer" id="viewer"><div class="js-viewer-content viewer-content"><div class="track" id="track">
${slots.join('\n')}
</div>
<a class="js-slide-backward" href="#back" aria-label="next page">${arrow('M15 4 7 12l8 8', 'icon-arrow-left')}</a>
<a class="js-slide-forward" href="#forward" aria-label="previous page">${arrow('m9 4 8 8-8 8', 'icon-arrow-right')}</a>
${sticker}
</div></div>
<script>
  const mode = ${JSON.stringify(mode)};
  const sources = ${JSON.stringify(pageSources)};
  document.querySelector('.js-page-ad').addEventListener('click', event => { event.preventDefault(); document.body.dataset.adClicked = 'yes'; });
  function load(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      if (mode === 'readable') image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }
  async function draw(canvas, src) {
    const image = await load(src);
    canvas.width = 844;
    canvas.height = 1200;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 844, 1200);
    context.drawImage(image, 0, ${letterbox.top}, 844, ${1200 * letterbox.scale});
  }
  window.drawPage = (page, src) => draw(document.querySelector('canvas[data-page="' + page + '"]'), src);
  let spread = 0;
  window.showSpread = next => { spread = next; document.getElementById('track').style.transform = 'translateX(' + spread * 844 + 'px)'; };
  // RTL reader: the left zone moves forward in the book, the right zone back.
  for (const [selector, step] of [['.js-slide-backward', 1], ['.js-slide-forward', -1]]) {
    document.querySelector(selector).addEventListener('click', event => {
      event.preventDefault();
      document.body.dataset.slid = String(Number(document.body.dataset.slid ?? 0) + 1);
      window.showSpread(Math.max(0, spread + step));
    });
  }
  window.readable = () => [...document.querySelectorAll('canvas.js-page-image')].map(canvas => {
    try { canvas.getContext('2d').getImageData(0, 0, 1, 1); return true; } catch (error) { return error.name; }
  });
  window.pagesReady = Promise.all([...document.querySelectorAll('canvas.js-page-image')]
    .map(canvas => draw(canvas, sources[Number(canvas.dataset.page) - 1]))).then(() => true);
</script>`;
}

/** A page whose manga is a CSS background, so there is no `<img>` or `<canvas>` to identify. */
const backgroundReader = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; height: 3000px } #page { position: absolute; left: 40px; top: 40px; width: 600px; height: 720px;
  background: url("${cdn}/public/page/background.png") 0 0 / 100% 100% no-repeat }
</style><div id="page" role="img" aria-label="page"></div>`;

interface Seen { url: string; extension: boolean }

function fromExtension(request: Request): boolean {
  if (request.serviceWorker()) return true;
  try { return request.frame().url().startsWith('chrome-extension://'); } catch { return true; }
}

async function routeFixtures(context: BrowserContext, mode: Mode, seen: Seen[]) {
  const serve = (body: Buffer) => async (route: Route) => {
    seen.push({ url: route.request().url(), extension: fromExtension(route.request()) });
    await route.fulfill({ status: 200, body, contentType: 'image/png',
      headers: mode === 'readable' ? { 'access-control-allow-origin': '*' } : {} });
  };
  // Pages 1, 2, 3 and 5 show fixture page A (at different URLs), page 4 shows page B.
  for (const [index, src] of pageSources.entries()) await context.route(src, serve(index === 3 ? pageB : pageA));
  await context.route(coverSrc, serve(pageA));
  await context.route(promoSrc, serve(pageB));
  await context.route(promoTailSrc, serve(solidPng(844, 1200)));
  await context.route(`${cdn}/public/page/background.png`, serve(pageA));
  await context.route(episode + '*', route => {
    const query = new URL(route.request().url()).searchParams;
    const icon = query.get('icon') ?? process.env.CANVAS_ICON;
    const badge = query.get('badge');
    return route.fulfill({ contentType: 'text/html', body: gigaViewer(mode, icon === 'svg' || icon === 'none' ? icon : 'span',
      badge === 'middle' || badge === 'bottom' ? badge : undefined) });
  });
  await context.route(generic, route => route.fulfill({ contentType: 'text/html', body: backgroundReader }));
}

async function launch(mockProviders: MockProviderServer, mode: Mode, grantHosts: string[], prefetch = false) {
  mockProviders.reset();
  const seen: Seen[] = [];
  const extension = await launchExtension(extensionDir(), { mock: mockProviders, grantHosts });
  await routeFixtures(extension.context, mode, seen);
  const options = await OptionsClient.open(extension);
  await options.setSettings({ uiLanguage: 'en', enabled: true, provider: 'deepl', source: 'en', target: 'id', ocrLanguage: 'en',
    readingOrder: 'ttb', performance: 'wasm', prefetch, contextual: false });
  await options.setCredential('deepl', MOCK_API_KEY);
  return { extension, options, seen };
}

async function openEpisode(extension: LaunchedExtension, url = episode) {
  const page = await extension.context.newPage();
  await page.goto(url);
  expect(await page.evaluate(() => (window as unknown as { pagesReady: Promise<boolean> }).pagesReady)).toBe(true);
  return page;
}

/** Viewport point of a normalized fixture-page point drawn on the canvas of reader page `index`. */
async function onCanvas(page: Page, index: number, point: [number, number]) {
  const box = (await page.locator(`canvas[data-page="${index}"]`).boundingBox())!;
  const [x, y] = canvasPoint(point);
  return { x: box.x + x * box.width, y: box.y + y * box.height };
}

async function canvasClip(page: Page, index: number, bounds: [number, number, number, number]) {
  const box = (await page.locator(`canvas[data-page="${index}"]`).boundingBox())!;
  const [x, y, width, height] = canvasBounds(bounds);
  return { x: box.x + x * box.width, y: box.y + y * box.height, width: width * box.width, height: height * box.height };
}

async function drag(page: Page, area: { x: number; y: number; width: number; height: number }) {
  await page.mouse.move(area.x, area.y);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width, area.y + area.height, { steps: 8 });
  await page.mouse.up();
}

/** Rectangles of overlay patches that are actually painted, in viewport coordinates. */
function paintedPatches(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('manga-translator-layer')?.shadowRoot;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLCanvasElement>('canvas.patch')].filter(patch => patch.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
      .map(patch => {
        // A clipping ancestor inside the overlay limits what is painted.
        let { left, top, right, bottom } = patch.getBoundingClientRect();
        for (let node = patch.parentElement; node; node = node.parentElement) {
          if (getComputedStyle(node).overflow === 'visible') continue;
          const clip = node.getBoundingClientRect();
          left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
        }
        left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
        return { left, top, right, bottom };
      }).filter(rect => rect.right - rect.left > 1 && rect.bottom - rect.top > 1);
  });
}

/** Parts of reader pages the user can see: each canvas clipped by the viewer and the viewport. */
function visiblePages(page: Page) {
  return page.evaluate(() => {
    const viewer = document.getElementById('viewer')!.getBoundingClientRect();
    return [...document.querySelectorAll('canvas.js-page-image')].map(canvas => {
      const box = canvas.getBoundingClientRect();
      return { page: Number((canvas as HTMLElement).dataset.page), left: Math.max(box.left, viewer.left, 0), top: Math.max(box.top, viewer.top, 0),
        right: Math.min(box.right, viewer.right, innerWidth), bottom: Math.min(box.bottom, viewer.bottom, innerHeight) };
    }).filter(rect => rect.right - rect.left > 1 && rect.bottom - rect.top > 1);
  });
}

/**
 * Box of the first patch once its position is stable for two reads. The overlay can insert a patch one frame before
 * placing it, while it is still at the layer origin.
 */
async function settledPatch(overlay: Overlay) {
  let previous = '';
  let box: { x: number; y: number; width: number; height: number } | null = null;
  await expect.poll(async () => {
    box = await overlay.patches.first().boundingBox();
    const key = JSON.stringify(box);
    const stable = !!box && key === previous && (box.x !== 0 || box.y !== 0);
    previous = key;
    return stable;
  }, { timeout: 5000, intervals: [50, 100, 100, 200] }).toBe(true);
  return box!;
}

async function strayPatches(page: Page) {
  const pages = await visiblePages(page);
  return (await paintedPatches(page)).filter(patch => !pages.some(item => patch.left >= item.left - 2 && patch.top >= item.top - 2 &&
    patch.right <= item.right + 2 && patch.bottom <= item.bottom + 2));
}

const noExtensionFetch = (seen: Seen[], ...urls: string[]) =>
  expect(seen.filter(item => item.extension && urls.includes(item.url)).map(item => item.url)).toEqual([]);

const allUrls = ['<all_urls>'];
const scoped = [episode, cdn, 'https://api-free.deepl.com'].map(url => new URL(url).origin + '/*');

test.skip(!hasBuiltExtension(), 'requires the unpacked extension');

let extension: LaunchedExtension | undefined;
test.afterEach(async () => { await extension?.dispose(); extension = undefined; });

test('fixture sanity: tainted canvases refuse reads, readable canvases allow them', async ({ mockProviders }) => {
  for (const mode of ['tainted', 'readable'] as const) {
    const launched = await launch(mockProviders, mode, scoped);
    extension = launched.extension;
    const page = await openEpisode(extension);
    expect(await page.locator('.js-viewer-content .js-page-area').count()).toBe(43);
    expect(await page.locator('.js-viewer-content canvas.page-image.js-page-image').count()).toBe(5);
    expect(await page.locator('.js-viewer-content .js-page-ad').count()).toBe(2);
    expect(await page.locator('.js-viewer-content .js-series-header-image').count()).toBe(0);
    const reads = await page.evaluate(() => (window as unknown as { readable(): (true | string)[] }).readable());
    expect(reads).toEqual(Array(5).fill(mode === 'readable' ? true : 'SecurityError'));
    await extension.dispose();
    extension = undefined;
  }
});

test('an unactivated canvas reader gets no overlay, no scan and no extension request', async ({ mockProviders }) => {
  const launched = await launch(mockProviders, 'tainted', allUrls, true);
  extension = launched.extension;
  const page = await openEpisode(extension);
  const tabId = await launched.options.tabIdOf(page);
  await launched.options.request({ type: 'GET_TAB', tabId });
  const point = await onCanvas(page, 1, panelA('A2').click);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(1500);
  await expect(new Overlay(page).host).toHaveCount(0);
  expect(launched.seen.filter(item => item.extension)).toEqual([]);
  expect(mockProviders.requests).toHaveLength(0);
});

for (const mode of ['tainted', 'readable'] as const) {
  test.describe(`${mode} canvas pages`, () => {
    test(`click on a ${mode} canvas page translates that panel`, async ({ mockProviders }) => {
      test.setTimeout(FLOW + 30_000);
      // A readable canvas must not need tab capture, so it gets no <all_urls>.
      const launched = await launch(mockProviders, mode, mode === 'readable' ? scoped : allUrls);
      extension = launched.extension;
      const page = await openEpisode(extension);
      expect((await launched.options.activate(page)).ok).toBe(true);
      const overlay = new Overlay(page);
      await expect(overlay.status).toHaveText('Click the panel you want to translate.');
      const point = await onCanvas(page, 1, panelA('A2').click);
      await page.mouse.move(point.x, point.y);
      await page.mouse.click(point.x, point.y);
      await expect(overlay.status).toHaveText(done, { timeout: FLOW });
      await expect(overlay.patches).toHaveCount(1);
      expect(mockProviders.requests).toHaveLength(1);
      const text = mockProviders.requests[0].texts.join(' ');
      expect(characterErrorRate(panelA('A2').text, text), `OCR: ${text}`).toBeLessThanOrEqual(0.25);
      expect(await strayPatches(page)).toEqual([]);
      const patch = await settledPatch(overlay);
      const target = await canvasClip(page, 1, panelA('A2').bounds);
      expect(patch.x).toBeGreaterThanOrEqual(target.x - 0.08 * target.width);
      expect(patch.x + patch.width).toBeLessThanOrEqual(target.x + target.width * 1.08);
      noExtensionFetch(launched.seen, coverSrc, promoSrc, promoTailSrc);
    });

    test(`Select area on a ${mode} canvas page translates the dragged rectangle`, async ({ mockProviders }) => {
      test.setTimeout(FLOW + 30_000);
      const launched = await launch(mockProviders, mode, mode === 'readable' ? scoped : allUrls);
      extension = launched.extension;
      const page = await openEpisode(extension);
      expect((await launched.options.activate(page)).ok).toBe(true);
      const overlay = new Overlay(page);
      await overlay.host.getByRole('button', { name: 'Select area', exact: true }).click();
      const area = await canvasClip(page, 1, panelA('A4').bounds);
      await drag(page, area);
      await expect(overlay.status).toHaveText(done, { timeout: FLOW });
      // The status can announce success a frame before the patch is placed. A painted patch must never sit elsewhere.
      const early = await paintedPatches(page);
      expect(early.filter(rect => Math.abs(rect.left - area.x) > 4 || Math.abs(rect.top - area.y) > 4), JSON.stringify({ early, area })).toEqual([]);
      await expect.poll(async () => {
        const box = (await overlay.patches.first().boundingBox())!;
        return [box.x - area.x, box.y - area.y, box.width - area.width, box.height - area.height].every(delta => Math.abs(delta) < 4);
      }, { timeout: 3000 }).toBe(true);
      expect(mockProviders.requests).toHaveLength(1);
      const text = mockProviders.requests[0].texts.join(' ');
      expect(characterErrorRate(panelA('A4').text, text), `OCR: ${text}`).toBeLessThanOrEqual(0.25);
      noExtensionFetch(launched.seen, coverSrc, promoSrc, promoTailSrc);
    });
  });
}

test('cover and ad slot are never queued, prefetched or fetched, and keep their own clicks', async ({ mockProviders }) => {
  test.setTimeout(60_000);
  const launched = await launch(mockProviders, 'tainted', allUrls, true);
  extension = launched.extension;
  const page = await openEpisode(extension);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const overlay = new Overlay(page);
  await expect(overlay.status).toHaveText('Click the panel you want to translate.');
  const cover = (await page.locator('img.js-series-header-image').boundingBox())!;
  await page.mouse.move(cover.x + cover.width / 2, cover.y + cover.height / 3);
  await page.mouse.click(cover.x + cover.width / 2, cover.y + cover.height / 3);
  await expect(page.locator('body')).toHaveAttribute('data-cover-clicked', 'yes');
  await page.evaluate(() => (window as unknown as { showSpread(n: number): void }).showSpread(1));
  const ad = (await page.locator('.js-page-ad img').first().boundingBox())!;
  // Click the right part of the ad so the reader's left page-turn zone (240 px) is not on top of it.
  const adPoint = { x: ad.x + ad.width * 0.8, y: ad.y + ad.height / 3 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.js-page-ad') !== null, adPoint)).toBe(true);
  await page.mouse.move(adPoint.x, adPoint.y);
  await page.mouse.click(adPoint.x, adPoint.y);
  await expect(page.locator('body')).toHaveAttribute('data-ad-clicked', 'yes');
  await page.waitForTimeout(2500);
  await expect(overlay.status).not.toHaveText(/Waiting in queue|Fetching|Translating/);
  await expect(overlay.patches).toHaveCount(0);
  noExtensionFetch(launched.seen, coverSrc, promoSrc, promoTailSrc);
  expect(mockProviders.requests).toHaveLength(0);
});

test('Select area dragged over the cover never fetches the cover', async ({ mockProviders }) => {
  test.setTimeout(FLOW + 30_000);
  const launched = await launch(mockProviders, 'tainted', allUrls);
  extension = launched.extension;
  const page = await openEpisode(extension);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const overlay = new Overlay(page);
  await overlay.host.getByRole('button', { name: 'Select area', exact: true }).click();
  const cover = (await page.locator('img.js-series-header-image').boundingBox())!;
  await drag(page, { x: cover.x + 10, y: cover.y + 10, width: cover.width * 0.45, height: cover.height * 0.4 });
  await page.waitForTimeout(4000);
  test.info().annotations.push({ type: 'observed', description: `status after drag over cover: ${await overlay.status.textContent()}` });
  noExtensionFetch(launched.seen, coverSrc, promoSrc, promoTailSrc);
});

interface VisiblePages { canvasPages?: number; visiblePages?: number; mounted?: number; visible?: number; run?: Record<string, unknown> }
type TabReply = { chapterAvailable?: boolean; chapterScope?: string; chapter?: ChapterStatus; visiblePages?: VisiblePages };

test('Translate visible pages covers the visible spread only, in place, without cover or ad', async ({ mockProviders }) => {
  test.setTimeout(FLOW * 2);
  const launched = await launch(mockProviders, 'tainted', allUrls);
  extension = launched.extension;
  const page = await openEpisode(extension);
  const tabId = await launched.options.tabIdOf(page);
  const status = () => launched.options.request<TabReply>({ type: 'GET_TAB', tabId });
  const before = await page.evaluate(() => ({ scroll: scrollY, track: document.getElementById('track')!.style.transform }));
  expect((await launched.options.activate(page)).ok).toBe(true);
  // protocol.ts names the counts canvasPages / visiblePages. The contract note called them mounted / visible.
  await expect.poll(async () => {
    const info = (await status()).visiblePages;
    return info && { mounted: info.canvasPages ?? info.mounted, visible: info.visiblePages ?? info.visible };
  }, { timeout: 10_000 }).toEqual({ mounted: 5, visible: 2 });
  await launched.options.request({ type: 'VISIBLE_PAGES', tabId, command: 'start' });
  await expect.poll(async () => String((await status()).visiblePages?.run?.phase), { timeout: FLOW * 1.5 }).toMatch(/finished|completed|error|stopped|failed/);
  const run = (await status()).visiblePages!.run!;
  console.log('visible pages run:', JSON.stringify(run));
  test.info().annotations.push({ type: 'observed', description: JSON.stringify(run) });
  expect(run).toMatchObject({ phase: 'finished', total: 2, processed: 2, failed: 0 });
  expect(await page.evaluate(() => ({ scroll: scrollY, track: document.getElementById('track')!.style.transform }))).toEqual(before);
  noExtensionFetch(launched.seen, coverSrc, promoSrc, promoTailSrc);
  await expect.poll(async () => (await paintedPatches(page)).length).toBeGreaterThanOrEqual(2);
  expect(await strayPatches(page)).toEqual([]);
  // Pages mounted after the snapshot are not added to the finished run.
  await page.evaluate(() => (window as unknown as { showSpread(n: number): void }).showSpread(2));
  await page.waitForTimeout(1500);
  expect((await status()).visiblePages?.run).toMatchObject({ total: 2, processed: 2 });
  expect(await strayPatches(page)).toEqual([]);
});

test('the image chapter batch on a canvas reader never picks the cover or ad image', async ({ mockProviders }) => {
  test.setTimeout(FLOW);
  const launched = await launch(mockProviders, 'tainted', allUrls);
  extension = launched.extension;
  const page = await openEpisode(extension);
  const tabId = await launched.options.tabIdOf(page);
  const status = () => launched.options.request<TabReply>({ type: 'GET_TAB', tabId });
  await launched.options.send({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
  await page.waitForTimeout(5000);
  test.info().annotations.push({ type: 'observed', description: JSON.stringify(await status()) });
  noExtensionFetch(launched.seen, coverSrc, promoSrc, promoTailSrc);
  expect(await strayPatches(page)).toEqual([]);
});

for (const icon of ['span', 'svg'] as const) {
  test(`a click on a page under the reader navigation zone (${icon} arrow) translates it instead of turning the page`, async ({ mockProviders }) => {
    test.setTimeout(FLOW + 30_000);
    const launched = await launch(mockProviders, 'readable', scoped);
    extension = launched.extension;
    const page = await openEpisode(extension, `${episode}?icon=${icon}`);
    expect((await launched.options.activate(page)).ok).toBe(true);
    const overlay = new Overlay(page);
    const point = await onCanvas(page, 2, panelA('A2').click);
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.className, point)).toBe('js-slide-backward');
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
    await expect(overlay.status).toHaveText(done, { timeout: FLOW });
    await expect(page.locator('body')).not.toHaveAttribute('data-slid', /.+/);
    expect(await page.evaluate(() => document.getElementById('track')!.style.transform)).toBe('');
    const text = mockProviders.requests.at(-1)?.texts.join(' ') ?? '';
    expect(characterErrorRate(panelA('A2').text, text), `OCR: ${text}`).toBeLessThanOrEqual(0.25);
    // Without translate mode the same click still belongs to the reader.
    await launched.options.activate(page, false);
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('body')).toHaveAttribute('data-slid', '1');
  });
}

test('patches do not stay painted after the page slides out of the viewer, and return with it', async ({ mockProviders }) => {
  test.setTimeout(FLOW + 30_000);
  const launched = await launch(mockProviders, 'readable', scoped);
  extension = launched.extension;
  const page = await openEpisode(extension);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const overlay = new Overlay(page);
  const point = await onCanvas(page, 1, panelA('A2').click);
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  await expect(overlay.status).toHaveText(done, { timeout: FLOW });
  expect(await paintedPatches(page)).toHaveLength(1);
  // The reader slides page 1 out of the clipped viewer. It is still inside the browser viewport, next to the cover.
  await page.evaluate(() => (window as unknown as { showSpread(n: number): void }).showSpread(2));
  await expect.poll(() => strayPatches(page)).toEqual([]);
  await page.evaluate(() => (window as unknown as { showSpread(n: number): void }).showSpread(0));
  await expect.poll(async () => (await paintedPatches(page)).length).toBe(1);
});

test('a patch follows its canvas when the reader zooms or resizes', async ({ mockProviders }) => {
  test.setTimeout(FLOW + 30_000);
  const launched = await launch(mockProviders, 'readable', scoped);
  extension = launched.extension;
  const page = await openEpisode(extension);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const overlay = new Overlay(page);
  const point = await onCanvas(page, 1, panelA('A2').click);
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  await expect(overlay.status).toHaveText(done, { timeout: FLOW });
  const relative = async () => {
    const canvas = (await page.locator('canvas[data-page="1"]').boundingBox())!;
    const patch = await settledPatch(overlay);
    return [(patch.x - canvas.x) / canvas.width, (patch.y - canvas.y) / canvas.height, patch.width / canvas.width, patch.height / canvas.height];
  };
  const initial = await relative();
  await page.addStyleTag({ content: '.js-viewer { width: 1012px !important; height: 720px !important } .js-viewer-content { width: 1012px; height: 720px } .js-page-area { width: 506px !important; height: 720px !important }' });
  await expect.poll(async () => (await relative()).map((value, index) => Math.abs(value - initial[index]) < 0.01)).toEqual([true, true, true, true]);
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(async () => (await relative()).map((value, index) => Math.abs(value - initial[index]) < 0.01)).toEqual([true, true, true, true]);
});

const drawOn = (page: Page, index: number, src: string) =>
  page.evaluate(([index, src]) => (window as unknown as { drawPage(page: number, src: string): Promise<void> }).drawPage(Number(index), String(src)), [index, src]);

async function translatedEpisode(mockProviders: MockProviderServer) {
  const launched = await launch(mockProviders, 'readable', scoped);
  extension = launched.extension;
  const page = await openEpisode(extension);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const overlay = new Overlay(page);
  const point = await onCanvas(page, 1, panelA('A2').click);
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  await expect(overlay.status).toHaveText(done, { timeout: FLOW });
  await expect.poll(async () => (await paintedPatches(page)).length).toBe(1);
  return page;
}

test('a canvas redrawn in place with another page drops the old patch', async ({ mockProviders }) => {
  test.setTimeout(FLOW + 30_000);
  const page = await translatedEpisode(mockProviders);
  // Same element. Assigning width resets the bitmap and records an attribute mutation, then page B is drawn.
  await drawOn(page, 1, pageSources[3]);
  await expect.poll(async () => (await paintedPatches(page)).length, { timeout: 5000 }).toBe(0);
});

test('single-page navigation to another episode drops the old patch', async ({ mockProviders }) => {
  test.setTimeout(FLOW + 30_000);
  const page = await translatedEpisode(mockProviders);
  await page.evaluate(() => history.pushState({}, '', '/episode/12207421984539831864'));
  await drawOn(page, 1, pageSources[4]);
  await expect.poll(async () => (await paintedPatches(page)).length, { timeout: 5000 }).toBe(0);
});

test('a canvas replaced by a new element in the same slot drops the old patch', async ({ mockProviders }) => {
  test.setTimeout(FLOW + 30_000);
  const page = await translatedEpisode(mockProviders);
  await page.evaluate(() => {
    const old = document.querySelector('canvas[data-page="1"]')!;
    old.replaceWith(old.cloneNode() as HTMLCanvasElement);
  });
  await drawOn(page, 1, pageSources[3]);
  await expect.poll(async () => (await paintedPatches(page)).length, { timeout: 5000 }).toBe(0);
});

test('Select area starts without any page element and the loose result expires when the view moves', async ({ mockProviders }) => {
  test.setTimeout(FLOW + 30_000);
  const launched = await launch(mockProviders, 'tainted', allUrls);
  extension = launched.extension;
  const page = await extension.context.newPage();
  await page.goto(generic);
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.endsWith('background.png')))).toBe(true);
  await page.waitForTimeout(300);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const overlay = new Overlay(page);
  await overlay.host.getByRole('button', { name: 'Select area', exact: true }).click();
  const box = (await page.locator('#page').boundingBox())!;
  const [x, y, width, height] = panelA('A2').bounds;
  const area = { x: box.x + x * box.width, y: box.y + y * box.height, width: width * box.width, height: height * box.height };
  await drag(page, area);
  await expect(overlay.status).toHaveText(done, { timeout: FLOW });
  const patch = await settledPatch(overlay);
  expect(Math.abs(patch.x - area.x)).toBeLessThan(4);
  expect(Math.abs(patch.y - area.y)).toBeLessThan(4);
  const text = mockProviders.requests.at(-1)?.texts.join(' ') ?? '';
  expect(characterErrorRate(panelA('A2').text, text), `OCR: ${text}`).toBeLessThanOrEqual(0.25);
  noExtensionFetch(launched.seen, `${cdn}/public/page/background.png`);
  await page.mouse.wheel(0, 240);
  await expect.poll(async () => (await paintedPatches(page)).length, { timeout: 5000 }).toBe(0);
});

// ---------------------------------------------------------------------------------------------------------------
// Residuals from the 0.4.7 review: crop that loses the click, patch placement from the first painted frame,
// tab switch during capture, and genuine browser zoom (chrome.tabs.setZoom).
// ---------------------------------------------------------------------------------------------------------------

interface Box { left: number; top: number; right: number; bottom: number }

/**
 * Records every patch rectangle that is about to be painted, from before the job starts. A sentinel's size is toggled
 * in each animation frame, so a ResizeObserver fires every frame after style and layout and before paint. Each
 * callback stores the painted (visible, unclipped) rectangle of every overlay patch at that moment.
 */
async function startFrameProbe(page: Page) {
  await page.evaluate(() => {
    const state = { frames: 0, samples: [] as { frame: number; left: number; top: number; right: number; bottom: number }[] };
    (window as unknown as { patchFrames: typeof state }).patchFrames = state;
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'position: fixed; left: -10px; top: -10px; width: 1px; height: 1px; pointer-events: none';
    document.documentElement.append(sentinel);
    new ResizeObserver(() => {
      state.frames++;
      const root = document.querySelector('manga-translator-layer')?.shadowRoot;
      if (!root) return;
      for (const patch of root.querySelectorAll<HTMLCanvasElement>('canvas.patch')) {
        if (!patch.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
        let { left, top, right, bottom } = patch.getBoundingClientRect();
        for (let node = patch.parentElement; node; node = node.parentElement) {
          if (getComputedStyle(node).overflow === 'visible') continue;
          const clip = node.getBoundingClientRect();
          left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
        }
        left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, innerWidth); bottom = Math.min(bottom, innerHeight);
        if (right - left > 1 && bottom - top > 1 && state.samples.length < 20_000) state.samples.push({ frame: state.frames, left, top, right, bottom });
      }
    }).observe(sentinel);
    let wide = false;
    const tick = () => { wide = !wide; sentinel.style.width = wide ? '2px' : '1px'; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  return {
    async outside(allowed: Box[]) {
      const state = await page.evaluate(() => (window as unknown as { patchFrames: { frames: number; samples: (Box & { frame: number })[] } }).patchFrames);
      const stray = state.samples.filter(rect => !allowed.some(box => rect.left >= box.left - 2 && rect.top >= box.top - 2 &&
        rect.right <= box.right + 2 && rect.bottom <= box.bottom + 2));
      return { frames: state.frames, samples: state.samples.length, stray: stray.slice(0, 5) };
    },
  };
}

const pageBox = async (page: Page, index: number): Promise<Box> => (await visiblePages(page)).find(item => item.page === index)!;
const areaBox = (area: { x: number; y: number; width: number; height: number }): Box =>
  ({ left: area.x, top: area.y, right: area.x + area.width, bottom: area.y + area.height });

/** Counts chrome.tabs.captureVisibleTab calls made by the service worker from now on. */
async function countCaptures(extension: LaunchedExtension) {
  await extension.serviceWorker.evaluate(() => {
    const scope = globalThis as unknown as { captureCalls?: number };
    if (scope.captureCalls !== undefined) return;
    scope.captureCalls = 0;
    const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    chrome.tabs.captureVisibleTab = ((...args: Parameters<typeof chrome.tabs.captureVisibleTab>) => {
      scope.captureCalls! += 1;
      return original(...args);
    }) as typeof chrome.tabs.captureVisibleTab;
  });
  return () => extension.serviceWorker.evaluate(() => (globalThis as unknown as { captureCalls: number }).captureCalls);
}

for (const badge of ['middle', 'bottom'] as const) {
  test(`a click on a tainted page keeps the clicked panel when an opaque badge floats ${badge === 'middle' ? 'below it' : 'near the bottom'}`, async ({ mockProviders }) => {
    test.setTimeout(FLOW + 30_000);
    const launched = await launch(mockProviders, 'tainted', allUrls);
    extension = launched.extension;
    const captures = await countCaptures(extension);
    const page = await openEpisode(extension, `${episode}?badge=${badge}`);
    expect((await launched.options.activate(page)).ok).toBe(true);
    const overlay = new Overlay(page);
    const probe = await startFrameProbe(page);
    const point = await onCanvas(page, 1, panelA('A2').click);
    const sticker = (await page.locator('.floating-badge').boundingBox())!;
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.floating-badge'), point)).toBeNull();
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
    await expect(overlay.status).toHaveText(done, { timeout: FLOW });
    expect(await captures()).toBeGreaterThanOrEqual(1);
    const text = mockProviders.requests.at(-1)?.texts.join(' ') ?? '';
    expect(characterErrorRate(panelA('A2').text, text), `OCR: ${text}`).toBeLessThanOrEqual(0.25);
    await settledPatch(overlay);
    const painted = await paintedPatches(page);
    expect(painted).toHaveLength(1);
    // The patch stays on page 1 and never covers the badge.
    expect(painted.filter(rect => rect.left < sticker.x + sticker.width && sticker.x < rect.right &&
      rect.top < sticker.y + sticker.height && sticker.y < rect.bottom)).toEqual([]);
    const result = await probe.outside([await pageBox(page, 1)]);
    expect(result.stray, JSON.stringify(result)).toEqual([]);
  });
}

const placementCases = [
  { name: 'tainted click', mode: 'tainted' as const, drag: false },
  { name: 'tainted Select area', mode: 'tainted' as const, drag: true },
  { name: 'readable click', mode: 'readable' as const, drag: false },
  { name: 'readable Select area', mode: 'readable' as const, drag: true },
];
for (const item of placementCases) {
  test(`${item.name}: no patch is painted outside its expected bounds from the first frame`, async ({ mockProviders }) => {
    test.setTimeout(FLOW + 30_000);
    const launched = await launch(mockProviders, item.mode, item.mode === 'readable' ? scoped : allUrls);
    extension = launched.extension;
    const page = await openEpisode(extension);
    expect((await launched.options.activate(page)).ok).toBe(true);
    const overlay = new Overlay(page);
    const probe = await startFrameProbe(page);
    let allowed: Box;
    if (item.drag) {
      await overlay.host.getByRole('button', { name: 'Select area', exact: true }).click();
      const area = await canvasClip(page, 1, panelA('A4').bounds);
      allowed = areaBox(area);
      await drag(page, area);
    } else {
      allowed = await pageBox(page, 1);
      const point = await onCanvas(page, 1, panelA('A2').click);
      await page.mouse.move(point.x, point.y);
      await page.mouse.click(point.x, point.y);
    }
    await expect(overlay.status).toHaveText(done, { timeout: FLOW });
    await settledPatch(overlay);
    await page.waitForTimeout(300);
    const result = await probe.outside([allowed]);
    expect(result.samples, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.stray, JSON.stringify(result)).toEqual([]);
  });
}

test('freeform Select area: no patch is painted outside the dragged area from the first frame', async ({ mockProviders }) => {
  test.setTimeout(FLOW + 30_000);
  const launched = await launch(mockProviders, 'tainted', allUrls);
  extension = launched.extension;
  const page = await extension.context.newPage();
  await page.goto(generic);
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.endsWith('background.png')))).toBe(true);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const overlay = new Overlay(page);
  const probe = await startFrameProbe(page);
  await overlay.host.getByRole('button', { name: 'Select area', exact: true }).click();
  const box = (await page.locator('#page').boundingBox())!;
  const [x, y, width, height] = panelA('A2').bounds;
  const area = { x: box.x + x * box.width, y: box.y + y * box.height, width: width * box.width, height: height * box.height };
  await drag(page, area);
  await expect(overlay.status).toHaveText(done, { timeout: FLOW });
  await settledPatch(overlay);
  await page.waitForTimeout(300);
  const result = await probe.outside([areaBox(area)]);
  expect(result.samples, JSON.stringify(result)).toBeGreaterThan(0);
  expect(result.stray, JSON.stringify(result)).toEqual([]);
});

test('switching tabs while the reader prepares a capture refuses the capture and paints nothing', async ({ mockProviders }) => {
  test.setTimeout(FLOW + 30_000);
  const launched = await launch(mockProviders, 'tainted', allUrls);
  extension = launched.extension;
  const captures = await countCaptures(extension);
  // The other tab shows a readable manga page, so a capture of the wrong tab would reach OCR and the provider.
  const other = await extension.context.newPage();
  await other.goto(generic);
  const otherTab = await launched.options.tabIdOf(other);
  const page = await openEpisode(extension);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const overlay = new Overlay(page);
  let switchedAt = 0;
  await page.exposeBinding('mangaCapturePrepared', async () => {
    await extension!.serviceWorker.evaluate(id => chrome.tabs.update(id, { active: true }), otherTab);
    switchedAt = Date.now();
  });
  // When the reader hides its overlay for the capture, notify the test and hold the page's main thread for 1.5 s.
  // The content script cannot finish preparing until then, so the tab switch lands before the extension continues.
  await page.evaluate(() => {
    const host = document.querySelector('manga-translator-layer')!;
    const observer = new MutationObserver(() => {
      if (!host.hasAttribute('data-capturing')) return;
      observer.disconnect();
      document.body.dataset.heldAt = String(Date.now());
      void (window as unknown as { mangaCapturePrepared(): Promise<void> }).mangaCapturePrepared();
      const until = performance.now() + 1500;
      while (performance.now() < until) { /* hold */ }
    });
    observer.observe(host, { attributes: true, attributeFilter: ['data-capturing'] });
  });
  await overlay.host.getByRole('button', { name: 'Select area', exact: true }).click();
  const area = await canvasClip(page, 1, panelA('A4').bounds);
  await drag(page, area);
  await expect(overlay.status).toHaveText('The reader tab changed. Select the area again.', { timeout: FLOW });
  expect(switchedAt, 'tab switch happened').toBeGreaterThan(0);
  expect(await captures(), 'captureVisibleTab calls').toBe(0);
  expect(mockProviders.requests).toHaveLength(0);
  await page.bringToFront();
  await extension.serviceWorker.evaluate(id => chrome.tabs.update(id, { active: true }), await launched.options.tabIdOf(page));
  await expect(overlay.patches).toHaveCount(0);
  await expect(page.locator('manga-translator-layer')).not.toHaveAttribute('data-capturing', /.*/);
  // After returning, the same selection works again.
  await overlay.host.getByRole('button', { name: 'Select area', exact: true }).click();
  await drag(page, area);
  await expect(overlay.status).toHaveText(done, { timeout: FLOW });
  expect(await captures()).toBe(1);
  const text = mockProviders.requests.at(-1)?.texts.join(' ') ?? '';
  expect(characterErrorRate(panelA('A4').text, text), `OCR: ${text}`).toBeLessThanOrEqual(0.25);
});

test('browser zoom (chrome.tabs.setZoom) keeps a patch on its canvas and a tainted Select area on the dragged rectangle', async ({ mockProviders }) => {
  test.setTimeout(FLOW * 2);
  const launched = await launch(mockProviders, 'tainted', allUrls);
  extension = launched.extension;
  const page = await openEpisode(extension);
  const tabId = await launched.options.tabIdOf(page);
  expect((await launched.options.activate(page)).ok).toBe(true);
  const overlay = new Overlay(page);
  const point = await onCanvas(page, 1, panelA('A2').click);
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  await expect(overlay.status).toHaveText(done, { timeout: FLOW });
  const relative = async () => {
    const canvas = (await page.locator('canvas[data-page="1"]').boundingBox())!;
    const patch = await settledPatch(overlay);
    return [(patch.x - canvas.x) / canvas.width, (patch.y - canvas.y) / canvas.height, patch.width / canvas.width, patch.height / canvas.height];
  };
  const initial = await relative();
  await extension.serviceWorker.evaluate(id => chrome.tabs.setZoom(id, 1.25), tabId);
  await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(1.25, 2);
  await expect.poll(async () => (await relative()).map((value, index) => Math.abs(value - initial[index]) < 0.01)).toEqual([true, true, true, true]);
  // A capture under zoom must crop the dragged rectangle in device pixels.
  await overlay.host.getByRole('button', { name: 'Select area', exact: true }).click();
  const area = await canvasClip(page, 1, panelA('A4').bounds);
  // Harness check: Playwright mouse coordinates must land on the same CSS pixel under browser zoom.
  await page.evaluate(() => addEventListener('pointermove', event => {
    (window as unknown as { lastMove: [number, number] }).lastMove = [event.clientX, event.clientY];
  }, true));
  await page.mouse.move(area.x, area.y);
  const landed = await page.evaluate(() => (window as unknown as { lastMove?: [number, number] }).lastMove);
  test.skip(!landed || Math.abs(landed[0] - area.x) > 2 || Math.abs(landed[1] - area.y) > 2,
    `Playwright mouse does not map to CSS pixels under chrome.tabs.setZoom: wanted ${area.x},${area.y} got ${landed}`);
  await drag(page, area);
  await expect(overlay.status).toHaveText(done, { timeout: FLOW });
  const text = mockProviders.requests.at(-1)?.texts.join(' ') ?? '';
  expect(characterErrorRate(panelA('A4').text, text), `OCR under zoom: ${text}`).toBeLessThanOrEqual(0.25);
  const painted = await paintedPatches(page);
  expect(painted.some(rect => Math.abs(rect.left - area.x) < 4 && Math.abs(rect.top - area.y) < 4 &&
    Math.abs(rect.right - area.x - area.width) < 4 && Math.abs(rect.bottom - area.y - area.height) < 4), JSON.stringify({ painted, area })).toBe(true);
  await extension.serviceWorker.evaluate(id => chrome.tabs.setZoom(id, 1), tabId);
});

const zoomCases = [
  { name: 'tainted Select area', mode: 'tainted' as const, kind: 'drag' as const },
  { name: 'readable Select area', mode: 'readable' as const, kind: 'drag' as const },
  { name: 'tainted click', mode: 'tainted' as const, kind: 'click' as const },
  { name: 'freeform Select area', mode: 'tainted' as const, kind: 'freeform' as const },
];
for (const item of zoomCases) {
  test(`browser zoom 125%: ${item.name} paints the patch on its target`, async ({ mockProviders }) => {
    test.setTimeout(FLOW + 30_000);
    const launched = await launch(mockProviders, item.mode, item.mode === 'readable' ? scoped : allUrls);
    extension = launched.extension;
    const page = item.kind === 'freeform' ? await extension.context.newPage() : await openEpisode(extension);
    if (item.kind === 'freeform') {
      await page.goto(generic);
      await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.endsWith('background.png')))).toBe(true);
    }
    const tabId = await launched.options.tabIdOf(page);
    await extension.serviceWorker.evaluate(id => chrome.tabs.setZoom(id, 1.25), tabId);
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(1.25, 2);
    expect((await launched.options.activate(page)).ok).toBe(true);
    const overlay = new Overlay(page);
    await page.evaluate(() => addEventListener('pointermove', event => {
      (window as unknown as { lastMove: [number, number] }).lastMove = [event.clientX, event.clientY];
    }, true));
    let target: Box;
    let expected: string;
    if (item.kind === 'click') {
      const point = await onCanvas(page, 1, panelA('A2').click);
      await page.mouse.move(point.x, point.y);
      const landed = await page.evaluate(() => (window as unknown as { lastMove?: [number, number] }).lastMove);
      test.skip(!landed || Math.abs(landed[0] - point.x) > 2 || Math.abs(landed[1] - point.y) > 2, `mouse mapping under zoom: ${landed}`);
      await page.mouse.click(point.x, point.y);
      target = await pageBox(page, 1);
      expected = panelA('A2').text;
    } else {
      await overlay.host.getByRole('button', { name: 'Select area', exact: true }).click();
      let area;
      if (item.kind === 'drag') area = await canvasClip(page, 1, panelA('A4').bounds);
      else {
        const box = (await page.locator('#page').boundingBox())!;
        const [x, y, width, height] = panelA('A2').bounds;
        area = { x: box.x + x * box.width, y: box.y + y * box.height, width: width * box.width, height: height * box.height };
      }
      await page.mouse.move(area.x, area.y);
      const landed = await page.evaluate(() => (window as unknown as { lastMove?: [number, number] }).lastMove);
      test.skip(!landed || Math.abs(landed[0] - area.x) > 2 || Math.abs(landed[1] - area.y) > 2, `mouse mapping under zoom: ${landed}`);
      await drag(page, area);
      target = areaBox(area);
      expected = item.kind === 'drag' ? panelA('A4').text : panelA('A2').text;
    }
    await expect(overlay.status).toHaveText(done, { timeout: FLOW });
    const text = mockProviders.requests.at(-1)?.texts.join(' ') ?? '';
    expect(characterErrorRate(expected, text), `OCR under zoom: ${text}`).toBeLessThanOrEqual(0.25);
    await settledPatch(overlay);
    const painted = await paintedPatches(page);
    expect(painted, JSON.stringify({ painted, target })).toHaveLength(1);
    const [rect] = painted;
    const inside = rect.left >= target.left - 3 && rect.top >= target.top - 3 && rect.right <= target.right + 3 && rect.bottom <= target.bottom + 3;
    expect(inside, JSON.stringify({ painted, target })).toBe(true);
    if (item.kind !== 'click') {
      expect(Math.abs(rect.right - rect.left - (target.right - target.left)), JSON.stringify({ painted, target })).toBeLessThan(4);
      expect(Math.abs(rect.bottom - rect.top - (target.bottom - target.top)), JSON.stringify({ painted, target })).toBeLessThan(4);
    }
  });
}
