import { describe, expect, it } from 'vitest';
import type { OCRResult, Rect } from '../../../src/types/contracts';
import { typicalLettering } from '../../../src/core/inpainting/classifyLine';

const line = (height: number, text = 'WORDS'): OCRResult => ({ id: text + height, text, confidence: 0.95, bounds: { x: 0, y: 0, width: 100, height }, vertical: false });
const group = (enclosed: boolean, ...lines: OCRResult[]) => ({
  bubble: { id: 'g', bounds: { x: 0, y: 0, width: 10, height: 10 } as Rect, lines: lines.map(entry => ({ bounds: entry.bounds, polygon: [] })), enclosed },
  recognized: lines,
});

describe('typical lettering height', () => {
  it('is the median line height inside balloons when the page has balloons', () => {
    expect(typicalLettering([group(true, line(20), line(24), line(26)), group(false, line(90))], 1200)).toBe(24);
  });

  it('falls back to the page width when there is nothing to measure', () => {
    expect(typicalLettering([], 1140)).toBe(30);
    expect(typicalLettering([], 300)).toBe(15);
  });

  it('is set by several outside lines that agree, so a large caption is not all "oversized"', () => {
    const caption = group(false, line(47), line(45), line(48), line(46), line(51));
    expect(typicalLettering([caption], 1266)).toBe(47);
  });

  it('keeps the width fallback for a lone line, which cannot be told from a sound effect', () => {
    expect(typicalLettering([group(false, line(78, "'sh"))], 1000)).toBe(Math.max(15, 1000 / 38));
  });

  it('keeps the width fallback when the outside lines are of unrelated sizes', () => {
    const mixed = group(false, line(20), line(60), line(110), line(30), line(150));
    expect(typicalLettering([mixed], 1266)).toBe(Math.max(15, 1266 / 38));
  });

  it('never goes below the width fallback', () => {
    expect(typicalLettering([group(false, line(10), line(10), line(11), line(10))], 1266)).toBe(Math.max(15, 1266 / 38));
  });
});
