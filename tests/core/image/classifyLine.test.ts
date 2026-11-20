import { expect, it } from 'vitest';
import type { BubbleRegion, OCRResult } from '../../../src/types/contracts';
import { classifyLine, type LineContext } from '../../../src/core/inpainting/classifyLine';

const size = 160;
const bounds = { x: 50, y: 50, width: 60, height: 40 };

/** White page with dark glyph bars inside the line box. A toned page also has a sparse dot screen all over it. */
function page(toned: boolean): ImageData {
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  const paint = (x: number, y: number, value: number) => data.fill(value, (y * size + x) * 4, (y * size + x) * 4 + 3);
  if (toned) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if ((x + y) % 3 === 0) paint(x, y, 220);
  for (const left of [62, 74, 86]) for (let y = 60; y < 80; y++) for (let x = left; x < left + 5; x++) paint(x, y, 10);
  return { width: size, height: size, data } as unknown as ImageData;
}

const group = (enclosed: boolean, lineBounds = bounds) => {
  const recognized: OCRResult[] = [];
  const bubble: BubbleRegion = { id: 'bubble-1', bounds: { x: 40, y: 40, width: 80, height: 60 }, lines: [], enclosed };
  return { bubble, recognized, add(text: string, confidence: number) {
    const result: OCRResult = { id: text, text, confidence, bounds: lineBounds, vertical: false };
    recognized.push(result);
    bubble.lines.push({ bounds: lineBounds, polygon: [] });
    return result;
  } };
};

const context = (toned: boolean, typicalLettering = 20): LineContext =>
  ({ raster: page(toned), source: 'en', mode: 'normal', typicalLettering, protectedRegions: [] });

it('keeps an oversized sound effect with a leading apostrophe on a toned background, whatever its confidence', () => {
  const free = group(false);
  const effect = free.add("'sh", 0.855);
  expect(classifyLine(context(true), free, effect)).toBe('keep');
});

it('still cleans the same big lettering on a flat background or inside a balloon', () => {
  const free = group(false);
  expect(classifyLine(context(false), free, free.add("'sh", 0.855))).toBe('clean');
  const balloon = group(true);
  expect(classifyLine(context(true), balloon, balloon.add("'sh", 0.855))).toBe('clean');
});

it('does not hold back lettering of ordinary size, or sentences, on a toned background', () => {
  const small = group(false);
  expect(classifyLine(context(true, 40), small, small.add('Yay!', 0.935))).toBe('clean');
  const sentence = group(false);
  expect(classifyLine(context(true), sentence, sentence.add('We should go home now', 0.93))).toBe('clean');
});

it('trims punctuation before testing for an uncertain isolated token', () => {
  const free = group(false);
  expect(classifyLine(context(false), free, free.add("'sh", 0.8))).toBe('keep');
  const confident = group(false);
  expect(classifyLine(context(false), confident, confident.add("'sh", 0.9))).toBe('clean');
});

it('reports lines inside a protected region as covered and unreadable lines as kept', () => {
  const free = group(false);
  const covered = { ...context(false), protectedRegions: [bounds] };
  expect(classifyLine(covered, free, free.add('Yay!', 0.95))).toBe('covered');
  const blank = group(false);
  expect(classifyLine(context(false), blank, blank.add('', 0))).toBe('keep');
});
