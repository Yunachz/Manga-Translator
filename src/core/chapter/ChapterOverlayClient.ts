import { copy, type UiLanguage } from '../../i18n/messages';
import { localizedError } from '../../i18n/errors';
import type { ChapterPatchRef, ReaderEvent, ReaderRequest } from '../../messaging/protocol';
import type { ImageDescriptor } from '../../types/contracts';
import type { ReaderOverlay } from '../../ui/ReaderOverlay';
import { activeChapter, canRetryChapter, chapterStatusLabel, chapterSummary, type ChapterAction } from './ChapterRun';
import { genericSource } from './genericPages';
import { readerImageDigest } from './readerImageDigest';
import { chapterPageKey, chapterSite } from './readerSites';

type ChapterEvent = Extract<ReaderEvent, { type: 'CHAPTER_STATUS' | 'CHAPTER_PAGE' | 'CHAPTER_PATCH' }>;
type Pending = { image: HTMLImageElement; descriptor: ImageDescriptor; ref: ChapterPatchRef };

export class ChapterOverlayClient {
  private status?: Extract<ChapterEvent, { type: 'CHAPTER_STATUS' }>;
  private interrupted = false;
  private readonly refs = new Map<string, ChapterPatchRef>();
  private readonly refsByDigest = new Map<string, ChapterPatchRef>();
  private readonly blobDigests = new WeakMap<HTMLImageElement, { src: string; digest?: string }>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly overlay: ReaderOverlay, private readonly send: (message: ReaderRequest) => boolean,
    private readonly descriptor: (image: HTMLImageElement) => ImageDescriptor | undefined,
    private readonly isActive: () => boolean, private readonly toggleActions: () => [string, () => void][],
    private readonly locale: () => UiLanguage, private readonly patchAdded: () => void) {}

  disconnect(): void {
    this.pending.clear();
    const status = this.status?.status;
    if (status && (activeChapter(status.phase) || canRetryChapter(status))) {
      this.interrupted = true;
      this.announce();
    }
  }

  clear(): void {
    this.status = undefined;
    this.interrupted = false;
    this.refs.clear();
    this.refsByDigest.clear();
    this.pending.clear();
  }

  announce(): boolean {
    const state = this.status;
    if (!state || !this.isActive() || chapterSite(location.href)?.key !== state.chapter) return false;
    const { status, run } = state;
    const locale = this.locale();
    const t = copy(locale);
    if (this.interrupted) {
      this.overlay.announce(t.chapterInterrupted, this.toggleActions());
      return true;
    }
    const actions: [string, () => void][] = [];
    const command = (command: ChapterAction) => this.send({ type: 'CHAPTER_COMMAND', id: crypto.randomUUID(), run, command });
    if (status.phase === 'paused' && !status.pendingOrigin) actions.push([t.continue, () => command('resume')]);
    if (status.phase === 'running' || status.phase === 'discovering') actions.push([t.pause, () => command('pause')]);
    if (['running', 'discovering', 'paused'].includes(status.phase)) actions.push([t.stopChapter, () => command('stop')]);
    if (canRetryChapter(status)) actions.push([t.retryPages, () => command('retry')]);
    const counts = status.total === null ? '' : ` · ${status.processed}/${status.total} ${t.pages}`;
    const detail = status.phase === 'completed' || canRetryChapter(status) ? ' · ' + chapterSummary(status, locale) : '';
    this.overlay.announce(chapterStatusLabel(status, locale) + counts + detail + (status.message ? `. ${localizedError(locale, status.message)}` : ''),
      [...actions, ...this.toggleActions()]);
    return true;
  }

  inspect(image: HTMLImageElement, descriptor: ImageDescriptor): void {
    if (!this.isActive() || descriptor.width < 250 || descriptor.height < 250 || !this.status) return;
    const site = chapterSite(location.href);
    if (site?.key !== this.status.chapter) return;
    if (site.site === 'dex' && descriptor.src.startsWith('blob:')) {
      this.inspectBlob(image, descriptor);
      return;
    }
    const key = site.site === 'generic' ? genericSource(descriptor.src, location.origin) : chapterPageKey(descriptor.src);
    const ref = key ? this.refs.get(key) : undefined;
    if (!ref || (site.page !== undefined && site.page !== ref.index)) return;
    this.requestPatch(image, descriptor, ref);
  }

  private inspectBlob(image: HTMLImageElement, descriptor: ImageDescriptor): void {
    if (!this.refsByDigest.size) return;
    const cached = this.blobDigests.get(image);
    if (cached?.src === descriptor.src) {
      const ref = cached.digest && this.refsByDigest.get(cached.digest);
      if (ref) this.requestPatch(image, descriptor, ref);
      return;
    }
    const entry: { src: string; digest?: string } = { src: descriptor.src };
    this.blobDigests.set(image, entry);
    void readerImageDigest(entry.src).then(digest => {
      entry.digest = digest;
      if (digest && this.descriptor(image)?.id === descriptor.id) this.inspect(image, descriptor);
    });
  }

  private requestPatch(image: HTMLImageElement, descriptor: ImageDescriptor, ref: ChapterPatchRef): void {
    if (ref.run !== this.status?.run) return;
    const panelId = this.panelId(ref);
    if (this.overlay.hasPatch(image, panelId) || [...this.pending.values()].some(item => item.descriptor.id === descriptor.id)) return;
    const id = crypto.randomUUID();
    if (this.send({ type: 'GET_CHAPTER_PATCH', id, chapter: ref.chapter, run: ref.run, index: ref.index })) {
      this.pending.set(id, { image, descriptor, ref });
    }
  }

  receive(event: ChapterEvent): void {
    if (event.type === 'CHAPTER_STATUS') {
      if (chapterSite(location.href)?.key !== event.chapter) return;
      if (event.status.phase === 'stopped' && this.status?.run !== event.run) return;
      this.interrupted = false;
      if (this.status?.run !== event.run) {
        this.refs.clear();
        this.refsByDigest.clear();
        this.pending.clear();
        if (event.status.phase === 'discovering') this.overlay.show();
      }
      this.status = event;
      this.announce();
    } else if (event.type === 'CHAPTER_PAGE') {
      const site = chapterSite(location.href);
      if (this.status?.run !== event.page.run || site?.key !== event.page.chapter) return;
      const key = site.site === 'generic' ? genericSource(event.page.src, location.origin) : chapterPageKey(event.page.src);
      if (key) this.refs.set(key, event.page);
      this.refsByDigest.set(event.page.imageHash, event.page);
      for (const image of document.images) {
        const bounds = image.getBoundingClientRect();
        if (bounds.bottom < -360 || bounds.top > innerHeight + 360) continue;
        const description = this.descriptor(image);
        if (description) this.inspect(image, description);
      }
    } else {
      const request = this.pending.get(event.id);
      if (!request) return;
      const { image, descriptor, ref } = request;
      const valid = () => this.isActive() && this.status?.run === ref.run && chapterSite(location.href)?.key === ref.chapter
        && this.descriptor(image)?.id === descriptor.id;
      if (!event.patch || !valid()) { this.pending.delete(event.id); return; }
      const patch = { ...event.patch, panel: { ...event.patch.panel, id: this.panelId(ref) } };
      void this.overlay.add(image, patch, valid).then(added => {
        if (added) { this.patchAdded(); this.announce(); }
      })
        .catch(() => undefined).finally(() => this.pending.delete(event.id));
    }
  }

  private panelId(ref: ChapterPatchRef): string { return `chapter-${ref.run}-${ref.index}`; }
}
