import { Tensor } from 'onnxruntime-web';
import type { PanelRegion, Rect } from '../../types/contracts';
import { clamp, rectPolygon } from '../image/geometry';
import { canvas2d } from '../image/raster';
import type { BackendPreference, ModelManager } from '../models/ModelManager';
import type { PanelDetector } from './PanelDetector';

export class MLPanelDetector implements PanelDetector {
  constructor(private readonly models: ModelManager, private readonly preference: BackendPreference) {}

  async detect(image: ImageBitmap): Promise<PanelRegion[]> {
    if (!this.models.optional('panel')) return [];
    const size = 1024, pixels = size * size;
    const scale = Math.min(size / image.width, size / image.height);
    const width = Math.round(image.width * scale), height = Math.round(image.height * scale);
    const left = Math.floor((size - width) / 2), top = Math.floor((size - height) / 2);
    const context = canvas2d(size, size);
    context.fillStyle = '#727272';
    context.fillRect(0, 0, size, size);
    context.drawImage(image, left, top, width, height);
    const { data } = context.getImageData(0, 0, size, size);
    const buffer = new Float32Array(pixels * 3);
    for (let index = 0; index < pixels; index++) {
      for (let channel = 0; channel < 3; channel++) buffer[channel * pixels + index] = data[index * 4 + channel] / 255;
    }
    const { outputs } = await this.models.infer('panel', { images: new Tensor('float32', buffer, [1, 3, size, size]) }, this.preference);
    const values = outputs.output0.data as Float32Array;
    const panels: PanelRegion[] = [];
    for (let i = 0; i + 5 < values.length; i += 6) {
      const [x1, y1, x2, y2, confidence, label] = values.subarray(i, i + 6);
      if (label !== 0 || confidence < 0.47 || confidence > 1) continue;
      const x = clamp((x1 - left) / width), y = clamp((y1 - top) / height);
      const bounds: Rect = { x, y, width: clamp((x2 - left) / width) - x, height: clamp((y2 - top) / height) - y };
      if (bounds.width > 0.035 && bounds.height > 0.035) {
        panels.push({ id: `model-${panels.length + 1}`, bounds, polygon: rectPolygon(bounds), confidence });
      }
    }
    return panels;
  }
}
