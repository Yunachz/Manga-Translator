import type { ImageDescriptor } from '../../types/contracts';
import { chapterSite } from '../chapter/readerSites';
import { intrinsicSize, isCanvas, type ReaderElement } from './ReaderSurface';

/**
 * Where reader pages come from. Adapters are tried in order: a scoped adapter that knows a reader's own DOM
 * goes before the generic `<img>` adapter, so a known container decides what counts as a page.
 */
export interface SurfaceAdapter {
  readonly name: string;
  /** Selector for elements this adapter reports, for scans and pointer styling. */
  readonly selector: string;
  /** Selector for the elements a pointer lands on over a page, which carry the crosshair cursor. */
  readonly cursor: string;
  /** Attributes whose change can mount, replace or resize a surface. */
  readonly attributes: readonly string[];
  /** True when the adapter's container bounds which surfaces of the document are pages. */
  readonly scoped: boolean;
  /** The container of this adapter's pages on the current document, if any. */
  scope(): Element | undefined;
  surfaces(root: Element): ReaderElement[];
  /** The surface a pointer target stands for. A page slot stands for the canvas it holds. */
  match(element: Element): ReaderElement | undefined;
  /** The stable slot of a surface: the page position in the reader, independent of which canvas is mounted. */
  slot(surface: ReaderElement): { element: Element; index: number } | undefined;
  /** An empty page-turn control that sits above pages and lets pointers through to them. */
  passThrough(element: Element): boolean;
  describe(surface: ReaderElement, id: string): ImageDescriptor | undefined;
}

export const imgAdapter: SurfaceAdapter = {
  name: 'img',
  selector: 'img, picture',
  cursor: 'img, picture',
  attributes: ['src', 'srcset', 'sizes', 'media'],
  scoped: false,
  scope: () => undefined,
  surfaces(root) {
    const found: ReaderElement[] = root instanceof HTMLImageElement ? [root] : [];
    return [...found, ...root.querySelectorAll('img')];
  },
  match(element) {
    if (element instanceof HTMLImageElement) return element;
    return element instanceof HTMLPictureElement ? element.querySelector('img') ?? undefined : undefined;
  },
  slot: () => undefined,
  passThrough: () => false,
  describe(surface, id) {
    if (isCanvas(surface)) return;
    const src = surface.currentSrc || surface.src;
    const supported = /^https?:\/\//i.test(src) || (src.startsWith('blob:https://') && chapterSite(location.href)?.site === 'dex');
    if (!supported || !surface.complete || surface.naturalWidth < 96 || surface.naturalHeight < 88 ||
        surface.naturalWidth * surface.naturalHeight > 44_000_000) return;
    return { id, src, width: surface.naturalWidth, height: surface.naturalHeight };
  },
};

/** Selector of the page canvases of the shared canvas viewer. Also used to recognise such a reader before the extension is active. */
export const scopedCanvasSelector = '.js-viewer-content .js-page-area canvas.page-image.js-page-image';

const comic = {
  root: '.js-viewer-content',
  slot: '.js-page-area',
  canvas: 'canvas.page-image.js-page-image',
  navigation: '.js-slide-forward, .js-slide-backward',
};

/**
 * The viewer container, but only when the markup that makes it a reader is present: page slots, at least one of
 * which holds a page canvas or an ad marker, or several slots. A lone `.js-viewer-content` class proves nothing.
 */
function comicRoot(): Element | undefined {
  const root = document.querySelector(comic.root);
  if (!root) return;
  const slots = root.querySelectorAll(comic.slot);
  const evidence = !!root.querySelector(`${comic.slot} ${comic.canvas}`) || !!root.querySelector(`${comic.slot} .js-page-ad`) || slots.length >= 2;
  return evidence ? root : undefined;
}

/** Elements a page-turn zone may hold besides its arrow. Anything else makes it a real control, such as a menu or an ad link. */
const interactive = 'a, button, img, input, select, textarea, video, canvas, iframe, form, label, [role="button"], [tabindex]';

/**
 * A page-turn zone: absolutely placed, with no background of its own, no words beyond an arrow glyph, and at
 * most an icon inside (a span, an SVG with its paths, or a background image). It covers the page without
 * showing anything of its own, so a pointer over it means the page beneath.
 */
function arrowOnly(control: Element): boolean {
  if (control.querySelector(interactive) || control.querySelectorAll('*').length > 8) return false;
  const style = getComputedStyle(control);
  return (style.position === 'absolute' || style.position === 'fixed') && style.backgroundColor === 'rgba(0, 0, 0, 0)' &&
    (control.textContent?.trim() ?? '').length <= 2;
}

function comicSlot(canvas: HTMLCanvasElement): Element | undefined {
  const root = comicRoot();
  const slot = canvas.closest(comic.slot);
  return root && slot && root.contains(slot) ? slot : undefined;
}

/**
 * Canvas readers built on the shared "gigaviewer" markup (Comic Action and its siblings): a `.js-viewer-content`
 * container holds one `.js-page-area` slot per page, and a mounted slot holds `canvas.page-image`. Ad and
 * back-matter slots hold no page canvas. Canvases are virtualised, so the slot position is the page identity.
 */
export const comicCanvasAdapter: SurfaceAdapter = {
  name: 'comic-canvas',
  selector: `${comic.root} ${comic.canvas}`,
  // The canvas ignores the pointer, so the page slot and the page-turn zones above it receive it.
  cursor: `${comic.root} ${comic.slot}:has(${comic.canvas}), ${comic.navigation}`,
  attributes: ['width', 'height', 'class'],
  scoped: true,
  scope: comicRoot,
  surfaces(root) {
    const scope = comicRoot();
    if (!scope) return [];
    const inside = root.contains(scope) || scope.contains(root);
    return inside ? [...scope.querySelectorAll<HTMLCanvasElement>(comic.canvas)] : [];
  },
  match(element) {
    const scope = comicRoot();
    if (!scope || !scope.contains(element)) return;
    const canvas = element instanceof HTMLCanvasElement ? element : element.matches(comic.slot)
      ? element.querySelector<HTMLCanvasElement>(comic.canvas) : undefined;
    return canvas?.matches(comic.canvas) && comicSlot(canvas) ? canvas : undefined;
  },
  slot(surface) {
    if (!isCanvas(surface)) return;
    const element = comicSlot(surface);
    const root = comicRoot();
    if (!element || !root) return;
    return { element, index: [...root.querySelectorAll(comic.slot)].indexOf(element) };
  },
  passThrough(element) {
    // The arrow icon inside a page-turn zone is part of the zone: the pointer is over the page beneath both.
    const control = element.closest(comic.navigation);
    if (!control || !comicRoot() || !control.closest('.viewer, .js-viewer')) return false;
    return arrowOnly(control);
  },
  describe(surface, id) {
    if (!isCanvas(surface) || !surface.isConnected) return;
    const { width, height } = intrinsicSize(surface);
    if (width < 96 || height < 88 || width * height > 44_000_000) return;
    const page = new URL(location.href);
    page.hash = '';
    return { id, src: page.href, width, height, kind: 'canvas' };
  },
};

/** Scoped adapters first, so a known reader container decides before the generic image rule is consulted. */
export const defaultAdapters: readonly SurfaceAdapter[] = [comicCanvasAdapter, imgAdapter];
