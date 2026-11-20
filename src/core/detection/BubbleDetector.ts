import type { BubbleRegion, OCRResult, Point, Rect, TextRegion } from '../../types/contracts';
import { clamp, rectPolygon } from '../image/geometry';
import { gray } from '../image/raster';
import { isolateBubbleLayouts } from './BubbleLayout';

interface Profile { count: Uint32Array; low: Uint32Array; high: Uint32Array }
interface BubbleCandidate {
  bounds: Rect; id: number; interior: boolean; profile?: [Profile, Profile];
  /** Set when a cut between two lobes is an estimate and not an edge in the artwork: the outline of the whole interior. */
  maskShape?: Point[];
  /** Flat indices of the light interior pixels this candidate owns, with the raster width to decode them. */
  pixels?: Int32Array; stride?: number;
}
interface Group { candidate: BubbleCandidate; lines: OCRResult[] }

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function around(bounds: Rect, width: number, height: number, factor = 0.22): Rect {
  const padX = Math.max(4, bounds.width * factor), padY = Math.max(4, bounds.height * factor);
  const x = clamp(bounds.x - padX, 0, width), y = clamp(bounds.y - padY, 0, height);
  return { x, y, width: clamp(bounds.x + bounds.width + padX, 0, width) - x,
    height: clamp(bounds.y + bounds.height + padY, 0, height) - y };
}

function related(a: Rect, b: Rect, vertical: boolean): boolean {
  if (vertical) return related({ x: a.y, y: a.x, width: a.height, height: a.width },
    { x: b.y, y: b.x, width: b.height, height: b.width }, false);
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const gap = Math.max(a.y - b.y - b.height, b.y - a.y - a.height);
  return overlap >= Math.min(a.width, b.width) * 0.48 && gap < Math.min(a.height, b.height) * 0.65 &&
    Math.abs(a.y - b.y) > Math.min(a.height, b.height) * 0.38;
}

/**
 * Two boxes that sit on one row of lettering with no more than a word space between them: a leading ellipsis the
 * detector boxed apart from the line it starts, or the two halves of a split line. They belong to one caption.
 */
export function sameRow(a: Rect, b: Rect): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const smaller = Math.min(a.height, b.height);
  const gap = Math.max(a.x - b.x - b.width, b.x - a.x - a.width);
  return overlap >= smaller * 0.6 && gap < smaller * 0.9 && gap > -Math.min(a.width, b.width) * 0.5;
}

class LightRegions {
  private readonly visited: Int32Array;
  private readonly queue: Int32Array;
  private readonly regions = new Map<number, BubbleCandidate | null>();
  private sequence = 0;

  constructor(private readonly raster: ImageData) {
    this.visited = new Int32Array(raster.width * raster.height);
    this.queue = new Int32Array(this.visited.length);
  }

  find(line: Rect): BubbleCandidate | undefined {
    const { width, height, data } = this.raster;
    for (const fractionY of [0.08, 0.92, 0.5]) {
      for (const fractionX of [0.16, 0.84, 0.5]) {
        const x = clamp(Math.round(line.x + line.width * fractionX), 0, width - 1);
        const y = clamp(Math.round(line.y + line.height * fractionY), 0, height - 1);
        const index = y * width + x;
        const current = this.visited[index];
        if (gray(data, index) < 225) continue;
        const found = current ? this.regions.get(current) : this.flood(index);
        if (!found) continue;
        const b = found.bounds;
        if (b.x <= line.x + line.width * 0.16 && b.y <= line.y + line.height * 0.16 &&
          b.x + b.width >= line.x + line.width * 0.84 && b.y + b.height >= line.y + line.height * 0.84 &&
          this.owns(line, found)) return found;
      }
    }
  }

  /**
   * The region's rectangle can cover text that sits outside the balloon, such as a corner of the rectangle
   * or the space past an outline. Count the line's own pixels: enough of its box must be this region's light
   * pixels. Ink and a little margin past the outline are expected, so a partly clipped line still counts.
   */
  private owns(line: Rect, region: BubbleCandidate): boolean {
    const { width, height } = this.raster;
    let own = 0, total = 0;
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 16; column++) {
        const x = clamp(Math.round(line.x + (line.width * (column + 0.5)) / 16), 0, width - 1);
        const y = clamp(Math.round(line.y + (line.height * (row + 0.5)) / 8), 0, height - 1);
        total++;
        if (this.visited[y * width + x] === region.id) own++;
      }
    }
    return own >= total * 0.4;
  }

  private flood(root: number): BubbleCandidate | undefined {
    const { width, height, data } = this.raster;
    const id = ++this.sequence;
    let xMin = width, xMax = 0, yMin = height, yMax = 0, count = 1;
    this.visited[root] = id;
    this.queue[0] = root;
    for (let head = 0; head < count; head++) {
      const index = this.queue[head];
      const x = index % width, y = Math.floor(index / width);
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
      for (const neighbor of [x ? index - 1 : -1, x + 1 < width ? index + 1 : -1, index - width, index + width]) {
        if (neighbor < 0 || neighbor >= this.visited.length || this.visited[neighbor] || gray(data, neighbor) < 225) continue;
        this.visited[neighbor] = id;
        this.queue[count++] = neighbor;
      }
    }
    const bounds = { x: xMin, y: yMin, width: xMax - xMin + 1, height: yMax - yMin + 1 };
    const closed = xMin > 1 && yMin > 1 && xMax < width - 2 && yMax < height - 2;
    const usable = closed && count >= 90 && count < width * height * 0.55 &&
      count / (bounds.width * bounds.height) > 0.52;
    let candidate: BubbleCandidate | undefined;
    if (usable) {
      const profile = (length: number): Profile => ({
        count: new Uint32Array(length), low: new Uint32Array(length).fill(0xffffffff), high: new Uint32Array(length),
      });
      const columns = profile(bounds.width), rows = profile(bounds.height);
      const sample = (axis: Profile, at: number, elevation: number) => {
        axis.count[at]++;
        axis.low[at] = Math.min(axis.low[at], elevation);
        axis.high[at] = Math.max(axis.high[at], elevation);
      };
      for (let i = 0; i < count; i++) {
        const index = this.queue[i];
        const x = index % width, y = Math.floor(index / width);
        sample(columns, x - xMin, y);
        sample(rows, y - yMin, x);
      }
      candidate = { id, bounds, interior: true, profile: [columns, rows], pixels: this.queue.slice(0, count), stride: width };
    }
    this.regions.set(id, candidate ?? null);
    return candidate;
  }
}

/**
 * How far the outline dips inward from the convex hull of the interior, per side, summed. A single balloon is
 * close to convex, so this is near zero. Where two balloons overlap, the outline has a notch on one or both sides.
 * The deepest notch inside the window between two text blocks marks where to cut.
 */
function notch(profile: Profile, from: number, to: number): { at: number; depth: number } {
  const points: [number, number, number][] = [];
  for (let i = 0; i < profile.count.length; i++) if (profile.count[i]) points.push([i, profile.low[i], profile.high[i]]);
  const hull = (value: 1 | 2, sign: 1 | -1) => {
    const chain: [number, number][] = [];
    for (const point of points) {
      const next: [number, number] = [point[0], sign * point[value]];
      while (chain.length > 1 && (chain[chain.length - 1][0] - chain[chain.length - 2][0]) * (next[1] - chain[chain.length - 2][1]) -
        (chain[chain.length - 1][1] - chain[chain.length - 2][1]) * (next[0] - chain[chain.length - 2][0]) <= 0) chain.pop();
      chain.push(next);
    }
    return (at: number) => {
      for (let i = 1; i < chain.length; i++) {
        if (chain[i][0] >= at) {
          const [x0, y0] = chain[i - 1], [x1, y1] = chain[i];
          return sign * (y0 + ((y1 - y0) * (at - x0)) / Math.max(1, x1 - x0));
        }
      }
      return sign * (chain.at(-1)?.[1] ?? 0);
    };
  };
  const top = hull(1, 1), bottom = hull(2, -1);
  let best = { at: Math.round((from + to) / 2), depth: 0 };
  for (let i = Math.max(0, from); i <= Math.min(profile.count.length - 1, to); i++) {
    if (!profile.count[i]) continue;
    const depth = Math.max(0, profile.low[i] - top(i)) + Math.max(0, bottom(i) - profile.high[i]);
    if (depth > best.depth) best = { at: i, depth };
  }
  return best;
}

/** A connected interior can contain separate dialogue lobes. Split at a neck between OCR blocks. */
function splitLobes(group: Group): Group[] {
  const { candidate, lines } = group;
  if (!candidate.profile || lines.length < 2) return [group];
  const { bounds } = candidate;
  let best: { axis: 'x' | 'y'; at: number; score: number; before: OCRResult[]; after: OCRResult[] } | undefined;
  for (const [index, axis] of (['x', 'y'] as const).entries()) {
    const size = axis === 'x' ? 'width' : 'height';
    const profile = candidate.profile[index].count;
    const ordered = [...lines].sort((a, b) => a.bounds[axis] - b.bounds[axis]);
    let end = ordered[0].bounds[axis] + ordered[0].bounds[size];
    for (let i = 1; i < ordered.length; i++) {
      const { bounds: next } = ordered[i];
      const gap = next[axis] - end;
      if (gap >= 3) {
        const from = Math.ceil(end - bounds[axis]), to = Math.floor(next[axis] - bounds[axis]);
        if (from > profile.length * 0.17 && to < profile.length * 0.83) {
          const peak = (start: number, stop: number) => profile.subarray(start, stop).reduce((max, value) => Math.max(max, value), 0);
          const shoulder = Math.min(peak(0, from), peak(to, profile.length));
          let neck = Math.round((from + to) / 2);
          for (let x = from; x <= to; x++) if (profile[x] < profile[neck]) neck = x;
          const score = 1 - profile[neck] / Math.max(1, shoulder);
          if (score >= 0.22 && score > (best?.score ?? 0)) {
            const at = bounds[axis] + neck;
            best = { axis, at, score, before: lines.filter(line => line.bounds[axis] < at),
              after: lines.filter(line => line.bounds[axis] >= at) };
          }
          // A diagonal joint can sit above or below the narrow gap between the padded OCR boxes.
          const previous = ordered[i - 1];
          const leftShift = Math.abs(previous.bounds.x + previous.bounds.width / 2 - next.x - next.width / 2);
          const offsetWindow = axis === 'y' && !previous.vertical && !ordered[i].vertical &&
            leftShift > Math.min(previous.bounds.width, next.width) * 0.3
            ? Math.round(Math.min(previous.bounds.height, next.height) * 0.6) : 0;
          const waist = notch(candidate.profile[index], from - offsetWindow, to + offsetWindow);
          const span = axis === 'x' ? bounds.height : bounds.width;
          const strength = 0.22 + waist.depth / span;
          if (waist.depth >= 5 && waist.depth >= span * 0.06 && strength > (best?.score ?? 0)) {
            const at = bounds[axis] + clamp(waist.at, from, to);
            best = { axis, at, score: strength, before: lines.filter(line => line.bounds[axis] < at),
              after: lines.filter(line => line.bounds[axis] >= at) };
          }
        }
      }
      end = Math.max(end, next[axis] + next[size]);
    }
  }
  const stacks = splitStacks(group);
  if (!best) return stacks;
  // A cut across the rows of a text column cannot be right when the columns themselves split into two balloons.
  // Prefer the column split, and keep the physical outline for cleanup because the cut between the lobes is not an edge.
  if (best.axis === 'y' && stacks.length === 2 && stacks.every(stack => stack.lines.length >= 2) && stacks.some(stack => stack.candidate.interior) &&
      stacks.some(stack => stack.lines.some(line => best.before.includes(line)) && stack.lines.some(line => best.after.includes(line)))) {
    const physical = interiorShape(candidate);
    return stacks.map(stack => stack.candidate.interior ? { ...stack, candidate: { ...stack.candidate, maskShape: physical } } : stack);
  }
  const { axis, at, before, after } = best;
  const split = at - bounds[axis];
  const length = candidate.profile[axis === 'x' ? 0 : 1].count.length;
  return [lobe(candidate, axis, 0, split, before), lobe(candidate, axis, split, length, after)];
}

/** The part of a connected interior between two cuts along one axis, with its own bounds from the interior profile. */
function lobe(candidate: BubbleCandidate, axis: 'x' | 'y', start: number, end: number, lines: OCRResult[]): Group {
  const { bounds } = candidate;
  const profile = candidate.profile![axis === 'x' ? 0 : 1];
  const low = profile.low.subarray(start, end).reduce((min, value) => Math.min(min, value));
  const high = profile.high.subarray(start, end).reduce((max, value) => Math.max(max, value));
  const offset = bounds[axis] + start, length = end - start, span = high - low + 1;
  const boundsInLobe = axis === 'x' ? { x: offset, y: low, width: length, height: span }
    : { x: low, y: offset, width: span, height: length };
  const { pixels, stride } = candidate;
  if (!pixels || !stride) return { candidate: { ...candidate, profile: undefined, bounds: boundsInLobe }, lines };
  const kept = pixels.filter(index => {
    const at = axis === 'x' ? index % stride : Math.floor(index / stride);
    return at >= offset && at < offset + length;
  });
  return { candidate: { ...candidate, profile: undefined, bounds: boundsInLobe, pixels: kept }, lines };
}

/**
 * Outline of the light interior as a polygon. Each row (or column) contributes the span between its outermost
 * light pixels, taking the narrower span within a small band so the polygon stays inside the balloon. The
 * orientation that encloses less area follows the balloon more closely.
 */
function interiorShape(candidate: BubbleCandidate): Point[] | undefined {
  const { pixels, stride, bounds } = candidate;
  if (!pixels?.length || !stride) return undefined;
  const build = (vertical: boolean): Point[] => {
    const length = vertical ? bounds.width : bounds.height;
    const low = new Int32Array(length).fill(0x7fffffff), high = new Int32Array(length).fill(-1);
    for (const index of pixels) {
      const x = index % stride, y = Math.floor(index / stride);
      const along = vertical ? x - bounds.x : y - bounds.y, across = vertical ? y : x;
      if (along < 0 || along >= length) continue;
      if (across < low[along]) low[along] = across;
      if (across > high[along]) high[along] = across;
    }
    const band = Math.max(1, Math.ceil(length / 48));
    const first: Point[] = [], second: Point[] = [];
    const at = (position: number, level: number): Point => vertical ? { x: position, y: level } : { x: level, y: position };
    for (let start = 0; start < length; start += band) {
      const stop = Math.min(length, start + band);
      let near = -1, far = 0x7fffffff, seen = false;
      for (let i = start; i < stop; i++) {
        if (high[i] < 0) continue;
        seen = true;
        near = Math.max(near, low[i]);
        far = Math.min(far, high[i]);
      }
      if (!seen || far < near) continue;
      const from = (vertical ? bounds.x : bounds.y) + start, to = (vertical ? bounds.x : bounds.y) + stop;
      first.push(at(from, near), at(to, near));
      second.push(at(to, far + 1), at(from, far + 1));
    }
    return [...first, ...second.reverse()];
  };
  const area = (polygon: Point[]) => Math.abs(polygon.reduce((total, point, i) => {
    const next = polygon[(i + 1) % polygon.length];
    return total + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
  const polygons = [build(false), build(true)].filter(polygon => polygon.length >= 4);
  return polygons.sort((a, b) => area(a) - area(b))[0];
}

interface Stack { lines: OCRResult[]; x: number; end: number; y: number; bottom: number }

/** Lines that read as one block: stacked rows that share a column. Side-by-side lines belong to different blocks. */
function stacks(lines: OCRResult[]): Stack[] {
  const parent = lines.map((_line, index) => index);
  const root = (index: number): number => parent[index] === index ? index : (parent[index] = root(parent[index]));
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (related(lines[i].bounds, lines[j].bounds, false)) parent[root(i)] = root(j);
    }
  }
  const members = new Map<number, OCRResult[]>();
  lines.forEach((line, index) => members.set(root(index), [...members.get(root(index)) ?? [], line]));
  return [...members.values()].map(entries => {
    const box = entries.reduce((total, line) => union(total, line.bounds), entries[0].bounds);
    return { lines: entries, x: box.x, end: box.x + box.width, y: box.y, bottom: box.y + box.height };
  }).sort((a, b) => a.x - b.x);
}

function alignedRows(left: Stack, right: Stack): boolean {
  if (left.lines.length !== right.lines.length) return false;
  const baseline = ({ bounds }: OCRResult) => bounds.y + bounds.height / 2;
  const byBaseline = (a: OCRResult, b: OCRResult) => baseline(a) - baseline(b);
  const lines = [...right.lines].sort(byBaseline);
  return [...left.lines].sort(byBaseline).every((line, index) =>
    Math.abs(baseline(line) - baseline(lines[index])) <=
      Math.min(line.bounds.height, lines[index].bounds.height) * 0.4);
}

/**
 * Two balloons drawn into each other form one light region without a narrow neck, so the profile cannot
 * split them. Their text still sits in separate columns: rows stacked inside each block, the blocks side by
 * side on shared rows with clear space between them. A single multi-line block next to a lone line, or two
 * multi-line blocks, are separate dialogue. Two single lines are left together because one line may have
 * been read as two boxes. Vertical text keeps its own column logic and is never split here.
 */
function splitStacks(group: Group): Group[] {
  const { candidate, lines } = group;
  if (!candidate.profile || lines.some(line => line.vertical)) return [group];
  const blocks = stacks(lines);
  if (blocks.length < 2) return [group];
  const cuts: number[] = [];
  const corner: Stack[] = [];
  let reach = blocks[0].end;
  let previous = blocks[0];
  const segments: Stack[][] = [[blocks[0]]];
  for (const block of blocks.slice(1)) {
    const gap = block.x - reach;
    const shared = Math.min(previous.bottom, block.bottom) - Math.max(previous.y, block.y);
    const smaller = Math.min(previous.bottom - previous.y, block.bottom - block.y);
    const precedingLines = segments.at(-1)!.reduce((count, stack) => count + stack.lines.length, 0);
    const multiline = Math.max(block.lines.length, precedingLines) > 1;
    const rowHeight = Math.min(...block.lines.map(line => line.bounds.height));
    // OCR boxes include padding around glyphs, so neighboring dialogue columns can overlap by a few pixels.
    const paddedGap = precedingLines > 1 && block.lines.length > 1 && gap >= -rowHeight * 0.32;
    const fragments = gap < rowHeight * 0.9 && alignedRows(previous, block);
    if (!fragments && (gap >= 3 || paddedGap) && shared >= -rowHeight * 0.5 && multiline) {
      cuts.push(Math.round((reach + block.x) / 2 - candidate.bounds.x));
      segments.push([block]);
    } else if (!fragments && gap < 3 && (block.x + block.end) / 2 >= reach && shared >= smaller * 0.2 && multiline) {
      // Text hanging off the corner of a balloon: its centre is outside the block's column. It is not part of
      // the balloon, so it becomes its own free text group and the balloon keeps its text.
      corner.push(block);
      continue;
    } else segments.at(-1)!.push(block);
    reach = Math.max(reach, block.end);
    previous = block;
  }
  const length = candidate.profile[0].count.length;
  if (cuts.some((cut, index) => cut <= (cuts[index - 1] ?? 0) || cut >= length)) return [group];
  if (!cuts.length && !corner.length) return [group];
  const lobes = cuts.length
    ? segments.map((members, index) => lobe(candidate, 'x', cuts[index - 1] ?? 0, cuts[index] ?? length, members.flatMap(stack => stack.lines)))
    : [{ candidate, lines: segments.flat().flatMap(stack => stack.lines) }];
  const free = corner.map(({ lines: entries }): Group => ({
    candidate: { bounds: entries.reduce((total, line) => union(total, line.bounds), entries[0].bounds), id: -1, interior: false },
    lines: entries,
  }));
  return [...lobes, ...free];
}

export function detectBubbles(raster: ImageData, recognized: OCRResult[]): { bubble: BubbleRegion; recognized: OCRResult[] }[] {
  const light = new LightRegions(raster);
  const groups: Group[] = [];
  for (const line of [...recognized].sort((a, b) => a.bounds.y - b.bounds.y)) {
    const enclosed = light.find(line.bounds);
    const existing = enclosed
      ? groups.find(group => group.candidate.id === enclosed.id)
      : groups.find(group => !group.candidate.interior && group.lines.some(previous =>
        previous.vertical === line.vertical && (related(previous.bounds, line.bounds, line.vertical) ||
          (!line.vertical && sameRow(previous.bounds, line.bounds)))));
    if (existing) {
      existing.lines.push(line);
      if (!existing.candidate.interior) existing.candidate.bounds = union(existing.candidate.bounds, line.bounds);
    } else {
      groups.push({ candidate: enclosed ?? { bounds: line.bounds, id: -1, interior: false }, lines: [line] });
    }
  }
  return isolateBubbleLayouts(groups.flatMap(splitLobes).map(({ candidate, lines }, index) => {
    const text = lines.reduce((bounds, line) => union(bounds, line.bounds), lines[0].bounds);
    const shape = candidate.interior ? interiorShape(candidate) : undefined;
    const edge = candidate.bounds;
    // One pixel off the outline keeps neighbouring lobes of a connected interior apart.
    const bounds = shape ? { x: edge.x + 1, y: edge.y + 1, width: Math.max(1, edge.width - 2), height: Math.max(1, edge.height - 2) } : around(text, raster.width, raster.height, 0.08);
    const regions: TextRegion[] = lines.map(line => ({ bounds: line.bounds, polygon: rectPolygon(line.bounds) }));
    const heights = lines.map(line => line.bounds.height).sort((a, b) => a - b);
    return { bubble: { id: `bubble-${index + 1}`, bounds, lines: regions, ...shape && { shape }, ...candidate.maskShape && { maskShape: candidate.maskShape }, enclosed: Boolean(shape),
      textSize: heights[Math.floor(heights.length / 2)] }, recognized: lines };
  }));
}
