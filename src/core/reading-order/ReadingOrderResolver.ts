import type { OCRResult, Rect, SourceLanguage } from '../../types/contracts';

interface Located { bounds: Rect }

export function readingOrder<T extends Located>(items: readonly T[], order: 'rtl' | 'ttb', speechLines = false): T[] {
  const rows: { anchor: Rect; items: T[] }[] = [];
  for (const item of [...items].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)) {
    const { x, y, width, height } = item.bounds;
    const row = rows.find(({ anchor }) => {
      const overlap = Math.min(y + height, anchor.y + anchor.height) - Math.max(y, anchor.y);
      if (speechLines) {
        const overlapX = Math.min(x + width, anchor.x + anchor.width) - Math.max(x, anchor.x);
        return overlap >= Math.min(height, anchor.height) * 0.56 &&
          overlapX <= Math.min(width, anchor.width) * 0.3 &&
          Math.abs(y + height / 2 - anchor.y - anchor.height / 2) <= Math.min(height, anchor.height) * 0.36;
      }
      return overlap >= Math.min(height, anchor.height) * 0.42 &&
        Math.abs(y + height / 2 - anchor.y - anchor.height / 2) <= Math.max(12, Math.max(height, anchor.height) * 0.63);
    });
    if (row) row.items.push(item);
    else rows.push({ anchor: item.bounds, items: [item] });
  }
  return rows.flatMap(row => row.items.sort((a, b) => order === 'rtl'
    ? b.bounds.x - a.bounds.x || a.bounds.y - b.bounds.y
    : a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y));
}

export function speechLineOrder(lines: OCRResult[]): OCRResult[] {
  if (lines.filter(line => line.vertical).length > lines.length / 2) {
    return [...lines].sort((a, b) => b.bounds.x - a.bounds.x || a.bounds.y - b.bounds.y);
  }
  return readingOrder(lines, 'ttb', true);
}

export function resolveReadingOrder<T extends Located>(items: readonly T[], setting: 'auto' | 'rtl' | 'ttb', language: SourceLanguage): T[] {
  return readingOrder(items, setting === 'auto' ? language === 'ja' ? 'rtl' : 'ttb' : setting);
}
