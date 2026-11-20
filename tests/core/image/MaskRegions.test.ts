import { expect, it } from 'vitest';
import { mergeLineMasks, protectMask } from '../../../src/core/inpainting/MaskRegions';

it('merges overlapping line masks without counting or painting the overlap twice', () => {
  const first = { bounds: { x: 2, y: 3, width: 4, height: 3 }, mask: new Uint8Array(12).fill(1) };
  const second = { bounds: { x: 4, y: 5, width: 4, height: 3 }, mask: new Uint8Array(12).fill(1) };
  const result = mergeLineMasks([first, second]);
  expect(result.bounds).toEqual({ x: 2, y: 3, width: 6, height: 5 });
  expect(result.mask.reduce((sum, pixel) => sum + pixel, 0)).toBe(22);
});

it('preserves original lettering and rejects a mask if too much would be left behind', () => {
  const region = { bounds: { x: 0, y: 0, width: 12, height: 10 }, mask: new Uint8Array(120).fill(1) };
  expect(protectMask(region, [{ x: 0, y: 0, width: 12, height: 7 }])).toBeUndefined();
  expect(protectMask(region, [{ x: 0, y: 0, width: 12, height: 1 }])!.mask.slice(0, 12)).toEqual(new Uint8Array(12));
  expect(region.mask[0]).toBe(1);
});
