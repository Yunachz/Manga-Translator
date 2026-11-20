import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noPagesMessage, protectedImageMessage, ChapterSessions } from '../../../src/core/chapter/ChapterSessions';
import type { ChapterStatus } from '../../../src/core/chapter/ChapterRun';
import { chapterSite } from '../../../src/core/chapter/readerSites';
import { ImageHttpError } from '../../../src/core/image/ImageFetcher';
import { PipelineError } from '../../../src/core/pipeline/PipelineError';
import type { ReaderEvent } from '../../../src/messaging/protocol';
import type { Settings } from '../../../src/types/contracts';

vi.mock('../../../src/core/cache/CacheManager', () => ({ cache: { set: vi.fn(async () => undefined), get: vi.fn(async () => undefined) } }));
const { cache } = await import('../../../src/core/cache/CacheManager');

const href = 'https://reader.example/read/ch-5';
const origin = 'https://reader.example';
const cdn = 'https://cdn.example';
const settings = {} as Settings;
const sources = [1, 2, 3, 4].map(index => `${cdn}/${index}.jpg`);
const patch = { dataUrl: 'data:image/png;base64,AA', width: 1, height: 1 };

interface Harness {
  sessions: ChapterSessions;
  events: ReaderEvent[];
  runs: string[];
  preloads: string[];
  permission: { granted: boolean };
  tab: { id: number; documentId: string; origin: string; site: NonNullable<ReturnType<typeof chapterSite>> };
  url: { value: string };
  finished(): Promise<ChapterStatus>;
}

function harness(options: { reply?: unknown; run?: (src: string) => Promise<unknown>; preload?: (src: string) => Promise<void> } = {}): Harness {
  const events: ReaderEvent[] = [];
  const runs: string[] = [];
  const preloads: string[] = [];
  const url = { value: href };
  const permission = { granted: false };
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async () => ({ url: url.value })),
      sendMessage: vi.fn(async () => 'reply' in options ? options.reply : { sources }),
    },
    permissions: { contains: vi.fn(async () => permission.granted) },
  });
  const queue = { enqueue: async (_id: string, task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal), cancel: vi.fn() };
  const pipeline = {
    preload: vi.fn(async (_ns: string, image: { src: string }) => { preloads.push(image.src); await options.preload?.(image.src); }),
    run: vi.fn(async (_ns: string, selection: { image: { src: string } }) => {
      runs.push(selection.image.src);
      await options.run?.(selection.image.src);
      return { patch, segments: [], cached: false, imageHash: 'h' };
    }),
  };
  const site = chapterSite(href)!;
  const tab = { id: 7, documentId: 'doc', origin, site };
  const sessions = new ChapterSessions(queue as never, pipeline as never, (_tab, message) => { events.push(message); });
  const statuses = () => events.filter(event => event.type === 'CHAPTER_STATUS').map(event => (event as { status: ChapterStatus }).status);
  return {
    sessions, events, runs, preloads, permission, tab, url,
    finished: () => vi.waitFor(() => {
      const last = statuses().at(-1);
      if (!last || ['discovering', 'running'].includes(last.phase)) throw new Error('running');
      return last;
    }),
  };
}

beforeEach(() => { vi.mocked(cache.set).mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('chapter sessions for any reader', () => {
  it('reads the loaded page list and says the scope is the mounted images', async () => {
    const h = harness();
    h.sessions.control(h.tab, 'start', settings);
    const last = await h.finished();
    expect(last).toMatchObject({ phase: 'completed', total: 4, processed: 4, scope: 'mounted' });
    expect(h.runs).toEqual(sources);
    expect(h.sessions.status(7, h.tab.site)).toMatchObject({ scope: 'mounted', phase: 'completed' });
  });
  it('reports an empty reader without requesting anything', async () => {
    const h = harness({ reply: { sources: [] } });
    h.sessions.control(h.tab, 'start', settings);
    expect(await h.finished()).toMatchObject({ phase: 'error', message: noPagesMessage });
    expect(h.runs).toEqual([]);
    expect(h.preloads).toEqual([]);
  });
  it('rejects a page list that points at private hosts', async () => {
    const h = harness({ reply: { sources: ['https://127.0.0.1/1.jpg'] } });
    h.sessions.control(h.tab, 'start', settings);
    expect(await h.finished()).toMatchObject({ phase: 'error', message: noPagesMessage });
  });
});

describe('lookahead', () => {
  it('starts the next fetch while the current page is still processing, one page ahead', async () => {
    const release = Promise.withResolvers<void>();
    const h = harness({ run: async src => { if (src === sources[0]) await release.promise; } });
    h.sessions.control(h.tab, 'start', settings);
    await vi.waitFor(() => expect(h.runs).toEqual([sources[0]]));
    expect(h.preloads).toEqual([sources[1]]);
    release.resolve();
    expect(await h.finished()).toMatchObject({ phase: 'completed', processed: 4 });
    expect(h.preloads).toEqual(sources.slice(1));
  });
  it('does not fetch ahead after the run is stopped', async () => {
    const release = Promise.withResolvers<void>();
    const h = harness({ run: async src => { if (src === sources[0]) await release.promise; } });
    const first = h.sessions.control(h.tab, 'start', settings)!;
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    const run = (h.events.find(event => event.type === 'CHAPTER_STATUS') as { run: string }).run;
    h.sessions.control(h.tab, 'stop', settings, run);
    release.resolve();
    await vi.waitFor(() => expect(h.sessions.status(7, h.tab.site)?.phase).toBe('stopped'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.preloads).toEqual([sources[1]]);
    expect(h.runs).toEqual([sources[0]]);
    expect(first.phase).toBe('discovering');
  });
  it('discards a finished page when the run stops before the result is stored', async () => {
    const release = Promise.withResolvers<void>();
    const h = harness({ run: async () => { await release.promise; } });
    h.sessions.control(h.tab, 'start', settings);
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    const run = (h.events.find(event => event.type === 'CHAPTER_STATUS') as { run: string }).run;
    h.sessions.control(h.tab, 'stop', settings, run);
    release.resolve();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(cache.set).not.toHaveBeenCalled();
    expect(h.events.some(event => event.type === 'CHAPTER_PAGE')).toBe(false);
  });
});

describe('servers that refuse the extension', () => {
  const refuse = (...refused: string[]) => async (src: string) => {
    if (refused.includes(src)) throw new ImageHttpError(403);
  };
  it('stops asking an origin after two refusals in a row and explains why', async () => {
    const h = harness({ run: refuse(...sources) });
    h.sessions.control(h.tab, 'start', settings);
    const last = await h.finished();
    expect(last).toMatchObject({ phase: 'error', failed: 4, message: protectedImageMessage });
    expect(h.runs).toEqual(sources.slice(0, 2));
    expect(h.preloads.length).toBeLessThanOrEqual(2);
  });
  it('does not request a page again after its lookahead was refused', async () => {
    const h = harness({ preload: async src => { if (src === sources[1]) throw new ImageHttpError(403); } });
    h.sessions.control(h.tab, 'start', settings);
    const last = await h.finished();
    expect(h.runs).not.toContain(sources[1]);
    expect(last).toMatchObject({ failed: 1, translated: 3 });
  });
  it('fetches a page whose lookahead failed only once per run, then again on retry', async () => {
    let failing = true;
    const h = harness({ preload: async src => {
      if (failing && src === sources[1]) throw new PipelineError('IMAGE_FETCH', 'Sumber gambar menolak request (HTTP 500).');
    } });
    h.sessions.control(h.tab, 'start', settings);
    expect(await h.finished()).toMatchObject({ failed: 1, translated: 3, phase: 'completed' });
    expect(h.runs).toEqual([sources[0], sources[2], sources[3]]);
    expect(h.preloads.filter(src => src === sources[1])).toHaveLength(1);
    const run = (h.events.find(event => event.type === 'CHAPTER_STATUS') as { run: string }).run;
    failing = false;
    h.sessions.control(h.tab, 'retry', settings, run);
    await vi.waitFor(() => expect(h.sessions.status(7, h.tab.site)).toMatchObject({ phase: 'completed', failed: 0, translated: 4 }));
    expect(h.runs.filter(src => src === sources[1])).toHaveLength(1);
  });
  it('tries the refused pages again on an explicit retry', async () => {
    let blocked = true;
    const h = harness({ run: async src => { if (blocked && src !== sources[0]) throw new ImageHttpError(403); } });
    h.sessions.control(h.tab, 'start', settings);
    expect(await h.finished()).toMatchObject({ failed: 3 });
    const run = (h.events.find(event => event.type === 'CHAPTER_STATUS') as { run: string }).run;
    blocked = false;
    const before = h.runs.length;
    h.sessions.control(h.tab, 'retry', settings, run);
    await vi.waitFor(() => expect(h.sessions.status(7, h.tab.site)).toMatchObject({ phase: 'completed', failed: 0 }));
    expect(h.runs.length).toBeGreaterThan(before);
  });
});

describe('resume after a permission grant', () => {
  const needPermission = (src: string) => src === sources[0] && !permissionGranted
    ? Promise.reject(new PipelineError('IMAGE_PERMISSION', 'Grant', cdn)) : Promise.resolve();
  let permissionGranted = false;
  beforeEach(() => { permissionGranted = false; });

  it('continues only when the exact origin is granted and the run is still the same paused run', async () => {
    const h = harness({ run: needPermission });
    h.sessions.control(h.tab, 'start', settings);
    expect(await h.finished()).toMatchObject({ phase: 'paused', pendingOrigin: cdn, processed: 0 });
    await h.sessions.resumeGrantedPermissions(7);
    expect(h.sessions.status(7, h.tab.site)?.phase).toBe('paused');
    await h.sessions.resumeGrantedPermissions(99);
    permissionGranted = true;
    h.permission.granted = true;
    await h.sessions.resumeGrantedPermissions(99);
    expect(h.sessions.status(7, h.tab.site)?.phase).toBe('paused');
    await h.sessions.resumeGrantedPermissions(7);
    await vi.waitFor(() => expect(h.sessions.status(7, h.tab.site)).toMatchObject({ phase: 'completed', processed: 4 }));
    const contains = (chrome.permissions.contains as unknown as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0]);
    expect(contains.every(call => call.origins.length === 1 && call.origins[0] === cdn + '/*')).toBe(true);
  });
  it('leaves a stopped or replaced run alone', async () => {
    const h = harness({ run: needPermission });
    h.sessions.control(h.tab, 'start', settings);
    await h.finished();
    const run = (h.events.find(event => event.type === 'CHAPTER_STATUS') as { run: string }).run;
    permissionGranted = true;
    h.permission.granted = true;
    h.sessions.control(h.tab, 'stop', settings, run);
    await h.sessions.resumeGrantedPermissions();
    expect(h.sessions.status(7, h.tab.site)?.phase).toBe('stopped');
    expect(h.runs).toEqual([sources[0]]);
  });
});
