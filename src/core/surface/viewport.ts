import type { CaptureFrame } from '../../messaging/protocol';
import type { Rect } from '../../types/contracts';
import type { ImageGeometry } from '../image/CoordinateMapper';

export type ViewportSnapshot = CaptureFrame['viewport'];

/** Smallest area, in CSS pixels, that is worth reading. */
export const minimumArea = 18;

export function viewportRect(): Rect {
  return { x: visualViewport?.offsetLeft ?? 0, y: visualViewport?.offsetTop ?? 0,
    width: visualViewport?.width ?? innerWidth, height: visualViewport?.height ?? innerHeight };
}

/** Visual viewport offset, size and pinch scale, then the scroll position. Any change moves what the user sees. */
export function viewportSnapshot(): ViewportSnapshot {
  const view = viewportRect();
  return [view.x, view.y, view.width, view.height, visualViewport?.scale ?? 1, scrollX, scrollY];
}

export function sameViewport(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) < 0.02);
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

/**
 * The part of a surface the user can see right now, normalized to the surface. The page area is its drawn
 * content clipped to its box and to the viewport. Undefined when too little of it shows.
 */
export function visibleCrop(geometry: ImageGeometry, viewport: Rect): Rect | undefined {
  const { object, clip } = geometry;
  if (object.width <= 0 || object.height <= 0) return;
  const shown = intersect(intersect(object, clip) ?? { x: 0, y: 0, width: 0, height: 0 }, viewport);
  if (!shown || shown.width < minimumArea || shown.height < minimumArea) return;
  return { x: (shown.x - object.x) / object.width, y: (shown.y - object.y) / object.height,
    width: shown.width / object.width, height: shown.height / object.height };
}

/** Share of a surface's drawn content that is inside the viewport, 0 to 1. */
export function visibleShare(geometry: ImageGeometry, viewport: Rect): number {
  const { object, clip } = geometry;
  const shown = intersect(intersect(object, clip) ?? { x: 0, y: 0, width: 0, height: 0 }, viewport);
  return shown && object.width > 0 && object.height > 0 ? (shown.width * shown.height) / (object.width * object.height) : 0;
}

/** A normalized rectangle of the visual viewport, in client pixels. */
export function viewportPixels(bounds: Rect, viewport: Rect = viewportRect()): Rect {
  return { x: viewport.x + bounds.x * viewport.width, y: viewport.y + bounds.y * viewport.height,
    width: bounds.width * viewport.width, height: bounds.height * viewport.height };
}

/** A client-pixel point as a point of the visual viewport, 0 to 1. */
export function viewportPoint(clientX: number, clientY: number, viewport: Rect = viewportRect()): { x: number; y: number } {
  return { x: Math.min(1, Math.max(0, (clientX - viewport.x) / viewport.width)),
    y: Math.min(1, Math.max(0, (clientY - viewport.y) / viewport.height)) };
}

const identities = new WeakMap<Element, number>();
let nextIdentity = 1;
function identityOf(element: Element): number {
  let value = identities.get(element);
  if (value === undefined) { value = nextIdentity++; identities.set(element, value); }
  return value;
}

/**
 * What lies under a freeform area: the nearest elements at a few points, each with its position. A reader that
 * slides, zooms or swaps its pages by a transform changes this without scrolling the window, so a freeform
 * result is kept only while the signature it was read under still holds.
 */
export function areaSignature(area: Rect): string {
  const points = [[0.15, 0.15], [0.85, 0.15], [0.5, 0.5], [0.15, 0.85], [0.85, 0.85]];
  return points.map(([fx, fy]) => document.elementsFromPoint(area.x + area.width * fx, area.y + area.height * fy)
    .filter(element => element.tagName !== 'MANGA-TRANSLATOR-LAYER').slice(0, 4).map(element => {
      const box = element.getBoundingClientRect();
      return `${identityOf(element)}@${Math.round(box.x * 2) / 2},${Math.round(box.y * 2) / 2},${Math.round(box.width)}x${Math.round(box.height)}`;
    }).join('>')).join('|');
}
