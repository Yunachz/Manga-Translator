import type { BubbleRegion, Rect, Settings, TranslationResult } from '../../types/contracts';
import { PipelineError } from '../pipeline/PipelineError';
import { planBubbleText, type BubblePlan } from './BubbleFit';
import { choosePaint, textBox, type TextPaint } from './Contrast';

export { planBubbleText } from './BubbleFit';

/** Plans the actual render before original lettering is erased. */
export function planTranslationText(context: OffscreenCanvasRenderingContext2D, bubble: BubbleRegion, text: string,
  settings: Settings, reserved?: Rect[]): BubblePlan | undefined {
  if (!text.trim()) return;
  const font = (size: number) => `${settings.fontWeight} ${size}px ${settings.fontFamily}, sans-serif`;
  return planBubbleText(bubble, text, size => {
    context.font = font(size);
    return value => Math.max(context.measureText(value).width + 2, 2);
  }, { lineHeight: settings.lineHeight, padding: settings.padding, language: settings.target, reserved });
}

/** Draws every bubble that fits. Returns the IDs of bubbles left untouched because the text does not fit. */
export function drawTranslation(context: OffscreenCanvasRenderingContext2D, bubbles: BubbleRegion[], translation: TranslationResult,
  settings: Settings, plans?: ReadonlyMap<string, BubblePlan>): string[] {
  const translations = new Map(translation.segments.map(segment => [segment.id, segment.text]));
  const skipped: string[] = [];
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  // Pass 1: plan and choose colors for every bubble from the untouched page, before any text is drawn.
  const jobs: { bubble: BubbleRegion; fit: BubblePlan; paint: TextPaint }[] = [];
  for (const bubble of bubbles) {
    const text = translations.get(bubble.id);
    if (!text) throw new PipelineError('TYPESET_FAILED', 'Teks terjemahan bubble tidak tersedia.');
    const fit = plans ? plans.get(bubble.id) : planTranslationText(context, bubble, text, settings);
    if (!fit) {
      skipped.push(bubble.id);
      continue;
    }
    context.font = `${settings.fontWeight} ${fit.size}px ${settings.fontFamily}, sans-serif`;
    const area = textBox(fit, line => context.measureText(line).width, bubble.bounds);
    const shape = bubble.enclosed === false ? undefined : bubble.shape;
    jobs.push({ bubble, fit, paint: choosePaint(context, area, fit.size, shape) });
  }
  // Pass 2: draw.
  for (const { bubble, fit, paint } of jobs) {
    const { x, y, width, height } = bubble.bounds;
    const { center } = fit;
    context.fillStyle = paint.fill;
    context.strokeStyle = paint.stroke;
    context.lineWidth = paint.strokeWidth;
    context.lineJoin = 'round';
    context.font = `${settings.fontWeight} ${fit.size}px ${settings.fontFamily}, sans-serif`;
    const top = center.y - (fit.lines.length - 1) * fit.lineHeight / 2;
    context.save();
    context.beginPath();
    context.rect(x, y, width, height);
    context.clip();
    if (bubble.shape && bubble.shape.length >= 3) {
      context.beginPath();
      context.moveTo(bubble.shape[0].x, bubble.shape[0].y);
      for (const point of bubble.shape.slice(1)) context.lineTo(point.x, point.y);
      context.closePath();
      context.clip();
    }
    for (const [index, line] of fit.lines.entries()) {
      const lineY = top + index * fit.lineHeight;
      const width = fit.scaleX < 1 ? context.measureText(line).width * fit.scaleX : undefined;
      context.strokeText(line, center.x, lineY, width);
      context.fillText(line, center.x, lineY, width);
    }
    context.restore();
  }
  return skipped;
}
