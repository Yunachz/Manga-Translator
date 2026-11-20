import type { Rect } from '../../types/contracts';
import { toViewport, type ImageGeometry } from './CoordinateMapper';

function contains(outer: Rect, inner: Rect): boolean {
  const tolerance = 0.01;
  return outer.width > 0 && outer.height > 0 && inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

export function visibleArea(selection: Rect, geometry: ImageGeometry, viewport: Rect): Rect | undefined {
  const area = toViewport(selection, geometry.object);
  if (area.width < 18 || area.height < 18 || !contains(geometry.clip, area) || !contains(viewport, area)) return;
  return toNormalizedViewport(area, viewport);
}

function toNormalizedViewport(area: Rect, viewport: Rect): Rect {
  const x = Math.max(0, (area.x - viewport.x) / viewport.width);
  const y = Math.max(0, (area.y - viewport.y) / viewport.height);
  return { x, y, width: Math.min(1 - x, area.width / viewport.width), height: Math.min(1 - y, area.height / viewport.height) };
}
