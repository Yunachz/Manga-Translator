import { describe, expect, it } from 'vitest';
import { decodeCTC, inferLanguage, inferPanelLanguage } from '../../../src/core/ocr/PaddleOCRProvider';

/**
 * Builds a softmax-like [T, C] tensor from a list of winning class indices. Class 0 is the CTC blank,
 * class i (1..N) is dictionary[i - 1], class N + 1 is the trailing space.
 */
function logits(classes: number, winners: number[], confidence = 0.9): Float32Array {
  const data = new Float32Array(winners.length * classes).fill((1 - confidence) / (classes - 1));
  winners.forEach((winner, step) => { data[step * classes + winner] = confidence; });
  return data;
}

const dictionary = ['行', 'こ', 'う', 'A', 'B'];
const classes = dictionary.length + 2; // blank + 5 + space

describe('decodeCTC', () => {
  it('decodes labels using blank = 0 and dictionary[index - 1]', () => {
    expect(decodeCTC(logits(classes, [1, 2, 3]), classes, dictionary).text).toBe('行こう');
  });

  it('collapses repeats and drops blanks', () => {
    expect(decodeCTC(logits(classes, [1, 1, 0, 2, 2, 2, 0, 3]), classes, dictionary).text).toBe('行こう');
  });

  it('keeps a genuine double letter that a blank separates', () => {
    expect(decodeCTC(logits(classes, [4, 0, 4]), classes, dictionary).text).toBe('AA');
    expect(decodeCTC(logits(classes, [4, 4]), classes, dictionary).text).toBe('A');
  });

  it('maps the extra trailing class to a space and trims the result', () => {
    expect(decodeCTC(logits(classes, [4, classes - 1, 5]), classes, dictionary).text).toBe('A B');
    expect(decodeCTC(logits(classes, [classes - 1, 4, classes - 1]), classes, dictionary).text).toBe('A');
  });

  it('averages the probability of the kept timesteps only', () => {
    const data = logits(classes, [1, 0, 2], 0.9);
    data[1 * classes + 0] = 0.999; // blank step must not count
    const { confidence } = decodeCTC(data, classes, dictionary);
    expect(confidence).toBeCloseTo(0.9, 6);

    const mixed = logits(classes, [1, 2], 0.9);
    mixed[1 * classes + 2] = 0.5;
    expect(decodeCTC(mixed, classes, dictionary).confidence).toBeCloseTo((0.9 + 0.5) / 2, 6);
  });

  it('returns empty text and zero confidence for an all-blank sequence', () => {
    expect(decodeCTC(logits(classes, [0, 0, 0]), classes, dictionary)).toEqual({ text: '', confidence: 0 });
  });

  it('returns empty output for zero timesteps', () => {
    expect(decodeCTC(new Float32Array(0), classes, dictionary)).toEqual({ text: '', confidence: 0 });
  });

  it('throws on a class count that does not match dictionary + 2, so a wrong model/dictionary pair is loud', () => {
    expect(() => decodeCTC(logits(classes, [1]), classes + 1, dictionary)).toThrow('Invalid OCR tensor shape');
    expect(() => decodeCTC(logits(classes, [1]), classes, dictionary.slice(1))).toThrow('Invalid OCR tensor shape');
  });

  it('throws when the tensor length is not a multiple of the class count', () => {
    expect(() => decodeCTC(new Float32Array(classes * 2 + 1), classes, dictionary)).toThrow('Invalid OCR tensor shape');
  });

  it('takes the first index on exact ties, which is the blank', () => {
    const flat = new Float32Array(classes).fill(0.1);
    expect(decodeCTC(flat, classes, dictionary).text).toBe('');
  });
});

describe('inferLanguage', () => {
  it.each([
    ['行こう！', 'ja'],
    ['カタカナ', 'ja'],
    ['漢字とかな', 'ja'],
    ['안녕하세요', 'ko'],
    ['ㅋㅋㅋ', 'ko'],
    ['你好', 'zh'],
    ['漢字', 'zh'],
    ['THE LIGHT IS ON.', 'en'],
    ['', 'en'],
    ['123!?', 'en'],
  ])('%j -> %s', (text, expected) => {
    expect(inferLanguage(text)).toBe(expected);
  });

  it('prefers kana over Han when a line mixes them, and hangul over Han', () => {
    expect(inferLanguage('東京にいく')).toBe('ja');
    expect(inferLanguage('東京 서울')).toBe('ko');
  });
});

it('does not let one Han glyph change the detected language of several Latin lines', () => {
  const lines = ['十', 'Yuu,', 'stop copying', 'pro players', 'techniques.'].map(text => ({ id: text, text,
    confidence: 0.8, bounds: { x: 0, y: 0, width: 40, height: 12 }, vertical: false }));
  expect(inferPanelLanguage(lines)).toBe('en');
  expect(inferPanelLanguage(lines.slice(0, 1))).toBe('zh');
});
