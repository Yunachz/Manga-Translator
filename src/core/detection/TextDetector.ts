import { Tensor } from 'onnxruntime-web';
import type { Rect, TextRegion } from '../../types/contracts';
import { clamp, rectPolygon } from '../image/geometry';
import { drawCrop } from '../image/raster';
import type { BackendPreference, ModelManager } from '../models/ModelManager';

function detectorInput(raster: ImageData): Tensor {
  const size = raster.width * raster.height;
  const values = new Float32Array(size * 3);
  const mean = [0.485, 0.456, 0.406];
  const standard = [0.229, 0.224, 0.225];
  for (let channel = 0; channel < 3; channel++) {
    const offset = channel * size;
    for (let index = 0; index < size; index++) {
      values[offset + index] = (raster.data[index * 4 + 2 - channel] / 255 - mean[channel]) / standard[channel];
    }
  }
  return new Tensor('float32', values, [1, 3, raster.height, raster.width]);
}

export function dbRegions(scores: Float32Array, width: number, height: number, area: Rect): TextRegion[] {
  const visited = new Uint8Array(scores.length);
  const queue = new Int32Array(scores.length);
  const regions: TextRegion[] = [];
  for (let root = 0; root < scores.length; root++) {
    if (visited[root] || scores[root] < 0.3) continue;
    let left = width, right = 0, top = height, bottom = 0, sum = 0, count = 1;
    queue[0] = root;
    visited[root] = 1;
    for (let head = 0; head < count; head++) {
      const index = queue[head];
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      sum += scores[index];
      for (const neighbor of [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, index - width, index + width]) {
        if (neighbor < 0 || neighbor >= scores.length || visited[neighbor] || scores[neighbor] < 0.3) continue;
        visited[neighbor] = 1;
        queue[count++] = neighbor;
      }
    }
    const w = right - left + 1;
    const h = bottom - top + 1;
    if (count < 7 || Math.min(w, h) < 3 || sum / count < 0.54) continue;
    const padding = Math.max(1, 1.45 * w * h / (2 * (w + h)));
    const x = clamp(left - padding, 0, width);
    const y = clamp(top - padding, 0, height);
    const bounds = { x: area.x + x / width * area.width, y: area.y + y / height * area.height,
      width: (clamp(right + 1 + padding, 0, width) - x) / width * area.width,
      height: (clamp(bottom + 1 + padding, 0, height) - y) / height * area.height };
    regions.push({ bounds, polygon: rectPolygon(bounds) });
  }
  return regions.slice(0, 120);
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return w * h / Math.min(a.width * a.height, b.width * b.height);
}

function tiles(width: number, height: number): Rect[] {
  const longer = Math.max(width, height), shorter = Math.min(width, height);
  if (longer <= 960 || longer / shorter < 1.7) return [{ x: 0, y: 0, width, height }];
  const size = Math.min(longer, Math.max(640, shorter * 1.55, longer / 5));
  const count = Math.ceil(longer / size) + 1;
  return Array.from({ length: count }, (_, index) => {
    const offset = (longer - size) * index / (count - 1);
    return height > width ? { x: 0, y: offset, width, height: size } : { x: offset, y: 0, width: size, height };
  });
}

export class TextDetector {
  constructor(private readonly models: ModelManager) {}

  private async detectArea(image: OffscreenCanvas, area: Rect, preference: BackendPreference) {
    const scale = Math.min(1, 960 / Math.max(area.width, area.height));
    const length = (value: number) => Math.max(32, Math.round(value * scale / 32) * 32);
    const width = length(area.width), height = length(area.height);
    const context = drawCrop(image, area, width, height);
    const result = await this.models.infer('det', { x: detectorInput(context.getImageData(0, 0, width, height)) }, preference);
    const map = result.outputs.fetch_name_0;
    const [mapHeight, mapWidth] = map.dims.slice(-2);
    return { regions: dbRegions(map.data as Float32Array, mapWidth, mapHeight, area), backend: result.backend };
  }

  async retryInside(image: OffscreenCanvas, bounds: Rect, preference: BackendPreference) {
    const marginX = clamp(bounds.width * 0.12, 8, 28), marginY = clamp(bounds.height * 0.27, 12, 24);
    const x = Math.max(0, Math.round(bounds.x - marginX));
    const y = Math.max(0, Math.round(bounds.y - marginY));
    const area = { x, y, width: Math.min(image.width, Math.round(bounds.x + bounds.width + marginX)) - x,
      height: Math.min(image.height, Math.round(bounds.y + bounds.height + marginY)) - y };
    const scan = await this.detectArea(image, area, preference);
    return scan.regions.filter(({ bounds: row }) => {
      const cx = row.x + row.width / 2, cy = row.y + row.height / 2;
      return row.height <= bounds.height * 0.67 && row.width >= row.height * 1.2 &&
        cx > bounds.x && cx < bounds.x + bounds.width && cy >= bounds.y - marginY * 0.5 &&
        cy <= bounds.y + bounds.height + marginY * 0.55;
    });
  }

  async detect(image: OffscreenCanvas, preference: BackendPreference, signal?: AbortSignal) {
    const regions: TextRegion[] = [];
    let backend = 'wasm';
    for (const area of tiles(image.width, image.height)) {
      signal?.throwIfAborted();
      const result = await this.detectArea(image, area, preference);
      backend = result.backend;
      for (const region of result.regions) {
        const duplicate = regions.findIndex(previous => overlap(previous.bounds, region.bounds) > 0.68);
        if (duplicate === -1) regions.push(region);
        else if (region.bounds.width * region.bounds.height > regions[duplicate].bounds.width * regions[duplicate].bounds.height) regions[duplicate] = region;
      }
    }
    return { regions: regions.slice(0, 120), backend };
  }
}
