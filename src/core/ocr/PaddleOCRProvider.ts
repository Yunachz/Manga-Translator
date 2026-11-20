import { Tensor } from 'onnxruntime-web';
import type { OCRResult, SourceLanguage, TextRegion } from '../../types/contracts';
import { canvas2d } from '../image/raster';
import { packagedAsset, type BackendPreference, type ModelManager } from '../models/ModelManager';
import { PipelineError } from '../pipeline/PipelineError';
import type { OCRProvider } from './OCRProvider';

export function decodeCTC(probabilities: Float32Array, classes: number, dictionary: string[]) {
  if (classes !== dictionary.length + 2 || probabilities.length % classes) throw new Error('Invalid OCR tensor shape');
  let text = '', score = 0, count = 0, previous = -1;
  for (let offset = 0; offset < probabilities.length; offset += classes) {
    let best = 0;
    for (let index = 1; index < classes; index++) {
      if (probabilities[offset + index] > probabilities[offset + best]) best = index;
    }
    if (best > 0 && best !== previous) {
      text += dictionary[best - 1] ?? ' ';
      score += probabilities[offset + best];
      count++;
    }
    previous = best;
  }
  return { text: text.trim(), confidence: count ? score / count : 0 };
}

function recognitionInput(image: OffscreenCanvas, region: TextRegion, rotate: boolean): Tensor {
  const { x, y, width: sourceWidth, height: sourceHeight } = region.bounds;
  const height = 48;
  const ratio = rotate ? sourceHeight / sourceWidth : sourceWidth / sourceHeight;
  const width = Math.min(1600, Math.max(1, Math.ceil(height * ratio)));
  const padded = Math.max(320, width);
  const context = canvas2d(width, height);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  if (rotate) {
    context.translate(0, height);
    context.rotate(-Math.PI / 2);
  }
  context.drawImage(image, x, y, sourceWidth, sourceHeight, 0, 0, rotate ? height : width, rotate ? width : height);
  const { data } = context.getImageData(0, 0, width, height);
  const values = new Float32Array(3 * height * padded);
  for (let channel = 0; channel < 3; channel++) {
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        values[(channel * height + row) * padded + col] = data[(row * width + col) * 4 + 2 - channel] / 127.5 - 1;
      }
    }
  }
  return new Tensor('float32', values, [1, 3, height, padded]);
}

type Recognizer = 'rec-cjk' | 'rec-ko' | 'rec-en';

export class PaddleOCRProvider implements OCRProvider {
  private readonly dictionaries = new Map<Recognizer, Promise<string[]>>();

  constructor(private readonly models: ModelManager) {}

  private dictionary(model: Recognizer): Promise<string[]> {
    const existing = this.dictionaries.get(model);
    if (existing) return existing;
    const loading = fetch(packagedAsset(`models/${model}.json`)).then(async response => {
      if (!response.ok) throw new Error();
      const entries: unknown = await response.json();
      if (!Array.isArray(entries) || !entries.every(item => typeof item === 'string')) throw new Error();
      return entries as string[];
    }).catch(() => {
      this.dictionaries.delete(model);
      throw new PipelineError('MODEL_LOAD', `Kamus model lokal "${model}" tidak tersedia.`);
    });
    this.dictionaries.set(model, loading);
    return loading;
  }

  async recognize(image: OffscreenCanvas, regions: TextRegion[], language: SourceLanguage, preference: BackendPreference, signal?: AbortSignal) {
    const model = language === 'ko' ? 'rec-ko' : language === 'en' ? 'rec-en' : 'rec-cjk';
    const dictionary = await this.dictionary(model);
    const lines: OCRResult[] = [];
    let backend = 'wasm';
    for (const [index, region] of regions.entries()) {
      signal?.throwIfAborted();
      const tall = region.bounds.height > region.bounds.width * 1.65;
      const first = await this.models.infer(model, { x: recognitionInput(image, region, tall) }, preference);
      backend = first.backend;
      const tensor = first.outputs.fetch_name_0;
      let decoded = decodeCTC(tensor.data as Float32Array, tensor.dims[2], dictionary);
      if (tall && decoded.confidence < 0.80) {
        const alternate = await this.models.infer(model, { x: recognitionInput(image, region, false) }, preference);
        const candidate = alternate.outputs.fetch_name_0;
        const result = decodeCTC(candidate.data as Float32Array, candidate.dims[2], dictionary);
        if (result.confidence > decoded.confidence) decoded = result;
      }
      if (decoded.text && decoded.confidence >= 0.33) {
        lines.push({ id: `line-${index + 1}`, ...decoded, bounds: region.bounds, vertical: tall });
      }
    }
    return { lines, backend };
  }
}

export function inferLanguage(text: string): Exclude<SourceLanguage, 'auto'> {
  if (/[\u3040-\u30ff]/u.test(text)) return 'ja';
  if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/u.test(text)) return 'ko';
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  return 'en';
}

/** A clipped, lone Han-like glyph should not determine the language of Latin dialogue. */
export function inferPanelLanguage(lines: OCRResult[]): Exclude<SourceLanguage, 'auto'> {
  const confident = lines.filter(line => line.confidence >= 0.62);
  const text = (confident.length ? confident : lines).map(line => line.text).join(' ');
  const guess = inferLanguage(text);
  if (guess === 'zh' && (text.match(/\p{Script=Han}/gu)?.length ?? 0) <= 2 &&
      (text.match(/[a-z]{3,}/gi)?.length ?? 0) >= 3) return 'en';
  return guess;
}
