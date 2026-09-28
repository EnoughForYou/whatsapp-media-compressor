import type { APIRoute } from 'astro';
import { getJobById, updateJob } from '../../../../lib/server/db';
import { sendMediaToWhatsApp } from '../../../../lib/server/whatsapp';

export const prerender = false;

export const POST: APIRoute = async ({ params }) => {
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

  if (job.state !== 'done' && job.state !== 'sent') {
    return new Response(JSON.stringify({ error: `Job belum selesai dikompres (status: ${job.state})` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  updateJob(id, { state: 'sending', delivery: 'queued' });

  try {
    const result = await sendMediaToWhatsApp(job);

    if (result.windowClosed) {
      updateJob(id, {
        state: 'done',
        error: result.error,
        delivery: 'failed',
      });
      return new Response(
        JSON.stringify({
          success: false,
          windowClosed: true,
          waMeUrl: result.waMeUrl,
          groupUrl: result.groupUrl,
          recipient: result.recipient,
          error: result.error,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    updateJob(id, {
      state: 'sent',
      message_id: result.messageId,
      delivery: 'sent',
      error: null,
    });

    return new Response(
      JSON.stringify({
        success: true,
        messageId: result.messageId,
        recipient: result.recipient,
        groupUrl: result.groupUrl,
        isMock: result.isMock,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    updateJob(id, {
      state: 'done',
      delivery: 'failed',
      error: err.message || 'Gagal mengirim ke WhatsApp',
    });

    return new Response(
      JSON.stringify({
        success: false,
        error: err.message || 'Gagal mengirim ke WhatsApp',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
