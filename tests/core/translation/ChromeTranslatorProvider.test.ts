import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChromeTranslatorProvider, chromeAvailability, nativeTranslator, prepareChromeTranslator,
} from '../../../src/core/translation/ChromeTranslatorProvider';
import { errorDetails } from '../../../src/core/pipeline/PipelineError';
import type { TranslationRequest } from '../../../src/types/contracts';

const request: TranslationRequest = {
  sourceLanguage: 'ja', targetLanguage: 'en',
  segments: [{ id: 'a', text: '行こう！' }, { id: 'b', text: '星が見える。' }],
};

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

function stubTranslator(options: { availability?: Availability | Error; translate?: (text: string) => Promise<string>; create?: () => Promise<void> } = {}) {
  const destroy = vi.fn();
  const translate = vi.fn(options.translate ?? (async (text: string) => `T:${text}`));
  const create = vi.fn(async (_pair: unknown) => { await options.create?.(); return { translate, destroy }; });
  const availability = vi.fn(async (_pair: unknown) => {
    if (options.availability instanceof Error) throw options.availability;
    return options.availability ?? 'available';
  });
  vi.stubGlobal('Translator', { create, availability });
  return { create, availability, translate, destroy };
}

afterEach(() => vi.unstubAllGlobals());

describe('nativeTranslator / chromeAvailability', () => {
  it('is undefined when the API is missing or incomplete', () => {
    expect(nativeTranslator()).toBeUndefined();
    vi.stubGlobal('Translator', { create: () => undefined });
    expect(nativeTranslator()).toBeUndefined();
  });

  it('reports unavailable without the API and available without a pair when the API exists', async () => {
    expect(await chromeAvailability({ sourceLanguage: 'ja', targetLanguage: 'en' })).toBe('unavailable');
    stubTranslator();
    expect(await chromeAvailability()).toBe('available');
  });

  it('never asks the browser about an auto source', async () => {
    const { availability } = stubTranslator();
    expect(await chromeAvailability({ sourceLanguage: 'auto', targetLanguage: 'en' })).toBe('unavailable');
    expect(availability).not.toHaveBeenCalled();
  });

  it.each(['available', 'downloadable', 'downloading', 'unavailable'] as const)('relays %s for a language pair', async state => {
    const { availability } = stubTranslator({ availability: state });
    expect(await chromeAvailability({ sourceLanguage: 'ja', targetLanguage: 'en' })).toBe(state);
    expect(availability).toHaveBeenCalledWith({ sourceLanguage: 'ja', targetLanguage: 'en' });
  });

  it('treats a throwing availability() as unavailable', async () => {
    stubTranslator({ availability: new Error('denied') });
    expect(await chromeAvailability({ sourceLanguage: 'ja', targetLanguage: 'en' })).toBe('unavailable');
  });
});

describe('prepareChromeTranslator', () => {
  it('creates and immediately destroys a translator to trigger the pack download', async () => {
    const { create, destroy } = stubTranslator();
    await prepareChromeTranslator({ sourceLanguage: 'ja', targetLanguage: 'en' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('fails with PROVIDER_UNAVAILABLE without the API or when create() throws', async () => {
    await expect(prepareChromeTranslator({ sourceLanguage: 'ja', targetLanguage: 'en' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    stubTranslator({ create: async () => { throw new Error('needs gesture'); } });
    await expect(prepareChromeTranslator({ sourceLanguage: 'ja', targetLanguage: 'en' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('ChromeTranslatorProvider', () => {
  const provider = new ChromeTranslatorProvider();
  const signal = () => new AbortController().signal;

  it('is a local, keyless provider without context support', () => {
    expect(provider).toMatchObject({ id: 'chrome', type: 'local', requiresApiKey: false, supportsContext: false });
  });

  it('translates every segment in order and returns them by ID', async () => {
    const { create, translate, destroy } = stubTranslator();
    const result = await provider.translate(request, signal());
    expect(result.segments).toEqual([{ id: 'a', text: 'T:行こう！' }, { id: 'b', text: 'T:星が見える。' }]);
    expect(translate.mock.calls.map(call => call[0])).toEqual(['行こう！', '星が見える。']);
    expect(create.mock.calls[0][0]).toMatchObject({ sourceLanguage: 'ja', targetLanguage: 'en' });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('translates sequentially, never in parallel', async () => {
    let running = 0;
    let peak = 0;
    stubTranslator({ translate: async text => { peak = Math.max(peak, ++running); await Promise.resolve(); running--; return text; } });
    await provider.translate(request, signal());
    expect(peak).toBe(1);
  });

  it('destroys the translator even when a segment fails', async () => {
    const { destroy } = stubTranslator({ translate: async () => { throw new Error('model crashed'); } });
    await expect(provider.translate(request, signal())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('reports PROVIDER_UNAVAILABLE without the API', async () => {
    await expect(provider.translate(request, signal())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('reports cancellation, not "unavailable", when aborted', async () => {
    const controller = new AbortController();
    stubTranslator({ translate: async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); } });
    const error = await provider.translate(request, controller.signal).catch(reason => reason);
    expect(errorDetails(error).code).toBe('CANCELLED');
  });

  it('rejects an empty translation as invalid', async () => {
    stubTranslator({ translate: async () => '' });
    await expect(provider.translate(request, signal())).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
  });

  it('isAvailable follows the pair availability', async () => {
    expect(await provider.isAvailable(request)).toBe(false);
    stubTranslator({ availability: 'downloadable' });
    expect(await provider.isAvailable(request)).toBe(true);
    stubTranslator({ availability: 'unavailable' });
    expect(await provider.isAvailable(request)).toBe(false);
    expect(await provider.isAvailable()).toBe(true);
  });
});
