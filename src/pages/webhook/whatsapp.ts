import type { APIRoute } from 'astro';
import { serverConfig } from '../../lib/server/config';
import { updateJobDeliveryByMessageId, recordWebhookLog } from '../../lib/server/db';
import { verifyWebhookSignature } from '../../lib/server/whatsapp';

export const prerender = false;

// GET: Meta Webhook Verification handshake
export const GET: APIRoute = async ({ url }) => {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === serverConfig.waVerifyToken) {
    return new Response(challenge || '', { status: 200 });
  }

  return new Response('Forbidden: verify_token mismatch', { status: 403 });
};

// POST: Meta Webhook status updates (sent, delivered, read, failed)
export const POST: APIRoute = async ({ request }) => {
  try {
    // Critical: read raw body first before JSON parsing for signature verification
    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256');

    if (!verifyWebhookSignature(rawBody, signature)) {
      console.warn('[Webhook] Invalid X-Hub-Signature-256');
      return new Response('Unauthorized signature', { status: 401 });
    }

    if (!rawBody.trim()) {
      return new Response('EVENT_RECEIVED', { status: 200 });
    }

    const payload = JSON.parse(rawBody);

    const entries = payload.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value;
        if (!value) continue;

        // Process message status updates
        const statuses = value.statuses || [];
        for (const status of statuses) {
          const messageId = status.id;
          const statusName = status.status as 'sent' | 'delivered' | 'read' | 'failed';
          const timestamp = Number.parseInt(status.timestamp || '0', 10) * 1000;

          recordWebhookLog(messageId, statusName, timestamp || Date.now(), rawBody);

          if (messageId && ['sent', 'delivered', 'read', 'failed'].includes(statusName)) {
            updateJobDeliveryByMessageId(messageId, statusName);
          }
        }
      }
    }

    return new Response('EVENT_RECEIVED', { status: 200 });
  } catch (err: any) {
    console.error('[Webhook error]', err);
    return new Response('EVENT_RECEIVED', { status: 200 });
  }
};
