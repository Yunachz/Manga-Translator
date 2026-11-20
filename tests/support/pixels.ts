import type { RasterImage } from './png';

/** Plain-object stand-in for `ImageData`. Node has no `ImageData`, and the detectors only read these three fields. */
export function asImageData(image: RasterImage): ImageData {
  return image as unknown as ImageData;
}

export function createRaster(width: number, height: number, shade = 255): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([shade, shade, shade, 255], i * 4);
  return { width, height, data };
}

export function fillRect(image: RasterImage, x: number, y: number, width: number, height: number, shade: number): void {
  const right = Math.min(image.width, x + width);
  const bottom = Math.min(image.height, y + height);
  for (let row = Math.max(0, y); row < bottom; row++) {
    for (let column = Math.max(0, x); column < right; column++) {
      image.data.set([shade, shade, shade, 255], (row * image.width + column) * 4);
    }
  }
}

/** Panel with a solid ink border and mid-gray artwork inside, plus a darker block so the interior has real contrast. */
export function drawPanel(image: RasterImage, x: number, y: number, width: number, height: number,
  { border = 4, ink = 0, art = 150 }: { border?: number; ink?: number; art?: number } = {}): void {
  fillRect(image, x, y, width, height, ink);
  fillRect(image, x + border, y + border, width - 2 * border, height - 2 * border, art);
  const block = art >= 128 ? Math.max(0, art - 90) : Math.min(255, art + 90);
  fillRect(image, x + Math.floor(width * 0.3), y + Math.floor(height * 0.3), Math.floor(width * 0.4), Math.floor(height * 0.4), block);
}

/** Deterministic nearest-neighbour resize. Close to the detector's canvas downscale for flat art. */
export function resizeNearest(image: RasterImage, width: number, height: number): RasterImage {
  const out = createRaster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width));
      const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / height));
      const from = (sy * image.width + sx) * 4;
      out.data.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return out;
}

/** Seeded generator so noisy fixtures never flake. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
