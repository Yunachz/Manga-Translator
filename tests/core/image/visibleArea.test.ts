import { describe, expect, it } from 'vitest';
import { visibleArea } from '../../../src/core/image/visibleArea';
import { sameCaptureFrame } from '../../../src/core/image/captureFrame';
import type { CaptureFrame } from '../../../src/messaging/protocol';

describe('visible capture coordinates', () => {
  const object = { x: 200, y: -800, width: 800, height: 2000 };
  const selection = { x: 0.2, y: 0.45, width: 0.5, height: 0.25 };
  const viewport = { x: 20, y: 50, width: 1000, height: 800 };

  it('maps a completely visible selection in a scrolled, zoomed reader to the screenshot', () => {
    expect(visibleArea(selection, { object, clip: object }, viewport)).toEqual({
      x: 0.34, y: 0.0625, width: 0.4, height: 0.625,
    });
  });

  it('rejects a selection clipped by either the viewport or the image box', () => {
    expect(visibleArea({ ...selection, y: 0.1 }, { object, clip: object }, viewport)).toBeUndefined();
    const clip = { x: 380, y: 0, width: 500, height: 900 };
    expect(visibleArea(selection, { object, clip }, viewport)).toBeUndefined();
  });

  it('rejects capture frames when the page scrolls or the visible crop moves', () => {
    const frame: CaptureFrame = { bounds: selection, viewport: [0, 0, 1280, 820, 1, 0, 420] };
    expect(sameCaptureFrame(frame, frame)).toBe(true);
    expect(sameCaptureFrame(frame, { ...frame, viewport: [0, 0, 1280, 820, 1, 0, 421] })).toBe(false);
    expect(sameCaptureFrame(frame, { ...frame, bounds: { ...selection, x: 0.24 } })).toBe(false);
    expect(sameCaptureFrame(frame, undefined)).toBe(false);
  });
});
