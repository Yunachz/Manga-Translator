import { describe, expect, it } from 'vitest';
import { gray, scaleDimensions } from '../../../src/core/image/raster';

describe('scaleDimensions', () => {
  it('never upscales', () => {
    expect(scaleDimensions(300, 200, 1024)).toEqual([300, 200]);
  });

  it('caps the longest side and keeps the aspect ratio', () => {
    expect(scaleDimensions(2000, 1000, 1000)).toEqual([1000, 500]);
    expect(scaleDimensions(1000, 2000, 1000)).toEqual([500, 1000]);
  });

  it('caps total pixels', () => {
    const [width, height] = scaleDimensions(1000, 1200, 1024, 520_000);
    expect(width * height).toBeLessThanOrEqual(520_000 * 1.01);
    expect(width / height).toBeCloseTo(1000 / 1200, 2);
  });

  it('picks the stricter of the side and pixel limits', () => {
    expect(scaleDimensions(4000, 100, 1000, 10_000_000)).toEqual([1000, 25]);
    const [w, h] = scaleDimensions(1000, 1000, 5000, 250_000);
    expect([w, h]).toEqual([500, 500]);
  });

  it('never returns a zero dimension', () => {
    expect(scaleDimensions(10_000, 1, 100)).toEqual([100, 1]);
    expect(scaleDimensions(1, 10_000, 100)).toEqual([1, 100]);
  });
});

describe('gray', () => {
  const rgba = (...pixels: number[][]) => new Uint8ClampedArray(pixels.flat());

  it('returns luma on the 0-255 scale', () => {
    const data = rgba([0, 0, 0, 255], [255, 255, 255, 255], [128, 128, 128, 255]);
    expect(gray(data, 0)).toBe(0);
    expect(gray(data, 1)).toBeCloseTo(255 * 256 / 256, 6); // weights sum to 256
    expect(gray(data, 2)).toBeCloseTo(128, 6);
  });

  it('weights green above red above blue', () => {
    const data = rgba([255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]);
    expect(gray(data, 1)).toBeGreaterThan(gray(data, 0));
    expect(gray(data, 0)).toBeGreaterThan(gray(data, 2));
  });

  it('ignores alpha', () => {
    expect(gray(rgba([90, 90, 90, 0]), 0)).toBe(gray(rgba([90, 90, 90, 255]), 0));
  });
});
