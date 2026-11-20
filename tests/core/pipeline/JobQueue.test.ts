import { describe, expect, it } from 'vitest';
import { JobQueue } from '../../../src/core/pipeline/JobQueue';
import { PipelineError, errorDetails } from '../../../src/core/pipeline/PipelineError';

interface Deferred<T = void> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void }

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Turns a promise into a value so a rejection never surfaces as unhandled while the test is still running. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('JobQueue', () => {
  it('runs a job and resolves with its value', async () => {
    const queue = new JobQueue();
    await expect(queue.enqueue('a', async () => 42)).resolves.toBe(42);
  });

  it('hands each task a live, un-aborted signal', async () => {
    const queue = new JobQueue();
    const signals: AbortSignal[] = [];
    await queue.enqueue('a', async signal => { signals.push(signal); });
    await queue.enqueue('b', async signal => { signals.push(signal); });
    expect(signals[0].aborted).toBe(false);
    expect(signals[1]).not.toBe(signals[0]);
  });

  it('runs one job at a time, in submission order', async () => {
    const queue = new JobQueue();
    const log: string[] = [];
    const gates = { a: deferred(), b: deferred(), c: deferred() };
    const run = (id: 'a' | 'b' | 'c') => queue.enqueue(id, async () => {
      log.push(`start ${id}`);
      await gates[id].promise;
      log.push(`end ${id}`);
    });
    const all = Promise.all([run('a'), run('b'), run('c')]);
    await tick();
    expect(log).toEqual(['start a']);
    gates.a.resolve();
    await tick();
    expect(log).toEqual(['start a', 'end a', 'start b']);
    gates.b.resolve();
    gates.c.resolve();
    await all;
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('starts the first job without waiting for a later enqueue', async () => {
    const queue = new JobQueue();
    let started = false;
    const gate = deferred();
    const job = queue.enqueue('a', async () => { started = true; await gate.promise; });
    await tick();
    expect(started).toBe(true);
    gate.resolve();
    await job;
  });

  describe('priority', () => {
    it('lets a priority job pass queued normal jobs but never the running one', async () => {
      const queue = new JobQueue();
      const order: string[] = [];
      const gate = deferred();
      const job = (id: string, priority?: boolean, wait?: Promise<void>) =>
        queue.enqueue(id, async () => { order.push(id); await wait; }, priority);
      const all = [job('running', false, gate.promise), job('prefetch-1'), job('prefetch-2'), job('click', true)];
      await tick();
      gate.resolve();
      await Promise.all(all);
      expect(order).toEqual(['running', 'click', 'prefetch-1', 'prefetch-2']);
    });

    it('keeps priority jobs first-in-first-out among themselves', async () => {
      const queue = new JobQueue();
      const order: string[] = [];
      const gate = deferred();
      const job = (id: string, priority: boolean, wait?: Promise<void>) =>
        queue.enqueue(id, async () => { order.push(id); await wait; }, priority);
      const all = [job('running', false, gate.promise), job('low', false), job('p1', true), job('p2', true), job('p3', true)];
      await tick();
      gate.resolve();
      await Promise.all(all);
      expect(order).toEqual(['running', 'p1', 'p2', 'p3', 'low']);
    });
  });

  describe('capacity and ids', () => {
    it('rejects with QUEUE_FULL once active + queued jobs reach capacity, then recovers', async () => {
      const queue = new JobQueue(2);
      const gate = deferred();
      const a = queue.enqueue('a', () => gate.promise);
      const b = queue.enqueue('b', async () => 'b');
      const overflow = await settle(queue.enqueue('c', async () => 'c'));
      expect(overflow.ok).toBe(false);
      expect(!overflow.ok && overflow.error).toBeInstanceOf(PipelineError);
      expect(!overflow.ok && (overflow.error as PipelineError).code).toBe('QUEUE_FULL');
      gate.resolve();
      await Promise.all([a, b]);
      await expect(queue.enqueue('c', async () => 'c')).resolves.toBe('c');
    });

    it('rejects a duplicate id while the first is queued or running, and allows the id after it finishes', async () => {
      const queue = new JobQueue();
      const gate = deferred();
      const first = queue.enqueue('same', () => gate.promise);
      const duplicate = await settle(queue.enqueue('same', async () => 1));
      expect(!duplicate.ok && (duplicate.error as PipelineError).code).toBe('QUEUE_FULL');
      gate.resolve();
      await first;
      await expect(queue.enqueue('same', async () => 2)).resolves.toBe(2);
    });

    it('frees capacity after a failure', async () => {
      const queue = new JobQueue(1);
      const failed = await settle(queue.enqueue('a', async () => { throw new Error('boom'); }));
      expect(failed.ok).toBe(false);
      await expect(queue.enqueue('b', async () => 'ok')).resolves.toBe('ok');
    });

    it('rejection from the queue is typed for the message layer', async () => {
      const queue = new JobQueue(1);
      const gate = deferred();
      const first = queue.enqueue('a', () => gate.promise);
      const rejected = await settle(queue.enqueue('b', async () => 1));
      expect(!rejected.ok && errorDetails(rejected.error).code).toBe('QUEUE_FULL');
      gate.resolve();
      await first;
    });
  });

  describe('failure', () => {
    it('propagates a task error and keeps processing the queue', async () => {
      const queue = new JobQueue();
      const bad = settle(queue.enqueue('bad', async () => { throw new Error('boom'); }));
      const good = queue.enqueue('good', async () => 'ok');
      const outcome = await bad;
      expect(!outcome.ok && (outcome.error as Error).message).toBe('boom');
      await expect(good).resolves.toBe('ok');
    });

    it('turns a synchronous throw inside the task into a rejection', async () => {
      const queue = new JobQueue();
      const outcome = await settle(queue.enqueue('sync', () => { throw new Error('sync boom'); }));
      expect(!outcome.ok && (outcome.error as Error).message).toBe('sync boom');
      await expect(queue.enqueue('after', async () => 1)).resolves.toBe(1);
    });

    it('preserves PipelineError details from a task', async () => {
      const queue = new JobQueue();
      const outcome = await settle(queue.enqueue('x', async () => { throw new PipelineError('OCR_FAILED', 'nope', 'https://example.test'); }));
      expect(!outcome.ok && errorDetails(outcome.error)).toEqual({ code: 'OCR_FAILED', message: 'nope', origin: 'https://example.test' });
    });
  });

  describe('cancel', () => {
    it('removes a queued job without running it and rejects it as cancelled', async () => {
      const queue = new JobQueue();
      const gate = deferred();
      let ran = false;
      const running = queue.enqueue('running', () => gate.promise);
      const queued = settle(queue.enqueue('queued', async () => { ran = true; }));
      const after = queue.enqueue('after', async () => 'after');
      queue.cancel('queued');
      const outcome = await queued;
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && errorDetails(outcome.error).code).toBe('CANCELLED');
      expect(!outcome.ok && (outcome.error as DOMException).name).toBe('AbortError');
      gate.resolve();
      await running;
      await expect(after).resolves.toBe('after');
      expect(ran).toBe(false);
    });

    it('frees the slot of a cancelled queued job', async () => {
      const queue = new JobQueue(2);
      const gate = deferred();
      const running = queue.enqueue('running', () => gate.promise);
      const queued = settle(queue.enqueue('queued', async () => 1));
      queue.cancel('queued');
      await queued;
      const retry = queue.enqueue('queued', async () => 2);
      gate.resolve();
      await running;
      await expect(retry).resolves.toBe(2);
    });

    it('aborts the signal of the running job and rejects when it cooperates', async () => {
      const queue = new JobQueue();
      let seen: AbortSignal | undefined;
      const started = deferred();
      const job = settle(queue.enqueue('run', signal => new Promise<void>((_resolve, reject) => {
        seen = signal;
        signal.addEventListener('abort', () => reject(signal.reason));
        started.resolve();
      })));
      await started.promise;
      expect(seen?.aborted).toBe(false);
      queue.cancel('run');
      expect(seen?.aborted).toBe(true);
      const outcome = await job;
      expect(!outcome.ok && errorDetails(outcome.error).code).toBe('CANCELLED');
    });

    it('discards the late result of a running job that ignores the signal', async () => {
      const queue = new JobQueue();
      const gate = deferred<string>();
      const started = deferred();
      const job = settle(queue.enqueue('late', async () => { started.resolve(); return gate.promise; }));
      await started.promise;
      queue.cancel('late');
      gate.resolve('stale result');
      const outcome = await job;
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && errorDetails(outcome.error).code).toBe('CANCELLED');
    });

    it('does not start the next job until the cancelled running job settles', async () => {
      const queue = new JobQueue();
      const order: string[] = [];
      const gate = deferred();
      const started = deferred();
      const running = settle(queue.enqueue('a', async () => { started.resolve(); await gate.promise; order.push('a done'); }));
      const next = queue.enqueue('b', async () => { order.push('b'); });
      await started.promise;
      queue.cancel('a');
      await tick();
      expect(order).toEqual([]);
      gate.resolve();
      await running;
      await next;
      expect(order).toEqual(['a done', 'b']);
    });

    it('ignores unknown ids and already finished jobs', async () => {
      const queue = new JobQueue();
      await queue.enqueue('done', async () => 1);
      expect(() => queue.cancel('done')).not.toThrow();
      expect(() => queue.cancel('never-existed')).not.toThrow();
      await expect(queue.enqueue('next', async () => 2)).resolves.toBe(2);
    });

    it('cancelling twice is harmless', async () => {
      const queue = new JobQueue();
      const gate = deferred();
      const running = queue.enqueue('running', () => gate.promise);
      const queued = settle(queue.enqueue('queued', async () => 1));
      queue.cancel('queued');
      queue.cancel('queued');
      expect((await queued).ok).toBe(false);
      gate.resolve();
      await running;
    });
  });
});
