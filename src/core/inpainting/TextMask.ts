import type { InpaintingMode, Point, Rect } from '../../types/contracts';
import { gray } from '../image/raster';
import { clamp, polygonCrossings } from '../image/geometry';
import { dilate } from './dilate';
import { sampleBackground, TEXTURED_BACKGROUND } from './FlatFill';
import { outlineMask } from './OutlineMask';

export { dilate };

/** `outlined` marks a mask of outlined lettering over artwork. Its fill must not copy the pale outline back in. */
export interface MaskRegion { bounds: Rect; mask: Uint8Array; outlined?: boolean }

/** Protect ink connected to real artwork. The edge of the OCR crop is a fallback when no contour is known. */
function edgeInk(ink: Uint8Array, width: number, height: number, owned?: Uint8Array): Uint8Array {
  const edge = new Uint8Array(ink.length);
  const queue: number[] = [];
  const add = (index: number) => {
    if (ink[index] && !edge[index]) { edge[index] = 1; queue.push(index); }
  };
  if (owned) {
    for (let index = 0; index < owned.length; index++) if (!owned[index]) add(index);
  } else {
    for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { add(y * width); add(y * width + width - 1); }
  }
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head], x = index % width;
    if (x > 0) add(index - 1);
    if (x + 1 < width) add(index + 1);
    if (index >= width) add(index - width);
    if (index + width < ink.length) add(index + width);
  }
  return edge;
}

function interiorMask(bounds: Rect, contour: Point[]): Uint8Array {
  const { x, y, width, height } = bounds;
  const inside = new Uint8Array(width * height);
  const rows = Array.from({ length: height + 2 }, (_, index) => polygonCrossings(contour, y + index - 0.5));
  for (let row = 0; row < height; row++) {
    const near = rows.slice(row, row + 3);
    const edges = [0, 0, 0];
    for (let col = 0; col < width; col++) {
      const center = x + col + 0.5;
      let owned = true;
      for (const [index, crossings] of near.entries()) {
        let edge = edges[index];
        while (edge < crossings.length && center >= crossings[edge]) edge++;
        edges[index] = edge;
        if (edge % 2 === 0 || crossings[edge - 1] >= center - 1 || crossings[edge] <= center + 1) owned = false;
      }
      if (owned) inside[row * width + col] = 1;
    }
  }
  return inside;
}

function extendGlyphs(mask: Uint8Array, ink: Uint8Array, edge: Uint8Array, width: number): void {
  const queue: number[] = [];
  for (let index = 0; index < mask.length; index++) if (mask[index]) queue.push(index);
  const add = (index: number) => {
    if (ink[index] && !edge[index] && !mask[index]) { mask[index] = 1; queue.push(index); }
  };
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head], x = index % width;
    if (x > 0) add(index - 1);
    if (x < width - 1) add(index + 1);
    if (index >= width) add(index - width);
    if (index + width < mask.length) add(index + width);
  }
}

function maskLine(raster: ImageData, line: Rect, contrastScale: number, tight: boolean, contour?: Point[]): MaskRegion | undefined {
    const radius = clamp(Math.round(Math.min(line.width, line.height) * (tight ? 0.03 : 0.055)), 1, tight ? 2 : 6);
    const extension = radius + 2;
    const x = clamp(Math.floor(line.x) - extension, 0, raster.width - 1);
    const y = clamp(Math.floor(line.y) - extension, 0, raster.height - 1);
    const width = clamp(Math.ceil(line.x + line.width) + extension, x + 1, raster.width) - x;
    const height = clamp(Math.ceil(line.y + line.height) + extension, y + 1, raster.height) - y;
    const shades: number[] = [];
    for (let i = 0; i < width; i += 2) {
      shades.push(gray(raster.data, y * raster.width + x + i));
      shades.push(gray(raster.data, (y + height - 1) * raster.width + x + i));
    }
    for (let i = 0; i < height; i += 2) {
      shades.push(gray(raster.data, (y + i) * raster.width + x));
      shades.push(gray(raster.data, (y + i) * raster.width + x + width - 1));
    }
    shades.sort((a, b) => a - b);
    const polarity = shades[Math.floor(shades.length * 0.5)] >= 117;
    const background = shades[Math.floor(shades.length * (polarity ? 0.72 : 0.28))];
    const contrast = clamp(Math.abs(background - 128) * 0.32, 22, 40) * contrastScale;
    const ink = new Uint8Array(width * height);
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const shade = gray(raster.data, (y + j) * raster.width + x + i);
      if (polarity ? shade < background - contrast : shade > background + contrast) ink[j * width + i] = 1;
    }
    const bounds = { x, y, width, height };
    const owned = contour && contour.length >= 3 ? interiorMask(bounds, contour) : undefined;
    const edge = edgeInk(ink, width, height, owned);
    const mask = new Uint8Array(width * height);
    let marked = 0, blocked = 0;
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        if (x + i < line.x - 0.5 || x + i > line.x + line.width + 0.5 ||
            y + j < line.y - 0.5 || y + j > line.y + line.height + 0.5) continue;
        const index = j * width + i;
        if (!ink[index]) continue;
        if (edge[index]) { blocked++; continue; }
        mask[index] = 1;
        marked++;
      }
    }
    const area = line.width * line.height;
    if (marked < 3 || marked > area * (tight ? 0.55 : 0.66) || (blocked > marked && blocked > area * 0.16)) return;
    if (owned) extendGlyphs(mask, ink, edge, width);
    const expanded = dilate(mask, width, height, radius);
    for (let i = 0; i < edge.length; i++) if (edge[i] || (owned && !owned[i])) expanded[i] = 0;
    return expanded.some(Boolean) ? { bounds, mask: expanded } : undefined;
}

/**
 * Lettering outside a balloon, printed as dark glyphs in a pale outline, gets the outline mask in every mode. It is
 * used when the ink mask fails, or when the artwork around the lettering is not a flat tone, because then the pale
 * outline would stay behind as a white ghost. Balloon text, with its contour, and plain text on a flat tone keep the ink mask.
 */
function outlined(raster: ImageData, line: Rect, mode: InpaintingMode, contour: Point[] | undefined, standard: MaskRegion | undefined): MaskRegion | undefined {
  if (contour) return;
  const outline = outlineMask(raster, line, mode);
  return outline && (!standard || sampleBackground(raster, outline).texture >= TEXTURED_BACKGROUND) ? outline : undefined;
}

export function buildLineMask(raster: ImageData, line: Rect, mode: InpaintingMode = 'normal', contour?: Point[]): MaskRegion | undefined {
  const standard = maskLine(raster, line, 1, false, contour);
  const outline = outlined(raster, line, mode, contour, standard);
  if (outline) return outline;
  if (standard || mode === 'normal') return standard;
  const constrained = maskLine(raster, line, 0.8, true, contour);
  if (constrained || mode === 'constrained') return constrained;
  return maskLine(raster, line, 0.6, true, contour);
}

export function textMask(raster: ImageData, lines: Rect[], mode: InpaintingMode = 'normal', contour?: Point[]): MaskRegion[] {
  return lines.flatMap(line => buildLineMask(raster, line, mode, contour) ?? []);
}
