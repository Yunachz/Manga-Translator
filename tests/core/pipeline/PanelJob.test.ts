import { describe, expect, it } from 'vitest';
import { advance } from '../../../src/core/pipeline/PanelJob';
import { PipelineError, errorDetails, fromDetails } from '../../../src/core/pipeline/PipelineError';
import { stages, type JobStatus, type PanelJob } from '../../../src/types/contracts';

const image = { id: 'img-1', src: 'http://127.0.0.1:8765/page-a.png', width: 1000, height: 1200 };
const job = (status: JobStatus): PanelJob => ({ id: 'job-1', image, status });
const terminal: JobStatus[] = ['DONE', 'ERROR', 'CANCELLED'];
const working = stages.filter(stage => !terminal.includes(stage));

describe('advance', () => {
  it('moves forward through every working stage in declared order', () => {
    let current = job('QUEUED');
    for (const stage of working.slice(1)) {
      current = advance(current, stage);
      expect(current.status).toBe(stage);
    }
    expect(current.status).toBe('COMPOSITE');
    expect(advance(current, 'DONE').status).toBe('DONE');
  });

  it('allows skipping stages (cache hits jump ahead)', () => {
    expect(advance(job('QUEUED'), 'TRANSLATION').status).toBe('TRANSLATION');
  });

  it('rejects repeating or moving back to an earlier stage', () => {
    expect(() => advance(job('OCR'), 'OCR')).toThrow('Invalid panel job transition');
    expect(() => advance(job('OCR'), 'PANEL_CROP')).toThrow('Invalid panel job transition');
    expect(() => advance(job('COMPOSITE'), 'QUEUED')).toThrow('Invalid panel job transition');
  });

  it.each(working)('can fail or be cancelled from %s', stage => {
    expect(advance(job(stage), 'ERROR').status).toBe('ERROR');
    expect(advance(job(stage), 'CANCELLED').status).toBe('CANCELLED');
    expect(advance(job(stage), 'DONE').status).toBe('DONE');
  });

  it.each(terminal)('is final once %s', status => {
    for (const next of stages) expect(() => advance(job(status), next), `${status} -> ${next}`).toThrow('Invalid panel job transition');
  });

  it('returns a new object and leaves the original untouched', () => {
    const original = job('QUEUED');
    const next = advance(original, 'IMAGE_FETCH');
    expect(next).not.toBe(original);
    expect(original.status).toBe('QUEUED');
    expect(next.image).toBe(original.image);
    expect(next.id).toBe('job-1');
  });

  it('keeps panel and error data attached across a transition', () => {
    const panel = { id: 'gutter-1', bounds: { x: 0, y: 0, width: 1, height: 1 }, polygon: [], confidence: 0.9 };
    const next = advance({ ...job('PANEL_RESOLVE'), panel }, 'PANEL_CROP');
    expect(next.panel).toBe(panel);
  });

  it('declares terminal states last so ordering comparisons stay valid', () => {
    expect(stages.slice(-3)).toEqual(['DONE', 'ERROR', 'CANCELLED']);
    expect(new Set(stages).size).toBe(stages.length);
  });
});

describe('PipelineError', () => {
  it('carries the code, message and optional origin through details()', () => {
    const error = new PipelineError('IMAGE_PERMISSION', 'Izin diperlukan', 'https://img.example');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PipelineError');
    expect(error.details()).toEqual({ code: 'IMAGE_PERMISSION', message: 'Izin diperlukan', origin: 'https://img.example' });
  });

  it('round-trips through fromDetails', () => {
    const original = new PipelineError('QUOTA', 'quota', 'https://api.example');
    const copy = fromDetails(original.details());
    expect(copy).toBeInstanceOf(PipelineError);
    expect(copy.details()).toEqual(original.details());
  });
});

describe('errorDetails', () => {
  it('passes PipelineError through unchanged', () => {
    expect(errorDetails(new PipelineError('NO_TEXT', 'kosong'))).toEqual({ code: 'NO_TEXT', message: 'kosong', origin: undefined });
  });

  it('maps AbortError to CANCELLED', () => {
    expect(errorDetails(new DOMException('aborted', 'AbortError')).code).toBe('CANCELLED');
  });

  it('wraps unknown errors with the default code and a generic message, never leaking the original text', () => {
    const details = errorDetails(new Error('secret-key=abc123 leaked in message'));
    expect(details.code).toBe('INTERNAL');
    expect(JSON.stringify(details)).not.toContain('abc123');
  });

  it('uses the caller-supplied code and message for unknown errors', () => {
    expect(errorDetails('weird', 'OCR_FAILED', 'OCR gagal')).toEqual({ code: 'OCR_FAILED', message: 'OCR gagal' });
  });

  it('does not treat other DOMExceptions as cancellation', () => {
    expect(errorDetails(new DOMException('x', 'NetworkError')).code).toBe('INTERNAL');
  });
});
