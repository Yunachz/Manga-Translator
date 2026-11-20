import type { ProviderConfig, TranslationRequest } from '../../types/contracts';
import { CloudProvider } from './CloudProvider';
import { parseLlm, responseSchema, translationInstructions } from './segments';

export class GeminiProvider extends CloudProvider {
  constructor(config: ProviderConfig, key?: string) { super('gemini', config, key); }

  async translate(request: TranslationRequest, signal: AbortSignal) {
    const payload = await this.request(`/v1beta/models/${this.model}:generateContent`, {
      systemInstruction: { parts: [{ text: translationInstructions }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(request) }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: responseSchema },
    }, key => ({ 'x-goog-api-key': key }), signal) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
    return parseLlm(request, payload.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join(''));
  }
}
