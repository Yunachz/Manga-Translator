/**
 * Offline stand-ins for the five cloud translation APIs. Pure request -> response logic, no sockets,
 * so it is unit-tested in tests/e2e/support/mock-providers.test.ts and reused by the HTTPS wrapper.
 *
 * The request and response shapes follow the adapters in src/core/translation (OpenAI uses the Responses
 * API, Gemini generateContent, the rest their v2/v3 REST forms). mock-providers.contract.test.ts drives the
 * real adapters through this module, so a drift in either side fails a unit test before any browser run.
 */

export const MOCK_API_KEY = 'mock-key-not-a-credential';

export type MockProviderId = 'gemini' | 'openai' | 'google' | 'deepl' | 'azure';

export const providerHosts: Record<string, MockProviderId> = {
  'generativelanguage.googleapis.com': 'gemini',
  'api.openai.com': 'openai',
  'translation.googleapis.com': 'google',
  'api-free.deepl.com': 'deepl',
  'api.deepl.com': 'deepl',
  'api.cognitive.microsofttranslator.com': 'azure',
};

/** Canned translations for the bubble text baked into tests/fixtures/page-{a,b}.png. */
export const canned: Record<string, string> = {
  '行こう！': "Let's go!",
  '星が見える。': 'I can see the stars.',
  '船が来た！': 'A ship is coming!',
  '波が高い。': 'The waves are high.',
  'THE LIGHT IS ON.': 'The light is on.',
  'WAIT FOR ME!': 'Wait for me!',
  'OVER HERE!': 'Over here!',
};

export function cannedTranslation(text: string): string {
  return canned[text.trim()] ?? `[mock] ${text}`;
}

export type Scenario =
  | { kind: 'success' }
  | { kind: 'error'; status: number; retryAfterSeconds?: number }
  | { kind: 'malformed' }
  | { kind: 'delay'; ms: number };

export interface MockRequest {
  method: string;
  host: string;
  /** Path with query string. */
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
}

/** What tests may assert on. Never contains the API key, only whether it matched. */
export interface RecordedRequest {
  provider: MockProviderId;
  method: string;
  path: string;
  authorized: boolean;
  texts: string[];
  ids: string[];
}

export interface MockState {
  scenarios: Map<MockProviderId | '*', Scenario>;
  requests: RecordedRequest[];
}

export function createMockState(): MockState {
  return { scenarios: new Map(), requests: [] };
}

interface Segment { id: string; text: string }

function json(status: number, body: unknown, extra: Record<string, string> = {}): MockResponse {
  return { status, headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body), delayMs: 0 };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function segmentsFromPrompt(prompt: string): Segment[] | undefined {
  for (const match of [prompt, ...(prompt.match(/\{[\s\S]*\}/g) ?? [])]) {
    const parsed = parseJson(match) as { segments?: unknown } | undefined;
    if (Array.isArray(parsed?.segments)) {
      const items = parsed.segments as Partial<Segment>[];
      if (items.every(item => typeof item?.id === 'string' && typeof item.text === 'string')) return items as Segment[];
    }
  }
  return undefined;
}

function llmPrompts(provider: MockProviderId, body: unknown): string[] {
  const root = body as Record<string, unknown> | undefined;
  if (provider === 'gemini') {
    const contents = (root?.contents ?? []) as { parts?: { text?: string }[] }[];
    return contents.flatMap(item => item.parts ?? []).map(part => part.text ?? '');
  }
  // OpenAI Responses API: `input` is the serialized TranslationRequest.
  if (typeof root?.input === 'string') return [root.input];
  const messages = (root?.messages ?? root?.input ?? []) as { content?: unknown }[];
  return Array.isArray(messages) ? messages.map(message => (typeof message.content === 'string' ? message.content : '')) : [];
}

function formTexts(body: string): string[] {
  return new URLSearchParams(body).getAll('text');
}

function authorized(provider: MockProviderId, request: MockRequest): boolean {
  const h = request.headers;
  const query = new URL(request.path, 'https://mock.invalid').searchParams;
  switch (provider) {
    case 'gemini': return h['x-goog-api-key'] === MOCK_API_KEY;
    case 'openai': return h.authorization === `Bearer ${MOCK_API_KEY}`;
    case 'google': return query.get('key') === MOCK_API_KEY || h['x-goog-api-key'] === MOCK_API_KEY;
    case 'deepl': return h.authorization === `DeepL-Auth-Key ${MOCK_API_KEY}`;
    case 'azure': return h['ocp-apim-subscription-key'] === MOCK_API_KEY;
  }
}

function rejection(provider: MockProviderId, status: number, retryAfterSeconds?: number): MockResponse {
  const extra: Record<string, string> = retryAfterSeconds === undefined ? {} : { 'Retry-After': String(retryAfterSeconds) };
  if (provider === 'deepl') return json(status, { message: `mock ${status}` }, extra);
  return json(status, { error: { code: status, message: `mock ${status}` } }, extra);
}

/** Returns the response for one request and records it in `state`. Unknown hosts get 404. */
export function handleMockRequest(request: MockRequest, state: MockState): MockResponse {
  const provider = providerHosts[request.host.toLowerCase().replace(/:\d+$/, '')];
  if (!provider) return json(404, { error: 'unknown host' });
  if (request.method === 'OPTIONS') return { status: 204, headers: {}, body: '', delayMs: 0 };

  const body = parseJson(request.body);
  let texts: string[] = [];
  let ids: string[] = [];
  let segments: Segment[] | undefined;

  if (provider === 'gemini' || provider === 'openai') {
    for (const prompt of llmPrompts(provider, body)) {
      segments = segmentsFromPrompt(prompt);
      if (segments) break;
    }
    texts = segments?.map(segment => segment.text) ?? [];
    ids = segments?.map(segment => segment.id) ?? [];
  } else if (provider === 'google') {
    const q = (body as { q?: unknown } | undefined)?.q;
    texts = Array.isArray(q) ? q.map(String) : typeof q === 'string' ? [q] : formTexts(request.body);
  } else if (provider === 'deepl') {
    const text = (body as { text?: unknown } | undefined)?.text;
    texts = Array.isArray(text) ? text.map(String) : typeof text === 'string' ? [text] : formTexts(request.body);
  } else if (Array.isArray(body)) {
    texts = (body as { Text?: unknown }[]).map(item => String(item.Text ?? ''));
  }

  const ok = authorized(provider, request);
  state.requests.push({ provider, method: request.method, path: request.path.replace(/([?&]key=)[^&]*/, '$1<redacted>'), authorized: ok, texts, ids });
  if (!ok) return rejection(provider, 401);

  const scenario = state.scenarios.get(provider) ?? state.scenarios.get('*') ?? { kind: 'success' };
  if (scenario.kind === 'error') return rejection(provider, scenario.status, scenario.retryAfterSeconds);
  if (scenario.kind === 'malformed') return { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"unexpected":', delayMs: 0 };

  const translated = texts.map(cannedTranslation);
  let response: MockResponse;
  switch (provider) {
    case 'gemini':
    case 'openai': {
      const answer = JSON.stringify({ segments: (segments ?? []).map(segment => ({ id: segment.id, text: cannedTranslation(segment.text) })) });
      response = provider === 'gemini'
        ? json(200, { candidates: [{ content: { role: 'model', parts: [{ text: answer }] }, finishReason: 'STOP' }] })
        : json(200, { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }] });
      break;
    }
    case 'google':
      response = json(200, { data: { translations: translated.map(translatedText => ({ translatedText })) } });
      break;
    case 'deepl':
      response = json(200, { translations: translated.map(text => ({ detected_source_language: 'JA', text })) });
      break;
    case 'azure':
      response = json(200, translated.map(text => ({ translations: [{ text, to: 'en' }] })));
      break;
  }
  return scenario.kind === 'delay' ? { ...response, delayMs: scenario.ms } : response;
}
