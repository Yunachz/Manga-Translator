import { describe, expect, it } from 'vitest';
import { outcomeOf, visiblePageLimit, VisiblePagesRun, type PageOutcome } from '../../../src/core/surface/VisiblePages';

type Settled = { outcome: PageOutcome; captured: boolean };
const settled = (outcome: PageOutcome, captured = false): Settled => ({ outcome, captured });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('visible pages run', () => {
  it('reads the planned pages in order and counts each outcome', async () => {
    const seen: number[] = [];
    const outcomes: Settled[] = [settled('translated', true), settled('skipped'), settled('failed'), settled('translated')];
    const run = new VisiblePagesRun(() => [1, 2, 3, 4], async page => { seen.push(page); return outcomes[page - 1]; }, () => undefined);
    const status = await run.start();
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(status).toEqual({ phase: 'finished', total: 4, processed: 4, translated: 2, skipped: 1, failed: 1, captured: 1 });
  });

  it('plans nothing when no page is on screen and reports the run as finished with no pages', async () => {
    const run = new VisiblePagesRun<number>(() => [], async () => settled('translated'), () => undefined);
    expect(await run.start()).toMatchObject({ phase: 'finished', total: 0, processed: 0 });
  });

  it('never reads more pages than the bound, however many are planned', async () => {
    let runs = 0;
    const run = new VisiblePagesRun(() => Array.from({ length: 40 }, (_, index) => index), async () => { runs++; return settled('translated'); }, () => undefined);
    const status = await run.start();
    expect(runs).toBe(visiblePageLimit);
    expect(status.total).toBe(visiblePageLimit);
  });

  it('counts a thrown page as failed and keeps going', async () => {
    const run = new VisiblePagesRun(() => [1, 2], async page => { if (page === 1) throw new Error('boom'); return settled('translated'); }, () => undefined);
    expect(await run.start()).toMatchObject({ processed: 2, translated: 1, failed: 1 });
  });

  it('stops after the page in flight when a page is cancelled', async () => {
    const seen: number[] = [];
    const run = new VisiblePagesRun(() => [1, 2, 3], async page => { seen.push(page); return settled(page === 2 ? 'cancelled' : 'translated'); }, () => undefined);
    const status = await run.start();
    expect(seen).toEqual([1, 2]);
    expect(status).toMatchObject({ phase: 'stopped', processed: 1, translated: 1 });
  });

  it('ignores late work from a stopped run so it cannot change a restarted run', async () => {
    const first = deferred<Settled>();
    const second = deferred<Settled>();
    const gates = [first, second];
    let calls = 0;
    const run = new VisiblePagesRun(() => ['a', 'b'], () => gates[calls++]?.promise ?? new Promise<Settled>(() => undefined), () => undefined);

    const oldRun = run.start();
    run.stop();
    expect(run.status.phase).toBe('stopped');

    // The restarted run first waits on the second gate: the stopped run still waits on the first.
    const latest = run.start();
    expect(run.status).toMatchObject({ phase: 'running', processed: 0, total: 2 });
    first.resolve(settled('translated', true));
    await oldRun;
    // The stopped run settled late. It must leave the new run's counts and status untouched.
    expect(run.status).toMatchObject({ phase: 'running', processed: 0, translated: 0, captured: 0 });
    second.resolve(settled('skipped'));
    await Promise.resolve();
    await Promise.resolve();
    expect(run.status).toMatchObject({ processed: 1, skipped: 1, translated: 0, captured: 0 });
    run.stop();
    expect(run.status.phase).toBe('stopped');
    void latest; // Never settles here: the page it waits for is abandoned with the stopped run.
  });

  it('does nothing when asked to stop an idle run, and a second start while running keeps the first', async () => {
    const gate = deferred<Settled>();
    const run = new VisiblePagesRun(() => [1], () => gate.promise, () => undefined);
    run.stop();
    expect(run.status.phase).toBe('idle');
    const first = run.start();
    expect(run.running).toBe(true);
    expect(await Promise.race([run.start(), Promise.resolve('pending')])).toMatchObject({ phase: 'running' });
    gate.resolve(settled('translated'));
    expect((await first).phase).toBe('finished');
  });
});

describe('page outcome', () => {
  it('treats pages with nothing to translate as skipped, cancellation as its own outcome and the rest as failed', () => {
    expect(outcomeOf(undefined)).toBe('translated');
    for (const code of ['NO_TEXT', 'PANEL_NOT_FOUND', 'INPAINT_FAILED', 'TYPESET_FAILED', 'ALREADY_TRANSLATED']) expect(outcomeOf(code)).toBe('skipped');
    expect(outcomeOf('CANCELLED')).toBe('cancelled');
    for (const code of ['IMAGE_UNSUPPORTED', 'CAPTURE_UNAVAILABLE', 'QUOTA', 'INTERNAL']) expect(outcomeOf(code)).toBe('failed');
  });
});
