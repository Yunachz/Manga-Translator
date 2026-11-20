import type { ProviderId, Settings, TranslationRequest, TranslationResult } from '../../types/contracts';
import { PipelineError } from '../pipeline/PipelineError';
import { AzureProvider } from './AzureProvider';
import { DeepLProvider } from './DeepLProvider';
import { GeminiProvider } from './GeminiProvider';
import { GoogleCloudProvider } from './GoogleCloudProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { matchSegments } from './segments';
import type { TranslatorProvider } from './TranslatorProvider';

const cloud = { gemini: GeminiProvider, openai: OpenAIProvider, google: GoogleCloudProvider, deepl: DeepLProvider, azure: AzureProvider };
const samples: Record<string, string> = { ja: 'こんにちは。', ko: '안녕하세요.', zh: '你好。', en: 'Hello.' };

export class TranslatorManager {
  constructor(private readonly chromeProvider: TranslatorProvider) {}

  selected(settings: Settings, key?: string): TranslatorProvider {
    const id: ProviderId = settings.provider;
    return id === 'chrome' ? this.chromeProvider : new cloud[id](settings.providers[id], key);
  }

  async translate(settings: Settings, key: string | undefined, request: TranslationRequest, signal: AbortSignal): Promise<TranslationResult> {
    if (request.sourceLanguage === request.targetLanguage) return { segments: request.segments };
    if (!request.segments.length || request.segments.length > 50 || request.segments.some(segment => segment.text.length > 2000)) {
      throw new PipelineError('TRANSLATION_INVALID', 'Jumlah atau panjang dialog panel melebihi batas.');
    }
    const provider = this.selected(settings, key);
    const payload = { ...request, context: provider.supportsContext && settings.contextual ? request.context : undefined };
    return matchSegments(payload, await provider.translate(payload, signal));
  }

  async test(settings: Settings, key: string | undefined, signal: AbortSignal): Promise<void> {
    const sourceLanguage = settings.source === 'auto' || settings.source === settings.target
      ? settings.target === 'en' ? 'ja' : 'en' : settings.source;
    await this.translate({ ...settings, contextual: false }, key, {
      sourceLanguage, targetLanguage: settings.target, segments: [{ id: 'connection-test', text: samples[sourceLanguage] }],
    }, signal);
  }
}
