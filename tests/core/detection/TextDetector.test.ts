import { describe, expect, it } from 'vitest';
import { dbRegions } from '../../../src/core/detection/TextDetector';

/** Probability map with filled rectangles. */
function map(width: number, height: number, boxes: { x: number; y: number; w: number; h: number; p?: number }[]): Float32Array {
  const data = new Float32Array(width * height);
  for (const { x, y, w, h, p = 0.9 } of boxes) {
    for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) data[row * width + column] = p;
  }
  return data;
}

const area = { x: 0, y: 0, width: 200, height: 100 }; // 2x horizontal and vertical scale for a 100 x 50 map

describe('dbRegions', () => {
  it('returns nothing for an empty map', () => {
    expect(dbRegions(new Float32Array(100 * 50), 100, 50, area)).toEqual([]);
  });

  it('finds one rectangle and maps it into the crop area with padding', () => {
    const [region, ...rest] = dbRegions(map(100, 50, [{ x: 20, y: 10, w: 40, h: 10 }]), 100, 50, area);
    expect(rest).toEqual([]);
    const { bounds, polygon } = region;
    // The box covers [20, 60) x [10, 20) in map pixels; padding is positive, so the region must contain it.
    expect(bounds.x).toBeLessThan(20 * 2);
    expect(bounds.y).toBeLessThan(10 * 2);
    expect(bounds.x + bounds.width).toBeGreaterThan(60 * 2);
    expect(bounds.y + bounds.height).toBeGreaterThan(20 * 2);
    expect(polygon).toHaveLength(4);
  });

  it('offsets and scales into a tile that does not start at the origin', () => {
    const tile = { x: 500, y: 300, width: 200, height: 100 };
    const [region] = dbRegions(map(100, 50, [{ x: 20, y: 10, w: 40, h: 10 }]), 100, 50, tile);
    expect(region.bounds.x).toBeGreaterThan(500);
    expect(region.bounds.y).toBeGreaterThan(300);
    expect(region.bounds.x + region.bounds.width).toBeLessThan(700);
    expect(region.bounds.y + region.bounds.height).toBeLessThan(400);
  });

  it('keeps regions inside the tile when the text touches the border', () => {
    const [region] = dbRegions(map(100, 50, [{ x: 0, y: 0, w: 100, h: 8 }]), 100, 50, area);
    expect(region.bounds.x).toBeGreaterThanOrEqual(0);
    expect(region.bounds.y).toBeGreaterThanOrEqual(0);
    expect(region.bounds.x + region.bounds.width).toBeLessThanOrEqual(200 + 1e-9);
    expect(region.bounds.y + region.bounds.height).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('separates distant components and keeps them apart', () => {
    const regions = dbRegions(map(100, 50, [{ x: 5, y: 5, w: 30, h: 8 }, { x: 50, y: 30, w: 30, h: 8 }]), 100, 50, area);
    expect(regions).toHaveLength(2);
  });

  it('applies the 0.3 pixel threshold and the 0.54 mean score gate', () => {
    expect(dbRegions(map(100, 50, [{ x: 10, y: 10, w: 30, h: 8, p: 0.29 }]), 100, 50, area)).toEqual([]);
    expect(dbRegions(map(100, 50, [{ x: 10, y: 10, w: 30, h: 8, p: 0.5 }]), 100, 50, area)).toEqual([]);
    expect(dbRegions(map(100, 50, [{ x: 10, y: 10, w: 30, h: 8, p: 0.6 }]), 100, 50, area)).toHaveLength(1);
  });

  it('drops specks (< 7 pixels) and slivers thinner than 3 pixels', () => {
    expect(dbRegions(map(100, 50, [{ x: 10, y: 10, w: 2, h: 3 }]), 100, 50, area)).toEqual([]);
    expect(dbRegions(map(100, 50, [{ x: 10, y: 10, w: 40, h: 2 }]), 100, 50, area)).toEqual([]);
    expect(dbRegions(map(100, 50, [{ x: 10, y: 10, w: 40, h: 3 }]), 100, 50, area)).toHaveLength(1);
  });

  it('does not join diagonal-only neighbours (4-connectivity)', () => {
    const data = map(100, 50, [{ x: 10, y: 10, w: 10, h: 4 }, { x: 20, y: 14, w: 10, h: 4 }]);
    expect(dbRegions(data, 100, 50, area)).toHaveLength(2);
  });

  it('caps the output at 120 regions', () => {
    const boxes = [];
    for (let row = 0; row < 14; row++) for (let column = 0; column < 14; column++) boxes.push({ x: column * 14 + 1, y: row * 14 + 1, w: 6, h: 6 });
    const regions = dbRegions(map(200, 200, boxes), 200, 200, { x: 0, y: 0, width: 200, height: 200 });
    expect(regions).toHaveLength(120);
  });

  it('is deterministic and does not mutate the map', () => {
    const data = map(100, 50, [{ x: 20, y: 10, w: 40, h: 10 }]);
    const before = new Float32Array(data);
    expect(dbRegions(data, 100, 50, area)).toEqual(dbRegions(data, 100, 50, area));
    expect(data).toEqual(before);
  });
});
