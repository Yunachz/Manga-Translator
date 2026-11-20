import type { ImageDescriptor } from '../../types/contracts';
import { namedChapterSite } from '../chapter/readerSites';
import { admitSurface, strongestCohort, type AdmissionIntent, type CohortMember, type SurfaceFacts, type Verdict } from './admission';
import { defaultAdapters, type SurfaceAdapter } from './adapters';
import { ancestryOf, containerOf, intrinsicSize, isCanvas, shown, type ReaderElement } from './ReaderSurface';

const cohortLifetime = 400;

/**
 * One reader-surface policy for the whole content script. Panel click, hover, read-ahead and generic chapter
 * discovery all ask it, so a surface is a page for all of them or for none. Adapters decide what a page is
 * on readers they know. The cohort decides which unknown images are pages before the extension fetches any.
 */
export class SurfacePolicy {
  private cohort?: { stamp: number; members: Set<ReaderElement> };

  constructor(private readonly known: () => Iterable<ReaderElement> = () => document.images,
    readonly adapters: readonly SurfaceAdapter[] = defaultAdapters) {}

  private adapterOf(surface: ReaderElement): SurfaceAdapter {
    return this.adapters.find(adapter => adapter.match(surface) === surface) ?? this.adapters[this.adapters.length - 1];
  }

  /** The surface a pointer target stands for, from the first adapter that claims it. */
  match(element: Element): ReaderElement | undefined {
    for (const adapter of this.adapters) {
      const surface = adapter.match(element);
      if (surface) return surface;
    }
  }

  surfaces(root: Element): ReaderElement[] {
    return this.adapters.flatMap(adapter => adapter.surfaces(root));
  }

  /** CSS selector of everything a pointer can mean as a page, for the cursor. */
  get selector(): string {
    return this.adapters.map(adapter => adapter.selector).join(', ');
  }

  get cursor(): string {
    return this.adapters.map(adapter => adapter.cursor).join(', ');
  }

  get attributes(): string[] {
    return [...new Set(this.adapters.flatMap(adapter => adapter.attributes))];
  }

  describe(surface: ReaderElement, id: string): ImageDescriptor | undefined {
    return this.adapterOf(surface).describe(surface, id);
  }

  slot(surface: ReaderElement): { element: Element; index: number } | undefined {
    return this.adapterOf(surface).slot(surface);
  }

  /** True when a scoped adapter has a reader container on this page. Only surfaces inside it are pages. */
  get scoped(): boolean {
    return this.adapters.some(adapter => adapter.scoped && adapter.scope());
  }

  /** An empty control that only turns pages, so a pointer over it means the page beneath. */
  passThrough(element: Element): boolean {
    return this.adapters.some(adapter => adapter.passThrough(element));
  }

  facts(surface: ReaderElement): SurfaceFacts {
    const adapter = this.adapterOf(surface);
    const box = surface.getBoundingClientRect();
    const natural = intrinsicSize(surface);
    const scopes = this.adapters.flatMap(item => item.scoped ? item.scope() ?? [] : []);
    return {
      kind: isCanvas(surface) ? 'canvas' : 'img', natural, rendered: { width: box.width, height: box.height },
      centre: { x: box.x + box.width / 2 + scrollX, y: box.y + box.height / 2 + scrollY },
      complete: isCanvas(surface) ? surface.isConnected && natural.width > 0 : surface.complete && natural.width > 0,
      visible: box.width > 0 && box.height > 0 && shown(surface),
      scoped: (adapter.scoped && !!adapter.scope()) || (!isCanvas(surface) && !!namedChapterSite(location.href)),
      ancestry: ancestryOf(surface), container: containerOf(surface),
      outsideRoot: scopes.length > 0 && !scopes.some(scope => scope.contains(surface)),
    };
  }

  /**
   * Whether a surface may be used. A click needs a plausible raster. Anything the extension starts by itself also
   * needs reader evidence: an owning adapter or a place in the strongest page cohort of the document.
   */
  admit(surface: ReaderElement, intent: AdmissionIntent): Verdict {
    const facts = this.facts(surface);
    const verdict = admitSurface(facts, intent);
    if (!verdict.ok || intent === 'click' || facts.scoped) return verdict;
    return this.trustedMembers().has(surface) ? verdict : { ok: false, reason: 'untrusted' };
  }

  invalidate(): void {
    this.cohort = undefined;
  }

  private trustedMembers(): Set<ReaderElement> {
    const now = performance.now();
    if (this.cohort && now - this.cohort.stamp < cohortLifetime) return this.cohort.members;
    const surfaces = [...this.known()];
    const candidates: CohortMember[] = [];
    for (const [index, surface] of surfaces.entries()) {
      const facts = this.facts(surface);
      if (admitSurface(facts, 'automatic').ok) candidates.push({ index, facts });
    }
    const members = new Set(strongestCohort(candidates).map(member => surfaces[member.index]));
    this.cohort = { stamp: now, members };
    return members;
  }
}
