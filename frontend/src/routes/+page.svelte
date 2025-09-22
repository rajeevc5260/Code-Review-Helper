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
  onMount(async () => {
    hydrateState();

    // If we restored a fileId but don't know whether structure is saved, ask backend
    if (uploadedFileId && !folderSaved) {
      try {
        const r = await fetch(`${backendUrl}/review-zip/meta?userId=${encodeURIComponent(userId)}&zipFileId=${encodeURIComponent(uploadedFileId)}`);
        const d = await r.json();
        if (d?.exists) {
          folderSaved = true;
          if (!listLocation && d.rootLocation) listLocation = d.rootLocation;
        }
      } catch {}
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

  function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0] ?? null;
    if (f && !f.name.toLowerCase().endsWith('.zip')) {
      alert('Please choose a .zip file.');
      (e.target as HTMLInputElement).value = '';
      file = null;
      return;
    }
    file = f;

    zipBase = f ? baseFromZip(f.name) : '';
    uploadMsg = null;
    uploadedFileId = null;
    uploadPct = 0;
    extractMsg = null;
    extractLocation = null;
    listLocation = '';
    listMsg = null;
    files = [];
    folders = [];
    lastListJson = null;

    folderSaved = false;
    saveMsg = null;
    saving = false;

    showFolders = false;
    showFiles = false;
    showJson = false;

    persistState();
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
  let showJson = false;

  function stepClass(state: 'done'|'current'|'future') {
    return state === 'done'
      ? 'bg-green-100 text-green-800 ring-1 ring-green-200'
      : state === 'current'
      ? 'bg-gray-900 text-white'
      : 'bg-gray-100 text-gray-600';
  }
  function stepState(n: number): 'done'|'current'|'future' {
    const s1 = !!uploadedFileId || uploading || extracting || verifying || !!extractLocation;
    const s2 = !!extractLocation && !verifying;
    const s3 = files.length > 0;
    const s4 = folderSaved;
    const s5 = folderSaved && !!uploadedFileId;
    const states = [s1, s2, s3, s4, s5];
    const idx = states.findIndex((ok) => !ok);
    const current = idx === -1 ? 5 : idx + 1;
    if (n < current && states[n-1]) return 'done';
    if (n === current) return 'current';
    return 'future';
  }
</script>

<!-- Layout -->
<div class="max-w-6xl mx-auto p-6 space-y-8">
  <!-- Title + Stepper -->
  <div class="space-y-3">
    <div class="flex flex-col">
      <h1 class="text-3xl font-semibold">AI Code Reviewer</h1>
      <div class="text-xs text-gray-500 font-light italic">Powered by Trelae Files</div>
    </div>

    <!-- Stepper -->
    <div class="flex flex-wrap gap-2">
      <span class="text-xs px-2.5 py-1.5 rounded-full {stepClass(stepState(1))}">Upload</span>
      <span class="text-xs px-2.5 py-1.5 rounded-full {stepClass(stepState(2))}">Unzip & Verify</span>
      <span class="text-xs px-2.5 py-1.5 rounded-full {stepClass(stepState(3))}">Browse</span>
      <span class="text-xs px-2.5 py-1.5 rounded-full {stepClass(stepState(4))}">Save</span>
      <span class="text-xs px-2.5 py-1.5 rounded-full {stepClass(stepState(5))}">Analyze</span>
    </div>
  </div>

  <!-- Upload / Extract card -->
  <div class="border rounded-2xl p-5 space-y-4 bg-white">
    <div class="space-y-3">

      <!-- Drop zone -->
      <label
        for="zip-file"
        class="flex flex-col items-center justify-center w-full p-6 border border-dashed rounded-xl cursor-pointer 
              hover:border-gray-400 hover:bg-gray-50 transition"
      >
        <svg class="w-10 h-10 text-gray-400 mb-2" fill="none" stroke="currentColor" stroke-width="2"
            viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round"
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6h.1a5 5 0 010 10h-1M12 12v9m0 0l-3-3m3 3l3-3"/>
        </svg>
        <p class="text-sm text-gray-600"><span class="font-medium">{file?.name || 'click to upload'}</span></p>
        <p class="text-xs text-gray-400">Only zip files are supported</p>
      </label>

      <!-- Hidden input -->
      <input id="zip-file" type="file" accept=".zip" class="hidden" on:change={onPick} />
    </div>

    <div class="flex flex-col gap-3">
      <button
        class="px-4 py-2 rounded-xl bg-gray-900 text-white font-medium hover:bg-black disabled:opacity-60 w-44"
        on:click={uploadAndExtract}
        disabled={!file || uploading || extracting || verifying}
      >
        {#if uploading}
          Uploading
        {:else if verifying}
          Verifying file status
        {:else if extracting}
          Unzipping
        {:else}
          Upload & Extract
        {/if}
      </button>

      <!-- Progress bar -->
      {#if uploading}
        <div class="flex items-center gap-2">
          <div class="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div class="h-2 bg-gray-900 transition-all" style={`width:${uploadPct}%;`}></div>
          </div>
          <div class="text-sm tabular-nums w-12 text-right">{uploadPct}%</div>
        </div>
      {/if}
    </div>

    {#if uploadMsg}<div class="text-sm text-green-700 italic">{uploadMsg}</div>{/if}
    <!-- during unzip -->
    {#if extracting}
      <p class="text-sm text-gray-600 italic animate-pulse">Zip extracting…{'.'.repeat(unzipSpinnerTick)}</p>
    {/if}
    {#if extractMsg}
      <div class="text-sm">
        <span class="text-green-700">{extractMsg}</span>
        {#if extractLocation}
          <div class="text-xs text-gray-500 mt-1">Listing from:
            <span class="font-mono">{listLocation || '(set after unzip)'}</span>
          </div>
        {/if}
      </div>
    {/if}
    {#if verifying}
      <p class="text-sm text-gray-600 italic animate-pulse">
        Verifying file status…{'.'.repeat(verifySpinnerTick)}
      </p>
    {/if}

    <!-- Manual list controls (pre-filled to extracted folder + zipBase) -->
    {#if extractLocation && !verifying}
      <div class="flex flex-wrap gap-2 items-center pt-2">
        <input
          class="flex-1 min-w-[280px] rounded-xl border px-3 py-2 text-sm"
          bind:value={listLocation}
          placeholder="CodeZips/<run>/<zipBase>"
        />
        <input class="w-20 rounded-xl border px-3 py-2 text-sm" type="number" min="1" max="100" bind:value={listLimit} />
        <input class="w-20 rounded-xl border px-3 py-2 text-sm" type="number" min="1" bind:value={listPage} />
        <button
          class="px-3 py-2 rounded-xl border text-sm hover:bg-gray-50 disabled:opacity-60"
          on:click={() => refreshList()}
          disabled={listBusy}
        >
          {listBusy ? 'Listing…' : 'Refresh List'}
        </button>
        {#if listMsg}<div class="text-sm text-gray-600">{listMsg}</div>{/if}
      </div>
    {/if}
  </div>

  <!-- Browse section (collapsibles) -->
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
              <div class="border rounded-xl p-3 flex flex-col gap-2 bg-white">
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

  <!-- Chat Panel (analyze via chat) -->
  <ChatPanel
    {backendUrl}
    {userId}
    {uploadedFileId}
    {folderSaved}
    {initialConversations}
    chatTitle={zipBase}
  />
</div>

<style>
  :global(table) { border-collapse: separate; border-spacing: 0; }
</style>