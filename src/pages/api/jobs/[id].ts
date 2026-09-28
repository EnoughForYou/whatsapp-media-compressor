import type { APIRoute } from 'astro';
import { getJobById, toAnalysis, toOutputMeta } from '../../../lib/server/db';
import type { Job } from '../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
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

  const responseData: Job = {
    jobId: job.id,
    state: job.state,
    progress: job.progress,
    analysis: toAnalysis(job),
    preset: job.preset,
    output: toOutputMeta(job),
    error: job.error,
    messageId: job.message_id,
    delivery: job.delivery,
  };

  return new Response(JSON.stringify(responseData), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
