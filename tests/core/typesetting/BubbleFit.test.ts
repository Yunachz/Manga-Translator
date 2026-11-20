import { describe, expect, it } from 'vitest';
import { detectBubbles } from '../../../src/core/detection/BubbleDetector';
import { isolateBubbleLayouts } from '../../../src/core/detection/BubbleLayout';
import { pointInPolygon, rectPolygon } from '../../../src/core/image/geometry';
import { planBubbleText, sizeCeiling, type BubblePlan } from '../../../src/core/typesetting/BubbleFit';
import type { BubbleRegion, OCRResult, Point, Rect } from '../../../src/types/contracts';

const measureAt = (size: number) => (value: string) => value.length * size * 0.55;
const options = { lineHeight: 1.17, padding: 0.09 };

function ellipse(cx: number, cy: number, rx: number, ry: number, count = 48): Point[] {
  return Array.from({ length: count }, (_, i) => ({ x: cx + rx * Math.cos(i / count * 2 * Math.PI), y: cy + ry * Math.sin(i / count * 2 * Math.PI) }));
}

function bubble(bounds: Rect, extra: Partial<BubbleRegion> = {}): BubbleRegion {
  return { id: 'b', bounds, lines: [], ...extra };
}

/** Every wrapped line, as drawn, must lie inside the polygon. */
function linesInside(plan: BubblePlan, shape: Point[], measure: (value: string) => number): boolean {
  return plan.lines.every((line, index) => {
    const y = plan.center.y + (index - (plan.lines.length - 1) / 2) * plan.lineHeight;
    const half = measure(line) / 2, glyph = plan.size / 2;
    return [[-half, -glyph], [half, -glyph], [-half, glyph], [half, glyph], [0, 0]]
      .every(([dx, dy]) => pointInPolygon({ x: plan.center.x + dx, y: y + dy }, shape));
  });
}

describe('planBubbleText', () => {
  it('places translated glyphs outside the bounds of a source line kept in the same bubble', () => {
    const plan = planBubbleText(bubble({ x: 0, y: 0, width: 110, height: 96 }), 'Baris baru', measureAt,
      { ...options, reserved: [{ x: 0, y: 38, width: 110, height: 20 }] })!;
    expect(plan.center.y + plan.size / 2).toBeLessThan(38);
  });
  it('keeps bounds-only bubbles on a centred layout inside their rectangle', () => {
    const plan = planBubbleText(bubble({ x: 10, y: 45, width: 120, height: 120 }), 'Kami main basket.', measureAt, options)!;
    expect(plan.center).toEqual({ x: 70, y: 105 });
    expect(plan.size).toBeGreaterThan(8);
  });

  it('places every line inside a curved outline, where the bounding rectangle would overflow', () => {
    const shape = ellipse(100, 100, 40, 60);
    const bounds = { x: 60, y: 40, width: 80, height: 120 };
    const text = 'Itu benar-benar hebat untukmu sekali, sungguh luar biasa bagimu.';
    const plan = planBubbleText(bubble(bounds, { shape, enclosed: true }), text, measureAt, options)!;
    expect(plan).toBeDefined();
    expect(linesInside(plan, shape, measureAt(plan.size))).toBe(true);
    const rectangular = planBubbleText(bubble(bounds), text, measureAt, options)!;
    expect(rectangular.size).toBeGreaterThanOrEqual(plan.size);
    expect(linesInside(rectangular, shape, measureAt(rectangular.size))).toBe(false);
  });

  it('returns nothing when the text cannot fit even at the minimum size', () => {
    const shape = ellipse(30, 30, 18, 14);
    expect(planBubbleText(bubble({ x: 12, y: 16, width: 36, height: 28 }, { shape, enclosed: true }),
      'Terjemahan yang sangat panjang sekali untuk ruang sekecil ini', measureAt, options)).toBeUndefined();
  });

  it('keeps the words of a narrow Indonesian bubble whole using a slightly narrower layout', () => {
    const shape = ellipse(50, 65, 32, 54);
    const bounds = { x: 18, y: 11, width: 64, height: 108 };
    const plan = planBubbleText(bubble(bounds, { shape, enclosed: true, textSize: 24 }),
      'Ini pertarungan serius!', measureAt, options)!;
    expect(plan.lines).toEqual(['Ini', 'pertarungan', 'serius!']);
    expect(plan.size).toBeGreaterThanOrEqual(9);
    expect(plan.scaleX).toBeGreaterThanOrEqual(0.86);
    expect(linesInside(plan, shape, text => measureAt(plan.size)(text) * plan.scaleX)).toBe(true);
  });

  it('does not exceed the size of the original text, so small areas never get giant type', () => {
    const lines = [{ bounds: { x: 100, y: 100, width: 60, height: 20 }, polygon: [] }];
    const roomy = bubble({ x: 0, y: 0, width: 400, height: 400 }, { lines, textSize: 20 });
    expect(sizeCeiling(roomy)).toBe(22);
    expect(planBubbleText(roomy, 'Hai', measureAt, options)!.size).toBeLessThanOrEqual(22);
    expect(sizeCeiling(bubble({ x: 0, y: 0, width: 400, height: 400 }, { lines }))).toBe(22);
    expect(sizeCeiling(bubble({ x: 0, y: 0, width: 4, height: 4 }))).toBe(64);
  });

  it('keeps unenclosed text near the OCR text instead of the middle of its box', () => {
    const lines = [{ bounds: { x: 20, y: 20, width: 50, height: 16 }, polygon: rectPolygon({ x: 20, y: 20, width: 50, height: 16 }) }];
    const plan = planBubbleText(bubble({ x: 0, y: 0, width: 200, height: 160 }, { lines, enclosed: false, textSize: 16 }), 'Sip', measureAt, options)!;
    expect(plan.center).toEqual({ x: 45, y: 28 });
    expect(plan.size).toBeLessThanOrEqual(18);
  });
});

describe('detected lobes', () => {
  const width = 300, height = 260;
  const light = ([x, y]: [number, number], balloons: [number, number, number, number][]) =>
    balloons.some(([cx, cy, rx, ry]) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1);
  function raster(balloons: [number, number, number, number][]): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.fill(light([x, y], balloons) ? 255 : 35, (y * width + x) * 4, (y * width + x) * 4 + 4);
    return { width, height, data } as ImageData;
  }
  const row = (id: string, x: number, y: number, w: number): OCRResult => ({ id, text: id, bounds: { x, y, width: w, height: 14 }, vertical: false, confidence: 1 });

  it('gives a small side lobe its own outline and fits translated text inside it', () => {
    const balloons: [number, number, number, number][] = [[75, 130, 45, 85], [185, 110, 62, 90]];
    const groups = isolateBubbleLayouts(detectBubbles(raster(balloons), [
      row('A1', 50, 105, 52), row('A2', 46, 124, 60), row('A3', 52, 143, 48),
      row('B1', 150, 80, 66), row('B2', 144, 100, 78), row('B3', 150, 120, 66), row('B4', 152, 140, 62)]))
      .sort((a, b) => a.bubble.bounds.x - b.bubble.bounds.x);
    expect(groups.map(group => group.recognized.map(item => item.id[0]).join(''))).toEqual(['AAA', 'BBBB']);
    const [small, large] = groups.map(group => group.bubble);
    expect(small.id).not.toBe(large.id);
    expect(small.enclosed).toBe(true);
    expect(small.textSize).toBe(14);
    expect(small.shape!.length).toBeGreaterThan(8);
    expect(small.bounds.x + small.bounds.width).toBeLessThan(large.bounds.x);
    // the outline follows the balloon: its corners are not part of the area
    const corner = { x: small.bounds.x + 1, y: small.bounds.y + 1 };
    expect(pointInPolygon(corner, small.shape!)).toBe(false);
    // bigger than the old inset rectangle gave room for
    const ratio = (small.bounds.width * small.bounds.height) / (90 * 170 * 0.76 * 0.74);
    expect(ratio).toBeGreaterThan(1.2);
    const plan = planBubbleText(small, 'Ini pertarungan serius!', measureAt, options)!;
    expect(plan.size).toBeGreaterThanOrEqual(10);
    expect(plan.size).toBeLessThanOrEqual(15);
    expect(linesInside(plan, small.shape!, measureAt(plan.size))).toBe(true);
  });

  it('marks text that has no balloon as unenclosed and without an outline', () => {
    const groups = detectBubbles(raster([]), [row('F1', 100, 100, 60), row('F2', 104, 118, 52)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].bubble.enclosed).toBe(false);
    expect(groups[0].bubble.shape).toBeUndefined();
    expect(groups[0].bubble.textSize).toBe(14);
  });
});
