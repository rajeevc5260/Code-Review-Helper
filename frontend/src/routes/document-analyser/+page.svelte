<script lang="ts">
  import { onMount } from 'svelte';
  import ChatPanelDoc from './ChatPanelDoc.svelte';

  export let data: { userId: string; backendUrl: string; conversations?: any[] };

  let backendUrl = data.backendUrl;
  let userId = data.userId;
  const initialConversations = data.conversations ?? [];

  // ===== PERSISTENCE (per-user) =====
  const LS_KEY = (u: string) => `adr:docstate:${u}`;
  const CONV_KEY = (u: string, fid: string) => `adr:conv:${u}:${fid}`;

  // NEW: block reactive persist until we've hydrated from LS
  let hydrated = false;

  // only persist when we actually have *something* to store
  function persistState() {
    try {
      // don't write an empty payload that would wipe previous state
      if (!uploadedFileId && !chatTitle) return;
      const payload = { uploadedFileId, chatTitle };
      localStorage.setItem(LS_KEY(userId), JSON.stringify(payload));
    } catch {}
  }
  function hydrateState() {
    try {
      const raw = localStorage.getItem(LS_KEY(userId));
      if (!raw) return;
      const d = JSON.parse(raw);
      if (typeof d?.uploadedFileId === 'string' && d.uploadedFileId) {
        uploadedFileId = d.uploadedFileId;
      }
      if (typeof d?.chatTitle === 'string' && d.chatTitle) {
        chatTitle = d.chatTitle;
      }
    } catch {}
  }
  function clearPersistedFor(prevFileId?: string | null) {
    try { localStorage.removeItem(LS_KEY(userId)); } catch {}
    if (prevFileId) {
      try { sessionStorage.removeItem(CONV_KEY(userId, prevFileId)); } catch {}
    }
  }

  // ===== File state =====
  let file: File | null = null;

  // Upload state
  let uploading = false;
  let uploadMsg: string | null = null;
  let uploadedFileId: string | null = null;
  let uploadPct = 0;

  // Verify state
  let verifying = false;
  let verifyMsg: string | null = null;
  let verifySpinnerTick = 0;

  // Link state
  let linkBusy = false;
  let downloadUrl: string | null = null;
  let linkErr: string | null = null;

  // Title for chat (basename without extension)
  let chatTitle = '';

  const ACCEPT = '.pdf,.doc,.docx';

  // ===== helpers =====
  function fmtSize(n?: number) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  function baseFromName(name = '') {
    const m = name.match(/^(.*)\.(pdf|docx?|PDF|DOCX?)$/);
    return (m ? m[1] : name).trim();
  }
  function xhrPut(url: string, blob: Blob, onProgress: (p: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(Math.max(0, Math.min(1, ev.loaded / ev.total))); };
      xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || ''); else reject(new Error(`HTTP ${xhr.status}`)); };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(blob);
    });
  }

  // ===== lifecycle =====
  onMount(async () => {
    hydrateState();
    hydrated = true; // <-- allow reactive persist after we’ve loaded prior state

    // Reflect restored state in UI and re-verify availability
    if (uploadedFileId) {
      uploadMsg = 'Document uploaded ✓';
      await verifyReady(); // will set verifyMsg or error
    }
  });

  // ===== reset / pick =====
  function resetAll() {
    file = null;
    uploading = false; uploadMsg = null; uploadPct = 0;
    verifying = false; verifyMsg = null; verifySpinnerTick = 0;
    linkBusy = false; downloadUrl = null; linkErr = null;
    // keep uploadedFileId & chatTitle for persistence unless explicit new pick
    try { const el = document.getElementById('doc-file') as HTMLInputElement | null; if (el) el.value = ''; } catch {}
  }

  async function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    if (f && !/\.(pdf|docx?|PDF|DOCX?)$/.test(f.name)) {
      alert('Please choose a PDF or Word file (.pdf, .doc, .docx).');
      (e.target as HTMLInputElement).value = '';
      file = null;
      return;
    }

    // purge old persisted convo + page state if switching to a new doc
    const prev = uploadedFileId;
    clearPersistedFor(prev || undefined);

    resetAll();

    file = f;
    chatTitle = baseFromName(f?.name || '');
    // persist early so a reload during upload still remembers intent
    persistState();

    if (file) await startUpload();
  }

  // ===== upload flow =====
  async function startUpload() {
    if (!file) return;
    uploadPct = 0; uploading = true; uploadMsg = null; uploadedFileId = null; downloadUrl = null; linkErr = null;

    try {
      // 1) Bootstrap
      const start = await fetch('/document-analyser', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, type: file.type || 'application/octet-stream', size: file.size })
      });
      const startData = await start.json();
      if (!start.ok) throw new Error(startData?.error || 'Failed to start upload');

      // 2) Upload
      if (startData.mode === 'single' && startData.uploadUrl) {
        await xhrPut(startData.uploadUrl, file, (p) => (uploadPct = Math.floor(p * 100)));
        uploadedFileId = startData.fileId;
      } else if (startData.mode === 'multipart') {
        const { fileId, uploadId, partSize, urls } = startData as { fileId: string; uploadId: string; partSize: number; urls: { partNumber: number; url: string }[]; };
        const total = file.size || 1;
        for (const { partNumber, url } of urls.sort((a, b) => a.partNumber - b.partNumber)) {
          const startOff = (partNumber - 1) * partSize;
          const endOff = Math.min(startOff + partSize, total);
          const chunk = file.slice(startOff, endOff);
          await xhrPut(url, chunk, (p) => {
            const loadedInPart = Math.floor(p * (endOff - startOff));
            const overallLoaded = startOff + loadedInPart;
            uploadPct = Math.floor((overallLoaded / total) * 100);
          });
        }
        uploadPct = 100;
        const complete = await fetch('/document-analyser', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'completeMultipart', fileId, uploadId, parts: [] })
        });
        const cdata = await complete.json();
        if (!complete.ok || cdata?.success !== true) throw new Error(cdata?.error || 'Failed to complete multipart');
        uploadedFileId = fileId;
      } else {
        throw new Error('Unknown upload mode');
      }

      uploadMsg = 'Document uploaded ✓';

      // persist (so reload keeps last doc)
      persistState();

      await verifyReady();
    } catch (e: any) {
      uploadMsg = `Upload failed: ${e?.message ?? e}`;
    } finally {
      uploading = false;
    }
  }

  async function verifyReady() {
    if (!uploadedFileId) return;
    verifying = true; verifyMsg = null;
    const t = setInterval(() => (verifySpinnerTick = (verifySpinnerTick + 1) % 4), 400);
    try {
      const r = await fetch('/document-analyser', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'meta', fileId: uploadedFileId })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'Meta check failed');

      // if backend signals the file vanished, clean up persisted state
      if (d?.exists === false) {
        clearPersistedFor(uploadedFileId);
        uploadedFileId = null;
        uploadMsg = null;
        verifyMsg = 'Not found';
      } else {
        verifyMsg = d?.ready ? 'Ready' : 'Processing…';
      }
    } catch (e: any) {
      verifyMsg = `Check failed: ${e?.message ?? e}`;
    } finally {
      clearInterval(t);
      verifying = false;
      // keep storage in sync
      persistState();
    }
  }

  async function getDownload() {
    if (!uploadedFileId) return;
    linkBusy = true; linkErr = null; downloadUrl = null;
    try {
      const r = await fetch(`/document-analyser?id=${encodeURIComponent(uploadedFileId)}`);
      const d = await r.json();
      if (!r.ok || !d?.url) throw new Error(d?.error || 'Failed to get URL');
      downloadUrl = d.url;
    } catch (e: any) {
      linkErr = e?.message ?? 'Failed to fetch link';
    } finally {
      linkBusy = false;
    }
  }

  // keep LS updated when these change — but ONLY after hydration
  $: if (hydrated) persistState();

  // —— badge / stripe helpers (unchanged) ——
  function eventBadgeClasses(t: string) {
    if (t.includes('error')) return 'bg-rose-50 text-rose-800 border border-rose-100';
    if (t.includes('complete')) return 'bg-emerald-50 text-emerald-800 border border-emerald-100';
    if (t.includes('started') || t.includes('active')) return 'bg-sky-50 text-sky-800 border border-sky-100';
    if (t === 'progress' || t === 'info') return 'bg-amber-50 text-amber-900 border-amber-100';
    return 'bg-gray-50 text-gray-800 border-gray-100';
  }
  function eventStripeClasses(t: string) {
    if (t.includes('error')) return 'border-rose-100 bg-rose-50/60';
    if (t.includes('complete')) return 'border-emerald-100 bg-emerald-50/60';
    if (t.includes('started') || t.includes('active')) return 'border-sky-100 bg-sky-50/60';
    if (t === 'progress' || t === 'info') return 'border-amber-100 bg-amber-50/60';
    return 'border-gray-100 bg-gray-50/60';
  }
  const Icon = {
    upload: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 12V4m0 0l-3 3m3-3l3 3"/></svg>`,
    verify: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4"/><path d="M12 22a10 10 0 110-20 10 10 0 010 20z"/></svg>`,
    link:   () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 13a5 5 0 007.07 0l2.12-2.12a5 5 0 10-7.07-7.07L10.1 5M14 11a5 5 0 00-7.07 0L4.8 13.12a5 5 0 107.07 7.07L14 18.9"/></svg>`
  };
  function stepBadge(status: 'idle'|'active'|'complete'|'error') {
    return status === 'error' ? eventBadgeClasses('error')
      : status === 'complete' ? eventBadgeClasses('complete')
      : status === 'active' ? eventBadgeClasses('active')
      : eventBadgeClasses('info');
  }
  function stepStripe(status: 'idle'|'active'|'complete'|'error') {
    return status === 'error' ? eventStripeClasses('error')
      : status === 'complete' ? eventStripeClasses('complete')
      : status === 'active' ? eventStripeClasses('active')
      : eventStripeClasses('info');
  }
  function prettyStatus(s: 'idle'|'active'|'complete'|'error') {
    if (s === 'complete') return 'Complete';
    if (s === 'active')   return 'Working';
    if (s === 'error')    return 'Error';
    return 'Waiting';
  }
  let uploadStatus: 'idle'|'active'|'complete'|'error';
  $: uploadStatus = uploading ? 'active' : uploadMsg?.startsWith('Upload failed:') ? 'error' : uploadedFileId ? 'complete' : 'idle';
  let verifyStatus: 'idle'|'active'|'complete'|'error';
  $: verifyStatus = verifying ? 'active' : verifyMsg?.startsWith('Check failed') ? 'error' : uploadedFileId ? 'complete' : 'idle';
  let linkStatus: 'idle'|'active'|'complete'|'error';
  $: linkStatus = linkBusy ? 'active' : linkErr ? 'error' : downloadUrl ? 'complete' : uploadedFileId ? 'idle' : 'idle';
  $: showPipeline = !!(uploading || uploadedFileId || verifying || linkBusy || linkErr || downloadUrl);
</script>

<div class="max-w-6xl mx-auto p-6 space-y-8">
  <!-- Title -->
  <div class="space-y-1">
    <div class="flex items-baseline gap-2">
      <h1 class="text-3xl font-bold italic bg-gradient-to-r from-sky-400 to-emerald-400 bg-clip-text text-transparent tracking-tight">
        Document Analyser
      </h1>
      <span class="text-[12px] font-light text-gray-400 italic">Upload PDF or Word</span>
    </div>
  </div>

  <!-- Pipeline card -->
  <div class="border border-gray-300 rounded-2xl bg-white overflow-hidden">
    <div class="p-4 pb-0">
      <div class="space-y-3">
        <label
          for="doc-file"
          class="flex flex-col items-center justify-center w-full p-6 border border-dashed border-gray-300 rounded-xl cursor-pointer 
                 hover:border-gray-300 hover:bg-gray-50 transition"
        >
          <svg class="w-10 h-10 text-gray-400 mb-2" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6h.1a5 5 0 010 10h-1M12 12v9m0 0l-3-3m3 3l3-3"/>
          </svg>
          <p class="text-xs text-gray-600">
            <span class="font-medium">{file?.name || 'Click to select a document (.pdf, .doc, .docx)'}</span>
            {#if file}<span class="text-gray-400"> • {fmtSize(file.size)}</span>{/if}
          </p>
          <p class="text-xs text-gray-400 font-light">Upload starts automatically</p>
        </label>
        <input id="doc-file" type="file" accept={ACCEPT} class="hidden" on:change={onPick} />

        {#if uploading}
          <div class="flex items-center gap-2">
            <div class="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div class="h-2 bg-gray-900 transition-all" style={`width:${uploadPct}%;`}></div>
            </div>
            <div class="text-sm tabular-nums w-12 text-right">{uploadPct}%</div>
          </div>
        {/if}
      </div>
    </div>

    {#if showPipeline}
      <div class="p-4 font-light">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <!-- Upload -->
          <div class={`p-3 rounded-xl border ${stepStripe(uploadStatus)} h-fit`}>
            <div class="flex items-start gap-2">
              <div class="mt-0.5 text-sky-700 shrink-0" aria-hidden="true">{@html Icon.upload()}</div>
              <div class="min-w-0 flex-1 text-[13px]">
                <div class="flex items-center justify-between">
                  <span class="text-[12px] font-medium text-gray-700">Upload</span>
                  <span class={`text-[11px] px-2 py-0.5 rounded ${stepBadge(uploadStatus)}`}>{prettyStatus(uploadStatus)}</span>
                </div>
                <div class="mt-1 truncate text-xs">
                  {#if uploadStatus === 'active'}Uploading… ({uploadPct}%)
                  {:else if uploadStatus === 'complete'}{uploadMsg || 'Document uploaded'}
                  {:else if uploadStatus === 'error'}{uploadMsg}
                  {:else}Waiting for a document{/if}
                </div>
              </div>
            </div>
          </div>

          <!-- Verify -->
          <div class={`p-3 rounded-xl border ${stepStripe(verifyStatus)} h-fit`}>
            <div class="flex items-start gap-2">
              <div class="mt-0.5 text-sky-700 shrink-0" aria-hidden="true">{@html Icon.verify()}</div>
              <div class="min-w-0 flex-1 text-[13px]">
                <div class="flex items-center justify-between">
                  <span class="text-[12px] font-medium text-gray-700">Verify</span>
                  <span class={`text-[11px] px-2 py-0.5 rounded ${stepBadge(verifyStatus)}`}>{prettyStatus(verifyStatus)}</span>
                </div>
                <div class="mt-1 truncate text-xs">
                  {#if verifyStatus === 'active'}Checking readiness…
                  {:else if verifyStatus === 'complete'}{verifyMsg || 'Ready'}
                  {:else if verifyStatus === 'error'}{verifyMsg}
                  {:else}Will verify automatically{/if}
                </div>
              </div>
            </div>
          </div>

          <!-- Link -->
          <div class={`p-3 rounded-xl border ${stepStripe(linkStatus)} h-fit`}>
            <div class="flex items-start gap-2">
              <div class="mt-0.5 text-sky-700 shrink-0" aria-hidden="true">{@html Icon.link()}</div>
              <div class="min-w-0 flex-1 text-[13px]">
                <div class="flex items-center justify-between">
                  <span class="text-[12px] font-medium text-gray-700">Link</span>
                  <span class={`text-[11px] px-2 py-0.5 rounded ${stepBadge(linkStatus)}`}>{prettyStatus(linkStatus)}</span>
                </div>
                <div class="mt-1 truncate text-xs">
                  {#if linkStatus === 'active'}Fetching link…
                  {:else if linkStatus === 'complete'}Ready
                  {:else if linkStatus === 'error'}{linkErr}
                  {:else}Click the button below{/if}
                </div>

                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    class="px-2 py-1 rounded-xl border text-xs hover:bg-gray-100 disabled:opacity-60"
                    on:click={getDownload}
                    disabled={!uploadedFileId || linkBusy}
                  >
                    {linkBusy ? 'Getting link…' : 'Get Download Link'}
                  </button>

                  {#if downloadUrl}
                    <a class="px-3 py-1.5 rounded-xl border text-sm hover:bg-gray-100" href={downloadUrl} target="_blank" rel="noreferrer">
                      Open file
                    </a>
                  {/if}

                  {#if linkErr}
                    <span class="text-xs text-rose-700">{linkErr}</span>
                  {/if}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    {:else}
      <div class="p-0.5 text-xs text-gray-500"></div>
    {/if}
  </div>

  <!-- AI Chat Panel -->
  <ChatPanelDoc
    {backendUrl}
    {userId}
    {uploadedFileId}
    {initialConversations}
    chatTitle={chatTitle}
  />
</div>

<style>
  :global(table) { border-collapse: separate; border-spacing: 0; }
</style>