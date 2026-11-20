import type { ErrorCode, ErrorDetails } from '../../types/contracts';

export class PipelineError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly origin?: string) {
    super(message);
    this.name = 'PipelineError';
  }

  details(): ErrorDetails {
    return { code: this.code, message: this.message, origin: this.origin };
  }
}

export function errorDetails(error: unknown, code: ErrorCode = 'INTERNAL', message = 'Proses terhenti. Coba lagi.'): ErrorDetails {
  if (error instanceof PipelineError) return error.details();
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'CANCELLED', message: 'Terjemahan dibatalkan.' };
  }
  return { code, message };
}

export function fromDetails(error: ErrorDetails): PipelineError {
  return new PipelineError(error.code, error.message, error.origin);
}
