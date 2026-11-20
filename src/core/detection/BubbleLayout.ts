import type { BubbleRegion } from '../../types/contracts';
import { clamp } from '../image/geometry';

type Axis = 'x' | 'y';
const length = { x: 'width', y: 'height' } as const;

function textCenter(bubble: BubbleRegion, axis: Axis): number {
  const size = length[axis];
  const centers = bubble.lines.map(({ bounds }) => bounds[axis] + bounds[size] / 2).sort((a, b) => a - b);
  return centers[Math.floor(centers.length / 2)] ?? bubble.bounds[axis] + bubble.bounds[size] / 2;
}

function separate(a: BubbleRegion, b: BubbleRegion): void {
  const axes = ['x', 'y'] as const;
  if (axes.some(axis => {
    const size = length[axis];
    return a.bounds[axis] + a.bounds[size] <= b.bounds[axis] || b.bounds[axis] + b.bounds[size] <= a.bounds[axis];
  })) return;

  const cuts = axes.flatMap(axis => {
    const size = length[axis];
    const centerA = textCenter(a, axis), centerB = textCenter(b, axis);
    const [first, second] = centerA <= centerB ? [a, b] : [b, a];
    const firstEnd = first.bounds[axis] + first.bounds[size], secondEnd = second.bounds[axis] + second.bounds[size];
    const low = Math.max(second.bounds[axis], first.bounds[axis] + Math.min(10, first.bounds[size] / 3));
    const high = Math.min(firstEnd, secondEnd - Math.min(10, second.bounds[size] / 3));
    if (low > high) return [];
    return [{ axis, first, second, secondEnd, cut: clamp((centerA + centerB) / 2, low, high),
      score: Math.abs(centerA - centerB) / Math.max(a.bounds[size], b.bounds[size]) }];
  }).sort((left, right) => right.score - left.score);
  const best = cuts[0];
  if (!best) return;
  const { axis, first, second, secondEnd, cut } = best;
  const size = length[axis];
  first.bounds[size] = Math.min(first.bounds[size], cut - first.bounds[axis]);
  second.bounds[axis] = Math.max(second.bounds[axis], cut);
  second.bounds[size] = secondEnd - second.bounds[axis];
}

/** Typesetting boxes from contour or OCR can overlap even when the dialogue groups are already distinct. */
export function isolateBubbleLayouts<T extends { bubble: BubbleRegion }>(groups: T[]): T[] {
  for (let first = 0; first < groups.length; first++) {
    for (let next = first + 1; next < groups.length; next++) separate(groups[first].bubble, groups[next].bubble);
  }
  return groups;
}
