<script lang="ts">
  import { onMount } from 'svelte';
  import ChatPanel from './ChatPanel.svelte';

  export let data: { userId: string; backendUrl: string; conversations?: any[] };
  const initialConversations = data.conversations ?? [];
  let backendUrl: string = data.backendUrl;
  let userId: string = data.userId;

  let file: File | null = null;

  let uploading = false;
  let uploadMsg: string | null = null;
  let uploadedFileId: string | null = null;
  let uploadPct = 0;

  let extracting = false;
  let extractMsg: string | null = null;
  let extractLocation: string | null = null;
  let unzipSpinnerTick = 0;

  let verifying = false;
  let verifySpinnerTick = 0;

  let zipBase = '';

  let listLocation = '';
  let listLimit = 100;
  let listPage = 1;
  let listBusy = false;
  let listMsg: string | null = null;

  type TFile = { id: string; name: string; size?: number; location?: string; metadata?: any; url?: string; _loading?: boolean; _err?: string; };
  type TPagination = { limit: number; page:number }
  type TCount = number;
  let files: TFile[] = [];
  let pagination: TPagination[] = [];
  let totalCount: TCount = 0;

  type TFolder = { name: string; location: string };
  let folders: TFolder[] = [];

  let lastListJson: any = null;

  // ---------- PERSISTENCE ----------
  const LS_KEY = (u: string) => `acr:zipstate:${u}`;
  // same format the ChatPanel uses for per-zip conversation id
  const CONV_KEY = (u: string, fid: string) => `acr:conv:${u}:${fid}`;

  function persistState() {
    try {
      const data = { uploadedFileId, listLocation, folderSaved, zipBase };
      localStorage.setItem(LS_KEY(userId), JSON.stringify(data));
    } catch {}
  }
  function hydrateState() {
    try {
      const raw = localStorage.getItem(LS_KEY(userId));
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d?.uploadedFileId) uploadedFileId = d.uploadedFileId;
      if (d?.listLocation) listLocation = d.listLocation;
      if (typeof d?.zipBase === 'string') zipBase = d.zipBase;
      if (typeof d?.folderSaved === 'boolean') folderSaved = d.folderSaved;
    } catch {}
  }

  // completely clear saved state (local + session) for a previous zip
  function clearPersistedFor(prevZipId?: string | null) {
    try { localStorage.removeItem(LS_KEY(userId)); } catch {}
    if (prevZipId) {
      try { sessionStorage.removeItem(CONV_KEY(userId, prevZipId)); } catch {}
    }
  }

  // infer extract root from saved list path (e.g. CodeZips/run/<zipBase>)
  function deriveExtractLocation(loc: string, base: string) {
    if (!loc) return null;
    if (base && loc.endsWith('/' + base)) return loc.slice(0, -('/' + base).length);
    const parts = loc.split('/').filter(Boolean);
    return parts.length > 1 ? parts.slice(0, -1).join('/') : null;
  }

  onMount(async () => {
    hydrateState();

    // Reflect restored state immediately so badges don't show "Waiting"
    if (uploadedFileId) {
      uploadMsg = 'Zip File Uploaded ✓';
    }
    if (!extractLocation && listLocation) {
      const maybeExtract = deriveExtractLocation(listLocation, zipBase);
      if (maybeExtract) {
        extractLocation = maybeExtract;
        extractMsg = `Extracted to ${extractLocation}/`;
      }
    }
    if (folderSaved) {
      saveMsg = 'Structure saved ✓';
    }

    // If we restored a fileId but don't know whether structure is saved, ask backend
    if (uploadedFileId && !folderSaved) {
      try {
        const r = await fetch(`${backendUrl}/review-zip/meta?userId=${encodeURIComponent(userId)}&zipFileId=${encodeURIComponent(uploadedFileId)}`);
        const d = await r.json();
        if (d?.exists) {
          folderSaved = true;
          if (!listLocation && d.rootLocation) listLocation = d.rootLocation;
          saveMsg = 'Structure saved ✓';
        }
      } catch {}
    }

    // If we have a location, run a silent list to settle the List step
    if (listLocation) {
      listBusy = true;
      await refreshList(false);
    }
  });

  // ---- helpers
  function baseFromZip(name: string) {
    const m = name.match(/^(.*)\.zip$/i);
    return (m ? m[1] : name).trim();
  }
  function fmtSize(n?: number) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  /** 🔄 Hard reset EVERYTHING for a new zip selection */
  function resetForNewZip() {
    // pipeline + status
    uploading = false; uploadMsg = null; uploadPct = 0; uploadedFileId = null;
    extracting = false; extractMsg = null; extractLocation = null; unzipSpinnerTick = 0;
    verifying = false; verifySpinnerTick = 0;

    // listing
    listBusy = false; listMsg = null; listLocation = ''; listLimit = 100; listPage = 1;
    files = []; folders = []; pagination = []; totalCount = 0; lastListJson = null;

    // LLM persistence
    folderSaved = false; saving = false; saveMsg = null;

    // UI toggles
    showFolders = false; showFiles = false;
  }

  // ⬇️ auto-run the entire flow on file pick (no upload button)
  async function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    if (f && !f.name.toLowerCase().endsWith('.zip')) {
      alert('Please choose a .zip file.');
      (e.target as HTMLInputElement).value = '';
      file = null;
      return;
    }

    // remember old zip id to purge any persisted keys
    const previousZipId = uploadedFileId;

    // ensure full reset before applying new file state
    resetForNewZip();

    // purge local/session storage for the previous zip
    clearPersistedFor(previousZipId || undefined);

    file = f;
    zipBase = f ? baseFromZip(f.name) : '';

    persistState();

    // 👉 kick off upload & extract immediately
    if (file) {
      await uploadAndExtract();
    }
  }

  function xhrPut(url: string, blob: Blob, onProgress: (p: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) onProgress(Math.max(0, Math.min(1, ev.loaded / ev.total)));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || '');
        else reject(new Error(`HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(blob);
    });
  }

  function isFileUploadedReady(f: any): boolean {
    if (!f || !f.metadata) return false;
    const status = (f.metadata.status || f.metadata.uploadStatus || f.metadata.state || f.status || '').toString().toLowerCase();
    return status === 'uploaded';
  }

  async function waitForAllExtracted(loc: string, opts?: { timeoutMs?: number; intervalMs?: number; settleMs?: number }) {
    const timeoutMs = opts?.timeoutMs ?? 90_000;
    const intervalMs = opts?.intervalMs ?? 1_200;
    const settleMs = opts?.settleMs ?? 1_500;
    const started = Date.now();
    while (true) {
      const r = await fetch('/ziplab', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', location: loc, limit: 100, page: 1 })
      });
      const data = await r.json().catch(() => ({}));
      const fs: any[] = Array.isArray(data?.files) ? data.files : [];
      const ds: any[] = Array.isArray(data?.folders) ? data.folders : [];
      const haveFiles = fs.length > 0;
      const allUploaded = haveFiles ? fs.every(isFileUploadedReady) : true;
      if ((haveFiles || ds.length > 0) && allUploaded) {
        if (settleMs > 0) await new Promise((res) => setTimeout(res, settleMs));
        return;
      }
      if (Date.now() - started > timeoutMs) return;
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  async function uploadAndExtract() {
    if (!file) return;

    uploading = true;
    uploadPct = 0;

    try {
      const start = await fetch('/ziplab', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, type: file.type || 'application/zip', size: file.size })
      });
      const startData = await start.json();
      if (!start.ok) throw new Error(startData?.error || 'Failed to start upload');

      if (startData.mode === 'single' && startData.uploadUrl) {
        await xhrPut(startData.uploadUrl, file, (p) => (uploadPct = Math.floor(p * 100)));
        uploadedFileId = startData.fileId;
      } else if (startData.mode === 'multipart') {
        const { fileId, uploadId, partSize, urls } = startData as { fileId: string; uploadId: string; partSize: number; urls: { partNumber: number; url: string }[]; };
        const totalBytes = file.size || 1;
        for (const { partNumber, url } of urls.sort((a, b) => a.partNumber - b.partNumber)) {
          const startOff = (partNumber - 1) * partSize;
          const endOff = Math.min(startOff + partSize, totalBytes);
          const chunk = file.slice(startOff, endOff);
          await xhrPut(url, chunk, (p) => {
            const loadedInPart = Math.floor(p * (endOff - startOff));
            const overallLoaded = startOff + loadedInPart;
            uploadPct = Math.floor((overallLoaded / totalBytes) * 100);
          });
        }
        uploadPct = 100;
        const complete = await fetch('/ziplab', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'completeMultipart', fileId, uploadId, parts: [] })
        });
        const cdata = await complete.json();
        if (!complete.ok || cdata?.success !== true) throw new Error(cdata?.error || 'Failed to complete multipart upload');
        uploadedFileId = fileId;
      } else {
        throw new Error('Unknown upload mode');
      }

      uploadMsg = `Zip File Uploaded ✓`;
    } catch (e: any) {
      uploadMsg = `Upload failed: ${e?.message ?? e}`;
      uploading = false;
      persistState();
      return;
    } finally {
      uploading = false;
    }

    if (!uploadedFileId) { persistState(); return; }

    extracting = true;
    unzipSpinnerTick = 0;
    const unzipTimer = setInterval(() => (unzipSpinnerTick = (unzipSpinnerTick + 1) % 4), 400);

    let verifyTimer: any = null;

    try {
      const res = await fetch('/ziplab', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unzip', fileId: uploadedFileId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || data?.error || 'Unzip failed');

      clearInterval(unzipTimer);
      extracting = false;

      extractLocation = data.location;
      extractMsg = `Extracted to ${extractLocation}/`;

      listLocation = `${extractLocation}/${zipBase}`;

      verifying = true;
      verifySpinnerTick = 0;
      verifyTimer = setInterval(() => (verifySpinnerTick = (verifySpinnerTick + 1) % 4), 400);

      await waitForAllExtracted(listLocation, { settleMs: 2000 });

      verifying = false;
      if (verifyTimer) clearInterval(verifyTimer);

      await refreshList(false);
    } catch (e: any) {
      extractMsg = `Extraction failed: ${e?.message ?? e}`;
      if (verifyTimer) clearInterval(verifyTimer);
    } finally {
      clearInterval(unzipTimer);
      verifying = false;
      extracting = false;
      persistState();
    }
  }

  async function refreshList(showStatus = true) {
    if (!listLocation.trim()) {
      listMsg = 'Enter a location to list (e.g., CodeZips/<run>/<zipBase>).';
      return;
    }
    listBusy = true;
    listMsg = showStatus ? 'Listing…' : null;
    try {
      const res = await fetch('/ziplab', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', location: listLocation.trim(), limit: Number(listLimit) || 100, page: Number(listPage) || 1 })
      });
      const data = await res.json();
      if (!res.ok) {
        listMsg = `List failed: ${data?.error || 'unknown error'}`;
        return;
      }
      files = (data.files || []) as TFile[];
      folders = (data.folders || []) as TFolder[];
      pagination = (data.pagination || []) as TPagination[];
      totalCount = data.totalCount || 0;

      handleFilesListed({ files, folders, pagination, totalCount });

      listMsg = `Found ${files.length} file${files.length === 1 ? '' : 's'} and ${folders.length} folder${folders.length === 1 ? '' : 's'}.`;

      await maybePersistFolderStructure();
    } catch (e: any) {
      listMsg = `List error: ${e?.message ?? e}`;
    } finally {
      listBusy = false;
      persistState();
    }
  }

  function handleFilesListed(payload: any) {
    lastListJson = payload;
  }

  async function getLink(idx: number) {
    const f = files[idx];
    if (!f) return;
    f._loading = true; f._err = undefined;
    try {
      const r = await fetch(`/ziplab?id=${encodeURIComponent(f.id)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'Failed to get download URL');
      f.url = d.url;
    } catch (e: any) {
      f._err = e?.message ?? 'Failed to get link';
    } finally {
      f._loading = false;
      files = [...files];
    }
  }

  function openFolder(folder: TFolder) {
    const next = `${(folder.location || '').replace(/^\/+|\/+$/g, '')}/${folder.name}`.replace(/^\/+/, '');
    listLocation = next;
    refreshList();
  }

  // ---------- LLM INTEGRATION ----------
  let folderSaved = false;
  let saving = false;
  let saveMsg: string | null = null;

  async function maybePersistFolderStructure() {
    if (!uploadedFileId || !lastListJson || folderSaved) return;
    try {
      saving = true;
      saveMsg = 'Saving project structure…';
      const body = {
        userId,
        zipFileId: uploadedFileId,
        folderStructure: { rootLocation: listLocation, ...lastListJson }
      };
      const r = await fetch(`${backendUrl}/review-zip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 409) throw new Error(d?.error || 'Failed to save');

      folderSaved = true;
      saveMsg = r.status === 409 ? 'Structure already saved for this user & zip' : 'Structure saved ✓';
    } catch (e: any) {
      saveMsg = `Save failed: ${e?.message ?? e}`;
    } finally {
      saving = false;
      persistState();
    }
  }

  let showFolders = false;
  let showFiles = false;

  // ======= Shared “activity stripe” styling (match ChatPanel) =======
  function eventBadgeClasses(t: string) {
    if (t.includes('error')) return 'bg-rose-50 text-rose-800 border border-rose-100';
    if (t.includes('complete')) return 'bg-emerald-50 text-emerald-800 border border-emerald-100';
    if (t.includes('started') || t.includes('active')) return 'bg-sky-50 text-sky-800 border border-sky-100';
    if (t === 'progress' || t === 'info') return 'bg-amber-50 text-amber-900 border border-amber-100';
    return 'bg-gray-50 text-gray-800 border border-gray-100';
  }
  function eventStripeClasses(t: string) {
    if (t.includes('error')) return 'border-rose-100 bg-rose-50/60';
    if (t.includes('complete')) return 'border-emerald-100 bg-emerald-50/60';
    if (t.includes('started') || t.includes('active')) return 'border-sky-100 bg-sky-50/60';
    if (t === 'progress' || t === 'info') return 'border-amber-100 bg-amber-50/60';
    return 'border-gray-100 bg-gray-50/60';
  }

  // ======= UI icons =======
  const Icon = {
    upload: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 12V4m0 0l-3 3m3-3l3 3"/></svg>`,
    unzip: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M9 3h6l4 4v14a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M12 7v10m-2-8h4m-4 4h4"/></svg>`,
    verify: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4"/><path d="M12 22a10 10 0 110-20 10 10 0 010 20z"/></svg>`,
    list:   () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
    save:   () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M17 3H5a2 2 0 00-2 2v14l4-4h10a2 2 0 002-2V5a2 2 0 00-2-2z"/></svg>`,
  };

  function stepBadge(status: 'idle'|'active'|'complete'|'error') {
    return status === 'error'
      ? eventBadgeClasses('error')
      : status === 'complete'
      ? eventBadgeClasses('complete')
      : status === 'active'
      ? eventBadgeClasses('active')
      : eventBadgeClasses('info');
  }
  function stepStripe(status: 'idle'|'active'|'complete'|'error') {
    return status === 'error'
      ? eventStripeClasses('error')
      : status === 'complete'
      ? eventStripeClasses('complete')
      : status === 'active'
      ? eventStripeClasses('active')
      : eventStripeClasses('info');
  }

  // human-friendly status text
  function prettyStatus(s: 'idle'|'active'|'complete'|'error') {
    if (s === 'complete') return 'Complete';
    if (s === 'active')   return 'Working';
    if (s === 'error')    return 'Error';
    return 'Waiting';
  }

  // step states
  let uploadStatus: 'idle'|'active'|'complete'|'error';
  $: uploadStatus =
      uploading ? 'active'
    : uploadMsg?.startsWith('Upload failed:') ? 'error'
    : uploadedFileId ? 'complete'
    : 'idle';

  let unzipStatus: 'idle'|'active'|'complete'|'error';
  $: unzipStatus =
      extracting ? 'active'
    : extractMsg?.startsWith('Extraction failed:') ? 'error'
    : extractLocation ? 'complete'
    : 'idle';

  let verifyStatus: 'idle'|'active'|'complete'|'error';
  $: verifyStatus =
      verifying ? 'active'
    : (!verifying && extractLocation) ? 'complete'
    : 'idle';

  let listStatus: 'idle'|'active'|'complete'|'error';
  $: listStatus =
      listBusy ? 'active'
    : listMsg?.startsWith('List failed') ? 'error'
    : (files.length + folders.length > 0) ? 'complete'
    : 'idle';

  let saveStatus: 'idle'|'active'|'complete'|'error';
  $: saveStatus =
      saving ? 'active'
    : saveMsg?.startsWith('Save failed') ? 'error'
    : folderSaved ? 'complete'
    : 'idle';

  // show stripes after pipeline begins or a prior session exists
  let showPipeline: boolean;
  $: showPipeline = !!(
    uploading || extracting || verifying ||
    uploadedFileId || extractLocation || saving || folderSaved ||
    listBusy || files.length > 0 || folders.length > 0
  );
</script>

<!-- Layout -->
<div class="max-w-6xl mx-auto p-6 space-y-8">
  <!-- Title -->
  <div class="space-y-1">
    <div class="flex items-baseline gap-2">
      <h1 class="text-3xl font-bold italic bg-gradient-to-r from-sky-400 to-emerald-400 bg-clip-text text-transparent tracking-tight">
        Code Analyser
      </h1>
      <span class="text-[12px] font-light text-gray-400 italic">
        Powered by Trelae Files
      </span>
    </div>
  </div>

  <!-- Connected Pipeline Card -->
  <div class="border border-gray-300 rounded-2xl bg-white overflow-hidden">

    <!-- Top: Upload controls (lighter borders; auto-start on choose) -->
    <div class="p-4 pb-0">
      <div class="space-y-3">
        <label
          for="zip-file"
          class="flex flex-col items-center justify-center w-full p-6 border border-dashed border-gray-300 rounded-xl cursor-pointer 
                 hover:border-gray-300 hover:bg-gray-50 transition"
        >
          <svg class="w-10 h-10 text-gray-400 mb-2" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round"
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6h.1a5 5 0 010 10h-1M12 12v9m0 0l-3-3m3 3l3-3"/>
          </svg>
          <p class="text-xs text-gray-600">
            <span class="font-medium">{file?.name || 'Click to select a .zip'}</span>
          </p>
          <p class="text-xs text-gray-400 font-light">Upload & extract starts automatically</p>
        </label>
        <input id="zip-file" type="file" accept=".zip" class="hidden" on:change={onPick} />

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

    <!-- Activity stripes -->
    {#if showPipeline}
      <div class="p-4 font-light">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          <!-- Upload -->
          <div class={`p-3 rounded-xl border ${stepStripe(uploadStatus)} h-fit`}>
            <div class="flex items-start gap-2">
              <div class="mt-0.5 text-sky-700 shrink-0" aria-hidden="true">{@html Icon.upload()}</div>
              <div class="min-w-0 flex-1 text-[13px]">
                <!-- minimal header -->
                <div class="flex items-center justify-between">
                  <span class="text-[12px] font-medium text-gray-700">Upload</span>
                  <span class={`text-[11px] px-2 py-0.5 rounded ${stepBadge(uploadStatus)}`}>{prettyStatus(uploadStatus)}</span>
                </div>
                <div class="mt-1 truncate text-xs">
                  {#if uploadStatus === 'active'}Uploading… ({uploadPct}%)
                  {:else if uploadStatus === 'complete'}{uploadMsg || 'Zip uploaded'}
                  {:else if uploadStatus === 'error'}{uploadMsg}
                  {:else}Waiting for a .zip file{/if}
                </div>
              </div>
            </div>
          </div>

          <!-- Extract -->
          <div class={`p-3 rounded-xl border ${stepStripe(unzipStatus)} h-fit`}>
            <div class="flex items-start gap-2">
              <div class="mt-0.5 text-sky-700 shrink-0" aria-hidden="true">{@html Icon.unzip()}</div>
              <div class="min-w-0 flex-1 text-[13px]">
                <div class="flex items-center justify-between">
                  <span class="text-[12px] font-medium text-gray-700">Extract</span>
                  <span class={`text-[11px] px-2 py-0.5 rounded ${stepBadge(unzipStatus)}`}>{prettyStatus(unzipStatus)}</span>
                </div>
                <div class="mt-1 truncate text-xs">
                  {#if unzipStatus === 'active'}Extracting files…
                  {:else if unzipStatus === 'complete'}{extractMsg}
                  {:else if unzipStatus === 'error'}{extractMsg}
                  {:else}Standing by{/if}
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
                  <span class="text-[12px] font-medium text-gray-700">Finalise</span>
                  <span class={`text-[11px] px-2 py-0.5 rounded ${stepBadge(verifyStatus)}`}>{prettyStatus(verifyStatus)}</span>
                </div>
                <div class="mt-1 truncate text-xs">
                  {#if verifyStatus === 'active'}Finalising file status…
                  {:else if verifyStatus === 'complete'}Ready
                  {:else}Waiting{/if}
                </div>
              </div>
            </div>
          </div>

          <!-- List -->
          <div class={`p-3 rounded-xl border ${stepStripe(listStatus)} h-full`}>
            <div class="flex items-start gap-2">
              <div class="mt-0.5 text-sky-700 shrink-0" aria-hidden="true">{@html Icon.list()}</div>
              <div class="min-w-0 flex-1 text-[13px]">
                <div class="flex items-center justify-between">
                  <span class="text-[12px] font-medium text-gray-700">List</span>
                  <span class={`text-[11px] px-2 py-0.5 rounded ${stepBadge(listStatus)}`}>{prettyStatus(listStatus)}</span>
                </div>
                <div class="mt-1 truncate text-xs">
                  {#if listStatus === 'active'}Listing extracted folder…
                  {:else if listStatus === 'complete'}{listMsg || 'Files listed'}
                  {:else if listStatus === 'error'}{listMsg || 'List failed'}
                  {:else}Waiting{/if}
                </div>

                {#if extractLocation}
                  <details class="mt-2">
                    <summary class="text-xs text-gray-600 cursor-pointer">advanced</summary>
                    <div class="pt-2 flex flex-wrap gap-2 items-center">
                      <input class="flex-1 min-w-[160px] rounded-xl border border-gray-200 px-2 py-1 text-xs" bind:value={listLocation} placeholder="CodeZips/&lt;run&gt;/&lt;zipBase&gt;" />
                      <input class="w-20 rounded-xl border border-gray-200 px-2 py-1 text-xs" type="number" min="1" max="100" bind:value={listLimit} />
                      <input class="w-20 rounded-xl border border-gray-200 px-2 py-1 text-xs" type="number" min="1" bind:value={listPage} />
                      <button class="px-2 py-1 rounded-xl border text-sm hover:bg-gray-50 disabled:opacity-60" on:click={() => refreshList()} disabled={listBusy}>
                        {listBusy ? 'Listing…' : 'Refresh List'}
                      </button>
                    </div>
                  </details>
                {/if}
              </div>
            </div>
          </div>

          <!-- Save -->
          <div class={`p-3 rounded-xl border ${stepStripe(saveStatus)} h-fit`}>
            <div class="flex items-start gap-2">
              <div class="mt-0.5 text-sky-700 shrink-0" aria-hidden="true">{@html Icon.save()}</div>
              <div class="min-w-0 flex-1 text-[13px]">
                <div class="flex items-center justify-between">
                  <span class="text-[12px] font-medium text-gray-700">Save</span>
                  <span class={`text-[11px] px-2 py-0.5 rounded ${stepBadge(saveStatus)}`}>{prettyStatus(saveStatus)}</span>
                </div>
                <div class="mt-1 truncate text-xs">
                  {#if saveStatus === 'active'}Saving project structure…
                  {:else if saveStatus === 'complete'}{saveMsg || 'Structure saved'}
                  {:else if saveStatus === 'error'}{saveMsg || 'Save failed'}
                  {:else}Will save automatically after listing{/if}
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

  <!-- Chat Panel -->
  <ChatPanel
    {backendUrl}
    {userId}
    {uploadedFileId}
    {folderSaved}
    {initialConversations}
    chatTitle={zipBase}
  />

  <!-- Browse (end) -->
  {#if extractLocation}
    <div class="space-y-3">
      <!-- Folders -->
      <div class="border rounded-2xl bg-white">
        <button class="w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
          on:click={() => showFolders = !showFolders}>
          <span>Extracted folders</span>
          <span class="flex items-center gap-2 text-xs text-gray-600">
            {folders.length} total
            <svg class="w-4 h-4 transition-transform" style={`transform: rotate(${showFolders ? 180 : 0}deg);`} viewBox="0 0 20 20"><path d="M5 8l5 5 5-5H5z" /></svg>
          </span>
        </button>
        {#if showFolders && folders.length}
          <div class="px-4 pb-4">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {#each folders as d}
                <div class="border rounded-2xl p-3 flex flex-col gap-2 bg-white">
                  <div class="flex items-center justify-between gap-2">
                    <div class="font-medium truncate" title={d.name}>📁 {d.name}</div>
                    <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100">folder</span>
                  </div>
                  <div class="text-xs text-gray-600 break-all">
                    <span class="font-semibold">Path:</span> {(d.location || '')}/{d.name}
                  </div>
                  <div class="mt-1">
                    <button class="inline-flex items-center px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50" on:click={() => openFolder(d)}>Open</button>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {:else if showFolders}
          <div class="px-4 pb-4 text-xs text-gray-500">No folders found.</div>
        {/if}
      </div>

      <!-- Files -->
      <div class="border rounded-2xl bg-white">
        <button class="w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
          on:click={() => showFiles = !showFiles}>
          <span>Extracted files</span>
          <span class="flex items-center gap-2 text-xs text-gray-600">
            {files.length} total
            <svg class="w-4 h-4 transition-transform" style={`transform: rotate(${showFiles ? 180 : 0}deg);`} viewBox="0 0 20 20"><path d="M5 8l5 5 5-5H5z" /></svg>
          </span>
        </button>

        {#if showFiles}
          <div class="px-4 pb-4">
            {#if files.length === 0}
              <div class="text-sm text-gray-500">No files found in this extraction.</div>
            {:else}
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {#each files as f, i}
                  <div class="border rounded-2xl p-3 flex flex-col gap-2 bg-white">
                    <div class="flex items-center justify-between gap-2">
                      <div class="font-medium truncate" title={f.name}>{f.name}</div>
                      <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100">{f.metadata?.fileType || 'unknown'}</span>
                    </div>
                    <div class="text-xs text-gray-600">
                      <div><span class="font-semibold">Size:</span> {fmtSize(f.metadata?.size)}</div>
                      <div class="break-all"><span class="font-semibold">Location:</span> {(f.location || listLocation)}/</div>
                    </div>
                    <div class="mt-1 flex gap-2">
                      {#if f.url}
                        <a class="inline-flex items-center px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50" href={f.url} target="_blank" rel="noreferrer">Download</a>
                      {:else}
                        <button class="inline-flex items-center px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50 disabled:opacity-60"
                          on:click={() => getLink(i)} disabled={!!f._loading}>
                          {#if f._loading}Getting link…{/if}{#if !f._loading}Get link{/if}
                        </button>
                      {/if}
                      {#if f._err}<span class="text-xs text-red-700">{f._err}</span>{/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if listLocation}
    <div class="mt-6 flex justify-end">
      <button
        class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50"
        on:click={async (e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          const original = btn.textContent;
          btn.disabled = true;
          btn.textContent = 'Zipping…';
          try {
            const res = await fetch('/ziplab', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'zipFolder',
                location: listLocation,
                zipName: `${(zipBase || 'archive').replace(/\s+/g, '-')}.zip`
              })
            });
            const d = await res.json();
            if (!res.ok || !d?.url) {
              alert(d?.error || 'Failed to create zip');
            } else {
              window.open(d.url, '_blank', 'noopener,noreferrer');
            }
          } catch (err) {
            alert((err as any)?.message || 'Zip failed');
          } finally {
            btn.disabled = false;
            btn.textContent = original || 'Download Zip';
          }
        }}
        title="Create a zip of the entire extracted folder"
      >
        Download Zip
      </button>
    </div>
  {/if}
</div>

<style>
  :global(table) { border-collapse: separate; border-spacing: 0; }
</style>