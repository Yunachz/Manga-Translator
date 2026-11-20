import { describe, expect, it } from 'vitest';
import { rectPolygon } from '../../../src/core/image/geometry';
import { coversLine, cropRegions, subtractCoverage, translatedPolygons, unfinishedRegion } from '../../../src/core/image/translatedCoverage';
import type { RenderedPatch } from '../../../src/types/contracts';

describe('translation hit areas', () => {
  const bounds = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  const region = { x: 0.25, y: 0.25, width: 0.25, height: 0.5 };
  const patch: RenderedPatch = {
    panel: { id: 'panel', bounds, polygon: rectPolygon(bounds), confidence: 1 },
    width: 100, height: 100, dataUrl: '', coverage: [region], remaining: [{ ...region, x: 0.5 }], skippedBubbles: 1,
  };

  it('projects sparse pixels without classifying any other point as translated', () => {
    expect(translatedPolygons(patch)).toEqual([rectPolygon({ x: 0.375, y: 0.375, width: 0.125, height: 0.25 })]);
    expect(unfinishedRegion([patch], { x: 0.66, y: 0.68 })).toBeUndefined();
    expect(unfinishedRegion([patch], { x: 0.8, y: 0.68 })).toBeUndefined();
  });

  it('selects only the known unfinished bubble inside a partial patch', () => {
    expect(unfinishedRegion([patch], { x: 0.55, y: 0.45 })).toEqual({
      x: 0.5, y: 0.375, width: 0.125, height: 0.25,
    });
  });

  it('maps protected pixels into the full crop and keeps nearby text actionable', () => {
    const protectedRegions = cropRegions([{ x: 0.125, y: 0.375, width: 0.25, height: 0.25 }], bounds);
    expect(protectedRegions).toEqual([{ x: 0, y: 0.25, width: 0.25, height: 0.5 }]);
    expect(coversLine(protectedRegions, { x: 0.1, y: 0.3, width: 0.15, height: 0.1 })).toBe(true);
    expect(coversLine(protectedRegions, { x: 0.2, y: 0.3, width: 0.4, height: 0.1 })).toBe(false);
  });

  it('keeps an unread line outside translated hit coverage even when the bitmap spans it', () => {
    const whole = { x: 0, y: 0, width: 100, height: 100 };
    const unread = { x: 20, y: 40, width: 60, height: 15 };
    const coverage = subtractCoverage([whole], [unread]);
    expect(coverage.reduce((total, rect) => total + rect.width * rect.height, 0)).toBe(9100);
    expect(coversLine(coverage, unread)).toBe(false);
  });
});
