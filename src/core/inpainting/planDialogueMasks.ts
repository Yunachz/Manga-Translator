import type { BubbleRegion, OCRResult, Rect } from '../../types/contracts';
import { rectPolygon } from '../image/geometry';
import { subtractCoverage } from '../image/translatedCoverage';
import { speechLineOrder } from '../reading-order/ReadingOrderResolver';

interface Dialogue { bubble: BubbleRegion; recognized: OCRResult[] }
type LineStatus = 'clean' | 'keep' | 'covered';

function enclosingBounds(lines: OCRResult[]): Rect {
  const x = Math.min(...lines.map(line => line.bounds.x));
  const y = Math.min(...lines.map(line => line.bounds.y));
  return { x, y, width: Math.max(...lines.map(line => line.bounds.x + line.bounds.width)) - x,
    height: Math.max(...lines.map(line => line.bounds.y + line.bounds.height)) - y };
}

/** Keep consecutive clean lines together and give each fragment a layout local to its source lines. */
export function planDialogueMasks(group: Dialogue, classify: (line: OCRResult) => LineStatus) {
  const lines = speechLineOrder(group.recognized).map(line => ({ line, status: classify(line) }));
  const keep = lines.filter(entry => entry.status === 'keep').map(entry => entry.line.bounds);
  const untouched = lines.filter(entry => entry.status !== 'clean').map(entry => entry.line.bounds);
  if (!untouched.length) return { ready: [group], keep, untouched };

  const runs: OCRResult[][] = [];
  let current: OCRResult[] | undefined;
  for (const { line, status } of lines) {
    if (status !== 'clean') { current = undefined; continue; }
    if (!current) { current = []; runs.push(current); }
    current.push(line);
  }
  const ready = runs.map((run, index) => {
    const original = enclosingBounds(run);
    const bounds = subtractCoverage([original], untouched).sort((a, b) => b.width * b.height - a.width * a.height)[0]
      ?? { ...original, width: 0, height: 0 };
    return {
      bubble: { ...group.bubble, id: `${group.bubble.id}-part-${index + 1}`, bounds,
        lines: run.map(({ bounds }) => ({ bounds, polygon: rectPolygon(bounds) })) },
      recognized: run,
    };
  });
  return { ready, keep, untouched };
}
