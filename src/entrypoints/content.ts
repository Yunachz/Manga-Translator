import { copy, defaultUiLanguage, format } from '../i18n/messages';
import { localizedError } from '../i18n/errors';
import { ChapterOverlayClient } from '../core/chapter/ChapterOverlayClient';
import { chapterSite, silentWitchPages } from '../core/chapter/readerSites';
import { collectCandidates, selectGenericPages } from '../core/chapter/genericPages';
import { imageGeometry, toNatural, toNormalized, toViewport } from '../core/image/CoordinateMapper';
import { clamp, normalizedSelection, rectPolygon, selectPanel } from '../core/image/geometry';
import { visibleArea } from '../core/image/visibleArea';
import { visibleReaderSurface } from '../core/image/visibleReaderImage';
import { sameCaptureFrame } from '../core/image/captureFrame';
import { ImageRegistry } from '../core/image/ImageRegistry';
import { readRenderedImage } from '../core/image/LocalImage';
import { canvasFingerprint, canvasReadable, readCanvas } from '../core/surface/canvasPixels';
import { isCanvas, type ReaderElement } from '../core/surface/ReaderSurface';
import { outcomeOf, VisiblePagesRun, type PageOutcome } from '../core/surface/VisiblePages';
import { anchorCell, clearWindow, windowRect } from '../core/surface/occlusion';
import { areaSignature, minimumArea, sameViewport, viewportPixels, viewportPoint, viewportRect, viewportSnapshot, visibleCrop, visibleShare,
  type ViewportSnapshot } from '../core/surface/viewport';
import { readerPort, type CaptureFrame, type CaptureProbe, type ChapterSourceProbe, type ClearProbe, type ImageProbe, type ReaderEvent, type ReaderInfo,
  type ReaderProbe, type ReaderRequest, type VisiblePagesProbe, type VisiblePagesStatus } from '../messaging/protocol';
import type { ImageDescriptor, JobStatus, PanelRegion, Point, Rect } from '../types/contracts';
import { ReaderOverlay } from '../ui/ReaderOverlay';

/**
 * One thing to translate. `surface` is the page image or canvas it belongs to. A freeform area has none: it is a
 * rectangle of the visible tab, tied to the view (viewport, scroll and what lies under it) it was drawn in.
 */
interface Hit {
  surface?: ReaderElement;
  descriptor: ImageDescriptor;
  point: Point;
  manual?: Rect;
  allowCapture?: true;
  /** `manual` is the visible part of a canvas the page hides from scripts. Panels are detected inside it. */
  surfaceCrop?: true;
  captureFrame?: CaptureFrame;
  view?: ViewportSnapshot;
  signature?: string;
  /** Page address a freeform area was drawn on. */
  route?: string;
  fingerprint?: string;
}
interface Drag { hit?: Hit; start: Point; pointerId: number; target: Element }
const fullSurface: Rect = { x: 0, y: 0, width: 1, height: 1 };
/** A page chosen for a visible-pages run, with the identity and position it had then. */
interface PageTarget { surface: ReaderElement; id: string; slot: number; box: Rect }
/** Longest a visible-pages run waits for one page before it cancels that page and goes on. */
const pageTimeout = 120_000;
/** Share of a page that must be on screen before "translate visible pages" counts it as visible. */
const visibleThreshold = 0.35;
const stageCopy: Record<JobStatus, keyof ReturnType<typeof copy>> = {
  QUEUED: 'waiting', IMAGE_FETCH: 'fetchingImage', PANEL_RESOLVE: 'locatingPanel',
  PANEL_CROP: 'cropping', TEXT_DETECTION: 'detectingText', OCR: 'readingText',
  READING_ORDER: 'orderingDialogue', TRANSLATION: 'translating', TEXT_MASK: 'masking',
  INPAINT: 'removingText', TYPESET: 'typesetting', COMPOSITE: 'preparingPatch',
  DONE: 'panelTranslated', ERROR: 'translationStopped', CANCELLED: 'translationCancelled',
};

export default defineContentScript({
  matches: ['https://*/*', 'http://*/*'],
  registration: 'runtime',
  main(ctx) {
    const world = globalThis as typeof globalThis & { mangaTranslatorLoaded?: boolean };
    if (world.mangaTranslatorLoaded) return;
    world.mangaTranslatorLoaded = true;
    const overlay = new ReaderOverlay();
    const maps = new Map<string, PanelRegion[]>();
    const jobs = new Map<string, Hit>();
    /** Callbacks that wait for a job to end: the error code, or nothing when it succeeded. */
    const settlers = new Map<string, (code?: string) => void>();
    /** Canvas pages the visible-pages run has already translated, by surface ID. */
    const translatedPages = new Set<string>();
    let port: chrome.runtime.Port | undefined;
    let locale = defaultUiLanguage;
    let t = copy(locale);
    let active = false;
    let translationGeneration = 0;
    let panelEnabled = true;
    let debug = false;
    let lastPointer: PointerEvent | undefined;
    let selection: { drag?: Drag } | undefined;
    let consumeClick = false;
    let capturing: string | undefined;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let toolsTimer: ReturnType<typeof setTimeout> | undefined;

    function send(message: ReaderRequest): boolean {
      try { port?.postMessage(message); return !!port; } catch { return false; }
    }

    function endJob(id: string, code?: string): void {
      const settle = settlers.get(id);
      settlers.delete(id);
      settle?.(code);
    }

    function dropJobs(code = 'CANCELLED'): void {
      for (const id of [...jobs.keys()]) endJob(id, code);
      jobs.clear();
    }

    const registry = new ImageRegistry({
      changed() { scheduleTools(); },
      ready(surface, descriptor) { if (!isCanvas(surface)) chapter.inspect(surface, descriptor); },
      near(_surface, descriptor) {
        if (active && !descriptor.src.startsWith('blob:')) {
          send({ type: 'PREFETCH', id: crypto.randomUUID(), image: descriptor });
        }
      },
      removed(surface, id) {
        overlay.remove(surface);
        maps.delete(id);
        if (selection?.drag?.hit?.descriptor.id === id) interruptSelection();
        for (const [jobId, hit] of jobs) {
          if (hit.descriptor.id === id) { send({ type: 'CANCEL', id: jobId }); jobs.delete(jobId); endJob(jobId, 'CANCELLED'); }
        }
      },
    });
    registry.setPrefetch(false);
    const policy = registry.policy;
    const cursor = new CSSStyleSheet();
    cursor.replaceSync(`
      html.manga-translate-mode:not(.manga-translate-covered) :is(${policy.cursor}),
      html.manga-translate-selecting :is(${policy.cursor}) { cursor: crosshair !important; }
      html.manga-translate-selecting, html.manga-translate-selecting body { cursor: crosshair; }
      html.manga-translate-selecting body { user-select: none !important; }
      html.manga-translate-selecting :is(${policy.selector}) { touch-action: none; }
    `);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, cursor];
    const chapter = new ChapterOverlayClient(overlay, send, image => registry.descriptor(image), () => active, toggleAction, () => locale,
      () => { if (lastPointer) hover(lastPointer); });
    overlay.onFreeInvalidated = () => overlay.announce(t.areaRemoved, toggleAction());

    function readyForPanel(message = t.readerReady) {
      overlay.announce(message, toggleAction());
    }

    function toggleAction(): [string, () => void][] {
      return overlay.hasPatches ? [[overlay.isShowing ? t.showOriginal : t.showTranslation, () => {
        overlay.toggle();
        if (!chapter.announce()) overlay.announce(overlay.isShowing ? t.translationVisible : t.originalVisible, toggleAction());
      }]] : [];
    }

    /** A result may be applied only to the same surface, in the same state, or in the same view for a freeform area. */
    function valid(hit: Hit): boolean {
      if (!active || !panelEnabled) return false;
      const { surface } = hit;
      if (!surface) return !!hit.view && !!hit.manual && hit.route === location.href && sameViewport(hit.view, viewportSnapshot()) &&
        areaSignature(viewportPixels(hit.manual)) === hit.signature;
      if (registry.descriptor(surface)?.id !== hit.descriptor.id) return false;
      return !hit.fingerprint || (isCanvas(surface) && canvasFingerprint(surface) === hit.fingerprint);
    }

    /**
     * The part of a surface a tab capture can show: what is on screen, minus whatever an opaque element covers (a
     * header bar, a menu). Samples a grid over the visible part and asks for the clear window around the anchor, the
     * point the user clicked, so the crop always contains the click or is refused. With no anchor, as in a
     * visible-pages run, the covered edges are trimmed instead.
     */
    function capturableCrop(surface: ReaderElement, anchor?: Point): Rect | undefined {
      const crop = visibleCrop(imageGeometry(surface), viewportRect());
      if (!crop) return;
      const { object } = imageGeometry(surface);
      const area = toViewport(crop, object);
      const columns = 12, rows = 30;
      const covered = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => visibleReaderSurface(
        area.x + area.width * (column + 0.5) / columns, area.y + area.height * (row + 0.5) / rows, policy) !== surface));
      const cell = anchor && anchorCell(anchor, crop, rows, columns);
      if (anchor && !cell) return;
      const window = clearWindow(covered, cell);
      if (!window) return;
      const kept = windowRect(window, rows, columns);
      return { x: crop.x + kept.x * crop.width, y: crop.y + kept.y * crop.height, width: kept.width * crop.width, height: kept.height * crop.height };
    }

    /** A canvas the browser hides from the page is read from the visible tab: the part on screen, with panels found inside it. */
    function plan(hit: Hit): Hit {
      const { surface } = hit;
      if (!surface || !isCanvas(surface) || hit.manual || canvasReadable(surface)) return hit;
      const crop = capturableCrop(surface, hit.point);
      return crop ? { ...hit, manual: crop, surfaceCrop: true, allowCapture: true } : hit;
    }

    function run(requested: Hit, settle?: (code?: string) => void): string | undefined {
      if (!valid(requested)) { settle?.('CANCELLED'); return; }
      const hit = plan(requested);
      // A canvas the page hides needs a capture. With no clear crop around the click there is nothing to capture.
      if (hit.surface && isCanvas(hit.surface) && !hit.manual && !canvasReadable(hit.surface)) {
        overlay.announce(t.surfaceCovered, toggleAction());
        settle?.('COVERED');
        return;
      }
      const previous = !settle && [...jobs].find(([, entry]) => entry.descriptor.id === hit.descriptor.id &&
        (entry.manual || hit.manual
          ? JSON.stringify(entry.manual) === JSON.stringify(hit.manual) &&
            (!hit.surfaceCrop || (Math.abs(entry.point.x - hit.point.x) < 0.025 && Math.abs(entry.point.y - hit.point.y) < 0.025))
          : Math.abs(entry.point.x - hit.point.x) < 0.025 && Math.abs(entry.point.y - hit.point.y) < 0.025));
      if (previous) return;
      const captureFrame = hit.allowCapture && imageFrame(hit);
      const job: Hit = { ...hit, captureFrame: captureFrame || undefined,
        fingerprint: hit.surface && isCanvas(hit.surface) && canvasReadable(hit.surface) ? canvasFingerprint(hit.surface) : undefined };
      const id = crypto.randomUUID();
      jobs.set(id, job);
      if (settle) settlers.set(id, settle);
      const message: ReaderRequest = { type: 'PROCESS_PANEL', id, image: job.descriptor, point: job.point, manual: job.manual,
        visibleCapture: captureFrame ? true : undefined, surfaceCrop: captureFrame && job.surfaceCrop ? true : undefined,
        protectedRegions: job.surface ? overlay.protectedRegions(job.surface).slice(-500) : undefined };
      if (!send(message)) {
        jobs.delete(id);
        endJob(id, 'CONNECTION');
        overlay.announce(t.connectionLost, [[t.retry, () => run(hit)], ...toggleAction()]);
        return;
      }
      overlay.show();
      if (!visible.running) overlay.announce(t[stageCopy.QUEUED], [[t.cancel, () => send({ type: 'CANCEL', id })], ...toggleAction()]);
      return id;
    }

    function updateSelectionControl(hint?: string): void {
      document.documentElement.classList.toggle('manga-translate-selecting', !!selection);
      if (selection) overlay.setSelectionControl([t.cancel, cancelManual], hint ?? t.selectAreaHelp);
      else overlay.setSelectionControl(active && panelEnabled ? [t.selectArea, () => selectManually()] : undefined);
      updateTools();
    }

    function selectManually(): void {
      if (!active || !panelEnabled) return;
      selection = {};
      overlay.highlight();
      updateSelectionControl();
    }

    function cancelManual(): void {
      interruptSelection();
      selection = undefined;
      overlay.highlight();
      overlay.highlightArea();
      updateSelectionControl();
    }

    function interruptSelection(event?: PointerEvent): void {
      if (!selection?.drag || (event && event.pointerId !== selection.drag.pointerId)) return;
      const { target, pointerId } = selection.drag;
      selection.drag = undefined;
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      overlay.highlight();
      overlay.highlightArea();
      updateSelectionControl();
    }

    function clearTranslations(): void {
      translationGeneration++;
      stopVisible();
      dropJobs();
      maps.clear();
      translatedPages.clear();
      chapter.clear();
      cancelManual();
      restoreCapture();
      document.documentElement.classList.remove('manga-translate-covered');
      overlay.clear();
      if (active && panelEnabled) readyForPanel(t.clearDone);
      else overlay.announce(t.clearDone);
    }

    // The canvas pages that show on screen now, in the reader's own page order. Each target records which page it
    // was and where it stood, so a canvas the reader reuses for another page, or one that has moved, is not read.
    function visibleTargets(): PageTarget[] {
      const viewport = viewportRect();
      return registry.list().flatMap(surface => {
        const descriptor = isCanvas(surface) ? registry.descriptor(surface) : undefined;
        if (!descriptor || translatedPages.has(descriptor.id) || !registry.admitted(surface) ||
            visibleShare(imageGeometry(surface), viewport) < visibleThreshold) return [];
        return [{ surface, id: descriptor.id, slot: policy.slot(surface)?.index ?? 0, box: surface.getBoundingClientRect().toJSON() as Rect }];
      }).sort((a, b) => a.slot - b.slot);
    }

    function sameBox(a: Rect, b: Rect): boolean {
      return (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(a[key] - b[key]) <= 1);
    }

    /** The page counts are measured at most a few times a second, however often the popup asks. The run is always current. */
    let counts: { stamp: number; canvasPages: number; visiblePages: number } | undefined;
    function readerInfo(): ReaderInfo {
      const now = performance.now();
      if (!counts || now - counts.stamp > 400) {
        counts = { stamp: now, canvasPages: registry.list().filter(isCanvas).length, visiblePages: visibleTargets().length };
      }
      const status = visible.status;
      return { ready: true, canvasPages: counts.canvasPages, visiblePages: counts.visiblePages, ...(status.phase !== 'idle' ? { run: status } : {}) };
    }

    function runVisiblePage(target: PageTarget): Promise<{ outcome: PageOutcome; captured: boolean }> {
      const { surface } = target;
      return new Promise(resolve => {
        const descriptor = isCanvas(surface) ? registry.descriptor(surface) : undefined;
        // The page may have turned, scrolled or been recycled since the run began. Reading it now would be a different page.
        if (!descriptor || descriptor.id !== target.id || !sameBox(surface.getBoundingClientRect(), target.box)) {
          resolve({ outcome: 'skipped', captured: false });
          return;
        }
        const readable = isCanvas(surface) && canvasReadable(surface);
        const manual = readable ? fullSurface : capturableCrop(surface);
        if (!descriptor || !manual) { resolve({ outcome: 'skipped', captured: false }); return; }
        const point = { x: manual.x + manual.width / 2, y: manual.y + manual.height / 2 };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const id = run({ surface, descriptor, point, manual, ...(readable ? {} : { allowCapture: true as const }) }, code => {
          clearTimeout(timer);
          if (!code) translatedPages.add(descriptor.id);
          resolve({ outcome: outcomeOf(code), captured: !readable });
        });
        // A page that never answers must not hold the whole run. It is cancelled and counted as failed.
        if (id) timer = setTimeout(() => { send({ type: 'CANCEL', id }); jobs.delete(id); endJob(id, 'TIMEOUT'); }, pageTimeout);
      });
    }

    function announceRun(status: VisiblePagesStatus): void {
      const counts = format(t.visibleCounts, { translated: status.translated, skipped: status.skipped, failed: status.failed });
      const note = status.captured ? ` ${t.visibleCaptureNote}` : '';
      if (status.phase === 'finished' && !status.total) { overlay.announce(t.visibleNone, toggleAction()); updateTools(); return; }
      const headline = status.phase === 'running' ? format(t.visibleProgress, { done: status.processed, total: status.total })
        : status.phase === 'stopped' ? format(t.visibleStopped, { done: status.processed, total: status.total })
          : format(t.visibleFinished, { done: status.processed, total: status.total });
      overlay.announce(`${headline} · ${counts}${note}`,
        status.phase === 'running' ? [[t.stopVisible, stopVisible], ...toggleAction()] : toggleAction());
      updateTools();
    }

    const visible = new VisiblePagesRun<PageTarget>(visibleTargets, runVisiblePage, announceRun);

    /** A start asked for before the tab finished activating waits for it. The popup can start this on a fresh tab. */
    let startWhenReady = false;
    function startVisible(): void {
      if (visible.running) return;
      if (!active || !panelEnabled || !port) { startWhenReady = true; return; }
      startWhenReady = false;
      void visible.start();
    }

    function stopVisible(): void {
      startWhenReady = false;
      if (!visible.running) return;
      visible.stop();
      for (const id of jobs.keys()) send({ type: 'CANCEL', id });
      dropJobs();
    }

    function updateTools(): void {
      const available = active && panelEnabled && !selection && !visible.running && !!port;
      overlay.setTools(available && visibleTargets().length ? [[t.translateVisible, startVisible]] : []);
    }

    function scheduleTools(): void {
      clearTimeout(toolsTimer);
      toolsTimer = setTimeout(updateTools, 250);
    }

    function receive(message: ReaderEvent): void {
      if (message.type === 'READER_STATE') {
        locale = message.uiLanguage ?? defaultUiLanguage;
        t = copy(locale);
        overlay.setLocale(locale);
        active = message.active;
        panelEnabled = message.panelMode !== false;
        debug = message.debug;
        overlay.setState(active, debug);
        registry.setPrefetch(active && panelEnabled && message.prefetch);
        document.documentElement.classList.toggle('manga-translate-mode', active && panelEnabled);
        if (!active || !panelEnabled) {
          document.documentElement.classList.remove('manga-translate-covered');
          stopVisible();
          for (const id of jobs.keys()) send({ type: 'CANCEL', id });
          dropJobs();
          restoreCapture();
          cancelManual();
          if (!chapter.announce()) overlay.announce('');
        } else {
          updateSelectionControl();
          if (!jobs.size && !chapter.announce()) readyForPanel();
          if (startWhenReady) startVisible();
        }
        return;
      }
      if (message.type === 'CHAPTER_STATUS' || message.type === 'CHAPTER_PAGE' || message.type === 'CHAPTER_PATCH') {
        chapter.receive(message);
        return;
      }
      if (message.type === 'PANEL_MAP') {
        maps.delete(message.image.id);
        maps.set(message.image.id, message.panels);
        const first = maps.keys().next().value;
        if (maps.size > 45 && first) maps.delete(first);
        if (lastPointer) hover(lastPointer);
        return;
      }
      const hit = jobs.get(message.id);
      if (!hit || !valid(hit)) { jobs.delete(message.id); endJob(message.id, 'CANCELLED'); return; }
      if (message.type === 'JOB_PROGRESS') {
        if (visible.running) return;
        overlay.announce(t[stageCopy[message.stage]],
          message.stage === 'DONE' || message.stage === 'ERROR' || message.stage === 'CANCELLED'
            ? toggleAction() : [[t.cancel, () => send({ type: 'CANCEL', id: message.id })], ...toggleAction()]);
        return;
      }
      jobs.delete(message.id);
      if (message.type === 'JOB_ERROR') {
        endJob(message.id, message.error.code);
        if (visible.running) return;
        const retry: [string, () => void][] = ['CANCELLED', 'ALREADY_TRANSLATED'].includes(message.error.code)
          ? [] : [[t.retry, () => run(hit)]];
        const imageError = ['IMAGE_PERMISSION', 'IMAGE_FETCH', 'IMAGE_UNSUPPORTED'].includes(message.error.code);
        const details = localizedError(locale, message.error.message);
        const text = hit.surfaceCrop && message.error.code === 'CAPTURE_UNAVAILABLE' ? t.surfaceCovered
          : imageError && hit.allowCapture && !hit.captureFrame ? `${details} ${t.areaMustFit}` : details;
        overlay.announce(text, [...retry, ...toggleAction()]);
        return;
      }
      const generation = translationGeneration;
      const accepted = () => generation === translationGeneration && valid(hit);
      const shown = hit.surface ? overlay.add(hit.surface, message.patch, accepted)
        : overlay.addFree(message.patch, { viewport: hit.view!, signature: hit.signature!, route: hit.route! }, accepted);
      void shown.then(added => {
        if (!added) {
          endJob(message.id, 'STALE');
          if (generation === translationGeneration && active && !visible.running) overlay.announce(t.areaChanged, toggleAction());
          return;
        }
        endJob(message.id);
        const data = message.patch.debug;
        const timing = data && Object.values(data.milliseconds ?? {}).reduce((sum, value) => sum + value, 0);
        const detail = data ? ` · ${data.backend} · ${data.inpainting?.join(', ')} · ${timing} ms` : '';
        const skipped = message.patch.skippedBubbles ?? 0;
        if (lastPointer) hover(lastPointer);
        if (visible.running) return;
        const actions = toggleAction();
        const result = skipped ? format(t.partlyTranslated, { count: skipped })
          : message.cached ? t.panelCached : t.panelTranslated;
        overlay.announce(result + detail, actions);
        updateTools();
      }).catch(() => {
        endJob(message.id, 'PATCH');
        if (generation === translationGeneration && !visible.running) overlay.announce(t.patchFailed, [[t.retry, () => run(hit)], ...toggleAction()]);
      });
    }

    function connect(): void {
      try {
        port = chrome.runtime.connect({ name: readerPort });
        port.onMessage.addListener(receive);
        port.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          port = undefined;
          restoreCapture();
          chapter.disconnect();
          const pending = [...jobs.values()].at(-1);
          stopVisible();
          dropJobs();
          if (active && pending) overlay.announce(t.processingInterrupted, [[t.retry, () => run(pending)]]);
          if (active && !ctx.isInvalid) reconnect = setTimeout(connect, 500);
        });
      } catch { /* Extension was updated or unloaded. */ }
    }

    function point(event: MouseEvent, surface: ReaderElement, fitOutside = false): Point | undefined {
      const geometry = imageGeometry(surface);
      const mapped = toNormalized({ x: event.clientX, y: event.clientY }, geometry);
      if (mapped || !fitOutside) return mapped;
      const object = geometry.object;
      return { x: clamp((event.clientX - object.x) / object.width), y: clamp((event.clientY - object.y) / object.height) };
    }

    function identify(event: MouseEvent): Hit | undefined {
      if (event.composedPath().includes(overlay.host)) return;
      const direct = registry.identify(event.composedPath());
      const beneath = direct ? undefined : visibleReaderSurface(event.clientX, event.clientY, policy);
      const surface = direct ?? (beneath && registry.identify([beneath]));
      if (!surface) return;
      const descriptor = registry.descriptor(surface);
      const normalized = point(event, surface);
      if (descriptor && normalized) return { surface, descriptor, point: normalized };
    }

    function hover(event: PointerEvent): void {
      if (!active || !panelEnabled) return;
      lastPointer = event;
      if (selection) {
        const drag = selection.drag;
        if (drag && event.pointerId === drag.pointerId) {
          const surface = drag.hit?.surface;
          const end = surface && point(event, surface, true);
          if (surface && end) overlay.highlight(surface, rectPolygon(normalizedSelection(drag.start, end)), true);
          else if (!surface) overlay.highlightArea(normalizedSelection(drag.start, viewportPoint(event.clientX, event.clientY)));
        }
        return;
      }
      const hit = identify(event);
      const choice = hit?.surface && overlay.selectionAt(hit.surface, hit.point);
      document.documentElement.classList.toggle('manga-translate-covered', choice === false);
      if (choice === false) { overlay.highlight(); return; }
      const panelMap = hit && maps.get(hit.descriptor.id);
      const panel = hit && panelMap && selectPanel(hit.point, panelMap);
      overlay.highlight(hit?.surface, choice ? rectPolygon(choice) : panel?.polygon, false, panelMap);
    }

    function click(event: MouseEvent): void {
      if (!active || !panelEnabled || !event.isTrusted || event.button !== 0 || event.composedPath().includes(overlay.host)) return;
      if (consumeClick || selection) {
        consumeClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const hit = identify(event);
      if (!hit?.surface) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const choice = overlay.selectionAt(hit.surface, hit.point);
      if (choice === false) {
        if (!chapter.announce()) overlay.announce(t.alreadyTranslated, toggleAction());
        return;
      }
      if (debug) console.debug('[Manga Translator]', { imageId: hit.descriptor.id, point: hit.point,
        natural: toNatural(hit.point, hit.descriptor.width, hit.descriptor.height) });
      run(choice ? { ...hit, manual: choice } : hit);
    }

    function down(event: PointerEvent): void {
      if (!event.isTrusted || event.button !== 0 || event.composedPath().includes(overlay.host)) return;
      consumeClick = false;
      if (!selection || selection.drag || !event.isPrimary) return;
      const hit = identify(event);
      event.preventDefault();
      event.stopImmediatePropagation();
      // A drag may begin anywhere on the visible tab. Over a reader page it is tied to that page; elsewhere it is freeform.
      const target = hit?.surface && !isCanvas(hit.surface) ? hit.surface : document.documentElement;
      try { target.setPointerCapture(event.pointerId); } catch { /* The drag still follows window events. */ }
      selection.drag = { hit, start: hit?.point ?? viewportPoint(event.clientX, event.clientY), pointerId: event.pointerId, target };
      updateSelectionControl();
    }

    function freeformHit(bounds: Rect): Hit {
      const viewport = viewportRect();
      const page = new URL(location.href);
      page.hash = '';
      const descriptor: ImageDescriptor = { id: crypto.randomUUID(), src: page.href, kind: 'viewport',
        width: Math.max(1, Math.round(viewport.width)), height: Math.max(1, Math.round(viewport.height)) };
      return { descriptor, point: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, manual: bounds, allowCapture: true,
        view: viewportSnapshot(), signature: areaSignature(viewportPixels(bounds, viewport)), route: location.href };
    }

    function up(event: PointerEvent): void {
      const drag = selection?.drag;
      if (!selection || !drag || drag.pointerId !== event.pointerId || !event.isTrusted) return;
      const { hit, start } = drag;
      const surface = hit?.surface;
      const end = surface ? point(event, surface, true) : viewportPoint(event.clientX, event.clientY);
      const bounds = end && normalizedSelection(start, end);
      event.preventDefault(); event.stopImmediatePropagation();
      interruptSelection();
      if (!bounds) return;
      if (surface && hit) {
        if (!valid(hit)) return;
        const area = toViewport(bounds, imageGeometry(surface).object);
        if (area.width < 12 || area.height < 12) { updateSelectionControl(t.selectionTooSmall); return; }
        const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        cancelManual();
        consumeClick = true;
        run({ ...hit, manual: bounds, point: center, allowCapture: true });
        return;
      }
      const area = viewportPixels(bounds);
      if (area.width < minimumArea || area.height < minimumArea) { updateSelectionControl(t.selectionTooSmall); return; }
      cancelManual();
      consumeClick = true;
      run(freeformHit(bounds));
    }

    function keydown(event: KeyboardEvent): void {
      if (!active || !event.isTrusted || event.key !== 'Escape') return;
      if (selection) { event.preventDefault(); event.stopImmediatePropagation(); cancelManual(); }
      else {
        const latest = [...jobs.keys()].at(-1);
        if (latest) send({ type: 'CANCEL', id: latest });
      }
    }

    function noDrag(event: DragEvent): void { if (active && selection) event.preventDefault(); }
    function selectionBlur(): void { interruptSelection(); }

    /**
     * The part of the visible tab to capture for this job, with the view it was measured in. A page surface must
     * be fully on screen and, when `inspectCoverage` is set, uncovered by anything opaque at nine sample points.
     */
    function imageFrame(hit: Hit, inspectCoverage = false): CaptureFrame | undefined {
      if (!valid(hit) || !hit.manual) return;
      const snapshot = viewportSnapshot();
      if (!hit.surface) return { bounds: hit.manual, viewport: snapshot };
      const geometry = imageGeometry(hit.surface);
      const bounds = visibleArea(hit.manual, geometry, viewportRect());
      if (!bounds) return;
      if (inspectCoverage) {
        const area = toViewport(hit.manual, geometry.object);
        for (const y of [0.04, 0.5, 0.96]) {
          for (const x of [0.04, 0.5, 0.96]) {
            if (visibleReaderSurface(area.x + area.width * x, area.y + area.height * y, policy) !== hit.surface) return;
          }
        }
      }
      return { bounds, viewport: snapshot };
    }

    function restoreCapture(id?: string): void {
      if (id && id !== capturing) return;
      clearTimeout(captureTimer);
      capturing = undefined;
      delete overlay.host.dataset.capturing;
    }

    async function prepareCapture(id: string): Promise<CaptureFrame | undefined> {
      const hit = jobs.get(id);
      if (!hit?.captureFrame || capturing || !sameCaptureFrame(hit.captureFrame, imageFrame(hit))) return;
      capturing = id;
      overlay.host.dataset.capturing = '';
      captureTimer = setTimeout(() => restoreCapture(id), 3500);
      await new Promise<void>(resolve => {
        const limit = setTimeout(resolve, 240);
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(limit); resolve(); }));
      });
      const frame = capturing === id ? imageFrame(hit, true) : undefined;
      if (sameCaptureFrame(hit.captureFrame, frame)) return frame;
      restoreCapture(id);
    }

    type Probe = ReaderProbe | CaptureProbe | ChapterSourceProbe | ClearProbe | ImageProbe | VisiblePagesProbe;
    const probe = (message: Probe, sender: chrome.runtime.MessageSender, reply: (answer?: unknown) => void) => {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js')) return;
      if (message?.type === 'READER_PROBE') {
        if (message.reconnect && !port) {
          clearTimeout(reconnect);
          connect();
        }
        reply(readerInfo());
      } else if (message?.type === 'VISIBLE_PAGES') {
        if (message.command === 'start') startVisible();
        else if (message.command === 'stop') stopVisible();
        reply(readerInfo());
      } else if (message?.type === 'CLEAR_READER_TRANSLATIONS') {
        clearTranslations();
        reply(true);
      } else if (message?.type === 'CHAPTER_SOURCE') {
        const site = chapterSite(location.href);
        if (site?.key !== message.key) return;
        const sources = [...document.images].map(img => img.currentSrc || img.src);
        const pages = site.site === 'witch' ? silentWitchPages(site,
          [...document.scripts].filter(script => !script.src).map(script => script.textContent ?? ''))
          : site.site === 'generic' ? selectGenericPages(collectCandidates(document, policy), location.origin) : undefined;
        reply({ sources: pages?.map(page => page.src), dataSaver: sources.some(src => src.includes('/data-saver/')) });
      } else if (message?.type === 'IMAGE_PROBE' && typeof message.id === 'string') {
        const hit = jobs.get(message.id);
        const surface = hit?.surface;
        if (!hit || !surface || !valid(hit)) { reply(); return; }
        void (isCanvas(surface) ? readCanvas(surface, hit.descriptor) : readRenderedImage(surface, hit.descriptor)).then(reply, () => reply());
        return true;
      } else if (message?.type === 'CAPTURE_PROBE' && typeof message.id === 'string') {
        if (message.phase === 'restore') {
          restoreCapture(message.id);
          reply();
        } else if (message.phase === 'validate') {
          const hit = jobs.get(message.id);
          reply(hit && capturing === message.id ? imageFrame(hit, true) : undefined);
        } else if (message.phase === 'prepare') {
          void prepareCapture(message.id).then(reply, () => { restoreCapture(message.id); reply(); });
          return true;
        }
      }
    };
    // A single-page reader can swap the episode with history.pushState and keep every element. The address is part of
    // a canvas's identity, so surfaces are checked again whenever it changes.
    let route = location.pathname + location.search;
    const routeTimer = setInterval(() => {
      const now = location.pathname + location.search;
      if (now === route) return;
      route = now;
      for (const surface of registry.list()) registry.descriptor(surface);
    }, 400);
    chrome.runtime.onMessage.addListener(probe);
    connect();
    window.addEventListener('pointermove', hover, { capture: true, passive: true });
    window.addEventListener('click', click, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', interruptSelection, true);
    window.addEventListener('lostpointercapture', interruptSelection, true);
    window.addEventListener('blur', selectionBlur);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('dragstart', noDrag, true);
    window.addEventListener('scroll', scheduleTools, { capture: true, passive: true });
    window.addEventListener('resize', scheduleTools);
    ctx.onInvalidated(() => {
      clearTimeout(reconnect);
      clearTimeout(toolsTimer);
      clearInterval(routeTimer);
      chrome.runtime.onMessage.removeListener(probe);
      restoreCapture();
      stopVisible();
      port?.disconnect();
      registry.destroy();
      overlay.destroy();
      document.documentElement.classList.remove('manga-translate-mode', 'manga-translate-covered', 'manga-translate-selecting');
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== cursor);
      window.removeEventListener('pointermove', hover, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', interruptSelection, true);
      window.removeEventListener('lostpointercapture', interruptSelection, true);
      window.removeEventListener('blur', selectionBlur);
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('dragstart', noDrag, true);
      window.removeEventListener('scroll', scheduleTools, true);
      window.removeEventListener('resize', scheduleTools);
      world.mangaTranslatorLoaded = false;
    });
  },
});
