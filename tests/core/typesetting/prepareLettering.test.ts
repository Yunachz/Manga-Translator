import { expect, it } from 'vitest';
import type { BubbleRegion, Rect, Settings } from '../../../src/types/contracts';
import { separateAmbiguousBubbles, uniqueIds } from '../../../src/core/typesetting/bubbleIds';
import { prepareLettering } from '../../../src/core/typesetting/prepareLettering';

const settings = { fontWeight: 600, fontFamily: 'Arial', padding: 0.09, lineHeight: 1.17, target: 'id', inpaintingMode: 'normal' } as Settings;
const context = { font: '', measureText: (value: string) => ({ width: value.length * 5 }) } as unknown as OffscreenCanvasRenderingContext2D;

/** White page; only the first bubble's line carries ink, so only it can produce a text mask. */
function page(): ImageData {
  const data = new Uint8ClampedArray(200 * 100 * 4).fill(255);
  for (const left of [50, 62, 74, 86]) for (let y = 22; y < 38; y++) for (let x = left; x < left + 5; x++) {
    data.fill(10, (y * 200 + x) * 4, (y * 200 + x) * 4 + 3);
  }
  return { width: 200, height: 100, data } as unknown as ImageData;
}

const bubble = (id: string, y: number): BubbleRegion => {
  const bounds: Rect = { x: 40, y, width: 100, height: 20 };
  return { id, bounds: { x: 10, y: y - 10, width: 180, height: 40 }, lines: [{ bounds, polygon: [] }] };
};

it('gives repeated IDs a fresh unused suffix and leaves unique IDs alone', () => {
  expect(uniqueIds(['a', 'b', 'a', 'a', 'a~2'])).toEqual(['a', 'b', 'a~3', 'a~4', 'a~2']);
  expect(uniqueIds(['a', 'b'])).toEqual(['a', 'b']);
});

it('sets aside every bubble whose ID is repeated in the reading or in the response, and keeps unique siblings', () => {
  const [first, second, third, fourth] = [bubble('x', 20), bubble('x', 60), bubble('y', 80), bubble('z', 90)];
  const twoBubbles = separateAmbiguousBubbles([first, second, third], [{ id: 'x', text: 'one' }, { id: 'y', text: 'three' }]);
  expect(twoBubbles.ambiguous).toEqual([first, second]);
  expect(twoBubbles.bubbles).toEqual([third]);
  expect(twoBubbles.segments).toEqual([{ id: 'y', text: 'three' }]);

  const twoSegments = separateAmbiguousBubbles([third, fourth],
    [{ id: 'y', text: 'a' }, { id: 'y', text: 'b' }, { id: 'z', text: 'c' }]);
  expect(twoSegments.ambiguous).toEqual([third]);
  expect(twoSegments.bubbles).toEqual([fourth]);
  expect(twoSegments.segments).toEqual([{ id: 'z', text: 'c' }]);

  const unique = separateAmbiguousBubbles([third, fourth], [{ id: 'y', text: 'a' }, { id: 'z', text: 'c' }]);
  expect(unique).toEqual({ bubbles: [third, fourth], segments: [{ id: 'y', text: 'a' }, { id: 'z', text: 'c' }], ambiguous: [] });
});

it('finishes when two bubbles share an ID and only one can be prepared, preserving the other', () => {
  const ready = bubble('bubble-5', 20), blocked = bubble('bubble-5', 60);
  const result = prepareLettering(context, page(), [ready, blocked], [{ id: 'bubble-5', text: 'Halo' }], settings,
    { preserve: [], remaining: [] });
  expect(result.prepared.map(item => item.bubble)).toEqual([ready]);
  expect(result.skipped).toBe(1);
  expect(result.preserve).toEqual(blocked.lines.map(line => line.bounds));
  expect(result.remaining).toEqual([blocked.bounds]);
});

it('translates only the unambiguous bubble when its sibling shares an ID, and never places text on the wrong one', () => {
  const sibling = bubble('b', 20), duplicate = bubble('b', 60), unique = bubble('c', 20);
  const paired = separateAmbiguousBubbles([sibling, duplicate, unique], [{ id: 'b', text: 'Halo' }, { id: 'c', text: 'Halo' }]);
  const result = prepareLettering(context, page(), paired.bubbles, paired.segments, settings, { preserve: [], remaining: [] });
  expect(result.prepared.map(item => item.bubble)).toEqual([unique]);
  expect(paired.ambiguous).toEqual([sibling, duplicate]);
});

it('accepts every bubble with no skip when all can be prepared', () => {
  const only = bubble('solo', 20);
  const result = prepareLettering(context, page(), [only], [{ id: 'solo', text: 'Halo' }], settings, { preserve: [], remaining: [] });
  expect(result).toMatchObject({ skipped: 0, preserve: [], remaining: [] });
  expect(result.prepared).toHaveLength(1);
});
