import type { TranslationRequest, TranslationResult } from '../../types/contracts';
import { PipelineError } from '../pipeline/PipelineError';
import { orderedTexts } from './segments';
import type { TranslatorProvider } from './TranslatorProvider';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
interface Pair { sourceLanguage: string; targetLanguage: string }
interface NativeTranslator { translate(text: string, options?: { signal?: AbortSignal }): Promise<string>; destroy(): void }
interface TranslatorApi {
  availability(pair: Pair): Promise<Availability>;
  create(pair: Pair & { signal?: AbortSignal }): Promise<NativeTranslator>;
}

export function nativeTranslator(): TranslatorApi | undefined {
  const api = (globalThis as typeof globalThis & { Translator?: TranslatorApi }).Translator;
  return api && typeof api.create === 'function' && typeof api.availability === 'function' ? api : undefined;
}

export async function chromeAvailability(pair?: Pair): Promise<Availability> {
  const api = nativeTranslator();
  if (!api) return 'unavailable';
  if (!pair) return 'available';
  if (pair.sourceLanguage === 'auto') return 'unavailable';
  return api.availability(pair).catch(() => 'unavailable');
}

export async function prepareChromeTranslator(pair: Pair): Promise<void> {
  const api = nativeTranslator();
  if (!api) throw chromeUnavailable();
  try {
    const instance = await api.create(pair);
    instance.destroy();
  } catch {
    throw chromeUnavailable();
  }
}

export function chromeUnavailable(): PipelineError {
  return new PipelineError('PROVIDER_UNAVAILABLE', 'Chrome Translator belum siap untuk pasangan bahasa ini. Coba siapkan di Pengaturan atau pilih provider lain.');
}

export class ChromeTranslatorProvider implements TranslatorProvider {
  readonly id = 'chrome';
  readonly name = 'Chrome Translator';
  readonly type = 'local';
  readonly requiresApiKey = false;
  readonly supportsContext = false;

  async isAvailable(request?: TranslationRequest): Promise<boolean> {
    return await chromeAvailability(request) !== 'unavailable';
  }

  async translate(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResult> {
    const api = nativeTranslator();
    if (!api) throw chromeUnavailable();
    let instance: NativeTranslator | undefined;
    try {
      instance = await api.create({ sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage, signal });
      const translations: string[] = [];
      for (const segment of request.segments) translations.push(await instance.translate(segment.text, { signal }));
      return orderedTexts(request, translations);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof PipelineError) throw error;
      throw chromeUnavailable();
    } finally {
      instance?.destroy();
    }
  }
}
