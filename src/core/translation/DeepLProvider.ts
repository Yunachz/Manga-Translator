import type { ProviderConfig, TranslationRequest } from '../../types/contracts';
import { CloudProvider } from './CloudProvider';
import { orderedTexts } from './segments';

export class DeepLProvider extends CloudProvider {
  constructor(config: ProviderConfig, key?: string) { super('deepl', config, key); }

  async translate(request: TranslationRequest, signal: AbortSignal) {
    const payload = await this.request('/v2/translate', {
      text: request.segments.map(segment => segment.text),
      source_lang: request.sourceLanguage === 'auto' ? undefined : request.sourceLanguage.toUpperCase(),
      target_lang: ({ en: 'EN-US', pt: 'PT-BR', zh: 'ZH-HANS' } as Record<string, string>)[request.targetLanguage] ?? request.targetLanguage.toUpperCase(),
    }, key => ({ Authorization: `DeepL-Auth-Key ${key}` }), signal) as { translations?: { text?: string }[] };
    return orderedTexts(request, payload.translations?.map(item => item.text));
  }
}
