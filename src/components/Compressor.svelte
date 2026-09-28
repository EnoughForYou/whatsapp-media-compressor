<script lang="ts">
  import { PRESETS, DEFAULT_PRESET, LIMITS, type Preset, type PresetId, type MediaKind } from '../lib/presets';
  import {
    apiUpload, apiCompress, apiJob, apiSend, listenProgress, formatBytes, prettyDuration,
    type Analysis, type OutputMeta,
  } from '../lib/api';

  type Stage =
    | 'idle'
    | 'analyzing'
    | 'ready'
    | 'compressing'
    | 'done'
    | 'sending'
    | 'sent'
    | 'failed';

  let stage: Stage = 'idle';
  let error = '';

  let dragOver = false;
  let input: HTMLInputElement;

  let jobId = '';
  let analysis: Analysis | null = null;
  let selected: PresetId = DEFAULT_PRESET;
  let progress = 0;
  let output: OutputMeta | null = null;

  let delivery: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null = null;
  let messageId = '';
  let open24 = false;
  let waMeUrl = '';
  let recipient = '';
  let groupUrl = '';

  let activeSseUnsubscribe: (() => void) | null = null;
  let statusPollInterval: any = null;

  const ACCEPT = 'image/jpeg,image/png,image/heic,image/heif,video/mp4,video/quicktime,application/pdf';

  function pickPreset(id: PresetId) {
    selected = id;
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  }

  function onPick(e: Event) {
    const el = e.target as HTMLInputElement;
    const f = el.files?.[0];
    if (f) handleFile(f);
    el.value = '';
  }

  async function handleFile(f: File) {
    cleanupTimers();
    error = '';
    delivery = null;
    messageId = '';
    output = null;
    progress = 0;
    open24 = false;

    stage = 'analyzing';
    try {
      const res = await apiUpload(f);
      jobId = res.jobId;
      analysis = res.analysis;

      // Auto-select smart preset based on analyzed media kind
      if (analysis.kind === 'document') {
        selected = 'doc-original';
      } else if (analysis.kind === 'image') {
        selected = 'chat-image';
      } else if (analysis.kind === 'video') {
        selected = 'chat-video';
      }

      stage = 'ready';
    } catch (err: any) {
      setFail(err.message || 'Gagal menganalisis file. Coba file lain.');
    }
  }

  function setFail(msg: string) {
    cleanupTimers();
    error = msg;
    stage = 'failed';
  }

  function cleanupTimers() {
    if (activeSseUnsubscribe) {
      activeSseUnsubscribe();
      activeSseUnsubscribe = null;
    }
    if (statusPollInterval) {
      clearInterval(statusPollInterval);
      statusPollInterval = null;
    }
  }

  async function compress() {
    if (!analysis || !jobId) return;
    cleanupTimers();
    error = '';
    stage = 'compressing';
    progress = 0;

    try {
      await apiCompress(jobId, selected);

      // Connect to SSE for real-time progress
      activeSseUnsubscribe = listenProgress(jobId, (data) => {
        if (data.progress != null) {
          progress = data.progress;
        }
        if (data.state === 'done') {
          if (data.output) {
            output = data.output;
          }
          stage = 'done';
          cleanupTimers();
        } else if (data.state === 'failed') {
          setFail(data.error || 'Kompresi gagal.');
        }
      });

      // Backup polling every 1.5 seconds in case SSE stream is blocked
      statusPollInterval = setInterval(async () => {
        try {
          const j = await apiJob(jobId);
          if (j.progress != null && j.progress > progress) {
            progress = j.progress;
          }
          if (j.state === 'done') {
            output = j.output;
            stage = 'done';
            cleanupTimers();
          } else if (j.state === 'failed') {
            setFail(j.error || 'Kompresi gagal.');
          }
        } catch {
          // Ignore transient poll errors
        }
      }, 1500);

    } catch (err: any) {
      setFail(err.message || 'Gagal memulai kompresi.');
    }
  }

  function presetFor(id: PresetId): Preset {
    return PRESETS.find((x) => x.id === id) || PRESETS[0];
  }

  async function send() {
    if (!analysis || !jobId) return;
    error = '';
    stage = 'sending';
    delivery = 'queued';
    open24 = false;

    try {
      const res = await apiSend(jobId);

      if (res.groupUrl) groupUrl = res.groupUrl;
      if (res.recipient) recipient = res.recipient;

      if (res.windowClosed) {
        open24 = true;
        waMeUrl = res.waMeUrl || `https://wa.me/${recipient}?text=hi`;
        setFail(res.error || 'Jendela 24 jam tertutup.');
        return;
      }

      messageId = res.messageId || '';
      delivery = 'sent';
      stage = 'sent';

      // Poll delivery status from webhook records in DB
      let pollCount = 0;
      const deliveryPoll = setInterval(async () => {
        pollCount++;
        if (pollCount > 20) {
          clearInterval(deliveryPoll);
          return;
        }
        try {
          const j = await apiJob(jobId);
          if (j.delivery) {
            delivery = j.delivery;
            if (j.delivery === 'read') {
              clearInterval(deliveryPoll);
            }
          }
        } catch {}
      }, 2000);

    } catch (err: any) {
      setFail(err.message || 'Gagal mengirim. Periksa konfigurasi WhatsApp.');
    }
  }

  function reset() {
    cleanupTimers();
    stage = 'idle';
    error = '';
    analysis = null;
    output = null;
    delivery = null;
    messageId = '';
    progress = 0;
    jobId = '';
    open24 = false;
  }

  const pct = () => Math.round(progress);

  const sourceInfo = () => {
    if (!analysis) return null;
    if (analysis.kind === 'video') {
      const hdrTag = analysis.hdr ? ' · HDR' : '';
      return `${analysis.width}×${analysis.height} · ${analysis.codec ?? ''}${hdrTag} · ${prettyDuration(analysis.durationSec)}`;
    }
    return `${analysis.width ?? '?'}×${analysis.height ?? '?'} · ${analysis.codec ?? ''}`;
  };

  function saveRatio(a: Analysis, o: OutputMeta): number {
    if (!a || !o || a.sizeBytes === 0) return 0;
    const diff = Math.round((1 - o.sizeBytes / a.sizeBytes) * 100);
    return Math.max(0, diff);
  }

  $: current = presetFor(selected);
</script>

<!-- ================= -->
<!-- App shell (island) -->
<!-- ================= -->
<section class="mx-auto w-full max-w-3xl">
  {#if stage === 'idle'}
    {@render dropZone()}
  {:else if stage === 'analyzing'}
    <div class="rounded-2xl border border-ink-700 bg-ink-900/40 p-10 flex flex-col items-center text-center gap-4">
      <h2 class="text-lg font-medium text-ink-50">Menganalisis file</h2>
      {@render pulse()}
      <p class="text-ink-300">Membaca resolusi, codec, durasi, dan HDR…</p>
    </div>
  {:else if stage === 'failed'}
    <div class="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-10 flex flex-col items-center text-center gap-4">
      <h2 class="text-lg font-medium text-ink-50">Ada kendala</h2>
      <p class="text-rose-300">{error}</p>
      {#if open24 && waMeUrl}
        <div class="mt-2 flex flex-col items-center gap-3">
          <a
            href={waMeUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="cta bg-amber-500 text-ink-950 font-medium px-4 py-2 rounded-lg"
          >
            Kirim Pesan Buka Jendela (wa.me)
          </a>
        </div>
      {/if}
      <div class="mt-2 flex gap-3">
        <button class="ghost" onclick={() => { stage = 'ready'; }}>Kembali</button>
        <button class="cta" onclick={reset}>Pilih File Lain</button>
      </div>
    </div>
  {:else}
    {@render fileHeader()}
    {#if stage === 'ready'}
      {@render presetGrid()}
      <div class="mt-8 flex items-center justify-end gap-3">
        <button class="cta" onclick={compress} disabled={!analysis}>Kompres Sekarang</button>
      </div>
    {:else if stage === 'compressing'}
      {@render progressPanel()}
    {:else if stage === 'done'}
      {#if analysis && output}
        {@render sideBySide()}
      {/if}
      <div class="mt-8 flex flex-wrap items-center gap-3 justify-end">
        {#if current.kind === 'document'}
          <p class="text-xs text-ink-400 mr-auto">Dokumen dikirim apa adanya tanpa kompresi.</p>
        {/if}
        <a
          href="/api/jobs/{jobId}/download"
          download
          class="ghost text-sm flex items-center gap-1.5"
          title="Unduh file hasil kompresi ke perangkat"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Unduh Hasil
        </a>
        <button class="ghost" onclick={() => { stage = 'ready'; }}>Ubah preset</button>
        <button class="cta flex items-center gap-2" onclick={send}>
          <span>Kirim ke WhatsApp</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    {:else if stage === 'sending' || stage === 'sent'}
      {@render sendPanel()}
    {/if}
  {/if}
</section>

<!-- ============= -->
<!-- Snippets -->
<!-- ============= -->

{#snippet dropZone()}
  <div
    class="rounded-2xl border-2 border-dashed p-10 transition-colors {dragOver ? 'border-wa-500 bg-wa-500/5' : 'border-ink-700 bg-ink-900/40'} flex flex-col items-center text-center gap-4 cursor-pointer"
    role="button"
    tabindex="0"
    onclick={() => input?.click()}
    ondragover={(e) => { e.preventDefault(); dragOver = true; }}
    ondragleave={() => { dragOver = false; }}
    ondrop={onDrop}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input?.click(); } }}
  >
    <div class="flex h-16 w-16 items-center justify-center rounded-full bg-wa-500/10 text-wa-400">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0l-4 4m4-4l4 4"/><path d="M4 16v3a1 1 0 00 1 1h14a1 1 0 00 1-1v-3"/></svg>
    </div>
    <div>
      <h2 class="text-lg font-medium text-ink-50">Tarik file ke sini</h2>
      <p class="text-sm text-ink-400 mt-1">atau klik untuk pilih dari galeri</p>
    </div>
    <p class="text-xs text-ink-500">JPG · PNG · HEIC · MP4 · MOV · PDF</p>
    <input bind:this={input} type="file" class="hidden" accept={ACCEPT} onchange={onPick} />
  </div>

  <div class="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
    {#each PRESETS as p}
      <div class="rounded-xl border border-ink-800 bg-ink-900/40 p-3">
        <div class="metric text-wa-400 text-sm">{p.kind === 'image' ? `≤ ${LIMITS.imageMB} MB` : p.kind === 'video' ? `≤ ${LIMITS.videoMB} MB` : `≤ ${LIMITS.documentMB} MB`}</div>
        <div class="text-xs text-ink-400 mt-1">{p.label}</div>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet presetGrid()}
  <h3 class="text-sm uppercase tracking-wide text-ink-400 mt-8 mb-3">Pilih preset</h3>
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
    {#each PRESETS as p}
      <button
        class="text-left rounded-2xl border p-4 transition-all {selected === p.id ? 'border-wa-500 bg-wa-500/10' : 'border-ink-700 bg-ink-900/40 hover:border-ink-600'}"
        onclick={() => pickPreset(p.id)}
      >
        <div class="flex items-center justify-between">
          <span class="font-medium text-ink-50">{p.label}</span>
          {#if selected === p.id}{@render checkMark()}{/if}
        </div>
        <p class="text-sm text-ink-400 mt-1">{p.tagline}</p>
        <div class="mt-3 flex flex-wrap gap-1.5">
          {#each p.specs as s}<span class="chip">{s}</span>{/each}
        </div>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet sideBySide()}
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6">
    <div class="rounded-2xl border border-ink-700 bg-ink-900/40 p-4">
      <div class="text-xs text-ink-400 mb-1">Sebelum</div>
      <div class="metric text-2xl text-ink-50">{formatBytes(analysis!.sizeBytes)}</div>
      <div class="text-xs text-ink-500 mt-1">{sourceInfo() ?? '—'}</div>
    </div>
    <div class="rounded-2xl border border-wa-600 bg-wa-500/5 p-4">
      <div class="text-xs text-ink-400 mb-1">Sesudah</div>
      <div class="metric text-2xl text-wa-400">{output!.estimateLabel}</div>
      <div class="text-xs text-ink-500 mt-1">{output!.width ?? '?'}×{output!.height ?? '?'} · {output!.mime}</div>
    </div>
  </div>
  <div class="mt-4 flex items-center justify-between rounded-xl border border-ink-800 bg-ink-900/40 px-4 py-3">
    <span class="text-sm text-ink-300">Ukuran Berkurang</span>
    <span class="metric text-wa-400">−{saveRatio(analysis!, output!)}%</span>
  </div>
{/snippet}

{#snippet progressPanel()}
  <div class="mt-8 rounded-2xl border border-ink-700 bg-ink-900/40 p-6">
    <div class="flex items-center justify-between mb-4">
      <span class="text-sm font-medium text-ink-50">Mengompres via FFmpeg</span>
      <span class="metric text-wa-400">{pct()}%</span>
    </div>
    <div class="h-2.5 w-full overflow-hidden rounded-full bg-ink-800">
      <div class="h-full rounded-full bg-wa-500 transition-[width] duration-200" style="width: {progress}%"></div>
    </div>
    <p class="text-xs text-ink-500 mt-3">H.264 Main · tanpa B-frames · faststart · tone-map SDR</p>
  </div>
{/snippet}

{#snippet sendPanel()}
  <div class="mt-8 rounded-2xl border border-ink-700 bg-ink-900/40 p-6">
    <div class="flex items-center gap-3 mb-4">
      {#if stage === 'sending'}
        {@render spinner()}
        <span class="font-medium text-ink-50">Mengirim ke WhatsApp…</span>
      {:else}
        <span class="flex h-5 w-5 items-center justify-center rounded-full bg-wa-500/20 text-wa-400">
          {@render checkMark()}
        </span>
        <span class="font-medium text-ink-50">Terkirim ke WhatsApp</span>
      {/if}
    </div>

    <!-- Recipient & Group destination info card -->
    <div class="rounded-xl border border-ink-800 bg-ink-950/60 p-4 mb-4 text-xs space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-ink-400">Nomor Penerima:</span>
        <span class="font-mono text-ink-200">+{recipient}</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-ink-400">Grup Tujuan:</span>
        <a
          href={groupUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="text-wa-400 underline truncate max-w-[280px]"
        >
          {groupUrl}
        </a>
      </div>
    </div>

    {#if delivery}
      <ul class="space-y-2 text-sm">
        {@render statusRow('Queued', delivery, 'queued')}
        {@render statusRow('Sent', delivery, 'sent')}
        {@render statusRow('Delivered', delivery, 'delivered')}
        {@render statusRow('Read', delivery, 'read')}
      </ul>
    {/if}

    {#if messageId}
      <p class="metric text-xs text-ink-500 mt-4 break-all">ID: {messageId}</p>
    {/if}

    {#if open24}
      <div class="mt-5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
        <p class="text-sm text-amber-200 font-medium">Jendela 24 jam tertutup.</p>
        <p class="text-xs text-amber-200/80 mt-1">Kirim satu pesan "hi" ke nomor bisnis dulu lewat tombol berikut, lalu coba lagi.</p>
        <a
          href={waMeUrl || `https://wa.me/${recipient}?text=hi`}
          target="_blank"
          rel="noopener noreferrer"
          class="mt-3 inline-block cta bg-amber-500 text-ink-950 text-xs px-3 py-1.5 font-medium rounded-lg"
        >
          Buka WhatsApp (wa.me)
        </a>
      </div>
    {/if}

    <div class="mt-6 pt-4 border-t border-ink-800 flex flex-wrap items-center gap-3 justify-between">
      <a
        href={groupUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="cta bg-wa-600 hover:bg-wa-500 text-white text-xs px-4 py-2 rounded-xl flex items-center gap-2"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        Buka Grup WhatsApp
      </a>

      <div class="flex gap-2">
        <a
          href="/api/jobs/{jobId}/download"
          download
          class="ghost text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5"
        >
          Unduh File
        </a>
        <button class="ghost text-xs px-3 py-1.5 rounded-lg" onclick={reset}>
          File Baru
        </button>
      </div>
    </div>
  </div>
{/snippet}

{#snippet fileHeader()}
  <div class="flex items-center justify-between gap-3 mb-2">
    <div class="min-w-0">
      <div class="truncate font-medium text-ink-50">{analysis?.name}</div>
      <div class="text-xs text-ink-400 mt-0.5">{formatBytes(analysis?.sizeBytes ?? 0)} · {sourceInfo()}</div>
    </div>
    <button class="ghost" onclick={reset} title="Ganti file">Ganti</button>
  </div>
{/snippet}

{#snippet pulse()}
  <div class="flex gap-1.5">
    {#each [0,1,2] as i}<span class="h-2 w-2 rounded-full bg-wa-500 animate-pulse" style="animation-delay:{i * 0.15}s"></span>{/each}
  </div>
{/snippet}

{#snippet checkMark()}
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-wa-400"><path d="M20 6L9 17l-5-5"/></svg>
{/snippet}

{#snippet spinner()}
  <svg class="animate-spin h-5 w-5 text-wa-400" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" class="opacity-25"/><path d="M21 12a9 9 0 00-9-9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
{/snippet}

{#snippet statusRow(label, state, value)}
  <li class="flex items-center gap-3">
    <span class="inline-block h-2 w-2 rounded-full {state === value ? 'bg-wa-500' : order.indexOf(state as any) < order.indexOf(value as any) ? 'bg-ink-700' : 'bg-wa-500'} {state === value ? 'animate-pulse' : ''}"></span>
    <span class="text-ink-300">{label}</span>
  </li>
{/snippet}

<script module lang="ts">
  const order = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;
</script>