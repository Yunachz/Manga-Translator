import { expect, it } from 'vitest';
import { drawTranslation } from '../../../src/core/typesetting/Renderer';
import { paintFor } from '../../../src/core/typesetting/Contrast';
import type { BubbleRegion, Settings } from '../../../src/types/contracts';

const settings = { fontWeight: 600, fontFamily: 'Arial', padding: 0.09, lineHeight: 1.17, target: 'id' } as Settings;

const white = [255, 255, 255, 255], black = [10, 10, 10, 255];

/** Canvas fake: pixel(x, y) gives the page color; text drawn so far darkens/lightens it like real ink would. */
function fakeContext(pixel: (x: number, y: number) => number[], fills: string[]) {
  const inked: { x: number; y: number }[] = [];
  const context = {
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    measureText: (value: string) => ({ width: value.length * 5 }),
    getImageData(x: number, y: number, w: number, h: number) {
      const data: number[] = [];
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const drawn = inked.some(p => Math.abs(p.x - (x + i)) < 40 && Math.abs(p.y - (y + j)) < 40);
        data.push(...(drawn ? black : pixel(x + i, y + j)));
      }
      return { data };
    },
    save() {}, beginPath() {}, rect() {}, clip() {}, restore() {}, moveTo() {}, lineTo() {}, closePath() {},
    strokeText() {},
    fillText(this: { fillStyle: string }, _t: string, x: number, y: number) { fills.push(this.fillStyle); inked.push({ x, y }); },
  };
  return context as unknown as OffscreenCanvasRenderingContext2D;
}

it('uses dark text on a white balloon even when the single center pixel is dark ink', () => {
  const fills: string[] = [];
  const context = fakeContext((x, y) => (x === 60 && y === 40 ? black : white), fills);
  const bubbles: BubbleRegion[] = [{ id: 'a', bounds: { x: 0, y: 0, width: 120, height: 80 }, lines: [] }];
  drawTranslation(context, bubbles, { segments: [{ id: 'a', text: 'Halo' }] }, settings);
  expect(fills[0]).toBe('#111');
});

it('keeps white text in a truly dark bubble', () => {
  const fills: string[] = [];
  const context = fakeContext(() => black, fills);
  const bubbles: BubbleRegion[] = [{ id: 'a', bounds: { x: 0, y: 0, width: 120, height: 80 }, lines: [] }];
  drawTranslation(context, bubbles, { segments: [{ id: 'a', text: 'Halo' }] }, settings);
  expect(fills[0]).toBe('#fff');
});

it('does not let text drawn into an overlapping earlier bubble flip a later decision', () => {
  const fills: string[] = [];
  const context = fakeContext(() => white, fills);
  const bubbles: BubbleRegion[] = [
    { id: 'a', bounds: { x: 0, y: 0, width: 120, height: 80 }, lines: [] },
    { id: 'b', bounds: { x: 30, y: 0, width: 120, height: 80 }, lines: [] },
  ];
  drawTranslation(context, bubbles, { segments: [{ id: 'a', text: 'Halo' }, { id: 'b', text: 'Hai' }] }, settings);
  expect(fills).toEqual(['#111', '#111']);
});

it('uses a thick opposite-color stroke on mixed textured backgrounds', () => {
  const half = [...Array(50).fill(0.9), ...Array(50).fill(0.02)];
  const paint = paintFor(half, 20);
  expect(paint.mode).toBe('mixed');
  expect(paint.strokeWidth).toBeGreaterThanOrEqual(1.5);
  expect(paint.stroke).toMatch(/255, 255, 255|10, 10, 10/);
});

it('classifies uniform backgrounds', () => {
  expect(paintFor(Array(30).fill(0.95), 20)).toMatchObject({ fill: '#111', mode: 'light' });
  expect(paintFor(Array(30).fill(0.01), 20)).toMatchObject({ fill: '#fff', mode: 'dark' });
});
