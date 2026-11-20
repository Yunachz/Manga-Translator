import { defaultUiLanguage, uiLanguages } from '../i18n/messages';
import { providers, targetLanguages } from '../core/translation/catalog';
import { inpaintingModes, providerIds, sourceLanguages, type ProviderConfig, type ProviderId, type Settings } from '../types/contracts';

const providerDefaults = Object.fromEntries(providerIds.map(id => [id, {
  model: providers[id].model, region: '', endpointTier: 'free',
}])) as Settings['providers'];

export const defaults: Settings = {
  uiLanguage: defaultUiLanguage,
  enabled: true, provider: 'chrome', providers: providerDefaults, source: 'auto', target: 'id', ocrLanguage: 'auto',
  readingOrder: 'auto', performance: 'auto', inpainting: 'auto', inpaintingMode: 'normal', contextual: true, usePreviousPanel: false,
  glossary: '', series: '', prefetch: true, debug: false, fontFamily: 'Arial', fontWeight: 600, padding: 0.09, lineHeight: 1.17,
};

const settingsKey = 'reader-settings-v1';
let trustStorage: Promise<void> | undefined;

export function restrictStorage(): Promise<void> {
  trustStorage ??= Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]).then(() => undefined);
  return trustStorage;
}

function oneOf<T>(value: unknown, valid: readonly T[], fallback: T): T {
  return valid.includes(value as T) ? value as T : fallback;
}
function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
function text(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}
function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function providerId(value: unknown): value is ProviderId {
  return providerIds.includes(value as ProviderId);
}

export function sanitizeSettings(value: unknown): Settings {
  const input = object(value);
  const configs = object(input.providers);
  const validated = {} as Settings['providers'];
  for (const id of providerIds) {
    const config = object(configs[id]);
    const model = text(config.model, 100, providers[id].model);
    const region = text(config.region, 50);
    validated[id] = {
      model: /^[a-zA-Z0-9._-]*$/.test(model) ? model : providers[id].model,
      region: /^[a-zA-Z0-9-]*$/.test(region) ? region : '',
      endpointTier: oneOf<ProviderConfig['endpointTier']>(config.endpointTier, ['free', 'pro'], 'free'),
    };
  }
  return {
    uiLanguage: oneOf(input.uiLanguage, uiLanguages, defaults.uiLanguage),
    enabled: flag(input.enabled, defaults.enabled), provider: oneOf(input.provider, providerIds, defaults.provider), providers: validated,
    source: oneOf(input.source, sourceLanguages, defaults.source), target: oneOf(input.target, targetLanguages.map(([code]) => code), defaults.target),
    ocrLanguage: oneOf(input.ocrLanguage, sourceLanguages, defaults.ocrLanguage),
    readingOrder: oneOf(input.readingOrder, ['auto', 'rtl', 'ttb'], defaults.readingOrder),
    performance: oneOf(input.performance, ['auto', 'wasm'], defaults.performance),
    inpainting: oneOf(input.inpainting, ['auto', 'fast', 'classical'], defaults.inpainting),
    inpaintingMode: oneOf(input.inpaintingMode, inpaintingModes, defaults.inpaintingMode),
    contextual: flag(input.contextual, defaults.contextual), usePreviousPanel: flag(input.usePreviousPanel, defaults.usePreviousPanel),
    glossary: text(input.glossary, 3000), series: text(input.series, 140), prefetch: flag(input.prefetch, defaults.prefetch),
    debug: flag(input.debug, defaults.debug),
    fontFamily: oneOf(input.fontFamily, ['Arial', 'Verdana', 'Georgia'], defaults.fontFamily),
    fontWeight: oneOf(input.fontWeight, [400, 600, 700], defaults.fontWeight),
    padding: bounded(input.padding, 0.02, 0.24, defaults.padding),
    lineHeight: bounded(input.lineHeight, 1.0, 1.55, defaults.lineHeight),
  };
}

export async function readSettings(): Promise<Settings> {
  await restrictStorage();
  return sanitizeSettings((await chrome.storage.local.get(settingsKey))[settingsKey]);
}

let writing: Promise<unknown> = Promise.resolve();
export function updateSettings(patch: unknown): Promise<Settings> {
  const write = writing.catch(() => undefined).then(async () => {
    const current = await readSettings();
    const settings = sanitizeSettings({ ...current, ...object(patch) });
    await chrome.storage.local.set({ [settingsKey]: settings });
    return settings;
  });
  writing = write;
  return write;
}
