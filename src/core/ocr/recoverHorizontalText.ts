import type { OCRResult, Rect, SourceLanguage, TextRegion } from '../../types/contracts';
import { rectPolygon } from '../image/geometry';
import { coversLine } from '../image/translatedCoverage';
import { letterCount } from './artworkMarks';
import { horizontalTextBands } from './HorizontalTextBands';

type Retry = (regions: TextRegion[]) => Promise<OCRResult[]>;
type Redetect = (bounds: Rect) => Promise<TextRegion[]>;

/** Below this confidence a tall line is most likely two rows read as one. */
const UNCERTAIN_MERGE = 0.5;
/** A weak read at least as tall as typical lettering may span two rows or hide text; confident reads keep the 1.55 rule. */
const MERGE_HEIGHT = 1;

export function unreliableShortLatin(line: OCRResult): boolean {
  const value = line.text.trim();
  if (value.length === 1 && /^[b-z]$/i.test(value) && value.toUpperCase() !== 'I') return line.confidence < 0.55;
  return line.confidence < 0.8 && value.length <= 8 && letterCount(value) <= 3 &&
    (value.match(/[$+\\^|]/g)?.length ?? 0) >= 2;
}

export async function recoverHorizontalText(raster: ImageData, regions: TextRegion[], original: OCRResult[],
  language: SourceLanguage, retry: Retry, redetect?: Redetect, signal?: AbortSignal): Promise<{ lines: OCRResult[]; unread: Rect[] }> {
  if (language !== 'en' && language !== 'auto') return { lines: original, unread: [] };
  const recognized = new Map(original.map(line => [line.bounds, line]));
  const lines: OCRResult[] = [], unread: Rect[] = [];
  const heights = original.filter(line => !line.vertical && letterCount(line.text) >= 4)
    .map(line => line.bounds.height).sort((a, b) => a - b);
  const typicalHeight = heights[Math.floor(heights.length / 2)] ?? Math.max(12, raster.width / 36);
  let tries = 0;
  for (const region of regions) {
    signal?.throwIfAborted();
    const { bounds } = region;
    const line = recognized.get(bounds);
    const letters = line ? letterCount(line.text) : 0;
    const latin = !line || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(line.text);
    if (language === 'en' && !latin && letters <= 2 && line && line.confidence < 0.8 &&
        (bounds.x < 1 || bounds.x + bounds.width > raster.width - 1)) {
      unread.push(bounds);
      continue;
    }
    const malformed = line && unreliableShortLatin(line);
    const uncertainMerge = line !== undefined && line.confidence < UNCERTAIN_MERGE && bounds.height >= typicalHeight * MERGE_HEIGHT;
    const candidate = latin && (!line || line.confidence < 0.88) &&
      (letters <= 3 || uncertainMerge || bounds.height >= typicalHeight * 1.55) &&
      bounds.width >= bounds.height * (malformed ? 0.85 : 1.05);
    if (candidate && tries < 8) {
      const bands = horizontalTextBands(raster, bounds, typicalHeight);
      const retryDetection = redetect && bounds.height >= typicalHeight * 1.45 && bands.length < 3;
      if (retryDetection) tries++;
      const local = retryDetection ? await redetect(bounds) : [];
      const split = local.length >= 2 ? local : bands.map(bounds => ({ bounds, polygon: rectPolygon(bounds) }));
      if (split.length >= 2) {
        const retryRegions = split.filter(row => !original.some(other => other !== line &&
          other.bounds.height < bounds.height * 0.72 && coversLine([other.bounds], row.bounds)));
        if (!retryDetection) tries++;
        const recovered = await retry(retryRegions);
        const readable = new Map(recovered.filter(row => row.confidence >= 0.57 &&
          (letterCount(row.text) >= 2 || /^(?:I|A|a)$/u.test(row.text))).map(row => [row.bounds, row]));
        const recoveredLetters = [...readable.values()].reduce((sum, row) => sum + letterCount(row.text), 0);
        // Prefer the existing legible line if splitting adds no reliable lettering. A descender or punctuation
        // fragment can otherwise turn an intact line into several translated fragments.
        if (!line || line.confidence < 0.65 || (readable.size >= 2 && recoveredLetters > letters)) {
          for (const [index, band] of retryRegions.entries()) {
            const row = readable.get(band.bounds);
            if (row) lines.push({ ...row, id: `recovered-${tries}-${index + 1}` });
            else unread.push(band.bounds);
          }
          continue;
        }
      }
    }
    // Splitting failed. Translating half of a merged line would erase the other half, so the line stays as drawn.
    if (line && !(candidate && uncertainMerge) && !(candidate && letters <= 3 && bounds.height >= typicalHeight * 1.45 && line.confidence < 0.8)
      && !(candidate && letters === 1 && bounds.width > bounds.height * 1.65 && line.confidence < 0.77)) lines.push(line);
    else if (candidate && (line || bounds.width >= bounds.height * 1.4)) unread.push(bounds);
  }
  return { lines, unread };
}
