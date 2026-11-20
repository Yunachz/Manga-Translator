import { describe, expect, it } from 'vitest';
import type { Rect } from '../../../src/types/contracts';
import { isSeamFragment } from '../../../src/core/ocr/seamFragments';

// Two stacked caption lines, about 46 px tall, whose boxes meet at y = 258.
const above: Rect = { x: 667, y: 213, width: 248, height: 45 };
const below: Rect = { x: 635, y: 258, width: 314, height: 48 };
const lines = [above, below];

describe('seam fragments', () => {
  it('absorbs a small unreadable detection on the seam between two stacked lines', () => {
    expect(isSeamFragment({ x: 703, y: 254, width: 32, height: 11 }, lines)).toBe(true);
  });

  it('keeps a fragment of a letter that sits inside one line as an unread mark', () => {
    expect(isSeamFragment({ x: 703, y: 225, width: 32, height: 11 }, lines)).toBe(false);
  });

  it('keeps a mark beside the lines, or past the last one', () => {
    expect(isSeamFragment({ x: 960, y: 254, width: 32, height: 11 }, lines)).toBe(false);
    expect(isSeamFragment({ x: 703, y: 330, width: 32, height: 11 }, lines)).toBe(false);
  });

  it('keeps a detection as tall as a line, which may be a line of its own', () => {
    expect(isSeamFragment({ x: 703, y: 240, width: 60, height: 40 }, lines)).toBe(false);
  });

  it('needs two lines to make a seam', () => {
    expect(isSeamFragment({ x: 703, y: 254, width: 32, height: 11 }, [above])).toBe(false);
    expect(isSeamFragment({ x: 703, y: 254, width: 32, height: 11 }, [])).toBe(false);
  });
});
