import type { PanelRegion, Point, Rect } from '../../types/contracts';

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function rectPolygon(rect: Rect): Point[] {
  const { x, y, width, height } = rect;
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}

/** Sorted x crossings at a horizontal scan line. Each pair bounds a polygon interior span. */
export function polygonCrossings(polygon: Point[], y: number): number[] {
  const crossings: number[] = [];
  let previous = polygon[polygon.length - 1];
  for (const point of polygon) {
    if ((previous.y > y) !== (point.y > y)) {
      crossings.push(previous.x + (y - previous.y) / (point.y - previous.y) * (point.x - previous.x));
    }
    previous = point;
  }
  return crossings.sort((a, b) => a - b);
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-9 && point.x >= Math.min(a.x, b.x) - 1e-9 &&
      point.x <= Math.max(a.x, b.x) + 1e-9 && point.y >= Math.min(a.y, b.y) - 1e-9 &&
      point.y <= Math.max(a.y, b.y) + 1e-9) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function selectPanel(point: Point, panels: PanelRegion[]): PanelRegion | undefined {
  return panels.filter(panel => pointInPolygon(point, panel.polygon))
    .sort((a, b) => b.confidence - a.confidence || a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height)[0];
}

export function normalizedSelection(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function cropBounds(region: Rect, width: number, height: number): Rect {
  const x = clamp(Math.floor(region.x * width), 0, width - 1);
  const y = clamp(Math.floor(region.y * height), 0, height - 1);
  const right = clamp(Math.ceil((region.x + region.width) * width), x + 1, width);
  const bottom = clamp(Math.ceil((region.y + region.height) * height), y + 1, height);
  return { x, y, width: right - x, height: bottom - y };
}
