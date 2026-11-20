import { describe, expect, it } from 'vitest';
import { fitFont } from '../../../src/core/typesetting/FontFitter';
import { wrapText, type Measure } from '../../../src/core/typesetting/TextLayout';

/** Deterministic monospace metrics: every UTF-16 code unit is `size` wide (default 10). */
const mono = (size = 10): Measure => text => text.length * size;
/** Full-width CJK glyphs are `size` wide, everything else half of it. */
const cjkAware = (size: number): Measure => text =>
  [...text].reduce((sum, char) => sum + (/[\u3000-\u9fff\uff00-\uffef]/.test(char) ? size : size / 2), 0);

describe('wrapText', () => {
  it('returns one line when the text fits', () => {
    expect(wrapText('hello world', 200, mono())).toEqual(['hello world']);
  });

  it('wraps at word boundaries and trims line edges', () => {
    expect(wrapText('aaa bbb ccc', 70, mono())).toEqual(['aaa bbb', 'ccc']);
    expect(wrapText('aaa bbb ccc', 30, mono())).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('never exceeds the width when every word fits on its own', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 100, mono());
    for (const line of lines) expect(mono()(line), line).toBeLessThanOrEqual(100);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('breaks an over-wide word by grapheme', () => {
    expect(wrapText('abcdefghij', 40, mono())).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('keeps combining sequences and emoji together when splitting', () => {
    const family = '👨‍👩‍👧';
    const lines = wrapText(`${family}${family}${family}`, 20, mono());
    expect(lines.join('')).toBe(`${family}${family}${family}`);
    for (const line of lines) expect(line.replace(new RegExp(family, 'gu'), '')).toBe('');
  });

  it('honours explicit newlines and blank lines are dropped', () => {
    expect(wrapText('one\ntwo', 200, mono())).toEqual(['one', 'two']);
    expect(wrapText('one\r\ntwo', 200, mono())).toEqual(['one', 'two']);
    expect(wrapText('one\n\ntwo', 200, mono())).toEqual(['one', 'two']);
  });

  it('returns no lines for empty or whitespace-only text', () => {
    expect(wrapText('', 100, mono())).toEqual([]);
    expect(wrapText('   ', 100, mono())).toEqual([]);
    expect(wrapText('\n\n', 100, mono())).toEqual([]);
  });

  it('breaks Japanese text with no spaces', () => {
    const lines = wrapText('これは長い日本語の文章です。', 50, cjkAware(10), 'ja');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('これは長い日本語の文章です。');
    for (const line of lines) expect(cjkAware(10)(line), line).toBeLessThanOrEqual(50);
  });

  it('does not lose or duplicate characters across arbitrary widths', () => {
    const text = 'Wait for me! Aku akan menunggumu di sini, jangan pergi.';
    for (const width of [15, 30, 55, 90, 400]) {
      const lines = wrapText(text, width, mono());
      expect(lines.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
    }
  });

  it('is deterministic', () => {
    const text = 'Satu dua tiga empat lima enam tujuh';
    expect(wrapText(text, 60, mono())).toEqual(wrapText(text, 60, mono()));
  });
});

describe('fitFont', () => {
  const measureAt = (size: number): Measure => mono(size * 0.5);

  it('picks the largest size whose wrapped text fits the box', () => {
    const fit = fitFont('hello world', 100, 100, 1.2, measureAt, 'en', 5, 64)!;
    expect(fit).toBeDefined();
    const measure = measureAt(fit.size);
    expect(fit.lines.length * fit.size * 1.2).toBeLessThanOrEqual(100);
    for (const line of fit.lines) expect(measure(line)).toBeLessThanOrEqual(100);

    // One pixel larger must not fit (otherwise the search stopped early).
    const bigger = fitFont('hello world', 100, 100, 1.2, measureAt, 'en', fit.size + 1, fit.size + 1);
    expect(bigger).toBeUndefined();
  });

  it('reports lineHeight in pixels (multiplier x size)', () => {
    const fit = fitFont('hi', 200, 200, 1.5, measureAt, 'en')!;
    expect(fit.lineHeight).toBeCloseTo(fit.size * 1.5, 9);
  });

  it('reduces the font size to preserve whole Indonesian words', () => {
    const fit = fitFont('Apakah berhasil', 48, 80, 1.2, measureAt, 'id', 5, 24);
    expect(fit).toMatchObject({ size: 12, lines: ['Apakah', 'berhasil'] });
  });

  it('keeps reduplicated Indonesian words and closing punctuation together', () => {
    const fit = fitFont('Anak-anak berlari-lari?!', 56, 80, 1.2, measureAt, 'id', 5, 24);
    expect(fit).toMatchObject({ size: 8, lines: ['Anak-anak', 'berlari-lari?!'] });
  });

  it('caps at the maximum font size', () => {
    expect(fitFont('a', 10_000, 10_000, 1.2, measureAt, 'en', 5, 24)!.size).toBe(24);
    expect(fitFont('a', 10_000, 10_000, 1.2, measureAt, 'en')!.size).toBe(64);
  });

  it('is limited by height: one line cannot be taller than the box', () => {
    const fit = fitFont('a', 10_000, 30, 1.2, measureAt, 'en')!;
    expect(fit.size).toBe(25); // floor(30 / 1.2)
    expect(fit.lines).toEqual(['a']);
  });

  it('shrinks as the text grows', () => {
    const short = fitFont('ok', 120, 80, 1.2, measureAt, 'en')!;
    const long = fitFont('this is a considerably longer translated sentence', 120, 80, 1.2, measureAt, 'en')!;
    expect(long.size).toBeLessThan(short.size);
    expect(long.lines.length).toBeGreaterThan(short.lines.length);
  });

  it('returns undefined when even the minimum size overflows (caller must report TYPESET_FAILED)', () => {
    expect(fitFont('x'.repeat(2000), 40, 40, 1.2, measureAt, 'en')).toBeUndefined();
  });

  it('returns undefined for text with no printable content', () => {
    expect(fitFont('   ', 100, 100, 1.2, measureAt, 'en')).toBeUndefined();
    expect(fitFont('', 100, 100, 1.2, measureAt, 'en')).toBeUndefined();
  });

  it('returns undefined for zero or negative boxes', () => {
    expect(fitFont('hello', 0, 100, 1.2, measureAt, 'en')).toBeUndefined();
    expect(fitFont('hello', 100, 0, 1.2, measureAt, 'en')).toBeUndefined();
    expect(fitFont('hello', -5, -5, 1.2, measureAt, 'en')).toBeUndefined();
  });

  it('honours a larger user-selected minimum', () => {
    const text = 'a fairly long sentence that needs to wrap over several lines';
    const small = fitFont(text, 80, 40, 1.2, measureAt, 'en', 5);
    expect(small).toBeDefined();
    expect(fitFont(text, 80, 40, 1.2, measureAt, 'en', small!.size + 1, 64)).toBeUndefined();
  });

  it('returned lines always satisfy both the width and the height constraint', () => {
    for (const [width, height] of [[60, 40], [150, 90], [300, 200], [90, 400]]) {
      const text = 'Aku tidak akan menyerah sampai semuanya selesai!';
      const fit = fitFont(text, width, height, 1.25, measureAt, 'id');
      if (!fit) continue;
      const measure = measureAt(fit.size);
      expect(fit.lines.length * fit.lineHeight, `${width}x${height}`).toBeLessThanOrEqual(height + 1e-9);
      for (const line of fit.lines) expect(measure(line), `${width}x${height}: ${line}`).toBeLessThanOrEqual(width);
    }
  });

  it('calls the measurer factory only with integer sizes inside [minimum, maximum]', () => {
    const seen: number[] = [];
    fitFont('hello world', 100, 100, 1.2, size => { seen.push(size); return measureAt(size); }, 'en', 8, 40);
    expect(seen.length).toBeGreaterThan(0);
    for (const size of seen) {
      expect(Number.isInteger(size)).toBe(true);
      expect(size).toBeGreaterThanOrEqual(8);
      expect(size).toBeLessThanOrEqual(40);
    }
  });

  it('fits fixture-sized bubbles: Japanese source bubble 420 x 480 hosts the translated line', () => {
    const fit = fitFont("Let's go!", 168, 192, 1.2, size => mono(size * 0.55), 'en')!;
    expect(fit.size).toBeGreaterThan(14);
  });
});
