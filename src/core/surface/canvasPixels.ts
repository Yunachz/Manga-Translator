import { localImageLimit, type RenderedImage } from '../image/LocalImage';

/**
 * A canvas is readable when drawing it to another canvas leaves that canvas origin-clean. Cross-origin pixels
 * taint a canvas, and then `getImageData` and `toBlob` throw a SecurityError. One pixel is enough to find out.
 */
export function canvasReadable(canvas: HTMLCanvasElement): boolean {
  if (canvas.width < 1 || canvas.height < 1) return false;
  try {
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    const context = probe.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(canvas, 0, 0, 1, 1, 0, 0, 1, 1);
    context.getImageData(0, 0, 1, 1);
    return true;
  } catch { return false; }
}

/** A coarse 8 x 8 luma map of the canvas, for noticing that a page script repainted it. Undefined when unreadable. */
export function canvasFingerprint(canvas: HTMLCanvasElement): string | undefined {
  try {
    const probe = document.createElement('canvas');
    probe.width = probe.height = 8;
    const context = probe.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 8, 8);
    const { data } = context.getImageData(0, 0, 8, 8);
    let text = '';
    for (let index = 0; index < data.length; index += 4) text += String.fromCharCode(48 + ((data[index] + data[index + 1] + data[index + 2]) / 3 >> 3));
    return text;
  } catch { return; }
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unreadable canvas'));
    reader.onerror = () => reject(reader.error ?? new Error('Unreadable canvas'));
    reader.readAsDataURL(blob);
  });
}

/**
 * A standard raster copy of what the page painted on a canvas, taken in the page's own memory. The copy is a
 * PNG of the bitmap at its own size. Nothing is requested from the network. Returns undefined for a tainted
 * or oversized canvas, or one whose size no longer matches what the job was created for.
 */
export async function readCanvas(canvas: HTMLCanvasElement, expected: { width: number; height: number }): Promise<RenderedImage | undefined> {
  if (!canvas.isConnected || canvas.width !== expected.width || canvas.height !== expected.height || !canvasReadable(canvas)) return;
  try {
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d');
    if (!context) return;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, copy.width, copy.height);
    context.drawImage(canvas, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => copy.toBlob(resolve, 'image/png'));
    if (!blob || blob.size === 0 || blob.size > localImageLimit || canvas.width !== expected.width || canvas.height !== expected.height) return;
    return { dataUrl: await dataUrl(blob), type: 'image/png', width: expected.width, height: expected.height };
  } catch { return; }
}
