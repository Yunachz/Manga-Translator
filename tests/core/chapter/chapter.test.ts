import { describe, expect, it, vi } from 'vitest';
import { canRetryChapter, chapterStatusLabel, ChapterRun } from '../../../src/core/chapter/ChapterRun';
import { mangaDexPages } from '../../../src/core/chapter/MangaDexPages';
import { chapterSite, namedChapterSite, silentWitchPages } from '../../../src/core/chapter/readerSites';
import { PipelineError } from '../../../src/core/pipeline/PipelineError';

const witch = chapterSite('https://w2.secretsofthesilentwitch.online/chapters/33/')!;
const cdn = 'https://manga.xtdz.top/Secrets-of-the-Silent-Witch';
const pages = [1, 2, 3].map(index => ({ index, src: cdn + '/033/p00' + index + '.webp' }));
const dexId = 'f49c0d3e-ddb1-487b-9514-39f781b8a168';

describe('chapter page sources', () => {
  it('identifies a MangaDex chapter across single-page routes', () => {
    const first = chapterSite('https://mangadex.org/chapter/' + dexId + '/1');
    const tenth = chapterSite('https://mangadex.org/chapter/' + dexId + '/10');
    expect(first).toMatchObject({ site: 'dex', id: dexId, page: 1 });
    expect(tenth).toMatchObject({ page: 10, key: first?.key });
    expect(namedChapterSite('https://mangadex.org.example.com/chapter/' + dexId + '/1')).toBeUndefined();
    expect(chapterSite('https://mangadex.org.example.com/chapter/' + dexId + '/1')).toMatchObject({ site: 'generic' });
  });
  it('requires a complete ordered list for the current Silent Witch chapter', () => {
    const props = JSON.stringify({ images: pages.map(page => page.src) });
    const flightData = 'self.__next_f.push(' + JSON.stringify([1, props]) + ')';
    expect(silentWitchPages(witch, [flightData])).toEqual(pages);
    expect(silentWitchPages(witch, [JSON.stringify({ images: [pages[0].src, pages[2].src] })])).toEqual([]);
    expect(silentWitchPages(witch, [JSON.stringify({ images: [cdn + '/034/p001.webp'] })])).toEqual([]);
    expect(silentWitchPages(witch, [JSON.stringify({ image: pages[0].src })])).toEqual([]);
  });
  it('matches the MangaDex saver preference and rejects invalid CDN responses', () => {
    const baseUrl = 'https://uploads.mangadex.org';
    const hash = '1234abcdef123456';
    const chapter = { hash, data: ['p1.png', 'p2.png'], dataSaver: ['p1.jpg', 'p2.jpg'] };
    expect(mangaDexPages({ baseUrl, chapter }, true)[0]).toEqual({ index: 1, src: baseUrl + '/data-saver/' + hash + '/p1.jpg' });
    expect(mangaDexPages({ baseUrl, chapter }, false)[1]).toEqual({ index: 2, src: baseUrl + '/data/' + hash + '/p2.png' });
    expect(mangaDexPages({ baseUrl: baseUrl + '.example.com', chapter }, false)).toEqual([]);
    expect(mangaDexPages({ baseUrl, chapter: { ...chapter, data: ['../p1.png'] } }, false)).toEqual([]);
  });
});

describe('chapter run', () => {
  it('waits for the running page before pause and resumes at the next page', async () => {
    const reset = Promise.withResolvers<void>();
    const process = vi.fn(async ({ index }: typeof pages[number]) => {
      if (index === 1) await reset.promise;
      if (index === 2) throw new PipelineError('NO_TEXT', 'No text');
      return { note: 'partial' as const };
    });
    const run = new ChapterRun({ discover: async () => pages, process, progress: () => undefined });
    const first = run.run();
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    run.pause();
    reset.resolve();
    await first;
    expect(run.status).toMatchObject({ phase: 'paused', processed: 1 });
    await run.run();
    expect(run.status).toMatchObject({ phase: 'completed', total: 3, processed: 3, translated: 2, skipped: 1, partial: 2 });
    expect(process.mock.calls.map(([page]) => page.index)).toEqual([1, 2, 3]);
  });
  it('pauses without advancing the page when an image origin needs permission', async () => {
    const origin = 'https://manga.xtdz.top';
    const process = vi.fn(async () => ({})).mockRejectedValueOnce(new PipelineError('IMAGE_PERMISSION', 'Grant access', origin));
    const run = new ChapterRun({ discover: async () => [pages[0]], process, progress: () => undefined });
    await run.run();
    expect(run.status).toMatchObject({ phase: 'paused', processed: 0, pendingOrigin: origin,
      message: 'Izinkan akses gambar di popup. Terjemahan akan lanjut otomatis.' });
    await run.run();
    expect(run.status).toMatchObject({ phase: 'completed', processed: 1, pendingOrigin: undefined });
    expect(process).toHaveBeenCalledTimes(2);
  });
  it('marks an all-page failure honestly and retries only the pages still failing', async () => {
    let failed = new Set([1, 2, 3]);
    const process = vi.fn(async (page: typeof pages[number]) => {
      if (failed.has(page.index)) throw new PipelineError('TRANSLATION_FAILED', 'Server error');
      return {};
    });
    const run = new ChapterRun({ discover: async () => pages, process, progress: () => undefined });
    await run.run();
    expect(run.status).toMatchObject({ phase: 'error', processed: 3, total: 3, failed: 3 });
    expect(chapterStatusLabel(run.status, 'id')).toBe('Semua halaman gagal diproses');
    failed = new Set([3]);
    await run.run(true);
    expect(run.status).toMatchObject({ phase: 'completed', processed: 3, translated: 2, failed: 1 });
    expect(chapterStatusLabel(run.status, 'id')).toBe('Sebagian halaman gagal diproses');
    failed.clear();
    await run.run(true);
    expect(run.status).toMatchObject({ phase: 'completed', processed: 3, translated: 3, failed: 0 });
    expect(canRetryChapter(run.status)).toBe(false);
    expect(process.mock.calls.map(([page]) => page.index)).toEqual([1, 2, 3, 1, 2, 3, 3]);
  });
  it('aborts the current page and discards a late result after stop', async () => {
    const reset = Promise.withResolvers<void>();
    const process = vi.fn(async () => { await reset.promise; return {}; });
    const run = new ChapterRun({ discover: async () => pages, process, progress: () => undefined });
    const first = run.run();
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    run.stop();
    reset.resolve();
    await first;
    await run.run();
    expect(run.status).toMatchObject({ phase: 'stopped', processed: 0 });
    expect(process).toHaveBeenCalledTimes(1);
  });
});
