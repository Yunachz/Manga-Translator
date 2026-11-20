import type { OCRResult, SourceLanguage, TextRegion } from '../../types/contracts';
import type { BackendPreference } from '../models/ModelManager';

export interface OCRProvider {
  recognize(image: OffscreenCanvas, regions: TextRegion[], language: SourceLanguage, backend: BackendPreference, signal?: AbortSignal):
    Promise<{ lines: OCRResult[]; backend: string }>;
}
