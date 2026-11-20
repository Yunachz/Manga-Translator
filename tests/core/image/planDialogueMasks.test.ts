import { expect, it } from 'vitest';
import type { OCRResult } from '../../../src/types/contracts';
import { rectPolygon } from '../../../src/core/image/geometry';
import { planDialogueMasks } from '../../../src/core/inpainting/planDialogueMasks';

it('processes clean lines on both sides of an unsafe line and leaves the unsafe line available for retry', () => {
  const recognized: OCRResult[] = ['Before', 'Keep original', 'After'].map((text, index) =>
    ({ id: `line-${index}`, text, bounds: { x: 10, y: 10 + index * 25, width: 80, height: 16 }, confidence: 0.9, vertical: false }));
  const bubble = { id: 'dialogue', bounds: { x: 0, y: 0, width: 100, height: 100 },
    lines: recognized.map(({ bounds }) => ({ bounds, polygon: rectPolygon(bounds) })) };
  const result = planDialogueMasks({ bubble, recognized }, line => line.text === 'Keep original' ? 'keep' : 'clean');
  expect(result.ready.map(({ bubble, recognized }) => [bubble.id, recognized[0].text, bubble.bounds])).toEqual([
    ['dialogue-part-1', 'Before', recognized[0].bounds], ['dialogue-part-2', 'After', recognized[2].bounds],
  ]);
  expect(result.keep).toEqual([recognized[1].bounds]);
});
