import type { BubbleRegion, TranslationSegment } from '../../types/contracts';

/**
 * The same IDs in the same order, except that a repeated ID gains a numeric suffix that no other ID uses.
 * The first holder of an ID keeps it, so a reading with unique IDs is returned unchanged.
 */
export function uniqueIds(ids: readonly string[]): string[] {
  const taken = new Set(ids);
  const seen = new Set<string>();
  return ids.map(id => {
    if (!seen.has(id)) { seen.add(id); return id; }
    let n = 2;
    while (taken.has(`${id}~${n}`)) n++;
    const fresh = `${id}~${n}`;
    taken.add(fresh);
    seen.add(fresh);
    return fresh;
  });
}

function repeated(ids: readonly string[]): Set<string> {
  const seen = new Set<string>(), twice = new Set<string>();
  for (const id of ids) (seen.has(id) ? twice : seen).add(id);
  return twice;
}

/**
 * Split bubbles into those whose ID names exactly one bubble and one translation, and the rest. Order cannot say
 * which of two bubbles owns a translation, nor which of two translations belongs to one bubble, so a bubble whose
 * ID is repeated in either the reading or the provider response is ambiguous. The caller leaves ambiguous bubbles
 * as drawn and renders their unambiguous siblings. Segments of ambiguous IDs are dropped.
 */
export function separateAmbiguousBubbles(bubbles: readonly BubbleRegion[], segments: readonly TranslationSegment[]):
  { bubbles: BubbleRegion[]; segments: TranslationSegment[]; ambiguous: BubbleRegion[] } {
  const doubtful = new Set([...repeated(bubbles.map(bubble => bubble.id)), ...repeated(segments.map(segment => segment.id))]);
  return {
    bubbles: bubbles.filter(bubble => !doubtful.has(bubble.id)),
    segments: segments.filter(segment => !doubtful.has(segment.id)),
    ambiguous: bubbles.filter(bubble => doubtful.has(bubble.id)),
  };
}
