import type { Point, Rect } from '../../types/contracts';

/** Inclusive range of grid cells. */
export interface CellWindow { top: number; bottom: number; left: number; right: number }
export interface CellAnchor { row: number; column: number }
type Covered = readonly (readonly boolean[])[];

/** Smallest share of the sampled area a crop must keep to be worth reading. */
export const minimumShare = 0.3;

/** The grid cell a point falls in, for a grid laid over `area` (both in the same normalized coordinates). */
export function anchorCell(point: Point, area: Rect, rows: number, columns: number): CellAnchor | undefined {
  if (area.width <= 0 || area.height <= 0) return;
  const x = (point.x - area.x) / area.width, y = (point.y - area.y) / area.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  return { row: Math.min(rows - 1, Math.floor(y * rows)), column: Math.min(columns - 1, Math.floor(x * columns)) };
}

/** The window as a rectangle of the grid area, normalized to it. */
export function windowRect(window: CellWindow, rows: number, columns: number): Rect {
  return { x: window.left / columns, y: window.top / rows, width: (window.right - window.left + 1) / columns, height: (window.bottom - window.top + 1) / rows };
}

function area(window: CellWindow): number {
  return (window.right - window.left + 1) * (window.bottom - window.top + 1);
}

function coveredCells(covered: Covered, window: CellWindow): number {
  let count = 0;
  for (let row = window.top; row <= window.bottom; row++) for (let column = window.left; column <= window.right; column++) count += Number(covered[row][column]);
  return count;
}

/** True when any cell just outside one side of the window, along that side, is covered. */
function bordersCover(covered: Covered, window: CellWindow, side: keyof CellWindow): boolean {
  const rows = covered.length, columns = covered[0]?.length ?? 0;
  if (side === 'top' || side === 'bottom') {
    const row = side === 'top' ? window.top - 1 : window.bottom + 1;
    if (row < 0 || row >= rows) return false;
    for (let column = window.left; column <= window.right; column++) if (covered[row][column]) return true;
    return false;
  }
  const column = side === 'left' ? window.left - 1 : window.right + 1;
  if (column < 0 || column >= columns) return false;
  for (let row = window.top; row <= window.bottom; row++) if (covered[row][column]) return true;
  return false;
}

/**
 * A sample sits at a cell centre, so a cell next to an occluder can be partly under it. Pull each side that touches
 * an occluder in by one cell, but never so far that the anchor leaves the window.
 */
function withMargin(covered: Covered, window: CellWindow, anchor?: CellAnchor): CellWindow {
  const next = { ...window };
  const sides = ['top', 'bottom', 'left', 'right'] as const;
  for (const side of sides) {
    if (!bordersCover(covered, window, side)) continue;
    const trial = { ...next, [side]: next[side] + (side === 'top' || side === 'left' ? 1 : -1) };
    if (trial.top > trial.bottom || trial.left > trial.right) continue;
    if (anchor && (anchor.row < trial.top || anchor.row > trial.bottom || anchor.column < trial.left || anchor.column > trial.right)) continue;
    Object.assign(next, trial);
  }
  return next;
}

/** The largest window with no covered cell that contains the anchor. Ties go to the higher, then the more left, window. */
function largestAround(covered: Covered, anchor: CellAnchor): CellWindow | undefined {
  const rows = covered.length, columns = covered[0]?.length ?? 0;
  if (covered[anchor.row]?.[anchor.column] !== false) return;
  // Prefix sums make "no covered cell in this window" a constant-time check.
  const sums = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    sums[row + 1][column + 1] = sums[row][column + 1] + sums[row + 1][column] - sums[row][column] + Number(covered[row][column]);
  }
  const clear = ({ top, bottom, left, right }: CellWindow) =>
    sums[bottom + 1][right + 1] - sums[top][right + 1] - sums[bottom + 1][left] + sums[top][left] === 0;
  let best: CellWindow | undefined;
  for (let top = 0; top <= anchor.row; top++) for (let bottom = anchor.row; bottom < rows; bottom++) {
    for (let left = 0; left <= anchor.column; left++) for (let right = anchor.column; right < columns; right++) {
      const window = { top, bottom, left, right };
      if (best && area(window) <= area(best)) continue;
      if (clear(window)) best = window;
    }
  }
  return best;
}

/** Without an anchor: trim the edge with the most covered cells until none is covered. */
function trimmed(covered: Covered): CellWindow | undefined {
  const rows = covered.length, columns = covered[0]?.length ?? 0;
  const window: CellWindow = { top: 0, bottom: rows - 1, left: 0, right: columns - 1 };
  const count = (side: keyof CellWindow): number => {
    const cells = side === 'top' || side === 'bottom'
      ? covered[window[side]].slice(window.left, window.right + 1)
      : covered.slice(window.top, window.bottom + 1).map(line => line[window[side]]);
    return cells.filter(Boolean).length;
  };
  while (window.top <= window.bottom && window.left <= window.right && coveredCells(covered, window) > 0) {
    const [side] = (['top', 'bottom', 'left', 'right'] as const).map(edge => [edge, count(edge)] as const).sort((a, b) => b[1] - a[1])[0];
    window[side] += side === 'top' || side === 'left' ? 1 : -1;
  }
  return window.top <= window.bottom && window.left <= window.right ? window : undefined;
}

/**
 * The part of a sampled surface that a tab capture can show: a window of grid cells with nothing opaque over it.
 * With an anchor (the point the user clicked) the window is the largest clear one that contains it, wherever the
 * occluder sits, and a covered anchor gives nothing, because the click is not on the page. With no anchor, which is
 * the case for a visible-pages run, the covered edges are trimmed away instead. Deterministic for a given grid.
 */
export function clearWindow(covered: Covered, anchor?: CellAnchor, share = minimumShare): CellWindow | undefined {
  const rows = covered.length, columns = covered[0]?.length ?? 0;
  if (!rows || !columns) return;
  const found = anchor ? largestAround(covered, anchor) : trimmed(covered);
  if (!found) return;
  const window = withMargin(covered, found, anchor);
  return area(window) / (rows * columns) >= share ? window : undefined;
}
