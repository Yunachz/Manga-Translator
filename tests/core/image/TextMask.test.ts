import { expect, it } from 'vitest';
import { textMask } from '../../../src/core/inpainting/TextMask';
import { rectPolygon } from '../../../src/core/image/geometry';

it('erases detached lettering while retaining an outline crossing the OCR crop', () => {
  const width = 70, height = 65;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const mark = (x: number, y: number) => data.fill(20, (y * width + x) * 4, (y * width + x) * 4 + 3);
  for (let y = 4; y < 56; y++) mark(43, y);
  for (let y = 23; y <= 33; y++) for (let x = 28; x <= 40; x++) mark(x, y);
  const [result] = textMask({ width, height, data } as ImageData, [{ x: 21, y: 18, width: 23, height: 22 }]);
  expect(result).toBeDefined();
  const masked = (x: number, y: number) =>
    result.mask[(y - result.bounds.y) * result.bounds.width + x - result.bounds.x];
  expect(masked(35, 28)).toBe(1);
  expect(masked(43, 28)).toBe(0);
});

it('recovers glyphs reaching an OCR crop edge inside a balloon while preserving the actual border', () => {
  const width = 72, height = 58;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const ink = (x: number, y: number) => data.fill(15, (y * width + x) * 4, (y * width + x) * 4 + 3);
  for (let y = 2; y < 56; y++) ink(52, y);
  for (let y = 12; y < 39; y++) for (let x = 29; x < 34; x++) ink(x, y);
  const image = { width, height, data } as ImageData;
  const lines = [{ x: 24, y: 17, width: 30, height: 22 }];
  expect(textMask(image, lines)).toHaveLength(0);
  const contour = rectPolygon({ x: 4, y: 4, width: 48, height: 50 });
  const [region] = textMask(image, lines, 'normal', contour);
  const at = (x: number, y: number) => region.mask[(y - region.bounds.y) * region.bounds.width + x - region.bounds.x];
  expect(at(31, 24)).toBe(1);
  expect(at(31, region.bounds.y)).toBe(1);
  expect(at(52, 24)).toBe(0);
});

it('gives higher-risk modes progressively fainter lettering while retaining the same border exclusion', () => {
  const width = 65, height = 45;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 12; y < 28; y++) for (let x = 21; x < 38; x++) {
    if (x % 5 < 2) data.fill(226, (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  for (let y = 0; y < height; y++) data.fill(40, (y * width + 43) * 4, (y * width + 43) * 4 + 3);
  const image = { width, height, data } as ImageData;
  const bounds = [{ x: 15, y: 8, width: 30, height: 24 }];
  expect(textMask(image, bounds, 'normal')).toEqual([]);
  expect(textMask(image, bounds, 'constrained')).toEqual([]);
  const [mask] = textMask(image, bounds, 'conservative');
  expect(mask.mask[(19 - mask.bounds.y) * mask.bounds.width + 43 - mask.bounds.x]).toBe(0);
  expect(mask.mask).toContain(1);
});
