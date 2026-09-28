import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getJobById } from '../../../../lib/server/db';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id) {
    return new Response('Job ID diperlukan', { status: 400 });
  }

  const job = getJobById(id);
  if (!job || !job.output_path || !fs.existsSync(job.output_path)) {
    return new Response('File output tidak ditemukan', { status: 404 });
  }

  const stats = fs.statSync(job.output_path);
  const ext = path.extname(job.output_path);
  const downloadName = `${path.parse(job.original_name).name}_compressed${ext}`;

  const nodeStream = fs.createReadStream(job.output_path);
  const webStream = Readable.toWeb(nodeStream) as any;

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': job.output_mime || 'application/octet-stream',
      'Content-Length': stats.size.toString(),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName)}"`,
      'Cache-Control': 'no-cache',
    },
  });
};
