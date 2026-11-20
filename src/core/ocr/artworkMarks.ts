import type { OCRResult, Rect } from '../../types/contracts';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** A mark this much shorter than the page's lettering is texture, a dot or a screentone cell, not a spoken line. */
const TINY_RATIO = 0.45;

export function letterCount(text: string): number {
  return [...text.matchAll(/[\p{L}\p{N}]/gu)].length;
}

/** Text without the quotes, apostrophes and punctuation OCR attaches to either end of a word. */
export function edgeTrimmed(text: string): string {
  return text.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Median height of lines long enough to be real dialogue, so artwork marks cannot pull the baseline down. */
export function lettering(lines: readonly OCRResult[], fallback: number): number {
  const heights = lines.filter(line => !line.vertical && letterCount(line.text) >= 3)
    .map(line => line.bounds.height).sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] ?? fallback;
}

/**
 * Latin lines of one or two letters that are far smaller than the surrounding lettering. OCR reads such a
 * mark off a cheek hatch or a halftone dot. Lines with no letter at all (an ellipsis) are real dialogue and
 * stay, as do CJK lines and vertical lines, whose box height is the length of the text.
 */
export function isArtworkMark(line: OCRResult, typical: number): boolean {
  if (line.vertical || CJK.test(line.text)) return false;
  const letters = letterCount(line.text);
  return letters >= 1 && letters <= 2 && line.bounds.height < typical * TINY_RATIO;
}

/** Split a reading into dialogue lines and artwork marks. Marks are never cleaned, translated or counted as unread. */
export function separateArtworkMarks(lines: OCRResult[], fallback: number): { lines: OCRResult[]; marks: Rect[] } {
  const typical = lettering(lines, fallback);
  const marks: Rect[] = [];
  const kept = lines.filter(line => {
    if (!isArtworkMark(line, typical)) return true;
    marks.push(line.bounds);
    return false;
  });
  return { lines: kept, marks };
}
