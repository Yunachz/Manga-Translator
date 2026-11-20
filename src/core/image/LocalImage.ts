import { chapterSite } from '../chapter/readerSites';

/** Largest image the content script hands to the background, in bytes before base64. */
export const localImageLimit = 16 * 1024 * 1024;
export const localImageType = /^image\/(?:png|jpeg|webp|gif|avif|bmp)$/i;

export interface RenderedImage { dataUrl: string; type: string; width: number; height: number }
export interface ExpectedImage { src: string; width: number; height: number }

/** A `blob:` source that the reader created on its own HTTPS origin. Nothing else is read locally. */
export function localBlobSource(src: string, pageHref = location.href): boolean {
  try {
    const url = new URL(src);
    const page = new URL(pageHref);
    return url.protocol === 'blob:' && url.origin === page.origin && page.protocol === 'https:' &&
      chapterSite(pageHref)?.site === 'dex';
  } catch { return false; }
}

/** Read an existing reader blob with a size bound before allocating its bytes. */
export async function readLocalBlob(src: string): Promise<Blob | undefined> {
  if (!localBlobSource(src)) return;
  try {
    const response = await fetch(src, { signal: AbortSignal.timeout(5000) });
    const size = Number(response.headers.get('content-length'));
    if (!response.ok || !Number.isSafeInteger(size) || size <= 0 || size > localImageLimit) {
      await response.body?.cancel();
      return;
    }
    const blob = await response.blob();
    if (blob.size === size) return blob;
  } catch {
    // The reader can revoke an object URL as soon as it leaves the viewport.
  }
}

function same(image: HTMLImageElement, expected: ExpectedImage): boolean {
  return image.isConnected && image.complete && (image.currentSrc || image.src) === expected.src &&
    image.naturalWidth === expected.width && image.naturalHeight === expected.height;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unreadable image'));
    reader.onerror = () => reject(reader.error ?? new Error('Unreadable image'));
    reader.readAsDataURL(blob);
  });
}

async function decodes(blob: Blob, image: HTMLImageElement): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(blob);
    const match = bitmap.width === image.naturalWidth && bitmap.height === image.naturalHeight;
    bitmap.close();
    return match;
  } catch { return false; }
}

async function encodeRendered(image: HTMLImageElement): Promise<Blob | undefined> {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(image, 0, 0);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob ?? undefined), 'image/png'));
}

/**
 * Reads the pixels the reader already shows, without any network request. The blob URL belongs to the
 * page origin, so `fetch` only touches memory. If the reader revoked it or the bytes do not match the
 * rendered size, the decoded `<img>` is re-encoded instead.
 */
export async function readRenderedImage(image: HTMLImageElement, expected: ExpectedImage): Promise<RenderedImage | undefined> {
  if (!localBlobSource(expected.src) || !same(image, expected)) return;
  const candidate = await readLocalBlob(expected.src);
  let blob = candidate && localImageType.test(candidate.type) && await decodes(candidate, image) ? candidate : undefined;
  blob ??= await encodeRendered(image);
  if (!blob || blob.size === 0 || blob.size > localImageLimit || !localImageType.test(blob.type) || !same(image, expected)) return;
  return { dataUrl: await dataUrl(blob), type: blob.type, width: expected.width, height: expected.height };
}
