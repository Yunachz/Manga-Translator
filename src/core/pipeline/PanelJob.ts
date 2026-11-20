import { stages, type JobStatus, type PanelJob } from '../../types/contracts';

const terminal = new Set<JobStatus>(['DONE', 'ERROR', 'CANCELLED']);
export function advance(job: PanelJob, status: JobStatus): PanelJob {
  if (terminal.has(job.status) || (!terminal.has(status) && stages.indexOf(status) <= stages.indexOf(job.status))) {
    throw new Error('Invalid panel job transition');
  }
  return { ...job, status };
}
