import type { ProviderConfig, TranslationRequest } from '../../types/contracts';
import { CloudProvider } from './CloudProvider';
import { orderedTexts } from './segments';

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, key: string) => {
    if (!key.startsWith('#')) return entities[key] ?? entity;
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

export class GoogleCloudProvider extends CloudProvider {
  constructor(config: ProviderConfig, key?: string) { super('google', config, key); }

  async translate(request: TranslationRequest, signal: AbortSignal) {
    const payload = await this.request('/language/translate/v2', {
      q: request.segments.map(segment => segment.text),
      source: request.sourceLanguage === 'auto' ? undefined : request.sourceLanguage,
      target: request.targetLanguage, format: 'text',
    }, key => ({ 'x-goog-api-key': key }), signal) as { data?: { translations?: { translatedText?: string }[] } };
    return orderedTexts(request, payload.data?.translations?.map(item =>
      typeof item.translatedText === 'string' ? decodeEntities(item.translatedText) : undefined));
  }
}
