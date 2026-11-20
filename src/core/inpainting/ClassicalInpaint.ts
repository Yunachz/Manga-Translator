import type { Color } from './FlatFill';
import type { MaskRegion } from './TextMask';

/** Middle value of a short list. A single bright or dark pixel among several does not move it. */
function middle(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** How pale a pixel on the rim may be before it counts as outline rather than artwork: just above the rim's own bright end. */
function rimCeiling(raster: ImageData, region: MaskRegion, edge: number[], neighbors: (index: number) => number[],
  rasterOffset: (index: number) => number): number {
  const shades: number[] = [];
  for (const index of edge) {
    for (const neighbor of neighbors(index)) {
      if (region.mask[neighbor]) continue;
      const offset = rasterOffset(neighbor);
      shades.push((77 * raster.data[offset] + 150 * raster.data[offset + 1] + 29 * raster.data[offset + 2]) / 256);
    }
  }
  if (shades.length < 8) return 256;
  shades.sort((a, b) => a - b);
  return shades[Math.floor(shades.length * 0.8)] + 30;
}

export function classicalInpaint(raster: ImageData, region: MaskRegion, fallback: Color): void {
  const { x, y, width, height } = region.bounds;
  const unknown = region.mask.slice();
  const queue: number[] = [];
  const deltas = [-1, 1, -width, width];
  const rasterOffset = (index: number) => ((y + Math.floor(index / width)) * raster.width + x + index % width) * 4;
  function neighbors(index: number): number[] {
    return deltas.filter((delta, direction) => direction === 0 ? index % width > 0
      : direction === 1 ? index % width + 1 < width : direction === 2 ? index >= width : index < width * (height - 1))
      .map(delta => index + delta);
  }
  for (let index = 0; index < unknown.length; index++) {
    if (unknown[index] && neighbors(index).some(neighbor => !unknown[neighbor])) {
      queue.push(index);
      unknown[index] = 2;
    }
  }
  // Outlined lettering: pale pixels left on the rim, well above the artwork's own range, are scraps of the outline.
  const ceiling = region.outlined ? rimCeiling(raster, region, queue, neighbors, rasterOffset) : 256;
  const luma = (offset: number) => (77 * raster.data[offset] + 150 * raster.data[offset + 1] + 29 * raster.data[offset + 2]) / 256;
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    const adjacent = neighbors(index);
    const known = adjacent.filter(neighbor => !unknown[neighbor]);
    const clean = region.outlined ? known.filter(neighbor => luma(rasterOffset(neighbor)) <= ceiling) : known;
    // With only outline scraps around, the typical background is a better guess than copying them.
    const sources = clean.length || !region.outlined ? clean : [];
    // Outlined lettering sits on screentone. Averaging smears the tone into grey, and one leftover pale pixel would
    // streak into the hole. The median of the known pixels around keeps the tone's own values.
    const color = sources.length ? ([0, 1, 2] as const).map(channel => region.outlined
      ? middle(sources.map(neighbor => raster.data[rasterOffset(neighbor) + channel]))
      : sources.reduce((sum, neighbor) => sum + raster.data[rasterOffset(neighbor) + channel], 0) / sources.length) : fallback;
    raster.data.set(color, rasterOffset(index));
    unknown[index] = 0;
    for (const neighbor of adjacent) {
      if (unknown[neighbor] !== 1) continue;
      queue.push(neighbor);
      unknown[neighbor] = 2;
    }
  }
  for (let index = 0; index < unknown.length; index++) {
    if (unknown[index]) raster.data.set(fallback, rasterOffset(index));
  }
  if (region.outlined) smooth(raster, region);
}

/**
 * The fill spreads each rim pixel across the hole in straight runs, which shows as streaks over screentone. Blend the
 * filled pixels with their surroundings, inside the mask only, so the hole settles to the tone around it.
 */
function smooth(raster: ImageData, region: MaskRegion): void {
  const { x, y, width, height } = region.bounds;
  const reach = 2;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Map<number, [number, number, number]>();
    for (let index = 0; index < region.mask.length; index++) {
      if (!region.mask[index]) continue;
      const px = index % width, py = Math.floor(index / width);
      const sum = [0, 0, 0];
      let count = 0;
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const offset = ((y + ny) * raster.width + x + nx) * 4;
        for (let channel = 0; channel < 3; channel++) sum[channel] += raster.data[offset + channel];
        count++;
      }
      next.set(index, [sum[0] / count, sum[1] / count, sum[2] / count]);
    }
    for (const [index, color] of next) raster.data.set(color, ((y + Math.floor(index / width)) * raster.width + x + index % width) * 4);
  }
}
