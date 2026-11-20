import { describe, expect, it } from 'vitest';
import { panelFromCrop, pointFromCrop, pointInCrop, rectFromCrop } from '../../../src/core/image/surfaceCrop';
import { sameViewport, viewportPixels, visibleCrop, visibleShare } from '../../../src/core/surface/viewport';
import { readerInfo, readerRequest } from '../../../src/messaging/validate';

const image = (patch: object = {}) => ({ id: 'surface-1', src: 'https://reader.example/episode/1', width: 844, height: 1200, kind: 'canvas', ...patch });
const request = (patch: object = {}) => ({ type: 'PROCESS_PANEL', id: 'job-1', image: image(), point: { x: 0.5, y: 0.5 }, ...patch });

describe('visible crop of a surface', () => {
  const viewport = { x: 0, y: 0, width: 1440, height: 800 };
  const geometry = (x: number, y = 0, width = 538, height = 765) => ({ object: { x, y, width, height }, clip: { x, y, width, height } });

  it('is the whole surface when it is fully on screen', () => {
    expect(visibleCrop(geometry(100), viewport)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(visibleShare(geometry(100), viewport)).toBe(1);
  });

  it('is the visible part, normalized to the surface, when the page is cut by the viewport edge', () => {
    const crop = visibleCrop(geometry(-269), viewport)!;
    expect(crop.x).toBeCloseTo(0.5);
    expect(crop.width).toBeCloseTo(0.5);
    expect(visibleShare(geometry(-269), viewport)).toBeCloseTo(0.5);
  });

  it('is clipped by the surface clip box and refuses a sliver or a hidden page', () => {
    const clipped = { object: { x: 0, y: 0, width: 500, height: 800 }, clip: { x: 0, y: 0, width: 500, height: 400 } };
    expect(visibleCrop(clipped, viewport)).toMatchObject({ height: 0.5 });
    expect(visibleCrop(geometry(-530), viewport)).toBeUndefined();
    expect(visibleCrop(geometry(2000), viewport)).toBeUndefined();
    expect(visibleShare(geometry(2000), viewport)).toBe(0);
  });

  it('maps a freeform area of the visual viewport to client pixels', () => {
    expect(viewportPixels({ x: 0.5, y: 0.25, width: 0.25, height: 0.5 }, { x: 10, y: 20, width: 800, height: 400 }))
      .toEqual({ x: 410, y: 120, width: 200, height: 200 });
  });

  it('treats snapshots that differ by a pixel of scroll as different views', () => {
    expect(sameViewport([0, 0, 800, 600, 1, 0, 0], [0, 0, 800, 600, 1, 0, 0.01])).toBe(true);
    expect(sameViewport([0, 0, 800, 600, 1, 0, 0], [0, 0, 800, 600, 1, 0, 1])).toBe(false);
    expect(sameViewport([0, 0, 800, 600, 1, 0, 0], [0, 0, 800, 600])).toBe(false);
  });
});

describe('panels detected inside a visible crop', () => {
  const crop = { x: 0.5, y: 0.2, width: 0.5, height: 0.4 };
  it('converts points both ways', () => {
    expect(pointInCrop({ x: 0.75, y: 0.4 }, crop)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointFromCrop({ x: 0.5, y: 0.5 }, crop)).toEqual({ x: 0.75, y: 0.4 });
    expect(pointInCrop({ x: 0.1, y: 0.9 }, crop)).toEqual({ x: 0, y: 1 });
  });

  it('places a panel back on the whole surface', () => {
    const panel = { id: 'p', confidence: 0.9, bounds: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      polygon: [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.5 }] };
    const placed = panelFromCrop(panel, crop);
    expect(placed.bounds).toEqual({ x: 0.75, y: 0.2, width: 0.25, height: 0.2 });
    expect(placed.polygon[2]).toEqual({ x: 1, y: 0.4 });
    expect(rectFromCrop({ x: 0, y: 0, width: 1, height: 1 }, crop)).toEqual(crop);
  });
});

describe('reader requests for canvas and viewport surfaces', () => {
  it('accepts a canvas descriptor whose source is only the page address', () => {
    expect(readerRequest(request())).toMatchObject({ type: 'PROCESS_PANEL', image: { kind: 'canvas' } });
    expect(readerRequest(request({ image: image({ src: 'blob:https://reader.example/abc' }) }))).toBeUndefined();
    expect(readerRequest(request({ image: image({ kind: 'bitmap' }) }))).toBeUndefined();
  });

  it('keeps the old image descriptor with no kind, including a same-origin blob', () => {
    expect(readerRequest(request({ image: image({ kind: undefined, src: 'https://cdn.example/1.jpg' }) }))).toBeTruthy();
    expect(readerRequest(request({ image: image({ kind: undefined, src: 'blob:https://reader.example/abc' }) }))).toBeTruthy();
  });

  it('requires a capture and an area for a viewport surface, and a capture for a surface crop', () => {
    const area = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    expect(readerRequest(request({ image: image({ kind: 'viewport' }) }))).toBeUndefined();
    expect(readerRequest(request({ image: image({ kind: 'viewport' }), manual: area }))).toBeUndefined();
    expect(readerRequest(request({ image: image({ kind: 'viewport' }), manual: area, visibleCapture: true }))).toBeTruthy();
    expect(readerRequest(request({ manual: area, visibleCapture: true, surfaceCrop: true }))).toMatchObject({ surfaceCrop: true });
    expect(readerRequest(request({ manual: area, surfaceCrop: true }))).toBeUndefined();
    expect(readerRequest(request({ surfaceCrop: true, visibleCapture: true }))).toBeUndefined();
    expect(readerRequest(request({ image: image({ kind: 'viewport' }), manual: area, visibleCapture: true, surfaceCrop: true }))).toBeUndefined();
  });
});

describe('reader info', () => {
  it('accepts the plain reply of an older reader as a reader with no canvas pages', () => {
    expect(readerInfo(true)).toEqual({ ready: true, canvasPages: 0, visiblePages: 0 });
  });

  it('accepts a bounded report with an optional run and rejects malformed ones', () => {
    const run = { phase: 'running', total: 3, processed: 1, translated: 1, skipped: 0, failed: 0, captured: 1 };
    expect(readerInfo({ ready: true, canvasPages: 5, visiblePages: 2, run })).toEqual({ ready: true, canvasPages: 5, visiblePages: 2, run });
    expect(readerInfo({ ready: true, canvasPages: 5, visiblePages: 2 })).toEqual({ ready: true, canvasPages: 5, visiblePages: 2 });
    for (const bad of [false, null, 'ready', { ready: true }, { ready: true, canvasPages: -1, visiblePages: 0 },
      { ready: true, canvasPages: 1, visiblePages: 1e9 }, { ready: true, canvasPages: 1, visiblePages: 1, run: { ...run, phase: 'paused' } },
      { ready: true, canvasPages: 1, visiblePages: 1, run: { ...run, total: Infinity } }]) {
      expect(readerInfo(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
