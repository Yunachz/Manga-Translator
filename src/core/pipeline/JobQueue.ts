import { PipelineError } from './PipelineError';

interface Entry {
  controller: AbortController;
  run: () => Promise<void>;
}

export class JobQueue {
  private readonly pending: Entry[] = [];
  private readonly entries = new Map<string, Entry>();
  private active = false;

  constructor(private readonly capacity = 10) {}

  enqueue<T>(id: string, task: (signal: AbortSignal) => Promise<T>, priority = false): Promise<T> {
    if (this.entries.has(id) || this.entries.size >= this.capacity) {
      return Promise.reject(new PipelineError('QUEUE_FULL', 'Antrean penuh. Tunggu proses yang sedang berjalan.'));
    }
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { controller, run: async () => {
        try {
          controller.signal.throwIfAborted();
          const value = await task(controller.signal);
          controller.signal.throwIfAborted();
          resolve(value);
        } catch (error) {
          reject(error);
        } finally {
          this.entries.delete(id);
        }
      } };
      this.entries.set(id, entry);
      if (priority) {
        const firstPrefetch = this.pending.findIndex(queued => this.lowPriority.has(queued));
        this.pending.splice(firstPrefetch < 0 ? this.pending.length : firstPrefetch, 0, entry);
      } else {
        this.lowPriority.add(entry);
        this.pending.push(entry);
      }
      void this.drain();
    });
  }

  private readonly lowPriority = new WeakSet<Entry>();

  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.controller.abort();
    const index = this.pending.indexOf(entry);
    if (index >= 0) {
      this.pending.splice(index, 1);
      void entry.run();
    }
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.pending.length) await this.pending.shift()?.run();
    } finally {
      this.active = false;
    }
  }
}
