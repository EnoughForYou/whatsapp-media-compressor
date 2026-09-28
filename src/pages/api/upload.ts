import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import { serverConfig, initDirectories } from '../../lib/server/config';
import { insertJob } from '../../lib/server/db';
import { analyzeMedia } from '../../lib/server/media';
import { startCleanupTimer } from '../../lib/server/cleanup';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  initDirectories();
  startCleanupTimer();

  const contentType = request.headers.get('content-type') || '';
  const uploadsDir = path.join(serverConfig.dataDir, 'uploads');
  const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  let originalName = 'upload.bin';
  let mimeType = 'application/octet-stream';
  let tempFilePath = '';

  try {
    if (!request.body) {
      return new Response(JSON.stringify({ error: 'Request body kosong' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (contentType.includes('multipart/form-data')) {
      // Stream multipart using busboy directly to disk (never buffering full file in memory)
      await new Promise<void>((resolve, reject) => {
        const bb = busboy({
          headers: {
            'content-type': contentType,
          },
          limits: {
            fileSize: 200 * 1024 * 1024, // 200MB max limit
          },
        });

        let fileHandled = false;
        const filePromises: Promise<void>[] = [];

        bb.on('file', (_name, fileStream, info) => {
          fileHandled = true;
          originalName = info.filename || 'upload.bin';
          mimeType = info.mimeType || 'application/octet-stream';

          const ext = path.extname(originalName) || '.bin';
          tempFilePath = path.join(uploadsDir, `${jobId}_src${ext}`);
          const dest = fs.createWriteStream(tempFilePath);

          const p = new Promise<void>((res, rej) => {
            fileStream.pipe(dest);
            dest.on('finish', () => res());
            dest.on('error', (err) => rej(err));
          });
          filePromises.push(p);
        });

        bb.on('error', reject);
        bb.on('finish', async () => {
          if (!fileHandled) {
            reject(new Error('Tidak ada file yang diunggah'));
          } else {
            try {
              await Promise.all(filePromises);
              resolve();
            } catch (err) {
              reject(err);
            }
          }
        });

        // Convert Fetch ReadableStream to Node.js Readable stream
        const nodeStream = Readable.fromWeb(request.body as any);
        nodeStream.pipe(bb);
      });
    } else {
      // Direct raw binary stream upload
      const headerName = request.headers.get('x-file-name');
      if (headerName) {
        originalName = decodeURIComponent(headerName);
      }
      mimeType = contentType.split(';')[0] || 'application/octet-stream';

      const ext = path.extname(originalName) || '.bin';
      tempFilePath = path.join(uploadsDir, `${jobId}_src${ext}`);

      const nodeStream = Readable.fromWeb(request.body as any);
      const dest = fs.createWriteStream(tempFilePath);
      await pipeline(nodeStream, dest);
    }

    if (!fs.existsSync(tempFilePath)) {
      throw new Error('File gagal disimpan ke disk');
    }

    const stats = fs.statSync(tempFilePath);
    if (stats.size === 0) {
      fs.unlinkSync(tempFilePath);
      return new Response(JSON.stringify({ error: 'File kosong (0 bytes)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Run ffprobe analysis
    const analysis = await analyzeMedia(tempFilePath, originalName);

    // Save job into SQLite database
    insertJob({
      id: jobId,
      originalName,
      sourcePath: tempFilePath,
      sourceSize: stats.size,
      sourceMime: mimeType,
      analysis,
    });

    return new Response(JSON.stringify({ jobId, analysis }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {}
    }
    console.error('[Upload error]', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Gagal memproses file upload' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
