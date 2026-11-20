import type { ProviderConfig, TranslationRequest } from '../../types/contracts';
import { CloudProvider } from './CloudProvider';
import { parseLlm, responseSchema, translationInstructions } from './segments';

export class OpenAIProvider extends CloudProvider {
  constructor(config: ProviderConfig, key?: string) { super('openai', config, key); }

  async translate(request: TranslationRequest, signal: AbortSignal) {
    const payload = await this.request('/v1/responses', {
      model: this.model, instructions: translationInstructions, input: JSON.stringify(request), store: false,
      text: { format: { type: 'json_schema', name: 'panel_translation', strict: true, schema: responseSchema } },
    }, key => ({ Authorization: `Bearer ${key}` }), signal) as {
      output?: { type?: string; content?: { type: string; text?: string }[] }[];
    };
    return parseLlm(request, payload.output?.flatMap(item => item.type === 'message' ? item.content ?? [] : [])
      .filter(item => item.type === 'output_text').map(item => item.text ?? '').join(''));
  }
}
