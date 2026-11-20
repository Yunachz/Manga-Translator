import type { PanelRegion, Point, Rect } from '../../types/contracts';
import { clamp } from './geometry';

/** A point of the whole surface, in the normalized coordinates of a crop of it. Callers keep the point inside the crop. */
export function pointInCrop(point: Point, crop: Rect): Point {
  return { x: clamp((point.x - crop.x) / crop.width), y: clamp((point.y - crop.y) / crop.height) };
}

/** A point of the crop, back in normalized coordinates of the whole surface. */
export function pointFromCrop(point: Point, crop: Rect): Point {
  return { x: crop.x + point.x * crop.width, y: crop.y + point.y * crop.height };
}

/** The rectangle of a crop (normalized to the crop) in normalized coordinates of the whole surface. */
export function rectFromCrop(rect: Rect, crop: Rect): Rect {
  return { x: crop.x + rect.x * crop.width, y: crop.y + rect.y * crop.height, width: rect.width * crop.width, height: rect.height * crop.height };
}

/** A panel detected inside a visible crop, placed on the whole surface so the patch and the highlight line up with it. */
export function panelFromCrop(panel: PanelRegion, crop: Rect): PanelRegion {
  return { ...panel, bounds: rectFromCrop(panel.bounds, crop), polygon: panel.polygon.map(point => pointFromCrop(point, crop)) };
}
