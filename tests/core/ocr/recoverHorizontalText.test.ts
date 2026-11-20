import { expect, it, vi } from 'vitest';
import type { OCRResult, Rect } from '../../../src/types/contracts';
import { rectPolygon } from '../../../src/core/image/geometry';
import { recoverHorizontalText, unreliableShortLatin } from '../../../src/core/ocr/recoverHorizontalText';

const box = { x: 10, y: 10, width: 120, height: 78 };
const region = { bounds: box, polygon: rectPolygon(box) };
const line = (text: string, bounds: Rect, confidence = 0.9): OCRResult => ({ id: 'line', text, confidence, bounds, vertical: false });

function raster(rows: (number | [number, number])[]): ImageData {
  const width = 150, height = 100;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const value of rows) {
    const [row, thickness] = typeof value === 'number' ? [value, 8] : value;
    for (let y = row; y < row + thickness; y++) for (let x = 29; x < 110; x++) {
      if (x % 7 < 3) data.fill(20, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  }
  return { width, height, data } as ImageData;
}

it('recovers four independently read lines from a merged crop that decoded as a single letter', async () => {
  const dialogue = ['Yuu,', 'stop copying', 'pro players’', 'techniques.'];
  const result = await recoverHorizontalText(raster([18, 35, 52, 69]), [region], [line('g', box, 0.399)], 'en',
    async regions => regions.map(({ bounds }, index) => line(dialogue[index], bounds)));
  expect(result.lines.map(row => row.text)).toEqual(dialogue);
  expect(result.unread).toEqual([]);
  expect(new Set(result.lines.map(row => row.id)).size).toBe(4);
});

it('does not turn a few descender pixels into an unread line between dialogue rows', async () => {
  const retry = vi.fn(async () => []);
  const original = line('You think', box, 0.82);
  const result = await recoverHorizontalText(raster([18, [34, 4]]), [region], [original], 'en', retry);
  expect(result).toEqual({ lines: [original], unread: [] });
  expect(retry).not.toHaveBeenCalled();
});

it('distinguishes weak mixed-symbol artefacts from a readable score and real one-letter words', () => {
  expect(unreliableShortLatin(line('$f+\\$', box, 0.57))).toBe(true);
  expect(unreliableShortLatin(line('w', box, 0.37))).toBe(true);
  expect(unreliableShortLatin(line('A', box, 0.50))).toBe(false);
  expect(unreliableShortLatin(line('1–0.', box, 0.69))).toBe(false);
});

it('keeps credible short text on a single row and never sends a weak isolated letter from a wide crop', async () => {
  const retry = vi.fn(async () => []);
  const original = line('Ho!', box);
  expect(await recoverHorizontalText(raster([33]), [region], [original], 'en', retry)).toEqual({ lines: [original], unread: [] });
  const wide = { ...box, height: 30 };
  expect(await recoverHorizontalText(raster([18]), [{ bounds: wide, polygon: rectPolygon(wide) }],
    [line('g', wide, 0.39)], 'en', retry)).toEqual({ lines: [], unread: [wide] });
  expect(retry).not.toHaveBeenCalled();
});

it('leaves a recovered row original when it still cannot be read', async () => {
  const result = await recoverHorizontalText(raster([18, 35, 52]), [region], [line('g', box, 0.399)], 'en',
    async regions => [line('stop copying', regions[1].bounds)]);
  expect(result.lines.map(row => row.text)).toEqual(['stop copying']);
  expect(result.unread).toHaveLength(2);
});

it('preserves a confident short line beside non-text decoration', async () => {
  const retry = vi.fn(async () => []);
  const original = line('in!', box, 0.94);
  const result = await recoverHorizontalText(raster([18, 35]), [region], [original], 'en', retry);
  expect(result).toEqual({ lines: [original], unread: [] });
  expect(retry).not.toHaveBeenCalled();
});

it('keeps a weak, unsplittable line unread instead of translating half of it, and leaves confident lines alone', async () => {
  const normal = line('Normal row of text', { x: 10, y: 5, width: 120, height: 20 }, 0.95);
  const weakBounds = { x: 10, y: 40, width: 120, height: 24 };
  const retry = vi.fn(async () => []);
  const weak = await recoverHorizontalText(raster([44]), [{ bounds: normal.bounds, polygon: rectPolygon(normal.bounds) }, { bounds: weakBounds, polygon: rectPolygon(weakBounds) }],
    [normal, line('goals il ve', weakBounds, 0.39)], 'en', retry);
  expect(weak.lines).toEqual([normal]);
  expect(weak.unread).toEqual([weakBounds]);

  const confident = line('goals will have', weakBounds, 0.7);
  const result = await recoverHorizontalText(raster([44]), [{ bounds: normal.bounds, polygon: rectPolygon(normal.bounds) }, { bounds: weakBounds, polygon: rectPolygon(weakBounds) }],
    [normal, confident], 'en', retry);
  expect(result).toEqual({ lines: [normal, confident], unread: [] });
});

it('restores both rows of a weak merged line when the rows can be read separately', async () => {
  const bounds = { x: 10, y: 10, width: 120, height: 32 };
  const rows = ['goals will have to', 'do an additional'];
  const normal = line('Normal row of text', { x: 10, y: 60, width: 120, height: 24 }, 0.95);
  const result = await recoverHorizontalText(raster([14, 28]), [{ bounds, polygon: rectPolygon(bounds) }, { bounds: normal.bounds, polygon: rectPolygon(normal.bounds) }],
    [line('goals il ve', bounds, 0.39), normal], 'en', async regions => regions.map((row, index) => line(rows[index], row.bounds)));
  expect(result.lines.map(row => row.text)).toEqual([...rows, normal.text]);
});
