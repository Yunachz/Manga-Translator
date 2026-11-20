export type AdmissionIntent = 'click' | 'automatic';

/** Facts about one candidate reader surface, in plain data so the policy can be tested without a DOM. */
export interface SurfaceFacts {
  kind: 'img' | 'canvas';
  natural: { width: number; height: number };
  /** Rendered size in CSS pixels. */
  rendered: { width: number; height: number };
  /** Centre of the rendered box in document coordinates, used to line pages up. */
  centre?: { x: number; y: number };
  complete: boolean;
  visible: boolean;
  /** A scoped reader adapter owns this surface inside its own container. */
  scoped?: boolean;
  /** Nearest ancestors first. */
  ancestry: readonly AncestorFacts[];
  /** The likely reader container: surfaces of one chapter share it. Missing means the whole document. */
  container?: ContainerFacts;
  /** The page has a scoped reader container and this surface is not inside it. */
  outsideRoot?: boolean;
}

/** `key` names one container element. `reader` is true when its own markup says reader, viewer or chapter. */
export interface ContainerFacts { key: string; reader: boolean }

export interface AncestorFacts { tag: string; classes: readonly string[]; id?: string; role?: string; hidden?: boolean }

export type Rejection = 'unready' | 'tiny' | 'huge' | 'hidden' | 'advert' | 'dialog' | 'navigation' | 'outside' | 'cover' | 'untrusted';
export type Verdict = { ok: true } | { ok: false; reason: Rejection };

export const minimum = { natural: { width: 96, height: 88 }, rendered: { width: 96, height: 88 } };
/** The generic automatic policy: surfaces smaller than this are never fetched or read ahead of a click. */
export const trusted = { natural: 400, rendered: 240, aspect: { min: 0.5, max: 12 }, tolerance: 0.15 };
const maxPixels = 44_000_000;

const adWords = new Set(['ad', 'ads', 'adv', 'advert', 'adverts', 'advertisement', 'adsbygoogle', 'sponsor', 'sponsored', 'promo', 'promoted']);
/** Names that mark a cover, banner, logo or thumbnail. They refuse a surface for every intent. */
const coverWords = new Set(['banner', 'cover', 'covers', 'thumb', 'thumbs', 'thumbnail', 'thumbnails', 'avatar', 'logo', 'poster']);
/** Names of page furniture around a reader. They refuse only what the extension starts by itself. */
const furnitureWords = new Set(['related', 'recommend', 'recommended', 'recommendation', 'sidebar', 'widget']);
/** Styling utilities such as `object-cover` or `bg-cover` describe how an image is painted, not what it is. */
const styling = /^(?:object|bg|background|fit)-/i;
const dialogRoles = new Set(['dialog', 'alertdialog']);
const navRoles = new Set(['navigation']);
const chromeTags = new Set(['header', 'footer', 'aside']);
const chromeRoles = new Set(['banner', 'complementary', 'contentinfo']);

/** Lowercase words of a class or id, split on punctuation and camelCase boundaries. */
export function words(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function vocabularyOf(ancestor: AncestorFacts): Set<string> {
  return new Set([...ancestor.classes.filter(name => !styling.test(name)), ancestor.id ?? ''].flatMap(words));
}

/**
 * Explicit markup that says the surface is not a reader page. Dialogs, hidden markup, navigation, ad and promo
 * markers and cover, banner, logo or thumbnail names apply to every intent. Sidebar and related-content names and
 * page chrome apply only to what the extension starts by itself, so a direct click on an unusual but plausible
 * raster still works.
 */
export function negativeMetadata(ancestry: readonly AncestorFacts[], intent: AdmissionIntent): Rejection | undefined {
  for (const ancestor of ancestry.slice(0, 12)) {
    const tag = ancestor.tag.toLowerCase();
    const role = ancestor.role?.toLowerCase() ?? '';
    const vocabulary = vocabularyOf(ancestor);
    if (tag === 'dialog' || dialogRoles.has(role)) return 'dialog';
    if (ancestor.hidden) return 'hidden';
    if ([...vocabulary].some(word => adWords.has(word))) return 'advert';
    if (tag === 'nav' || navRoles.has(role)) return 'navigation';
    if ([...vocabulary].some(word => coverWords.has(word))) return 'cover';
    if (intent === 'automatic') {
      if (chromeTags.has(tag) || chromeRoles.has(role)) return 'navigation';
      if ([...vocabulary].some(word => furnitureWords.has(word))) return 'cover';
    }
  }
}

/**
 * Whether one surface may be treated as a reader page. Both intents refuse unusable geometry and explicit
 * negative markup. A direct user click needs nothing more.
 */
export function admitSurface(facts: SurfaceFacts, intent: AdmissionIntent): Verdict {
  if (!facts.complete || facts.natural.width <= 0 || facts.natural.height <= 0) return { ok: false, reason: 'unready' };
  if (!facts.visible) return { ok: false, reason: 'hidden' };
  if (facts.outsideRoot) return { ok: false, reason: 'outside' };
  if (facts.natural.width < minimum.natural.width || facts.natural.height < minimum.natural.height ||
      facts.rendered.width < minimum.rendered.width || facts.rendered.height < minimum.rendered.height) return { ok: false, reason: 'tiny' };
  if (facts.natural.width * facts.natural.height > maxPixels) return { ok: false, reason: 'huge' };
  const metadata = negativeMetadata(facts.ancestry, intent);
  return metadata ? { ok: false, reason: metadata } : { ok: true };
}

/** Geometry a generic reader page is expected to have, before any other surface is compared to it. */
export function plausiblePage(facts: SurfaceFacts): boolean {
  const ratio = facts.natural.height / Math.max(1, facts.natural.width);
  return facts.natural.width >= trusted.natural && facts.natural.height >= trusted.natural &&
    facts.rendered.width >= trusted.rendered && facts.rendered.height >= trusted.rendered &&
    ratio >= trusted.aspect.min && ratio <= trusted.aspect.max;
}

export interface CohortMember { index: number; facts: SurfaceFacts }

function similar(value: number, reference: number): boolean {
  return Math.abs(value - reference) <= Math.max(1, reference) * trusted.tolerance;
}

/** A group in a container that calls itself a reader, viewer or chapter outranks any group in one that does not. */
const readerTier = 1e12;

/**
 * The strongest group of repeated pages: surfaces of one width stacked in one column, or of one height laid
 * out in one row, inside one reader container. Each group is scored by its total rendered area, so a few full
 * pages outweigh a grid of related thumbnails, and a container that calls itself a reader outranks one that
 * does not. A lone surface that no adapter owns is discarded before any scoring: one picture with no reader
 * evidence is as likely an article photo as a page, and a huge one must not outbid a real column of pages.
 */
export function strongestCohort(candidates: readonly CohortMember[]): CohortMember[] {
  const pool = candidates.filter(({ facts }) => facts.scoped || plausiblePage(facts)).slice(0, 400);
  let best: CohortMember[] = [];
  let bestScore = 0;
  for (const pivot of pool) {
    const { rendered: size, centre } = pivot.facts;
    for (const axis of ['column', 'row'] as const) {
      const group = pool.filter(({ facts }) => {
        if (pivot.facts.container && facts.container && pivot.facts.container.key !== facts.container.key) return false;
        const at = facts.centre;
        if (axis === 'column') {
          return similar(facts.rendered.width, size.width) && (!at || !centre || Math.abs(at.x - centre.x) <= size.width * trusted.tolerance);
        }
        return similar(facts.rendered.height, size.height) && (!at || !centre || Math.abs(at.y - centre.y) <= size.height * trusted.tolerance);
      });
      if (group.length < 2 && !pivot.facts.scoped) continue;
      const score = group.reduce((sum, { facts }) => sum + facts.rendered.width * facts.rendered.height, 0) +
        (pivot.facts.container?.reader ? readerTier : 0);
      if (score > bestScore) { best = group; bestScore = score; }
    }
  }
  return [...best].sort((a, b) => a.index - b.index);
}
