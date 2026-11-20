import { sha256 } from '../cache/identity';
import { runInference } from '../pipeline/OffscreenClient';
import { PipelineError } from '../pipeline/PipelineError';
import type { CaptureFrame, CaptureProbe } from '../../messaging/protocol';
import { captureFrame } from '../../messaging/validate';
import type { AcquiredImage } from './ImageFetcher';
import { sameCaptureFrame } from './captureFrame';
import { rasterBlob } from './rasterDataUrl';

interface CaptureTarget { tabId: number; documentId: string; jobId: string }

function denied(message: string): PipelineError {
  return new PipelineError('CAPTURE_UNAVAILABLE', message);
}

async function ask(target: CaptureTarget, phase: CaptureProbe['phase']): Promise<CaptureFrame | undefined> {
  const message: CaptureProbe = { type: 'CAPTURE_PROBE', id: target.jobId, phase };
  const result: unknown = await chrome.tabs.sendMessage(target.tabId, message, { documentId: target.documentId }).catch(() => undefined);
  return captureFrame(result);
}

export async function captureVisibleArea(target: CaptureTarget, signal: AbortSignal): Promise<AcquiredImage> {
  signal.throwIfAborted();
  const tab = await chrome.tabs.get(target.tabId).catch(() => undefined);
  if (!tab?.active) throw denied('Buka kembali tab reader dan pilih area yang terlihat.');
  let switched = false;
  const onActivated = (info: { tabId: number; windowId: number }) => {
    if (info.windowId === tab.windowId && info.tabId !== target.tabId) switched = true;
  };
  chrome.tabs.onActivated.addListener(onActivated);

  let screenshot: string;
  let frame: CaptureFrame;
  try {
    const prepared = await ask(target, 'prepare');
    if (!prepared) throw denied('Tampilkan seluruh area yang dipilih di layar, lalu pilih ulang area.');
    frame = prepared;
    signal.throwIfAborted();
    const current = await chrome.tabs.get(target.tabId).catch(() => undefined);
    if (!current?.active || current.windowId !== tab.windowId || switched) throw denied('Tab reader berpindah. Pilih ulang area.');
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => {
      throw denied('Browser tidak dapat menangkap tab. Buka popup, aktifkan kembali mode, lalu pilih area.');
    });
    const after = await ask(target, 'validate');
    if (switched || !sameCaptureFrame(frame, after)) throw denied('Tampilan reader berubah saat diproses. Pilih ulang area.');
    signal.throwIfAborted();
  } finally {
    chrome.tabs.onActivated.removeListener(onActivated);
    await ask(target, 'restore');
  }
  if (!screenshot.startsWith('data:image/png;base64,') || screenshot.length > 32_000_000) {
    throw denied('Tampilan tab terlalu besar untuk diproses. Perkecil ukuran jendela dan coba lagi.');
  }
  const cropped = await runInference('captureCrop', { screenshot, bounds: frame.bounds }, undefined, signal);
  const blob = rasterBlob(cropped);
  return { blob, hash: await sha256(await blob.arrayBuffer()) };
}
