import type { Rect } from '../../types/contracts';
import { gray } from '../image/raster';

/** Split a merged Latin text block at clear horizontal whitespace between glyph rows. */
export function horizontalTextBands(raster: ImageData, bounds: Rect, typicalHeight: number): Rect[] {
  const left = Math.max(0, Math.floor(bounds.x));
  const top = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(raster.width, Math.ceil(bounds.x + bounds.width));
  const bottom = Math.min(raster.height, Math.ceil(bounds.y + bounds.height));
  const width = right - left, height = bottom - top;
  if (height < 23 || width < height * 0.85) return [];
  const shades: number[] = [];
  for (let x = left; x < right; x += 2) {
    shades.push(gray(raster.data, top * raster.width + x), gray(raster.data, (bottom - 1) * raster.width + x));
  }
  shades.sort((a, b) => a - b);
  const light = shades[Math.floor(shades.length / 2)] >= 127;
  const background = shades[Math.floor(shades.length * (light ? 0.75 : 0.25))];
  const band: Rect[] = [];
  const minimumHeight = Math.max(5, height * 0.10, Math.min(typicalHeight * 0.41, height * 0.2));
  const minimumGap = Math.max(3, Math.round(height * 0.028));
  let start = -1, end = -1, rowLeft = right, rowRight = left, total = 0;
  const finish = () => {
    if (end - start + 1 >= minimumHeight && rowRight - rowLeft >= width * 0.12) {
      const x = Math.max(0, rowLeft - 3), y = Math.max(0, start - 1);
      band.push({ x, y, width: Math.min(raster.width, rowRight + 4) - x, height: Math.min(raster.height, end + 2) - y });
    }
    start = -1;
    end = -1;
    rowLeft = right;
    rowRight = left;
  };
  for (let y = top; y < bottom; y++) {
    let count = 0, low = right, high = left;
    for (let x = left; x < right; x++) {
      const value = gray(raster.data, y * raster.width + x);
      if ((light ? background - value : value - background) < 48) continue;
      count++;
      low = Math.min(low, x);
      high = Math.max(high, x);
    }
    total += count;
    if (count >= Math.max(2, width * 0.035) && count < width * 0.75) {
      if (start === -1) start = y;
      end = y;
      rowLeft = Math.min(rowLeft, low);
      rowRight = Math.max(rowRight, high);
    } else if (start !== -1 && y - end >= minimumGap) finish();
  }
  if (start !== -1) finish();
  return band.length >= 2 && band.length <= 8 && total < width * height * 0.48 ? band : [];
}
