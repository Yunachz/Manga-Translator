import { expect, it } from 'vitest';
import { isolateBubbleLayouts } from '../../../src/core/detection/BubbleLayout';
import { rectPolygon } from '../../../src/core/image/geometry';
import type { Rect } from '../../../src/types/contracts';

function group(id: string, bounds: Rect, text: Rect) {
  return { bubble: { id, bounds, lines: [{ bounds: text, polygon: rectPolygon(text) }] } };
}

it('keeps the staggered dialogue in two separate placement boxes even when OCR padding crosses the seam', () => {
  const left = group('left', { x: 277, y: 832, width: 147, height: 139 }, { x: 270, y: 850, width: 94, height: 115 });
  const right = group('right', { x: 356, y: 840, width: 87, height: 54 }, { x: 362, y: 844, width: 75, height: 46 });

  isolateBubbleLayouts([right, left]);

  expect(left.bubble.bounds.x + left.bubble.bounds.width).toBeLessThanOrEqual(right.bubble.bounds.x);
  expect(left.bubble.bounds.width).toBeGreaterThan(75);
  expect(right.bubble.bounds.width).toBeGreaterThan(75);
  expect(left.bubble.lines[0].bounds.width).toBe(94);
  expect(right.bubble.lines[0].bounds.width).toBe(75);
});

it('separates stacked boxes on the vertical axis and leaves other boxes alone', () => {
  const top = group('top', { x: 15, y: 10, width: 90, height: 70 }, { x: 35, y: 20, width: 50, height: 18 });
  const bottom = group('bottom', { x: 10, y: 60, width: 105, height: 80 }, { x: 30, y: 90, width: 60, height: 22 });
  const otherBounds = { x: 150, y: 15, width: 45, height: 55 };
  const other = group('other', { ...otherBounds }, otherBounds);

  isolateBubbleLayouts([top, bottom, other]);

  expect(top.bubble.bounds.y + top.bubble.bounds.height).toBeLessThanOrEqual(bottom.bubble.bounds.y);
  expect(other.bubble.bounds).toEqual(otherBounds);
});
