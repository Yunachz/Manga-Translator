import { isChapterAction } from '../core/chapter/ChapterRun';
import { ChapterSessions } from '../core/chapter/ChapterSessions';
import { chapterSite, namedChapterSite } from '../core/chapter/readerSites';
import { captureVisibleArea } from '../core/image/captureVisibleArea';
import { acquireRenderedImage } from '../core/image/LocalImageAcquire';
import { cache } from '../core/cache/CacheManager';
import { JobQueue } from '../core/pipeline/JobQueue';
import { advance } from '../core/pipeline/PanelJob';
import { Pipeline, testProvider } from '../core/pipeline/Pipeline';
import { chromeProxy, inferenceProgress } from '../core/pipeline/OffscreenClient';
import { errorDetails, PipelineError } from '../core/pipeline/PipelineError';
import { hostPattern } from '../messaging/permission';
import { readerPort, type ClearProbe, type PopupEvent, type ReaderEvent, type ReaderInfo, type ReaderProbe, type TabStatus, type VisiblePagesProbe } from '../messaging/protocol';
import { readerInfo, readerRequest, record } from '../messaging/validate';
import { scopedCanvasSelector } from '../core/surface/adapters';
import { credential, saveCredential } from '../storage/credentials';
import { providerId, readSettings, restrictStorage, updateSettings } from '../storage/settings';
import type { InferenceResponse } from '../messaging/inference';
import type { JobStatus, PanelJob, Settings, TranslationSegment } from '../types/contracts';

const tabKey = (id: number) => `reader-tab:${id}`;
const queue = new JobQueue();
const pipeline = new Pipeline();
const readers = new Map<number, Set<chrome.runtime.Port>>();
const resetReaderJobs = new WeakMap<chrome.runtime.Port, () => void>();
type SavedTab = TabStatus & { origin?: string; documentId?: string; panelMode?: boolean };
const chapters = new ChapterSessions(queue, pipeline, (tab, message) => {
  for (const port of readers.get(tab.id) ?? []) if (port.sender?.documentId === tab.documentId) post(port, message);
  if (message.type === 'CHAPTER_STATUS') notifyPopup(tab.id);
});

function notifyPopup(tabId: number): void {
  const message: PopupEvent = { to: 'popup', type: 'TAB_STATUS_CHANGED', tabId };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function getTab(id: number): Promise<SavedTab> {
  await restrictStorage();
  return (await chrome.storage.session.get(tabKey(id)))[tabKey(id)] as SavedTab | undefined ?? { active: false };
}
async function saveTab(id: number, value: SavedTab): Promise<void> {
  await chrome.storage.session.set({ [tabKey(id)]: value });
  notifyPopup(id);
}
function post(port: chrome.runtime.Port, message: ReaderEvent): void {
  try { port.postMessage(message); } catch { /* The reader was closed. */ }
}
function readerState(port: chrome.runtime.Port, settings: Settings, tab: SavedTab): void {
  post(port, { type: 'READER_STATE', uiLanguage: settings.uiLanguage, active: settings.enabled && tab.active && (!tab.documentId || port.sender?.documentId === tab.documentId), panelMode: tab.panelMode !== false, prefetch: settings.prefetch, debug: settings.debug });
}
async function syncTab(id: number, settings?: Settings) {
  const ports = readers.get(id);
  if (!ports?.size) return;
  const config = settings ?? await readSettings();
  const tab = await getTab(id);
  for (const port of ports) readerState(port, config, tab);
}

function originOf(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch { /* Non-web tab. */ }
}

async function readerInfoOf(id: number, tab: SavedTab, reconnect = false): Promise<ReaderInfo | undefined> {
  if (!tab.documentId) return;
  const message: ReaderProbe = { type: 'READER_PROBE', reconnect };
  return await chrome.tabs.sendMessage(id, message, { documentId: tab.documentId })
    .then(readerInfo).catch(() => undefined);
}

async function probe(id: number, tab: SavedTab, reconnect = false): Promise<boolean> {
  return !!await readerInfoOf(id, tab, reconnect);
}

/**
 * Whether a tab that has no reader yet shows a canvas reader the extension knows. The popup was opened on this tab,
 * so this runs on the user's own invocation. The page function only counts matching elements. Nothing is read.
 */
async function canvasHint(id: number): Promise<number> {
  const result = await chrome.scripting.executeScript({ target: { tabId: id }, args: [scopedCanvasSelector],
    func: (selector: string) => document.querySelectorAll(selector).length }).catch(() => undefined);
  const count = result?.[0]?.result;
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 && count < 5000 ? count : 0;
}

async function toggleTab(id: number, active: boolean, chapterOnly = false): Promise<TabStatus> {
  await restrictStorage();
  const previous = await getTab(id);
  if (!active) {
    const current = await chrome.tabs.get(id).catch(() => undefined);
    const keepChapter = !!chapters.status(id, chapterSite(current?.url ?? ''));
    await saveTab(id, { ...previous, active: keepChapter, panelMode: false });
    await syncTab(id);
    return { active: false };
  }
  if (!(await readSettings()).enabled) throw new PipelineError('INTERNAL', 'Aktifkan extension terlebih dahulu.');
  const tab = await chrome.tabs.get(id);
  const origin = originOf(tab.url);
  if (!origin || !tab.active) throw new PipelineError('IMAGE_UNSUPPORTED', 'Buka halaman HTTP(S) reader aktif terlebih dahulu.');
  if (previous.origin === origin && await probe(id, previous)) {
    const current = { ...previous, active: true, panelMode: !chapterOnly };
    await saveTab(id, current);
    if (!readers.get(id)?.size) await probe(id, current, true);
    await syncTab(id);
    return { active: !chapterOnly, pendingOrigin: current.pendingOrigin };
  }
  await saveTab(id, { active: true, origin, panelMode: !chapterOnly });
  try {
    const [injected] = await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content-scripts/content.js'] });
    const state = await getTab(id);
    if (injected?.documentId && state.active && state.origin === origin && !state.documentId) {
      await saveTab(id, { ...state, documentId: injected.documentId });
    }
  } catch {
    await saveTab(id, { active: false });
    throw new PipelineError('IMAGE_UNSUPPORTED', 'Extension tidak dapat aktif di tab ini. Buka kembali reader dan coba lagi.');
  }
  await syncTab(id);
  return { active: !chapterOnly };
}

function registerReader(port: chrome.runtime.Port): void {
  const { sender } = port;
  const id = sender?.tab?.id;
  const origin = originOf(sender?.url);
  const documentId = sender?.documentId;
  if (port.name !== readerPort || sender?.id !== chrome.runtime.id || id === undefined ||
      sender.frameId !== 0 || !origin || !documentId) { port.disconnect(); return; }
  const namespace = `${id}:${documentId}:${crypto.randomUUID()}`;
  const jobs = new Map<string, string>();
  const prefetching = new Set<string>();
  let previous: TranslationSegment[] | undefined;
  let generation = 0;
  let disconnected = false;
  const ports = readers.get(id) ?? new Set<chrome.runtime.Port>();
  readers.set(id, ports);
  ports.add(port);
  resetReaderJobs.set(port, () => {
    generation++;
    previous = undefined;
    for (const entry of jobs.values()) queue.cancel(entry);
    jobs.clear();
    prefetching.clear();
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    for (const entry of jobs.values()) queue.cancel(entry);
    ports.delete(port);
    if (!ports.size) {
      readers.delete(id);
      chapters.forget(id);
      notifyPopup(id);
    }
  });

  const initial = (async () => {
    const tab = await getTab(id);
    if (tab.origin !== origin || (tab.documentId && tab.documentId !== documentId)) {
      port.disconnect();
      return false;
    }
    if (tab.active && !tab.documentId) await saveTab(id, { ...tab, documentId });
    if (!disconnected) readerState(port, await readSettings(), tab);
    return true;
  })().catch(() => false);

  port.onMessage.addListener((raw: unknown) => {
    const message = readerRequest(raw);
    if (!message || disconnected) return;
    if (message.type === 'CANCEL') {
      const entry = jobs.get(message.id);
      if (entry) queue.cancel(entry);
      return;
    }
    const epoch = generation;
    void (async () => {
      if (!await initial || disconnected) return;
      const tab = await getTab(id);
      const settings = await readSettings();
      if (epoch !== generation || jobs.has(message.id)) return;
      if (message.type === 'GET_CHAPTER_PATCH' || message.type === 'CHAPTER_COMMAND') {
        if (!tab.active || !settings.enabled || tab.documentId !== documentId) return;
        if (message.type === 'GET_CHAPTER_PATCH') {
          const patch = await chapters.patch({ id, documentId }, message).catch(() => undefined);
          if (epoch === generation) post(port, { type: 'CHAPTER_PATCH', id: message.id, patch });
        } else {
          const current = await chrome.tabs.get(id).catch(() => undefined);
          const site = chapterSite(current?.url ?? '');
          if (site) chapters.control({ id, origin, documentId, site }, message.command, settings, message.run);
        }
        return;
      }
      if (!tab.active || !settings.enabled || tab.documentId !== documentId) {
        if (message.type === 'PROCESS_PANEL') post(port, { type: 'JOB_ERROR', id: message.id, image: message.image,
          error: { code: 'INTERNAL', message: 'Mode tab tidak aktif. Aktifkan kembali dari popup.' } });
        return;
      }
      if (tab.panelMode === false) return;
      const entryId = `${namespace}:${message.id}`;
      const isPrefetch = message.type === 'PREFETCH';
      if (isPrefetch && (!settings.prefetch || prefetching.size >= 2 || prefetching.has(message.image.id))) return;
      if (isPrefetch) prefetching.add(message.image.id);
      jobs.set(message.id, entryId);
      const jobId = message.id;
      let job: PanelJob = { id: jobId, image: message.image, status: 'QUEUED' };
      const panels = (data: import('../types/contracts').PanelRegion[]) => {
        if (epoch === generation) post(port, { type: 'PANEL_MAP', image: message.image, panels: data });
      };
      function progress(stage: JobStatus) {
        if (stage === job.status) return;
        // Inference progress messages can arrive after the corresponding result.
        try { job = advance(job, stage); } catch { return; }
        post(port, { type: 'JOB_PROGRESS', id: jobId, stage });
      }
      if (!isPrefetch) post(port, { type: 'JOB_PROGRESS', id: message.id, stage: 'QUEUED' });
      try {
        await queue.enqueue(entryId, async signal => {
          if (isPrefetch) {
            const data = await pipeline.prefetch(namespace, message.image, origin, settings, signal);
            signal.throwIfAborted();
            panels(data);
            return;
          }
          const capture = message.visibleCapture ? () => captureVisibleArea({ tabId: id, documentId, jobId }, signal) : undefined;
          const location = await chrome.tabs.get(id).catch(() => undefined);
          const recoverBubble = !!namedChapterSite(location?.url ?? '');
          const result = await pipeline.run(namespace, message, origin, settings, previous, signal, { progress, panels }, capture, recoverBubble,
            (image, localSignal) => acquireRenderedImage({ tabId: id, documentId, jobId, origin }, image, localSignal));
          signal.throwIfAborted();
          if (epoch !== generation) return;
          if (!settings.usePreviousPanel || !settings.contextual) previous = undefined;
          else if (!result.cached) previous = result.segments;
          progress('DONE');
          post(port, { type: 'JOB_COMPLETE', id: message.id, image: message.image, patch: result.patch, cached: result.cached });
        }, !isPrefetch);
      } catch (error) {
        if (epoch !== generation || isPrefetch) return;
        const details = errorDetails(error);
        if (details.origin) {
          const current = await getTab(id);
          if (epoch !== generation) return;
          if (current.documentId === documentId && current.active) await saveTab(id, { ...current, pendingOrigin: details.origin });
        }
        if (epoch !== generation) return;
        progress(details.code === 'CANCELLED' ? 'CANCELLED' : 'ERROR');
        post(port, { type: 'JOB_ERROR', id: message.id, image: message.image, error: details });
      } finally {
        jobs.delete(message.id);
        if (isPrefetch) prefetching.delete(message.image.id);
      }
    })().catch(() => undefined);
  });
}

async function trustedUi(message: Record<string, unknown>, options: boolean): Promise<unknown> {
  switch (message.type) {
    case 'GET_SETTINGS': return readSettings();
    case 'GET_CHROME': return chromeProxy.isAvailable();
    case 'GET_TAB':
      if (Number.isInteger(message.tabId)) {
        const status = await getTab(message.tabId as number);
        const allowed = status.pendingOrigin &&
          await chrome.permissions.contains({ origins: [hostPattern(status.pendingOrigin)] });
        const info = await readerInfoOf(message.tabId as number, status);
        const readerReady = !!info;
        const active = status.active && readerReady;
        const browserTab = await chrome.tabs.get(message.tabId as number).catch(() => undefined);
        const site = chapterSite(browserTab?.url ?? '');
        // A canvas reader has no page list to fetch: it gets the visible-pages mode instead of a chapter run.
        const hinted = !info && site && browserTab?.active ? await canvasHint(message.tabId as number) : 0;
        const canvasPages = info?.canvasPages ?? hinted;
        const visiblePages = canvasPages > 0 ? { canvasPages, visiblePages: info?.visiblePages ?? canvasPages, ...(info?.run ? { run: info.run } : {}) } : undefined;
        return { active: active && status.panelMode !== false, readerReady, pendingOrigin: !active || allowed ? undefined : status.pendingOrigin,
          chapterAvailable: !!site && !visiblePages, chapterScope: site && !visiblePages ? (site.site === 'generic' ? 'mounted' : 'full') : undefined,
          chapter: chapters.status(message.tabId as number, site), ...(visiblePages ? { visiblePages } : {}) };
      }
      break;
    case 'SET_TAB':
      if (Number.isInteger(message.tabId) && typeof message.active === 'boolean') return toggleTab(message.tabId as number, message.active);
      break;
    case 'CLEAR_TRANSLATIONS': {
      if (typeof message.tabId !== 'number' || !Number.isInteger(message.tabId)) break;
      const id = message.tabId;
      const current = await chrome.tabs.get(id).catch(() => undefined);
      const tab = await getTab(id);
      if (!current?.active || !tab.documentId) {
        throw new PipelineError('INTERNAL', 'Tidak ada terjemahan yang bisa dibersihkan di tab aktif.');
      }
      chapters.forget(id);
      for (const port of readers.get(id) ?? []) {
        if (port.sender?.documentId !== tab.documentId) continue;
        resetReaderJobs.get(port)?.();
      }
      const probe: ClearProbe = { type: 'CLEAR_READER_TRANSLATIONS' };
      const acknowledged = await chrome.tabs.sendMessage(id, probe, { documentId: tab.documentId }).catch(() => undefined);
      if (tab.pendingOrigin) await saveTab(id, { ...tab, pendingOrigin: undefined });
      else notifyPopup(id);
      await cache.deleteChapterPatches(id, tab.documentId);
      if (acknowledged !== true) throw new PipelineError('INTERNAL', 'Reader belum terhubung. Coba lagi.');
      return true;
    }
    case 'RESUME_AFTER_PERMISSION':
      if (typeof message.tabId === 'number' && Number.isInteger(message.tabId)) {
        await chapters.resumeGrantedPermissions(message.tabId);
        return true;
      }
      break;
    case 'CHAPTER_CONTROL': {
      if (!Number.isInteger(message.tabId) || (message.command !== 'start' && !isChapterAction(message.command))) break;
      const id = message.tabId as number;
      const browserTab = await chrome.tabs.get(id).catch(() => undefined);
      const site = chapterSite(browserTab?.url ?? '');
      const origin = originOf(browserTab?.url);
      if (!site || !origin || !browserTab?.active) {
        throw new PipelineError('IMAGE_UNSUPPORTED', 'Buka halaman HTTP(S) reader aktif terlebih dahulu.');
      }
      const settings = await readSettings();
      if (!settings.enabled) throw new PipelineError('INTERNAL', 'Aktifkan extension terlebih dahulu.');
      if (message.command === 'start') {
        const state = await getTab(id);
        await toggleTab(id, true, !state.active || state.panelMode === false);
      }
      const saved = await getTab(id);
      if (!saved.documentId) throw new PipelineError('INTERNAL', 'Reader belum terhubung. Coba lagi.');
      return chapters.control({ id, origin, site, documentId: saved.documentId }, message.command, settings);
    }
    case 'VISIBLE_PAGES': {
      if (!Number.isInteger(message.tabId) || (message.command !== 'start' && message.command !== 'stop')) break;
      const id = message.tabId as number;
      const browserTab = await chrome.tabs.get(id).catch(() => undefined);
      if (!originOf(browserTab?.url) || !browserTab?.active) {
        throw new PipelineError('IMAGE_UNSUPPORTED', 'Buka halaman HTTP(S) reader aktif terlebih dahulu.');
      }
      // Starting works on a fresh tab: this turns panel mode on and injects the reader first.
      if (message.command === 'start') {
        if (!(await readSettings()).enabled) throw new PipelineError('INTERNAL', 'Aktifkan extension terlebih dahulu.');
        const state = await getTab(id);
        if (!state.active || state.panelMode === false || !state.documentId) await toggleTab(id, true, false);
      }
      const saved = await getTab(id);
      if (!saved.documentId) throw new PipelineError('INTERNAL', 'Reader belum terhubung. Coba lagi.');
      const command: VisiblePagesProbe = { type: 'VISIBLE_PAGES', command: message.command };
      const reply = await chrome.tabs.sendMessage(id, command, { documentId: saved.documentId }).then(readerInfo).catch(() => undefined);
      if (!reply) throw new PipelineError('INTERNAL', 'Reader belum terhubung. Coba lagi.');
      notifyPopup(id);
      return reply;
    }
    case 'SET_SETTINGS': {
      if (!record(message.patch)) break;
      const { enabled, provider, source, target, uiLanguage, inpaintingMode } = message.patch;
      const patch = options ? message.patch : Object.fromEntries(Object.entries({ enabled, provider, source, target, uiLanguage, inpaintingMode })
        .filter(([, value]) => value !== undefined));
      const settings = await updateSettings(patch);
      if (!settings.enabled) {
        for (const [id] of readers) {
          chapters.forget(id);
          await saveTab(id, { ...(await getTab(id)), active: false, panelMode: false });
        }
      }
      await Promise.all([...readers.keys()].map(id => syncTab(id, settings)));
      return settings;
    }
    case 'GET_CREDENTIAL':
      if (options && providerId(message.provider)) {
        const secret = await credential(message.provider);
        return { present: !!secret.key, remembered: secret.remembered };
      }
      break;
    case 'SET_CREDENTIAL':
      if (options && providerId(message.provider) && typeof message.remember === 'boolean' &&
          (message.key === undefined || (typeof message.key === 'string' && message.key.length <= 4096))) {
        await saveCredential(message.provider, message.key as string | undefined, message.remember);
        const secret = await credential(message.provider);
        return { present: !!secret.key, remembered: secret.remembered };
      }
      break;
    case 'TEST_PROVIDER':
      if (options && providerId(message.provider)) return testProvider({ ...await readSettings(), provider: message.provider });
      break;
    case 'CLEAR_CACHE':
      if (options) return cache.clear();
      break;
  }
  throw new PipelineError('INTERNAL', 'Instruksi extension tidak valid.');
}

export default defineBackground(() => {
  void restrictStorage().catch(() => undefined);
  chrome.runtime.onConnect.addListener(registerReader);
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !record(message) || message.to !== 'background') return;
    if (sender.url === chrome.runtime.getURL('offscreen.html') && message.type === 'INFERENCE_PROGRESS' &&
        typeof message.id === 'string' && typeof message.stage === 'string') {
      inferenceProgress(message as unknown as InferenceResponse);
      return;
    }
    const options = sender.url === chrome.runtime.getURL('options.html');
    if (!options && sender.url !== chrome.runtime.getURL('popup.html')) return;
    void trustedUi(message, options).then(output => respond({ ok: true, output: output ?? null }),
      error => respond({ ok: false, error: errorDetails(error) }));
    return true;
  });
  chrome.permissions.onAdded.addListener(permissions => {
    if (permissions.origins?.length) void chapters.resumeGrantedPermissions().catch(() => undefined);
  });
  chrome.tabs.onRemoved.addListener(id => {
    chapters.forget(id);
    void chrome.storage.session.remove(tabKey(id));
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.url) {
      chapters.onNavigation(id, change.url);
      notifyPopup(id);
    }
  });
});
