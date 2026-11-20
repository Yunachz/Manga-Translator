import { PipelineError } from '../pipeline/PipelineError';

export function providerHttpError(status: number, payload: unknown): PipelineError {
  const object = payload as { error?: { code?: unknown; status?: unknown; type?: unknown; message?: unknown }; message?: unknown } | null;
  const tag = [object?.error?.code, object?.error?.status, object?.error?.type, object?.error?.message, object?.message].join(' ').toLowerCase();
  if (status === 401 || status === 403 || /api.key.invalid|api.key.not.valid|invalid.api.key|keyinvalid/.test(tag)) {
    return new PipelineError('UNAUTHORIZED', 'API key tidak valid atau tidak diizinkan untuk provider ini.');
  }
  if ([402, 456].includes(status) || /insufficient_quota|daily.limit|billing.hard.limit|quota_exceeded/.test(tag) ||
      (status === 429 && /exceeded your current quota|quota has been exceeded/.test(tag))) {
    return new PipelineError('QUOTA', 'Kuota terjemahan provider habis.');
  }
  if (status === 429) return new PipelineError('RATE_LIMITED', 'Provider membatasi request. Coba lagi nanti.');
  return new PipelineError('TRANSLATION_FAILED', `Provider menolak request (HTTP ${status}). Periksa model, bahasa, atau paket layanan.`);
}

export async function postJson(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(25_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, timeout]),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw providerHttpError(response.status, payload);
    if (payload === null) throw new PipelineError('TRANSLATION_INVALID', 'Respons provider bukan JSON yang valid.');
    return payload;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof PipelineError) throw error;
    throw new PipelineError('TRANSLATION_FAILED', timeout.aborted ? 'Waktu tunggu provider habis.' : 'Provider tidak dapat dihubungi.');
  }
}
