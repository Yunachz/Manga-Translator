import type { AncestorFacts, ContainerFacts } from './admission';

/** A rendered page the reader shows: an image, or a canvas that a page script paints. */
export type ReaderElement = HTMLImageElement | HTMLCanvasElement;

export function isCanvas(element: Element): element is HTMLCanvasElement {
  return (element as { tagName?: string }).tagName === 'CANVAS';
}

/** Size of the raster a surface draws from: natural size for an image, bitmap size for a canvas. */
export function intrinsicSize(element: ReaderElement): { width: number; height: number } {
  return isCanvas(element) ? { width: element.width, height: element.height }
    : { width: element.naturalWidth, height: element.naturalHeight };
}

const ancestorLimit = 12;

/** Nearest ancestors first, starting with the element itself. */
export function ancestryOf(element: Element): AncestorFacts[] {
  const chain: AncestorFacts[] = [];
  for (let node: Element | null = element; node && chain.length < ancestorLimit; node = node.parentElement) {
    chain.push({ tag: node.tagName, classes: [...node.classList], id: node.id || undefined,
      role: node.getAttribute('role') ?? undefined,
      hidden: node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert') });
  }
  return chain;
}

/** Display state a user can see: not `display: none`, hidden by visibility, or transparent. */
export function shown(element: Element): boolean {
  const check = (element as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility;
  if (check) return check.call(element, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
}

/** A box that draws nothing: no background, border, shadow, filter or generated content. */
export function isTransparent(element: Element): boolean {
  const style = getComputedStyle(element);
  if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none' ||
      style.boxShadow !== 'none' || style.filter !== 'none' || style.backdropFilter !== 'none' ||
      [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
        .some(width => parseFloat(width) > 0)) return false;
  return ['::before', '::after'].every(pseudo => {
    const content = getComputedStyle(element, pseudo).content;
    return content === 'none' || content === 'normal';
  });
}

/** An empty, invisible control that only turns pages. It never covers real content. */
export function emptyTransparentControl(element: Element): boolean {
  if (element.childElementCount || element.textContent?.trim() || element.hasAttribute('aria-label') ||
      element.hasAttribute('aria-labelledby') || element.hasAttribute('title')) return false;
  const { position } = getComputedStyle(element);
  return (position === 'absolute' || position === 'fixed') && isTransparent(element);
}

const containerNames = '[class*="reader" i], [class*="viewer" i], [class*="chapter" i], [id*="reader" i], [id*="viewer" i], [id*="chapter" i]';
const containerIdentities = new WeakMap<Element, number>();
let nextContainer = 1;
function containerKey(element: Element): string {
  let value = containerIdentities.get(element);
  if (value === undefined) { value = nextContainer++; containerIdentities.set(element, value); }
  return `c${value}`;
}

/**
 * The likely reader container of a surface. The outermost ancestor whose class or id says reader, viewer or chapter
 * (so pages wrapped in per-page `viewer-page` boxes still share one), else the nearest `main`, `article` or
 * `role=main`, else the whole document.
 */
export function containerOf(element: Element): ContainerFacts {
  let named: Element | undefined;
  for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (node.matches(containerNames)) named = node;
  }
  if (named) return { key: containerKey(named), reader: true };
  const semantic = element.closest('main, article, [role="main"]');
  return semantic ? { key: containerKey(semantic), reader: false } : { key: 'document', reader: false };
}
