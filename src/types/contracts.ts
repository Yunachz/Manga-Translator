import type { UiLanguage } from '../i18n/messages';

export const providerIds = ['chrome', 'gemini', 'openai', 'google', 'deepl', 'azure'] as const;
export type ProviderId = typeof providerIds[number];
export const sourceLanguages = ['auto', 'ja', 'ko', 'zh', 'en'] as const;
export type SourceLanguage = typeof sourceLanguages[number];
export const inpaintingModes = ['normal', 'constrained', 'conservative'] as const;
export type InpaintingMode = typeof inpaintingModes[number];

export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
/**
 * `img` (default) is fetched or read from the page. `canvas` is a canvas the page paints: its `src` is only the page
 * address and is never fetched. `viewport` is a freeform area of the visible tab, read only by tab capture.
 */
export type SurfaceKind = 'img' | 'canvas' | 'viewport';
export interface ImageDescriptor { id: string; src: string; width: number; height: number; kind?: SurfaceKind }
export interface PanelRegion { id: string; bounds: Rect; polygon: Point[]; confidence: number }
export interface TextRegion { bounds: Rect; polygon: Point[] }
export interface BubbleRegion {
  id: string;
  bounds: Rect;
  lines: TextRegion[];
  shape?: Point[];
  /** The physical outline of the interior this bubble was cut from, when the cut between two bubbles is not a real edge. */
  maskShape?: Point[];
  enclosed?: boolean;
  textSize?: number;
}
export interface OCRResult { id: string; text: string; confidence: number; bounds: Rect; vertical: boolean }
export interface TranslationSegment { id: string; text: string }
export interface TranslationContext {
  previousPanel?: TranslationSegment[];
  glossary?: Record<string, string>;
  series?: string;
}
export interface TranslationRequest {
  sourceLanguage: string;
  targetLanguage: string;
  segments: TranslationSegment[];
  context?: TranslationContext;
}
export interface TranslationResult { segments: TranslationSegment[] }
export interface ProviderConfig { model: string; region: string; endpointTier: 'free' | 'pro' }

export interface Settings {
  uiLanguage: UiLanguage;
  enabled: boolean;
  provider: ProviderId;
  providers: Record<ProviderId, ProviderConfig>;
  source: SourceLanguage;
  target: string;
  ocrLanguage: SourceLanguage;
  readingOrder: 'auto' | 'rtl' | 'ttb';
  performance: 'auto' | 'wasm';
  inpainting: 'auto' | 'fast' | 'classical';
  inpaintingMode: InpaintingMode;
  contextual: boolean;
  usePreviousPanel: boolean;
  glossary: string;
  series: string;
  prefetch: boolean;
  debug: boolean;
  fontFamily: 'Arial' | 'Verdana' | 'Georgia';
  fontWeight: 400 | 600 | 700;
  padding: number;
  lineHeight: number;
}
export const stages = ['QUEUED', 'IMAGE_FETCH', 'PANEL_RESOLVE', 'PANEL_CROP', 'TEXT_DETECTION', 'OCR',
  'READING_ORDER', 'TRANSLATION', 'TEXT_MASK', 'INPAINT', 'TYPESET', 'COMPOSITE', 'DONE', 'ERROR', 'CANCELLED'] as const;
export type JobStatus = typeof stages[number];
export type ErrorCode = 'CANCELLED' | 'IMAGE_PERMISSION' | 'IMAGE_FETCH' | 'IMAGE_UNSUPPORTED' | 'CAPTURE_UNAVAILABLE' |
  'PANEL_NOT_FOUND' | 'NO_TEXT' | 'ALREADY_TRANSLATED' | 'OCR_FAILED' | 'MODEL_LOAD' | 'PROVIDER_UNAVAILABLE' |
  'PROVIDER_PERMISSION' | 'UNAUTHORIZED' | 'QUOTA' | 'RATE_LIMITED' | 'TRANSLATION_FAILED' |
  'TRANSLATION_INVALID' | 'INPAINT_FAILED' | 'TYPESET_FAILED' | 'QUEUE_FULL' | 'INTERNAL';
export interface ErrorDetails { code: ErrorCode; message: string; origin?: string }
export interface JobDebug {
  text: TextRegion[];
  bubbles: BubbleRegion[];
  ordered: OCRResult[];
  mask?: string;
  inpainting?: string[];
  backend?: string;
  milliseconds?: Partial<Record<JobStatus, number>>;
}
export interface RenderedPatch { panel: PanelRegion; dataUrl: string; width: number; height: number; skippedBubbles?: number; coverage?: Rect[]; remaining?: Rect[]; debug?: JobDebug }
export interface PanelJob {
  id: string;
  image: ImageDescriptor;
  status: JobStatus;
  panel?: PanelRegion;
  error?: ErrorDetails;
}
