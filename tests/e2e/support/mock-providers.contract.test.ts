import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslatorManager } from '../../../src/core/translation/TranslatorManager';
import type { TranslationRequest } from '../../../src/types/contracts';
import { stubChromePermissions } from '../../support/fetch';
import { createSettings } from '../../support/settings';
import { MOCK_API_KEY, createMockState, handleMockRequest, type MockState } from './mock-providers';

/**
 * Runs the real adapters against the e2e mock without sockets or a browser. If an adapter changes
 * its wire format, this fails before the Playwright suite does.
 */

const request: TranslationRequest = {
  sourceLanguage: 'ja', targetLanguage: 'en',
  segments: [{ id: 'a', text: '行こう！' }, { id: 'b', text: '星が見える。' }],
};

let state: MockState;

beforeEach(() => {
  state = createMockState();
  stubChromePermissions(true);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    const mock = handleMockRequest({ method: init.method ?? 'GET', host: url.host, path: url.pathname + url.search, headers, body: String(init.body ?? '') }, state);
    return new Response(mock.body, { status: mock.status, headers: mock.headers });
  });
});
afterEach(() => vi.unstubAllGlobals());

const manager = new TranslatorManager({
  id: 'chrome', name: 'unused', type: 'local', requiresApiKey: false, supportsContext: false,
  isAvailable: async () => true, translate: async () => { throw new Error('local provider must not run'); },
});

describe.each(['gemini', 'openai', 'google', 'deepl', 'azure'] as const)('adapter %s against the e2e mock', provider => {
  const run = (key = MOCK_API_KEY) => manager.translate(createSettings({ provider }), key, request, new AbortController().signal);

  it('gets the canned translations back by ID', async () => {
    const result = await run();
    expect(result.segments).toEqual([{ id: 'a', text: "Let's go!" }, { id: 'b', text: 'I can see the stars.' }]);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toMatchObject({ provider, authorized: true, texts: ['行こう！', '星が見える。'] });
  });

  it('is refused with UNAUTHORIZED for any other key, which proves the mock sees the real header', async () => {
    await expect(run('another-key')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(state.requests[0].authorized).toBe(false);
  });

  it('maps scripted failures onto typed errors', async () => {
    state.scenarios.set(provider, { kind: 'error', status: 429, retryAfterSeconds: 3 });
    await expect(run()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    state.scenarios.set(provider, { kind: 'error', status: 500 });
    await expect(run()).rejects.toMatchObject({ code: 'TRANSLATION_FAILED' });
    state.scenarios.set(provider, { kind: 'malformed' });
    await expect(run()).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
  });
});
