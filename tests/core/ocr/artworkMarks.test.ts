import { expect, it } from 'vitest';
import type { OCRResult, Rect } from '../../../src/types/contracts';
import { edgeTrimmed, isArtworkMark, separateArtworkMarks } from '../../../src/core/ocr/artworkMarks';

const line = (text: string, height: number, extra: Partial<OCRResult> = {}): OCRResult =>
  ({ id: text, text, confidence: 0.86, bounds: { x: 0, y: 0, width: Math.max(10, height * 2), height }, vertical: false, ...extra });
const dialogue = ['Ooh! Nicely', 'done today', 'Yay again'].map(text => line(text, 30));

it('drops a one-letter read far smaller than the lettering but keeps real one-letter words', () => {
  const mark = line('a', 8.7), real = line('A', 17), pronoun = line('I', 19);
  const result = separateArtworkMarks([...dialogue, mark, real, pronoun], 15);
  expect(result.lines).toEqual([...dialogue, real, pronoun]);
  expect(result.marks).toEqual([mark.bounds] satisfies Rect[]);
});

it('drops a tiny digit read from a halftone dot, with or without punctuation around it', () => {
  expect(separateArtworkMarks([...dialogue, line('8', 7.9), line("'a.", 8)], 15).lines).toEqual(dialogue);
});

it('keeps ellipses, CJK text and vertical lines however small their box is', () => {
  const kept = [line('...', 6), line('あ', 6), line('え', 6, { vertical: true }), line('a', 6, { vertical: true })];
  expect(separateArtworkMarks([...dialogue, ...kept], 15).lines).toEqual([...dialogue, ...kept]);
});

it('uses the fallback height when the page has no real dialogue to measure', () => {
  expect(separateArtworkMarks([line('a', 8)], 30)).toEqual({ lines: [], marks: [line('a', 8).bounds] });
  expect(separateArtworkMarks([line('a', 8)], 15).lines).toHaveLength(1);
});

it('does not treat lines of three letters as marks', () => {
  expect(isArtworkMark(line('Ohh', 8), 30)).toBe(false);
  expect(isArtworkMark(line('Oh', 8), 30)).toBe(true);
});

it('trims quotes and punctuation from both ends only', () => {
  expect(edgeTrimmed("'sh")).toBe('sh');
  expect(edgeTrimmed('"it\'s!!"')).toBe("it's");
  expect(edgeTrimmed('...')).toBe('');
});
