import type { InpaintingMode, Rect } from '../../types/contracts';
import { clamp } from '../image/geometry';
import { gray } from '../image/raster';
import { dilate } from './dilate';
import type { MaskRegion } from './TextMask';

/** Pixels at or below this are ink-dark. A pale pixel is at least `LIGHT`. Between them is shading, such as the soft edge of a stroke. */
const DARK = 90;
const LIGHT = 170;
/** An outline run continues through soft edges down to this shade, so its width is measured to the true outer edge. */
const SOFT = 130;
/** The mask grows only through pixels this pale: the outline itself. Lighter shading of the artwork is not taken in. */
const OUTLINE = 190;
/** A glyph core is surrounded by pale pixels: at least this share of the ring just outside it. */
const RING_SHARE = 0.6;
/** A core this tall, relative to the line, is a letter rather than a speck of screentone or a dot. */
const LETTER_HEIGHT = 0.3;
/** Fewest letter cores a line needs before it counts as outlined lettering. */
const MIN_LETTERS = 3;
/** Share of the line width its letter cores must span. */
const MIN_SPREAD = 0.5;
/** Largest share of the line box dark cores may cover. Beyond it the box is mostly shadow, not lettering. */
const MAX_CORE_SHARE = 0.45;
/** Pale-run limits for the outline width, relative to the line height. */
const MAX_OUTLINE = 0.22;
/** Steps the finished mask may still grow through pale pixels, to take in the thick parts of the outline. */
const COMPLETION = 3;
/** Largest enclosed pocket, as a share of the line box, that counts as the inside of a letter. */
const MAX_COUNTER = 0.04;
/** Largest mask, as a multiple of the glyph cores. An outline several times the lettering is the artwork, not an outline. */
const MAX_GROWTH = 4;
/** A base mask up to this multiple of the cap is retried with its outer growth shells removed. Beyond it the mask has leaked. */
const NEAR_CAP = 1.04;
/** The retry drops this many of the outermost growth shells. */
const TRIM_SHELLS = 3;
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

interface Component { pixels: number[]; left: number; top: number; right: number; bottom: number; touchesEdge: boolean }

function components(dark: Uint8Array, width: number, height: number): Component[] {
  const seen = new Uint8Array(dark.length);
  const found: Component[] = [];
  for (let root = 0; root < dark.length; root++) {
    if (!dark[root] || seen[root]) continue;
    const pixels = [root];
    seen[root] = 1;
    const part: Component = { pixels, left: width, top: height, right: 0, bottom: 0, touchesEdge: false };
    for (let head = 0; head < pixels.length; head++) {
      const index = pixels[head], x = index % width, y = Math.floor(index / width);
      part.left = Math.min(part.left, x); part.right = Math.max(part.right, x);
      part.top = Math.min(part.top, y); part.bottom = Math.max(part.bottom, y);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) part.touchesEdge = true;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (dark[next] && !seen[next]) { seen[next] = 1; pixels.push(next); }
      }
    }
    found.push(part);
  }
  return found;
}

/** Share of pale pixels in the ring one to two pixels outside a component. */
function paleRing(part: Component, shade: Float32Array, width: number, height: number): number {
  const inside = new Set(part.pixels);
  const ring = new Set<number>();
  for (const index of part.pixels) {
    const x = index % width, y = Math.floor(index / width);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const near = ny * width + nx;
      if (!inside.has(near)) ring.add(near);
    }
  }
  let pale = 0;
  for (const index of ring) pale += Number(shade[index] >= LIGHT);
  return ring.size ? pale / ring.size : 0;
}

/** Length of the pale run that starts next to a core pixel and ends at the first pixel that is not pale. */
function outlineRun(index: number, shade: Float32Array, core: Uint8Array, width: number, height: number, limit: number): number {
  const x = index % width, y = Math.floor(index / width);
  let shortest = limit + 1;
  for (const [dx, dy] of NEIGHBORS) {
    let run = 0;
    for (let step = 1; step <= limit; step++) {
      const nx = x + dx * step, ny = y + dy * step;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) { run = limit + 1; break; }
      const next = ny * width + nx;
      if (core[next]) { run = limit + 1; break; }
      if (shade[next] < SOFT) break;
      run = step;
    }
    // A direction that starts on the core itself, or never leaves the core, says nothing about the outline.
    if (run > 0 && run <= limit) shortest = Math.min(shortest, run);
  }
  return shortest;
}

/**
 * Pale pixels that belong to a stroke at least three pixels wide: the pale pixels with the thin ones opened away.
 * The outline is such a stroke. Hatching and halftone highlights are one or two pixels thick, and would otherwise
 * carry the mask far across the artwork wherever they touch the outline.
 */
function thickPale(shade: Float32Array, width: number, height: number): Uint8Array {
  const pale = new Uint8Array(shade.length);
  for (let index = 0; index < shade.length; index++) pale[index] = Number(shade[index] >= OUTLINE);
  const core = new Uint8Array(shade.length);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    let all = 1;
    for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (!pale[(y + dy) * width + x + dx]) { all = 0; break; }
    core[y * width + x] = all;
  }
  const thick = new Uint8Array(shade.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!pale[y * width + x]) continue;
    let near = 0;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && core[ny * width + nx]) { near = 1; break; }
    }
    thick[y * width + x] = near;
  }
  return thick;
}

/**
 * Mask for lettering printed as dark glyphs inside a pale outline, with no balloon around it, over artwork. The
 * ordinary ink mask cannot separate such lettering from the artwork: the dark artwork touches the edge of the box
 * and the pale outline is not ink at all. Here the glyph cores are the dark islands that artwork does not reach and
 * that a pale ring surrounds, and the mask is those cores plus the outline around them, as wide as the outline
 * measures next to the cores. Artwork beyond the outline is not touched. Returns undefined unless a line shows
 * several letters with that structure, so ordinary text, artwork lines and screentone dots are left to the usual mask.
 */
export function outlineMask(raster: ImageData, line: Rect, mode: InpaintingMode = 'normal'): MaskRegion | undefined {
  if (line.width < 12 || line.height < 12) return;
  const extension = clamp(Math.round(line.height * 0.15), 3, 10);
  const x = clamp(Math.floor(line.x) - extension, 0, raster.width - 1);
  const y = clamp(Math.floor(line.y) - extension, 0, raster.height - 1);
  const width = clamp(Math.ceil(line.x + line.width) + extension, x + 1, raster.width) - x;
  const height = clamp(Math.ceil(line.y + line.height) + extension, y + 1, raster.height) - y;
  const shade = new Float32Array(width * height);
  const dark = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const value = gray(raster.data, (y + row) * raster.width + x + column);
    shade[row * width + column] = value;
    dark[row * width + column] = Number(value <= DARK);
  }
  const box = { left: line.x - x, right: line.x + line.width - x, top: line.y - y, bottom: line.y + line.height - y };
  const core = new Uint8Array(width * height);
  const letters: Component[] = [];
  let cores = 0;
  for (const part of components(dark, width, height)) {
    const centreX = (part.left + part.right) / 2, centreY = (part.top + part.bottom) / 2;
    // Artwork reaches the edge of the box. A core is an island whose centre lies inside the line.
    if (part.touchesEdge || centreX < box.left || centreX > box.right || centreY < box.top || centreY > box.bottom) continue;
    if (part.pixels.length < 3 || paleRing(part, shade, width, height) < RING_SHARE) continue;
    for (const index of part.pixels) core[index] = 1;
    cores += part.pixels.length;
    if (part.bottom - part.top + 1 >= line.height * LETTER_HEIGHT) letters.push(part);
  }
  if (letters.length < MIN_LETTERS || cores > line.width * line.height * MAX_CORE_SHARE) return;
  const spread = Math.max(...letters.map(part => part.right)) - Math.min(...letters.map(part => part.left)) + 1;
  if (spread < line.width * MIN_SPREAD) return;
  // Letters sit on one line: their centres share a band of the line's height.
  const centres = letters.map(part => (part.top + part.bottom) / 2).sort((a, b) => a - b);
  if (centres[centres.length - 1] - centres[0] > line.height * 0.5) return;

  const limit = Math.max(2, Math.round(line.height * MAX_OUTLINE));
  const runs: number[] = [];
  for (let index = 0; index < core.length; index++) {
    if (!core[index]) continue;
    const px = index % width, py = Math.floor(index / width);
    if (NEIGHBORS.every(([dx, dy]) => px + dx >= 0 && py + dy >= 0 && px + dx < width && py + dy < height && core[(py + dy) * width + px + dx])) continue;
    const run = outlineRun(index, shade, core, width, height, limit);
    if (run <= limit) runs.push(run);
  }
  if (runs.length < 8) return;
  runs.sort((a, b) => a - b);
  const outline = runs[Math.floor(runs.length / 2)];

  // Grow the cores through the thick pale outline as far as it reaches.
  const thick = thickPale(shade, width, height);
  const mask = new Uint8Array(width * height);
  const reach = new Int16Array(width * height).fill(-1);
  const queue: number[] = [];
  for (let index = 0; index < core.length; index++) if (core[index]) { mask[index] = 1; reach[index] = 0; queue.push(index); }
  const grow = Math.ceil(outline * 1.5) + 1;
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    if (reach[index] >= grow) continue;
    const px = index % width, py = Math.floor(index / width);
    for (const [dx, dy] of NEIGHBORS) {
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (reach[next] >= 0 || !thick[next]) continue;
      reach[next] = reach[index] + 1;
      mask[next] = 1;
      queue.push(next);
    }
  }
  const counter = line.width * line.height * MAX_COUNTER;
  fillCounters(mask, width, height, counter);
  // The outline of bold lettering can take most of the box. A mask many times the glyphs, or nearly the whole region, has leaked.
  // A whole number of pixels: a fractional cap would leave a fractional budget that admits one pixel too many.
  const cap = Math.floor(Math.min(cores * MAX_GROWTH, width * height * 0.9));
  let marked = count(mask);
  if (marked > cap) {
    // A base only just over the cap is a soft or recompressed outline whose edge shading was grown into. Drop the
    // outer shells and test the same cap again. A base far over the cap has leaked and is rejected.
    if (marked > cap * NEAR_CAP) return;
    mask.fill(0);
    for (let index = 0; index < reach.length; index++) if (reach[index] >= 0 && reach[index] <= grow - TRIM_SHELLS) mask[index] = 1;
    fillCounters(mask, width, height, counter);
    marked = count(mask);
    if (marked > cap) return;
  }
  // The pale edge pixels the base missed are taken in only while the mask stays within the cap.
  completeOutline(mask, thick, width, height, cap - marked);
  marked = count(mask);
  if (marked < 3 || marked > cap) return;
  // The soft edge of the outline is darker than `OUTLINE`. Two pixels take it in; a safety mode takes one.
  return { bounds: { x, y, width, height }, mask: dilate(mask, width, height, mode === 'normal' ? 2 : 1), outlined: true };
}

/**
 * The outline is thicker than its median where letters end, join or turn. A few pale pixels stay just outside the
 * mask there, and the fill would copy them into the hole as bright streaks. Take in the pale pixels next to the mask,
 * a few steps deep and no further, so artwork that happens to be pale is not eaten into.
 */
function completeOutline(mask: Uint8Array, thick: Uint8Array, width: number, height: number, budget: number): void {
  let frontier: number[] = [];
  for (let index = 0; index < mask.length; index++) if (mask[index]) frontier.push(index);
  for (let step = 0; step < COMPLETION && frontier.length && budget > 0; step++) {
    const next: number[] = [];
    for (const index of frontier) {
      const x = index % width, y = Math.floor(index / width);
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const near = ny * width + nx;
        if (mask[near] || !thick[near]) continue;
        if (budget <= 0) return;
        mask[near] = 1;
        budget--;
        next.push(near);
      }
    }
    frontier = next;
  }
}

function count(mask: Uint8Array): number {
  let total = 0;
  for (const value of mask) total += value;
  return total;
}

/**
 * Close the small pockets a letter encloses, such as the inside of an O or an A. The outline runs around them on
 * both sides, so they belong to the lettering. A pocket that connects to the rest of the box is artwork and stays.
 */
function fillCounters(mask: Uint8Array, width: number, height: number, largest: number): void {
  const outside = new Uint8Array(mask.length);
  const queue: number[] = [];
  const visit = (index: number) => { if (!mask[index] && !outside[index]) { outside[index] = 1; queue.push(index); } };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head], x = index % width, y = Math.floor(index / width);
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height) visit(ny * width + nx);
    }
  }
  const seen = new Uint8Array(mask.length);
  for (let root = 0; root < mask.length; root++) {
    if (mask[root] || outside[root] || seen[root]) continue;
    const pocket = [root];
    seen[root] = 1;
    for (let head = 0; head < pocket.length; head++) {
      const index = pocket[head], x = index % width, y = Math.floor(index / width);
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!mask[next] && !outside[next] && !seen[next]) { seen[next] = 1; pocket.push(next); }
      }
    }
    if (pocket.length <= largest) for (const index of pocket) mask[index] = 1;
  }
}
