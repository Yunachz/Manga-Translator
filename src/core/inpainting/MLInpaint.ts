import { Tensor } from 'onnxruntime-web';
import { clamp } from '../image/geometry';
import { canvas2d } from '../image/raster';
import type { BackendPreference, ModelManager } from '../models/ModelManager';
import { writeMasked } from './FlatFill';
import type { MaskRegion } from './TextMask';

export async function mlInpaint(raster: ImageData, region: MaskRegion, models: ModelManager, preference: BackendPreference): Promise<boolean> {
  if (!models.optional('lama')) return false;
  const { x, y, width, height } = region.bounds;
  const size = 512, pixels = size * size;
  const border = Math.max(24, Math.round(Math.min(width, height) * 2));
  const left = Math.max(0, x - border), top = Math.max(0, y - border);
  const w = Math.min(raster.width - left, x + width + border - left);
  const h = Math.min(raster.height - top, y + height + border - top);
  const source = canvas2d(w, h);
  source.putImageData(raster, -left, -top, left, top, w, h);
  const scaled = canvas2d(size, size);
  scaled.drawImage(source.canvas, 0, 0, size, size);
  const { data } = scaled.getImageData(0, 0, size, size);
  const image = new Float32Array(pixels * 3), mask = new Float32Array(pixels);
  for (let index = 0; index < pixels; index++) {
    for (let channel = 0; channel < 3; channel++) image[channel * pixels + index] = data[index * 4 + channel] / 255;
    const col = Math.floor((index % size + 0.5) * w / size) + left - x;
    const row = Math.floor((Math.floor(index / size) + 0.5) * h / size) + top - y;
    if (col >= 0 && col < width && row >= 0 && row < height) mask[index] = region.mask[row * width + col];
  }
  const { outputs } = await models.infer('lama', {
    image: new Tensor('float32', image, [1, 3, size, size]),
    mask: new Tensor('float32', mask, [1, 1, size, size]),
  }, preference);
  const values = outputs.output.data as Float32Array;
  if (values.length !== pixels * 3) return false;
  writeMasked(raster, region, index => {
    const col = clamp(Math.floor((index % width + x - left + 0.5) * size / w), 0, size - 1);
    const row = clamp(Math.floor((Math.floor(index / width) + y - top + 0.5) * size / h), 0, size - 1);
    const offset = row * size + col;
    return [values[offset], values[pixels + offset], values[2 * pixels + offset]];
  });
  return true;
}
