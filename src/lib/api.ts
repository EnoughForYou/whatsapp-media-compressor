import type { PresetId } from './presets';

export type JobState =
  | 'analyzing'
  | 'ready'
  | 'compressing'
  | 'done'
  | 'sending'
  | 'sent'
  | 'failed';

export interface Analysis {
  kind: 'image' | 'video' | 'document' | 'unknown';
  name: string;
  /** Source size in bytes. */
  sizeBytes: number;
  /** Raw, pre-compression dimensions. */
  width: number | null;
  height: number | null;
  /** Detected container/codec hints (e.g. HEIC, HEVC/HDR). */
  codec: string | null;
  hdr: boolean;
  durationSec: number | null;
}

export interface OutputMeta {
  sizeBytes: number;
  width: number | null;
  height: number | null;
  /** MIME type to upload (must match extension, error 131053). */
  mime: string;
  /** Human estimate for the UI. */
  estimateLabel: string;
}

export interface Job {
  jobId: string;
  state: JobState;
  /** 0..100 compression progress (SSE in real backend). */
  progress: number;
  analysis: Analysis;
  preset: PresetId | null;
  output: OutputMeta | null;
  error: string | null;
  messageId: string | null;
  /** Delivery states surfaced via webhook in real backend. */
  delivery: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null;
}

export interface SendResponse {
  success: boolean;
  messageId?: string;
  recipient?: string;
  groupUrl?: string;
  isMock?: boolean;
  windowClosed?: boolean;
  waMeUrl?: string;
  error?: string;
}

export const formatBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
};

export function prettyDuration(s: number | null): string {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Real Backend API calls
 * ------------------------------------------------------------------ */

export async function apiUpload(file: File): Promise<{ jobId: string; analysis: Analysis }> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload gagal: HTTP ${res.status}`);
  }

  return res.json();
}

export async function apiCompress(jobId: string, preset: PresetId): Promise<{ jobId: string }> {
  const res = await fetch(`/api/jobs/${jobId}/compress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Kompresi gagal dimulai: HTTP ${res.status}`);
  }

  return res.json();
}

export async function apiJob(jobId: string): Promise<Job> {
  const res = await fetch(`/api/jobs/${jobId}`);
  if (!res.ok) {
    throw new Error(`Job tidak ditemukan: HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiSend(jobId: string): Promise<SendResponse> {
  const res = await fetch(`/api/jobs/${jobId}/send`, {
    method: 'POST',
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.windowClosed) {
    throw new Error(data.error || `Pengiriman gagal: HTTP ${res.status}`);
  }

  return data;
}

/**
 * Connect to SSE for real-time progress updates.
 */
export function listenProgress(
  jobId: string,
  onUpdate: (data: { state: JobState; progress: number; output?: OutputMeta; error?: string }) => void
): () => void {
  const es = new EventSource(`/api/jobs/${jobId}/progress`);

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onUpdate(data);
      if (data.state === 'done' || data.state === 'failed') {
        es.close();
      }
    } catch (e) {
      console.warn('Failed to parse SSE payload:', e);
    }
  };

  es.onerror = () => {
    es.close();
  };

  return () => {
    es.close();
  };
}