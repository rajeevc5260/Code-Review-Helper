<script lang="ts">
  let file: File | null = null;

  // Upload state
  let uploading = false;
  let uploadMsg: string | null = null;
  let uploadedFileId: string | null = null;
  let uploadPct = 0;               // NEW: upload progress %

  // Extraction / listing state
  let extracting = false;
  let extractMsg: string | null = null;
  let extractLocation: string | null = null;
  let unzipSpinnerTick = 0;        // for subtle animated dots

  // NEW: zip base name (folder inside extracted location)
  let zipBase = '';

  // Manual list inputs
  let listLocation = '';
  let listLimit = 100;   // Trelae max per page = 100
  let listPage = 1;
  let listBusy = false;
  let listMsg: string | null = null;

  type TFile = {
    id: string;
    name: string;
    size?: number;
    location?: string;
    metadata?: any;
    url?: string;
    _loading?: boolean;
    _err?: string;
  };
  let files: TFile[] = [];

  // 🚀 NEW: folders from Trelae list API
  type TFolder = { name: string; location: string };
  let folders: TFolder[] = [];

  // JSON out (for testing)
  let lastListJson: any = null;

  // Simple chat stub (UI only)
  let chatInput = '';

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────
  function baseFromZip(name: string) {
    // keep spaces intact; just remove a single trailing .zip (case-insensitive)
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

    // reset
    zipBase = f ? baseFromZip(f.name) : '';
    uploadMsg = null;
    uploadedFileId = null;
    uploadPct = 0;
    extractMsg = null;
    extractLocation = null;
    listLocation = '';
    listMsg = null;
    files = [];
    folders = [];          // ← reset folders too
    lastListJson = null;
  }

  // XHR helpers to show progress (fetch doesn't provide upload progress)
  function xhrPut(url: string, blob: Blob, onProgress: (p: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) onProgress(Math.max(0, Math.min(1, ev.loaded / ev.total)));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // Try to read ETag if present
          resolve(xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || '');
        } else {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(blob);
    });
  }

  // ─────────────────────────────────────────────
  // NEW: readiness check after unzip
  // ─────────────────────────────────────────────
  function isFileUploadedReady(f: any): boolean {
    const m = f?.metadata ?? {};
    const status = (m.status || '').toString();
    if (/uploaded|ready|complete/i.test(status)) return true;
    if (m.ready === true || m.uploadCompleted === true) return true;
    if (Number.isFinite(m.size) && m.size >= 0) return true; // Trelae commonly sets size in metadata
    if (m.etag || m.hash || m.sha256) return true;
    return false;
  }

  // add settleMs to the options and a short delay after allReady
  async function waitForAllExtracted(
    loc: string,
    opts?: { timeoutMs?: number; intervalMs?: number; settleMs?: number }
  ) {
    const timeoutMs = opts?.timeoutMs ?? 90_000;
    const intervalMs = opts?.intervalMs ?? 1_200;
    const settleMs = opts?.settleMs ?? 1_500; // NEW: post-ready grace delay
    const started = Date.now();

    while (true) {
      const r = await fetch('/ziplab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'list',
          location: loc,
          limit: 100,
          page: 1
        })
      });
      const data = await r.json().catch(() => ({}));
      const fs: any[] = Array.isArray(data?.files) ? data.files : [];
      const ds: any[] = Array.isArray(data?.folders) ? data.folders : [];

      const allReady = fs.every(isFileUploadedReady);
      if ((fs.length > 0 || ds.length > 0) && allReady) {
        if (settleMs > 0) {
          await new Promise((res) => setTimeout(res, settleMs)); // ✅ let backend finish updating
        }
        return;
      }

      if (Date.now() - started > timeoutMs) return; // give up silently
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  // ─────────────────────────────────────────────
  // Upload + Unzip + List
  // ─────────────────────────────────────────────
  async function uploadAndExtract() {
    if (!file) return;

    uploading = true;
    uploadPct = 0;

    try {
      const start = await fetch('/ziplab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          type: file.type || 'application/zip',
          size: file.size
        })
      });
      const startData = await start.json();
      if (!start.ok) throw new Error(startData?.error || 'Failed to start upload');

      if (startData.mode === 'single' && startData.uploadUrl) {
        await xhrPut(startData.uploadUrl, file, (p) => (uploadPct = Math.floor(p * 100)));
        uploadedFileId = startData.fileId;
      } else if (startData.mode === 'multipart') {
        const { fileId, uploadId, partSize, urls } = startData as {
          fileId: string; uploadId: string; partSize: number;
          urls: { partNumber: number; url: string }[];
        };
        const parts: { partNumber: number; etag: string }[] = [];
        const totalBytes = file.size || 1;

        // Track bytes uploaded across parts
        for (const { partNumber, url } of urls.sort((a, b) => a.partNumber - b.partNumber)) {
          const startOff = (partNumber - 1) * partSize;
          const endOff = Math.min(startOff + partSize, totalBytes);
          const chunk = file.slice(startOff, endOff);
          const etag = await xhrPut(url, chunk, (p) => {
            // p is 0..1 within this chunk — compute overall
            const loadedInPart = Math.floor(p * (endOff - startOff));
            const overallLoaded = startOff + loadedInPart;
            uploadPct = Math.floor((overallLoaded / totalBytes) * 100);
          });
          if (!etag) throw new Error(`Missing ETag for part ${partNumber}`);
          parts.push({ partNumber, etag });
        }

        // Finish: set 100%
        uploadPct = 100;

        // Complete multipart
        const complete = await fetch('/ziplab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'completeMultipart', fileId, uploadId, parts })
        });
        const cdata = await complete.json();
        if (!complete.ok || cdata?.success !== true) {
          throw new Error(cdata?.error || 'Failed to complete multipart upload');
        }
        uploadedFileId = fileId;
      } else {
        throw new Error('Unknown upload mode');
      }

      uploadMsg = `Zip File Uploaded ✓`;
    } catch (e: any) {
      uploadMsg = `Upload failed: ${e?.message ?? e}`;
      uploading = false;
      return;
    } finally {
      uploading = false;
    }

    if (!uploadedFileId) return;

    // unzip
    extracting = true;
    unzipSpinnerTick = 0;
    const spinnerTimer = setInterval(() => (unzipSpinnerTick = (unzipSpinnerTick + 1) % 4), 400);

    try {
      const res = await fetch('/ziplab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unzip', fileId: uploadedFileId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || data?.error || 'Unzip failed');

      extractLocation = data.location;
      extractMsg = `Extracted to ${extractLocation}/`;

      // IMPORTANT: files are inside a subfolder named after the zip filename (without .zip)
      // e.g. CodeZips/abc123/<zipBase>
      listLocation = `${extractLocation}/${zipBase}`;

      // ⏳ Wait until extracted files are ready, then add a little grace delay
      await waitForAllExtracted(listLocation, { settleMs: 2000 });

      // Now render the final listing
      await refreshList(false);
    } catch (e: any) {
      extractMsg = `Extraction failed: ${e?.message ?? e}`;
    } finally {
      clearInterval(spinnerTimer);
      extracting = false;
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'list',
          location: listLocation.trim(),
          limit: Number(listLimit) || 100,
          page: Number(listPage) || 1
        })
      });
      const data = await res.json();
      if (!res.ok) {
        listMsg = `List failed: ${data?.error || 'unknown error'}`;
        return;
      }
      files = (data.files || []) as TFile[];
      folders = (data.folders || []) as TFolder[];    // ← capture folders

      handleFilesListed({ files, folders });

      listMsg = `Found ${files.length} file${files.length === 1 ? '' : 's'} and ${folders.length} folder${folders.length === 1 ? '' : 's'}.`;
    } catch (e: any) {
      listMsg = `List error: ${e?.message ?? e}`;
    } finally {
      listBusy = false;
    }
  }

  function handleFilesListed(payload: any) {
    // 👇 Your future pipeline hook. For now, log & expose to UI.
    console.log('[AI Code Reviewer] files listed:', payload);
    lastListJson = payload;
  }

  async function getLink(idx: number) {
    const f = files[idx];
    if (!f) return;
    f._loading = true;
    f._err = undefined;
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

  // 🔸 NEW: open a folder tile (drill in)
  function openFolder(folder: TFolder) {
    const next = `${(folder.location || '').replace(/^\/+|\/+$/g, '')}/${folder.name}`.replace(/^\/+/, '');
    listLocation = next;
    refreshList();
  }

  function onChatSubmit() {
    if (!chatInput.trim()) return;
    console.log('[AI Code Reviewer] chat prompt:', chatInput);
    chatInput = '';
  }
</script>

<!-- ─────────────────────────────────────────────
     Layout
────────────────────────────────────────────── -->
<div class="max-w-6xl mx-auto p-6 space-y-8">
  <div class="flex items-baseline justify-between">
    <h1 class="text-3xl font-semibold">AI Code Reviewer</h1>
    <div class="text-xs text-gray-500">Upload → Unzip → Browse</div>
  </div>

  <!-- Upload card -->
  <div class="border rounded-2xl p-5 space-y-4">
    <div class="space-y-2">
      <label for="zip-file" class="text-sm font-medium">ZIP file</label>
      <input id="zip-file" type="file" accept=".zip" class="block w-full text-sm" on:change={onPick} />
      <p class="text-xs text-gray-500">Only .zip is allowed. We’ll choose single vs multipart based on size.</p>
    </div>

    <div class="flex flex-col gap-3">
      <button
        class="px-4 py-2 rounded-xl bg-gray-900 text-white font-medium hover:bg-black disabled:opacity-60 w-40"
        on:click={uploadAndExtract}
        disabled={!file || uploading || extracting}
      >
        {#if uploading}Uploading…{/if}
        {#if !uploading && extracting}Unzipping{/if}
        {#if !uploading && !extracting}Upload & Extract{/if}
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

    {#if uploadMsg}<div class="text-sm text-green-700">{uploadMsg}</div>{/if}
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

    <!-- Manual list controls (pre-filled to extracted folder + zipBase) -->
    {#if extractLocation}
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

  <!-- 🗂️ Folders grid -->
  <div class="space-y-2">
    {#if folders.length}
      <div class="text-sm font-medium">Extracted folders</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each folders as d}
          <div class="border rounded-xl p-3 flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <div class="font-medium truncate" title={d.name}>📁 {d.name}</div>
              <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100">folder</span>
            </div>
            <div class="text-xs text-gray-600 break-all">
              <span class="font-semibold">Path:</span> {(d.location || '')}/{d.name}
            </div>
            <div class="mt-1">
              <button
                class="inline-flex items-center px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50"
                on:click={() => openFolder(d)}
              >Open</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- 📄 Files grid -->
  <div class="space-y-2">
    <div class="text-sm font-medium">Extracted files</div>

    {#if files.length === 0}
      <div class="text-sm text-gray-500">No files found in this extraction.</div>
    {:else}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {#each files as f, i}
          <div class="border rounded-xl p-3 flex flex-col gap-2">
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
                <a class="inline-flex items-center px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50"
                   href={f.url} target="_blank" rel="noreferrer">Download</a>
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

  <!-- Raw JSON preview (from handleFilesListed) -->
  <div class="border rounded-2xl p-4">
    <div class="text-sm font-medium mb-2">Listed JSON (testing)</div>
    {#if lastListJson}
      <pre class="text-xs bg-gray-50 p-3 rounded-lg overflow-auto max-h-80">{JSON.stringify(lastListJson, null, 2)}</pre>
    {:else}
      <div class="text-xs text-gray-500">Nothing listed yet.</div>
    {/if}
  </div>

  <!-- Chat stub -->
  <div class="border rounded-2xl p-4 space-y-2">
    <div class="text-sm font-medium">Ask a question (wire up later)</div>
    <textarea
      class="w-full rounded-xl border px-3 py-2 text-sm"
      rows="3"
      bind:value={chatInput}
      placeholder="e.g., Where is the main logic?"
    ></textarea>
    <div class="flex justify-end">
      <button class="px-4 py-2 rounded-xl bg-gray-900 text-white font-semibold hover:bg-black disabled:opacity-60"
              on:click={onChatSubmit} disabled={!chatInput.trim()}>
        Submit
      </button>
    </div>
  </div>
</div>

<style>
  :global(table) { border-collapse: separate; border-spacing: 0; }
</style>