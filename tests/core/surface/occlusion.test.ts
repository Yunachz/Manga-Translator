import { describe, expect, it } from 'vitest';
import { anchorCell, clearWindow, windowRect, type CellWindow } from '../../../src/core/surface/occlusion';

/** `#` is a covered cell, `.` is clear. */
const grid = (...rows: string[]) => rows.map(row => [...row].map(cell => cell === '#'));
const covered = (window: CellWindow, rows: readonly (readonly boolean[])[]) => {
  for (let row = window.top; row <= window.bottom; row++) for (let column = window.left; column <= window.right; column++) if (rows[row][column]) return true;
  return false;
};
const contains = (window: CellWindow, row: number, column: number) =>
  row >= window.top && row <= window.bottom && column >= window.left && column <= window.right;

describe('crop around a clicked point', () => {
  // A menu stands in the middle of the page. The page shows on both sides of it.
  const middle = grid(
    '..........',
    '..........',
    '....##....',
    '....##....',
    '....##....',
    '....##....',
    '..........',
    '..........',
    '..........',
  );

  it('keeps a click left of a middle occluder inside a crop that is clear', () => {
    const window = clearWindow(middle, { row: 4, column: 1 }, 0.1)!;
    expect(window).toBeDefined();
    expect(contains(window, 4, 1)).toBe(true);
    expect(covered(window, middle)).toBe(false);
  });

  it('keeps a click right of the occluder inside a crop that is clear', () => {
    const window = clearWindow(middle, { row: 4, column: 8 }, 0.1)!;
    expect(contains(window, 4, 8)).toBe(true);
    expect(covered(window, middle)).toBe(false);
  });

  it('gives different crops for the two sides and the same crop every time', () => {
    const left = clearWindow(middle, { row: 4, column: 1 }, 0.1)!;
    const right = clearWindow(middle, { row: 4, column: 8 }, 0.1)!;
    expect(left.right).toBeLessThan(right.left);
    expect(clearWindow(middle, { row: 4, column: 1 }, 0.1)).toEqual(left);
  });

  it('refuses a click that lands on the occluder', () => {
    expect(clearWindow(middle, { row: 3, column: 4 }, 0.1)).toBeUndefined();
    expect(clearWindow(middle, { row: 99, column: 0 }, 0.1)).toBeUndefined();
  });

  it('prefers the tallest crop above or below the occluder when the click is clear of it on both axes', () => {
    const window = clearWindow(middle, { row: 0, column: 4 }, 0.1)!;
    expect(contains(window, 0, 4)).toBe(true);
    expect(covered(window, middle)).toBe(false);
    // A full-width band above the occluder beats a narrow column beside it.
    expect(window.left).toBe(0);
    expect(window.right).toBe(9);
  });

  it('keeps one cell of margin from the occluder without losing the click', () => {
    const rows = grid('.....', '.....', '..#..', '.....');
    const window = clearWindow(rows, { row: 0, column: 0 }, 0.1)!;
    expect(contains(window, 0, 0)).toBe(true);
    expect(covered(window, rows)).toBe(false);
    // The window never ends on the cell next to the occluder when it can stop one earlier.
    const next = clearWindow(grid('......', '..#...', '......'), { row: 0, column: 5 }, 0.1)!;
    expect(next).toEqual({ top: 0, bottom: 2, left: 4, right: 5 });
    expect(covered(next, grid('......', '..#...', '......'))).toBe(false);
  });

  it('gives up when too little of the page is left around the click', () => {
    const narrow = grid('.####', '.####', '.####', '.####');
    expect(clearWindow(narrow, { row: 1, column: 0 }, 0.3)).toBeUndefined();
    expect(clearWindow(narrow, { row: 1, column: 0 }, 0.1)).toEqual({ top: 0, bottom: 3, left: 0, right: 0 });
  });

  it('is the whole grid when nothing covers it', () => {
    expect(clearWindow(grid('...', '...'), { row: 1, column: 2 })).toEqual({ top: 0, bottom: 1, left: 0, right: 2 });
  });
});

describe('crop with no click anchor, as the visible-pages run needs', () => {
  it('trims a header band away from the top', () => {
    const rows = grid('######', '######', '......', '......', '......', '......', '......', '......');
    const window = clearWindow(rows)!;
    expect(covered(window, rows)).toBe(false);
    expect(window.top).toBeGreaterThanOrEqual(2);
    expect(window.bottom).toBe(7);
    expect(window.left).toBe(0);
    expect(window.right).toBe(5);
  });

  it('is the whole page when nothing covers it and gives up when too little is clear', () => {
    expect(clearWindow(grid('....', '....'))).toEqual({ top: 0, bottom: 1, left: 0, right: 3 });
    expect(clearWindow(grid('####', '####', '#..#', '####'))).toBeUndefined();
    expect(clearWindow([])).toBeUndefined();
  });
});

describe('grid geometry', () => {
  it('finds the cell of a point in the sampled area and refuses a point outside it', () => {
    const area = { x: 0.25, y: 0.5, width: 0.5, height: 0.5 };
    expect(anchorCell({ x: 0.3, y: 0.55 }, area, 10, 4)).toEqual({ row: 1, column: 0 });
    expect(anchorCell({ x: 0.75, y: 1 }, area, 10, 4)).toEqual({ row: 9, column: 3 });
    expect(anchorCell({ x: 0.2, y: 0.6 }, area, 10, 4)).toBeUndefined();
    expect(anchorCell({ x: 0.5, y: 0.4 }, area, 10, 4)).toBeUndefined();
  });

  it('turns a window back into a rectangle of the grid area', () => {
    expect(windowRect({ top: 2, bottom: 5, left: 1, right: 2 }, 10, 4)).toEqual({ x: 0.25, y: 0.2, width: 0.5, height: 0.4 });
  });
});
