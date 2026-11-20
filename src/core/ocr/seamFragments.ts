import type { Rect } from '../../types/contracts';

/** A fragment taller than this share of the lines around it could be a line of its own. */
const SMALL = 0.4;
/** Share of the fragment's width that each neighbouring line must span. */
const SPAN = 0.8;
/** How far past the gap between two lines a fragment may reach, relative to the line height. */
const REACH = 0.2;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function spans(line: Rect, fragment: Rect): boolean {
  const overlap = Math.min(line.x + line.width, fragment.x + fragment.width) - Math.max(line.x, fragment.x);
  return overlap >= fragment.width * SPAN;
}

/**
 * A detection that read as nothing and sits on the seam between two stacked lines of one caption: a bit of outline
 * or a letter's foot that the detector split off. It belongs to those lines, so it must not cut the caption in two
 * or count as unread text. A detection beside one line, or away from the seam, is still an unread mark.
 */
export function isSeamFragment(fragment: Rect, lines: readonly Rect[]): boolean {
  if (lines.length < 2) return false;
  const height = median(lines.map(line => line.height));
  if (fragment.height > height * SMALL) return false;
  const reach = height * REACH;
  const centre = fragment.y + fragment.height / 2;
  return lines.some(above => lines.some(below => {
    if (above === below) return false;
    const seams = [above.y + above.height, below.y];
    const near = fragment.y < Math.max(...seams) + reach && fragment.y + fragment.height > Math.min(...seams) - reach;
    return near && centre > above.y + above.height / 2 && centre < below.y + below.height / 2 && spans(above, fragment) && spans(below, fragment);
  }));
}
