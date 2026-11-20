import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectGutters } from '../../../src/core/panel/ClassicalPanelDetector';
import { selectPanel } from '../../../src/core/image/geometry';
import type { PanelRegion } from '../../../src/types/contracts';
import { asImageData, createRaster, drawPanel, fillRect, mulberry32, resizeNearest } from '../../support/pixels';
import { decodePng } from '../../support/png';

const fixtures = resolve(__dirname, '../../fixtures');

type Box = [x: number, y: number, width: number, height: number];

function boxesOf(panels: PanelRegion[], width: number, height: number): Box[] {
  return panels
    .map(({ bounds }): Box => [
      Math.round(bounds.x * width), Math.round(bounds.y * height),
      Math.round(bounds.width * width), Math.round(bounds.height * height),
    ])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function expectBoxes(actual: Box[], expected: Box[], tolerance: number) {
  expect(actual).toHaveLength(expected.length);
  const want = [...expected].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  actual.forEach((box, index) => box.forEach((value, i) => expect(Math.abs(value - want[index][i]),
    `panel ${index} component ${i}: got ${box} want ${want[index]}`).toBeLessThanOrEqual(tolerance)));
}

describe('detectGutters: synthetic pages', () => {
  it('finds a 2 x 2 grid separated by white gutters', () => {
    const page = createRaster(400, 500, 255);
    drawPanel(page, 20, 20, 170, 220);
    drawPanel(page, 210, 20, 170, 220);
    drawPanel(page, 20, 260, 170, 220);
    drawPanel(page, 210, 260, 170, 220);
    const panels = detectGutters(asImageData(page));
    expectBoxes(boxesOf(panels, 400, 500), [[20, 20, 170, 220], [210, 20, 170, 220], [20, 260, 170, 220], [210, 260, 170, 220]], 2);
  });

  it('keeps normalized bounds in [0, 1] and polygons equal to the bounds rectangle', () => {
    const page = createRaster(400, 500, 255);
    drawPanel(page, 20, 20, 360, 220);
    drawPanel(page, 20, 260, 170, 220);
    drawPanel(page, 210, 260, 170, 220);
    const panels = detectGutters(asImageData(page));
    expect(panels).toHaveLength(3);
    for (const { bounds, polygon, confidence, id } of panels) {
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(1);
      expect(polygon).toEqual([
        { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height },
      ]);
      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
      expect(id).toMatch(/^gutter-\d+$/);
    }
    expect(new Set(panels.map(panel => panel.id)).size).toBe(panels.length);
  });

  it('finds a full-width panel above two columns (non-uniform layout)', () => {
    const page = createRaster(400, 500, 255);
    drawPanel(page, 20, 20, 360, 220);
    drawPanel(page, 20, 260, 250, 220);
    drawPanel(page, 290, 260, 90, 220);
    expectBoxes(boxesOf(detectGutters(asImageData(page)), 400, 500),
      [[20, 20, 360, 220], [20, 260, 250, 220], [290, 260, 90, 220]], 2);
  });

  it('finds vertical strips', () => {
    const page = createRaster(500, 300, 255);
    drawPanel(page, 20, 20, 140, 260);
    drawPanel(page, 180, 20, 140, 260);
    drawPanel(page, 340, 20, 140, 260);
    expectBoxes(boxesOf(detectGutters(asImageData(page)), 500, 300), [[20, 20, 140, 260], [180, 20, 140, 260], [340, 20, 140, 260]], 2);
  });

  it('supports dark gutters between light panels', () => {
    const page = createRaster(400, 500, 0);
    drawPanel(page, 20, 20, 170, 220, { ink: 255, art: 120, border: 0 });
    drawPanel(page, 210, 20, 170, 220, { ink: 255, art: 120, border: 0 });
    drawPanel(page, 20, 260, 360, 220, { ink: 255, art: 120, border: 0 });
    const boxes = boxesOf(detectGutters(asImageData(page)), 400, 500);
    expectBoxes(boxes, [[20, 20, 170, 220], [210, 20, 170, 220], [20, 260, 360, 220]], 3);
  });

  it('tolerates narrow gutters (>= 0.8% of the page edge)', () => {
    const page = createRaster(500, 500, 255);
    drawPanel(page, 20, 20, 226, 460, { border: 2 });
    drawPanel(page, 254, 20, 226, 460, { border: 2 });
    expectBoxes(boxesOf(detectGutters(asImageData(page)), 500, 500), [[20, 20, 226, 460], [254, 20, 226, 460]], 2);
  });

  it('ignores stray dust in a gutter below the 1.8% tolerance', () => {
    const page = createRaster(400, 500, 255);
    drawPanel(page, 20, 20, 170, 460);
    drawPanel(page, 210, 20, 170, 460);
    const random = mulberry32(7);
    // 4 specks of the 460 px gutter height = 0.87% of the column.
    for (let i = 0; i < 4; i++) fillRect(page, 195 + Math.floor(random() * 10), 40 + Math.floor(random() * 400), 1, 1, 0);
    expect(detectGutters(asImageData(page))).toHaveLength(2);
  });

  it('does not split a panel on a hairline that is not a gutter', () => {
    const page = createRaster(400, 500, 255);
    drawPanel(page, 20, 20, 360, 460);
    fillRect(page, 200, 24, 1, 452, 255); // one-pixel bright seam, narrower than the 3 px minimum span
    expect(detectGutters(asImageData(page))).toHaveLength(1);
  });

  it('drops empty cells that carry no artwork', () => {
    const page = createRaster(400, 500, 255);
    drawPanel(page, 20, 20, 170, 460);
    fillRect(page, 210, 20, 170, 460, 0);
    fillRect(page, 214, 24, 162, 452, 250); // blank panel: flat near-white interior, no artwork
    const panels = detectGutters(asImageData(page));
    expect(panels).toHaveLength(1);
    expect(boxesOf(panels, 400, 500)[0][0]).toBeLessThan(100);
  });

  it('returns no panels for a blank white page', () => {
    expect(detectGutters(asImageData(createRaster(300, 300, 255)))).toEqual([]);
  });

  // Regression: a uniformly dark page used to yield a bogus centered panel (bounds 0.34..0.66).
  it('returns no panels for a solid black page', () => {
    expect(detectGutters(asImageData(createRaster(300, 300, 0)))).toEqual([]);
  });

  it('returns no panels for a full-bleed illustration without gutters', () => {
    const page = createRaster(400, 500, 140);
    expect(detectGutters(asImageData(page))).toEqual([]);
  });

  it('returns a single panel for an artwork with a thick page margin, with lower confidence than multi-panel', () => {
    const single = createRaster(400, 500, 255);
    drawPanel(single, 60, 60, 280, 380);
    const panels = detectGutters(asImageData(single));
    expect(panels).toHaveLength(1);
    expectBoxes(boxesOf(panels, 400, 500), [[60, 60, 280, 380]], 2);

    const multi = createRaster(400, 500, 255);
    drawPanel(multi, 20, 20, 170, 460);
    drawPanel(multi, 210, 20, 170, 460);
    const best = Math.min(...detectGutters(asImageData(multi)).map(panel => panel.confidence));
    expect(panels[0].confidence).toBeLessThan(best);
  });

  it('is deterministic: identical input gives identical output', () => {
    const page = createRaster(400, 500, 255);
    drawPanel(page, 20, 20, 170, 220);
    drawPanel(page, 210, 20, 170, 220);
    drawPanel(page, 20, 260, 360, 220);
    const first = detectGutters(asImageData(page));
    expect(detectGutters(asImageData(page))).toEqual(first);
    expect(detectGutters(asImageData({ ...page, data: new Uint8ClampedArray(page.data) }))).toEqual(first);
  });

  it('does not mutate the pixel buffer', () => {
    const page = createRaster(400, 500, 255);
    drawPanel(page, 20, 20, 170, 460);
    drawPanel(page, 210, 20, 170, 460);
    const before = new Uint8ClampedArray(page.data);
    detectGutters(asImageData(page));
    expect(page.data).toEqual(before);
  });
});

describe('detectGutters: checked-in page fixtures', () => {
  interface PanelTruth { id: string; bounds: [number, number, number, number]; click: [number, number] }
  interface PageTruth { panels: PanelTruth[]; outsidePanels: { position: string; click: [number, number] }[] }
  const oracle = JSON.parse(readFileSync(resolve(fixtures, 'expected-panels.json'), 'utf8')) as {
    imageSize: { width: number; height: number };
    pages: Record<string, PageTruth>;
    swapProbes: { click: [number, number]; pageA: string | null; pageB: string | null }[];
  };

  // The production detector downscales to <= 520k pixels before analysis (658 x 790 for these pages).
  const sizes: [number, number][] = [[1000, 1200], [658, 790]];

  for (const [file, truth] of Object.entries(oracle.pages)) {
    const source = decodePng(resolve(fixtures, file));

    it(`${file} decodes to the documented size`, () => {
      expect({ width: source.width, height: source.height }).toEqual(oracle.imageSize);
    });

    for (const [width, height] of sizes) {
      describe(`${file} at ${width} x ${height}`, () => {
        const image = width === source.width ? source : resizeNearest(source, width, height);
        const panels = detectGutters(asImageData(image));

        it('finds exactly the oracle panels within 0.02 per normalized edge', () => {
          expect(panels).toHaveLength(truth.panels.length);
          for (const expected of truth.panels) {
            const [x, y, w, h] = expected.bounds;
            const match = panels.find(panel => Math.abs(panel.bounds.x - x) <= 0.02 && Math.abs(panel.bounds.y - y) <= 0.02 &&
              Math.abs(panel.bounds.x + panel.bounds.width - (x + w)) <= 0.02 &&
              Math.abs(panel.bounds.y + panel.bounds.height - (y + h)) <= 0.02);
            expect(match, `no detected panel for ${expected.id}`).toBeDefined();
          }
        });

        it('hits the right panel for each bubble click', () => {
          for (const expected of truth.panels) {
            const hit = selectPanel({ x: expected.click[0], y: expected.click[1] }, panels);
            expect(hit, `click for ${expected.id}`).toBeDefined();
            const [x, y, w, h] = expected.bounds;
            expect(hit!.bounds.x).toBeCloseTo(x, 1);
            expect(hit!.bounds.y).toBeCloseTo(y, 1);
            expect(hit!.bounds.x + hit!.bounds.width).toBeCloseTo(x + w, 1);
            expect(hit!.bounds.y + hit!.bounds.height).toBeCloseTo(y + h, 1);
          }
        });

        it('misses on gutters and margins', () => {
          for (const outside of truth.outsidePanels) {
            expect(selectPanel({ x: outside.click[0], y: outside.click[1] }, panels), outside.position).toBeUndefined();
          }
        });
      });
    }
  }

  it('flips the cross-source swap probes between page A and page B', () => {
    const detect = (file: string) => detectGutters(asImageData(decodePng(resolve(fixtures, file))));
    const a = detect('page-a.png');
    const b = detect('page-b.png');
    for (const probe of oracle.swapProbes) {
      const point = { x: probe.click[0], y: probe.click[1] };
      expect(selectPanel(point, a) !== undefined, `A ${probe.click}`).toBe(probe.pageA !== null);
      expect(selectPanel(point, b) !== undefined, `B ${probe.click}`).toBe(probe.pageB !== null);
    }
  });
});
