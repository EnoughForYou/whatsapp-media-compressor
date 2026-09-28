import Database from 'better-sqlite3';
import path from 'node:path';
import { serverConfig, initDirectories } from './config';
import type { Analysis, OutputMeta } from '../api';
import type { PresetId } from '../presets';

export interface JobRecord {
  id: string;
  state: 'analyzing' | 'ready' | 'compressing' | 'done' | 'sending' | 'sent' | 'failed';
  preset: PresetId | null;
  original_name: string;
  source_path: string;
  source_size: number;
  source_mime: string;
  source_kind: 'image' | 'video' | 'document' | 'unknown';
  source_width: number | null;
  source_height: number | null;
  source_codec: string | null;
  source_hdr: number; // 0 or 1
  source_duration: number | null;
  output_path: string | null;
  output_size: number | null;
  output_width: number | null;
  output_height: number | null;
  output_mime: string | null;
  progress: number;
  error: string | null;
  message_id: string | null;
  delivery: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  created_at: number;
  updated_at: number;
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    initDirectories();
    const dbPath = path.join(serverConfig.dataDir, 'db', 'compressor.sqlite');
    dbInstance = new Database(dbPath);
    dbInstance.pragma('journal_mode = WAL');

    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        preset TEXT,
        original_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_size INTEGER NOT NULL,
        source_mime TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_width INTEGER,
        source_height INTEGER,
        source_codec TEXT,
        source_hdr INTEGER NOT NULL DEFAULT 0,
        source_duration REAL,
        output_path TEXT,
        output_size INTEGER,
        output_width INTEGER,
        output_height INTEGER,
        output_mime TEXT,
        progress REAL NOT NULL DEFAULT 0,
        error TEXT,
        message_id TEXT,
        delivery TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_message_id ON jobs(message_id);

      CREATE TABLE IF NOT EXISTS webhook_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        status TEXT,
        timestamp INTEGER,
        payload TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }
  return dbInstance;
}

export function insertJob(job: {
  id: string;
  originalName: string;
  sourcePath: string;
  sourceSize: number;
  sourceMime: string;
  analysis: Analysis;
}): JobRecord {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO jobs (
      id, state, original_name, source_path, source_size, source_mime,
      source_kind, source_width, source_height, source_codec, source_hdr,
      source_duration, progress, created_at, updated_at
    ) VALUES (
      ?, 'ready', ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, 0, ?, ?
    )
  `);

  stmt.run(
    job.id,
    job.originalName,
    job.sourcePath,
    job.sourceSize,
    job.sourceMime,
    job.analysis.kind,
    job.analysis.width,
    job.analysis.height,
    job.analysis.codec,
    job.analysis.hdr ? 1 : 0,
    job.analysis.durationSec,
    now,
    now
  );

  return getJobById(job.id)!;
}

export function getJobById(id: string): JobRecord | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const row = stmt.get(id) as JobRecord | undefined;
  return row ?? null;
}

export function updateJob(
  id: string,
  fields: Partial<Omit<JobRecord, 'id' | 'created_at'>>
): void {
  const db = getDb();
  const updates: string[] = [];
  const values: any[] = [];

  for (const [key, val] of Object.entries(fields)) {
    updates.push(`${key} = ?`);
    values.push(val);
  }

  updates.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  const query = `UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`;
  db.prepare(query).run(...values);
}

export function updateJobDeliveryByMessageId(
  messageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed'
): boolean {
  const db = getDb();
  const info = db.prepare(`
    UPDATE jobs 
    SET delivery = ?, updated_at = ? 
    WHERE message_id = ?
  `).run(status, Date.now(), messageId);
  return info.changes > 0;
}

export function recordWebhookLog(
  messageId: string | null,
  status: string,
  timestamp: number,
  payload: string
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO webhook_logs (message_id, status, timestamp, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(messageId, status, timestamp, payload, Date.now());
}

export function getJobsOlderThan(ttlMs: number): JobRecord[] {
  const db = getDb();
  const cutoff = Date.now() - ttlMs;
  return db.prepare('SELECT * FROM jobs WHERE created_at < ?').all(cutoff) as JobRecord[];
}

export function deleteJobById(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

export function toAnalysis(record: JobRecord): Analysis {
  return {
    kind: record.source_kind,
    name: record.original_name,
    sizeBytes: record.source_size,
    width: record.source_width,
    height: record.source_height,
    codec: record.source_codec,
    hdr: record.source_hdr === 1,
    durationSec: record.source_duration,
  };
}

export function toOutputMeta(record: JobRecord): OutputMeta | null {
  if (record.output_size == null) return null;
  const size = record.output_size;
  const label = size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / (1024 * 1024)).toFixed(2)} MB`;

  return {
    sizeBytes: size,
    width: record.output_width,
    height: record.output_height,
    mime: record.output_mime || 'application/octet-stream',
    estimateLabel: label,
  };
}
