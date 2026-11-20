import type { UiLanguage } from '../i18n/messages';
import type { ChapterAction, ChapterCommand, ChapterStatus } from '../core/chapter/ChapterRun';
import type { ChapterPage } from '../core/chapter/readerSites';
import type { ErrorDetails, ImageDescriptor, JobStatus, PanelRegion, Point, ProviderId, Rect, RenderedPatch, Settings } from '../types/contracts';

export const readerPort = 'manga-reader-v1';

export interface CaptureProbe { type: 'CAPTURE_PROBE'; id: string; phase: 'prepare' | 'validate' | 'restore' }
export interface CaptureFrame { bounds: Rect; viewport: [number, number, number, number, number, number, number] }

export interface ImageProbe { type: 'IMAGE_PROBE'; id: string }
export interface ChapterSourceProbe { type: 'CHAPTER_SOURCE'; key: string }
export interface ChapterPatchRef extends ChapterPage { chapter: string; run: string; imageHash: string }
export interface ReaderProbe { type: 'READER_PROBE'; reconnect: boolean }
export interface VisiblePagesProbe { type: 'VISIBLE_PAGES'; command: 'start' | 'stop' }
/** Progress of the run that reads the canvas pages showing on screen. Counts are of this run only. */
export interface VisiblePagesStatus {
  phase: 'idle' | 'running' | 'finished' | 'stopped';
  total: number; processed: number; translated: number; skipped: number; failed: number;
  /** Pages read from a screen capture because the browser hides the canvas pixels from the page. */
  captured: number;
}
/** What the reader reports about itself when probed. */
export interface ReaderInfo {
  ready: true;
  /** Canvas pages mounted, and how many of them are on screen and eligible now. */
  canvasPages: number;
  visiblePages: number;
  run?: VisiblePagesStatus;
}
export interface ClearProbe { type: 'CLEAR_READER_TRANSLATIONS' }

export type ReaderRequest =
  | { type: 'PREFETCH'; id: string; image: ImageDescriptor }
  | { type: 'PROCESS_PANEL'; id: string; image: ImageDescriptor; point: Point; manual?: Rect; visibleCapture?: true; surfaceCrop?: true; protectedRegions?: Rect[] }
  | { type: 'CHAPTER_COMMAND'; id: string; run: string; command: ChapterAction }
  | { type: 'GET_CHAPTER_PATCH'; id: string; chapter: string; run: string; index: number }
  | { type: 'CANCEL'; id: string };

export type ReaderEvent =
  | { type: 'READER_STATE'; uiLanguage: UiLanguage; active: boolean; panelMode?: boolean; prefetch: boolean; debug: boolean }
  | { type: 'CHAPTER_STATUS'; chapter: string; run: string; status: ChapterStatus }
  | { type: 'CHAPTER_PAGE'; page: ChapterPatchRef }
  | { type: 'CHAPTER_PATCH'; id: string; patch?: RenderedPatch }
  | { type: 'PANEL_MAP'; image: ImageDescriptor; panels: PanelRegion[] }
  | { type: 'JOB_PROGRESS'; id: string; stage: JobStatus }
  | { type: 'JOB_COMPLETE'; id: string; image: ImageDescriptor; patch: RenderedPatch; cached: boolean }
  | { type: 'JOB_ERROR'; id: string; image: ImageDescriptor; error: ErrorDetails };

export type UiRequest =
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; patch: Partial<Settings> }
  | { type: 'GET_TAB'; tabId: number }
  | { type: 'SET_TAB'; tabId: number; active: boolean }
  | { type: 'CLEAR_TRANSLATIONS'; tabId: number }
  | { type: 'RESUME_AFTER_PERMISSION'; tabId: number }
  | { type: 'CHAPTER_CONTROL'; tabId: number; command: ChapterCommand }
  | { type: 'VISIBLE_PAGES'; tabId: number; command: 'start' | 'stop' }
  | { type: 'GET_CHROME' }
  | { type: 'GET_CREDENTIAL'; provider: ProviderId }
  | { type: 'SET_CREDENTIAL'; provider: ProviderId; key?: string; remember: boolean }
  | { type: 'TEST_PROVIDER'; provider: ProviderId }
  | { type: 'CLEAR_CACHE' };

export interface PopupEvent { to: 'popup'; type: 'TAB_STATUS_CHANGED'; tabId: number }

export interface TabStatus {
  active: boolean;
  readerReady?: boolean;
  pendingOrigin?: string;
  chapterAvailable?: boolean;
  /** `mounted` for readers without a known page list: only loaded images are translated. */
  chapterScope?: 'full' | 'mounted';
  chapter?: ChapterStatus;
  /** Present for readers that paint pages on canvases: the visible-pages mode replaces whole-chapter translation. */
  visiblePages?: Omit<ReaderInfo, 'ready'>;
}
type Reply<T> = { ok: true; output: T } | { ok: false; error: ErrorDetails };

export async function uiRequest<T>(message: UiRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage({ to: 'background', ...message }) as Reply<T> | undefined;
  if (!response) throw new Error('Extension tidak merespons.');
  if (!response.ok) throw new Error(response.error.message);
  return response.output;
}
