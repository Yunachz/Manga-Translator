import { providerIds, type ProviderConfig, type Settings } from '../../src/types/contracts';

export function providerConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { model: '', region: '', endpointTier: 'free', ...overrides };
}

export function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    uiLanguage: 'en',
    enabled: true,
    provider: 'chrome',
    providers: Object.fromEntries(providerIds.map(id => [id, providerConfig()])) as Settings['providers'],
    source: 'auto',
    target: 'id',
    ocrLanguage: 'auto',
    readingOrder: 'auto',
    performance: 'wasm',
    inpainting: 'auto',
    inpaintingMode: 'normal',
    contextual: false,
    usePreviousPanel: false,
    glossary: '',
    series: '',
    prefetch: false,
    debug: false,
    fontFamily: 'Arial',
    fontWeight: 600,
    padding: 0.08,
    lineHeight: 1.2,
    ...overrides,
  };
}
