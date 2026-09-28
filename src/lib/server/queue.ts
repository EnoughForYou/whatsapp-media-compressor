import { EventEmitter } from 'node:events';
import { serverConfig } from './config';
import { getJobById, updateJob } from './db';
import { compressMedia } from './media';
import type { PresetId } from '../presets';

interface QueueItem {
  jobId: string;
  preset: PresetId;
}

class CompressionQueue extends EventEmitter {
  private queue: QueueItem[] = [];
  private activeCount = 0;
  private maxConcurrent = serverConfig.maxConcurrentVideoJobs;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  enqueue(jobId: string, preset: PresetId): void {
    const job = getJobById(jobId);
    if (!job) throw new Error(`Job ${jobId} tidak ditemukan.`);

    updateJob(jobId, {
      state: 'compressing',
      preset,
      progress: 0,
      error: null,
    });

    this.emit(`progress:${jobId}`, {
      state: 'compressing',
      progress: 0,
    });

    this.queue.push({ jobId, preset });
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.activeCount++;
    const { jobId, preset } = item;

    try {
      const job = getJobById(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);

      const result = await compressMedia(job, preset, (pct) => {
        updateJob(jobId, { progress: pct });
        this.emit(`progress:${jobId}`, {
          state: 'compressing',
          progress: pct,
        });
      });

      updateJob(jobId, {
        state: 'done',
        progress: 100,
        output_path: result.outputPath,
        output_size: result.sizeBytes,
        output_width: result.width,
        output_height: result.height,
        output_mime: result.mime,
      });

      this.emit(`progress:${jobId}`, {
        state: 'done',
        progress: 100,
        output: {
          sizeBytes: result.sizeBytes,
          width: result.width,
          height: result.height,
          mime: result.mime,
          estimateLabel: result.estimateLabel,
        },
      });
    } catch (err: any) {
      const msg = err?.message || 'Proses kompresi gagal.';
      console.error(`[Queue] Job ${jobId} failed:`, msg);

      updateJob(jobId, {
        state: 'failed',
        error: msg,
      });

      this.emit(`progress:${jobId}`, {
        state: 'failed',
        error: msg,
      });
    } finally {
      this.activeCount--;
      this.processNext();
    }
  }

  subscribe(jobId: string, listener: (data: any) => void): () => void {
    const eventName = `progress:${jobId}`;
    this.on(eventName, listener);
    return () => {
      this.off(eventName, listener);
    };
  }
}

// Global singleton across requests in Astro SSR
const globalForQueue = globalThis as unknown as { compressionQueue?: CompressionQueue };
export const queue = globalForQueue.compressionQueue || new CompressionQueue();
if (process.env.NODE_ENV !== 'production') {
  globalForQueue.compressionQueue = queue;
}
