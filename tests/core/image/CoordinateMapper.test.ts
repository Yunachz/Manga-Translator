import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageGeometry, toNatural, toNormalized, toViewport, type ImageGeometry } from '../../../src/core/image/CoordinateMapper';
import type { Rect } from '../../../src/types/contracts';

const plain: ImageGeometry = {
  object: { x: 100, y: 50, width: 400, height: 480 },
  clip: { x: 100, y: 50, width: 400, height: 480 },
};

describe('toNormalized', () => {
  it('maps viewport points to the unit square of the displayed image', () => {
    expect(toNormalized({ x: 100, y: 50 }, plain)).toEqual({ x: 0, y: 0 });
    expect(toNormalized({ x: 500, y: 530 }, plain)).toEqual({ x: 1, y: 1 });
    expect(toNormalized({ x: 300, y: 290 }, plain)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('rejects points outside the clip box', () => {
    expect(toNormalized({ x: 99.9, y: 100 }, plain)).toBeUndefined();
    expect(toNormalized({ x: 500.1, y: 100 }, plain)).toBeUndefined();
    expect(toNormalized({ x: 200, y: 49.9 }, plain)).toBeUndefined();
    expect(toNormalized({ x: 200, y: 530.1 }, plain)).toBeUndefined();
  });

  it('rejects points in the letterbox: inside the clip but outside the drawn image', () => {
    const letterboxed: ImageGeometry = {
      clip: { x: 0, y: 0, width: 400, height: 200 },
      object: { x: 100, y: 0, width: 200, height: 200 },
    };
    expect(toNormalized({ x: 50, y: 100 }, letterboxed)).toBeUndefined();
    expect(toNormalized({ x: 350, y: 100 }, letterboxed)).toBeUndefined();
    expect(toNormalized({ x: 200, y: 100 }, letterboxed)).toEqual({ x: 0.5, y: 0.5 });
    expect(toNormalized({ x: 100, y: 0 }, letterboxed)).toEqual({ x: 0, y: 0 });
  });

  it('rejects points in the cropped part of an overflowing image (object-fit: cover)', () => {
    const covered: ImageGeometry = {
      clip: { x: 0, y: 0, width: 400, height: 200 },
      object: { x: 0, y: -100, width: 400, height: 400 },
    };
    expect(toNormalized({ x: 200, y: 100 }, covered)).toEqual({ x: 0.5, y: 0.5 });
    expect(toNormalized({ x: 200, y: 0 }, covered)).toEqual({ x: 0.5, y: 0.25 });
    expect(toNormalized({ x: 200, y: 201 }, covered)).toBeUndefined();
  });

  it('returns undefined for a collapsed or negative object box', () => {
    const clip: Rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(toNormalized({ x: 5, y: 5 }, { clip, object: { x: 0, y: 0, width: 0, height: 10 } })).toBeUndefined();
    expect(toNormalized({ x: 5, y: 5 }, { clip, object: { x: 0, y: 0, width: 10, height: 0 } })).toBeUndefined();
    expect(toNormalized({ x: 5, y: 5 }, { clip, object: { x: 0, y: 0, width: -10, height: 10 } })).toBeUndefined();
  });
});

describe('toNatural', () => {
  it('scales normalized points into natural pixels', () => {
    expect(toNatural({ x: 0.73, y: 0.166667 }, 1000, 1200)).toEqual({ x: 730, y: 0.166667 * 1200 });
    expect(toNatural({ x: 0, y: 1 }, 640, 480)).toEqual({ x: 0, y: 480 });
  });

  it('round-trips click -> normalized -> natural for the fixture oracle points', () => {
    // Displayed at 400 x 480 (0.4x) at an arbitrary offset.
    const geometry: ImageGeometry = { object: { x: 31, y: 77, width: 400, height: 480 }, clip: { x: 31, y: 77, width: 400, height: 480 } };
    for (const [nx, ny] of [[0.73, 0.166667], [0.27, 0.633333], [0.325, 0.633333]]) {
      const click = { x: geometry.object.x + nx * 400, y: geometry.object.y + ny * 480 };
      const natural = toNatural(toNormalized(click, geometry)!, 1000, 1200);
      expect(natural.x).toBeCloseTo(nx * 1000, 6);
      expect(natural.y).toBeCloseTo(ny * 1200, 6);
    }
  });
});

describe('toViewport', () => {
  it('projects a normalized rect onto the displayed object box', () => {
    const projected = toViewport({ x: 0.52, y: 0.05, width: 0.42, height: 0.4 }, plain.object);
    expect(projected.x).toBeCloseTo(100 + 0.52 * 400, 9);
    expect(projected.y).toBeCloseTo(50 + 0.05 * 480, 9);
    expect(projected.width).toBeCloseTo(168, 9);
    expect(projected.height).toBeCloseTo(192, 9);
  });

  it('is the inverse of toNormalized for rect corners', () => {
    const rect: Rect = { x: 0.2, y: 0.3, width: 0.5, height: 0.25 };
    const view = toViewport(rect, plain.object);
    const topLeft = toNormalized({ x: view.x, y: view.y }, plain)!;
    const bottomRight = toNormalized({ x: view.x + view.width, y: view.y + view.height }, plain)!;
    expect(topLeft.x).toBeCloseTo(0.2, 12);
    expect(topLeft.y).toBeCloseTo(0.3, 12);
    expect(bottomRight.x).toBeCloseTo(0.7, 12);
    expect(bottomRight.y).toBeCloseTo(0.55, 12);
  });

  it('follows a resized image: same normalized rect, new object box', () => {
    const rect: Rect = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
    expect(toViewport(rect, { x: 0, y: 0, width: 200, height: 100 })).toEqual({ x: 100, y: 50, width: 100, height: 50 });
    expect(toViewport(rect, { x: 10, y: 20, width: 400, height: 200 })).toEqual({ x: 210, y: 120, width: 200, height: 100 });
  });
});

describe('imageGeometry', () => {
  interface Style {
    objectFit: string;
    objectPosition: string;
    paddingLeft: string; paddingRight: string; paddingTop: string; paddingBottom: string;
    borderLeftWidth: string; borderRightWidth: string; borderTopWidth: string; borderBottomWidth: string;
  }

  const baseStyle: Style = {
    objectFit: 'fill', objectPosition: '50% 50%',
    paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px',
    borderLeftWidth: '0px', borderRightWidth: '0px', borderTopWidth: '0px', borderBottomWidth: '0px',
  };

  interface Fixture {
    box: Rect;
    offset?: [number, number];
    natural?: [number, number];
    style?: Partial<Style>;
  }

  function geometryOf({ box, offset = [box.width, box.height], natural = [1000, 1200], style = {} }: Fixture): ImageGeometry {
    vi.stubGlobal('getComputedStyle', () => ({ ...baseStyle, ...style }));
    const image = {
      getBoundingClientRect: () => ({ ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height }),
      offsetWidth: offset[0], offsetHeight: offset[1],
      naturalWidth: natural[0], naturalHeight: natural[1],
    } as unknown as HTMLImageElement;
    return imageGeometry(image);
  }

  afterEach(() => vi.unstubAllGlobals());

  const box = { x: 10, y: 20, width: 400, height: 200 };

  it('object-fit: fill stretches to the content box', () => {
    const g = geometryOf({ box, natural: [100, 100] });
    expect(g.object).toEqual(box);
    expect(g.clip).toEqual(box);
  });

  it('falls back to the clip box before the image has natural size', () => {
    const g = geometryOf({ box, natural: [0, 0], style: { objectFit: 'contain' } });
    expect(g.object).toEqual(box);
    expect(g.clip).toEqual(box);
  });

  it('contain letterboxes and centers by default', () => {
    const g = geometryOf({ box, natural: [100, 100], style: { objectFit: 'contain' } });
    expect(g.clip).toEqual(box);
    expect(g.object).toEqual({ x: 110, y: 20, width: 200, height: 200 }); // x: 10 + (400 - 200) / 2
    const tall = geometryOf({ box: { x: 0, y: 0, width: 100, height: 400 }, natural: [100, 100], style: { objectFit: 'contain' } });
    expect(tall.object).toEqual({ x: 0, y: 150, width: 100, height: 100 });
  });

  it('cover fills the box and overflows symmetrically', () => {
    const g = geometryOf({ box, natural: [100, 100], style: { objectFit: 'cover' } });
    expect(g.object).toEqual({ x: 10, y: -80, width: 400, height: 400 }); // y: 20 + (200 - 400) / 2
    expect(g.clip).toEqual(box);
  });

  it('none keeps natural size, centered, even when larger than the box', () => {
    const small = geometryOf({ box, natural: [100, 100], style: { objectFit: 'none' } });
    expect(small.object).toEqual({ x: 160, y: 70, width: 100, height: 100 });
    const large = geometryOf({ box, natural: [600, 300], style: { objectFit: 'none' } });
    expect(large.object).toEqual({ x: -90, y: -30, width: 600, height: 300 }); // y: 20 + (200 - 300) / 2
  });

  it('scale-down never enlarges beyond natural size', () => {
    const enlarge = geometryOf({ box, natural: [100, 100], style: { objectFit: 'scale-down' } });
    expect(enlarge.object).toEqual({ x: 160, y: 70, width: 100, height: 100 });
    const shrink = geometryOf({ box, natural: [1000, 1000], style: { objectFit: 'scale-down' } });
    expect(shrink.object).toEqual({ x: 110, y: 20, width: 200, height: 200 });
  });

  it('applies keyword, percent and px object-position', () => {
    const at = (objectPosition: string) =>
      geometryOf({ box, natural: [100, 100], style: { objectFit: 'contain', objectPosition } }).object;
    expect(at('left top')).toMatchObject({ x: 10, y: 20 });
    expect(at('right bottom')).toMatchObject({ x: 210, y: 20 }); // vertical remaining is 0
    expect(at('0% 0%')).toMatchObject({ x: 10 });
    expect(at('100% 0%')).toMatchObject({ x: 210 });
    expect(at('25% 50%')).toMatchObject({ x: 60 });
    expect(at('30px 0px')).toMatchObject({ x: 40 });
    expect(at('-20px 0px')).toMatchObject({ x: -10 });
  });

  it('applies calc() object-position', () => {
    const g = geometryOf({ box, natural: [100, 100], style: { objectFit: 'contain', objectPosition: 'calc(50% + 10px) 50%' } });
    expect(g.object.x).toBeCloseTo(10 + 100 + 10, 9);
  });

  it('defaults to the center for an unrecognised position token', () => {
    const g = geometryOf({ box, natural: [100, 100], style: { objectFit: 'contain', objectPosition: 'center center' } });
    expect(g.object.x).toBe(110);
  });

  it('insets the clip box by padding and border', () => {
    const g = geometryOf({
      box: { x: 0, y: 0, width: 400, height: 200 },
      natural: [100, 100],
      style: { objectFit: 'fill', paddingLeft: '10px', paddingRight: '10px', paddingTop: '5px', paddingBottom: '5px',
        borderLeftWidth: '5px', borderRightWidth: '5px', borderTopWidth: '5px', borderBottomWidth: '5px' },
    });
    expect(g.clip).toEqual({ x: 15, y: 10, width: 370, height: 180 });
    expect(g.object).toEqual(g.clip);
  });

  it('compensates for CSS transform scale (box is larger than offset size)', () => {
    // 200 x 100 CSS box rendered at 2x -> 400 x 200 on screen.
    const g = geometryOf({
      box: { x: 0, y: 0, width: 400, height: 200 }, offset: [200, 100],
      natural: [100, 100], style: { objectFit: 'contain' },
    });
    expect(g.clip).toEqual({ x: 0, y: 0, width: 400, height: 200 });
    // 100 x 100 CSS object centered in 200 x 100 -> offset 50 CSS px -> 100 screen px.
    expect(g.object).toEqual({ x: 100, y: 0, width: 200, height: 200 });
  });

  it('scales padding by the transform as well', () => {
    const g = geometryOf({
      box: { x: 0, y: 0, width: 400, height: 200 }, offset: [200, 100], natural: [100, 100],
      style: { objectFit: 'fill', paddingLeft: '10px', paddingRight: '10px' },
    });
    expect(g.clip).toEqual({ x: 20, y: 0, width: 360, height: 200 });
  });

  it('gives a click-to-natural result that matches the fixture oracle when letterboxed', () => {
    // 1000 x 1200 page shown contained in a 600 x 600 slot -> 500 x 600 centered.
    const g = geometryOf({ box: { x: 0, y: 0, width: 600, height: 600 }, natural: [1000, 1200], style: { objectFit: 'contain' } });
    expect(g.object).toEqual({ x: 50, y: 0, width: 500, height: 600 });
    const click = { x: 50 + 0.73 * 500, y: 0.166667 * 600 };
    const natural = toNatural(toNormalized(click, g)!, 1000, 1200);
    expect(natural.x).toBeCloseTo(730, 6);
    expect(natural.y).toBeCloseTo(200, 3);
    expect(toNormalized({ x: 20, y: 100 }, g)).toBeUndefined();
  });

  it('never returns negative sizes when padding exceeds the box', () => {
    const g = geometryOf({
      box: { x: 0, y: 0, width: 10, height: 10 }, natural: [100, 100],
      style: { objectFit: 'contain', paddingLeft: '20px', paddingRight: '20px', paddingTop: '20px', paddingBottom: '20px' },
    });
    expect(g.clip.width).toBe(0);
    expect(g.clip.height).toBe(0);
    expect(g.object.width).toBe(0);
    expect(toNormalized({ x: 20, y: 20 }, g)).toBeUndefined();
  });
});
