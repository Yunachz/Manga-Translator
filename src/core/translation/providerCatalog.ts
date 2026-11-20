import type { ProviderConfig, ProviderId } from '../../types/contracts';

const deepLEndpoints = {
  free: 'https://api-free.deepl.com/v2/translate',
  pro: 'https://api.deepl.com/v2/translate',
} as const;

const deepLOrigins = {
  free: 'https://api-free.deepl.com/*',
  pro: 'https://api.deepl.com/*',
} as const;

export interface ProviderInfo {
  displayName: string;
  origins: readonly string[];
  defaultModel?: string;
}

export const providerCatalog = {
  chrome: { displayName: 'Chrome Translator', origins: [] },
  gemini: {
    displayName: 'Google Gemini',
    origins: ['https://generativelanguage.googleapis.com/*'],
    defaultModel: 'gemini-2.5-flash',
  },
  openai: {
    displayName: 'OpenAI',
    origins: ['https://api.openai.com/*'],
    defaultModel: 'gpt-4o-mini',
  },
  google: {
    displayName: 'Google Cloud Translation',
    origins: ['https://translation.googleapis.com/*'],
  },
  deepl: { displayName: 'DeepL', origins: [deepLOrigins.free, deepLOrigins.pro] },
  azure: { displayName: 'Azure AI Translator', origins: ['https://api.cognitive.microsofttranslator.com/*'] },
} as const satisfies Record<ProviderId, ProviderInfo>;

export function getDeepLEndpoint(tier: ProviderConfig['endpointTier']): string {
  return deepLEndpoints[tier === 'pro' ? 'pro' : 'free'];
}

export function getProviderOrigins(
  provider: ProviderId,
  tier: ProviderConfig['endpointTier'] = 'free',
): readonly string[] {
  if (provider === 'deepl') return [deepLOrigins[tier === 'pro' ? 'pro' : 'free']];
  return providerCatalog[provider].origins;
}
