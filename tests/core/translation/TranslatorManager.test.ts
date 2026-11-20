import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AzureProvider } from '../../../src/core/translation/AzureProvider';
import { DeepLProvider } from '../../../src/core/translation/DeepLProvider';
import { GeminiProvider } from '../../../src/core/translation/GeminiProvider';
import { GoogleCloudProvider } from '../../../src/core/translation/GoogleCloudProvider';
import { OpenAIProvider } from '../../../src/core/translation/OpenAIProvider';
import { TranslatorManager } from '../../../src/core/translation/TranslatorManager';
import type { TranslatorProvider } from '../../../src/core/translation/TranslatorProvider';
import type { TranslationRequest, TranslationResult } from '../../../src/types/contracts';
import { jsonResponse, stubChromePermissions, stubFetch } from '../../support/fetch';
import { createSettings } from '../../support/settings';

const signal = () => new AbortController().signal;
const request: TranslationRequest = {
  sourceLanguage: 'ja', targetLanguage: 'en',
  segments: [{ id: 'a', text: '行こう！' }, { id: 'b', text: '星が見える。' }],
  context: { previousPanel: [{ id: 'p', text: '前' }], glossary: { 星: 'star' }, series: 'Test' },
};

function fakeLocal(translate: TranslatorProvider['translate'], supportsContext = false): TranslatorProvider & { translate: ReturnType<typeof vi.fn> } {
  return {
    id: 'chrome', name: 'fake', type: 'local', requiresApiKey: false, supportsContext,
    isAvailable: async () => true, translate: vi.fn(translate),
  };
}

const echo = async (r: TranslationRequest): Promise<TranslationResult> =>
  ({ segments: r.segments.map(segment => ({ id: segment.id, text: `T:${segment.text}` })) });

beforeEach(() => { stubChromePermissions(true); });
afterEach(() => vi.unstubAllGlobals());

describe('TranslatorManager.selected', () => {
  const manager = new TranslatorManager(fakeLocal(echo));

  it('returns the injected local provider for "chrome"', () => {
    expect(manager.selected(createSettings({ provider: 'chrome' }))).toBeInstanceOf(Object);
    expect(manager.selected(createSettings({ provider: 'chrome' })).id).toBe('chrome');
  });

  it.each([
    ['gemini', GeminiProvider], ['openai', OpenAIProvider], ['google', GoogleCloudProvider],
    ['deepl', DeepLProvider], ['azure', AzureProvider],
  ] as const)('builds the %s adapter from settings', (provider, type) => {
    const selected = manager.selected(createSettings({ provider }), 'k');
    expect(selected).toBeInstanceOf(type);
    expect(selected.id).toBe(provider);
  });
});

describe('TranslatorManager.translate', () => {
  it('short-circuits identical source and target without calling any provider', async () => {
    const local = fakeLocal(echo);
    const result = await new TranslatorManager(local).translate(createSettings(), undefined, { ...request, sourceLanguage: 'en', targetLanguage: 'en' }, signal());
    expect(result.segments).toEqual(request.segments);
    expect(local.translate).not.toHaveBeenCalled();
  });

  it('returns provider output in the request order', async () => {
    const local = fakeLocal(async r => ({ segments: [...r.segments].reverse().map(s => ({ id: s.id, text: `T:${s.text}` })) }));
    const result = await new TranslatorManager(local).translate(createSettings(), undefined, request, signal());
    expect(result.segments.map(segment => segment.id)).toEqual(['a', 'b']);
  });

  it('validates the provider answer even for the local provider', async () => {
    const local = fakeLocal(async () => ({ segments: [{ id: 'a', text: 'only one' }] }));
    await expect(new TranslatorManager(local).translate(createSettings(), undefined, request, signal()))
      .rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
  });

  it('rejects empty, oversized and over-long panels before any provider call', async () => {
    const local = fakeLocal(echo);
    const manager = new TranslatorManager(local);
    const settings = createSettings();
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, text: 'x' }));
    await expect(manager.translate(settings, undefined, { ...request, segments: [] }, signal())).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
    await expect(manager.translate(settings, undefined, { ...request, segments: many }, signal())).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
    await expect(manager.translate(settings, undefined, { ...request, segments: [{ id: 'a', text: 'x'.repeat(2001) }] }, signal())).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
    expect(local.translate).not.toHaveBeenCalled();
  });

  it('accepts the boundary values: 50 segments and 2000 characters', async () => {
    const manager = new TranslatorManager(fakeLocal(echo));
    const fifty = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, text: 'x'.repeat(i === 0 ? 2000 : 1) }));
    const result = await manager.translate(createSettings(), undefined, { ...request, segments: fifty }, signal());
    expect(result.segments).toHaveLength(50);
  });

  describe('context egress', () => {
    it('strips context when the user has not enabled it', async () => {
      const local = fakeLocal(echo, true);
      await new TranslatorManager(local).translate(createSettings({ contextual: false }), undefined, request, signal());
      expect(local.translate.mock.calls[0][0].context).toBeUndefined();
    });

    it('forwards context only to providers that support it and only when enabled', async () => {
      const supporting = fakeLocal(echo, true);
      await new TranslatorManager(supporting).translate(createSettings({ contextual: true }), undefined, request, signal());
      expect(supporting.translate.mock.calls[0][0].context).toEqual(request.context);

      const plain = fakeLocal(echo, false);
      await new TranslatorManager(plain).translate(createSettings({ contextual: true }), undefined, request, signal());
      expect(plain.translate.mock.calls[0][0].context).toBeUndefined();
    });

    it('does not mutate the caller request', async () => {
      const frozen = Object.freeze({ ...request });
      await new TranslatorManager(fakeLocal(echo)).translate(createSettings(), undefined, frozen, signal());
      expect(frozen.context).toBeDefined();
    });

    it('sends context to an LLM adapter only when enabled (wire check)', async () => {
      const llm = jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ segments: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }) }] } }] });
      const off = stubFetch(llm);
      await new TranslatorManager(fakeLocal(echo)).translate(createSettings({ provider: 'gemini', contextual: false }), 'k', request, signal());
      const payloadOff = JSON.parse((off.calls[0].body as { contents: { parts: { text: string }[] }[] }).contents[0].parts[0].text);
      expect(payloadOff).not.toHaveProperty('context');

      const on = stubFetch(llm);
      await new TranslatorManager(fakeLocal(echo)).translate(createSettings({ provider: 'gemini', contextual: true }), 'k', request, signal());
      const payloadOn = JSON.parse((on.calls[0].body as { contents: { parts: { text: string }[] }[] }).contents[0].parts[0].text);
      expect(payloadOn.context).toEqual(request.context);
    });

    it('never sends context to a machine-translation adapter, even when enabled', async () => {
      const { calls } = stubFetch(jsonResponse({ translations: [{ text: 'A' }, { text: 'B' }] }));
      await new TranslatorManager(fakeLocal(echo)).translate(createSettings({ provider: 'deepl', contextual: true }), 'k', request, signal());
      expect(JSON.stringify(calls[0].body)).not.toContain('glossary');
      expect(JSON.stringify(calls[0].body)).not.toContain('前');
    });
  });

  it('does not fall back to another provider when the selected one fails', async () => {
    const local = fakeLocal(echo);
    const { calls } = stubFetch(jsonResponse({ error: { message: 'down' } }, 500));
    await expect(new TranslatorManager(local).translate(createSettings({ provider: 'openai' }), 'k', request, signal()))
      .rejects.toMatchObject({ code: 'TRANSLATION_FAILED' });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).host).toBe('api.openai.com');
    expect(local.translate).not.toHaveBeenCalled();
  });

  it('passes the abort signal through to the provider', async () => {
    const local = fakeLocal(echo);
    const controller = new AbortController();
    await new TranslatorManager(local).translate(createSettings(), undefined, request, controller.signal);
    expect(local.translate.mock.calls[0][1]).toBe(controller.signal);
  });
});

describe('TranslatorManager.test (connection test)', () => {
  const run = async (overrides: Parameters<typeof createSettings>[0]) => {
    const local = fakeLocal(echo);
    await new TranslatorManager(local).test(createSettings(overrides), undefined, signal());
    return local.translate.mock.calls[0][0] as TranslationRequest;
  };

  it('sends one tiny fixed segment, without context', async () => {
    const sent = await run({ source: 'ja', target: 'en', contextual: true });
    expect(sent.segments).toEqual([{ id: 'connection-test', text: 'こんにちは。' }]);
    expect(sent.context).toBeUndefined();
  });

  it('uses a sample in the configured source language', async () => {
    expect((await run({ source: 'ko', target: 'id' })).segments[0].text).toBe('안녕하세요.');
    expect((await run({ source: 'zh', target: 'id' })).segments[0].text).toBe('你好。');
    expect((await run({ source: 'en', target: 'id' })).segments[0].text).toBe('Hello.');
  });

  it('picks a different sample language when source is auto or equals the target', async () => {
    expect((await run({ source: 'auto', target: 'id' })).sourceLanguage).toBe('en');
    expect((await run({ source: 'auto', target: 'en' })).sourceLanguage).toBe('ja');
    expect((await run({ source: 'en', target: 'en' })).sourceLanguage).toBe('ja');
    expect((await run({ source: 'ja', target: 'ja' })).sourceLanguage).toBe('en');
  });

  it('surfaces provider errors', async () => {
    stubFetch(jsonResponse({}, 401));
    await expect(new TranslatorManager(fakeLocal(echo)).test(createSettings({ provider: 'deepl', source: 'ja' }), 'bad', signal()))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
