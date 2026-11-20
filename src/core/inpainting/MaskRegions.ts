import type { Rect } from '../../types/contracts';
import type { MaskRegion } from './TextMask';

/** Resolve overlapping lines together so they cannot sample each other's original lettering. */
export function mergeLineMasks(regions: MaskRegion[]): MaskRegion {
  if (regions.length === 1) return regions[0];
  const x = Math.min(...regions.map(region => region.bounds.x)), y = Math.min(...regions.map(region => region.bounds.y));
  const width = Math.max(...regions.map(region => region.bounds.x + region.bounds.width)) - x;
  const height = Math.max(...regions.map(region => region.bounds.y + region.bounds.height)) - y;
  const mask = new Uint8Array(width * height);
  for (const region of regions) {
    const source = region.bounds;
    for (let row = 0; row < source.height; row++) for (let col = 0; col < source.width; col++) {
      if (region.mask[row * source.width + col]) mask[(row + source.y - y) * width + col + source.x - x] = 1;
    }
  }
  return { bounds: { x, y, width, height }, mask, ...(regions.every(region => region.outlined) ? { outlined: true } : {}) };
}

/** Original lettering wins on overlap. Reject a mask when the retained area leaves too much original ink. */
export function protectMask(region: MaskRegion, reserved: Rect[]): MaskRegion | undefined {
  const { x, y, width, height } = region.bounds;
  let mask: Uint8Array | undefined;
  let removed = 0;
  for (const rect of reserved) {
    const left = Math.max(0, Math.floor(rect.x) - x), top = Math.max(0, Math.floor(rect.y) - y);
    const right = Math.min(width, Math.ceil(rect.x + rect.width) - x), bottom = Math.min(height, Math.ceil(rect.y + rect.height) - y);
    if (left >= right || top >= bottom) continue;
    mask ??= region.mask.slice();
    for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
      const index = row * width + col;
      removed += mask[index];
      mask[index] = 0;
    }
  }
  if (!mask || !removed) return region;
  const retained = mask.reduce((sum, pixel) => sum + pixel, 0);
  return retained >= 3 && removed <= retained * 0.22 ? { ...region, mask } : undefined;
}
