import { isChapterAction } from '../core/chapter/ChapterRun';
import type { ImageDescriptor, Point, Rect } from '../types/contracts';
import type { CaptureFrame, ReaderInfo, ReaderRequest, VisiblePagesStatus } from './protocol';

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function image(value: unknown): value is ImageDescriptor {
  if (!record(value) || typeof value.id !== 'string' || !/^[\w-]{1,80}$/.test(value.id) ||
      typeof value.src !== 'string' || value.src.length > 16_384 ||
      !finite(value.width, 1, 36000) || !finite(value.height, 1, 36000) || value.width * value.height > 44_000_000) return false;
  const { kind } = value;
  if (kind !== undefined && kind !== 'img' && kind !== 'canvas' && kind !== 'viewport') return false;
  try {
    const url = new URL(value.src);
    // A canvas or viewport source is only the page address. It is never fetched, so it cannot be a blob.
    const blob = url.protocol === 'blob:' && url.origin.startsWith('https://') && (kind === undefined || kind === 'img');
    return (url.protocol === 'https:' || url.protocol === 'http:' || blob) && !url.username && !url.password;
  } catch { return false; }
}

function point(value: unknown): value is Point {
  return record(value) && finite(value.x, 0, 1) && finite(value.y, 0, 1);
}

function rectangle(value: unknown): value is Rect {
  if (!record(value) || !point(value)) return false;
  const box = value as unknown as Rect;
  return finite(box.width, 0.0001, 1) && finite(box.height, 0.0001, 1) &&
    box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001;
}

export function readerRequest(value: unknown): ReaderRequest | undefined {
  if (!record(value) || typeof value.id !== 'string' || !/^[\w-]{1,80}$/.test(value.id)) return;
  const { type, id } = value;
  if (type === 'CANCEL') return { type, id };
  const run = typeof value.run === 'string' && /^[a-f0-9-]{36}$/.test(value.run) ? value.run : undefined;
  if (type === 'CHAPTER_COMMAND' && run && isChapterAction(value.command)) {
    return { type, id, run, command: value.command };
  }
  if (type === 'GET_CHAPTER_PATCH' && run && typeof value.chapter === 'string' && /^[a-z0-9.-]{4,64}$/i.test(value.chapter) &&
      typeof value.index === 'number' && Number.isInteger(value.index) && value.index >= 1 && value.index <= 200) {
    return { type, id, chapter: value.chapter, run, index: value.index };
  }
  if (!image(value.image)) return;
  if (type === 'PREFETCH') return { type, id, image: value.image };
  if (type === 'PROCESS_PANEL' && point(value.point) && (value.manual === undefined || rectangle(value.manual))) {
    if (value.visibleCapture !== undefined && (value.visibleCapture !== true || !value.manual)) return;
    if (value.surfaceCrop !== undefined && (value.surfaceCrop !== true || !value.visibleCapture || value.image.kind === 'viewport')) return;
    // Pixels of a viewport area exist only in a tab capture.
    if (value.image.kind === 'viewport' && (!value.visibleCapture || !value.manual)) return;
    const protectedRegions = value.protectedRegions;
    if (protectedRegions !== undefined && (!Array.isArray(protectedRegions) ||
        protectedRegions.length > 500 || !protectedRegions.every(rectangle))) return;
    return { type, id, image: value.image, point: value.point, manual: value.manual, visibleCapture: value.visibleCapture, surfaceCrop: value.surfaceCrop,
      ...(protectedRegions?.length ? { protectedRegions } : {}) };
  }
}

export function captureFrame(value: unknown): CaptureFrame | undefined {
  if (!record(value) || !record(value.bounds) || !point(value.bounds)) return;
  const { x, y, width, height } = value.bounds;
  const { viewport } = value;
  if (!finite(width, Number.EPSILON, 1) || !finite(height, Number.EPSILON, 1) ||
      x + width > 1.000001 || y + height > 1.000001 ||
      !Array.isArray(viewport) || viewport.length !== 7 || !viewport.every(part => Number.isFinite(part))) return;
  const [offsetX, offsetY, viewportWidth, viewportHeight, scale, scrollX, scrollY] = viewport;
  return { bounds: { x, y, width, height },
    viewport: [offsetX, offsetY, viewportWidth, viewportHeight, scale, scrollX, scrollY] };
}

const phases = ['idle', 'running', 'finished', 'stopped'] as const;

function visiblePagesStatus(value: unknown): VisiblePagesStatus | undefined {
  if (!record(value) || !phases.includes(value.phase as typeof phases[number])) return;
  const counts = ['total', 'processed', 'translated', 'skipped', 'failed', 'captured'] as const;
  if (!counts.every(key => finite(value[key], 0, 1000))) return;
  return { phase: value.phase as VisiblePagesStatus['phase'], total: value.total as number, processed: value.processed as number,
    translated: value.translated as number, skipped: value.skipped as number, failed: value.failed as number, captured: value.captured as number };
}

/** The reply of a reader to a probe. Anything else, including the older plain `true`, is a reader with no canvas pages. */
export function readerInfo(value: unknown): ReaderInfo | undefined {
  if (value === true) return { ready: true, canvasPages: 0, visiblePages: 0 };
  if (!record(value) || value.ready !== true || !finite(value.canvasPages, 0, 5000) || !finite(value.visiblePages, 0, 5000)) return;
  const run = value.run === undefined ? undefined : visiblePagesStatus(value.run);
  if (value.run !== undefined && !run) return;
  return { ready: true, canvasPages: value.canvasPages, visiblePages: value.visiblePages, ...(run ? { run } : {}) };
}
