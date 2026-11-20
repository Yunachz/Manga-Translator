import type { ProviderConfig, TranslationRequest } from '../../types/contracts';
import { CloudProvider } from './CloudProvider';
import { orderedTexts } from './segments';

const azureLanguage = (tag: string) => tag === 'zh' ? 'zh-Hans' : tag;

export class AzureProvider extends CloudProvider {
  constructor(config: ProviderConfig, key?: string) { super('azure', config, key); }

  async translate(request: TranslationRequest, signal: AbortSignal) {
    const query = new URLSearchParams({ 'api-version': '3.0', to: azureLanguage(request.targetLanguage) });
    if (request.sourceLanguage !== 'auto') query.set('from', azureLanguage(request.sourceLanguage));
    const payload = await this.request(`/translate?${query}`, request.segments.map(segment => ({ Text: segment.text })), key => {
      const headers: Record<string, string> = { 'Ocp-Apim-Subscription-Key': key };
      if (this.config.region) headers['Ocp-Apim-Subscription-Region'] = this.config.region;
      return headers;
    }, signal) as { translations?: { text?: string }[] }[];
    return orderedTexts(request, Array.isArray(payload) ? payload.map(item => item.translations?.[0]?.text) : undefined);
  }
}
