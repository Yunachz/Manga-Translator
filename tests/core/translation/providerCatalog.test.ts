import { describe, expect, it } from 'vitest';
import { getDeepLEndpoint, getProviderOrigins, providerCatalog } from '../../../src/core/translation/providerCatalog';
import { providerIds } from '../../../src/types/contracts';

describe('providerCatalog', () => {
  it('has exactly one entry per ProviderId', () => {
    expect(Object.keys(providerCatalog).sort()).toEqual([...providerIds].sort());
    expect(providerIds).toHaveLength(6);
  });

  it('gives every provider a display name', () => {
    for (const id of providerIds) expect(providerCatalog[id].displayName.length, id).toBeGreaterThan(0);
  });

  it('declares only exact https origin patterns, with no wildcard host and no plain http', () => {
    for (const id of providerIds) {
      for (const origin of providerCatalog[id].origins) {
        expect(origin, id).toMatch(/^https:\/\/[a-z0-9.-]+\/\*$/);
        expect(origin, id).not.toContain('*.');
        expect(origin, id).not.toMatch(/^https:\/\/\*/);
      }
    }
  });

  it('requires no host permission for the local Chrome translator', () => {
    expect(providerCatalog.chrome.origins).toEqual([]);
    expect(getProviderOrigins('chrome')).toEqual([]);
  });

  it('pins each cloud provider to its documented host', () => {
    expect(providerCatalog.gemini.origins).toEqual(['https://generativelanguage.googleapis.com/*']);
    expect(providerCatalog.openai.origins).toEqual(['https://api.openai.com/*']);
    expect(providerCatalog.google.origins).toEqual(['https://translation.googleapis.com/*']);
    expect(providerCatalog.azure.origins).toEqual(['https://api.cognitive.microsofttranslator.com/*']);
  });

  it('does not share a host between providers (no cross-provider egress by permission)', () => {
    const seen = new Map<string, string>();
    for (const id of providerIds) {
      for (const origin of providerCatalog[id].origins) {
        expect(seen.get(origin), `${origin} claimed by ${seen.get(origin)} and ${id}`).toBeUndefined();
        seen.set(origin, id);
      }
    }
  });

  it('defines a default model only for the LLM providers', () => {
    expect(providerCatalog.gemini.defaultModel).toBeTruthy();
    expect(providerCatalog.openai.defaultModel).toBeTruthy();
    for (const id of ['chrome', 'google', 'deepl', 'azure'] as const) {
      expect('defaultModel' in providerCatalog[id], id).toBe(false);
    }
  });
});

describe('getDeepLEndpoint', () => {
  it('maps tiers to the documented endpoints', () => {
    expect(getDeepLEndpoint('free')).toBe('https://api-free.deepl.com/v2/translate');
    expect(getDeepLEndpoint('pro')).toBe('https://api.deepl.com/v2/translate');
  });

  it('falls back to the free endpoint for unknown tier values coming from corrupt storage', () => {
    expect(getDeepLEndpoint('enterprise' as never)).toBe('https://api-free.deepl.com/v2/translate');
    expect(getDeepLEndpoint(undefined as never)).toBe('https://api-free.deepl.com/v2/translate');
  });

  it('is covered by the origins the catalog requests for the same tier', () => {
    for (const tier of ['free', 'pro'] as const) {
      const url = new URL(getDeepLEndpoint(tier));
      expect(getProviderOrigins('deepl', tier)).toEqual([`${url.protocol}//${url.host}/*`]);
    }
  });
});

describe('getProviderOrigins', () => {
  it('returns only the selected DeepL tier host', () => {
    expect(getProviderOrigins('deepl', 'free')).toEqual(['https://api-free.deepl.com/*']);
    expect(getProviderOrigins('deepl', 'pro')).toEqual(['https://api.deepl.com/*']);
    expect(getProviderOrigins('deepl')).toEqual(['https://api-free.deepl.com/*']);
  });

  it('ignores the tier for other providers', () => {
    expect(getProviderOrigins('openai', 'pro')).toEqual(providerCatalog.openai.origins);
    expect(getProviderOrigins('azure', 'free')).toEqual(providerCatalog.azure.origins);
  });

  it('requests permission for a single provider at a time', () => {
    for (const id of providerIds) expect(getProviderOrigins(id).length, id).toBeLessThanOrEqual(1);
  });
});
