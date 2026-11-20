import type { BubbleRegion, InpaintingMode, OCRResult, Rect, SourceLanguage } from '../../types/contracts';
import { coversLine } from '../image/translatedCoverage';
import { edgeTrimmed, letterCount } from '../ocr/artworkMarks';
import { unreliableShortLatin } from '../ocr/recoverHorizontalText';
import { sampleBackground, TEXTURED_BACKGROUND } from './FlatFill';
import { buildLineMask, type MaskRegion } from './TextMask';

export type LineStatus = 'clean' | 'keep' | 'covered';

export interface LineContext {
  raster: ImageData;
  source: Exclude<SourceLanguage, 'auto'>;
  mode: InpaintingMode;
  /** Median height of the page's dialogue lines. */
  typicalLettering: number;
  protectedRegions: readonly Rect[];
}

interface Dialogue { bubble: BubbleRegion; recognized: OCRResult[] }

const OVERSIZED = 1.75;
const UNCERTAIN = 0.83;
const SHORT_EFFECT_LETTERS = 12;

function effectFragment(core: string): boolean {
  return /^(?:\d\s*[a-z]|[a-z]\s*\d|[a-z](?:\s+[a-z]){1,2})$/i.test(core);
}

function isolatedToken(core: string): boolean {
  return /^\S{1,10}$/u.test(core);
}

/** One or two short words, such as an onomatopoeia, as opposed to a sentence of lettering. */
function shortEffect(core: string): boolean {
  return core.split(/\s+/u).length <= 2 && letterCount(core) <= SHORT_EFFECT_LETTERS;
}

/** An oversized, uncertain sound effect often shares pixels with the underlying artwork. */
function uncertainEffect(group: Dialogue, line: OCRResult, typical: number): boolean {
  if (line.bounds.height <= typical * OVERSIZED) return false;
  const core = edgeTrimmed(line.text);
  const largeSingleRegion = group.bubble.lines.length === 1 && group.bubble.bounds.height > typical * 4;
  if (effectFragment(core) && (largeSingleRegion || line.confidence < UNCERTAIN)) return true;
  return group.bubble.enclosed === false && isolatedToken(core) && line.confidence < UNCERTAIN;
}

/**
 * Lettering drawn over a toned background, with no balloon around it, cannot be cleaned without smearing
 * the tone and cannot be redrawn without sitting on it. Confidence does not matter: a clean read of a sound
 * effect is still artwork. Dialogue in a balloon, or lettering on a flat background, is not affected.
 */
function onTone(raster: ImageData, group: Dialogue, line: OCRResult, typical: number, mask: MaskRegion): boolean {
  if (group.bubble.enclosed !== false || line.bounds.height <= typical * OVERSIZED) return false;
  if (!shortEffect(edgeTrimmed(line.text))) return false;
  return sampleBackground(raster, mask).texture >= TEXTURED_BACKGROUND;
}

function median(values: number[]): number | undefined {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Height of ordinary lettering on the page. Lines inside balloons set it. A page with no balloon, such as a caption
 * panel, has no such lines, and falling back to the page width would call every line of a large caption oversized.
 * Then the lines themselves set it, but only when several of them agree on a height. A lone line, or lines of
 * unrelated sizes, cannot be told from a sound effect and keep the width-based fallback.
 */
export function typicalLettering(groups: readonly Dialogue[], pageWidth: number): number {
  const fallback = Math.max(15, pageWidth / 38);
  const enclosed = median(groups.filter(group => group.bubble.enclosed).flatMap(group => group.bubble.lines.map(line => line.bounds.height)));
  if (enclosed !== undefined) return enclosed;
  const heights = groups.flatMap(group => group.recognized.filter(line => line.text).map(line => line.bounds.height));
  const middle = median(heights);
  if (middle === undefined || heights.length < 4) return fallback;
  const agreeing = heights.filter(height => Math.abs(height - middle) <= middle * 0.25).length;
  return agreeing >= 4 && agreeing >= heights.length * 0.6 ? Math.max(fallback, middle) : fallback;
}

/** Decide whether one recognized line is safe to clean, must stay as drawn, or is already translated. */
export function classifyLine(context: LineContext, group: Dialogue, line: OCRResult): LineStatus {
  const { raster, source, mode, typicalLettering, protectedRegions } = context;
  if (coversLine(protectedRegions, line.bounds)) return 'covered';
  if (source === 'en' && (unreliableShortLatin(line) || (/^\d+[.!?]?$/u.test(line.text) &&
      group.recognized.some(other => unreliableShortLatin(other))))) return 'keep';
  if (uncertainEffect(group, line, typicalLettering)) return 'keep';
  const mask = line.text ? buildLineMask(raster, line.bounds, mode, group.bubble.maskShape ?? group.bubble.shape) : undefined;
  if (!mask || onTone(raster, group, line, typicalLettering, mask)) return 'keep';
  return 'clean';
}
