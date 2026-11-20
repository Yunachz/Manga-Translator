import { describe, expect, it } from 'vitest';
import { clamp, cropBounds, normalizedSelection, pointInPolygon, rectPolygon, selectPanel } from '../../../src/core/image/geometry';
import type { PanelRegion, Point, Rect } from '../../../src/types/contracts';

function panel(id: string, bounds: Rect, confidence = 0.9, polygon: Point[] = rectPolygon(bounds)): PanelRegion {
  return { id, bounds, polygon, confidence };
}

describe('clamp', () => {
  it('limits to [0, 1] by default', () => {
    expect(clamp(-0.5)).toBe(0);
    expect(clamp(0.25)).toBe(0.25);
    expect(clamp(7)).toBe(1);
  });

  it('honours explicit bounds and keeps the bounds themselves', () => {
    expect(clamp(5, 2, 4)).toBe(4);
    expect(clamp(2, 2, 4)).toBe(2);
    expect(clamp(4, 2, 4)).toBe(4);
    expect(clamp(-1, -3, -2)).toBe(-2);
  });
});

describe('rectPolygon', () => {
  it('returns corners clockwise from top-left', () => {
    expect(rectPolygon({ x: 1, y: 2, width: 3, height: 4 })).toEqual([
      { x: 1, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 6 }, { x: 1, y: 6 },
    ]);
  });

  it('keeps a degenerate rect as four coincident-edge points', () => {
    expect(rectPolygon({ x: 0.5, y: 0.5, width: 0, height: 0 })).toHaveLength(4);
  });
});

describe('pointInPolygon', () => {
  const square = rectPolygon({ x: 0, y: 0, width: 1, height: 1 });

  it('accepts interior points and rejects exterior points', () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 1.0001, y: 0.5 }, square)).toBe(false);
    expect(pointInPolygon({ x: -0.0001, y: 0.5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 0.5, y: 2 }, square)).toBe(false);
  });

  it('treats edges and vertices as inside', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, square)).toBe(true);
    expect(pointInPolygon({ x: 1, y: 1 }, square)).toBe(true);
    expect(pointInPolygon({ x: 0.5, y: 0 }, square)).toBe(true);
    expect(pointInPolygon({ x: 1, y: 0.25 }, square)).toBe(true);
  });

  it('handles concave polygons', () => {
    // L shape: the top-right quadrant is missing.
    const ell: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
    expect(pointInPolygon({ x: 0.5, y: 1.5 }, ell)).toBe(true);
    expect(pointInPolygon({ x: 1.5, y: 1.5 }, ell)).toBe(true);
    expect(pointInPolygon({ x: 1.5, y: 0.5 }, ell)).toBe(false);
  });

  it('handles non-axis-aligned polygons', () => {
    const diamond: Point[] = [{ x: 1, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 1 }];
    expect(pointInPolygon({ x: 1, y: 1 }, diamond)).toBe(true);
    expect(pointInPolygon({ x: 0.1, y: 0.1 }, diamond)).toBe(false);
    expect(pointInPolygon({ x: 1.5, y: 0.5 }, diamond)).toBe(true); // on an edge
  });

  it('is false for fewer than three points of area', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [])).toBe(false);
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, [{ x: 0, y: 0 }])).toBe(false);
  });
});

describe('selectPanel', () => {
  const left = panel('left', { x: 0, y: 0, width: 0.5, height: 1 });
  const right = panel('right', { x: 0.5, y: 0, width: 0.5, height: 1 });

  it('returns the panel under the point', () => {
    expect(selectPanel({ x: 0.25, y: 0.5 }, [left, right])?.id).toBe('left');
    expect(selectPanel({ x: 0.75, y: 0.5 }, [left, right])?.id).toBe('right');
  });

  it('returns undefined when nothing contains the point (gutter or margin)', () => {
    const a = panel('a', { x: 0.06, y: 0.05, width: 0.42, height: 0.4 });
    const b = panel('b', { x: 0.52, y: 0.05, width: 0.42, height: 0.4 });
    expect(selectPanel({ x: 0.5, y: 0.25 }, [a, b])).toBeUndefined();
    expect(selectPanel({ x: 0.03, y: 0.25 }, [a, b])).toBeUndefined();
    expect(selectPanel({ x: 0.5, y: 0.25 }, [])).toBeUndefined();
  });

  it('prefers higher confidence when panels overlap', () => {
    const big = panel('big', { x: 0, y: 0, width: 1, height: 1 }, 0.6);
    const small = panel('small', { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, 0.9);
    expect(selectPanel({ x: 0.5, y: 0.5 }, [big, small])?.id).toBe('small');
    expect(selectPanel({ x: 0.5, y: 0.5 }, [small, big])?.id).toBe('small');
  });

  it('breaks confidence ties with the smaller area, whatever the input order', () => {
    const big = panel('big', { x: 0, y: 0, width: 1, height: 1 }, 0.8);
    const small = panel('small', { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, 0.8);
    expect(selectPanel({ x: 0.5, y: 0.5 }, [big, small])?.id).toBe('small');
    expect(selectPanel({ x: 0.5, y: 0.5 }, [small, big])?.id).toBe('small');
  });

  it('does not reorder or mutate the caller array', () => {
    const panels = [panel('x', { x: 0, y: 0, width: 1, height: 1 }, 0.1), panel('y', { x: 0, y: 0, width: 1, height: 1 }, 0.9)];
    selectPanel({ x: 0.5, y: 0.5 }, panels);
    expect(panels.map(p => p.id)).toEqual(['x', 'y']);
  });

  it('hit-tests the polygon, not the bounding box', () => {
    const triangle = panel('tri', { x: 0, y: 0, width: 1, height: 1 }, 0.9, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]);
    expect(selectPanel({ x: 0.2, y: 0.2 }, [triangle])?.id).toBe('tri');
    expect(selectPanel({ x: 0.9, y: 0.9 }, [triangle])).toBeUndefined();
  });
});

describe('normalizedSelection', () => {
  it('orders corners regardless of drag direction', () => {
    const expected = { x: 0.2, y: 0.1, width: 0.3, height: 0.4 };
    const a = { x: 0.2, y: 0.1 };
    const b = { x: 0.5, y: 0.5 };
    expect(normalizedSelection(a, b)).toEqual(expected);
    expect(normalizedSelection(b, a)).toEqual(expected);
    const c = normalizedSelection({ x: 0.5, y: 0.1 }, { x: 0.2, y: 0.5 });
    expect(c.x).toBe(0.2);
    expect(c.y).toBe(0.1);
    expect(c.width).toBeCloseTo(0.3, 12);
    expect(c.height).toBeCloseTo(0.4, 12);
  });

  it('gives a zero-area rect for a click without drag', () => {
    expect(normalizedSelection({ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 })).toEqual({ x: 0.3, y: 0.3, width: 0, height: 0 });
  });
});

describe('cropBounds', () => {
  it('maps the whole image to the full pixel rect', () => {
    expect(cropBounds({ x: 0, y: 0, width: 1, height: 1 }, 1000, 1200)).toEqual({ x: 0, y: 0, width: 1000, height: 1200 });
  });

  it('floors the origin and ceils the far edge so the crop never loses pixels', () => {
    // x: 0.15 * 10 = 1.5 -> 1; right: 0.45 * 10 = 4.5 -> 5
    expect(cropBounds({ x: 0.15, y: 0.15, width: 0.3, height: 0.3 }, 10, 10)).toEqual({ x: 1, y: 1, width: 4, height: 4 });
  });

  it('maps the oracle panel bounds to exact pixel boxes on the 1000 x 1200 fixtures', () => {
    expect(cropBounds({ x: 0.52, y: 0.05, width: 0.42, height: 0.4 }, 1000, 1200)).toEqual({ x: 520, y: 60, width: 420, height: 480 });
    expect(cropBounds({ x: 0.06, y: 0.5, width: 0.5, height: 0.45 }, 1000, 1200)).toEqual({ x: 60, y: 600, width: 500, height: 540 });
  });

  it('never returns an empty crop', () => {
    expect(cropBounds({ x: 0.5, y: 0.5, width: 0, height: 0 }, 100, 100)).toEqual({ x: 50, y: 50, width: 1, height: 1 });
  });

  it('clamps regions that spill outside the image', () => {
    expect(cropBounds({ x: -0.2, y: -0.2, width: 0.5, height: 0.5 }, 100, 100)).toEqual({ x: 0, y: 0, width: 30, height: 30 });
    expect(cropBounds({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 100, 100)).toEqual({ x: 90, y: 90, width: 10, height: 10 });
  });

  it('keeps a one-pixel crop for a region entirely beyond the right or bottom edge', () => {
    expect(cropBounds({ x: 1.5, y: 1.5, width: 0.2, height: 0.2 }, 100, 80)).toEqual({ x: 99, y: 79, width: 1, height: 1 });
  });

  it('stays inside the image for every x on a small grid', () => {
    for (let i = 0; i <= 20; i++) {
      const crop = cropBounds({ x: i / 20, y: 0, width: 0.1, height: 1 }, 7, 5);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(7);
      expect(crop.width).toBeGreaterThanOrEqual(1);
    }
  });
});
