import { rectPolygon } from '../image/geometry';
import { drawCrop, scaleDimensions, gray } from '../image/raster';
import type { PanelRegion, Rect } from '../../types/contracts';
import type { PanelDetector } from './PanelDetector';

type Axis = 'x' | 'y';

function uniform(data: ImageData, area: Rect, axis: Axis, line: number, light: boolean): boolean {
  const start = axis === 'x' ? area.y : area.x;
  const length = axis === 'x' ? area.height : area.width;
  let mismatched = 0;
  for (let offset = start; offset < start + length; offset++) {
    const index = axis === 'x' ? offset * data.width + line : line * data.width + offset;
    const shade = gray(data.data, index);
    if ((light ? shade < 243 : shade > 18) && ++mismatched > length * 0.018) return false;
  }
  return true;
}

function inset(data: ImageData, rect: Rect): Rect {
  const light = gray(data.data, 0) > 128;
  let { x, y, width, height } = rect;
  const maximumX = Math.floor(width * 0.22);
  const maximumY = Math.floor(height * 0.22);
  for (let i = 0; i < maximumY && uniform(data, rect, 'y', y, light); i++) { y++; height--; }
  for (let i = 0; i < maximumY && uniform(data, rect, 'y', y + height - 1, light); i++) height--;
  const vertical = { x, y, width, height };
  for (let i = 0; i < maximumX && uniform(data, vertical, 'x', x, light); i++) { x++; width--; }
  for (let i = 0; i < maximumX && uniform(data, vertical, 'x', x + width - 1, light); i++) width--;
  return { x, y, width, height };
}

function split(data: ImageData, area: Rect): Rect[] {
  let best: { axis: Axis; start: number; end: number; score: number } | undefined;
  for (const axis of ['y', 'x'] as const) {
    const size = axis === 'y' ? area.height : area.width;
    const minimum = Math.max(18, Math.floor(size * 0.12));
    const last = area[axis] + size - minimum;
    for (const light of [true, false]) {
      let start = -1;
      for (let line = area[axis] + minimum; line <= last; line++) {
        if (line < last && uniform(data, area, axis, line, light)) {
          if (start < 0) start = line;
          continue;
        }
        const span = line - start;
        if (start >= 0 && span >= Math.max(3, size * 0.008) && span < size * 0.34) {
          const score = span / size;
          if (!best || score > best.score) best = { axis, start, end: line, score };
        }
        start = -1;
      }
    }
  }
  if (!best) return [area];
  const { axis, start, end } = best;
  const size = axis === 'x' ? 'width' : 'height';
  return [{ ...area, [size]: start - area[axis] },
    { ...area, [axis]: end, [size]: area[axis] + area[size] - end }];
}

function hasArtwork(data: ImageData, area: Rect): boolean {
  let dark = 0;
  let total = 0;
  let low = 255;
  let high = 0;
  for (let y = area.y + 3; y < area.y + area.height - 3; y += 4) {
    for (let x = area.x + 3; x < area.x + area.width - 3; x += 4) {
      const shade = gray(data.data, y * data.width + x);
      if (shade < 230) dark++;
      low = Math.min(low, shade);
      high = Math.max(high, shade);
      total++;
    }
  }
  return total > 0 && dark / total > 0.045 && high - low >= 18;
}

export function detectGutters(data: ImageData): PanelRegion[] {
  const full = { x: 0, y: 0, width: data.width, height: data.height };
  const inner = inset(data, full);
  const cells = (rect: Rect, depth: number): Rect[] => {
    const children = split(data, rect);
    return children.length === 1 || depth >= 5 ? [rect] : children.flatMap(child => cells(child, depth + 1));
  };
  const panels = cells(inner, 0).map(rect => inset(data, rect)).filter(rect => hasArtwork(data, rect));
  if (panels.length === 1) {
    const margin = full.width - inner.width + full.height - inner.height;
    if (margin < (full.width + full.height) * 0.025) return [];
  }
  return panels.map((rect, index) => {
    const bounds = { x: rect.x / full.width, y: rect.y / full.height, width: rect.width / full.width, height: rect.height / full.height };
    return { id: `gutter-${index + 1}`, bounds, polygon: rectPolygon(bounds), confidence: panels.length > 1 ? 0.91 : 0.76 };
  });
}

export class ClassicalPanelDetector implements PanelDetector {
  async detect(image: ImageBitmap): Promise<PanelRegion[]> {
    const [width, height] = scaleDimensions(image.width, image.height, image.height > image.width * 2.5 ? 2850 : 1200, 780_000);
    const context = drawCrop(image, { x: 0, y: 0, width: image.width, height: image.height }, width, height);
    return detectGutters(context.getImageData(0, 0, width, height));
  }
}
