import type { PanelRegion } from '../../types/contracts';
import { ClassicalPanelDetector } from './ClassicalPanelDetector';
import { MLPanelDetector } from './MLPanelDetector';
import type { BackendPreference, ModelManager } from '../models/ModelManager';

export class PanelEngine {
  private readonly classical = new ClassicalPanelDetector();

  constructor(private readonly models: ModelManager) {}

  async detect(image: ImageBitmap, preference: BackendPreference): Promise<PanelRegion[]> {
    const classical = await this.classical.detect(image);
    if (classical.length > 1) return classical;
    const detected = await new MLPanelDetector(this.models, preference).detect(image).catch(() => []);
    return detected.length && (detected.length > 1 || (detected[0].confidence > 0.72 && !classical.length))
      ? detected : classical;
  }
}
