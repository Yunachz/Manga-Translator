import { describe, expect, it } from 'vitest';
import { languageNames, providerOrigin, providers, targetLanguages } from '../../../src/core/translation/catalog';
import { getProviderOrigins, providerCatalog } from '../../../src/core/translation/providerCatalog';
import { providerIds, sourceLanguages } from '../../../src/types/contracts';
import { providerConfig } from '../../support/settings';

describe('catalog', () => {
  it('has one entry per provider ID', () => {
    expect(Object.keys(providers).sort()).toEqual([...providerIds].sort());
  });

  it('classifies chrome as local and the two LLMs as llm', () => {
    expect(providers.chrome.type).toBe('local');
    expect(providers.gemini.type).toBe('llm');
    expect(providers.openai.type).toBe('llm');
    for (const id of ['google', 'deepl', 'azure'] as const) expect(providers[id].type).toBe('machine-translation');
  });

  it('uses https hosts without a trailing slash or path', () => {
    for (const id of providerIds) {
      if (id === 'chrome') continue;
      const { host } = providers[id];
      expect(new URL(host).origin, id).toBe(host);
      expect(host.startsWith('https://'), id).toBe(true);
    }
  });

  it('keeps the local provider hostless so no host permission is ever requested for it', () => {
    expect(providers.chrome.host).toBe('');
  });

  it('only LLMs carry a default model', () => {
    expect(providers.gemini.model).toBeTruthy();
    expect(providers.openai.model).toBeTruthy();
    for (const id of ['chrome', 'google', 'deepl', 'azure'] as const) expect(providers[id].model).toBe('');
  });

  it('agrees with the permission catalog for every provider and tier', () => {
    for (const id of providerIds) {
      for (const endpointTier of ['free', 'pro'] as const) {
        const origin = providerOrigin(id, providerConfig({ endpointTier }));
        const permitted = getProviderOrigins(id, endpointTier);
        expect(permitted, `${id}/${endpointTier}`).toEqual(origin ? [`${origin}/*`] : []);
      }
    }
  });

  it('keeps display names in sync between the two catalogs', () => {
    for (const id of providerIds) expect(providers[id].name, id).toBeTruthy();
    expect(providerCatalog.deepl.displayName).toContain('DeepL');
    expect(providers.deepl.name).toContain('DeepL');
  });
});

describe('providerOrigin', () => {
  it('switches DeepL to the pro host by tier and ignores the tier elsewhere', () => {
    expect(providerOrigin('deepl', providerConfig({ endpointTier: 'free' }))).toBe('https://api-free.deepl.com');
    expect(providerOrigin('deepl', providerConfig({ endpointTier: 'pro' }))).toBe('https://api.deepl.com');
    expect(providerOrigin('openai', providerConfig({ endpointTier: 'pro' }))).toBe('https://api.openai.com');
  });

  it('falls back to the free host for an unexpected tier value', () => {
    expect(providerOrigin('deepl', providerConfig({ endpointTier: 'enterprise' as never }))).toBe('https://api-free.deepl.com');
  });
});

describe('language tables', () => {
  it('has unique, lower-case, non-empty target codes', () => {
    const codes = targetLanguages.map(([code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const [code, label] of targetLanguages) {
      expect(code).toMatch(/^[a-z]{2,3}$/);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('defaults to Indonesian first', () => {
    expect(targetLanguages[0][0]).toBe('id');
  });

  it('names every source language', () => {
    for (const code of sourceLanguages) expect(languageNames[code], code).toBeTruthy();
  });
});
