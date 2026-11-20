import InferenceWorker from '../../workers/inference.worker?worker';
import { ChromeTranslatorProvider, chromeAvailability } from '../../core/translation/ChromeTranslatorProvider';
import { errorDetails } from '../../core/pipeline/PipelineError';
import type { InferenceRequest, InferenceResponse } from '../../messaging/inference';
import type { TranslationRequest } from '../../types/contracts';

type LocalMessage =
  | { to: 'offscreen'; kind: 'CHROME_STATUS' }
  | { to: 'offscreen'; kind: 'CHROME_TRANSLATE'; request: TranslationRequest }
  | { to: 'offscreen'; kind: 'INFERENCE'; request: InferenceRequest }
  | { to: 'offscreen'; kind: 'INFERENCE_CANCEL'; id: string };
type Reply = (response: unknown) => void;
let worker: Worker | undefined;
const waiting = new Map<string, Reply>();

function inferenceWorker(): Worker {
  if (worker) return worker;
  worker = new InferenceWorker();
  worker.addEventListener('message', (event: MessageEvent<InferenceResponse>) => {
    const message = event.data;
    if (!waiting.has(message.id)) return;
    if ('stage' in message) {
      void chrome.runtime.sendMessage({ to: 'background', type: 'INFERENCE_PROGRESS', ...message }).catch(() => undefined);
    } else {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  worker.addEventListener('error', () => {
    for (const [id, reply] of waiting) {
      reply({ id, ok: false, error: { code: 'MODEL_LOAD', message: 'Inference worker tidak dapat dijalankan.' } });
    }
    waiting.clear();
    worker?.terminate();
    worker = undefined;
  });
  return worker;
}

chrome.runtime.onMessage.addListener((message: LocalMessage, sender, reply) => {
  if (message?.to !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab ||
      sender.url !== chrome.runtime.getURL('background.js')) return;
  if (message.kind === 'CHROME_STATUS') {
    void chromeAvailability().then(status => reply({ ok: true, output: status !== 'unavailable' }));
    return true;
  }
  if (message.kind === 'CHROME_TRANSLATE') {
    void new ChromeTranslatorProvider().translate(message.request, AbortSignal.timeout(60_000))
      .then(output => reply({ ok: true, output }), error => reply({ ok: false, error: errorDetails(error) }));
    return true;
  }
  if (message.kind === 'INFERENCE_CANCEL') {
    if (waiting.has(message.id)) worker?.postMessage({ abort: message.id });
    return;
  }
  if (message.kind !== 'INFERENCE' || !message.request?.id ||
      !['captureCrop', 'detect', 'read', 'render'].includes(message.request.op) || waiting.has(message.request.id)) return;
  try {
    waiting.set(message.request.id, reply);
    inferenceWorker().postMessage(message.request);
  } catch (error) {
    waiting.delete(message.request.id);
    reply({ ok: false, error: errorDetails(error, 'MODEL_LOAD', 'Inference worker tidak dapat dimulai.') });
  }
  return true;
});
