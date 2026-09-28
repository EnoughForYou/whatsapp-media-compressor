import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serverConfig } from './config';
import type { JobRecord } from './db';

export interface SendResult {
  messageId: string;
  isMock: boolean;
  groupUrl: string;
  recipient: string;
  error?: string;
  windowClosed?: boolean;
  waMeUrl?: string;
}

export async function sendMediaToWhatsApp(job: JobRecord): Promise<SendResult> {
  const filePath = job.output_path;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('File hasil kompresi tidak ditemukan.');
  }

  const recipient = serverConfig.waRecipient;
  const groupUrl = serverConfig.waGroupUrl;

  // If Meta Cloud API credentials are not yet configured in .env,
  // return simulated result with real direct links so user can test and open group
  if (!serverConfig.waToken || !serverConfig.waPhoneNumberId) {
    const simMessageId = `wamid.test_${Date.now().toString(36)}_${job.id}`;
    return {
      messageId: simMessageId,
      isMock: true,
      groupUrl,
      recipient,
    };
  }

  // Determine WhatsApp media type
  let waType: 'image' | 'video' | 'document' = 'document';
  if (job.output_mime?.startsWith('image/')) {
    waType = 'image';
  } else if (job.output_mime?.startsWith('video/')) {
    waType = 'video';
  }

  // 1. Upload media to WhatsApp Cloud API
  const uploadUrl = `https://graph.facebook.com/${serverConfig.waApiVersion}/${serverConfig.waPhoneNumberId}/media`;

  const fileBytes = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const blob = new Blob([fileBytes], { type: job.output_mime || 'application/octet-stream' });

  const formData = new FormData();
  formData.append('file', blob, fileName);
  formData.append('type', job.output_mime || 'application/octet-stream');
  formData.append('messaging_product', 'whatsapp');

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serverConfig.waToken}`,
    },
    body: formData,
  });

  const uploadJson = await uploadRes.json();
  if (!uploadRes.ok || !uploadJson.id) {
    const errText = uploadJson?.error?.message || `HTTP ${uploadRes.status}`;
    const code = uploadJson?.error?.code;
    throw new Error(`Gagal upload media ke Meta Cloud API (code: ${code}): ${errText}`);
  }

  const mediaId = uploadJson.id;

  // 2. Send message with mediaId
  const messagesUrl = `https://graph.facebook.com/${serverConfig.waApiVersion}/${serverConfig.waPhoneNumberId}/messages`;

  const mediaPayload: any = { id: mediaId };
  if (waType === 'document') {
    mediaPayload.filename = job.original_name;
  }
  mediaPayload.caption = `WhatsApp Compressor · ${job.original_name}`;

  const messageBody = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: waType,
    [waType]: mediaPayload,
  };

  const sendRes = await fetch(messagesUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serverConfig.waToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messageBody),
  });

  const sendJson = await sendRes.json();

  if (!sendRes.ok) {
    const errCode = sendJson?.error?.code;
    const errMsg = sendJson?.error?.message || `HTTP ${sendRes.status}`;

    // Error 131047 / 131026: 24h customer service window closed
    if (errCode === 131047 || errCode === 131026) {
      const waMeUrl = `https://wa.me/${serverConfig.waPhoneNumberId}?text=hi`;
      return {
        messageId: '',
        isMock: false,
        groupUrl,
        recipient,
        windowClosed: true,
        waMeUrl,
        error: 'Jendela 24 jam tertutup. Kirim pesan "hi" terlebih dahulu ke nomor bisnis.',
      };
    }

    throw new Error(`Meta API error (${errCode}): ${errMsg}`);
  }

  const messageId = sendJson.messages?.[0]?.id || `wamid.${Date.now()}`;

  return {
    messageId,
    isMock: false,
    groupUrl,
    recipient,
  };
}

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!serverConfig.waAppSecret) {
    // If app secret is not configured, pass in dev/test mode
    return true;
  }
  if (!signatureHeader) return false;

  const parts = signatureHeader.split('sha256=');
  if (parts.length !== 2) return false;
  const expectedSig = parts[1];

  const hmac = crypto.createHmac('sha256', serverConfig.waAppSecret);
  hmac.update(rawBody, 'utf8');
  const digest = hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch {
    return false;
  }
}
