import type { Point, Rect } from '../../types/contracts';
import { intrinsicSize, type ReaderElement } from '../surface/ReaderSurface';

export interface ImageGeometry { object: Rect; clip: Rect }

export function toNormalized(point: Point, geometry: ImageGeometry): Point | undefined {
  const { object, clip } = geometry;
  if (object.width <= 0 || object.height <= 0 || point.x < clip.x || point.y < clip.y ||
      point.x > clip.x + clip.width || point.y > clip.y + clip.height) return;
  const x = (point.x - object.x) / object.width;
  const y = (point.y - object.y) / object.height;
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return { x, y };
}

export function toNatural(point: Point, width: number, height: number): Point {
  return { x: point.x * width, y: point.y * height };
}

export function toViewport(rect: Rect, object: Rect): Rect {
  return { x: object.x + rect.x * object.width, y: object.y + rect.y * object.height,
    width: rect.width * object.width, height: rect.height * object.height };
}

function positionOffset(value: string, remaining: number): number {
  if (value === 'left' || value === 'top') return 0;
  if (value === 'right' || value === 'bottom') return remaining;
  if (/^-?[\d.]+%$/.test(value)) return remaining * parseFloat(value) / 100;
  if (/^-?[\d.]+px$/.test(value)) return parseFloat(value);
  if (value.startsWith('calc(')) {
    return [...value.matchAll(/([+-]?)\s*([\d.]+)(%|px)/g)]
      .reduce((sum, [, sign, amount, unit]) => sum + (sign === '-' ? -1 : 1) * Number(amount) * (unit === '%' ? remaining / 100 : 1), 0);
  }
  return remaining / 2;
}

export function imageGeometry(image: ReaderElement): ImageGeometry {
  const natural = intrinsicSize(image);
  const box = image.getBoundingClientRect();
  const style = getComputedStyle(image);
  const scaleX = image.offsetWidth ? box.width / image.offsetWidth : 1;
  const scaleY = image.offsetHeight ? box.height / image.offsetHeight : 1;
  const px = (value: string) => parseFloat(value) || 0;
  const left = px(style.paddingLeft) + px(style.borderLeftWidth);
  const right = px(style.paddingRight) + px(style.borderRightWidth);
  const top = px(style.paddingTop) + px(style.borderTopWidth);
  const bottom = px(style.paddingBottom) + px(style.borderBottomWidth);
  const width = Math.max(0, box.width / (scaleX || 1) - left - right);
  const height = Math.max(0, box.height / (scaleY || 1) - top - bottom);
  const clip = { x: box.x + left * scaleX, y: box.y + top * scaleY, width: width * scaleX, height: height * scaleY };
  if (style.objectFit === 'fill' || !natural.width || !natural.height) return { object: clip, clip };
  const contain = Math.min(width / natural.width, height / natural.height);
  const fit = style.objectFit === 'cover' ? Math.max(width / natural.width, height / natural.height)
    : style.objectFit === 'none' ? 1 : style.objectFit === 'scale-down' ? Math.min(1, contain) : contain;
  const objectWidth = natural.width * fit;
  const objectHeight = natural.height * fit;
  const [horizontal, vertical = '50%'] = style.objectPosition.match(/calc\([^)]*\)|\S+/g) ?? ['50%'];
  return {
    clip,
    object: { x: clip.x + positionOffset(horizontal, width - objectWidth) * scaleX,
      y: clip.y + positionOffset(vertical, height - objectHeight) * scaleY,
      width: objectWidth * scaleX, height: objectHeight * scaleY },
  };
}
