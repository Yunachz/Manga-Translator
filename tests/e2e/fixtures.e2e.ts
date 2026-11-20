import { expect, test } from './support/test';
import { loadOracle, viewportPoint } from './support/oracle';

/**
 * QA-PLAN.md "Verify the fixture alone". No extension involved. Guards the fixture itself so an
 * extension failure can be told apart from a broken reader page.
 */

const oracle = loadOracle();

test.beforeEach(async ({ page, fixtureServer }) => {
  fixtureServer.reset();
  await page.goto(`${fixtureServer.origin}/reader.html`);
  await expect(page.locator('#plain-page')).toHaveJSProperty('complete', true);
});

const currentSrc = (page: import('@playwright/test').Page) => page.locator('#picture-page').evaluate((img: HTMLImageElement) => img.currentSrc);

test('plain image shows page A at natural size', async ({ page }) => {
  const size = await page.locator('#plain-page').evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
  expect(size).toEqual([oracle.imageSize.width, oracle.imageSize.height]);
});

test('picture stays on page A, and page B is not requested, until the swap is queued and visible', async ({ page, fixtureServer }) => {
  expect(await currentSrc(page)).toMatch(/\/page-a\.png$/);
  await page.waitForTimeout(300);
  expect(fixtureServer.requests.filter(path => path.includes('page-b.png'))).toEqual([]);
});

test('queueing B alone does not load it while the picture is out of view', async ({ page, fixtureServer }) => {
  await page.locator('#queue-page-b').click();
  await expect(page.locator('#queue-page-b')).toHaveText('Page B queued');
  await expect(page.locator('#picture-status')).toHaveText('Page B queued');
  await page.waitForTimeout(300);
  expect(fixtureServer.requests.filter(path => path.includes('page-b.png'))).toEqual([]);
});

test('scrolling to the queued picture swaps in B on the same img element and keeps the fallback src', async ({ page }) => {
  await page.locator('#queue-page-b').click();
  await page.getByRole('link', { name: 'Go to picture reader' }).click();
  await expect(page.locator('#picture-status')).toHaveText('Page B loaded');
  expect(await currentSrc(page)).toMatch(/\/page-b\.png$/);
  await expect(page.locator('#picture-page')).toHaveAttribute('src', './page-a.png?fallback');
  const plain = await page.locator('#plain-page').evaluate((img: HTMLImageElement) => img.currentSrc);
  expect(plain).toMatch(/\/page-a\.png$/);
});

test('visiting the picture without queuing B keeps page A', async ({ page }) => {
  await page.getByRole('link', { name: 'Go to picture reader' }).click();
  await expect(page.locator('#picture-page')).toHaveJSProperty('complete', true);
  expect(await currentSrc(page)).toMatch(/\/page-a\.png$/);
  await expect(page.locator('#picture-status')).toHaveText('Page A selected');
});

test('reload resets the fixture', async ({ page }) => {
  await page.locator('#queue-page-b').click();
  await page.reload();
  await expect(page.locator('#queue-page-b')).toBeEnabled();
  await expect(page.locator('#queue-page-b')).toHaveText('Queue Page B');
});

test.describe('click oracle lands on the image element', () => {
  for (const [file, truth] of Object.entries(oracle.pages)) {
    // Only page A is on the plain image. Page B is on the picture after the swap, covered above.
    if (file !== 'page-a.png') continue;
    for (const panel of truth.panels) {
      test(`${panel.id} bubble point hits #plain-page`, async ({ page }) => {
        const point = await viewportPoint(page, '#plain-page', panel.click);
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point);
        expect(hit).toBe('plain-page');
      });
    }
  }

  test('mapped points are proportional to the displayed size at a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    const box = await page.locator('#plain-page').boundingBox();
    expect(box).not.toBeNull();
    const point = await viewportPoint(page, '#plain-page', [0.73, 0.166667]);
    const after = (await page.locator('#plain-page').boundingBox())!;
    expect(point.x).toBeCloseTo(after.x + 0.73 * after.width, 3);
    expect(after.width / after.height).toBeCloseTo(1000 / 1200, 2);
  });
});
