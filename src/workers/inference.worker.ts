import { cache } from '../core/cache/CacheManager';
import { detectBubbles } from '../core/detection/BubbleDetector';
import { subtractCoverage } from '../core/image/translatedCoverage';
import { TextDetector } from '../core/detection/TextDetector';
import { cropBounds, pointInPolygon } from '../core/image/geometry';
import { rasterBlob } from '../core/image/rasterDataUrl';
import { canvas2d, drawCrop, rasterDataUrl, scaleDimensions } from '../core/image/raster';
import { InpaintEngine } from '../core/inpainting/InpaintEngine';
import { classifyLine, typicalLettering as typicalHeight } from '../core/inpainting/classifyLine';
import { mergeLineMasks } from '../core/inpainting/MaskRegions';
import type { MaskRegion } from '../core/inpainting/TextMask';
import { planDialogueMasks } from '../core/inpainting/planDialogueMasks';
import { ModelManager } from '../core/models/ModelManager';
import { inferPanelLanguage, PaddleOCRProvider } from '../core/ocr/PaddleOCRProvider';
import { separateArtworkMarks } from '../core/ocr/artworkMarks';
import { isSeamFragment } from '../core/ocr/seamFragments';
import { recoverHorizontalText } from '../core/ocr/recoverHorizontalText';
import { PanelEngine } from '../core/panel/PanelEngine';
import { errorDetails, PipelineError } from '../core/pipeline/PipelineError';
import { resolveReadingOrder, speechLineOrder } from '../core/reading-order/ReadingOrderResolver';
import { separateAmbiguousBubbles, uniqueIds } from '../core/typesetting/bubbleIds';
import { prepareLettering } from '../core/typesetting/prepareLettering';
import { drawTranslation } from '../core/typesetting/Renderer';
import type { InferenceOperations, InferenceResponse, OCRPanel, WorkerMessage } from '../messaging/inference';
import type { JobStatus, PanelRegion, RenderedPatch } from '../types/contracts';

const models = new ModelManager();
const panels = new PanelEngine(models);
const detector = new TextDetector(models);
const ocr = new PaddleOCRProvider(models);
const inpaint = new InpaintEngine(models);

function send(message: InferenceResponse) { self.postMessage(message); }

async function bitmap(key: string): Promise<ImageBitmap> {
  const blob = await cache.get<Blob>('transfer', key);
  if (!blob) throw new PipelineError('IMAGE_FETCH', 'Berkas gambar tidak tersedia. Coba lagi.');
  const image = await createImageBitmap(blob).catch(() => {
    throw new PipelineError('IMAGE_UNSUPPORTED', 'Format gambar tidak didukung untuk pemrosesan lokal.');
  });
  if (image.width * image.height > 44_000_000 || image.width > 26_000 || image.height > 36_000) {
    image.close();
    throw new PipelineError('IMAGE_UNSUPPORTED', 'Dimensi gambar terlalu besar untuk diproses.');
  }
  return image;
}

async function captureCrop({ screenshot, bounds }: InferenceOperations['captureCrop']['input']): Promise<string> {
  const image = await createImageBitmap(rasterBlob(screenshot, 32_000_000)).catch(() => {
    throw new PipelineError('CAPTURE_UNAVAILABLE', 'Piksel tab tidak dapat dibaca. Pilih ulang area.');
  });
  try {
    const area = cropBounds(bounds, image.width, image.height);
    const [width, height] = scaleDimensions(area.width, area.height, 2100, 2_500_000);
    return await rasterDataUrl(drawCrop(image, area, width, height).canvas);
  } finally {
    image.close();
  }
}

async function crop(key: string, panel: PanelRegion) {
  const image = await bitmap(key);
  try {
    const area = cropBounds(panel.bounds, image.width, image.height);
    const [width, height] = scaleDimensions(area.width, area.height, 2100, 2_500_000);
    return drawCrop(image, area, width, height);
  } finally {
    image.close();
  }
}

type Report = (status: JobStatus) => void;

async function detect(input: InferenceOperations['detect']['input']): Promise<PanelRegion[]> {
  const image = await bitmap(input.key);
  try { return await panels.detect(image, input.preference); }
  finally { image.close(); }
}

async function read(input: InferenceOperations['read']['input'], report: Report, signal: AbortSignal): Promise<OCRPanel> {
  const { panel, settings } = input;
  report('PANEL_CROP');
  const context = await crop(input.key, panel);
  report('TEXT_DETECTION');
  const detected = await detector.detect(context.canvas, settings.performance, signal).catch(error => {
    signal.throwIfAborted();
    if (error instanceof PipelineError) throw error;
    throw new PipelineError('OCR_FAILED', 'Deteksi teks lokal gagal.');
  });
  if (!detected.regions.length) throw new PipelineError('NO_TEXT', 'Tidak ada teks yang terdeteksi pada panel.');
  report('OCR');
  const preferred = settings.ocrLanguage === 'auto' ? settings.source : settings.ocrLanguage;
  const recognize = (regions: typeof detected.regions, language: typeof preferred) =>
    ocr.recognize(context.canvas, regions, language, settings.performance, signal);
  let recognized = await recognize(detected.regions, preferred).catch(error => {
    signal.throwIfAborted();
    if (error instanceof PipelineError) throw error;
    throw new PipelineError('OCR_FAILED', 'Pembacaan teks lokal gagal.');
  });
  const guess = inferPanelLanguage(recognized.lines);
  if (preferred === 'auto' && guess === 'ko') {
    recognized = await recognize(detected.regions, 'ko');
  }
  const raster = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  const recovered = await recoverHorizontalText(raster, detected.regions, recognized.lines, preferred === 'auto' ? guess : preferred,
    async regions => (await recognize(regions, 'en')).lines,
    bounds => detector.retryInside(context.canvas, bounds, settings.performance), signal);
  const dialogue = separateArtworkMarks(recovered.lines, Math.max(15, raster.width / 38));
  recognized.lines = dialogue.lines;
  if (!recognized.lines.length) throw new PipelineError('NO_TEXT', 'OCR belum dapat membaca teks panel ini. Periksa bahasa atau pilih area yang lebih sempit.');
  report('READING_ORDER');
  const source = settings.source !== 'auto' ? settings.source : settings.ocrLanguage !== 'auto' ? settings.ocrLanguage : guess;
  const order = settings.readingOrder === 'auto' ? source === 'ja' ? 'rtl' : 'ttb' : settings.readingOrder;
  let groups = detectBubbles(raster, recognized.lines);
  const unread = [...recovered.unread];
  for (const [index, bounds] of recovered.unread.entries()) {
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    const inside = groups.find(({ bubble }) => bubble.shape && pointInPolygon({ x, y }, bubble.shape)) ??
      groups.find(({ bubble: { bounds: box, shape } }) => !shape &&
        x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height);
    if (!inside) continue;
    unread.splice(unread.indexOf(bounds), 1);
    // A sliver on the seam between two lines of the caption belongs to them. It is neither text left unread nor a line.
    if (isSeamFragment(bounds, inside.recognized.map(line => line.bounds))) continue;
    inside.recognized.push({ id: `unread-${index + 1}`, text: '', confidence: 0, bounds, vertical: false });
  }
  if (input.focus) {
    const mouseX = input.focus.x * raster.width;
    const mouseY = input.focus.y * raster.height;
    const candidates = groups.filter(({ bubble: { bounds } }) =>
      mouseX >= bounds.x && mouseX <= bounds.x + bounds.width &&
      mouseY >= bounds.y && mouseY <= bounds.y + bounds.height);
    const distance = ({ bubble: { bounds } }: typeof groups[number]) =>
      Math.hypot(mouseX - bounds.x - bounds.width / 2, mouseY - bounds.y - bounds.height / 2);
    const target = candidates.sort((a, b) => distance(a) - distance(b))[0];
    if (!target) throw new PipelineError('PANEL_NOT_FOUND', 'Panel tidak dapat ditentukan. Klik di dalam balon dialog atau gunakan Pilih area.');
    groups = [target];
  }
  const protectedRegions = (input.protectedRegions ?? []).map(rect => ({
    x: rect.x * raster.width, y: rect.y * raster.height, width: rect.width * raster.width, height: rect.height * raster.height,
  }));
  const typicalLettering = typicalHeight(groups, raster.width);
  const lineContext = { raster, source, mode: settings.inpaintingMode, typicalLettering, protectedRegions };
  const decisions = groups.map(group => planDialogueMasks(group, line => classifyLine(lineContext, group, line)));
  const safeGroups = decisions.flatMap(decision => decision.ready);
  const unfinished = decisions.flatMap(decision => decision.keep);
  if (!safeGroups.length) {
    if (!unfinished.length) throw new PipelineError('ALREADY_TRANSLATED', 'Dialog yang terbaca di area ini sudah diterjemahkan.');
    throw new PipelineError('INPAINT_FAILED', 'Mask teks belum cukup aman. Pilih area di sekitar satu balon dialog.');
  }
  const sorted = resolveReadingOrder(safeGroups.map(group => ({ ...group, bounds: group.bubble.bounds })), order, source);
  const ids = uniqueIds(sorted.map(group => group.bubble.id));
  const ordered = sorted.map((group, index) => ids[index] === group.bubble.id ? group
    : { ...group, bubble: { ...group.bubble, id: ids[index] } }).slice(0, 50);
  const overflow = sorted.slice(50);
  return {
    source, skippedBubbles: decisions.filter(decision => decision.keep.length).length + overflow.length + unread.length,
    remaining: [...unfinished, ...unread, ...overflow.map(group => group.bubble.bounds)],
    preserve: [...decisions.flatMap(decision => decision.untouched), ...unread, ...dialogue.marks,
      ...overflow.flatMap(group => group.bubble.lines.map(line => line.bounds))],
    segments: ordered.map(group => ({ id: group.bubble.id, text: speechLineOrder(group.recognized)
      .map(line => line.text).join(source === 'ja' || source === 'zh' ? '' : ' ').slice(0, 2000) })),
    debug: { text: detected.regions, bubbles: ordered.map(group => group.bubble),
      ordered: ordered.flatMap(group => speechLineOrder(group.recognized)), backend: recognized.backend },
  };
}

async function maskPreview(width: number, height: number, masks: MaskRegion[]): Promise<string> {
  const context = canvas2d(width, height);
  context.fillStyle = 'rgba(236, 56, 88, .55)';
  for (const { bounds, mask } of masks) {
    for (let index = 0; index < mask.length; index++) {
      if (mask[index]) context.fillRect(bounds.x + index % bounds.width, bounds.y + Math.floor(index / bounds.width), 1, 1);
    }
  }
  const [w, h] = scaleDimensions(width, height, 700);
  const preview = canvas2d(w, h);
  preview.drawImage(context.canvas, 0, 0, w, h);
  return rasterDataUrl(preview.canvas);
}

async function render(input: InferenceOperations['render']['input'], report: Report, signal: AbortSignal): Promise<RenderedPatch> {
  const { panel, settings, reading, translation } = input;
  const context = await crop(input.key, panel);
  const { width, height } = context.canvas;
  const raster = context.getImageData(0, 0, width, height);
  report('TEXT_MASK');
  const paired = separateAmbiguousBubbles(reading.debug.bubbles, translation.segments);
  const held = { preserve: [...reading.preserve, ...paired.ambiguous.flatMap(bubble => bubble.lines.map(line => line.bounds))],
    remaining: [...reading.remaining, ...paired.ambiguous.map(bubble => bubble.bounds)] };
  const { prepared, preserve, remaining, skipped } = prepareLettering(context, raster, paired.bubbles, paired.segments, settings, held);
  const bubbles = prepared.map(({ bubble }) => bubble);
  if (!bubbles.length) throw new PipelineError('TYPESET_FAILED', 'Terjemahan terlalu panjang untuk ditempatkan di bubble.');
  const plans = new Map(prepared.map(({ bubble, plan }) => [bubble.id, plan]));
  const masks = prepared.flatMap(item => item.masks);
  report('INPAINT');
  const modes = await inpaint.clean(raster, prepared.map(({ masks }) => mergeLineMasks(masks)), settings, signal).catch(() => {
    signal.throwIfAborted();
    throw new PipelineError('INPAINT_FAILED', 'Pembersihan teks lokal gagal.');
  });
  context.putImageData(raster, 0, 0);
  report('TYPESET');
  drawTranslation(context, bubbles, { segments: paired.segments }, settings, plans);
  report('COMPOSITE');
  // Keep artwork around the translated dialogue transparent, even for a complete manual crop.
  const coverage = [...bubbles.map(bubble => bubble.bounds), ...masks.map(mask => mask.bounds)];
  context.save();
  context.globalCompositeOperation = 'destination-in';
  context.fillStyle = '#fff';
  context.beginPath();
  for (const rect of coverage) context.rect(rect.x, rect.y, rect.width, rect.height);
  context.fill();
  context.globalCompositeOperation = 'destination-out';
  for (const rect of preserve) context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.restore();
  return {
    panel, width, height, skippedBubbles: reading.skippedBubbles + skipped + paired.ambiguous.length,
    coverage: subtractCoverage(coverage, preserve)
      .map(rect => ({ x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height })),
    remaining: remaining.map(rect => ({ x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height })),
    dataUrl: await rasterDataUrl(context.canvas),
    debug: settings.debug ? { ...reading.debug, bubbles, inpainting: modes, mask: await maskPreview(width, height, masks) } : undefined,
  };
}

let processing = Promise.resolve();
const pending = new Map<string, AbortController>();
self.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
  const request = event.data;
  if ('abort' in request) {
    pending.get(request.abort)?.abort();
    return;
  }
  const controller = new AbortController();
  const { signal } = controller;
  pending.set(request.id, controller);
  processing = processing.then(async () => {
    const report: Report = stage => {
      signal.throwIfAborted();
      send({ id: request.id, stage });
    };
    try {
      signal.throwIfAborted();
      const output = request.op === 'captureCrop' ? await captureCrop(request.input)
        : request.op === 'detect' ? await detect(request.input)
        : request.op === 'read' ? await read(request.input, report, signal) : await render(request.input, report, signal);
      signal.throwIfAborted();
      send({ id: request.id, ok: true, output });
    } catch (error) {
      send({ id: request.id, ok: false, error: errorDetails(error) });
    } finally {
      pending.delete(request.id);
    }
  });
});
