import { cache } from '../cache/CacheManager';
import { cacheKey } from '../cache/identity';
import { fetchImage, type AcquiredImage } from '../image/ImageFetcher';
import type { LocalAcquirer } from '../image/LocalImageAcquire';
import { cropRegions } from '../image/translatedCoverage';
import { panelFromCrop, pointInCrop } from '../image/surfaceCrop';
import { optionalModels } from '../models/capabilities';
import { rectPolygon, selectPanel } from '../image/geometry';
import type { OCRPanel } from '../../messaging/inference';
import type { ReaderRequest } from '../../messaging/protocol';
import { credential } from '../../storage/credentials';
import type { ImageDescriptor, JobStatus, PanelRegion, Point, RenderedPatch, Settings, TranslationContext, TranslationRequest, TranslationResult, TranslationSegment } from '../../types/contracts';
import { TranslatorManager } from '../translation/TranslatorManager';
import { chromeProxy, runInference } from './OffscreenClient';
import { PipelineError } from './PipelineError';

type Selection = Extract<ReaderRequest, { type: 'PROCESS_PANEL' }>;
interface Hooks { progress: (stage: JobStatus) => void; panels: (panels: PanelRegion[]) => void }
const translator = new TranslatorManager(chromeProxy);

function optionalContext(settings: Settings, previous?: TranslationSegment[]): TranslationContext | undefined {
  if (!settings.contextual || !['gemini', 'openai'].includes(settings.provider)) return;
  const glossary = Object.fromEntries(settings.glossary.split('\n').flatMap(line => {
    const [term, ...rest] = line.split('=');
    const definition = rest.join('=').trim();
    return term.trim() && definition ? [[term.trim(), definition]] : [];
  }));
  return { series: settings.series || undefined, glossary: Object.keys(glossary).length ? glossary : undefined,
    previousPanel: settings.usePreviousPanel ? previous?.slice(0, 12).map(segment => ({ ...segment, text: segment.text.slice(0, 400) })) : undefined };
}

export class Pipeline {
  private readonly images = new Map<string, { image: AcquiredImage; expires: number }>();
  private readonly pending = new Map<string, Promise<AcquiredImage>>();

  /**
   * Where the pixels of one surface come from. A canvas is read from the page that paints it, a viewport area only
   * from a tab capture, and neither is ever requested from the network. Both fail with IMAGE_UNSUPPORTED so the
   * caller can fall back to a tab capture the user started.
   */
  private async source(image: ImageDescriptor, origin: string, signal: AbortSignal, prompt: boolean, local?: LocalAcquirer): Promise<AcquiredImage> {
    if (image.kind === 'viewport') throw new PipelineError('IMAGE_UNSUPPORTED', 'Area layar hanya dapat dibaca lewat tangkapan tab.');
    if (image.kind === 'canvas') {
      if (!local) throw new PipelineError('IMAGE_UNSUPPORTED', 'Canvas reader tidak dapat dibaca langsung.');
      return local(image, signal);
    }
    return image.src.startsWith('blob:') && local ? local(image, signal) : fetchImage(image, origin, signal, prompt);
  }

  private async acquire(namespace: string, image: ImageDescriptor, origin: string, signal: AbortSignal, prompt: boolean, local?: LocalAcquirer) {
    // A page script can repaint a canvas under the same ID, so its pixels are read every time.
    if (image.kind === 'canvas' || image.kind === 'viewport') return this.source(image, origin, signal, prompt, local);
    const key = `${namespace}|${image.id}|${image.src}`;
    const stored = this.images.get(key);
    if (stored && stored.expires > Date.now()) return stored.image;
    // A lookahead fetch and the job that needs it share one request.
    const waiting = this.pending.get(key);
    if (waiting) return waiting;
    const task = (async () => {
      const acquired = await this.source(image, origin, signal, prompt, local);
      this.images.delete(key);
      this.images.set(key, { image: acquired, expires: Date.now() + 180_000 });
      const first = this.images.keys().next().value;
      if (this.images.size > 3 && first) this.images.delete(first);
      return acquired;
    })();
    this.pending.set(key, task);
    try { return await task; } finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }

  /** Fetches an image without inference. Preserve permission errors for a job that joins this request. */
  async preload(namespace: string, image: ImageDescriptor, origin: string, signal: AbortSignal): Promise<void> {
    await this.acquire(namespace, image, origin, signal, true);
  }

  private async panelMap(image: AcquiredImage, key: string, settings: Settings, signal: AbortSignal): Promise<PanelRegion[]> {
    const signature = await cacheKey('panel-v4', [image.hash, settings.performance, optionalModels.panel]);
    const hit = await cache.get<PanelRegion[]>('panel', signature);
    if (hit) return hit;
    const panels = await runInference('detect', { key, preference: settings.performance }, undefined, signal);
    await cache.set('panel', signature, panels);
    return panels;
  }

  async prefetch(namespace: string, image: ImageDescriptor, origin: string, settings: Settings, signal: AbortSignal) {
    const acquired = await this.acquire(namespace, image, origin, signal, false);
    return this.withTransfer(acquired, key => this.panelMap(acquired, key, settings, signal));
  }

  private async withTransfer<T>(image: AcquiredImage, task: (key: string) => Promise<T>): Promise<T> {
    const key = crypto.randomUUID();
    await cache.set('transfer', key, image.blob);
    try { return await task(key); }
    finally { await cache.delete('transfer', key); }
  }

  async run(namespace: string, selection: Selection, origin: string, settings: Settings, previous: TranslationSegment[] | undefined,
    signal: AbortSignal, hooks: Hooks, capture?: () => Promise<AcquiredImage>, recoverBubble = false, local?: LocalAcquirer): Promise<{ patch: RenderedPatch; segments: TranslationSegment[]; cached: boolean; imageHash: string }> {
    const timeline: Partial<Record<JobStatus, number>> = {};
    let stage: JobStatus = 'QUEUED', start = performance.now();
    const progress = (next: JobStatus) => {
      if (signal.aborted) return;
      const now = performance.now();
      timeline[stage] = Math.round(now - start);
      stage = next;
      start = now;
      if (settings.debug) console.debug('[Manga Translator]', { id: selection.id, stage: next });
      hooks.progress(next);
    };
    progress('IMAGE_FETCH');
    let captured = false;
    const acquired = await this.acquire(namespace, selection.image, origin, signal, true, local).catch(async (error: unknown) => {
      signal.throwIfAborted();
      if (!capture || !(error instanceof PipelineError) ||
          !['IMAGE_PERMISSION', 'IMAGE_FETCH', 'IMAGE_UNSUPPORTED'].includes(error.code)) throw error;
      const visible = await capture();
      captured = true;
      return visible;
    });
    signal.throwIfAborted();
    return this.withTransfer(acquired, async key => {
      progress('PANEL_RESOLVE');
      // A click on a surface only readable through the tab capture asks for the visible part of it. Panels are then
      // detected inside that crop and placed back on the surface.
      const crop = captured && selection.surfaceCrop ? selection.manual : undefined;
      const manual = crop ? undefined : captured ? { x: 0, y: 0, width: 1, height: 1 } : selection.surfaceCrop ? undefined : selection.manual;
      const point = crop ? pointInCrop(selection.point, crop) : selection.point;
      let panel: PanelRegion | undefined;
      let focus: Point | undefined;
      if (manual) panel = { id: 'manual', bounds: manual, polygon: rectPolygon(manual), confidence: 1 };
      else {
        const panels = await this.panelMap(acquired, key, settings, signal);
        signal.throwIfAborted();
        hooks.panels(crop ? panels.map(entry => panelFromCrop(entry, crop)) : panels);
        panel = selectPanel(point, panels);
      }
      if (!panel && recoverBubble) {
        const width = 0.52, height = 0.42;
        const x = Math.max(0, Math.min(1 - width, point.x - width / 2));
        const y = Math.max(0, Math.min(1 - height, point.y - height / 2));
        const bounds = { x, y, width, height };
        panel = { id: 'dialog-focus', bounds, polygon: rectPolygon(bounds), confidence: 0 };
        focus = { x: (point.x - x) / width, y: (point.y - y) / height };
      }
      if (!panel) throw new PipelineError('PANEL_NOT_FOUND', 'Panel tidak dapat ditentukan. Gunakan Pilih area.');
      const displayPanel = crop ? panelFromCrop(panel, crop) : captured && selection.manual ? { ...panel, bounds: selection.manual,
        polygon: rectPolygon(selection.manual) } : panel;
      const protectedRegions = cropRegions(selection.protectedRegions ?? [], displayPanel.bounds);
      const ocrSignature = await cacheKey('ocr-ppocrv5-v14', [acquired.hash, panel.bounds, settings.source,
        settings.ocrLanguage, settings.readingOrder, settings.performance, settings.inpaintingMode, focus, protectedRegions]);
      let reading = await cache.get<OCRPanel>('ocr', ocrSignature);
      if (!reading) {
        reading = await runInference('read', { key, panel, settings, focus, protectedRegions }, progress, signal);
        signal.throwIfAborted();
        await cache.set('ocr', ocrSignature, reading);
      }
      progress('TRANSLATION');
      const request: TranslationRequest = { sourceLanguage: reading.source, targetLanguage: settings.target,
        segments: reading.segments, context: optionalContext(settings, previous) };
      const translationSignature = await cacheKey('translation-v2', [settings.provider, settings.providers[settings.provider], request]);
      const renderSignature = await cacheKey('render-v14', [ocrSignature, translationSignature, settings.inpainting,
        settings.fontFamily, settings.fontWeight, settings.padding, settings.lineHeight, settings.debug, optionalModels.lama]);
      const hit = await cache.get<RenderedPatch>('render', renderSignature);
      if (hit) return { patch: { ...hit, panel: displayPanel }, segments: reading.segments, cached: true, imageHash: acquired.hash };
      const translation = await this.translate(translationSignature, settings, request, signal);
      signal.throwIfAborted();
      const patch = await runInference('render', { key, panel, reading, translation, settings }, progress, signal);
      signal.throwIfAborted();
      if (patch.debug) {
        timeline.COMPOSITE = Math.round(performance.now() - start);
        patch.debug.milliseconds = timeline;
      }
      if (patch.dataUrl.length < 7_000_000) await cache.set('render', renderSignature, patch);
      return { patch: { ...patch, panel: displayPanel }, segments: reading.segments, cached: false, imageHash: acquired.hash };
    });
  }

  private async translate(signature: string, settings: Settings, request: TranslationRequest, signal: AbortSignal): Promise<TranslationResult> {
    const cached = await cache.get<TranslationResult>('translation', signature);
    if (cached) return cached;
    const secret = await credential(settings.provider);
    const result = await translator.translate(settings, secret.key, request, signal);
    signal.throwIfAborted();
    await cache.set('translation', signature, result);
    return result;
  }
}

export async function testProvider(settings: Settings): Promise<void> {
  await translator.test(settings, (await credential(settings.provider)).key, AbortSignal.timeout(28_000));
}
