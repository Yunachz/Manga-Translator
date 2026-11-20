import type { PanelRegion } from '../../types/contracts';

export interface PanelDetector {
  detect(image: ImageBitmap): Promise<PanelRegion[]>;
}
