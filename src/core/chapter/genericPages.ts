import { admitSurface, strongestCohort, type AncestorFacts, type CohortMember, type ContainerFacts, type SurfaceFacts } from '../surface/admission';
import { ancestryOf, containerOf, shown as shownElement } from '../surface/ReaderSurface';
import type { SurfacePolicy } from '../surface/SurfacePolicy';
import { chapterPageLimit, type ChapterPage } from './readerSites';

/**
 * Page discovery for readers without a known page list. It only looks at images the browser has already
 * loaded and the reader shows. It never scrolls, never requests anything and never guesses URLs, so the
 * result is the mounted part of the chapter. Site-specific lists (Silent Witch, MangaDex) stay exact.
 * Which images are pages is decided by the shared surface admission, so the chapter list, the panel click and
 * the read-ahead agree: explicit ads, covers and navigation never count, and a page needs company. The strongest
 * group of repeated, aligned images is the chapter. A lone image with no reader evidence is not.
 */
export interface PageCandidate {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  /** Rendered size in CSS pixels. */
  width: number;
  height: number;
  complete: boolean;
  visible: boolean;
  /** Inside navigation, header, footer, sidebar, dialog or hidden markup. */
  chrome: boolean;
  /** Centre of the rendered box in document coordinates, to line pages up. Missing counts as aligned. */
  centre?: { x: number; y: number };
  /** Nearest ancestors first, for explicit ad, cover and dialog markup. */
  ancestry?: readonly AncestorFacts[];
  /** The page has a scoped reader container and this image is outside it. */
  outsideRoot?: boolean;
  /** The likely reader container. Pages of one chapter share it. */
  container?: ContainerFacts;
}

const chromeSelector = 'nav, header, footer, aside, dialog, [hidden], [aria-hidden="true"], [inert], ' +
  '[role="banner"], [role="navigation"], [role="complementary"], [role="contentinfo"], [role="dialog"], [role="alertdialog"]';

function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1).map(Number);
  if (!octets) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** A page image URL that the extension may fetch for this reader. Cross-origin private hosts never qualify. */
export function genericSource(src: unknown, origin: string): string | undefined {
  if (typeof src !== 'string' || src.length > 4096) return;
  let url: URL, page: URL;
  try { url = new URL(src); page = new URL(origin); } catch { return; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return;
  if (page.protocol === 'https:' && url.protocol !== 'https:') return;
  if (url.origin !== page.origin && privateHost(url.hostname)) return;
  url.hash = '';
  return url.href;
}

function factsOf(item: PageCandidate): SurfaceFacts {
  return { kind: 'img', natural: { width: item.naturalWidth, height: item.naturalHeight }, rendered: { width: item.width, height: item.height },
    centre: item.centre, complete: item.complete, visible: item.visible, ancestry: item.ancestry ?? [], outsideRoot: item.outsideRoot, container: item.container };
}

export function selectGenericPages(candidates: readonly PageCandidate[], origin: string): ChapterPage[] {
  const seen = new Set<string>();
  const loaded: { src: string; member: CohortMember }[] = [];
  for (const item of candidates) {
    const src = genericSource(item.src, origin);
    if (!src || seen.has(src) || item.chrome) continue;
    const facts = factsOf(item);
    if (!admitSurface(facts, 'automatic').ok) continue;
    seen.add(src);
    loaded.push({ src, member: { index: loaded.length, facts } });
  }
  const chosen = new Set(strongestCohort(loaded.map(item => item.member)).map(member => member.index));
  return loaded.filter((_item, index) => chosen.has(index)).slice(0, chapterPageLimit)
    .map((item, position) => ({ index: position + 1, src: item.src }));
}

/** Validates the page list that the content script returned. The tab's origin decides which URLs are acceptable. */
export function validateGenericPages(origin: string, sources: unknown): ChapterPage[] {
  if (!Array.isArray(sources) || sources.length > chapterPageLimit) return [];
  const pages: ChapterPage[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const src = genericSource(source, origin);
    if (!src || seen.has(src)) return [];
    seen.add(src);
    pages.push({ index: pages.length + 1, src });
  }
  return pages;
}

export function collectCandidates(root: Document = document, policy?: SurfacePolicy): PageCandidate[] {
  return [...root.images].map(image => {
    const bounds = image.getBoundingClientRect();
    const facts = policy?.facts(image);
    return {
      src: image.currentSrc || image.src, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      width: bounds.width, height: bounds.height, complete: image.complete && image.naturalWidth > 0,
      visible: bounds.width > 0 && bounds.height > 0 && shownElement(image), chrome: !!image.closest(chromeSelector),
      centre: facts?.centre ?? { x: bounds.x + bounds.width / 2 + scrollX, y: bounds.y + bounds.height / 2 + scrollY },
      ancestry: facts?.ancestry ?? ancestryOf(image), outsideRoot: facts?.outsideRoot, container: facts?.container ?? containerOf(image),
    };
  });
}
