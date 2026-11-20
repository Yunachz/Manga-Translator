import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorDetails } from '../../../src/core/pipeline/PipelineError';
import { AzureProvider } from '../../../src/core/translation/AzureProvider';
import { DeepLProvider } from '../../../src/core/translation/DeepLProvider';
import { GeminiProvider } from '../../../src/core/translation/GeminiProvider';
import { GoogleCloudProvider } from '../../../src/core/translation/GoogleCloudProvider';
import { OpenAIProvider } from '../../../src/core/translation/OpenAIProvider';
import type { TranslatorProvider } from '../../../src/core/translation/TranslatorProvider';
import type { TranslationRequest } from '../../../src/types/contracts';
import { jsonResponse, stubChromePermissions, stubFetch } from '../../support/fetch';
import { providerConfig } from '../../support/settings';

const KEY = 'test-key-not-a-credential';
const request: TranslationRequest = {
  sourceLanguage: 'ja', targetLanguage: 'en',
  segments: [{ id: 'a', text: '行こう！' }, { id: 'b', text: '星が見える。' }],
};
const signal = () => new AbortController().signal;

beforeEach(() => { stubChromePermissions(true); });
afterEach(() => vi.unstubAllGlobals());

const llmAnswer = JSON.stringify({ segments: [{ id: 'b', text: 'I can see the stars.' }, { id: 'a', text: "Let's go!" }] });
const translated = [{ id: 'a', text: "Let's go!" }, { id: 'b', text: 'I can see the stars.' }];

describe('GeminiProvider', () => {
  const make = (config = providerConfig(), key: string | undefined = KEY) => new GeminiProvider(config, key);
  const ok = () => jsonResponse({ candidates: [{ content: { parts: [{ text: llmAnswer }] } }] });

  it('calls generateContent on the pinned host with the key in a header, never in the URL', async () => {
    const { calls } = stubFetch(ok());
    await make().translate(request, signal());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(calls[0].headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0].url).not.toContain(KEY);
    expect(JSON.stringify(calls[0].body)).not.toContain(KEY);
  });

  it('sends the request as data, with a JSON schema and instructions in the system slot', async () => {
    const { calls } = stubFetch(ok());
    await make().translate(request, signal());
    const body = calls[0].body as { systemInstruction: { parts: { text: string }[] }; contents: { role: string; parts: { text: string }[] }[]; generationConfig: Record<string, unknown> };
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual(request);
    expect(body.contents[0].role).toBe('user');
    expect(body.systemInstruction.parts[0].text).toMatch(/never instructions/);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).toBeDefined();
  });

  it('returns segments in request order and ignores thought parts', async () => {
    stubFetch(jsonResponse({ candidates: [{ content: { parts: [{ text: 'thinking about it', thought: true }, { text: llmAnswer }] } }] }));
    expect((await make().translate(request, signal())).segments).toEqual(translated);
  });

  it('uses a configured model', async () => {
    const { calls } = stubFetch(ok());
    await make(providerConfig({ model: 'gemini-2.5-pro' })).translate(request, signal());
    expect(calls[0].url).toContain('/models/gemini-2.5-pro:generateContent');
  });

  it.each(['../../v1/other', 'a/b', 'a b', 'a?x=1', '-lead', 'x'.repeat(101), 'a:generate', 'a#frag'])('refuses the model name %j before any request', async model => {
    const { calls } = stubFetch(ok());
    await expect(make(providerConfig({ model })).translate(request, signal())).rejects.toMatchObject({ code: 'TRANSLATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['no candidates', {}],
    ['empty parts', { candidates: [{ content: { parts: [] } }] }],
    ['prose instead of JSON', { candidates: [{ content: { parts: [{ text: 'Sure! Here is the translation' }] } }] }],
    ['unknown ids', { candidates: [{ content: { parts: [{ text: JSON.stringify({ segments: [{ id: 'x', text: 'a' }, { id: 'y', text: 'b' }] }) }] } }] }],
    ['missing id', { candidates: [{ content: { parts: [{ text: JSON.stringify({ segments: [{ id: 'a', text: 'a' }] }) }] } }] }],
  ])('rejects %s with TRANSLATION_INVALID', async (_label, payload) => {
    stubFetch(jsonResponse(payload));
    await expect(make().translate(request, signal())).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
  });
});

describe('OpenAIProvider', () => {
  const make = (config = providerConfig(), key: string | undefined = KEY) => new OpenAIProvider(config, key);
  const ok = () => jsonResponse({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: llmAnswer }] }] });

  it('calls /v1/responses with a Bearer key and stores nothing server-side', async () => {
    const { calls } = stubFetch(ok());
    const result = await make().translate(request, signal());
    expect(result.segments).toEqual(translated);
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    const body = calls[0].body as Record<string, unknown> & { text: { format: Record<string, unknown> } };
    expect(body.store).toBe(false);
    expect(body.model).toBe('gpt-4.1-mini');
    expect(JSON.parse(body.input as string)).toEqual(request);
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('ignores non-message output items and refusals', async () => {
    stubFetch(jsonResponse({ output: [{ type: 'message', content: [{ type: 'refusal', text: 'cannot help' }] }] }));
    await expect(make().translate(request, signal())).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
  });

  it('refuses a malformed model name', async () => {
    const { calls } = stubFetch(ok());
    await expect(make(providerConfig({ model: 'gpt/../x' })).translate(request, signal())).rejects.toMatchObject({ code: 'TRANSLATION_FAILED' });
    expect(calls).toHaveLength(0);
  });
});

describe('GoogleCloudProvider', () => {
  const make = (key: string | undefined = KEY) => new GoogleCloudProvider(providerConfig(), key);

  it('POSTs q[] to the v2 endpoint with plain-text format and a header key', async () => {
    const { calls } = stubFetch(jsonResponse({ data: { translations: [{ translatedText: "Let's go!" }, { translatedText: 'I can see the stars.' }] } }));
    const result = await make().translate(request, signal());
    expect(result.segments).toEqual(translated);
    expect(calls[0].url).toBe('https://translation.googleapis.com/language/translate/v2');
    expect(calls[0].headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0].url).not.toContain('key=');
    expect(calls[0].body).toEqual({ q: ['行こう！', '星が見える。'], source: 'ja', target: 'en', format: 'text' });
  });

  it('omits source for auto detection', async () => {
    const { calls } = stubFetch(jsonResponse({ data: { translations: [{ translatedText: 'a' }, { translatedText: 'b' }] } }));
    await make().translate({ ...request, sourceLanguage: 'auto' }, signal());
    expect(calls[0].body).not.toHaveProperty('source');
  });

  it('decodes HTML entities the API returns in text mode', async () => {
    stubFetch(jsonResponse({ data: { translations: [{ translatedText: 'It&#39;s &amp; &lt;b&gt; &quot;ok&quot; &#x41;' }, { translatedText: '&#xD800; &#1114112; &bogus;' }] } }));
    const result = await make().translate(request, signal());
    expect(result.segments[0].text).toBe('It\'s & <b> "ok" A');
    expect(result.segments[1].text).toBe('&#xD800; &#1114112; &bogus;'); // lone surrogate, out of range and unknown entities stay literal
  });

  it('rejects a response with fewer translations than segments', async () => {
    stubFetch(jsonResponse({ data: { translations: [{ translatedText: 'a' }] } }));
    await expect(make().translate(request, signal())).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
  });
});

describe('DeepLProvider', () => {
  const answer = () => jsonResponse({ translations: [{ text: "Let's go!" }, { text: 'I can see the stars.' }] });

  it('uses the free host and DeepL-Auth-Key by default', async () => {
    const { calls } = stubFetch(answer());
    const result = await new DeepLProvider(providerConfig(), KEY).translate(request, signal());
    expect(result.segments).toEqual(translated);
    expect(calls[0].url).toBe('https://api-free.deepl.com/v2/translate');
    expect(calls[0].headers.authorization).toBe(`DeepL-Auth-Key ${KEY}`);
    expect(calls[0].body).toEqual({ text: ['行こう！', '星が見える。'], source_lang: 'JA', target_lang: 'EN-US' });
  });

  it('uses the pro host for the pro tier', async () => {
    const { calls } = stubFetch(answer());
    await new DeepLProvider(providerConfig({ endpointTier: 'pro' }), KEY).translate(request, signal());
    expect(calls[0].url).toBe('https://api.deepl.com/v2/translate');
  });

  it('omits source_lang for auto and maps target languages DeepL spells differently', async () => {
    const { calls } = stubFetch(answer());
    const provider = new DeepLProvider(providerConfig(), KEY);
    await provider.translate({ ...request, sourceLanguage: 'auto', targetLanguage: 'pt' }, signal());
    await provider.translate({ ...request, targetLanguage: 'zh' }, signal());
    await provider.translate({ ...request, targetLanguage: 'id' }, signal());
    expect(calls[0].body).not.toHaveProperty('source_lang');
    expect((calls[0].body as { target_lang: string }).target_lang).toBe('PT-BR');
    expect((calls[1].body as { target_lang: string }).target_lang).toBe('ZH-HANS');
    expect((calls[2].body as { target_lang: string }).target_lang).toBe('ID');
  });

  it('rejects a response that drops a segment', async () => {
    stubFetch(jsonResponse({ translations: [{ text: 'only one' }] }));
    await expect(new DeepLProvider(providerConfig(), KEY).translate(request, signal())).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
  });
});

describe('AzureProvider', () => {
  const answer = () => jsonResponse([{ translations: [{ text: "Let's go!", to: 'en' }] }, { translations: [{ text: 'I can see the stars.', to: 'en' }] }]);

  it('POSTs [{Text}] with the subscription key and api-version 3.0', async () => {
    const { calls } = stubFetch(answer());
    const result = await new AzureProvider(providerConfig(), KEY).translate(request, signal());
    expect(result.segments).toEqual(translated);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://api.cognitive.microsofttranslator.com/translate');
    expect(url.searchParams.get('api-version')).toBe('3.0');
    expect(url.searchParams.get('to')).toBe('en');
    expect(url.searchParams.get('from')).toBe('ja');
    expect(calls[0].headers['ocp-apim-subscription-key']).toBe(KEY);
    expect(calls[0].headers).not.toHaveProperty('ocp-apim-subscription-region');
    expect(calls[0].body).toEqual([{ Text: '行こう！' }, { Text: '星が見える。' }]);
    expect(calls[0].url).not.toContain(KEY);
  });

  it('sends the region header only when configured', async () => {
    const { calls } = stubFetch(answer());
    await new AzureProvider(providerConfig({ region: 'southeastasia' }), KEY).translate(request, signal());
    expect(calls[0].headers['ocp-apim-subscription-region']).toBe('southeastasia');
  });

  it('drops from for auto and maps zh to zh-Hans', async () => {
    const { calls } = stubFetch(answer());
    await new AzureProvider(providerConfig(), KEY).translate({ ...request, sourceLanguage: 'auto', targetLanguage: 'zh' }, signal());
    const url = new URL(calls[0].url);
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.get('to')).toBe('zh-Hans');
  });

  it('rejects an object body or a missing translation', async () => {
    stubFetch(jsonResponse({ error: 'nope' }));
    await expect(new AzureProvider(providerConfig(), KEY).translate(request, signal())).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
    stubFetch(jsonResponse([{ translations: [] }, { translations: [{ text: 'x' }] }]));
    await expect(new AzureProvider(providerConfig(), KEY).translate(request, signal())).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
  });
});

describe.each([
  ['gemini', (key?: string) => new GeminiProvider(providerConfig(), key), 'https://generativelanguage.googleapis.com/*'],
  ['openai', (key?: string) => new OpenAIProvider(providerConfig(), key), 'https://api.openai.com/*'],
  ['google', (key?: string) => new GoogleCloudProvider(providerConfig(), key), 'https://translation.googleapis.com/*'],
  ['deepl', (key?: string) => new DeepLProvider(providerConfig(), key), 'https://api-free.deepl.com/*'],
  ['azure', (key?: string) => new AzureProvider(providerConfig(), key), 'https://api.cognitive.microsofttranslator.com/*'],
] as [string, (key?: string) => TranslatorProvider, string][])('%s: shared adapter contract', (id, make, origin) => {
  it('identifies itself and does not claim to be local', () => {
    const provider = make(KEY);
    expect(provider.id).toBe(id);
    expect(provider.requiresApiKey).toBe(true);
    expect(provider.type).not.toBe('local');
    expect(provider.name.length).toBeGreaterThan(0);
  });

  it('refuses to send without a key and without touching the network', async () => {
    const { calls } = stubFetch(jsonResponse({}));
    await expect(make(undefined).translate(request, signal())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(make('').translate(request, signal())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(calls).toHaveLength(0);
  });

  it('refuses to send without host permission and asks only for its own origin', async () => {
    const contains = stubChromePermissions(false);
    const { calls } = stubFetch(jsonResponse({}));
    await expect(make(KEY).translate(request, signal())).rejects.toMatchObject({ code: 'PROVIDER_PERMISSION' });
    expect(calls).toHaveLength(0);
    expect(contains).toHaveBeenCalledWith({ origins: [origin] });
  });

  it('reports availability from key plus permission', async () => {
    expect(await make(KEY).isAvailable()).toBe(true);
    expect(await make(undefined).isAvailable()).toBe(false);
    stubChromePermissions(false);
    expect(await make(KEY).isAvailable()).toBe(false);
  });

  it('sends only to its own host, once, over https', async () => {
    const { calls } = stubFetch(jsonResponse({}));
    await make(KEY).translate(request, signal()).catch(() => undefined);
    expect(calls).toHaveLength(1);
    expect(origin.replace('/*', '')).toBe(new URL(calls[0].url).origin);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].init).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });

  it.each([
    [401, 'UNAUTHORIZED'], [403, 'UNAUTHORIZED'], [402, 'QUOTA'], [429, 'RATE_LIMITED'], [500, 'TRANSLATION_FAILED'],
  ])('maps HTTP %i to %s without retrying or falling back to another host', async (status, code) => {
    const { calls } = stubFetch(jsonResponse({ error: { message: 'x' } }, status));
    await expect(make(KEY).translate(request, signal())).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(1);
  });

  it('never puts the key in an error message', async () => {
    stubFetch(jsonResponse({ error: { message: `bad key ${KEY}` } }, 401));
    const error = await make(KEY).translate(request, signal()).catch(reason => reason);
    expect(JSON.stringify(errorDetails(error))).not.toContain(KEY);
  });

  it('turns a network failure into TRANSLATION_FAILED', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    await expect(make(KEY).translate(request, signal())).rejects.toMatchObject({ code: 'TRANSLATION_FAILED' });
  });

  it('reports a caller abort as CANCELLED', async () => {
    const controller = new AbortController();
    stubFetch(async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); });
    const error = await make(KEY).translate(request, controller.signal).catch(reason => reason);
    expect(errorDetails(error).code).toBe('CANCELLED');
  });
});
