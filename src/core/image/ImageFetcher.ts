import { hostPattern } from '../../messaging/permission';
import { sha256 } from '../cache/identity';
import { PipelineError } from '../pipeline/PipelineError';
import type { ImageDescriptor } from '../../types/contracts';

const maxBytes = 24 * 1024 * 1024;
const acceptedType = /^image\/(png|jpeg|webp|gif|avif|bmp|x-icon|vnd\.microsoft\.icon)(?:$|;)/i;

export interface AcquiredImage { blob: Blob; hash: string }

export class ImageHttpError extends PipelineError {
  constructor(readonly status: number) {
    super('IMAGE_FETCH', `Sumber gambar menolak request (HTTP ${status}).`);
  }
}

export async function fetchImage(image: ImageDescriptor, pageOrigin: string, signal: AbortSignal, prompt = true): Promise<AcquiredImage> {
  const url = new URL(image.src);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PipelineError('IMAGE_UNSUPPORTED', 'Gambar reader tersedia di tab. Gunakan Pilih area pada panel yang tampil.');
  }
  const origin = url.origin;
  const allowed = await chrome.permissions.contains({ origins: [hostPattern(origin)] });
  if (!allowed && origin !== pageOrigin) throw imagePermission(origin);
  const timeout = AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, timeout]) });
  } catch {
    signal.throwIfAborted();
    if (!allowed && prompt && !timeout.aborted) throw imagePermission(origin);
    throw new PipelineError('IMAGE_FETCH', 'Gambar tidak dapat diambil. Situs mungkin membatasi akses gambar.');
  }
  if (!response.ok) throw new ImageHttpError(response.status);
  const type = response.headers.get('content-type') ?? '';
  if (type && !acceptedType.test(type) && !/^application\/octet-stream/i.test(type)) {
    throw new PipelineError('IMAGE_UNSUPPORTED', 'Sumber gambar bukan raster PNG, JPEG, WebP, GIF, AVIF, atau BMP.');
  }
  const body = response.body?.getReader();
  if (!body) throw new PipelineError('IMAGE_FETCH', 'Sumber gambar mengirim respons kosong.');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await body.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new PipelineError('IMAGE_UNSUPPORTED', 'Ukuran gambar melebihi batas 24 MiB.');
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    void body.cancel().catch(() => undefined);
    signal.throwIfAborted();
    if (error instanceof PipelineError) throw error;
    throw new PipelineError('IMAGE_FETCH', 'Pengambilan gambar terhenti.');
  } finally {
    body.releaseLock();
  }
  if (!size) throw new PipelineError('IMAGE_FETCH', 'Sumber gambar mengirim berkas kosong.');
  const blob = new Blob(chunks, { type });
  return { blob, hash: await sha256(await blob.arrayBuffer()) };
}

function imagePermission(origin: string): PipelineError {
  return new PipelineError('IMAGE_PERMISSION', 'Izinkan domain gambar dari popup, lalu pilih Coba lagi.', origin);
}
