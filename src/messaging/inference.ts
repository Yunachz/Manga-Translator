import type { ErrorDetails, JobDebug, JobStatus, PanelRegion, Point, Rect, RenderedPatch, Settings, SourceLanguage, TranslationResult, TranslationSegment } from '../types/contracts';

export interface OCRPanel {
  source: Exclude<SourceLanguage, 'auto'>;
  segments: TranslationSegment[];
  skippedBubbles: number;
  remaining: Rect[];
  preserve: Rect[];
  debug: JobDebug;
}

export interface InferenceOperations {
  captureCrop: { input: { screenshot: string; bounds: Rect }; output: string };
  detect: { input: { key: string; preference: Settings['performance'] }; output: PanelRegion[] };
  read: { input: { key: string; panel: PanelRegion; settings: Settings; focus?: Point; protectedRegions?: Rect[] }; output: OCRPanel };
  render: { input: { key: string; panel: PanelRegion; reading: OCRPanel; translation: TranslationResult; settings: Settings }; output: RenderedPatch };
}

export type Operation = keyof InferenceOperations;
export type InferenceRequest = {
  [K in Operation]: { id: string; op: K; input: InferenceOperations[K]['input'] }
}[Operation];
export type WorkerMessage = InferenceRequest | { abort: string };
export type InferenceResponse =
  | { id: string; stage: JobStatus }
  | { id: string; ok: true; output: InferenceOperations[Operation]['output'] }
  | { id: string; ok: false; error: ErrorDetails };
