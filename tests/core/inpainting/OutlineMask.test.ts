import { describe, expect, it } from 'vitest';
import type { Rect } from '../../../src/types/contracts';
import { buildLineMask } from '../../../src/core/inpainting/TextMask';
import { outlineMask } from '../../../src/core/inpainting/OutlineMask';

const width = 300, height = 120;
const line: Rect = { x: 20, y: 38, width: 250, height: 44 };

interface Options { background?: 'checker' | 'flat' | 'dots'; halo?: number; letters?: number; counter?: boolean; coreWidth?: number; coreHeight?: number; pitch?: number }

/** A synthetic caption: dark letter blocks inside a pale outline, printed over a screentone or a flat tone. */
function caption({ background = 'checker', halo = 5, letters = 8, counter = false, coreWidth = 14, coreHeight = 24, pitch = 28 }: Options = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const paint = (x: number, y: number, value: number) => data.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    paint(x, y, background === 'flat' ? 245 : background === 'dots' ? ((x % 6 < 2 && y % 6 < 2) ? 10 : 230) : [40, 150, 90, 170, 60][(x * 3 + y * 7) % 5]);
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = 255;
  const cores: Rect[] = [];
  for (let letter = 0; letter < letters; letter++) cores.push({ x: 30 + letter * pitch, y: 48, width: coreWidth, height: coreHeight });
  const near = (x: number, y: number, core: Rect, grow: number) =>
    x >= core.x - grow && x < core.x + core.width + grow && y >= core.y - grow && y < core.y + core.height + grow;
  if (halo > 0) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (cores.some(core => near(x, y, core, halo))) paint(x, y, 250);
  for (const core of cores) for (let y = core.y; y < core.y + core.height; y++) for (let x = core.x; x < core.x + core.width; x++) paint(x, y, 10);
  // The inside of a letter such as an O: an opening in the dark core, pale around its rim, with artwork in the middle.
  if (counter) for (let y = 56; y < 64; y++) for (let x = 37; x < 43; x++) paint(x, y, y > 57 && y < 62 && x > 38 && x < 42 ? 90 : 250);
  return { raster: { width, height, data } as unknown as ImageData, cores };
}

const covered = (mask: { bounds: Rect; mask: Uint8Array }, x: number, y: number) =>
  mask.mask[(y - mask.bounds.y) * mask.bounds.width + (x - mask.bounds.x)] === 1;

function share(mask: { bounds: Rect; mask: Uint8Array } | undefined, cells: [number, number][]): number {
  if (!mask) return 0;
  return cells.filter(([x, y]) => covered(mask, x, y)).length / Math.max(1, cells.length);
}

describe('outlined lettering mask', () => {
  it('covers each glyph core and the outline around it', () => {
    const { raster, cores } = caption();
    const mask = outlineMask(raster, line)!;
    expect(mask).toBeDefined();
    const core = cores.flatMap(box => [...Array(box.width * box.height).keys()].map((i): [number, number] => [box.x + i % box.width, box.y + Math.floor(i / box.width)]));
    expect(share(mask, core)).toBe(1);
    const ring = cores.flatMap(box => [[box.x - 3, box.y + 12], [box.x + box.width + 2, box.y + 12], [box.x + 7, box.y - 3], [box.x + 7, box.y + box.height + 2]] as [number, number][]);
    expect(share(mask, ring)).toBeGreaterThan(0.95);
  });

  it('leaves the artwork beyond the outline alone', () => {
    const { raster } = caption();
    const mask = outlineMask(raster, line)!;
    // The band between letters past their outlines, and the corners of the line box, are artwork.
    const far: [number, number][] = [[24, 40], [265, 80], [24, 80], [265, 40], [150, 40], [150, 80]];
    expect(share(mask, far)).toBe(0);
  });

  it('closes the pocket inside a letter', () => {
    const { raster } = caption({ counter: true });
    const mask = outlineMask(raster, line)!;
    expect(covered(mask, 40, 59)).toBe(true);
  });

  it('is the same for every inpainting mode up to the soft-edge margin, never smaller than the glyphs and outline', () => {
    const { raster, cores } = caption();
    const normal = outlineMask(raster, line, 'normal')!;
    const conservative = outlineMask(raster, line, 'conservative')!;
    const count = (mask: { mask: Uint8Array }) => mask.mask.reduce((sum, value) => sum + value, 0);
    expect(count(conservative)).toBeLessThanOrEqual(count(normal));
    expect(count(conservative)).toBeGreaterThan(cores.length * 14 * 24);
  });

  it('gives up without a pale outline around the letters', () => {
    expect(outlineMask(caption({ halo: 0 }).raster, line)).toBeUndefined();
  });

  it('gives up on fewer letters than a caption line has, and on screentone dots', () => {
    expect(outlineMask(caption({ letters: 2 }).raster, line)).toBeUndefined();
    expect(outlineMask(caption({ letters: 0, background: 'dots' }).raster, line)).toBeUndefined();
  });

  it('gives up on a line box that is too small to hold lettering', () => {
    expect(outlineMask(caption().raster, { x: 20, y: 40, width: 8, height: 8 })).toBeUndefined();
  });
});

describe('outline masks near the growth cap', () => {
  // Soft or recompressed prints grow the mask a little past a clean one. These fixtures stand for them: thin letters in
  // a wide halo, so the grown mask sits at or just over the cap of four times the glyph cores.
  const near = (options: Options) => caption({ coreWidth: 7, halo: 6, pitch: 30, ...options });
  const coreCells = (cores: Rect[]) => cores.flatMap(box => [...Array(box.width * box.height).keys()].map((i): [number, number] => [box.x + i % box.width, box.y + Math.floor(i / box.width)]));

  it('keeps a line whose outline completion only just reaches the cap', () => {
    const { raster, cores } = near({ coreHeight: 24 });
    for (const mode of ['normal', 'constrained', 'conservative'] as const) {
      const mask = outlineMask(raster, line, mode)!;
      expect(mask, mode).toBeDefined();
      expect(share(mask, coreCells(cores)), mode).toBe(1);
    }
  });

  it('retries a base mask a few percent over the cap with its outermost growth dropped', () => {
    const { raster, cores } = near({ coreHeight: 22 });
    for (const mode of ['normal', 'constrained', 'conservative'] as const) {
      const mask = outlineMask(raster, line, mode)!;
      expect(mask, mode).toBeDefined();
      expect(share(mask, coreCells(cores)), mode).toBe(1);
      // The artwork between the letters and the corners of the box stay untouched.
      expect(share(mask, [[20, 36], [268, 84], [20, 84], [268, 36], [150, 36], [150, 84]]), mode).toBe(0);
    }
    const thin = caption({ coreWidth: 8, coreHeight: 18, halo: 6, pitch: 30 });
    expect(outlineMask(thin.raster, line, 'conservative')).toBeDefined();
  });

  it('still rejects a base mask well over the cap, where the outline has leaked into the artwork', () => {
    expect(outlineMask(caption({ coreWidth: 8, coreHeight: 24, halo: 7, pitch: 30 }).raster, line)).toBeUndefined();
    expect(outlineMask(caption({ coreWidth: 6, coreHeight: 24, halo: 6 }).raster, line)).toBeUndefined();
    expect(outlineMask(near({ coreHeight: 24, halo: 7 }).raster, line)).toBeUndefined();
  });

  it('keeps the other gates on a near-cap line: no outline, too few letters', () => {
    expect(outlineMask(near({ halo: 0 }).raster, line)).toBeUndefined();
    expect(outlineMask(near({ letters: 2 }).raster, line)).toBeUndefined();
  });
});

describe('line mask choice', () => {
  it('uses the outline mask outside a balloon on a textured background, so the pale outline does not stay behind', () => {
    const { raster } = caption();
    const mask = buildLineMask(raster, line, 'conservative')!;
    expect(mask).toBeDefined();
    expect(share(mask, [[27, 60], [25, 60], [44 + 3, 60], [37, 45], [37, 75]])).toBeGreaterThan(0.7);
  });

  it('does not use it inside a balloon contour, where the ink mask and the contour decide', () => {
    const { raster } = caption();
    const contour = [{ x: 15, y: 30 }, { x: 280, y: 30 }, { x: 280, y: 95 }, { x: 15, y: 95 }];
    // A glyph core is dark. Only the outline mask takes it in; the ink mask of a balloon takes in the pale pixels.
    const core: [number, number][] = [[36, 60], [64, 60], [92, 60]];
    expect(share(buildLineMask(raster, line, 'normal'), core)).toBe(1);
    expect(share(buildLineMask(raster, line, 'normal', contour), core)).toBe(0);
  });

  it('keeps the ordinary ink mask for dark text on a flat tone', () => {
    const { raster } = caption({ background: 'flat', halo: 0 });
    const mask = buildLineMask(raster, line, 'normal')!;
    expect(mask).toBeDefined();
    // Nothing outside the glyphs and a small margin around them.
    expect(share(mask, [[24, 40], [265, 80], [150, 40]])).toBe(0);
  });
});
