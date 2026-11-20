import type { Rect } from '../../types/contracts';

export function canvas2d(width: number, height: number, read = true): OffscreenCanvasRenderingContext2D {
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: read });
  if (!context) throw new Error('Canvas 2D unavailable');
  return context;
}

export function scaleDimensions(width: number, height: number, maxSide: number, maxPixels = Infinity): [number, number] {
  const scale = Math.min(1, maxSide / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export function drawCrop(image: CanvasImageSource, area: Rect, width = area.width, height = area.height) {
  const context = canvas2d(width, height);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, width, height);
  return context;
}

export function gray(data: Uint8ClampedArray, index: number): number {
  const offset = index * 4;
  return (77 * data[offset] + 150 * data[offset + 1] + 29 * data[offset + 2]) / 256;
}

export async function rasterDataUrl(canvas: OffscreenCanvas, type = 'image/png'): Promise<string> {
  const blob = await canvas.convertToBlob({ type, quality: 0.92 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
