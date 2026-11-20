import { protectMask } from '../inpainting/MaskRegions';
import { textMask, type MaskRegion } from '../inpainting/TextMask';
import type { BubbleRegion, Rect, Settings, TranslationSegment } from '../../types/contracts';
import { planTranslationText } from './Renderer';
import type { BubblePlan } from './BubbleFit';

export interface PreparedBubble { bubble: BubbleRegion; plan: BubblePlan; masks: MaskRegion[] }
export interface Lettering {
  prepared: PreparedBubble[];
  /** Original lettering that must stay: the reading's own, plus every bubble that could not be prepared. */
  preserve: Rect[];
  remaining: Rect[];
  skipped: number;
}

/**
 * Every bubble that can be both typeset and cleaned without touching preserved lettering. Bubbles are tracked
 * by identity and each pass either accepts every candidate or drops at least one, so the loop ends within
 * `bubbles.length + 1` passes whatever the IDs are. Dropping a bubble preserves its lines, which can in turn
 * block a neighbour that reached into them, so the survivors are checked again. The caller guarantees unique IDs.
 */
export function prepareLettering(context: OffscreenCanvasRenderingContext2D, raster: ImageData, bubbles: readonly BubbleRegion[],
  segments: readonly TranslationSegment[], settings: Settings, held: { preserve: readonly Rect[]; remaining: readonly Rect[] }): Lettering {
  const translated = new Map(segments.map(segment => [segment.id, segment.text]));
  const preserve = [...held.preserve];
  const remaining = [...held.remaining];
  let candidates = bubbles.map(bubble => ({ bubble,
    masks: textMask(raster, bubble.lines.map(line => line.bounds), settings.inpaintingMode, bubble.maskShape ?? bubble.shape) }));
  for (let pass = 0; pass <= bubbles.length; pass++) {
    const accepted = new Map<typeof candidates[number], PreparedBubble>();
    for (const candidate of candidates) {
      const { bubble } = candidate;
      const plan = planTranslationText(context, bubble, translated.get(bubble.id) ?? '', settings, preserve);
      if (!plan || candidate.masks.length !== bubble.lines.length) continue;
      const masks = candidate.masks.flatMap(mask => protectMask(mask, preserve) ?? []);
      if (masks.length === candidate.masks.length) accepted.set(candidate, { bubble, plan, masks });
    }
    if (accepted.size === candidates.length) {
      return { prepared: [...accepted.values()], preserve, remaining, skipped: bubbles.length - accepted.size };
    }
    candidates = candidates.filter(candidate => {
      if (accepted.has(candidate)) return true;
      preserve.push(...candidate.bubble.lines.map(line => line.bounds));
      remaining.push(candidate.bubble.bounds);
      return false;
    });
  }
  // Unreachable: each pass above shrinks `candidates` unless it returns. Fail closed rather than loop.
  for (const { bubble } of candidates) {
    preserve.push(...bubble.lines.map(line => line.bounds));
    remaining.push(bubble.bounds);
  }
  return { prepared: [], preserve, remaining, skipped: bubbles.length };
}
