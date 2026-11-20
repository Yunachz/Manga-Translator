import { prepareText, type Measure } from './TextLayout';

export interface FittedText { size: number; lines: string[]; lineHeight: number }

export function fitFont(text: string, width: number, height: number, lineHeight: number,
  measureAt: (size: number) => Measure, language = 'id', minimum = 5, maximum = 64): FittedText | undefined {
  const wrap = prepareText(text, language);
  function search(breakLongWords: boolean): FittedText | undefined {
    let low = minimum;
    let high = Math.min(maximum, Math.floor(height / lineHeight));
    let best: FittedText | undefined;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      const measure = measureAt(size);
      const lines = wrap(width, measure, breakLongWords);
      if (lines.length && lines.length * lineHeight * size <= height && lines.every(line => measure(line) <= width)) {
        best = { size, lines, lineHeight: size * lineHeight };
        low = size + 1;
      } else high = size - 1;
    }
    return best;
  }
  return search(false) ?? search(true);
}
