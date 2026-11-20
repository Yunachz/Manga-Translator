import type { BubbleRegion, Point, Rect } from '../../types/contracts';
import { polygonCrossings } from '../image/geometry';
import { prepareText, type Measure } from './TextLayout';

export interface BubblePlan { size: number; lines: string[]; lineHeight: number; center: Point; scaleX: number }
export interface BubbleFitOptions {
  lineHeight: number; padding: number; language?: string; minimum?: number; maximum?: number; reserved?: Rect[];
}

/** Free area of a bubble as a pixel grid with a summed-area table, so "does this rectangle fit" is O(1). */
class Region {
  private readonly sums: Int32Array;
  private readonly stride: number;
  readonly origin: Point;
  readonly rows: number;

  constructor(bounds: Rect, shape?: Point[]) {
    const x0 = Math.floor(bounds.x), y0 = Math.floor(bounds.y);
    const columns = Math.max(1, Math.ceil(bounds.x + bounds.width) - x0), rows = Math.max(1, Math.ceil(bounds.y + bounds.height) - y0);
    this.origin = { x: x0, y: y0 };
    this.stride = columns + 1;
    this.rows = rows;
    this.sums = new Int32Array((columns + 1) * (rows + 1));
    const inside = shape && shape.length >= 3 ? shape : undefined;
    for (let row = 0; row < rows; row++) {
      const y = y0 + row + 0.5;
      const intersections = inside ? polygonCrossings(inside, y) : [];
      let edge = 0;
      let run = 0;
      for (let column = 0; column < columns; column++) {
        const x = x0 + column + 0.5;
        while (edge < intersections.length && x >= intersections[edge]) edge++;
        const free = x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height &&
          (!inside || edge % 2 === 1);
        run += free ? 1 : 0;
        this.sums[(row + 1) * this.stride + column + 1] = this.sums[row * this.stride + column + 1] + run;
      }
    }
  }

  /** True when every pixel of the rectangle belongs to the region. */
  holds(left: number, top: number, right: number, bottom: number): boolean {
    const columns = this.stride - 1;
    const a = Math.floor(left - this.origin.x), b = Math.ceil(right - this.origin.x);
    const c = Math.floor(top - this.origin.y), d = Math.ceil(bottom - this.origin.y);
    if (a < 0 || c < 0 || b > columns || d > this.rows || b <= a || d <= c) return false;
    const { sums, stride } = this;
    const total = sums[d * stride + b] - sums[c * stride + b] - sums[d * stride + a] + sums[c * stride + a];
    return total === (b - a) * (d - c);
  }
}

function median(values: number[]): number | undefined {
  const sorted = values.filter(value => value > 0).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Largest font size worth using: close to the size of the text that was cleaned, so lobes never get giant text. */
export function sizeCeiling(bubble: BubbleRegion, maximum = 64): number {
  const original = bubble.textSize ?? median(bubble.lines.map(line => line.bounds.height));
  return original ? Math.max(6, Math.min(maximum, Math.round(original * (bubble.enclosed === false ? 0.82 : 1.1)))) : maximum;
}

/**
 * Picks the largest font size, wrap width and centre for which every wrapped line sits inside the real balloon
 * (its `shape`, or its bounds when the shape is unknown) and inside `bounds`. Returns undefined when even the
 * minimum size does not fit, so the caller can leave the original text in place.
 */
export function planBubbleText(bubble: BubbleRegion, text: string, measureAt: (size: number) => Measure,
  options: BubbleFitOptions): BubblePlan | undefined {
  const { bounds } = bubble;
  const maximum = sizeCeiling(bubble, options.maximum ?? 64);
  const minimum = options.minimum ?? (bubble.textSize ? Math.max(6, Math.min(15, Math.round(maximum * 0.53))) : 6);
  const clearance = Math.min(6, Math.max(1, Math.min(bounds.width, bounds.height) * options.padding * 0.5));
  const region = new Region(bounds, bubble.enclosed === false ? undefined : bubble.shape);
  const reserved = options.reserved?.filter(rect => rect.x < bounds.x + bounds.width && bounds.x < rect.x + rect.width &&
    rect.y < bounds.y + bounds.height && bounds.y < rect.y + rect.height) ?? [];
  const wrap = prepareText(text, options.language ?? 'id');
  const preferred = preferredCenter(bubble);
  const centers = candidateCenters(bounds, preferred);
  const widest = bounds.width - 2 * clearance;
  if (widest <= 0) return undefined;

  const top = Math.min(maximum, Math.floor(bounds.height / Math.max(1, options.lineHeight)));
  function search(floor: number, scaleX = 1, breakLongWords = false): BubblePlan | undefined {
    for (let size = top; size >= floor; size--) {
      const widthAtSize = measureAt(size);
      const measure = (line: string) => scaleX * widthAtSize(line);
      const lineHeight = size * options.lineHeight;
      const glyph = size * 1.05;
      const seen = new Set<string>();
      for (let step = 0; step <= 16; step++) {
        const width = widest * (1 - step * 0.045);
        if (width < size) break;
        const lines = wrap(width, measure, breakLongWords);
        if (!lines.length) continue;
        const key = lines.join('\n');
        if (seen.has(key)) continue;
        seen.add(key);
        const widths = lines.map(measure);
        if (Math.max(...widths) > widest) continue;
        for (const center of centers) {
          if (lines.every((_line, index) => {
            const y = center.y + (index - (lines.length - 1) / 2) * lineHeight;
            const left = center.x - widths[index] / 2 - clearance, right = center.x + widths[index] / 2 + clearance;
            const top = y - glyph / 2, bottom = y + glyph / 2;
            return region.holds(left, top, right, bottom) && !reserved.some(rect =>
              left < rect.x + rect.width && rect.x < right && top - 2 < rect.y + rect.height && rect.y < bottom + 2);
          })) return { size, lines, lineHeight, center, scaleX };
        }
      }
    }
  }
  const wordFloor = options.minimum ?? Math.min(minimum, 8);
  return search(minimum) ?? search(minimum, 0.86) ?? search(wordFloor, 0.86) ?? search(minimum, 1, true);
}

function preferredCenter(bubble: BubbleRegion): Point {
  const { bounds, lines } = bubble;
  if (bubble.enclosed === false && lines.length) {
    const boxes = lines.map(line => line.bounds);
    const left = Math.min(...boxes.map(box => box.x)), right = Math.max(...boxes.map(box => box.x + box.width));
    const top = Math.min(...boxes.map(box => box.y)), bottom = Math.max(...boxes.map(box => box.y + box.height));
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }
  if (bubble.shape?.length && lines.length) {
    const boxes = lines.map(line => line.bounds);
    const x = median(boxes.map(box => box.x + box.width / 2)), y = median(boxes.map(box => box.y + box.height / 2));
    if (x !== undefined && y !== undefined) return { x, y };
  }
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** Preferred centre first, then a grid ordered by distance from it. */
function candidateCenters(bounds: Rect, preferred: Point): Point[] {
  const step = Math.max(1, Math.round(Math.max(bounds.width, bounds.height) / 70));
  const centers: Point[] = [preferred];
  for (let y = bounds.y; y <= bounds.y + bounds.height; y += step) {
    for (let x = bounds.x; x <= bounds.x + bounds.width; x += step) centers.push({ x, y });
  }
  const distance = (point: Point) => Math.hypot(point.x - preferred.x, (point.y - preferred.y) * 1.3);
  return centers.sort((a, b) => distance(a) - distance(b));
}
