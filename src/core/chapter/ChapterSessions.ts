import { cache } from '../cache/CacheManager';
import { ImageHttpError } from '../image/ImageFetcher';
import type { JobQueue } from '../pipeline/JobQueue';
import type { Pipeline } from '../pipeline/Pipeline';
import { PipelineError } from '../pipeline/PipelineError';
import { hostPattern } from '../../messaging/permission';
import type { ChapterPatchRef, ChapterSourceProbe, ReaderEvent } from '../../messaging/protocol';
import { record } from '../../messaging/validate';
import type { RenderedPatch, Settings } from '../../types/contracts';
import { activeChapter, ChapterRun, type ChapterCommand, type ChapterStatus } from './ChapterRun';
import { validateGenericPages } from './genericPages';
import { loadMangaDexPages } from './MangaDexPages';
import { chapterSite, validateSilentWitchPages, type ChapterPage, type ChapterSite } from './readerSites';

interface ChapterTab { id: number; documentId: string; origin: string; site: ChapterSite }
interface Entry { tab: ChapterTab; run: ChapterRun; blocked: Map<string, number>; lookahead: Map<number, PipelineError> }
const fullPage = { x: 0, y: 0, width: 1, height: 1 };
/** An image server that refused this many requests in a row gets no more requests during the run. */
const blockedLimit = 2;
export const protectedImageMessage = 'Server gambar menolak request dari extension (HTTP 401/403). Gunakan Pilih area pada panel yang tampil.';
export const noPagesMessage = 'Belum ada gambar halaman manga yang termuat di tab ini. Tunggu halaman tampil atau gulir sendiri, lalu coba lagi.';

function cacheKey(tab: Pick<ChapterTab, 'id' | 'documentId'>, chapter: string, run: string, index: number): string {
  return [tab.id, tab.documentId, chapter, run, index].join(':');
}

function forbidden(error: unknown): boolean {
  return error instanceof ImageHttpError && (error.status === 401 || error.status === 403);
}

function originOf(src: string): string {
  try { return new URL(src).origin; } catch { return ''; }
}

export class ChapterSessions {
  private readonly sessions = new Map<number, Entry>();
  constructor(private readonly queue: JobQueue, private readonly pipeline: Pipeline,
    private readonly broadcast: (tab: ChapterTab, message: ReaderEvent) => void) {}

  /** The run's status as the UI sees it: scope for readers without a page list, reason when a server refuses images. */
  private view(site: ChapterSite, blocked: ReadonlyMap<string, number>, status: ChapterStatus): ChapterStatus {
    const refused = [...blocked.values()].some(count => count >= blockedLimit);
    return { ...status, ...(site.site === 'generic' ? { scope: 'mounted' as const } : {}),
      ...(refused && !activeChapter(status.phase) && !status.message ? { message: protectedImageMessage } : {}) };
  }

  status(id: number, site?: ChapterSite): ChapterStatus | undefined {
    const entry = this.sessions.get(id);
    return entry && entry.tab.site.key === site?.key ? this.view(entry.tab.site, entry.blocked, entry.run.status) : undefined;
  }

  forget(id: number): void {
    this.sessions.get(id)?.run.stop();
    this.sessions.delete(id);
  }

  onNavigation(id: number, href: string): void {
    const entry = this.sessions.get(id);
    if (entry && chapterSite(href)?.key !== entry.tab.site.key) this.forget(id);
  }

  /** Continues paused runs whose missing image permission has since been granted. Only reads permission state. */
  async resumeGrantedPermissions(tabId?: number): Promise<void> {
    for (const [id, entry] of [...this.sessions]) {
      if (tabId !== undefined && id !== tabId) continue;
      const { phase, pendingOrigin } = entry.run.status;
      if (phase !== 'paused' || !pendingOrigin) continue;
      const granted = await chrome.permissions.contains({ origins: [hostPattern(pendingOrigin)] }).catch(() => false);
      const now = entry.run.status;
      if (!granted || this.sessions.get(id) !== entry || now.phase !== 'paused' || now.pendingOrigin !== pendingOrigin) continue;
      void entry.run.run();
    }
  }

  control(tab: ChapterTab, command: ChapterCommand, settings: Settings, runId?: string): ChapterStatus | undefined {
    const existing = this.sessions.get(tab.id);
    const current = existing?.tab.documentId === tab.documentId && existing.tab.site.key === tab.site.key ? existing.run : undefined;
    if (command !== 'start') {
      if (!existing || !current || (runId && current.id !== runId)) return;
      if (command === 'pause') current.pause();
      if (command === 'resume' && current.status.phase === 'paused') {
        existing.lookahead.clear();
        void current.run();
      }
      if (command === 'stop') current.stop();
      if (command === 'retry') {
        existing.blocked.clear();
        existing.lookahead.clear();
        void current.run(true);
      }
      return this.view(existing.tab.site, existing.blocked, current.status);
    }
    if (existing && current && activeChapter(current.status.phase)) return this.view(existing.tab.site, existing.blocked, current.status);
    existing?.run.stop();
    const blocked = new Map<string, number>();
    const lookahead = new Map<number, PipelineError>();
    let pages: ChapterPage[] = [];
    const run: ChapterRun = new ChapterRun({
      discover: async signal => {
        await this.ensureCurrent(tab);
        const probe: ChapterSourceProbe = { type: 'CHAPTER_SOURCE', key: tab.site.key };
        const reply: unknown = await chrome.tabs.sendMessage(tab.id, probe, { documentId: tab.documentId }).catch(() => undefined);
        signal.throwIfAborted();
        if (tab.site.site === 'dex') pages = await loadMangaDexPages(tab.site.id, record(reply) && reply.dataSaver === true, signal);
        else if (tab.site.site === 'generic') {
          pages = validateGenericPages(tab.origin, record(reply) ? reply.sources : undefined);
          if (!pages.length) throw new PipelineError('IMAGE_UNSUPPORTED', noPagesMessage);
        } else pages = validateSilentWitchPages(tab.site, record(reply) ? reply.sources : undefined);
        return pages;
      },
      process: async (page, signal) => {
        const job = `${run.id}-${page.index}`;
        const origin = originOf(page.src);
        const abort = () => this.queue.cancel(job);
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          if ((blocked.get(origin) ?? 0) >= blockedLimit) throw new PipelineError('IMAGE_FETCH', protectedImageMessage);
          const early = lookahead.get(page.index);
          lookahead.delete(page.index);
          if (early) {
            if (forbidden(early)) blocked.set(origin, (blocked.get(origin) ?? 0) + 1);
            throw early;
          }
          const result = await this.queue.enqueue(job, async queuedSignal => {
            await this.ensureCurrent(tab);
            this.preloadNext(tab, run.id, pages, page.index, blocked, lookahead, signal);
            const image = { id: job, src: page.src, width: 1, height: 1 };
            return await this.pipeline.run(run.id, { type: 'PROCESS_PANEL', id: job, image, point: { x: 0.5, y: 0.5 },
              manual: fullPage }, tab.origin, settings, undefined, AbortSignal.any([signal, queuedSignal]), {
              progress() {}, panels() {},
            });
          }, true).catch((error: unknown) => {
            if (forbidden(error)) blocked.set(origin, (blocked.get(origin) ?? 0) + 1);
            throw error;
          });
          blocked.delete(origin);
          signal.throwIfAborted();
          await this.ensureCurrent(tab);
          signal.throwIfAborted();
          await cache.set('chapter', cacheKey(tab, tab.site.key, run.id, page.index), result.patch);
          signal.throwIfAborted();
          this.broadcast(tab, { type: 'CHAPTER_PAGE', page: { ...page, chapter: tab.site.key, run: run.id, imageHash: result.imageHash } });
          return { note: result.patch.skippedBubbles ? 'partial' : undefined };
        } finally { signal.removeEventListener('abort', abort); }
      },
      progress: status => this.broadcast(tab, { type: 'CHAPTER_STATUS', chapter: tab.site.key, run: run.id,
        status: this.view(tab.site, blocked, status) }),
    });
    this.sessions.set(tab.id, { tab, run, blocked, lookahead });
    void run.run();
    return this.view(tab.site, blocked, run.status);
  }

  /**
   * Fetches the next page while the current one is read and rendered. One page ahead at most, no inference,
   * no permission prompt, and the same abort signal as the run. A failed fetch is remembered so the page
   * is not requested a second time.
   */
  private preloadNext(tab: ChapterTab, run: string, pages: readonly ChapterPage[], index: number,
    blocked: ReadonlyMap<string, number>, failures: Map<number, PipelineError>, signal: AbortSignal): void {
    const next = pages.find(page => page.index === index + 1);
    if (!next || signal.aborted || failures.has(next.index) || (blocked.get(originOf(next.src)) ?? 0) > 0) return;
    const image = { id: `${run}-${next.index}`, src: next.src, width: 1, height: 1 };
    this.pipeline.preload(run, image, tab.origin, signal).catch((error: unknown) => {
      if (!signal.aborted && error instanceof PipelineError && (error.code === 'IMAGE_FETCH' || error.code === 'IMAGE_UNSUPPORTED')) {
        failures.set(next.index, error);
      }
    });
  }

  async patch(tab: Pick<ChapterTab, 'id' | 'documentId'>, page: Pick<ChapterPatchRef, 'chapter' | 'run' | 'index'>): Promise<RenderedPatch | undefined> {
    const current = await chrome.tabs.get(tab.id).catch(() => undefined);
    if (chapterSite(current?.url ?? '')?.key !== page.chapter) return;
    return cache.get<RenderedPatch>('chapter', cacheKey(tab, page.chapter, page.run, page.index));
  }

  private async ensureCurrent(tab: ChapterTab): Promise<void> {
    const current = await chrome.tabs.get(tab.id).catch(() => undefined);
    if (chapterSite(current?.url ?? '')?.key !== tab.site.key) {
      this.forget(tab.id);
      throw new DOMException('Chapter navigation', 'AbortError');
    }
  }
}
