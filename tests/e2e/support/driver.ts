import type { Locator, Page } from '@playwright/test';
import type { LaunchedExtension } from './extension';
import { openExtensionPage } from './extension';

/**
 * Drives the built extension the way the UI does.
 *
 * Settings, credentials and activation go through the same `{ to: 'background', type }` messages that
 * src/messaging/protocol.ts defines for Options and Popup, sent from a real extension-origin document
 * (the background only trusts senders whose URL is options.html or popup.html).
 */

declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  tabs: { query(query: unknown): Promise<{ id?: number; url?: string }[]>; update(id: number, props: unknown): Promise<unknown> };
};

export type Reply<T = unknown> = { ok: true; output: T } | { ok: false; error: { code: string; message: string; origin?: string } };

export class OptionsClient {
  private constructor(private readonly ext: LaunchedExtension, readonly page: Page) {}

  static async open(ext: LaunchedExtension): Promise<OptionsClient> {
    const page = await openExtensionPage(ext, 'options.html');
    await page.waitForLoadState('domcontentloaded');
    return new OptionsClient(ext, page);
  }

  /** Raw reply, so tests can assert on failures. */
  send<T = unknown>(message: Record<string, unknown>): Promise<Reply<T>> {
    return this.page.evaluate(m => chrome.runtime.sendMessage({ to: 'background', ...m }), message) as Promise<Reply<T>>;
  }

  async request<T = unknown>(message: Record<string, unknown>): Promise<T> {
    const reply = await this.send<T>(message);
    if (!reply.ok) throw new Error(`${String(message.type)} failed: ${reply.error.code} ${reply.error.message}`);
    return reply.output;
  }

  setSettings(patch: Record<string, unknown>) {
    return this.request<Record<string, unknown>>({ type: 'SET_SETTINGS', patch });
  }

  /** Stores the mock sentinel for the session only (`remember: false`). Never pass a real key. */
  setCredential(provider: string, key: string) {
    return this.request<{ present: boolean }>({ type: 'SET_CREDENTIAL', provider, key, remember: false });
  }

  testProvider(provider: string) {
    return this.send({ type: 'TEST_PROVIDER', provider });
  }

  clearCache() {
    return this.request({ type: 'CLEAR_CACHE' });
  }

  /** Makes `reader` the active tab and asks the background to activate it, as the popup toggle does. */
  async activate(reader: Page, active = true): Promise<Reply<{ active: boolean }>> {
    const tabId = await this.tabIdOf(reader);
    await reader.bringToFront();
    await this.ext.serviceWorker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
    return this.send<{ active: boolean }>({ type: 'SET_TAB', tabId, active });
  }

  tabStatus(tabId: number) {
    return this.request<{ active: boolean; pendingOrigin?: string }>({ type: 'GET_TAB', tabId });
  }

  /** Id of the active tab, after bringing `page` to the front. Works without host access, where `tab.url` is hidden. */
  async tabIdOf(page: Page): Promise<number> {
    await page.bringToFront();
    const tabs = await this.ext.serviceWorker.evaluate(() => chrome.tabs.query({ active: true }));
    const tab = tabs.find(candidate => candidate.url === undefined || candidate.url === page.url());
    if (!tab?.id) throw new Error(`no active tab for ${page.url()}`);
    return tab.id;
  }
}

/** The reader overlay (open shadow root of <manga-translator-layer>). Selectors pierce it. */
export class Overlay {
  constructor(private readonly page: Page) {}

  get host(): Locator { return this.page.locator('manga-translator-layer'); }
  get status(): Locator { return this.page.locator('manga-translator-layer .status'); }
  get patches(): Locator { return this.page.locator('manga-translator-layer canvas.patch'); }
  button(name: string): Locator { return this.page.locator('manga-translator-layer button', { hasText: name }); }
}

export const copy = {
  idle: 'Klik panel yang ingin diterjemahkan.',
  translating: 'Menerjemahkan…',
  done: 'Panel diterjemahkan.',
  cancelled: 'Terjemahan dibatalkan.',
  noPanel: 'Panel tidak dapat ditentukan',
  imagePermission: 'Izinkan domain gambar',
  rateLimited: 'Provider membatasi request',
  showOriginal: 'Tampilkan asli',
  showTranslation: 'Tampilkan terjemahan',
  cancel: 'Batalkan',
  retry: 'Coba lagi',
} as const;
