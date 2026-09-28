# OpenCode Instructions

- Repo: WhatsApp Media Compressor (Cloud API-based).
- Goal: Pre-encode media to WhatsApp specs, send to self via Cloud API.
- Source of truth: `whatsapp-compressor-prd.md` (PRD + knowledge base). Angka [VERIFY] jangan di-hardcode — simpan sebagai konfigurasi preset.

## Architecture (v1)

- Framework: **Astro (SSR)** + `@astrojs/node` mode `standalone`. Bukan Next.js.
- Deploy: proses Node persisten (VPS/Docker + Cloudflare Tunnel). **Jangan serverless** — worker video & SSE butuh proses hidup terus.
- Pages: `.astro` server-rendered; interaksi via island kecil (Svelte/Solid, bukan React). JS ke browser seminimal mungkin.
- API: `src/pages/api/*.ts`. Webhook: `src/pages/webhook/whatsapp.ts`.
- DB: SQLite via `better-sqlite3` (riwayat job + status webhook, bertahan saat restart).
- Queue: modul singleton in-proses, maks 1–2 job video sekaligus.
- Media: `ffmpeg`/`ffprobe` via `child_process.spawn`.

## Gotchas (mudah salah)

- **HEIC:** `sharp` prebuilt TIDAK decode HEIC. Decode dulu via `libvips`/`heif-convert`/ImageMagick+libheif (`spawn`), baru resize/encode JPEG pakai `sharp`.
- **Upload video besar:** stream `request.body` ke disk. JANGAN `request.formData()` (baca semua ke memori).
- **Webhook signature:** verifikasi `X-Hub-Signature-256` terhadap **raw body** — baca `request.text()` sebelum parse JSON.
- **Progres kompresi:** SSE, parse `ffmpeg -progress pipe:1`.

## WhatsApp Cloud API — critical

- Video: H.264 Main/Baseline, **tanpa B-frames** (`-bf 0`), `yuv420p`, `-movflags +faststart`. Profil High + B-frames ditolak klien Android.
- HDR (HLG/Dolby Vision) wajib tone-map ke SDR BT.709 (`zscale`+`tonemap`), kalau tidak warna pucat.
- Limits: Image 5MB, Video 16MB, Document 100MB. File > batas ditolak (bukan dikecilkan) — validasi `ffprobe` sebelum kirim.
- MIME harus cocok ekstensi (error 131053).
- Flow: `POST /{PHONE_NUMBER_ID}/media` → `media_id` → `POST /{PHONE_NUMBER_ID}/messages`.
- Jendela 24 jam: di luar window wajib template; UI harus tampilkan langkah perbaikan (tombol `wa.me`), bukan error mentah.

## Env (`.env`)

`WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_RECIPIENT` (format internasional tanpa `+`), `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `WA_API_VERSION`.

## Workflow

- **Prioritaskan M0 (uji fondasi) sebelum coding fitur:** buktikan Cloud API tidak re-encode, uji forward/Story dari hasil. Lihat PRD bagian 6.
- Milestone: M0 uji → M1 MVP (upload → preset Chat-Foto/Chat-Video/Dokumen → kirim) → M2 Status/HDR/webhook → M3 UX.
- Commands: `npm install`, `npm run dev`, `npm run build`.

## Non-negotiables

- Privasi: file dihapus otomatis (TTL), konten tidak dilog, token Meta hanya di server.
- Single user (pemilik), login sederhana.
- Jalur resmi (Cloud API) default; library tidak resmi (Baileys dsb.) hanya eksperimen nomor cadangan — risiko blokir permanen.

## Current state (Full-stack: Front-end + Backend complete)

- Framework: Astro SSR (`@astrojs/node` standalone) + Svelte island.
- Database: SQLite via `better-sqlite3` located at `data/db/compressor.sqlite`.
- Media engine: `ffmpeg` & `ffprobe` via `child_process.spawn` (`src/lib/server/media.ts`).
  - H.264 Main profile, no B-frames (`-bf 0`), `yuv420p`, `-movflags +faststart`.
  - Dynamic bitrate based on target size (≤16MB) and duration.
  - HDR tone-mapping to BT.709 SDR via `zscale` + `tonemap`.
  - Image scaling to 1600px sRGB JPEG with quality tuning (≤5MB).
- Queue: Singleton in-process queue (`src/lib/server/queue.ts`) with SSE progress streaming.
- TTL Cleaner: Automatic cleanup of uploads and outputs after configured TTL (`src/lib/server/cleanup.ts`).
- Endpoints:
  - `POST /api/upload`: Streaming upload (never buffering entire file in memory) + ffprobe analysis.
  - `POST /api/jobs/:id/compress`: Enqueue compression job.
  - `GET /api/jobs/:id`: Autoritative job state and metadata.
  - `GET /api/jobs/:id/progress`: Real-time SSE progress stream.
  - `GET /api/jobs/:id/download`: Direct download of compressed output.
  - `POST /api/jobs/:id/send`: Meta Cloud API upload & message send with 24h window detection.
  - `GET & POST /webhook/whatsapp`: Meta webhook verification and status event handling (`sent`, `delivered`, `read`, `failed`).
- WhatsApp Destination configured:
  - Recipient: Configurable via WA_RECIPIENT (.env)
  - Group: Configurable via WA_GROUP_URL (.env)
