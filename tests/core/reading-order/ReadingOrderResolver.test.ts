import { describe, expect, it } from 'vitest';
import { readingOrder, resolveReadingOrder, speechLineOrder } from '../../../src/core/reading-order/ReadingOrderResolver';

interface Item { id: string; bounds: { x: number; y: number; width: number; height: number } }
const box = (id: string, x: number, y: number, width: number, height: number): Item => ({ id, bounds: { x, y, width, height } });
const ids = (items: Item[]) => items.map(item => item.id);

describe('readingOrder: right-to-left (vertical Japanese columns)', () => {
  const columns = [box('left', 100, 50, 30, 200), box('right', 200, 50, 30, 200), box('middle', 150, 55, 30, 190)];

  it('orders columns from right to left', () => {
    expect(ids(readingOrder(columns, 'rtl'))).toEqual(['right', 'middle', 'left']);
  });

  it('is independent of input order', () => {
    const shuffled = [columns[1], columns[2], columns[0]];
    expect(ids(readingOrder(shuffled, 'rtl'))).toEqual(['right', 'middle', 'left']);
    expect(ids(readingOrder([...columns].reverse(), 'rtl'))).toEqual(['right', 'middle', 'left']);
  });

  it('reads the upper bubble before a lower one, each bubble right-to-left', () => {
    const items = [
      box('lower-left', 40, 400, 30, 150), box('lower-right', 90, 400, 30, 150),
      box('upper-left', 300, 50, 30, 150), box('upper-right', 350, 50, 30, 150),
    ];
    expect(ids(readingOrder(items, 'rtl'))).toEqual(['upper-right', 'upper-left', 'lower-right', 'lower-left']);
  });

  it('breaks an x tie by the higher item first', () => {
    const items = [box('lower', 100, 60, 30, 100), box('upper', 100, 50, 30, 100)];
    expect(ids(readingOrder(items, 'rtl'))).toEqual(['upper', 'lower']);
  });
});

describe('readingOrder: top-to-bottom rows', () => {
  it('keeps staggered but vertically overlapping speech lines in order', () => {
    const lines = [box('girl', 234, 110, 65, 42), box('this-isnt', 207, 135, 120, 35), box('bowling', 212, 159, 108, 41)]
      .map(line => ({ ...line, text: line.id, vertical: false, confidence: 0.9 }));
    expect(ids(speechLineOrder(lines))).toEqual(['girl', 'this-isnt', 'bowling']);
  });

  it('orders stacked lines from top to bottom', () => {
    const lines = [box('c', 10, 100, 200, 20), box('a', 10, 20, 200, 20), box('b', 10, 60, 200, 20)];
    expect(ids(readingOrder(lines, 'ttb'))).toEqual(['a', 'b', 'c']);
  });

  it('keeps rows apart when lines do not overlap vertically', () => {
    const lines = [box('b', 10, 50, 100, 20), box('a', 200, 10, 100, 20)];
    expect(ids(readingOrder(lines, 'ttb'))).toEqual(['a', 'b']);
  });

  // Regression: 'ttb' rows used to sort by `y` first, so side-by-side boxes were ordered by pixel noise.
  it('reads two boxes in the same row left to right even when the right one is a pixel higher', () => {
    const items = [box('right', 200, 10, 100, 20), box('left', 10, 11, 100, 20)];
    expect(ids(readingOrder(items, 'ttb'))).toEqual(['left', 'right']);
  });
});

describe('readingOrder: general', () => {
  it('returns an empty array for no items and one item unchanged', () => {
    expect(readingOrder([], 'rtl')).toEqual([]);
    const only = box('only', 1, 2, 3, 4);
    expect(readingOrder([only], 'ttb')).toEqual([only]);
  });

  it('does not mutate the input array', () => {
    const input = [box('b', 200, 10, 30, 100), box('a', 100, 10, 30, 100)];
    readingOrder(input, 'rtl');
    expect(ids(input)).toEqual(['b', 'a']);
  });

  it('returns every item exactly once', () => {
    const input = Array.from({ length: 30 }, (_, i) => box(`n${i}`, (i * 37) % 400, (i * 53) % 600, 20 + (i % 5) * 10, 20 + (i % 7) * 8));
    const output = readingOrder(input, 'rtl');
    expect(ids(output).sort()).toEqual(ids(input).sort());
  });

  it('preserves extra fields on items (generic passthrough)', () => {
    const items = [{ ...box('a', 0, 0, 10, 10), text: 'こんにちは' }];
    expect(readingOrder(items, 'ttb')[0].text).toBe('こんにちは');
  });

  it('uses a minimum row tolerance for tiny boxes', () => {
    // 6 px apart vertically, boxes only 4 px tall: the 12 px floor still groups them into one row.
    const items = [box('left-lower', 10, 16, 20, 4), box('right-upper', 60, 10, 20, 4)];
    expect(readingOrder(items, 'rtl').map(item => item.id)).toEqual(['right-upper', 'left-lower']);
  });
});

describe('resolveReadingOrder', () => {
  const vertical = [box('left', 100, 50, 30, 200), box('right', 200, 50, 30, 200)];

  it('auto picks right-to-left for Japanese', () => {
    expect(ids(resolveReadingOrder(vertical, 'auto', 'ja'))).toEqual(['right', 'left']);
  });

  it.each(['ko', 'zh', 'en', 'auto'] as const)('auto picks top-to-bottom for %s', language => {
    const lines = [box('lower', 10, 100, 100, 20), box('upper', 10, 10, 100, 20)];
    expect(ids(resolveReadingOrder(lines, 'auto', language))).toEqual(['upper', 'lower']);
  });

  it('honours an explicit setting over the language', () => {
    expect(ids(resolveReadingOrder(vertical, 'rtl', 'en'))).toEqual(['right', 'left']);
    const stacked = [box('lower', 10, 100, 100, 20), box('upper', 10, 10, 100, 20)];
    expect(ids(resolveReadingOrder(stacked, 'ttb', 'ja'))).toEqual(['upper', 'lower']);
  });
});
