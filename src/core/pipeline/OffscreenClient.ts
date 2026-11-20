import type { InferenceOperations, InferenceResponse, Operation } from '../../messaging/inference';
import type { ErrorDetails, JobStatus, TranslationRequest, TranslationResult } from '../../types/contracts';
import { chromeUnavailable } from '../translation/ChromeTranslatorProvider';
import type { TranslatorProvider } from '../translation/TranslatorProvider';
import { fromDetails, PipelineError } from './PipelineError';

type Reply<T> = { ok: true; output: T } | { ok: false; error: ErrorDetails };
const path = 'offscreen.html';
let creating: Promise<void> | undefined;
const progress = new Map<string, (stage: JobStatus) => void>();

export async function ensureOffscreen(): Promise<void> {
  if (creating) return creating;
  creating = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(path)] });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({ url: path, reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Local panel detection, OCR, inpainting and typesetting in one dedicated worker.' });
  })();
  try { await creating; } finally { creating = undefined; }
}

export function inferenceProgress(message: InferenceResponse): void {
  if ('stage' in message) progress.get(message.id)?.(message.stage);
}

async function offscreen<T>(message: object): Promise<T> {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ to: 'offscreen', ...message }) as Reply<T> | undefined;
  if (!response) throw new PipelineError('INTERNAL', 'Runtime lokal tidak merespons. Coba ulangi terjemahan.');
  if (!response.ok) throw fromDetails(response.error);
  return response.output;
}

export async function runInference<K extends Operation>(op: K, input: InferenceOperations[K]['input'],
  onProgress?: (stage: JobStatus) => void, signal?: AbortSignal): Promise<InferenceOperations[K]['output']> {
  const id = crypto.randomUUID();
  await ensureOffscreen();
  signal?.throwIfAborted();
  if (onProgress) progress.set(id, onProgress);
  const abort = () => {
    void chrome.runtime.sendMessage({ to: 'offscreen', kind: 'INFERENCE_CANCEL', id }).catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await offscreen<InferenceOperations[K]['output']>({ kind: 'INFERENCE', request: { id, op, input } });
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    progress.delete(id);
  }
}

export const chromeProxy: TranslatorProvider = {
  id: 'chrome', name: 'Chrome Translator', type: 'local', requiresApiKey: false, supportsContext: false,
  isAvailable: () => offscreen<boolean>({ kind: 'CHROME_STATUS' }).catch(() => false),
  async translate(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResult> {
    signal.throwIfAborted();
    const output = await offscreen<TranslationResult>({ kind: 'CHROME_TRANSLATE', request }).catch(error => {
      throw error instanceof PipelineError ? error : chromeUnavailable();
    });
    signal.throwIfAborted();
    return output;
  },
};
