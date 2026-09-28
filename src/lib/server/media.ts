import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serverConfig } from './config';
import type { JobRecord } from './db';
import type { Analysis, OutputMeta } from '../api';
import { LIMITS, type PresetId } from '../presets';

export interface CompressResult {
  outputPath: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  mime: string;
  sha256?: string;
  estimateLabel: string;
}

export async function analyzeMedia(
  filePath: string,
  originalFilename: string
): Promise<Analysis> {
  const stats = fs.statSync(filePath);
  const ext = path.extname(originalFilename).toLowerCase();

  return new Promise((resolve) => {
    const ffprobe = spawn(serverConfig.ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    let stdout = '';
    ffprobe.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    ffprobe.on('error', (err) => {
      console.warn('ffprobe execution failed, falling back to basic analysis:', err.message);
      resolve(fallbackAnalysis(originalFilename, stats.size, ext));
    });

    ffprobe.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        return resolve(fallbackAnalysis(originalFilename, stats.size, ext));
      }

      try {
        const info = JSON.parse(stdout);
        const streams = info.streams || [];
        const format = info.format || {};

        const videoStream = streams.find((s: any) => s.codec_type === 'video');
        const audioStream = streams.find((s: any) => s.codec_type === 'audio');

        let kind: Analysis['kind'] = 'unknown';
        let width: number | null = null;
        let height: number | null = null;
        let codec: string | null = null;
        let hdr = false;
        let durationSec: number | null = null;

        if (videoStream) {
          width = videoStream.width || null;
          height = videoStream.height || null;
          codec = (videoStream.codec_name || '').toUpperCase();

          // Check if this is an animated/video file or static image
          const hasDuration = format.duration != null || videoStream.duration != null;
          const isImageExt = /\.(jpe?g|png|heic|heif|webp|tiff?|bmp)$/i.test(originalFilename);

          if (isImageExt || (!audioStream && !hasDuration && streams.length === 1)) {
            kind = 'image';
            if (codec === 'HEVC' && /\.(heic|heif)$/i.test(originalFilename)) {
              codec = 'HEIC';
            }
          } else {
            kind = 'video';
            const dur = Number.parseFloat(videoStream.duration || format.duration || '0');
            durationSec = dur > 0 ? dur : null;

            // HDR Detection
            const colorTransfer = (videoStream.color_transfer || '').toLowerCase();
            const colorPrimaries = (videoStream.color_primaries || '').toLowerCase();
            const colorSpace = (videoStream.color_space || '').toLowerCase();

            if (
              colorTransfer.includes('arib-std-b67') || // HLG
              colorTransfer.includes('smpte2084') ||    // PQ / HDR10
              colorPrimaries.includes('bt2020') ||
              colorSpace.includes('bt2020')
            ) {
              hdr = true;
            }
          }
        } else {
          // Document / other
          kind = 'document';
        }

        resolve({
          kind,
          name: originalFilename,
          sizeBytes: stats.size,
          width,
          height,
          codec,
          hdr,
          durationSec,
        });
      } catch (e) {
        resolve(fallbackAnalysis(originalFilename, stats.size, ext));
      }
    });
  });
}

function fallbackAnalysis(name: string, sizeBytes: number, ext: string): Analysis {
  let kind: Analysis['kind'] = 'unknown';
  let codec: string | null = null;

  if (/\.(jpe?g|png|heic|heif|webp)$/i.test(ext)) {
    kind = 'image';
    codec = ext.replace('.', '').toUpperCase();
  } else if (/\.(mp4|mov|mkv|webm)$/i.test(ext)) {
    kind = 'video';
    codec = ext === '.mov' ? 'HEVC/H.264' : 'H.264';
  } else if (/\.(pdf|docx?|xlsx?|txt)$/i.test(ext)) {
    kind = 'document';
  }

  return {
    kind,
    name,
    sizeBytes,
    width: null,
    height: null,
    codec,
    hdr: false,
    durationSec: null,
  };
}

export async function compressMedia(
  job: JobRecord,
  preset: PresetId,
  onProgress: (pct: number) => void
): Promise<CompressResult> {
  const outputDir = path.join(serverConfig.dataDir, 'outputs');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Preset: Document -> direct copy without transcoding
  if (preset === 'doc-original' || job.source_kind === 'document') {
    const ext = path.extname(job.original_name) || '.bin';
    const outputPath = path.join(outputDir, `${job.id}_doc${ext}`);

    onProgress(10);
    fs.copyFileSync(job.source_path, outputPath);
    onProgress(90);

    const stats = fs.statSync(outputPath);
    if (stats.size > LIMITS.documentMB * 1024 * 1024) {
      throw new Error(`Ukuran dokumen (${(stats.size / 1024 / 1024).toFixed(1)} MB) melebihi batas WhatsApp Cloud API (${LIMITS.documentMB} MB).`);
    }

    const sha256 = await computeFileHash(outputPath);
    onProgress(100);

    return {
      outputPath,
      sizeBytes: stats.size,
      width: job.source_width,
      height: job.source_height,
      mime: job.source_mime || 'application/octet-stream',
      sha256,
      estimateLabel: formatBytes(stats.size),
    };
  }

  // Preset: Chat-Foto (Image)
  if (preset === 'chat-image' || (job.source_kind === 'image' && preset !== 'status-video')) {
    const outputPath = path.join(outputDir, `${job.id}_compressed.jpg`);
    onProgress(20);

    // Filter to scale long edge to 1600px with lanczos, sRGB 8-bit
    // scale='if(gt(iw,ih),min(1600,iw),-2)':'if(gt(ih,iw),min(1600,ih),-2)':flags=lanczos
    const filter = "scale='if(gt(iw,ih),min(1600,iw),-2)':'if(gt(ih,iw),min(1600,ih),-2)':flags=lanczos,format=yuvj420p";

    await runFfmpeg([
      '-y',
      '-i', job.source_path,
      '-vf', filter,
      '-qscale:v', '3',
      outputPath,
    ], (p) => onProgress(20 + p * 0.7));

    let stats = fs.statSync(outputPath);
    // If output is somehow still > 5 MB, re-encode with higher compression
    if (stats.size > LIMITS.imageMB * 1024 * 1024) {
      await runFfmpeg([
        '-y',
        '-i', job.source_path,
        '-vf', filter,
        '-qscale:v', '8',
        outputPath,
      ]);
      stats = fs.statSync(outputPath);
    }

    if (stats.size > LIMITS.imageMB * 1024 * 1024) {
      throw new Error(`Ukuran foto hasil (${(stats.size / 1024 / 1024).toFixed(1)} MB) melebihi batas WhatsApp 5 MB.`);
    }

    const probe = await analyzeMedia(outputPath, `${job.id}.jpg`);
    onProgress(100);

    return {
      outputPath,
      sizeBytes: stats.size,
      width: probe.width,
      height: probe.height,
      mime: 'image/jpeg',
      estimateLabel: formatBytes(stats.size),
    };
  }

  // Preset: Chat-Video or Status-Video
  const outputPath = path.join(outputDir, `${job.id}_compressed.mp4`);
  const isStatus = preset === 'status-video';

  const durationSec = Math.max(1, job.source_duration || 30);
  // Status is capped at 30 seconds
  const targetDuration = isStatus ? Math.min(30, durationSec) : durationSec;

  // PRD bitrate calculation
  // total_kbps = (target_MB * 8192 * 0.95) / durasi_detik
  // video_kbps = total_kbps - audio_kbps (audio 128 kbps)
  const targetMB = isStatus ? 12 : 15.5; // Leave safety margin under 16 MB
  const totalKbps = (targetMB * 8192 * 0.95) / targetDuration;
  const audioKbps = 128;
  const videoKbps = Math.max(250, Math.min(2400, Math.round(totalKbps - audioKbps)));
  const maxrateKbps = Math.round(videoKbps * 1.25);
  const bufsizeKbps = Math.round(videoKbps * 2);

  // Video filter assembly
  const vfParts: string[] = [];

  // Tone-mapping if HDR
  if (job.source_hdr === 1) {
    vfParts.push(
      'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'
    );
  }

  if (isStatus) {
    // 9:16 target, scale to fit 720x1280 without stretching, pad if needed
    vfParts.push("scale='if(gt(iw/ih,720/1280),720,-2)':'if(gt(iw/ih,720/1280),-2,1280)':flags=lanczos");
    vfParts.push('pad=720:1280:(720-iw)/2:(1280-ih)/2:black');
  } else {
    // 720p max dimension (landscape or portrait)
    // Scale so longer dimension or height <= 720
    vfParts.push("scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)':flags=lanczos");
  }

  vfParts.push('fps=30');
  vfParts.push('format=yuv420p');

  const args: string[] = [
    '-y',
    '-i', job.source_path,
  ];

  if (isStatus && durationSec > 30) {
    args.push('-t', '30');
  }

  args.push(
    '-vf', vfParts.join(','),
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-bf', '0', // WhatsApp Android crashes on High profile with B-frames!
    '-preset', 'slow',
    '-b:v', `${videoKbps}k`,
    '-maxrate', `${maxrateKbps}k`,
    '-bufsize', `${bufsizeKbps}k`,
    '-c:a', 'aac',
    '-b:a', `${audioKbps}k`,
    '-ac', '2',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    outputPath
  );

  await runFfmpegWithProgress(args, targetDuration, onProgress);

  const stats = fs.statSync(outputPath);
  if (stats.size > LIMITS.videoMB * 1024 * 1024) {
    throw new Error(`Ukuran video (${(stats.size / 1024 / 1024).toFixed(1)} MB) melebihi batas WhatsApp Cloud API (${LIMITS.videoMB} MB).`);
  }

  const probe = await analyzeMedia(outputPath, `${job.id}.mp4`);
  onProgress(100);

  return {
    outputPath,
    sizeBytes: stats.size,
    width: probe.width,
    height: probe.height,
    mime: 'video/mp4',
    estimateLabel: formatBytes(stats.size),
  };
}

function runFfmpeg(args: string[], onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(serverConfig.ffmpegPath, args);
    let stderr = '';

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        if (onProgress) onProgress(100);
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

function runFfmpegWithProgress(
  args: string[],
  totalDurationSec: number,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(serverConfig.ffmpegPath, args);
    let stdoutBuffer = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const [k, v] = line.trim().split('=');
        if (k === 'out_time_us' || k === 'out_time_ms') {
          const us = Number.parseInt(v, 10);
          const currentSec = k === 'out_time_us' ? us / 1000000 : us / 1000;
          if (totalDurationSec > 0) {
            const pct = Math.min(99, Math.round((currentSec / totalDurationSec) * 100));
            onProgress(pct);
          }
        } else if (k === 'progress' && v === 'end') {
          onProgress(99);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`ffmpeg transcoding failed (${code}): ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}
