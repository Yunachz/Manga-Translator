import type { MaskRegion } from './TextMask';

export type Color = [number, number, number];

/** Spread of the pixels around the ink above which the background is artwork, not a flat tone. The inpainting engine uses it too. */
export const TEXTURED_BACKGROUND = 25;

export function sampleBackground(raster: ImageData, region: MaskRegion): { color: Color; texture: number } {
  const { x, y, width, height } = region.bounds;
  const channels: [number[], number[], number[]] = [[], [], []];
  for (let row = 0; row < height; row += 2) {
    for (let col = 0; col < width; col += 2) {
      if (region.mask[row * width + col]) continue;
      const index = ((y + row) * raster.width + x + col) * 4;
      for (let channel = 0; channel < 3; channel++) channels[channel].push(raster.data[index + channel]);
    }
  }
  const color: Color = [255, 255, 255];
  let texture = 0;
  for (let channel = 0; channel < 3; channel++) {
    const values = channels[channel].sort((a, b) => a - b);
    if (!values.length) continue;
    color[channel] = values[Math.floor(values.length / 2)];
    texture = Math.max(texture, values[Math.floor(values.length * 0.88)] - values[Math.floor(values.length * 0.12)]);
  }
  return { color, texture };
}

export function writeMasked(raster: ImageData, region: MaskRegion, colorAt: (index: number) => Color): void {
  const { x, y, width } = region.bounds;
  for (let index = 0; index < region.mask.length; index++) {
    if (!region.mask[index]) continue;
    const offset = ((y + Math.floor(index / width)) * raster.width + x + index % width) * 4;
    raster.data.set(colorAt(index), offset);
  }
}
