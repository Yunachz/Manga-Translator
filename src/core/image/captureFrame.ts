import type { CaptureFrame } from '../../messaging/protocol';

export function sameCaptureFrame(before: CaptureFrame, after: CaptureFrame | undefined): boolean {
  return !!after && before.viewport.length === after.viewport.length &&
    before.viewport.every((value, index) => Math.abs(value - after.viewport[index]) < 0.02) &&
    (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(before.bounds[key] - after.bounds[key]) < 0.0001);
}
