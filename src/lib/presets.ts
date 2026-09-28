/**
 * WhatsApp Media Compressor — preset config.
 *
 * Source of truth: whatsapp-compressor-prd.md.
 * Numbers tagged [VERIFY] are NOT hardcoded facts — kept here as config
 * so they can be tuned without touching code. Re-verify against the live
 * app/API before shipping. [OFFICIAL] numbers come from Meta docs.
 */

export type MediaKind = 'image' | 'video' | 'document';
export type PresetId = 'chat-photo' | 'chat-video' | 'status' | 'document';

export interface Preset {
  id: PresetId;
  label: string;
  /** Primary use-case shown in the UI. */
  tagline: string;
  /** WhatsApp delivery kind. */
  kind: MediaKind;
  /** Hard limit the API enforces — files over this are rejected, not shrunk. [OFFICIAL] */
  maxBytes: number;
  /** Target for the compressor (may exceed nothing; validation is the gate). */
  targetBytes: number;
  /** User-facing spec summary. */
  specs: string[];
  /** Whether this preset transcodes at all (Document = passthrough). */
  transcodes: boolean;
}

/** Cloud API hard limits, in MB. [OFFICIAL] */
export const LIMITS = {
  imageMB: 5,
  videoMB: 16,
  documentMB: 100,
} as const;

export const PRESETS: Preset[] = [
  {
    id: 'chat-photo',
    label: 'Chat · Foto',
    tagline: 'Foto jernih di chat, tanpa pecah.',
    kind: 'image',
    maxBytes: LIMITS.imageMB * 1024 * 1024,
    targetBytes: LIMITS.imageMB * 1024 * 1024,
    // Longest side 1600px, JPEG sRGB 8-bit. [VERIFY]
    specs: ['1600 px sisi terpanjang', 'JPEG · sRGB 8-bit', `≤ ${LIMITS.imageMB} MB`],
    transcodes: true,
  },
  {
    id: 'chat-video',
    label: 'Chat · Video',
    tagline: 'Video 720p H.264, cocok di iOS & Android.',
    kind: 'video',
    maxBytes: LIMITS.videoMB * 1024 * 1024,
    targetBytes: LIMITS.videoMB * 1024 * 1024,
    // 720p, H.264 Main no B-frames, AAC, faststart. [OFFICIAL] for codec, [VERIFY] for size
    specs: ['720p · H.264 Main', 'tanpa B-frames · faststart', `≤ ${LIMITS.videoMB} MB`],
    transcodes: true,
  },
  {
    id: 'status',
    label: 'Status',
    tagline: '9:16 portrait, dipotong ke durasi Status.',
    kind: 'video',
    maxBytes: LIMITS.videoMB * 1024 * 1024,
    targetBytes: LIMITS.videoMB * 1024 * 1024,
    // 1080x1920 / 720x1280, ~30s clip. [VERIFY]
    specs: ['1080×1920 / 720×1280', '9:16 · ≤ 30 dtk', `≤ ${LIMITS.videoMB} MB`],
    transcodes: true,
  },
  {
    id: 'document',
    label: 'Dokumen',
    tagline: 'Tanpa kompresi, kualitas utuh.',
    kind: 'document',
    maxBytes: LIMITS.documentMB * 1024 * 1024,
    targetBytes: LIMITS.documentMB * 1024 * 1024,
    // Passthrough — hash must match on receive. [OFFICIAL] 100MB
    specs: ['tanpa re-encode', 'hash input = hash output', `≤ ${LIMITS.documentMB} MB`],
    transcodes: false,
  },
];

export const DEFAULT_PRESET: PresetId = 'chat-photo';