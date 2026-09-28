import type { APIRoute } from 'astro';
import { getJobById, toOutputMeta } from '../../../../lib/server/db';
import { queue } from '../../../../lib/server/queue';

export const prerender = false;

export const GET: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id) {
    return new Response('Job ID diperlukan', { status: 400 });
  }

  const job = getJobById(id);
  if (!job) {
    return new Response(`Job ${id} tidak ditemukan`, { status: 404 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Send initial state immediately
      send({
        state: job.state,
        progress: job.progress,
        output: toOutputMeta(job),
        error: job.error,
      });

      if (job.state === 'done' || job.state === 'failed') {
        controller.close();
        return;
      }

      // Subscribe to live queue updates
      const unsubscribe = queue.subscribe(id, (eventData) => {
        try {
          send(eventData);
          if (eventData.state === 'done' || eventData.state === 'failed') {
            unsubscribe();
            controller.close();
          }
        } catch {
          unsubscribe();
        }
      });

      // Cleanup if client closes connection
      request.signal.addEventListener('abort', () => {
        unsubscribe();
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};
