import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Route } from '@playwright/test';
import type { ChapterStatus } from '../../src/core/chapter/ChapterRun';
import { OptionsClient, Overlay } from './support/driver';
import { launchExtension, type LaunchedExtension } from './support/extension';
import { MOCK_API_KEY } from './support/mock-providers';
import { extensionDir, fixturesDir, hasBuiltExtension } from './support/paths';
import { expect, test } from './support/test';

const witch = 'https://w2.secretsofthesilentwitch.online/chapters/33/';
const witchCdn = 'https://manga.xtdz.top/Secrets-of-the-Silent-Witch/033';
const dexId = 'f49c0d3e-ddb1-487b-9514-39f781b8a168';
const dex = 'https://mangadex.org/chapter/' + dexId;
const dexCdn = 'https://uploads.mangadex.org';
const hash = 'abcd1234'.repeat(4);
const dataPath = dexCdn + '/data/' + hash;
const sources = {
  witch: [witchCdn + '/p001.png', witchCdn + '/p002.png'],
  dex: [dataPath + '/p001.png', dataPath + '/p002.png'],
};
const files = ['page-a.png', 'page-b.png'].map(file => readFileSync(join(fixturesDir, file)));
const grantHosts = [witch, witchCdn, dex, dexCdn, 'https://api.mangadex.org', 'https://api-free.deepl.com']
  .map(url => new URL(url).origin + '/*');

test.skip(!hasBuiltExtension(), 'requires the unpacked extension');
let extension: LaunchedExtension;
let options: OptionsClient;

test.beforeAll(async ({ mockProviders }) => {
  extension = await launchExtension(extensionDir(), { mock: mockProviders, grantHosts });
  const { context } = extension;
  for (const [site, pages] of Object.entries(sources)) {
    for (const [index, src] of pages.entries()) {
      await context.route(src, route => route.fulfill({ body: files[index], contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' } }));
    }
    if (site === 'witch') {
      await context.route(witch, route => route.fulfill({ contentType: 'text/html',
        body: `<img id="reader" width="570" src="${pages[0]}"><script type="application/json">${JSON.stringify({ images: pages })}</script>` }));
      await context.route(new URL('..', witch).href, route => route.fulfill({ contentType: 'text/html', body: '<h1>Daftar bab</h1>' }));
      await context.route(witch + '?missing=1', route => route.fulfill({ contentType: 'text/html',
        body: `<img id="reader" width="570" src="${pages[0]}">` }));
    } else {
      await context.route(dex + '/*', route => route.fulfill({ contentType: 'text/html', body: `
        <style>body { margin: 0 } main { position: relative; width: 570px } #navigation {
          position: absolute; inset: 0; border: 0; background: transparent; padding: 0;
        }</style>
        <main><img id="reader" width="570" src="${pages[0]}"><button id="navigation" aria-label="Halaman berikutnya" onclick="this.dataset.clicked = 'yes'"></button></main>` }));
    }
  }
  await context.route('https://api.mangadex.org/at-home/server/**', route =>
    route.fulfill({ json: { baseUrl: dexCdn, chapter: { hash, data: ['p001.png', 'p002.png'], dataSaver: [] } } }));
  options = await OptionsClient.open(extension);
  await options.setSettings({ uiLanguage: 'id', enabled: true, provider: 'deepl', source: 'en', target: 'id', ocrLanguage: 'en',
    readingOrder: 'ttb', performance: 'wasm', prefetch: false });
  await options.setCredential('deepl', MOCK_API_KEY);
});

test.afterAll(async () => { await extension?.dispose(); });

test('Silent Witch discovers lazy chapter pages before they mount and restores patches on load', async () => {
  test.setTimeout(120_000);
  const page = await extension.context.newPage();
  try {
    await page.goto(witch);
    const tabId = await options.tabIdOf(page);
    const status = () => options.request<{ active: boolean; chapter?: ChapterStatus }>({ type: 'GET_TAB', tabId });
    await options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
    await expect.poll(async () => (await status()).chapter, { timeout: 90_000 })
      .toMatchObject({ phase: 'completed', total: 2, processed: 2, translated: 2, failed: 0 });
    expect((await status()).active).toBe(false);
    const overlay = new Overlay(page);
    await expect(overlay.patches).toHaveCount(1);
    expect((await options.activate(page)).ok).toBe(true);
    await page.locator('#reader').hover({ position: { x: 175, y: 215 } });
    await expect(page.locator('html')).not.toHaveClass(/manga-translate-covered/);
    await page.locator('#reader').hover({ position: { x: 154, y: 114 } });
    await expect(page.locator('html')).toHaveClass(/manga-translate-covered/);
    await page.locator('#reader').click({ position: { x: 154, y: 114 } });
    await expect(overlay.patches).toHaveCount(1);
    await expect(overlay.status).toContainText('Pemrosesan bab selesai');
    await expect(overlay.host.getByRole('button', { name: 'Pilih area', exact: true })).toBeVisible();
    await page.locator('#reader').evaluate((image, src) => (image as HTMLImageElement).src = src, sources.witch[1]);
    await expect(overlay.host.locator('canvas[data-panel^="chapter-"][data-panel$="-2"]')).toHaveCount(1);
    await overlay.button('Tampilkan asli').click();
    await expect(overlay.patches).toBeHidden();
    await overlay.button('Tampilkan terjemahan').click();
    await expect(overlay.patches).toBeVisible();
  } finally {
    await page.close();
  }
});

test('MangaDex handles empty navigation zones and maps a chapter run across single-page navigation', async () => {
  test.setTimeout(120_000);
  const page = await extension.context.newPage();
  try {
    await page.goto(dex + '/1');
    const tabId = await options.tabIdOf(page);
    const status = () => options.request<{ active: boolean; chapter?: ChapterStatus }>({ type: 'GET_TAB', tabId });
    expect((await options.activate(page)).ok).toBe(true);
    const overlay = new Overlay(page);
    await expect(overlay.status).toHaveText('Klik panel yang ingin diterjemahkan.');
    await page.locator('#navigation').click({ position: { x: 130, y: 190 } });
    await expect(overlay.patches).toHaveCount(1, { timeout: 30_000 });
    await options.activate(page, false);
    await options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
    await expect.poll(async () => (await status()).chapter, { timeout: 90_000 })
      .toMatchObject({ phase: 'completed', total: 2, processed: 2, translated: 2, failed: 0 });
    expect((await status()).active).toBe(false);
    await expect(overlay.host.locator('canvas[data-panel^="chapter-"][data-panel$="-1"]')).toHaveCount(1);
    await page.locator('#navigation').click({ position: { x: 130, y: 190 } });
    await expect(page.locator('#navigation')).toHaveAttribute('data-clicked', 'yes');
    await page.locator('#reader').evaluate((image, src) => {
      history.pushState({}, '', location.pathname.replace(/\/1$/, '/2'));
      (image as HTMLImageElement).src = src;
    }, sources.dex[1]);
    await expect(overlay.host.locator('canvas[data-panel^="chapter-"][data-panel$="-2"]')).toHaveCount(1);
    await expect(overlay.host.locator('canvas[data-panel^="chapter-"][data-panel$="-1"]')).toHaveCount(0);
  } finally {
    await page.close();
  }
});

test('MangaDex overlays chapter results on matching reader blob images', async () => {
  const page = await extension.context.newPage();
  const showBlob = (index: number) => page.locator('#reader').evaluate(async (node, { src, index }) => {
    history.replaceState({}, '', location.pathname.replace(/\/\d+$/, '/' + index));
    const img = node as HTMLImageElement;
    const blob = await (await fetch(src)).blob();
    img.src = URL.createObjectURL(blob);
    await img.decode();
  }, { src: sources.dex[index - 1], index });
  try {
    await page.goto(dex + '/1');
    await showBlob(1);
    const tabId = await options.tabIdOf(page);
    await options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
    const overlay = new Overlay(page);
    await expect(overlay.host.locator('canvas[data-panel^="chapter-"][data-panel$="-1"]')).toHaveCount(1);
    await showBlob(2);
    await expect(overlay.host.locator('canvas[data-panel^="chapter-"][data-panel$="-2"]')).toHaveCount(1);
    await expect(overlay.host.locator('canvas[data-panel^="chapter-"][data-panel$="-1"]')).toHaveCount(0);
  } finally {
    await page.close();
  }
});

async function popupFor(ext: LaunchedExtension, tabId: number, stubPermission = false) {
  const popup = await ext.context.newPage();
  await popup.addInitScript(({ id, stubPermission }) => {
    // Loading popup.html as a tab changes the active tab. Supply the toolbar popup's target.
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (async (filter: chrome.tabs.QueryInfo) =>
      filter.active ? [{ id, active: true }] : query(filter)) as typeof chrome.tabs.query;
    if (stubPermission) {
      let granted = false;
      chrome.permissions.request = (async () => {
        granted = sessionStorage.getItem('mock-permission') === 'grant';
        return granted;
      }) as typeof chrome.permissions.request;
      chrome.permissions.contains = (async () => granted) as typeof chrome.permissions.contains;
    }
  }, { id: tabId, stubPermission });
  await popup.setViewportSize({ width: 320, height: 600 });
  await popup.goto('chrome-extension://' + ext.id + '/popup.html');
  return popup;
}

test('chapter preview ignores rapid double Enter and fits a zoomed popup', async () => {
  const reader = await extension.context.newPage();
  await reader.goto(witch);
  const tabId = await options.tabIdOf(reader);
  const popup = await popupFor(extension, tabId);
  try {
    const review = popup.getByRole('button', { name: 'Tinjau terjemahan bab' });
    const summary = popup.getByText('Periksa penyedia dan bahasa di atas sebelum memulai bab.');
    await expect(review).toBeVisible();
    await review.focus();
    await popup.keyboard.press('Enter');
    await popup.keyboard.press('Enter');
    await expect(summary).toBeFocused();
    await expect(popup.getByRole('button', { name: 'Mulai terjemahan' })).toBeVisible();
    const status = await options.request<{ chapter?: ChapterStatus }>({ type: 'GET_TAB', tabId });
    expect(status.chapter).toBeUndefined();
    await popup.keyboard.press('Tab');
    await expect(popup.getByRole('button', { name: 'Mulai terjemahan' })).toBeFocused();
    for (const width of [320, 200, 160]) {
      await popup.setViewportSize({ width, height: 600 });
      expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    await popup.keyboard.press('Escape');
    await expect(review).toBeFocused();
    const enabled = popup.getByRole('checkbox', { name: 'Extension aktif' });
    await enabled.uncheck();
    try {
      await expect(review).toHaveAttribute('aria-disabled', 'true');
      await review.focus();
      await popup.keyboard.press('Enter');
      await expect(popup.getByText('Aktifkan ekstensi untuk menerjemahkan bab.')).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Mulai terjemahan' })).toHaveCount(0);
    } finally {
      await enabled.check();
    }
    await expect(new Overlay(reader).host).toHaveCount(0);
    await reader.goto(new URL('..', witch).href);
    await expect(popup.getByRole('heading', { name: 'Terjemahkan halaman yang sudah dimuat' })).toBeVisible();
  } finally {
    await popup.close();
    await reader.close();
  }
});

test('chapter permission denial stays compact and a simulated grant resumes processing', async ({ mockProviders }) => {
  const ungranted = await launchExtension(extensionDir(), { mock: mockProviders,
    grantHosts: grantHosts.filter(pattern => pattern !== new URL(witchCdn).origin + '/*') });
  try {
    await ungranted.context.route(witch, route => route.fulfill({ contentType: 'text/html',
      body: `<img width="570" src="${sources.witch[0]}"><script type="application/json">${JSON.stringify({ images: sources.witch })}</script>` }));
    for (const [index, src] of sources.witch.entries()) {
      await ungranted.context.route(src, route => route.fulfill({ body: files[index], contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' } }));
    }
    const reader = await ungranted.context.newPage();
    await reader.goto(witch);
    const driver = await OptionsClient.open(ungranted);
    await driver.setSettings({ uiLanguage: 'id', enabled: true, provider: 'deepl', source: 'en', target: 'id',
      ocrLanguage: 'en', performance: 'wasm', prefetch: false });
    await driver.setCredential('deepl', MOCK_API_KEY);
    const tabId = await driver.tabIdOf(reader);
    await reader.bringToFront();
    await driver.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
    const overlay = new Overlay(reader);
    await expect(overlay.status).toContainText('Izinkan akses gambar di popup. Terjemahan akan lanjut otomatis.');
    const popup = await popupFor(ungranted, tabId, true);
    const grant = popup.getByRole('button', { name: 'Izinkan domain gambar' });
    const resume = popup.getByRole('button', { name: 'Lanjutkan' });
    await expect(resume).toHaveCount(0);
    await grant.click();
    await expect(popup.getByRole('alert')).toHaveText('Izin belum diberikan.');
    const button = (await grant.boundingBox())!;
    expect(button.y + button.height).toBeLessThanOrEqual(600);
    await expect(grant).toBeFocused();
    await ungranted.serviceWorker.evaluate(origin => {
      const contains = chrome.permissions.contains.bind(chrome.permissions);
      chrome.permissions.contains = (async (query: chrome.permissions.Permissions) =>
        query.origins?.includes(origin + '/*') || contains(query)) as typeof chrome.permissions.contains;
    }, new URL(witchCdn).origin);
    await popup.evaluate(() => sessionStorage.setItem('mock-permission', 'grant'));
    await grant.click();
    await expect(grant).toHaveCount(0);
    await expect(resume).toHaveCount(0);
    await expect(overlay.status).toContainText('Pemrosesan bab selesai · 2/2 halaman', { timeout: 30_000 });
    await expect(overlay.patches).toHaveCount(1);
  } finally {
    await ungranted.dispose();
  }
});

test('translated panels ignore repeated clicks until the popup clears this tab', async () => {
  const reader = await extension.context.newPage();
  const other = await extension.context.newPage();
  let popup: Awaited<ReturnType<typeof popupFor>> | undefined;
  const point = { x: 154, y: 114 };
  try {
    for (const tab of [other, reader]) {
      await tab.goto(dex + '/1');
      expect((await options.activate(tab)).ok).toBe(true);
      await tab.locator('#navigation').click({ position: point });
      await expect(new Overlay(tab).patches).toHaveCount(1, { timeout: 30_000 });
    }
    const target = reader.locator('#navigation');
    const overlay = new Overlay(reader);
    await target.hover({ position: point });
    await expect(reader.locator('html')).toHaveClass(/manga-translate-covered/);
    await target.hover({ position: { x: 420, y: 190 } });
    await expect(reader.locator('html')).not.toHaveClass(/manga-translate-covered/);
    await target.click({ position: point });
    await expect(target).not.toHaveAttribute('data-clicked', 'yes');
    await expect(overlay.status).toHaveText('Dialog ini sudah diterjemahkan.');
    await overlay.button('Tampilkan asli').click();
    await expect(overlay.patches).toHaveCount(1);
    await expect(overlay.patches).toBeHidden();
    const tabId = await options.tabIdOf(reader);
    popup = await popupFor(extension, tabId);
    await reader.bringToFront();
    await popup.getByRole('button', { name: 'Hapus terjemahan' }).click();
    await expect(popup.getByText('Terjemahan di tab ini sudah dihapus.')).toBeVisible();
    await expect(overlay.patches).toHaveCount(0);
    await expect(new Overlay(other).patches).toHaveCount(1);
    await target.hover({ position: point });
    await expect(reader.locator('html')).not.toHaveClass(/manga-translate-covered/);
    await target.click({ position: point });
    await expect(overlay.patches).toHaveCount(1, { timeout: 30_000 });
    await expect(overlay.patches).toBeVisible();
  } finally {
    await popup?.close();
    await reader.close();
    await other.close();
  }
});

test('popup and reader distinguish failed runs and retry only failed pages', async () => {
  const reader = await extension.context.newPage();
  const requested: string[] = [];
  const reject = new Set(sources.witch);
  const imageHandler = (index: number) => (route: Route) => {
    if (route.request().serviceWorker()) {
      requested.push(route.request().url());
      if (reject.has(route.request().url())) return route.fulfill({ status: 500 });
    }
    return route.fulfill({ body: files[index], contentType: 'image/png' });
  };
  const handlers = sources.witch.map((_src, index) => imageHandler(index));
  let popup: Awaited<ReturnType<typeof popupFor>> | undefined;
  try {
    for (const [index, src] of sources.witch.entries()) await extension.context.route(src, handlers[index]);
    await reader.goto(witch);
    const tabId = await options.tabIdOf(reader);
    popup = await popupFor(extension, tabId);
    await reader.bringToFront();
    await options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
    const overlay = new Overlay(reader);
    await expect(overlay.status).toContainText('Semua halaman gagal diproses · 2/2 halaman');
    const status = popup.locator('.chapter-status');
    await expect(status).toHaveText('Semua halaman gagal diproses · 2/2 halaman');
    expect(requested.splice(0).sort()).toEqual([...sources.witch].sort());
    await expect(popup.getByRole('button', { name: 'Coba lagi halaman gagal' })).toBeVisible();
    reject.delete(sources.witch[0]);
    await overlay.button('Coba lagi halaman gagal').click();
    await expect(status).toHaveText('Sebagian halaman gagal diproses · 2/2 halaman');
    await expect(overlay.patches).toHaveCount(1);
    expect(requested.splice(0).sort()).toEqual([...sources.witch].sort());
    reject.clear();
    await overlay.button('Coba lagi halaman gagal').click();
    await expect(status).toHaveText('Pemrosesan bab selesai · 2/2 halaman');
    expect(requested).toEqual([sources.witch[1]]);
  } finally {
    await popup?.close();
    for (const [index, src] of sources.witch.entries()) await extension.context.unroute(src, handlers[index]);
    await reader.close();
  }
});

test('Silent Witch does not declare a complete chapter from the currently mounted image', async () => {
  const reader = await extension.context.newPage();
  try {
    await reader.goto(witch + '?missing=1');
    const tabId = await options.tabIdOf(reader);
    await options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
    const overlay = new Overlay(reader);
    await expect(overlay.status).toContainText('Daftar halaman bab belum ditemukan');
    await expect(overlay.patches).toHaveCount(0);
    const status = await options.request<{ chapter?: ChapterStatus }>({ type: 'GET_TAB', tabId });
    expect(status.chapter).toMatchObject({ phase: 'error', total: null, processed: 0 });
  } finally {
    await reader.close();
  }
});

test('reader controls pause after the active page and cancel the rest of the chapter', async () => {
  const reader = await extension.context.newPage();
  const overlay = new Overlay(reader);
  const gates = sources.witch.map((src, index) => {
    const fetching = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const handler = async (route: Route) => {
      if (route.request().serviceWorker()) {
        fetching.resolve();
        await release.promise;
      }
      await route.fulfill({ body: files[index], contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } })
        .catch(() => undefined);
    };
    return { src, handler, fetching, release };
  });
  try {
    for (const gate of gates) await extension.context.route(gate.src, gate.handler);
    await reader.goto(witch);
    const tabId = await options.tabIdOf(reader);
    const status = () => options.request<{ chapter?: ChapterStatus }>({ type: 'GET_TAB', tabId });
    await options.request({ type: 'CHAPTER_CONTROL', tabId, command: 'start' });
    await gates[0].fetching.promise;
    await overlay.button('Jeda').click();
    await expect(overlay.status).toContainText('Menjeda setelah langkah ini');
    gates[0].release.resolve();
    await expect.poll(async () => (await status()).chapter).toMatchObject({ phase: 'paused', processed: 1 });
    await expect(overlay.patches).toHaveCount(1);
    await overlay.button('Lanjutkan').click();
    await gates[1].fetching.promise;
    await overlay.button('Hentikan bab').click();
    await expect.poll(async () => (await status()).chapter).toMatchObject({ phase: 'stopped', processed: 1 });
    gates[1].release.resolve();
    await expect(overlay.patches).toHaveCount(1);
  } finally {
    for (const gate of gates) {
      gate.release.resolve();
      await extension.context.unroute(gate.src, gate.handler);
    }
    await reader.close();
  }
});
