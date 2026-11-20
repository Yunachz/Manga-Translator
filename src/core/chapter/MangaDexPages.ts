import { hostPattern } from '../../messaging/permission';
import { record } from '../../messaging/validate';
import { PipelineError } from '../pipeline/PipelineError';
import { chapterPageLimit, type ChapterPage } from './readerSites';

const api = 'https://api.mangadex.org';
const asset = /^[\w.-]{1,240}\.(webp|avif|png|jpeg|jpg|gif)$/i;

export function mangaDexPages(raw: unknown, dataSaver: boolean): ChapterPage[] {
  if (!record(raw) || typeof raw.baseUrl !== 'string' || !record(raw.chapter) ||
      typeof raw.chapter.hash !== 'string' || !/^[a-f0-9]{16,128}$/i.test(raw.chapter.hash)) return [];
  let base: URL;
  try { base = new URL(raw.baseUrl); } catch { return []; }
  if (base.protocol !== 'https:' || base.username || base.password || base.port || base.pathname !== '/' ||
      base.search || base.hash || !/^(?:[\w-]+\.)+(?:mangadex\.org|mangadex\.network)$/i.test(base.hostname)) return [];
  const optimized = dataSaver && Array.isArray(raw.chapter.dataSaver) && raw.chapter.dataSaver.length > 0;
  const files: unknown = optimized ? raw.chapter.dataSaver : raw.chapter.data;
  if (!Array.isArray(files) || !files.length || files.length > chapterPageLimit ||
      !files.every((file): file is string => typeof file === 'string' && asset.test(file))) return [];
  const tier = optimized ? 'data-saver' : 'data';
  const hash = raw.chapter.hash;
  return files.map((file, number) => ({ index: number + 1, src: new URL(`/${tier}/${hash}/${encodeURIComponent(file)}`, base).href }));
}

export async function loadMangaDexPages(chapter: string, saver: boolean, signal: AbortSignal): Promise<ChapterPage[]> {
  if (!await chrome.permissions.contains({ origins: [hostPattern(api)] })) {
    throw new PipelineError('IMAGE_PERMISSION', 'Izinkan MangaDex untuk membaca daftar halaman chapter.', api);
  }
  let response: Response;
  try {
    response = await fetch(`${api}/at-home/server/${chapter}?forcePort443=true`, { credentials: 'omit', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  } catch {
    signal.throwIfAborted();
    throw new PipelineError('IMAGE_FETCH', 'Daftar halaman MangaDex tidak bisa dihubungi.');
  }
  if (!response.ok) throw new PipelineError('IMAGE_FETCH', `Daftar halaman MangaDex mengembalikan HTTP ${response.status}.`);
  const pages = mangaDexPages(await response.json().catch(() => undefined), saver);
  if (!pages.length) throw new PipelineError('IMAGE_UNSUPPORTED', 'Format daftar halaman MangaDex belum didukung.');
  return pages;
}
