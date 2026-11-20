import * as ort from 'onnxruntime-web';
import { PipelineError } from '../pipeline/PipelineError';
import { optionalModels } from './capabilities';

export type BackendPreference = 'auto' | 'wasm';
type Backend = 'webgpu' | 'wasm';
type ModelName = 'det' | 'rec-cjk' | 'rec-ko' | 'rec-en' | 'panel' | 'lama';
interface LoadedModel { session: ort.InferenceSession; backend: Backend }

export function packagedAsset(path: string): string {
  return new URL('/' + path, globalThis.location.href).href;
}

export class ModelManager {
  private readonly models = new Map<string, LoadedModel>();
  private availableGpu?: Promise<boolean>;
  private readonly unsupportedGpu = new Set<ModelName>();

  constructor() {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';
    ort.env.wasm.wasmPaths = packagedAsset('ort/');
  }

  async infer(model: ModelName, inputs: ort.InferenceSession.FeedsType, preference: BackendPreference) {
    const loaded = await this.load(model, preference);
    try {
      return { outputs: await loaded.session.run(inputs), backend: loaded.backend };
    } catch (error) {
      if (loaded.backend === 'wasm') throw error;
      this.unsupportedGpu.add(model);
      await this.unload(model, 'webgpu');
      const fallback = await this.load(model, 'wasm');
      return { outputs: await fallback.session.run(inputs), backend: fallback.backend };
    }
  }

  optional(model: 'panel' | 'lama'): boolean {
    return optionalModels[model];
  }

  private async canUseGpu(): Promise<boolean> {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    this.availableGpu ??= gpu ? gpu.requestAdapter().then(Boolean).catch(() => false) : Promise.resolve(false);
    return this.availableGpu;
  }

  private async unload(model: ModelName, backend: Backend): Promise<void> {
    const key = `${model}:${backend}`;
    const loaded = this.models.get(key);
    this.models.delete(key);
    await loaded?.session.release().catch(() => undefined);
  }

  private async load(model: ModelName, preference: BackendPreference): Promise<LoadedModel> {
    const tryGpu = preference === 'auto' && !this.unsupportedGpu.has(model) && await this.canUseGpu();
    const backends: Backend[] = tryGpu ? ['webgpu', 'wasm'] : ['wasm'];
    for (const backend of backends) {
      const key = `${model}:${backend}`;
      const cached = this.models.get(key);
      if (cached) {
        this.models.delete(key);
        this.models.set(key, cached);
        return cached;
      }
      try {
        if (this.models.size >= 3) {
          const oldest = this.models.keys().next().value;
          if (oldest) {
            const [oldModel, oldBackend] = oldest.split(':') as [ModelName, Backend];
            await this.unload(oldModel, oldBackend);
          }
        }
        const session = await ort.InferenceSession.create(packagedAsset(`models/${model}.onnx`), {
          executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
        });
        const loaded = { session, backend };
        this.models.set(key, loaded);
        return loaded;
      } catch {
        if (backend === 'webgpu') this.unsupportedGpu.add(model);
      }
    }
    throw new PipelineError('MODEL_LOAD', `Model lokal "${model}" gagal dimuat. Periksa pemasangan model dan build extension.`);
  }
}
