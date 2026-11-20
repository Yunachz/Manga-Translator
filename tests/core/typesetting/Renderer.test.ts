import { expect, it } from 'vitest';
import { drawTranslation, planTranslationText } from '../../../src/core/typesetting/Renderer';
import type { BubbleRegion, Rect, Settings } from '../../../src/types/contracts';

it('clips strokes and fills to the bounds of the bubble matched by segment ID', () => {
  const boxes: Rect[] = [{ x: 10, y: 45, width: 120, height: 120 }, { x: 132, y: 9, width: 85, height: 65 }];
  const bubbles: BubbleRegion[] = boxes.map((bounds, index) => ({ id: String(index), bounds, lines: [] }));
  const draws: { text: string; x: number; y: number; bounds: Rect | undefined }[] = [];
  let rect: Rect | undefined;
  let clipped: Rect | undefined;
  const draw = (text: string, x: number, y: number) => draws.push({ text, x, y, bounds: clipped });
  const context = {
    measureText: (value: string) => ({ width: value.length * 5 }),
    getImageData: () => ({ data: [255, 255, 255, 255] }),
    save() {},
    beginPath() { rect = undefined; },
    rect(x: number, y: number, width: number, height: number) { rect = { x, y, width, height }; },
    clip() { clipped = rect; },
    restore() { clipped = undefined; },
    fillText: draw,
    strokeText: draw,
  } as unknown as OffscreenCanvasRenderingContext2D;
  const settings = { fontWeight: 600, fontFamily: 'Arial', padding: 0.09, lineHeight: 1.17, target: 'id' } as Settings;

  drawTranslation(context, bubbles, { segments: [{ id: '1', text: 'Yah…' }, { id: '0', text: 'Kami main basket.' }] }, settings);
  expect(draws).toHaveLength(4);
  expect(draws.slice(0, 2)).toEqual(Array(2).fill({ text: 'Kami main basket.', x: 70, y: 105, bounds: boxes[0] }));
  expect(draws.slice(2)).toEqual(Array(2).fill({ text: 'Yah…', x: 174.5, y: 41.5, bounds: boxes[1] }));
  expect(clipped).toBeUndefined();
});

it('skips a bubble whose text cannot fit instead of drawing outside it, and reports it', () => {
  const draws: string[] = [];
  const context = {
    measureText: (value: string) => ({ width: value.length * 5 }),
    getImageData: () => ({ data: [255, 255, 255, 255] }),
    save() {}, beginPath() {}, rect() {}, clip() {}, restore() {},
    fillText: (text: string) => draws.push(text), strokeText() {},
  } as unknown as OffscreenCanvasRenderingContext2D;
  const settings = { fontWeight: 600, fontFamily: 'Arial', padding: 0.09, lineHeight: 1.17, target: 'id' } as Settings;
  const bubbles: BubbleRegion[] = [
    { id: 'small', bounds: { x: 0, y: 0, width: 20, height: 10 }, lines: [] },
    { id: 'roomy', bounds: { x: 30, y: 0, width: 120, height: 80 }, lines: [] },
  ];
  const text = 'Terjemahan yang sangat panjang sekali';
  expect(planTranslationText(context, bubbles[0], text, settings)).toBeUndefined();
  expect(planTranslationText(context, bubbles[1], text, settings)).toBeDefined();
  const skipped = drawTranslation(context, bubbles, { segments: [{ id: 'small', text }, { id: 'roomy', text }] }, settings);
  expect(skipped).toEqual(['small']);
  expect(draws.join(' ')).toBe(text);
});
