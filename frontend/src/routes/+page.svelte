<script lang="ts">
  let file: File | null = null;

  // Upload state
  let uploading = false;
  let uploadMsg: string | null = null;
  let uploadedFileId: string | null = null;

  // Extraction / listing state
  let extracting = false;
  let extractMsg: string | null = null;
  let extractLocation: string | null = null;

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
    mimeType?: string;
    url?: string;
    _loading?: boolean;
    _err?: string;
  };
  let files: TFile[] = [];

  function baseFromZip(name: string) {
    // keep spaces intact; just remove a single trailing .zip (case-insensitive)
    const m = name.match(/^(.*)\.zip$/i);
    return (m ? m[1] : name).trim();
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
    extractMsg = null;
    extractLocation = null;
    listLocation = '';
    listMsg = null;
    files = [];
  }

  async function uploadAndExtract() {
    if (!file) return;

    uploading = true;
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
        const put = await fetch(startData.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/zip' },
          body: file
        });
        if (!put.ok) throw new Error('Direct upload failed');
        uploadedFileId = startData.fileId;
      } else if (startData.mode === 'multipart') {
        const { fileId, uploadId, partSize, urls } = startData as {
          fileId: string; uploadId: string; partSize: number;
          urls: { partNumber: number; url: string }[];
        };
        const parts: { partNumber: number; etag: string }[] = [];
        for (const { partNumber, url } of urls.sort((a, b) => a.partNumber - b.partNumber)) {
          const s = (partNumber - 1) * partSize;
          const e = Math.min(s + partSize, file.size);
          const chunk = file.slice(s, e);
          const r = await fetch(url, { method: 'PUT', body: chunk });
          if (!r.ok) throw new Error(`Part ${partNumber} upload failed`);
          const etag = r.headers.get('ETag') || r.headers.get('etag');
          if (!etag) throw new Error(`Missing ETag for part ${partNumber}`);
          parts.push({ partNumber, etag });
        }
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

      uploadMsg = `Uploaded ✓ ${uploadedFileId}`;
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

      // Try one automatic list immediately
      await refreshList(false);
    } catch (e: any) {
      extractMsg = `Extraction failed: ${e?.message ?? e}`;
    } finally {
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
      listMsg = `Found ${files.length} file${files.length === 1 ? '' : 's'}.`;
    } catch (e: any) {
      listMsg = `List error: ${e?.message ?? e}`;
    } finally {
      listBusy = false;
    }
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

  function fmtSize(n?: number) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
</script>

<div class="max-w-5xl mx-auto p-6 space-y-8">
  <h1 class="text-3xl font-semibold">Zip Inspector</h1>
  <p class="text-sm text-gray-600">Upload a .zip (Trelae single/multipart) → server unzips → browse files.</p>

  <!-- Upload card -->
  <div class="border rounded-2xl p-5 space-y-4">
    <div class="space-y-2">
      <label for="zip-file" class="text-sm font-medium">ZIP file</label>
      <input id="zip-file" type="file" accept=".zip" class="block w-full text-sm" on:change={onPick} />
      <p class="text-xs text-gray-500">Only .zip is allowed. We'll choose single vs multipart based on size.</p>
    </div>

    <button
      class="px-4 py-2 rounded-xl bg-gray-900 text-white font-semibold hover:bg-black disabled:opacity-60"
      on:click={uploadAndExtract}
      disabled={!file || uploading || extracting}
    >
      {#if uploading}Uploading…{/if}
      {#if !uploading && extracting}Extracting…{/if}
      {#if !uploading && !extracting}Upload & Extract{/if}
    </button>

    {#if uploadMsg}<div class="text-sm text-green-700">{uploadMsg}</div>{/if}
    {#if extractMsg}
      <div class="text-sm">
        <span class="text-green-700">{extractMsg}</span>
        {#if extractLocation}
          <div class="text-xs text-blue-700 underline">{extractLocation}/</div>
          <div class="text-xs text-gray-500">Listing from: <span class="font-mono">{listLocation}</span></div>
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
          {listBusy ? 'Listing…' : 'List files now'}
        </button>
        {#if listMsg}<div class="text-sm text-gray-600">{listMsg}</div>{/if}
      </div>
    {/if}
  </div>

  <!-- Attachments list -->
  <div class="border rounded-2xl p-5 space-y-3">
    <div class="text-sm font-medium">Extracted files</div>

    {#if files.length === 0}
      <div class="text-sm text-gray-500">No files found in this extraction.</div>
    {/if}

    <ul class="space-y-2">
      {#each files as f, i}
        <li class="flex items-center justify-between gap-3 rounded-xl border px-3 py-2">
          <div class="min-w-0">
            <div class="font-medium truncate">{f.name}</div>
            <div class="text-xs text-gray-500 break-all">
              {(f.location || listLocation)}/ • {fmtSize(f.size)}
            </div>
          </div>

          <div class="flex items-center gap-2">
            {#if f.url}
              <a class="inline-flex items-center px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50" href={f.url} target="_blank" rel="noreferrer">Download</a>
            {:else}
              <button
                class="inline-flex items-center px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50 disabled:opacity-60"
                on:click={() => getLink(i)}
                disabled={!!f._loading}
              >
                {#if f._loading}Getting link…{/if}
                {#if !f._loading}Get link{/if}
              </button>
              {#if f._err}<span class="text-xs text-red-700">{f._err}</span>{/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  :global(table) { border-collapse: separate; border-spacing: 0; }
</style>