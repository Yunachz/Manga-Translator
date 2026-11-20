import type { ProviderConfig, ProviderId } from '../../types/contracts';

export const providers = {
  chrome: { name: 'Chrome Translator', type: 'local', host: '', model: '' },
  gemini: { name: 'Gemini API', type: 'llm', host: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash' },
  openai: { name: 'OpenAI API', type: 'llm', host: 'https://api.openai.com', model: 'gpt-4.1-mini' },
  google: { name: 'Google Cloud Translation', type: 'machine-translation', host: 'https://translation.googleapis.com', model: '' },
  deepl: { name: 'DeepL API', type: 'machine-translation', host: 'https://api-free.deepl.com', model: '' },
  azure: { name: 'Azure Translator', type: 'machine-translation', host: 'https://api.cognitive.microsofttranslator.com', model: '' },
} as const;

export function providerOrigin(id: ProviderId, config: ProviderConfig): string {
  return id === 'deepl' && config.endpointTier === 'pro' ? 'https://api.deepl.com' : providers[id].host;
}

export const targetLanguages = [
  ['id', 'Indonesia'], ['en', 'Inggris'], ['ja', 'Jepang'], ['ko', 'Korea'], ['zh', 'Mandarin'],
  ['es', 'Spanyol'], ['fr', 'Prancis'], ['de', 'Jerman'], ['pt', 'Portugis'], ['vi', 'Vietnam'],
  ['th', 'Thailand'], ['ru', 'Rusia'], ['it', 'Italia'], ['ms', 'Melayu'],
] as const;

export const languageNames = { auto: 'Otomatis', ja: 'Jepang', ko: 'Korea', zh: 'Mandarin', en: 'Inggris' };
