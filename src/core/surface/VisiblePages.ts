import type { VisiblePagesStatus } from '../../messaging/protocol';

export type PageOutcome = 'translated' | 'skipped' | 'failed' | 'cancelled';

/** A run never reads more pages than this. Anything further needs another explicit start after the user turns the page. */
export const visiblePageLimit = 6;

export const idleVisiblePages: VisiblePagesStatus = { phase: 'idle', total: 0, processed: 0, translated: 0, skipped: 0, failed: 0, captured: 0 };

/** Error codes that mean a page held nothing to translate or nothing that could be cleaned safely. They are not failures. */
export const skippedCodes: readonly string[] = ['NO_TEXT', 'PANEL_NOT_FOUND', 'INPAINT_FAILED', 'TYPESET_FAILED', 'ALREADY_TRANSLATED'];

export function outcomeOf(code: string | undefined): PageOutcome {
  if (!code) return 'translated';
  if (code === 'CANCELLED') return 'cancelled';
  return skippedCodes.includes(code) ? 'skipped' : 'failed';
}

/**
 * Reads the pages showing on screen one after another and keeps honest counts. The run only ever covers the pages
 * planned when the user started it. It does not scroll, turn pages or look for more. A page that cannot be read
 * is counted and the run goes on. Every run holds its own token: stopping, or starting again, invalidates the
 * token of the run before, so work that settles late can neither change the counts nor the status of a newer run.
 */
export class VisiblePagesRun<Target> {
  private state: VisiblePagesStatus = idleVisiblePages;
  private token = 0;

  constructor(private readonly plan: () => Target[], private readonly runOne: (target: Target, index: number) => Promise<{ outcome: PageOutcome; captured: boolean }>,
    private readonly changed: (status: VisiblePagesStatus) => void) {}

  get status(): VisiblePagesStatus { return this.state; }
  get running(): boolean { return this.state.phase === 'running'; }

  private update(patch: Partial<VisiblePagesStatus>): void {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  stop(): void {
    if (!this.running) return;
    this.token++;
    this.update({ phase: 'stopped' });
  }

  async start(): Promise<VisiblePagesStatus> {
    if (this.running) return this.state;
    const token = ++this.token;
    const current = () => token === this.token;
    const targets = this.plan().slice(0, visiblePageLimit);
    this.state = { ...idleVisiblePages, phase: targets.length ? 'running' : 'finished', total: targets.length };
    this.changed(this.state);
    for (const [index, target] of targets.entries()) {
      if (!current()) return this.state;
      const { outcome, captured } = await this.runOne(target, index).catch(() => ({ outcome: 'failed' as const, captured: false }));
      if (!current()) return this.state;
      if (outcome === 'cancelled') { this.token++; this.update({ phase: 'stopped' }); return this.state; }
      this.update({ processed: this.state.processed + 1, captured: this.state.captured + Number(captured),
        translated: this.state.translated + Number(outcome === 'translated'), skipped: this.state.skipped + Number(outcome === 'skipped'),
        failed: this.state.failed + Number(outcome === 'failed') });
    }
    if (current()) this.update({ phase: 'finished' });
    return this.state;
  }
}
