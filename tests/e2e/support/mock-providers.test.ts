import { describe, expect, it } from 'vitest';
import { MOCK_API_KEY, createMockState, handleMockRequest, type MockRequest } from './mock-providers';

const segments = [{ id: 's1', text: '行こう！' }, { id: 's2', text: 'unknown line' }];
const prompt = `Translate to English. Reply with JSON only. ${JSON.stringify({ segments })}`;

function request(host: string, path: string, headers: Record<string, string>, body: unknown): MockRequest {
  return { method: 'POST', host, path, headers, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

describe('mock providers', () => {
  it('gemini: echoes ids in order with canned text', () => {
    const state = createMockState();
    const response = handleMockRequest(request('generativelanguage.googleapis.com', '/v1beta/models/m:generateContent',
      { 'x-goog-api-key': MOCK_API_KEY }, { contents: [{ parts: [{ text: prompt }] }] }), state);
    expect(response.status).toBe(200);
    const text = JSON.parse(response.body).candidates[0].content.parts[0].text;
    expect(JSON.parse(text)).toEqual({ segments: [{ id: 's1', text: "Let's go!" }, { id: 's2', text: '[mock] unknown line' }] });
    expect(state.requests[0]).toMatchObject({ provider: 'gemini', authorized: true, ids: ['s1', 's2'] });
  });

  it('openai: returns a Responses API message', () => {
    const response = handleMockRequest(request('api.openai.com', '/v1/responses', { authorization: `Bearer ${MOCK_API_KEY}` },
      { model: 'm', input: prompt, store: false }), createMockState());
    const content = JSON.parse(JSON.parse(response.body).output[0].content[0].text);
    expect(content.segments.map((s: { id: string }) => s.id)).toEqual(['s1', 's2']);
  });

  it('google v2: maps q[] to translatedText[]', () => {
    const response = handleMockRequest(request('translation.googleapis.com', `/language/translate/v2?key=${MOCK_API_KEY}`, {},
      { q: ['行こう！'], target: 'en', format: 'text' }), createMockState());
    expect(JSON.parse(response.body)).toEqual({ data: { translations: [{ translatedText: "Let's go!" }] } });
  });

  it('deepl: accepts form bodies on both tiers', () => {
    for (const host of ['api-free.deepl.com', 'api.deepl.com']) {
      const response = handleMockRequest(request(host, '/v2/translate', { authorization: `DeepL-Auth-Key ${MOCK_API_KEY}` },
        'text=%E8%A1%8C%E3%81%93%E3%81%86%EF%BC%81&target_lang=EN'), createMockState());
      expect(JSON.parse(response.body).translations[0].text).toBe("Let's go!");
    }
  });

  it('azure: maps [{Text}] to translations', () => {
    const response = handleMockRequest(request('api.cognitive.microsofttranslator.com', '/translate?api-version=3.0&to=en',
      { 'ocp-apim-subscription-key': MOCK_API_KEY }, [{ Text: '波が高い。' }]), createMockState());
    expect(JSON.parse(response.body)).toEqual([{ translations: [{ text: 'The waves are high.', to: 'en' }] }]);
  });

  it('rejects any key other than the sentinel, so a real key would never be accepted or recorded', () => {
    const state = createMockState();
    const response = handleMockRequest(request('api.openai.com', '/v1/responses', { authorization: 'Bearer sk-real-looking' },
      { input: prompt }), state);
    expect(response.status).toBe(401);
    expect(JSON.stringify(state.requests)).not.toContain('sk-real-looking');
    expect(state.requests[0].authorized).toBe(false);
  });

  it('redacts a query-string key in the recorded path', () => {
    const state = createMockState();
    handleMockRequest(request('translation.googleapis.com', '/language/translate/v2?key=abc123&x=1', {}, { q: ['a'] }), state);
    expect(state.requests[0].path).toBe('/language/translate/v2?key=<redacted>&x=1');
  });

  it('returns 404 for hosts that are not translation providers', () => {
    expect(handleMockRequest(request('example.com', '/', {}, {}), createMockState()).status).toBe(404);
  });

  it('applies per-provider and wildcard scenarios', () => {
    const state = createMockState();
    const call = (host: string, headers: Record<string, string>, body: unknown) =>
      handleMockRequest(request(host, '/v2/translate', headers, body), state);
    const deepl = { authorization: `DeepL-Auth-Key ${MOCK_API_KEY}` };

    state.scenarios.set('deepl', { kind: 'error', status: 429, retryAfterSeconds: 7 });
    const limited = call('api.deepl.com', deepl, { text: ['a'] });
    expect(limited.status).toBe(429);
    expect(limited.headers['Retry-After']).toBe('7');

    state.scenarios.set('deepl', { kind: 'malformed' });
    expect(() => JSON.parse(call('api.deepl.com', deepl, { text: ['a'] }).body)).toThrow();

    state.scenarios.set('deepl', { kind: 'delay', ms: 250 });
    const slow = call('api.deepl.com', deepl, { text: ['a'] });
    expect(slow.delayMs).toBe(250);
    expect(slow.status).toBe(200);

    state.scenarios.clear();
    state.scenarios.set('*', { kind: 'error', status: 500 });
    expect(call('api.deepl.com', deepl, { text: ['a'] }).status).toBe(500);
  });

  it('lets a provider scenario override the wildcard', () => {
    const state = createMockState();
    state.scenarios.set('*', { kind: 'error', status: 500 });
    state.scenarios.set('azure', { kind: 'success' });
    const response = handleMockRequest(request('api.cognitive.microsofttranslator.com', '/translate',
      { 'ocp-apim-subscription-key': MOCK_API_KEY }, [{ Text: 'x' }]), state);
    expect(response.status).toBe(200);
  });

  it('answers CORS preflight without recording it', () => {
    const state = createMockState();
    const response = handleMockRequest({ method: 'OPTIONS', host: 'api.openai.com', path: '/v1/responses', headers: {}, body: '' }, state);
    expect(response.status).toBe(204);
    expect(state.requests).toEqual([]);
  });
});
