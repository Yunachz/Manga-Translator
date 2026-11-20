import type { ProviderId, TranslationRequest, TranslationResult } from '../../types/contracts';

export interface TranslatorProvider {
  id: ProviderId;
  name: string;
  type: 'local' | 'machine-translation' | 'llm';
  requiresApiKey: boolean;
  supportsContext: boolean;
  isAvailable(request?: TranslationRequest): Promise<boolean>;
  translate(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResult>;
}
