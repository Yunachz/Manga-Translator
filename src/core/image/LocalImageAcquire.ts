import { sha256 } from '../cache/identity';
import { PipelineError } from '../pipeline/PipelineError';
import type { ImageProbe } from '../../messaging/protocol';
import { record } from '../../messaging/validate';
import type { ImageDescriptor } from '../../types/contracts';
import type { AcquiredImage } from './ImageFetcher';
import { localImageLimit } from './LocalImage';

export interface LocalTarget { tabId: number; documentId: string; jobId: string; origin: string }
export type LocalAcquirer = (image: ImageDescriptor, signal: AbortSignal) => Promise<AcquiredImage>;

const header = /^data:(image\/(?:png|jpeg|webp|gif|avif|bmp));base64,/i;
const maxLength = Math.ceil(localImageLimit / 3) * 4 + 40;

function unreadable(): PipelineError {
  return new PipelineError('IMAGE_UNSUPPORTED', 'Gambar reader tidak dapat dibaca langsung. Gunakan Pilih area pada panel yang tampil.');
}

function ask(target: LocalTarget, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) { stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => resolve(undefined), 20_000);
    const message: ImageProbe = { type: 'IMAGE_PROBE', id: target.jobId };
    chrome.tabs.sendMessage(target.tabId, message, { documentId: target.documentId }).then(resolve, () => resolve(undefined))
      .finally(() => { clearTimeout(timer); signal.removeEventListener('abort', stop); });
  });
}

/**
 * Takes the pixels of a surface the reader already rendered: a `blob:` image on the tab's own HTTPS origin, or a
 * canvas the page paints. The content script reads them from its own page's memory and replies once. Nothing is
 * requested again, so no URL or API call is repeated. A canvas whose pixels the browser marks as cross-origin
 * cannot be read, and the content script answers with nothing.
 */
export async function acquireRenderedImage(target: LocalTarget, image: ImageDescriptor, signal: AbortSignal): Promise<AcquiredImage> {
  if (image.kind === 'canvas') {
    let page: URL;
    try { page = new URL(image.src); } catch { throw unreadable(); }
    if (page.origin !== target.origin) throw unreadable();
  } else {
    let source: URL;
    try { source = new URL(image.src); } catch { throw unreadable(); }
    if (source.protocol !== 'blob:' || source.origin !== target.origin || !target.origin.startsWith('https://')) throw unreadable();
  }
  const answer = await ask(target, signal);
  signal.throwIfAborted();
  if (!record(answer) || typeof answer.dataUrl !== 'string' || typeof answer.type !== 'string' ||
      answer.width !== image.width || answer.height !== image.height) throw unreadable();
  const kind = header.exec(answer.dataUrl);
  if (!kind || answer.dataUrl.length > maxLength || kind[1].toLowerCase() !== answer.type.toLowerCase()) throw unreadable();
  let bytes: ArrayBuffer;
  try { bytes = await (await fetch(answer.dataUrl)).arrayBuffer(); } catch { throw unreadable(); }
  signal.throwIfAborted();
  if (!bytes.byteLength || bytes.byteLength > localImageLimit) throw unreadable();
  return { blob: new Blob([bytes], { type: kind[1].toLowerCase() }), hash: await sha256(bytes) };
}
