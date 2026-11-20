import { copy, defaultUiLanguage, type UiLanguage } from '../i18n/messages';
import { pointInPolygon } from '../core/image/geometry';
import { cropRegions, paintedRegions, translatedPolygons, unfinishedRegion } from '../core/image/translatedCoverage';
import { rasterBlob } from '../core/image/rasterDataUrl';
import { imageGeometry, toViewport } from '../core/image/CoordinateMapper';
import type { ReaderElement } from '../core/surface/ReaderSurface';
import { areaSignature, sameViewport, viewportPixels, viewportRect, viewportSnapshot, type ViewportSnapshot } from '../core/surface/viewport';
import type { PanelRegion, Point, Rect, RenderedPatch } from '../types/contracts';

interface PatchLayer { coverage: Point[][]; pixels: HTMLCanvasElement; debug?: HTMLCanvasElement; patch: RenderedPatch }
interface ImageLayer { clip: HTMLDivElement; patches: Map<string, PatchLayer> }
/** A result tied to what was on screen when it was read, not to a page surface. It lives only while that view holds. */
interface FreeLayer { pixels: HTMLCanvasElement; patch: RenderedPatch; snapshot: ViewportSnapshot; area: Rect; signature: string; route: string }
/** `route` is the page address the area was read on. A single-page reader can swap pages without navigating the window, so it is checked too. */
export interface FreeAnchor { viewport: ViewportSnapshot; signature: string; route: string }
type Action = [string, () => void];
const style = `
  :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
    color: #171913; font: 14px/1.45 system-ui, sans-serif; color-scheme: light; }
  :host([hidden]) { display: none; }
  :host([data-capturing]) { visibility: hidden !important; }
  .clip { position: absolute; overflow: hidden; pointer-events: none; }
  .patch, .diagnostic { position: absolute; display: block; pointer-events: none; }
  .outline { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .notice { position: absolute; bottom: 18px; right: 18px; width: min(320px, calc(100vw - 36px));
    box-sizing: border-box; padding: 11px 13px; border: 1px solid #b9bbb3; border-radius: 6px;
    background: #f8f9f3; pointer-events: auto; }
  .notice[hidden], [hidden] { display: none !important; }
  .status { margin: 0; font-weight: 560; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .actions:empty { display: none; }
  button { appearance: none; background: #fff; border: 1px solid #9a9d93; color: #191c14; border-radius: 4px;
    min-height: 34px; padding: 5px 9px; font: 600 12px/1.4 system-ui, sans-serif; cursor: pointer; }
  button:hover { background: #e8ebdf; }
  button:focus-visible { outline: 2px solid #376f46; outline-offset: 2px; }
`;

function position(element: HTMLElement, rect: Rect): void {
  Object.assign(element.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
}

function decode(url: string): Promise<ImageBitmap> {
  return createImageBitmap(rasterBlob(url));
}

export class ReaderOverlay {
  readonly host = document.createElement('manga-translator-layer');
  private readonly shadow = this.host.attachShadow({ mode: 'open' });
  private readonly base = document.createElement('div');
  private readonly outline = document.createElement('canvas');
  private readonly notice = document.createElement('aside');
  private readonly status = document.createElement('p');
  private readonly actions = document.createElement('div');
  private readonly images = new Map<ReaderElement, ImageLayer>();
  private readonly free = new Set<FreeLayer>();
  private freeTimer?: ReturnType<typeof setInterval>;
  /** Called after freeform results were removed because the view they were read from changed. */
  onFreeInvalidated?: () => void;
  private readonly resize = new ResizeObserver(() => this.schedule());
  private readonly buttons = new Map<string, { button: HTMLButtonElement; action: () => void }>();
  private announcement: { status: string; actions: Action[] } = { status: '', actions: [] };
  private selection?: { action: Action; hint?: string };
  private tools: Action[] = [];
  private locale = defaultUiLanguage;
  private active = false;
  private shown = true;
  private debug = false;
  private frame = 0;
  private current?: { image?: ReaderElement; area?: Rect; panel: Point[]; manual: boolean; map?: PanelRegion[] };

  constructor() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(style);
    this.shadow.adoptedStyleSheets = [sheet];
    this.status.className = 'status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.actions.className = 'actions';
    this.notice.className = 'notice';
    this.notice.hidden = true;
    this.notice.append(this.status, this.actions);
    this.outline.className = 'outline';
    this.outline.setAttribute('aria-hidden', 'true');
    this.shadow.append(this.base, this.outline, this.notice);
    document.documentElement.append(this.host);
    addEventListener('scroll', this.schedule, { capture: true, passive: true });
    addEventListener('resize', this.schedule);
    visualViewport?.addEventListener('resize', this.schedule);
  }

  get hasPatches(): boolean { return this.images.size > 0 || this.free.size > 0; }
  get isShowing(): boolean { return this.shown; }
  hasPatch(image: ReaderElement, id: string): boolean {
    return [...(this.images.get(image)?.patches.values() ?? [])].some(layer => layer.patch.panel.id === id);
  }

  protectedRegions(image: ReaderElement): Rect[] {
    return [...(this.images.get(image)?.patches.values() ?? [])].flatMap(layer => paintedRegions(layer.patch));
  }

  covers(image: ReaderElement, point: Point): boolean {
    const layer = this.images.get(image);
    if (!layer) return false;
    for (const patch of layer.patches.values()) {
      if (patch.coverage.some(polygon => pointInPolygon(point, polygon))) return true;
    }
    return false;
  }

  selectionAt(image: ReaderElement, point: Point): Rect | false | undefined {
    if (this.covers(image, point)) return false;
    const layer = this.images.get(image);
    return layer && unfinishedRegion([...layer.patches.values()].map(item => item.patch), point);
  }

  clear(): void {
    for (const image of this.images.keys()) this.remove(image);
    this.dropFree();
    this.shown = true;
    this.base.hidden = false;
    this.highlight();
  }

  setLocale(locale: UiLanguage): void {
    if (this.host.lang === locale) return;
    this.locale = locale;
    this.host.lang = locale;
    for (const layer of this.images.values()) {
      for (const patch of layer.patches.values()) patch.pixels.setAttribute('aria-label', copy(locale).translatedPanel);
    }
  }

  setState(active: boolean, debug: boolean): void {
    this.active = active;
    this.debug = debug;
    this.host.hidden = !active;
    for (const layer of this.images.values()) {
      for (const patch of layer.patches.values()) if (patch.debug) patch.debug.hidden = !debug;
    }
    if (active) this.schedule();
  }

  toggle(): void {
    this.shown = !this.shown;
    this.base.hidden = !this.shown;
  }

  show(): void {
    this.shown = true;
    this.base.hidden = false;
  }

  announce(status: string, actions: Action[] = []): void {
    this.announcement = { status, actions };
    this.updateNotice();
  }

  setSelectionControl(action?: Action, hint?: string): void {
    this.selection = action && { action, hint };
    this.updateNotice();
  }

  /** Standing actions shown beside the status, such as translating the visible pages. Hidden while selecting. */
  setTools(actions: Action[]): void {
    if (actions.length === this.tools.length && actions.every(([label], index) => label === this.tools[index][0])) {
      this.tools = actions;
      return;
    }
    this.tools = actions;
    this.updateNotice();
  }

  private updateNotice(): void {
    let { status, actions } = this.announcement;
    if (this.selection?.hint) {
      status = this.selection.hint;
      actions = [this.selection.action];
    } else if (this.selection && !actions.some(([label]) => label === this.selection?.action[0])) {
      actions = [this.selection.action, ...actions];
    }
    if (!this.selection?.hint) actions = [...actions, ...this.tools.filter(([label]) => !actions.some(([name]) => name === label))];
    if (this.status.textContent !== status) this.status.textContent = status;
    this.notice.hidden = !status;
    const focused = this.shadow.activeElement;
    const focusedIndex = [...this.actions.children].findIndex(button => button === focused);
    for (const [label, { button }] of this.buttons) {
      if (!actions.some(([name]) => name === label)) {
        button.remove();
        this.buttons.delete(label);
      }
    }
    for (const [index, [label, action]] of actions.entries()) {
      let entry = this.buttons.get(label);
      if (!entry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        const control = { button, action };
        button.addEventListener('click', event => { if (event.isTrusted) control.action(); });
        this.buttons.set(label, control);
        entry = control;
      }
      entry.action = action;
      const current = this.actions.children[index] ?? null;
      if (current !== entry.button) this.actions.insertBefore(entry.button, current);
    }
    if (focusedIndex >= 0 && this.shadow.activeElement !== focused) {
      const replacement = focused?.parentElement === this.actions ? focused :
        this.actions.children[Math.min(focusedIndex, this.actions.children.length - 1)];
      if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
    }
  }

  highlight(image?: ReaderElement, panel?: Point[], manual = false, map?: PanelRegion[]): void {
    if (this.current?.image === image && this.current?.panel === panel && this.current?.map === map && this.current?.manual === manual &&
        !this.current?.area) return;
    this.current = image && panel ? { image, panel, manual, map } : undefined;
    this.schedule();
  }

  /** Outline a freeform area of the viewport while the user drags it. `bounds` is normalized to the visual viewport. */
  highlightArea(bounds?: Rect): void {
    this.current = bounds ? { area: bounds, panel: [], manual: true } : undefined;
    this.schedule();
  }

  /**
   * Shows a result for a freeform area. It stays only while the viewport, the scroll position and what lies under
   * the area are as they were when the area was read, and goes away the moment any of them changes.
   */
  async addFree(patch: RenderedPatch, anchor: FreeAnchor, valid: () => boolean): Promise<boolean> {
    const bitmap = await decode(patch.dataUrl);
    try {
      if (!valid()) return false;
      const pixels = document.createElement('canvas');
      pixels.className = 'patch';
      pixels.dataset.panel = patch.panel.id;
      pixels.dataset.anchor = 'viewport';
      pixels.setAttribute('aria-label', copy(this.locale).translatedPanel);
      pixels.width = bitmap.width;
      pixels.height = bitmap.height;
      const context = pixels.getContext('2d');
      if (!context) return false;
      context.drawImage(bitmap, 0, 0);
      const [x, y, width, height] = anchor.viewport;
      const area = viewportPixels(patch.panel.bounds, { x, y, width, height });
      const layer: FreeLayer = { pixels, patch, snapshot: anchor.viewport, area, signature: anchor.signature, route: anchor.route };
      position(pixels, area);
      this.free.add(layer);
      this.base.append(pixels);
      this.freeTimer ??= setInterval(() => this.checkFree(), 250);
      return true;
    } finally { bitmap.close(); }
  }

  private removeFree(layer: FreeLayer): void {
    layer.pixels.remove();
    this.free.delete(layer);
    if (!this.free.size && this.freeTimer) { clearInterval(this.freeTimer); this.freeTimer = undefined; }
  }

  private dropFree(): void {
    for (const layer of [...this.free]) this.removeFree(layer);
  }

  /** Remove every freeform result whose view has changed. Returns true when anything was removed. */
  private checkFree(): boolean {
    if (!this.free.size) return false;
    const now = viewportSnapshot();
    let removed = false;
    for (const layer of [...this.free]) {
      if (layer.route === location.href && sameViewport(layer.snapshot, now) && areaSignature(layer.area) === layer.signature) continue;
      this.removeFree(layer);
      removed = true;
    }
    if (removed) this.onFreeInvalidated?.();
    return removed;
  }

  async add(image: ReaderElement, patch: RenderedPatch, valid: () => boolean): Promise<boolean> {
    const bitmap = await decode(patch.dataUrl);
    try {
      if (!valid()) return false;
      const pixels = document.createElement('canvas');
      pixels.className = 'patch';
      pixels.dataset.panel = patch.panel.id;
      pixels.setAttribute('aria-label', copy(this.locale).translatedPanel);
      pixels.width = bitmap.width;
      pixels.height = bitmap.height;
      const context = pixels.getContext('2d');
      if (!context) return false;
      context.drawImage(bitmap, 0, 0);
      const diagnostic = patch.debug && await this.diagnostic(patch);
      if (!valid()) return false;
      let layer = this.images.get(image);
      if (!layer) {
        const clip = document.createElement('div');
        clip.className = 'clip';
        clip.style.visibility = 'hidden';
        layer = { clip, patches: new Map() };
        this.images.set(image, layer);
        this.base.append(clip);
        this.resize.observe(image);
      }
      const protectedRegions = cropRegions(this.protectedRegions(image), patch.panel.bounds);
      if (protectedRegions.length) {
        // A job can finish after a different patch arrived. Retain the pixels already shown.
        context.globalCompositeOperation = 'destination-out';
        context.fillStyle = '#fff';
        for (const rect of protectedRegions) context.fillRect(rect.x * pixels.width, rect.y * pixels.height,
          rect.width * pixels.width, rect.height * pixels.height);
        context.globalCompositeOperation = 'source-over';
      }
      // Layers stay invisible until `place` has put them at their coordinates, so no frame shows one at the origin.
      pixels.style.visibility = 'hidden';
      if (diagnostic) diagnostic.style.visibility = 'hidden';
      layer.patches.set(crypto.randomUUID(), { coverage: translatedPolygons(patch), pixels, debug: diagnostic, patch });
      layer.clip.append(pixels);
      if (diagnostic) layer.clip.append(diagnostic);
      this.enforceBudget();
      if (image.isConnected && this.images.get(image) === layer) this.place(image, layer);
      this.schedule();
      return true;
    } finally { bitmap.close(); }
  }

  private async diagnostic(patch: RenderedPatch): Promise<HTMLCanvasElement | undefined> {
    const debug = patch.debug;
    if (!debug) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'diagnostic';
    canvas.hidden = !this.debug;
    canvas.width = patch.width;
    canvas.height = patch.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    if (debug.mask) {
      const mask = await decode(debug.mask).catch(() => undefined);
      if (mask) { context.drawImage(mask, 0, 0, canvas.width, canvas.height); mask.close(); }
    }
    context.lineWidth = Math.max(2, canvas.width / 400);
    context.strokeStyle = '#1fb5cb';
    for (const { bounds } of debug.text) context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.strokeStyle = '#4cc443';
    for (const { bounds } of debug.bubbles) context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.fillStyle = '#111';
    context.font = `bold ${Math.max(14, canvas.width / 42)}px system-ui`;
    for (const [i, { bounds, confidence }] of debug.ordered.entries()) {
      const label = `${i + 1} · ${Math.round(confidence * 100)}%`;
      const y = Math.max(20, bounds.y);
      context.fillStyle = '#fff';
      const width = context.measureText(label).width;
      context.fillRect(bounds.x, y - 20, width + 6, 21);
      context.fillStyle = '#111';
      context.fillText(label, bounds.x + 3, y - 3);
    }
    return canvas;
  }

  private enforceBudget(): void {
    let total = [...this.images.values()].reduce((count, layer) => count + layer.patches.size, 0);
    for (const [image, layer] of this.images) {
      for (const [id, patch] of layer.patches) {
        if (total <= 32) return;
        patch.pixels.remove();
        patch.debug?.remove();
        layer.patches.delete(id);
        total--;
      }
      if (!layer.patches.size) this.remove(image);
    }
  }

  remove(image: ReaderElement): void {
    this.images.get(image)?.clip.remove();
    this.images.delete(image);
    this.resize.unobserve(image);
  }

  private readonly schedule = () => {
    if (!this.frame && this.active) this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.layout();
    });
  };

  /** Put a surface's layers at the surface's current coordinates, then let them show. */
  private place(image: ReaderElement, layer: ImageLayer): void {
    const { object, clip } = imageGeometry(image);
    position(layer.clip, clip);
    for (const { pixels, debug, patch } of layer.patches.values()) {
      const fit = toViewport(patch.panel.bounds, object);
      fit.x -= clip.x;
      fit.y -= clip.y;
      position(pixels, fit);
      pixels.style.visibility = '';
      if (debug) { position(debug, fit); debug.style.visibility = ''; }
    }
    layer.clip.style.visibility = '';
  }

  private layout(): void {
    this.checkFree();
    for (const [image, layer] of this.images) {
      if (!image.isConnected) { this.remove(image); continue; }
      this.place(image, layer);
    }
    const context = this.outline.getContext('2d');
    if (!context) return;
    const scale = Math.min(2, devicePixelRatio);
    const width = Math.round(innerWidth * scale), height = Math.round(innerHeight * scale);
    if (this.outline.width !== width || this.outline.height !== height) {
      this.outline.width = width;
      this.outline.height = height;
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, innerWidth, innerHeight);
    if (this.current?.area) {
      const box = viewportPixels(this.current.area, viewportRect());
      context.fillStyle = 'rgba(68, 130, 83, .11)';
      context.fillRect(box.x, box.y, box.width, box.height);
      context.strokeStyle = '#ffe07a';
      context.lineWidth = 2;
      context.strokeRect(box.x, box.y, box.width, box.height);
      return;
    }
    if (!this.current?.image || !this.current.image.isConnected) return;
    const { object, clip } = imageGeometry(this.current.image);
    context.save();
    context.beginPath();
    context.rect(clip.x, clip.y, clip.width, clip.height);
    context.clip();
    const trace = (polygon: Point[]) => {
      context.beginPath();
      polygon.forEach((point, index) => {
        const x = object.x + point.x * object.width, y = object.y + point.y * object.height;
        if (index) context.lineTo(x, y); else context.moveTo(x, y);
      });
      context.closePath();
    };
    const draw = (polygon: Point[], color: string, width: number, fill = false) => {
      trace(polygon);
      context.strokeStyle = color;
      context.lineWidth = width;
      context.stroke();
      if (fill) { context.fillStyle = 'rgba(68, 130, 83, .11)'; context.fill(); }
    };
    if (this.debug) for (const panel of this.current.map ?? []) draw(panel.polygon, '#16a2a1', 1);
    draw(this.current.panel, this.current.manual ? '#ffe07a' : '#59b470', 2, true);
    const translated = this.images.get(this.current.image);
    if (translated && !this.current.manual) {
      context.globalCompositeOperation = 'destination-out';
      context.fillStyle = '#fff';
      for (const patch of translated.patches.values()) {
        for (const polygon of patch.coverage) {
          trace(polygon);
          context.fill();
        }
      }
    }
    context.restore();
  }

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.dropFree();
    removeEventListener('scroll', this.schedule, true);
    removeEventListener('resize', this.schedule);
    visualViewport?.removeEventListener('resize', this.schedule);
    this.host.remove();
  }
}
