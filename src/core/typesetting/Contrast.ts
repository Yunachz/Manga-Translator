import type { Point, Rect } from '../../types/contracts';
import type { BubblePlan } from './BubbleFit';

export interface TextPaint { fill: string; stroke: string; strokeWidth: number; mode: 'light' | 'dark' | 'mixed' }

const INK = '#111';
const PAPER = '#fff';
const INK_LUMINANCE = 0.0056;
const MIN_CONTRAST = 3.5;
const MAX_SAMPLES = 4096;

/** Smallest rectangle around all laid-out lines (the area the glyphs will actually cover), plus a stroke margin. */
export function textBox(fit: BubblePlan, measure: (line: string) => number, bounds: Rect): Rect {
  const widest = Math.max(1, ...fit.lines.map(line => measure(line) * fit.scaleX));
  const height = fit.lines.length * fit.lineHeight;
  const margin = Math.max(2, fit.size * 0.15);
  const x0 = Math.max(bounds.x, fit.center.x - widest / 2 - margin);
  const y0 = Math.max(bounds.y, fit.center.y - height / 2 - margin);
  const x1 = Math.min(bounds.x + bounds.width, fit.center.x + widest / 2 + margin);
  const y1 = Math.min(bounds.y + bounds.height, fit.center.y + height / 2 + margin);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/**
 * Chooses text colors from the pixels the text will sit on (not a single point). Must be called before anything
 * is drawn for the page, so earlier translated text never influences a later decision.
 */
export function choosePaint(context: OffscreenCanvasRenderingContext2D, area: Rect, size: number, shape?: Point[]): TextPaint {
  const luminances = sampleLuminance(context, area, shape);
  return paintFor(luminances, size);
}

export function paintFor(luminances: number[], size: number): TextPaint {
  if (!luminances.length) return build('light', size);
  const sorted = [...luminances].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const spread = sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)];
  const inkScore = coverage(luminances, INK_LUMINANCE);
  const paperScore = coverage(luminances, 1);
  const best = Math.max(inkScore, paperScore);
  const preferDark = inkScore === paperScore ? median > 0.4 : inkScore > paperScore;
  const mixed = best < 0.85 || spread > 0.35;
  return build(mixed ? 'mixed' : preferDark ? 'light' : 'dark', size, preferDark);
}

function build(mode: 'light' | 'dark' | 'mixed', size: number, inkText = true): TextPaint {
  // `light` = light background -> dark text. `dark` = dark background -> white text.
  if (mode === 'mixed') {
    const strokeWidth = Math.min(3.5, Math.max(1.5, size / 9));
    return inkText
      ? { fill: INK, stroke: 'rgba(255, 255, 255, .95)', strokeWidth, mode }
      : { fill: PAPER, stroke: 'rgba(10, 10, 10, .9)', strokeWidth, mode };
  }
  const strokeWidth = Math.min(2, Math.max(0.5, size / 22));
  return mode === 'light'
    ? { fill: INK, stroke: 'rgba(255, 255, 255, .75)', strokeWidth, mode }
    : { fill: PAPER, stroke: 'rgba(10, 10, 10, .65)', strokeWidth, mode };
}

function coverage(luminances: number[], textLuminance: number): number {
  let good = 0;
  for (const value of luminances) {
    const hi = Math.max(value, textLuminance), lo = Math.min(value, textLuminance);
    if ((hi + 0.05) / (lo + 0.05) >= MIN_CONTRAST) good++;
  }
  return good / luminances.length;
}

function sampleLuminance(context: OffscreenCanvasRenderingContext2D, area: Rect, shape?: Point[]): number[] {
  const x = Math.max(0, Math.floor(area.x)), y = Math.max(0, Math.floor(area.y));
  const width = Math.max(1, Math.ceil(area.x + area.width) - x), height = Math.max(1, Math.ceil(area.y + area.height) - y);
  const data = context.getImageData(x, y, width, height).data;
  const pixels = Math.floor(data.length / 4);
  const stride = Math.max(1, Math.ceil(pixels / MAX_SAMPLES));
  const inside = shape && shape.length >= 3 ? shape : undefined;
  const result: number[] = [];
  for (let index = 0; index < pixels; index += stride) {
    if (data[index * 4 + 3] < 128) continue;
    if (inside && pixels === width * height && !contains(inside, x + (index % width) + 0.5, y + Math.floor(index / width) + 0.5)) continue;
    result.push(luminance(data[index * 4], data[index * 4 + 1], data[index * 4 + 2]));
  }
  return result;
}

function luminance(r: number, g: number, b: number): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contains(polygon: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (a.y > y !== b.y > y && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
