import fs from 'node:fs';
import { serverConfig } from './config';
import { getJobsOlderThan, deleteJobById } from './db';

export function runCleanup(): void {
  try {
    const ttlMs = serverConfig.fileTtlHours * 60 * 60 * 1000;
    const oldJobs = getJobsOlderThan(ttlMs);

    for (const job of oldJobs) {
      if (job.source_path && fs.existsSync(job.source_path)) {
        try {
          fs.unlinkSync(job.source_path);
        } catch {}
      }
      if (job.output_path && fs.existsSync(job.output_path)) {
        try {
          fs.unlinkSync(job.output_path);
        } catch {}
      }
      deleteJobById(job.id);
    }

    if (oldJobs.length > 0) {
      console.log(`[Cleanup] Deleted ${oldJobs.length} expired jobs.`);
    }
  } catch (err: any) {
    console.warn('[Cleanup] Error during job cleanup:', err.message);
  }
}

// Start periodic cleanup in long-running Node process
let cleanupInterval: NodeJS.Timeout | null = null;

export function startCleanupTimer(): void {
  if (cleanupInterval) return;
  // Run once immediately, then every 30 minutes
  runCleanup();
  cleanupInterval = setInterval(runCleanup, 30 * 60 * 1000);
}
