import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorDetails, PipelineError } from '../../../src/core/pipeline/PipelineError';
import { postJson, providerHttpError } from '../../../src/core/translation/http';
import { jsonResponse, stubFetch } from '../../support/fetch';

afterEach(() => vi.unstubAllGlobals());

describe('providerHttpError', () => {
  it.each([401, 403])('maps HTTP %i to UNAUTHORIZED', status => {
    expect(providerHttpError(status, null).code).toBe('UNAUTHORIZED');
  });

  it.each([402, 456])('maps HTTP %i to QUOTA', status => {
    expect(providerHttpError(status, null).code).toBe('QUOTA');
  });

  it('maps a bare 429 to RATE_LIMITED', () => {
    expect(providerHttpError(429, {}).code).toBe('RATE_LIMITED');
    expect(providerHttpError(429, { error: { message: 'Too many requests' } }).code).toBe('RATE_LIMITED');
  });

  it('maps a 429 with a quota message to QUOTA, not RATE_LIMITED', () => {
    expect(providerHttpError(429, { error: { message: 'You exceeded your current quota, please check your plan' } }).code).toBe('QUOTA');
    expect(providerHttpError(429, { error: { type: 'insufficient_quota' } }).code).toBe('QUOTA');
  });

  it('maps unauthorized-looking bodies on non-401 statuses', () => {
    expect(providerHttpError(400, { error: { message: 'Incorrect API key invalid api key provided' } }).code).toBe('UNAUTHORIZED');
  });

  it.each([400, 404, 500, 503])('maps HTTP %i to TRANSLATION_FAILED with the status in the message', status => {
    const error = providerHttpError(status, { error: { message: 'boom' } });
    expect(error.code).toBe('TRANSLATION_FAILED');
    expect(error.message).toContain(String(status));
  });

  it('never echoes the provider body into the user-visible message', () => {
    const error = providerHttpError(500, { error: { message: 'secret sk-live-123 in provider text' }, message: 'secret sk-live-123' });
    expect(error.message).not.toContain('sk-live-123');
  });

  it('copes with non-object payloads', () => {
    expect(providerHttpError(500, 'plain text').code).toBe('TRANSLATION_FAILED');
    expect(providerHttpError(500, undefined).code).toBe('TRANSLATION_FAILED');
  });

  // Regression: Google AI Studio answers a bad key with HTTP 400 and "API key not valid. Please pass a
  // valid API key." (status INVALID_ARGUMENT). It must surface as UNAUTHORIZED.
  it('maps the Gemini bad-key 400 to UNAUTHORIZED', () => {
    const payload = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } };
    expect(providerHttpError(400, payload).code).toBe('UNAUTHORIZED');
  });
});

describe('postJson', () => {
  const url = 'https://api.example.test/v1/translate';

  it('POSTs JSON with credentials omitted, redirects refused and caching off', async () => {
    const { calls } = stubFetch(jsonResponse({ ok: true }));
    const payload = await postJson(url, { a: 1 }, { 'X-Test': 'yes' }, new AbortController().signal);
    expect(payload).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url, method: 'POST', body: { a: 1 } });
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(calls[0].headers['x-test']).toBe('yes');
    expect(calls[0].init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
  });

  it('lets caller headers override the default content type only on purpose', async () => {
    const { calls } = stubFetch(jsonResponse({}));
    await postJson(url, {}, { Authorization: 'Bearer k' }, new AbortController().signal);
    expect(calls[0].headers.authorization).toBe('Bearer k');
  });

  it('turns an HTTP error into a typed PipelineError', async () => {
    stubFetch(jsonResponse({ error: { message: 'nope' } }, 401));
    await expect(postJson(url, {}, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('keeps the quota/rate-limit distinction end to end', async () => {
    stubFetch(jsonResponse({ error: { message: 'exceeded your current quota' } }, 429));
    await expect(postJson(url, {}, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'QUOTA' });
    stubFetch(jsonResponse({}, 429, { 'Retry-After': '7' }));
    await expect(postJson(url, {}, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('rejects a 200 that is not JSON with TRANSLATION_INVALID', async () => {
    stubFetch(new Response('<html>captive portal</html>', { status: 200 }));
    await expect(postJson(url, {}, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
  });

  it('rejects a JSON null body', async () => {
    stubFetch(jsonResponse('null'));
    await expect(postJson(url, {}, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSLATION_INVALID' });
  });

  it('reports a network failure without leaking the underlying error text', async () => {
    stubFetch(new TypeError('getaddrinfo ENOTFOUND secret-host.internal'));
    const error = await postJson(url, {}, {}, new AbortController().signal).catch((reason: unknown) => reason) as PipelineError;
    expect(error).toBeInstanceOf(PipelineError);
    expect(error.code).toBe('TRANSLATION_FAILED');
    expect(error.message).not.toContain('secret-host');
  });

  it('reports cancellation, not a provider failure, when the caller aborts mid-request', async () => {
    const controller = new AbortController();
    stubFetch(async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); });
    const error = await postJson(url, {}, {}, controller.signal).catch(reason => reason);
    expect(errorDetails(error).code).toBe('CANCELLED');
  });

  it('passes a signal that follows the caller signal', async () => {
    const controller = new AbortController();
    const { calls } = stubFetch(jsonResponse({}));
    await postJson(url, {}, {}, controller.signal);
    const signal = calls[0].init.signal!;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('reports cancellation when the caller had already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(async () => { throw new DOMException('aborted', 'AbortError'); });
    const error = await postJson(url, {}, {}, controller.signal).catch(reason => reason);
    expect(errorDetails(error).code).toBe('CANCELLED');
  });
});
