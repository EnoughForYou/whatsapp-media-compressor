# WhatsApp Media Compressor — Knowledge Base & PRD

Status: Draft v1 · Disusun 28 Sep 2026
Tujuan dokumen: bahan referensi untuk membangun website yang mengompres foto/video ke spesifikasi WhatsApp, lalu mengirim hasilnya otomatis ke WhatsApp pemilik (nomor sendiri).

Label sumber angka:
- **[OFFICIAL]** dari dokumentasi Meta.
- **[VERIFY]** dari sumber pihak ketiga / uji pengguna. Wajib diuji sendiri sebelum dijadikan konstanta.

---

## 1. Ringkasan masalah

Foto/video terlihat HD di galeri, tapi pecah setelah dikirim lewat WhatsApp (chat maupun Status). Penyebab: WhatsApp meng-*re-encode* media dengan resolusi dan bitrate rendah. Kompresi bertingkat (file sudah dikompres → dikompres lagi oleh WhatsApp) memperburuk hasil.

Ide produk: **pre-encode** media ke spesifikasi yang dekat dengan target WhatsApp (sehingga re-encode minim kerusakan) atau **kirim tanpa kompresi** (dokumen), lalu antar hasilnya ke WhatsApp pengguna secara otomatis.

---

## 2. Knowledge: aturan kompresi WhatsApp

### 2.1 Aplikasi WhatsApp (konsumen, iPhone/Android)

| Aspek | Nilai | Sumber |
|---|---|---|
| Foto standar | sisi terpanjang ≈ 1600 px, JPEG ≈ q75, ukuran sering ≈ 100–300 KB | [VERIFY] |
| Foto mode HD | resolusi lebih tinggi dari standar, tetap dikompres | [VERIFY] |
| Video standar | ≈ 480p (contoh uji: 476×848, 71 MB → 2,2 MB) | [VERIFY] |
| Video mode HD | dibatasi 720p (contoh uji: 718×1280, ≈ 4 MB); 1080p/4K tetap diturunkan | [VERIFY] |
| Batas video inline | ≈ 16 MB | [VERIFY] |
| Kirim sebagai Dokumen | tanpa kompresi, sampai 2 GB | [VERIFY] |
| Status: video | ≈ 30 detik per klip | [VERIFY] |
| Status: foto/video | tidak ada opsi HD di Status; ukuran ideal 1080×1920 (9:16) | [VERIFY] |
| Foto profil | disimpan 640×640 | [VERIFY] |

Catatan: angka persis berubah antar versi aplikasi. Jangan hardcode sebagai fakta; simpan sebagai konfigurasi preset.

### 2.2 WhatsApp Business Platform (Cloud API)

Tidak ada pengaturan kompresi; hanya batas keras. File yang melewati batas ditolak, bukan dikecilkan otomatis.

| Tipe | Batas | Sumber |
|---|---|---|
| Gambar (JPEG/PNG, 8-bit RGB/RGBA) | 5 MB | [OFFICIAL/VERIFY] |
| Video (MP4) | 16 MB | [OFFICIAL/VERIFY] |
| Dokumen | 100 MB | [OFFICIAL] |
| Batas maksimum media message | 100 MB | [OFFICIAL] |

Aturan teknis penting dari Meta [OFFICIAL]:
- Video H.264 profil **High dengan B-frames tidak didukung** klien Android. Pakai profil **Main tanpa B-frames** atau **Baseline**.
- Letakkan `moov` sebelum `mdat` (`-movflags +faststart`).
- MIME type harus sesuai ekstensi (error 131053 jika tidak cocok).
- Upload dua langkah: `POST /{PHONE_NUMBER_ID}/media` → dapat `media_id` → `POST /{PHONE_NUMBER_ID}/messages` dengan `media_id` tersebut.
- Media tersimpan di server WhatsApp ±14 hari [VERIFY].

### 2.3 Jendela 24 jam

Pesan bebas (termasuk media) hanya boleh dikirim saat *customer service window* terbuka: 24 jam sejak pengguna terakhir mengirim pesan ke nomor bisnis. Di luar itu wajib memakai **template** yang sudah disetujui.

### 2.4 Implikasi desain

1. Mengirim via Cloud API tidak melewati kompresi aplikasi konsumen, hanya batas keras. Ini keuntungan utama jalur resmi. **Perlu dibuktikan lewat uji** (bandingkan file asli vs file yang diterima).
2. Jika hasil dari chat kemudian di-*forward* atau diposting ke Story, WhatsApp bisa meng-*encode* ulang. **Belum diketahui seberapa parah — uji dulu** (lihat bagian 8).
3. Mode dokumen = kualitas terjaga, tapi tampil sebagai file, bukan pratinjau. Sediakan sebagai pilihan, bukan default.

---

## 3. Knowledge: teknik kompresi

### 3.1 Foto
- Input umum iPhone: **HEIC**, kadang Display P3. Konversi ke **JPEG sRGB 8-bit** (Cloud API menolak 16-bit / CMYK).
- Terapkan rotasi EXIF (`orientation`) sebelum resize, lalu buang orientasi.
- Resize sisi terpanjang sesuai preset; pakai Lanczos.
- Kualitas JPEG 82–88 untuk target ≤ 5 MB; turunkan bertahap sampai muat.
- Sharpening ringan setelah downscale (unsharp mask kecil) mengurangi kesan buram.

### 3.2 Video
- Input umum iPhone: **HEVC (H.265) .MOV**, sering **HDR (HLG/Dolby Vision)**, frame rate variabel.
- Output: **MP4, H.264 (Main), AAC**, `yuv420p`, frame rate konstan (≤ 30 fps untuk preset ukuran kecil).
- **HDR → SDR**: jika input HDR dan hanya di-*transcode* langsung, warna jadi pucat. Perlu tone-mapping (`zscale` + `tonemap` di ffmpeg) ke BT.709.
- Rotasi: perhatikan metadata rotate pada video portrait.
- Video pendek ≤ 60 dtk: pertahankan 720p, turunkan bitrate. Video 1–3 menit: 480p dengan bitrate lebih rendah [VERIFY].

### 3.3 Rumus bitrate untuk target ukuran

```
total_kbps  = (target_MB × 8192 × 0.95) / durasi_detik
video_kbps  = total_kbps − audio_kbps      # audio 96–128
```
Faktor 0,95 = ruang aman untuk container overhead. Contoh: 16 MB, 60 dtk, audio 128 kbps → total ≈ 2076 kbps → video ≈ 1950 kbps.

### 3.4 Contoh perintah ffmpeg (video, target ukuran)

```bash
ffmpeg -i input.mov \
  -vf "scale=-2:720:flags=lanczos,fps=30,format=yuv420p" \
  -c:v libx264 -profile:v main -bf 0 -preset slow \
  -b:v 1950k -maxrate 2400k -bufsize 4800k \
  -c:a aac -b:a 128k -ac 2 \
  -movflags +faststart output.mp4
```
Untuk akurasi ukuran, gunakan two-pass (`-pass 1` / `-pass 2`). Untuk HDR tambahkan filter tone-mapping sebelum `scale`. Cek hasil dengan `ffprobe`; jika > 16 MB, ulangi dengan bitrate lebih rendah.

---

## 4. Knowledge: jalur pengiriman ke WhatsApp nomor sendiri

| | **A. Cloud API (resmi)** | **B. Library tidak resmi (Baileys / whatsapp-web.js)** |
|---|---|---|
| Nomor pengirim | Nomor bisnis khusus (nomor uji dari Meta, atau nomor sendiri yang didaftarkan) | Nomor pribadi via QR / pairing |
| Kirim ke diri sendiri | Nomor pribadi jadi **penerima** | Bisa *self-chat* |
| Risiko akun | Aman secara ToS | **Melanggar ToS; nomor bisa diblokir permanen** |
| Syarat | Akun Meta Business + app, token, webhook HTTPS publik | Sesi QR, server berjalan terus |
| Batasan | Jendela 24 jam, template di luar jendela, batas ukuran keras | Stabilitas tergantung perubahan protokol WhatsApp |
| Biaya | Utility template gratis di dalam jendela; pesan di luar jendela berbayar per pesan [VERIFY] | Gratis, biaya server saja |
| Cocok untuk | Produk yang dipakai jangka panjang | Prototipe cepat |

**Rekomendasi:** Jalur A sebagai default. Jalur B hanya sebagai opsi eksperimen dengan **nomor cadangan**, bukan nomor utama.

Catatan Jalur A untuk kebutuhan "kirim ke nomor sendiri":
- Nomor uji Meta gratis, penerima harus didaftarkan/diverifikasi di dashboard (jumlah terbatas) [VERIFY].
- Agar jendela 24 jam terbuka, pengguna mengirim satu pesan ("hi") ke nomor bisnis dulu. Website bisa menampilkan tombol/tautan `wa.me/<nomor_bisnis>?text=...` untuk ini.
- Token sementara berlaku 24 jam; produksi pakai *system user token* permanen [OFFICIAL/VERIFY].
- Mendaftarkan nomor pribadi yang sedang dipakai di aplikasi WhatsApp biasa ke Cloud API punya konsekuensi (nomor tidak bisa dipakai bersamaan seperti biasa, kecuali mode coexistence dengan WhatsApp Business app). Periksa dokumentasi Meta terbaru sebelum memutuskan.

---

## 5. PRD

### 5.1 Tujuan
- Pengguna mengunggah foto/video → website menghasilkan versi terkompresi sesuai preset WhatsApp → hasil terkirim otomatis ke WhatsApp pemilik.
- Kualitas visual hasil akhir di WhatsApp lebih baik daripada mengirim file asli lewat mode standar.

### 5.2 Bukan tujuan (v1)
- Kirim ke kontak orang lain / broadcast.
- Posting otomatis ke Status (tidak ada API resmi untuk ini).
- Akun multi-pengguna, pembayaran.
- Editor media (crop, filter).

### 5.3 Pengguna
Satu pengguna: pemilik (Naufal). Akses dilindungi login sederhana.

### 5.4 Alur utama
1. Buka website → unggah file (drag-drop / pilih dari galeri iPhone via Safari).
2. Pilih preset: **Chat**, **Status**, atau **Dokumen (tanpa kompresi)**.
3. Website menganalisis file (resolusi, codec, durasi, HDR) dan menampilkan estimasi ukuran hasil.
4. Kompresi berjalan; progres tampil.
5. Pratinjau hasil + ukuran + perbandingan sebelum/sesudah.
6. Tombol **Kirim ke WhatsApp** (atau otomatis setelah selesai jika diaktifkan).
7. Server mengunggah ke Cloud API dan mengirim; status pengiriman tampil (queued / sent / delivered / read / failed via webhook).

### 5.5 Kebutuhan fungsional

| ID | Kebutuhan | Prioritas |
|---|---|---|
| FR-1 | Terima JPG, PNG, HEIC/HEIF, MP4, MOV (HEVC/H.264) | P0 |
| FR-2 | Preset **Chat-Foto**: sisi terpanjang 1600 px, JPEG sRGB, ≤ 5 MB | P0 |
| FR-3 | Preset **Chat-Video**: 720p, H.264 Main tanpa B-frames, AAC, MP4 faststart, ≤ 16 MB | P0 |
| FR-4 | Preset **Status**: 1080×1920 / 720×1280 (9:16), video dipotong ke batas durasi Status; peringatan jika lebih | P1 |
| FR-5 | Preset **Dokumen**: tanpa kompresi, ≤ 100 MB (batas API) | P0 |
| FR-6 | Deteksi HDR dan tone-map ke SDR BT.709 | P1 |
| FR-7 | Hitung bitrate otomatis dari durasi + target ukuran | P0 |
| FR-8 | Validasi hasil (`ffprobe`): ukuran, codec, profil, MIME, sebelum kirim | P0 |
| FR-9 | Kirim via Cloud API (upload media → message) ke nomor terkonfigurasi | P0 |
| FR-10 | Deteksi jendela 24 jam tertutup → tampilkan instruksi/template fallback | P1 |
| FR-11 | Webhook status pengiriman + riwayat | P1 |
| FR-12 | Hapus file sumber & hasil otomatis setelah N jam | P0 |
| FR-13 | Pratinjau sebelum/sesudah (ukuran, resolusi, bitrate) | P2 |

### 5.6 Kebutuhan non-fungsional
- **Privasi:** file pribadi. Hapus otomatis, tidak disimpan permanen, tidak dilog kontennya.
- **Keamanan:** autentikasi (login/passkey/token statis untuk v1), rate limit, validasi MIME server-side, batas ukuran upload, token Meta hanya di server (`.env`), verifikasi tanda tangan webhook (`X-Hub-Signature-256`).
- **Performa:** foto < 3 dtk; video 60 dtk 1080p → < 2× durasi pada server 2–4 vCPU (indikatif).
- **Kompatibilitas:** Safari iOS (upload dari Photos). Input HEIC/HEVC wajib bisa diproses.
- **Reliabilitas:** antrean job, retry dengan backoff, pesan error yang jelas untuk kode error Meta (mis. 131052, 131053, di luar jendela).

### 5.7 Arsitektur (usulan)

Stack v1: **Astro (SSR, adapter Node standalone)**, satu proyek untuk UI dan API.

- **Framework:** Astro dengan `@astrojs/node` mode `standalone`. Wajib proses Node yang hidup terus (VPS/Docker); jangan deploy ke serverless karena worker video dan SSE butuh proses persisten.
- **Halaman:** `.astro` server-rendered, JavaScript ke browser seminimal mungkin. Interaksi (drop zone, progres, pratinjau) berupa satu atau dua *island* kecil (Svelte atau Solid; bukan React).
- **API:** endpoint di `src/pages/api/*.ts` (upload, compress, send, status). Progres kompresi lewat **SSE** dari endpoint yang mem-parse `ffmpeg -progress pipe:1`.
- **Upload video besar:** alirkan `request.body` (stream) ke disk. Jangan pakai `request.formData()`, karena membaca seluruh file ke memori.
- **Worker/antrean:** modul singleton di proses yang sama, antrean in-memory dengan batas 1–2 job video sekaligus; state job disimpan di SQLite agar bertahan saat restart.
- **Database:** SQLite (`better-sqlite3`) untuk riwayat job dan status webhook.
- **Pemroses media:** `ffmpeg`/`ffprobe` via `child_process.spawn`. Foto HEIC → JPEG: **jangan mengandalkan `sharp` bawaan**, binary prebuilt-nya tidak mendekode HEIC; pakai `libvips`/`heif-convert`/ImageMagick dengan libheif via `spawn`. Setelah itu resize/encode JPEG boleh pakai `sharp`.
- **Penyimpanan:** direktori sementara + job pembersih TTL.
- **Integrasi:** WhatsApp Cloud API (Graph API) lewat `fetch`/`FormData`; webhook di `src/pages/webhook/whatsapp.ts`, verifikasi `X-Hub-Signature-256` dengan `node:crypto` terhadap **raw body** (baca `request.text()` sebelum parse JSON). Webhook Meta berformat JSON sehingga tidak terkena pemeriksaan origin Astro untuk form.
- **Deploy:** Docker (Node + ffmpeg + libvips) di VPS kecil, di belakang Cloudflare Tunnel.

Alternatif jika Astro kurang cocok:
- **Go + HTMX:** satu binary, memori kecil; HEIC tetap via libvips.
- **Elixir + Phoenix LiveView + Oban:** progres realtime dan antrean bawaan; kurva belajar lebih tinggi.
- `ffmpeg.wasm` di browser hanya untuk eksperimen (batas memori Safari iOS, lambat); v1 tetap server-side.

Endpoint minimum:
```
POST /api/upload          -> { jobId, analysis }
POST /api/jobs/:id/compress { preset }
GET  /api/jobs/:id        -> { state, progress, outputMeta }
POST /api/jobs/:id/send   -> { messageId }
GET  /webhook/whatsapp    (verifikasi)   POST /webhook/whatsapp (status/pesan masuk)
```

Konfigurasi (`.env`): `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_RECIPIENT` (format internasional tanpa `+`), `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `WA_API_VERSION` (ikuti versi terbaru di dokumentasi Meta).

### 5.8 Kriteria penerimaan
- Foto HEIC 12 MP dari iPhone → JPEG ≤ 5 MB, sisi terpanjang sesuai preset, orientasi benar, diterima di WhatsApp tanpa error.
- Video HEVC HDR 1 menit → MP4 ≤ 16 MB, warna tidak pucat, diputar normal di iPhone **dan** Android.
- Preset Dokumen: hash file yang diterima = hash file yang diunggah.
- File > batas API ditolak dengan pesan jelas sebelum upload ke Meta.
- Pengiriman gagal (jendela tertutup) menampilkan langkah perbaikan, bukan error mentah.
- File pengguna terhapus otomatis sesuai TTL.

### 5.9 Risiko

| Risiko | Dampak | Mitigasi |
|---|---|---|
| WhatsApp meng-encode ulang saat forward/Story | Tujuan "tidak pecah" tidak tercapai penuh | Uji empiris; jika terbukti, tonjolkan preset Dokumen + preset yang mendekati target WhatsApp |
| Angka batas berubah | Preset usang | Simpan sebagai konfigurasi; uji berkala |
| Jendela 24 jam | Pengiriman otomatis gagal | Tombol `wa.me` untuk membuka jendela; template utility sebagai fallback |
| Akun diblokir (jalur B) | Kehilangan nomor | Jalur A default; jalur B hanya nomor cadangan |
| Memori/CPU server untuk video | Job gagal/lambat | Batas ukuran, antrean, satu job video sekaligus |
| Privasi file | Kebocoran | TTL, akses terautentikasi, tidak ada URL publik permanen |

### 5.10 Milestone
1. **M0 — Uji fondasi (wajib dulu):** kirim foto & video sampel via Cloud API ke nomor sendiri; bandingkan kualitas vs kirim biasa dari iPhone; uji forward & Story dari hasil tersebut.
2. **M1 — MVP:** upload → preset Chat-Foto/Chat-Video/Dokumen → kirim ke nomor sendiri.
3. **M2:** preset Status, HDR tone-map, webhook status, riwayat.
4. **M3:** perbaikan UX, pratinjau sebelum/sesudah, opsi ffmpeg.wasm.

---

## 6. Yang harus diuji sebelum coding (M0)

1. Apakah gambar/video yang dikirim via Cloud API diterima **tanpa** re-encode? (bandingkan resolusi, bitrate, hash)
2. Kualitas setelah **forward** ke kontak dan setelah **posting ke Story** dari file yang diterima.
3. Apakah foto 1600 px vs 2048 px (≤ 5 MB) terlihat berbeda di layar iPhone penerima.
4. Batas durasi Status yang berlaku sekarang.
5. Perilaku nomor uji Meta: batas penerima, kebutuhan template, masa berlaku token.
6. Opsi pendaftaran nomor sendiri (dedicated vs coexistence) menurut dokumentasi Meta terbaru.

## 7. Referensi

- Meta for Developers — WhatsApp Business Platform, Media (batas 100 MB, H.264 Main/Baseline, faststart, alur upload).
- Panduan pihak ketiga 2026 tentang ukuran gambar/video WhatsApp (angka 1600 px, HD 720p, batas 16 MB, dokumen 2 GB) — semua **[VERIFY]**.
- Perbandingan Cloud API vs Baileys/whatsapp-web.js (risiko blokir nomor pada jalur tidak resmi).
