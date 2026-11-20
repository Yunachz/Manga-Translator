import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { MockProviderServer } from './mock-provider-server';

export interface LaunchedExtension {
  context: BrowserContext;
  /** 32-character extension ID taken from the service worker URL. */
  id: string;
  serviceWorker: Worker;
  /** Console errors from the service worker and extension pages, collected from launch. */
  errors: string[];
  /** Every request URL the browser made, including the extension's own. */
  requestUrls: string[];
  dispose(): Promise<void>;
}

export interface LaunchOptions {
  /** Provider mock. Without it every external host fails to resolve. */
  mock?: MockProviderServer;
  /**
   * Host patterns added to `host_permissions` in a temporary COPY of the build, never in the build itself.
   * The real build ships optional hosts only, and Chromium offers no automation for the permission prompt,
   * so this stands in for "user granted the origin". Omit to test the build exactly as packaged.
   */
  grantHosts?: string[];
}

/** Copies the unpacked build to a temp dir, optionally widening `host_permissions`. Caller removes `dir`. */
export function prepareExtensionCopy(source: string, grantHosts: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'manga-e2e-ext-'));
  cpSync(source, dir, { recursive: true });
  if (grantHosts.length) {
    const path = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { host_permissions?: string[] };
    manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...grantHosts])];
    writeFileSync(path, JSON.stringify(manifest));
  }
  return dir;
}

/**
 * Starts a fresh persistent Chromium profile with the unpacked extension.
 *
 * Needs the full Chromium build (`npx playwright install chromium`); the headless shell cannot load
 * extensions. Provider hostnames resolve to the local mock and every other external host is blocked,
 * so a test run cannot reach a real service even if the extension tries.
 */
export async function launchExtension(extensionPath: string, { mock, grantHosts }: LaunchOptions = {}): Promise<LaunchedExtension> {
  const profile = mkdtempSync(join(tmpdir(), 'manga-e2e-profile-'));
  const copy = prepareExtensionCopy(extensionPath, grantHosts);
  extensionPath = copy;
  const errors: string[] = [];
  const requestUrls: string[] = [];
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--disable-background-networking',
      '--disable-component-update',
      ...(mock ? mock.chromiumArgs() : ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']),
    ],
  });
  context.on('request', request => requestUrls.push(request.url()));
  const watch = (target: Page | Worker) => {
    target.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  context.on('serviceworker', watch);
  context.on('page', watch);

  const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  watch(serviceWorker);
  const id = new URL(serviceWorker.url()).host;
  return {
    context, id, serviceWorker, errors, requestUrls,
    async dispose() {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
      rmSync(copy, { recursive: true, force: true });
    },
  };
}

/** Opens an extension page such as `options.html`, `popup.html` or `offscreen.html`. */
export async function openExtensionPage(extension: LaunchedExtension, file: string): Promise<Page> {
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.id}/${file}`);
  return page;
}

export interface RuntimeManifest {
  manifest_version: number;
  name: string;
  version: string;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: { matches: string[] }[];
  content_security_policy?: { extension_pages?: string };
  background?: { service_worker?: string };
}

declare const chrome: { runtime: { getManifest(): unknown } };

/** Manifest as the browser sees it, read from the live service worker. */
export function readManifest(extension: LaunchedExtension): Promise<RuntimeManifest> {
  return extension.serviceWorker.evaluate(() => chrome.runtime.getManifest() as RuntimeManifest);
}
