import { describe, expect, it } from 'vitest';
import { classicalInpaint } from '../../../src/core/inpainting/ClassicalInpaint';
import { mergeLineMasks, protectMask } from '../../../src/core/inpainting/MaskRegions';
import type { MaskRegion } from '../../../src/core/inpainting/TextMask';

const size = 40;
function raster(paint: (x: number, y: number) => number): ImageData {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.fill(paint(x, y), (y * size + x) * 4, (y * size + x) * 4 + 3);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width: size, height: size, data } as unknown as ImageData;
}
const square = (outlined?: boolean): MaskRegion => {
  const mask = new Uint8Array(size * size);
  for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) mask[y * size + x] = 1;
  return { bounds: { x: 0, y: 0, width: size, height: size }, mask, ...(outlined ? { outlined } : {}) };
};
const at = (image: ImageData, x: number, y: number) => image.data[(y * size + x) * 4];

describe('inpainting outlined lettering', () => {
  // Mid-grey screentone with one scrap of white outline on the rim of the hole.
  const scene = () => raster((x, y) => x === 11 && y === 20 ? 255 : (x + y) % 2 ? 150 : 60);

  it('does not copy a scrap of outline from the rim into the hole', () => {
    const image = scene();
    classicalInpaint(image, square(true), [100, 100, 100]);
    let brightest = 0;
    for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) brightest = Math.max(brightest, at(image, x, y));
    expect(brightest).toBeLessThanOrEqual(150);
  });

  it('settles the hole into the range of the screentone around it', () => {
    const image = scene();
    classicalInpaint(image, square(true), [100, 100, 100]);
    for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) {
      expect(at(image, x, y)).toBeGreaterThanOrEqual(60);
      expect(at(image, x, y)).toBeLessThanOrEqual(150);
    }
  });

  it('leaves ordinary masks on the averaging fill they always used', () => {
    const image = scene();
    classicalInpaint(image, square(), [100, 100, 100]);
    let brightest = 0;
    for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) brightest = Math.max(brightest, at(image, x, y));
    // The scrap is averaged in with its neighbours and spreads: the fill is not limited to the screentone's range.
    expect(brightest).toBeGreaterThan(60);
    const values = new Set<number>();
    for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) values.add(at(image, x, y));
    expect(values.size).toBeGreaterThan(3);
  });
});

describe('outlined mask flag', () => {
  it('survives merging only when every line is outlined, and survives protecting a region', () => {
    expect(mergeLineMasks([square(true), square(true)]).outlined).toBe(true);
    expect(mergeLineMasks([square(true), square()]).outlined).toBeUndefined();
    const kept = protectMask(square(true), [{ x: 0, y: 0, width: 2, height: 2 }]);
    expect(kept?.outlined).toBe(true);
  });
});
