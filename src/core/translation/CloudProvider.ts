import type { ProviderConfig, ProviderId, TranslationRequest, TranslationResult } from '../../types/contracts';
import { PipelineError } from '../pipeline/PipelineError';
import { providerOrigin, providers } from './catalog';
import { postJson } from './http';
import type { TranslatorProvider } from './TranslatorProvider';

export abstract class CloudProvider implements TranslatorProvider {
  readonly requiresApiKey = true;
  readonly supportsContext: boolean;
  readonly name: string;
  readonly type: 'machine-translation' | 'llm';

  constructor(readonly id: Exclude<ProviderId, 'chrome'>, protected readonly config: ProviderConfig, private readonly apiKey?: string) {
    const provider = providers[id];
    this.name = provider.name;
    this.type = provider.type;
    this.supportsContext = this.type === 'llm';
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey && await chrome.permissions.contains({ origins: [`${providerOrigin(this.id, this.config)}/*`] });
  }

  protected async request(path: string, payload: unknown, auth: (key: string) => Record<string, string>, signal: AbortSignal) {
    if (!this.apiKey) throw new PipelineError('UNAUTHORIZED', 'Masukkan API key provider di Pengaturan.');
    const origin = providerOrigin(this.id, this.config);
    if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
      throw new PipelineError('PROVIDER_PERMISSION', 'Berikan izin akses provider di Pengaturan.');
    }
    return postJson(origin + path, payload, auth(this.apiKey), signal);
  }

  protected get model(): string {
    const model = this.config.model || providers[this.id].model;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model)) {
      throw new PipelineError('TRANSLATION_FAILED', 'Nama model provider tidak valid.');
    }
    return model;
  }

  abstract translate(request: TranslationRequest, signal: AbortSignal): Promise<TranslationResult>;
}
