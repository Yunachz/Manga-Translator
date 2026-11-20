import type { Point, Rect, RenderedPatch } from '../../types/contracts';
import { pointInPolygon, rectPolygon } from './geometry';

function inImage(patch: RenderedPatch, regions: Rect[]): Rect[] {
  const panel = patch.panel.bounds;
  return regions.map(rect => ({
    x: panel.x + rect.x * panel.width,
    y: panel.y + rect.y * panel.height,
    width: rect.width * panel.width,
    height: rect.height * panel.height,
  }));
}

export function translatedPolygons(patch: RenderedPatch): Point[][] {
  if (!patch.coverage) return patch.skippedBubbles ? [] : [patch.panel.polygon];
  return inImage(patch, patch.coverage).map(rectPolygon);
}

export function paintedRegions(patch: RenderedPatch): Rect[] {
  return patch.coverage ? inImage(patch, patch.coverage) : [];
}

export function cropRegions(regions: readonly Rect[], crop: Rect): Rect[] {
  return regions.flatMap(region => {
    const x = Math.max(region.x, crop.x), y = Math.max(region.y, crop.y);
    const right = Math.min(region.x + region.width, crop.x + crop.width);
    const bottom = Math.min(region.y + region.height, crop.y + crop.height);
    return right > x && bottom > y ? [{ x: (x - crop.x) / crop.width, y: (y - crop.y) / crop.height,
      width: (right - x) / crop.width, height: (bottom - y) / crop.height }] : [];
  });
}

export function coversLine(regions: readonly Rect[], line: Rect): boolean {
  return regions.some(region => {
    const width = Math.min(line.x + line.width, region.x + region.width) - Math.max(line.x, region.x);
    const height = Math.min(line.y + line.height, region.y + region.height) - Math.max(line.y, region.y);
    return width > 0 && height > 0 && width * height >= line.width * line.height * 0.65;
  });
}

/** Keep hit testing and the protected OCR regions in sync with holes in the bitmap. */
export function subtractCoverage(regions: readonly Rect[], omitted: readonly Rect[]): Rect[] {
  let remaining = [...regions];
  for (const hole of omitted) {
    remaining = remaining.flatMap(rect => {
      const right = rect.x + rect.width, bottom = rect.y + rect.height;
      const x0 = Math.max(rect.x, hole.x), x1 = Math.min(right, hole.x + hole.width);
      const y0 = Math.max(rect.y, hole.y), y1 = Math.min(bottom, hole.y + hole.height);
      if (x0 >= x1 || y0 >= y1) return [rect];
      return [
        { x: rect.x, y: rect.y, width: rect.width, height: y0 - rect.y },
        { x: rect.x, y: y1, width: rect.width, height: bottom - y1 },
        { x: rect.x, y: y0, width: x0 - rect.x, height: y1 - y0 },
        { x: x1, y: y0, width: right - x1, height: y1 - y0 },
      ].filter(part => part.width > 0 && part.height > 0);
    });
  }
  return remaining;
}

/** Locate a known unfinished bubble. Sparse chapter patches say nothing about the rest of the page. */
export function unfinishedRegion(patches: Iterable<RenderedPatch>, point: Point): Rect | undefined {
  for (const patch of patches) {
    if (!pointInPolygon(point, patch.panel.polygon)) continue;
    const remaining = inImage(patch, patch.remaining ?? []).find(rect =>
      point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height);
    if (remaining) return remaining;
  }
}
