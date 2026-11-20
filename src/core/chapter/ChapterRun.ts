import { copy, defaultUiLanguage, format, type UiLanguage } from '../../i18n/messages';
import { errorDetails, PipelineError } from '../pipeline/PipelineError';
import type { ChapterPage } from './readerSites';

export type ChapterPhase = 'discovering' | 'running' | 'paused' | 'completed' | 'stopped' | 'error';
export type ChapterAction = 'pause' | 'resume' | 'stop' | 'retry';
export type ChapterCommand = 'start' | ChapterAction;
export function isChapterAction(command: unknown): command is ChapterAction {
  return command === 'pause' || command === 'resume' || command === 'stop' || command === 'retry';
}
export interface ChapterStatus {
  phase: ChapterPhase;
  total: number | null;
  processed: number;
  translated: number;
  skipped: number;
  failed: number;
  partial: number;
  current?: number;
  pendingOrigin?: string;
  message?: string;
  /** `mounted` when the page list is only what the reader had loaded, not the whole chapter. */
  scope?: 'mounted';
}
export interface ChapterResult { note?: 'partial' }
interface ChapterHooks {
  discover(signal: AbortSignal): Promise<ChapterPage[]>;
  process(page: ChapterPage, signal: AbortSignal): Promise<ChapterResult>;
  progress(status: ChapterStatus): void;
}
const pauseErrors = new Set(['IMAGE_PERMISSION', 'PROVIDER_PERMISSION', 'UNAUTHORIZED', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'QUOTA']);
const imagePermissionMessage = 'Izinkan akses gambar di popup. Terjemahan akan lanjut otomatis.';

export function activeChapter(phase: ChapterPhase): boolean {
  return phase === 'discovering' || phase === 'running' || phase === 'paused';
}

export function canRetryChapter(status: ChapterStatus): boolean {
  return (status.phase === 'completed' || status.phase === 'error') && status.failed > 0;
}

export class ChapterRun {
  readonly id = crypto.randomUUID();
  private readonly controller = new AbortController();
  private remaining?: ChapterPage[];
  private readonly failedPages: ChapterPage[] = [];
  private busy = false;
  private pauseRequested = false;
  private state: ChapterStatus = { phase: 'discovering', total: null, processed: 0, translated: 0, skipped: 0, failed: 0, partial: 0 };

  constructor(private readonly hooks: ChapterHooks) {}
  get status(): ChapterStatus { return this.state; }

  private update(patch: Partial<ChapterStatus>): void {
    this.state = { ...this.state, ...patch };
    this.hooks.progress(this.state);
  }

  pause(): void {
    if (!activeChapter(this.state.phase) || this.state.phase === 'paused') return;
    this.pauseRequested = true;
    // Finish the current page before pausing. A provider may have already billed it.
    this.update({ message: 'Menjeda setelah langkah ini…' });
  }

  stop(): void {
    if (!activeChapter(this.state.phase)) return;
    this.controller.abort();
    this.update({ phase: 'stopped', current: undefined, message: undefined, pendingOrigin: undefined });
  }

  async run(retry = false): Promise<void> {
    if (this.busy || !(retry ? canRetryChapter(this.state) : activeChapter(this.state.phase))) return;
    this.busy = true;
    this.pauseRequested = false;
    const signal = this.controller.signal;
    const retryCount = retry ? this.failedPages.length : 0;
    if (retry) this.remaining = this.failedPages.splice(0);
    this.update({ phase: this.remaining ? 'running' : 'discovering', message: undefined, pendingOrigin: undefined,
      processed: this.state.processed - retryCount, failed: this.state.failed - retryCount });
    try {
      this.remaining ??= [...await this.hooks.discover(signal)];
      signal.throwIfAborted();
      if (!this.remaining.length) throw new PipelineError('IMAGE_UNSUPPORTED', 'Daftar halaman bab belum ditemukan. Tunggu bab tampil, lalu coba lagi.');
      this.update({ phase: 'running', total: this.state.total ?? this.remaining.length });
      while (this.remaining.length && !this.pauseRequested) {
        signal.throwIfAborted();
        const page = this.remaining[0];
        this.update({ current: page.index });
        try {
          const result = await this.hooks.process(page, signal);
          signal.throwIfAborted();
          this.remaining.shift();
          this.update({ processed: this.state.processed + 1, translated: this.state.translated + 1,
            partial: this.state.partial + Number(result.note === 'partial') });
        } catch (error) {
          signal.throwIfAborted();
          const details = errorDetails(error);
          if (pauseErrors.has(details.code)) {
            this.update({ phase: 'paused', pendingOrigin: details.origin,
              message: details.code === 'IMAGE_PERMISSION' ? imagePermissionMessage : details.message });
            return;
          }
          const skipped = ['NO_TEXT', 'PANEL_NOT_FOUND', 'INPAINT_FAILED', 'TYPESET_FAILED'].includes(details.code);
          if (!skipped) this.failedPages.push(page);
          this.remaining.shift();
          this.update({ processed: this.state.processed + 1, skipped: this.state.skipped + Number(skipped),
            failed: this.state.failed + Number(!skipped) });
        }
      }
      const phase = this.remaining.length ? 'paused' : this.state.failed === this.state.total ? 'error' : 'completed';
      this.update({ phase, current: undefined, message: undefined });
    } catch (error) {
      if (signal.aborted) return;
      const details = errorDetails(error);
      const needsPermission = details.code === 'IMAGE_PERMISSION';
      this.update({ phase: needsPermission ? 'paused' : 'error', pendingOrigin: details.origin,
        message: needsPermission ? imagePermissionMessage : details.message });
    } finally { this.busy = false; }
  }
}

export function chapterStatusLabel(status: ChapterStatus, locale: UiLanguage = defaultUiLanguage): string {
  const t = copy(locale);
  if (status.phase === 'discovering') return t.findingPages;
  if (status.phase === 'error') return canRetryChapter(status) ? t.allPagesFailed : t.chapterUnavailable;
  if (status.phase === 'stopped') return t.chapterStopped;
  if (status.phase === 'paused') return t.chapterPaused;
  if (status.phase === 'completed') return status.failed ? t.somePagesFailed : t.chapterComplete;
  return status.current ? format(t.processingPage, { page: status.current }) : t.processingChapter;
}

export function chapterSummary(status: ChapterStatus, locale: UiLanguage): string {
  const { translated, partial, skipped, failed } = status;
  return format(copy(locale).counts, { translated: translated - partial, partial, skipped, failed });
}
