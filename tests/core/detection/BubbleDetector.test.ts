import { describe, expect, it } from 'vitest';
import { detectBubbles } from '../../../src/core/detection/BubbleDetector';
import type { OCRResult } from '../../../src/types/contracts';

const width = 260, height = 230;
type Ellipse = [centerX: number, centerY: number, radiusX: number, radiusY: number];

function raster(ellipses: Ellipse[]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const light = ellipses.some(([cx, cy, rx, ry]) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1);
    data.fill(light ? 255 : 35, (y * width + x) * 4, (y * width + x) * 4 + 4);
  }
  return { width, height, data } as ImageData;
}

function line(id: string, x: number, y: number, width = 42): OCRResult {
  return { id, text: id, bounds: { x, y, width, height: 12 }, vertical: false, confidence: 1 };
}

describe('connected dialogue interiors', () => {
  it('separates offset dialogue stacks when the padded text boxes overlap by a few pixels', () => {
    const image = raster([[105, 134, 69, 73], [172, 102, 59, 58]]);
    const result = detectBubbles(image, [line('L1', 76, 119, 65), line('L2', 82, 136, 54), line('L3', 80, 154, 59),
      line('R1', 140, 97, 57), line('R2', 138, 113, 60)]);
    expect(result.map(group => group.recognized.map(item => item.id))).toEqual([['L1', 'L2', 'L3'], ['R1', 'R2']]);
    expect(result[0].bubble.bounds.x + result[0].bubble.bounds.width).toBeLessThan(result[1].bubble.bounds.x);
  });

  it('gives touching side-by-side bubbles different IDs, lines and placement areas', () => {
    const image = raster([[78, 120, 55, 65], [176, 106, 56, 62]]);
    const result = detectBubbles(image, [line('L1', 57, 102), line('R1', 157, 90),
      line('L2', 53, 124, 52), line('R2', 155, 116)]);
    expect(result).toHaveLength(2);
    expect(result.map(group => group.recognized.map(item => item.id))).toEqual([['L1', 'L2'], ['R1', 'R2']]);
    const [left, right] = result.map(group => group.bubble);
    expect(left.id).not.toBe(right.id);
    expect(left.bounds.x + left.bounds.width).toBeLessThan(right.bounds.x);
  });

  it('splits stacked touching bubbles across a vertical gap', () => {
    const image = raster([[132, 66, 66, 47], [127, 146, 63, 46]]);
    const result = detectBubbles(image, [line('top', 105, 54), line('bottom', 104, 141)]);
    expect(result.map(group => group.recognized.map(item => item.id))).toEqual([['top'], ['bottom']]);
    const [top, bottom] = result.map(group => group.bubble.bounds);
    expect(top.y + top.height).toBeLessThan(bottom.y);
  });

  it('keeps all lines of one oval bubble together', () => {
    const image = raster([[130, 115, 70, 75]]);
    const result = detectBubbles(image, [line('first', 113, 85, 36), line('second', 92, 109, 75), line('third', 108, 135, 44)]);
    expect(result).toHaveLength(1);
    expect(result[0].recognized).toHaveLength(3);
  });

  it('keeps aligned word fragments from two successive OCR rows in one balloon', () => {
    const image = raster([[130, 115, 100, 75]]);
    const lines = [line('THE', 61, 97, 61), line('LIGHT', 121, 96, 71),
      line('IS', 72, 115, 49), line('ON.', 125, 114, 52)];
    const result = detectBubbles(image, lines);
    expect(result).toHaveLength(1);
    expect(result[0].recognized.map(item => item.id).sort()).toEqual(['IS', 'LIGHT', 'ON.', 'THE']);
  });
});

describe('balloons drawn into each other', () => {
  // A small balloon overlaps the upper right of a large one. The merged interior has a step, not a neck.
  const merged = () => raster([[90, 120, 72, 82], [200, 90, 56, 40]]);
  const column = (prefix: string, x: number, width = 70) =>
    [0, 1, 2, 3].map(row => line(`${prefix}${row + 1}`, x + (row % 2) * 4, 80 + row * 14, width));

  it('separates a lone line from the multi-line block beside it, even with a narrow gap', () => {
    const result = detectBubbles(merged(), [...column('A', 62), line('B1', 142, 82, 52)]);
    expect(result.map(group => group.recognized.map(item => item.id).sort())).toEqual([['A1', 'A2', 'A3', 'A4'], ['B1']]);
    const [left, right] = result.map(group => group.bubble);
    expect(left.id).not.toBe(right.id);
    expect(left.bounds.x + left.bounds.width).toBeLessThanOrEqual(right.bounds.x + right.bounds.width);
  });

  it('separates two multi-line blocks that share rows', () => {
    const image = raster([[78, 118, 56, 70], [170, 112, 56, 70]]);
    const lines = [line('L1', 56, 90, 44), line('L2', 58, 104, 40), line('L3', 56, 118, 44),
      line('R1', 148, 84, 44), line('R2', 150, 98, 40), line('R3', 148, 112, 44)];
    const result = detectBubbles(image, lines);
    expect(result.map(group => group.recognized.map(item => item.id))).toEqual([['L1', 'L2', 'L3'], ['R1', 'R2', 'R3']]);
  });

  it('keeps two single lines of one bubble together because one line may be read as two boxes', () => {
    const result = detectBubbles(raster([[130, 115, 100, 60]]), [line('left', 70, 105, 60), line('right', 140, 107, 60)]);
    expect(result).toHaveLength(1);
  });

  it('keeps a row that is wider than the block below it joined to that block', () => {
    const result = detectBubbles(raster([[130, 115, 100, 75]]), [line('wide', 80, 82, 100), line('under1', 100, 96, 60),
      line('under2', 96, 110, 70)]);
    expect(result).toHaveLength(1);
    expect(result[0].recognized).toHaveLength(3);
  });

  it('never splits vertical text columns', () => {
    const vertical = (id: string, x: number): OCRResult => ({ id, text: id, bounds: { x, y: 70, width: 14, height: 90 }, vertical: true, confidence: 1 });
    const result = detectBubbles(raster([[130, 115, 70, 75]]), [vertical('c1', 150), vertical('c2', 128), vertical('c3', 106)]);
    expect(result).toHaveLength(1);
    expect(result[0].recognized).toHaveLength(3);
  });
});

describe('overlapping balloons without a neck', () => {
  const size = [360, 340] as const;
  const draw = (ellipses: Ellipse[]): ImageData => {
    const [w, h] = size;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const light = ellipses.some(([cx, cy, rx, ry]) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1);
      data.fill(light ? 255 : 35, (y * w + x) * 4, (y * w + x) * 4 + 4);
    }
    return { width: w, height: h, data } as ImageData;
  };
  const row = (id: string, x: number, y: number, w: number): OCRResult => line(id, x, y, w);
  const ids = (result: ReturnType<typeof detectBubbles>) => result.map(group => group.recognized.map(item => item.id).sort());

  it('splits a staggered pair where the small balloon sits up and to the right', () => {
    const image = draw([[90, 134, 72, 82], [200, 90, 56, 48]]);
    const left = [['a1', 62, 105, 54], ['a2', 70, 121, 70], ['a3', 64, 137, 62], ['a4', 68, 153, 66], ['a5', 62, 169, 60]] as const;
    const result = detectBubbles(image, [...left.map(([id, x, y, w]) => row(id, x, y, w)), row('b1', 155, 75, 65), row('b2', 150, 90, 76)]);
    expect(ids(result)).toEqual([['a1', 'a2', 'a3', 'a4', 'a5'], ['b1', 'b2']]);
  });

  it('splits two wide balloons stacked with a deep overlap, but not the same text in one tall balloon', () => {
    const lines = [row('top', 145, 98, 56), row('bottom', 124, 153, 66)];
    expect(ids(detectBubbles(draw([[174, 98, 53, 58], [160, 183, 76, 78]]), lines))).toEqual([['top'], ['bottom']]);
    expect(ids(detectBubbles(draw([[160, 155, 76, 115]]), lines))).toEqual([['bottom', 'top']]);
  });

  it('does not accept text that sits beside the balloon as part of its interior', () => {
    // The rectangle of the balloon covers the lower right corner, but that corner is outside the outline.
    const image = draw([[110, 120, 80, 90]]);
    const result = detectBubbles(image, [row('in1', 80, 100, 60), row('in2', 76, 116, 68), row('corner', 170, 195, 40)]);
    const owner = result.find(group => group.recognized.some(item => item.id === 'in1'))!;
    expect(owner.recognized.map(item => item.id)).not.toContain('corner');
  });

  it('keeps text that is partly clipped by the outline with its balloon', () => {
    const image = draw([[110, 120, 80, 90]]);
    const result = detectBubbles(image, [row('a', 70, 105, 80), row('b', 62, 121, 94), row('edge', 50, 150, 44)]);
    expect(result).toHaveLength(1);
    expect(result[0].recognized).toHaveLength(3);
  });

  it('puts text hanging off the corner of a balloon into its own group', () => {
    const image = draw([[130, 140, 90, 100]]);
    const column = [0, 1, 2, 3].map(i => row(`t${i}`, 100 + (i % 2) * 6, 100 + i * 14, 66));
    const result = detectBubbles(image, [...column, row('see', 160, 92, 56)]);
    expect(ids(result)).toEqual([['t0', 't1', 't2', 't3'], ['see']]);
    expect(result[1].bubble.bounds.width).toBeLessThan(90);
  });
});

it('keeps staggered five- and three-row columns intact when a shallow row gap meets an asymmetric outline notch', () => {
  // Synthetic polygon with a short right lobe, a long left lobe, and a broad shared joint.
  const width = 1800, height = 1391;
  const outline = [[895,310],[1000,115],[1100,63],[1200,65],[1375,105],[1390,25],[1784,25],[1784,560],
    [1700,620],[1610,680],[1580,675],[1540,653],[1530,890],[1520,970],[1470,1030],[1320,1107],
    [1240,1108],[1110,1045],[1000,962],[939,873]];
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) {
    const intersections = outline.flatMap(([x1, y1], i) => {
      const [x2, y2] = outline[(i + 1) % outline.length];
      return (y1 <= y && y < y2) || (y2 <= y && y < y1) ? [x1 + (x2 - x1) * (y - y1) / (y2 - y1)] : [];
    }).sort((a,b) => a-b);
    let x = 0;
    for (let i = 0; i < intersections.length; i += 2) {
      const start = Math.ceil(intersections[i]);
      data.fill(30, (width*y+x)*4, (width*y+start)*4);
      x = Math.floor(intersections[i+1])+1;
    }
    data.fill(30, (width*y+x)*4, width*(y+1)*4);
  }
  const rows = [
    ['R1',1428,164,352,95], ['R2',1451,261,295,93], ['R3',1469,358,260,99],
    ['L1',1109,294,213,103], ['L2',972,386,485,117], ['L3',1018,505,393,99],
    ['L4',989,606,456,100], ['L5',1019,710,393,103],
  ] as const;
  const lines = rows.map(([id,x,y,width,height]) => ({...line(id,x,y,width),bounds:{x,y,width,height}}));
  const groups = detectBubbles({width,height,data} as ImageData, lines);
  expect(groups.map(group => group.recognized.map(row => row.id))).toEqual([['L1','L2','L3','L4','L5'],['R1','R2','R3']]);
  expect(groups.every(group => group.bubble.enclosed && group.bubble.shape?.length)).toBe(true);
  expect(groups[0].bubble.bounds.x + groups[0].bubble.bounds.width).toBeLessThan(groups[1].bubble.bounds.x);
  // The cut between the two lobes is an estimate, so cleanup keeps the outline of the whole interior.
  expect(groups.every(group => (group.bubble.maskShape?.length ?? 0) >= 4)).toBe(true);
  expect(groups[0].bubble.maskShape).toEqual(groups[1].bubble.maskShape);
});
