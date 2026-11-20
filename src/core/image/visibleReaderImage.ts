import { chapterSite } from '../chapter/readerSites';
import { isTransparent, type ReaderElement } from '../surface/ReaderSurface';
import type { SurfacePolicy } from '../surface/SurfacePolicy';

function isViewportLink(element: Element | null): boolean {
  if (!(element instanceof HTMLAnchorElement) || element.childElementCount || element.textContent?.trim() ||
      element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby') || element.hasAttribute('title')) return false;
  const bounds = element.getBoundingClientRect();
  if (bounds.left > 1 || bounds.top > 1 || bounds.right < document.documentElement.clientWidth - 1 ||
      bounds.bottom < document.documentElement.clientHeight - 1) return false;
  return getComputedStyle(element).position === 'fixed' && isTransparent(element);
}

/** The paginated MangaDex reader places empty navigation hit zones over the current image. */
function emptyHitZone(element: Element): boolean {
  if (!element.matches('a, button, div') || element.childElementCount || element.textContent?.trim()
    || element.closest('nav, aside, header, dialog, [role="dialog"]') || !isTransparent(element)) return false;
  const { position } = getComputedStyle(element);
  return position === 'absolute' || position === 'fixed';
}

/**
 * The reader surface a pointer is over, looking through controls that only turn pages. A scoped adapter names its
 * own page-turn zones. A full-viewport transparent link and the MangaDex hit zones stay as before. Anything else
 * above a surface, such as an ad, a dialog or a menu, hides it.
 */
export function visibleReaderSurface(x: number, y: number, policy: SurfacePolicy): ReaderElement | undefined {
  const stack = document.elementsFromPoint(x, y);
  const [top] = stack;
  if (!top) return;
  const direct = policy.match(top);
  if (direct) return direct;
  if (isViewportLink(top)) {
    const beneath = stack[1];
    return beneath && policy.match(beneath);
  }
  const dex = chapterSite(location.href)?.site === 'dex';
  for (const element of stack) {
    const surface = policy.match(element);
    if (surface) {
      if (dex && surface instanceof HTMLImageElement && (surface.naturalWidth < 250 || surface.naturalHeight < 250)) return;
      return surface;
    }
    if (policy.passThrough(element)) continue;
    if (dex && emptyHitZone(element)) continue;
    return;
  }
}
