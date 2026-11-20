import type { ImageDescriptor } from '../../types/contracts';
import { isCanvas, type ReaderElement } from '../surface/ReaderSurface';
import { SurfacePolicy } from '../surface/SurfacePolicy';

interface Entry { id: string; signature: string; near: boolean; prefetched: boolean; revision: number }
interface Hooks {
  /** Surfaces came, went or moved in or out of view. Cheap and frequent: callers should debounce. */
  changed?: () => void;
  ready?: (surface: ReaderElement, descriptor: ImageDescriptor) => void;
  near: (surface: ReaderElement, descriptor: ImageDescriptor) => void;
  removed: (surface: ReaderElement, id: string) => void;
}

/**
 * Tracks the reader surfaces of the page and the identity of each one. An image keeps its identity while its
 * source is unchanged. A canvas is a recycled element, so its identity is its page slot plus its bitmap size:
 * a different slot, a resize or a remount is a new surface and everything tied to the old one is dropped.
 */
export class ImageRegistry {
  private readonly surfaces = new Map<ReaderElement, Entry>();
  private readonly observer: MutationObserver;
  private readonly intersection: IntersectionObserver;
  private prefetch = true;
  readonly policy: SurfacePolicy;

  constructor(private readonly hooks: Hooks, policy?: SurfacePolicy) {
    this.policy = policy ?? new SurfacePolicy(() => this.surfaces.keys());
    this.intersection = new IntersectionObserver(entries => {
      for (const item of entries) {
        const surface = item.target as ReaderElement;
        const entry = this.surfaces.get(surface);
        if (!entry) continue;
        entry.near = item.isIntersecting;
        if (entry.near) this.inspect(surface);
      }
      this.hooks.changed?.();
    }, { rootMargin: '360px 0px', threshold: 0 });
    this.observer = new MutationObserver(records => {
      let removed = false;
      for (const record of records) {
        if (record.type === 'attributes') {
          const element = record.target as Element;
          const surface = this.policy.match(element) ?? (element.parentElement && this.policy.match(element.parentElement));
          if (surface) {
            this.add(surface);
            // Setting `width` or `height` clears a canvas, even to the same value, and the page then paints something
            // else on it. A mutation of either is a new surface, whatever the size is afterwards.
            const entry = this.surfaces.get(surface);
            if (entry && isCanvas(surface) && element === surface && (record.attributeName === 'width' || record.attributeName === 'height')) entry.revision++;
            this.inspect(surface);
          }
        }
        for (const added of record.addedNodes) this.scan(added);
        removed ||= record.removedNodes.length > 0;
      }
      if (removed) this.sweep();
    });
    document.addEventListener('load', this.loaded, true);
    this.scan(document.documentElement);
    this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: this.policy.attributes });
  }

  setPrefetch(active: boolean): void {
    this.prefetch = active;
    if (!active) return;
    for (const [surface, entry] of this.surfaces) if (entry.near) this.inspect(surface);
  }

  private readonly loaded = (event: Event) => {
    if (event.target instanceof HTMLImageElement) {
      this.add(event.target);
      this.inspect(event.target);
    }
  };

  private scan(root: Node): void {
    if (!(root instanceof Element)) return;
    for (const surface of this.policy.surfaces(root)) this.add(surface);
  }

  private add(surface: ReaderElement): void {
    if (this.surfaces.has(surface)) return;
    this.surfaces.set(surface, { id: crypto.randomUUID(), signature: this.signature(surface), near: false, prefetched: false, revision: 0 });
    this.intersection.observe(surface);
    this.policy.invalidate();
    this.hooks.changed?.();
  }

  private delete(surface: ReaderElement): void {
    const entry = this.surfaces.get(surface);
    if (!entry) return;
    this.surfaces.delete(surface);
    this.intersection.unobserve(surface);
    this.policy.invalidate();
    this.hooks.removed(surface, entry.id);
    this.hooks.changed?.();
  }

  /** Every surface the page has mounted, in the order they were found. */
  list(): ReaderElement[] {
    return [...this.surfaces.keys()];
  }

  /** Forget surfaces that left the document. Virtualised readers unmount canvases without telling anyone. */
  private sweep(): void {
    for (const surface of [...this.surfaces.keys()]) if (!surface.isConnected) this.delete(surface);
  }

  /** What makes one mounted surface the same surface: the image source, or a canvas's page slot and bitmap size. */
  private signature(surface: ReaderElement): string {
    if (!isCanvas(surface)) return surface.currentSrc || surface.src;
    const slot = this.policy.slot(surface);
    return `${slot?.index ?? -1}|${surface.width}x${surface.height}|${this.surfaces.get(surface)?.revision ?? 0}|${location.pathname}${location.search}`;
  }

  descriptor(surface: ReaderElement): ImageDescriptor | undefined {
    if (!surface.isConnected) return;
    this.add(surface);
    const entry = this.surfaces.get(surface)!;
    const signature = this.signature(surface);
    if (entry.signature !== signature) {
      this.hooks.removed(surface, entry.id);
      Object.assign(entry, { id: crypto.randomUUID(), signature, prefetched: false });
    }
    return this.policy.describe(surface, entry.id);
  }

  private inspect(surface: ReaderElement): void {
    const descriptor = this.descriptor(surface);
    if (!descriptor) return;
    const entry = this.surfaces.get(surface)!;
    const size = surface.getBoundingClientRect();
    if (entry.near) this.hooks.ready?.(surface, descriptor);
    // Read-ahead fetches an image the user has not asked for, so it needs more evidence than a click does.
    // A canvas is read only from its own page and only when the user asks.
    if (this.prefetch && entry.near && !entry.prefetched && !isCanvas(surface) && size.width >= 96 && size.height >= 88 &&
        this.policy.admit(surface, 'automatic').ok) {
      entry.prefetched = true;
      this.hooks.near(surface, descriptor);
    }
  }

  /** The surface under an event path that may serve a click: a plausible raster with no markup against it. */
  identify(elements: EventTarget[]): ReaderElement | undefined {
    for (const element of elements) {
      if (!(element instanceof Element)) continue;
      const surface = this.policy.match(element);
      if (!surface || !this.descriptor(surface)) continue;
      const bounds = surface.getBoundingClientRect();
      if (bounds.width >= 96 && bounds.height >= 88 && this.policy.admit(surface, 'click').ok) return surface;
    }
  }

  /** True when the surface may be highlighted or read ahead without a click. */
  admitted(surface: ReaderElement): boolean {
    return this.policy.admit(surface, 'automatic').ok;
  }

  destroy(): void {
    document.removeEventListener('load', this.loaded, true);
    this.observer.disconnect();
    this.intersection.disconnect();
    this.surfaces.clear();
  }
}
