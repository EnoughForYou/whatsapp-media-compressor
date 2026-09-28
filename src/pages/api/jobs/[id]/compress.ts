import type { APIRoute } from 'astro';
import { getJobById } from '../../../../lib/server/db';
import { queue } from '../../../../lib/server/queue';
import type { PresetId } from '../../../../lib/presets';

export const prerender = false;

export const POST: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ error: 'Job ID diperlukan' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const job = getJobById(id);
  if (!job) {
    return new Response(JSON.stringify({ error: `Job ${id} tidak ditemukan` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const preset = (body?.preset || 'chat-video') as PresetId;

    queue.enqueue(id, preset);

    return new Response(JSON.stringify({ jobId: id, status: 'compressing' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Gagal memulai kompresi' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
