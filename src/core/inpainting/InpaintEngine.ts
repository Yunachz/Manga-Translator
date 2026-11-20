import type { Settings } from '../../types/contracts';
import type { ModelManager } from '../models/ModelManager';
import { classicalInpaint } from './ClassicalInpaint';
import { sampleBackground, TEXTURED_BACKGROUND, writeMasked } from './FlatFill';
import { mlInpaint } from './MLInpaint';
import type { MaskRegion } from './TextMask';

export class InpaintEngine {
  constructor(private readonly models: ModelManager) {}

  async clean(raster: ImageData, masks: MaskRegion[], settings: Pick<Settings, 'inpainting' | 'performance'>, signal?: AbortSignal): Promise<string[]> {
    const used = new Set<string>();
    for (const mask of masks) {
      signal?.throwIfAborted();
      const { color, texture } = sampleBackground(raster, mask);
      if (settings.inpainting === 'fast' || (settings.inpainting === 'auto' && texture < TEXTURED_BACKGROUND)) {
        writeMasked(raster, mask, () => color);
        used.add('flat');
        continue;
      }
      if (settings.inpainting === 'auto' && texture > 75 &&
          await mlInpaint(raster, mask, this.models, settings.performance).catch(() => false)) {
        used.add('ml');
        continue;
      }
      classicalInpaint(raster, mask, color);
      used.add('classical');
    }
    signal?.throwIfAborted();
    return [...used];
  }
}
