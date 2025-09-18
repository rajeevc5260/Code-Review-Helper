<script lang="ts">
	import { Trelae } from 'trelae-files';
  import { tick } from 'svelte';

  //  values supplied by +page.server.ts
  export let data: { userId: string; backendUrl: string };
  let backendUrl: string = data.backendUrl;
  let userId: string = data.userId;

  console.log('[AI Code Reviewer] backendUrl:', backendUrl, 'userId:', userId);

  let file: File | null = null;

  // Upload state
  let uploading = false;
  let uploadMsg: string | null = null;
  let uploadedFileId: string | null = null;
  let uploadPct = 0;

  // Extraction / listing state
  let extracting = false;
  let extractMsg: string | null = null;
  let extractLocation: string | null = null;
  let unzipSpinnerTick = 0;

  // verification phase after unzip
  let verifying = false;
  let verifySpinnerTick = 0;

  // zip base name (folder inside extracted location)
  let zipBase = '';

  // Manual list inputs
  let listLocation = '';
  let listLimit = 100;
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

  type TPagination = { limit: number; page:number }
  type TCount = number;
  let files: TFile[] = [];
  let pagination: TPagination[] = [];
  let totalCount: TCount = 0;

  // folders from Trelae list API
  type TFolder = { name: string; location: string };
  let folders: TFolder[] = [];

  // JSON out (for testing)
  let lastListJson: any = null;

  // Helpers
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
    folders = [];
    lastListJson = null;

    // LLM integration state reset
    folderSaved = false;
    saveMsg = null;
    saving = false;
    events = [];
    connectionStatus = 'disconnected';

    // collapse panels again on new selection
    showFolders = false;
    showFiles = false;
    showJson = false;
  }

  // XHR helpers (upload progress)
  function xhrPut(url: string, blob: Blob, onProgress: (p: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) onProgress(Math.max(0, Math.min(1, ev.loaded / ev.total)));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || '');
        } else {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(blob);
    });
  }

  // readiness check after unzip
  function isFileUploadedReady(f: any): boolean {
    if (!f || !f.metadata) return false;
    const status =
      (f.metadata.status ||
       f.metadata.uploadStatus ||
       f.metadata.state ||
       f.status ||
       ''
      ).toString().toLowerCase();

    return status === 'uploaded';
  }

  async function waitForAllExtracted(
    loc: string,
    opts?: { timeoutMs?: number; intervalMs?: number; settleMs?: number }
  ) {
    const timeoutMs = opts?.timeoutMs ?? 90_000;
    const intervalMs = opts?.intervalMs ?? 1_200;
    const settleMs = opts?.settleMs ?? 1_500;
    const started = Date.now();

    while (true) {
      const r = await fetch('/ziplab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  // Upload + Unzip + List
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
        if (!complete.ok || cdata?.success !== true) throw new Error(cdata?.error || 'Failed to complete multipart upload');
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
    const unzipTimer = setInterval(() => (unzipSpinnerTick = (unzipSpinnerTick + 1) % 4), 400);

    let verifyTimer: any = null;

    try {
      const res = await fetch('/ziplab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unzip', fileId: uploadedFileId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || data?.error || 'Unzip failed');

      // Unzip finished
      clearInterval(unzipTimer);
      extracting = false;

      extractLocation = data.location;
      extractMsg = `Extracted to ${extractLocation}/`;

      // IMPORTANT: files are inside a subfolder named after the zip filename (without .zip)
      // e.g. CodeZips/abc123/<zipBase>
      listLocation = `${extractLocation}/${zipBase}`;

      // ✅ Verification phase (button text changes; listing only after this)
      verifying = true;
      verifySpinnerTick = 0;
      verifyTimer = setInterval(() => (verifySpinnerTick = (verifySpinnerTick + 1) % 4), 400);

      await waitForAllExtracted(listLocation, { settleMs: 2000 });

      verifying = false;
      if (verifyTimer) clearInterval(verifyTimer);

      // Final list AFTER verification
      await refreshList(false);
    } catch (e: any) {
      extractMsg = `Extraction failed: ${e?.message ?? e}`;
      if (verifyTimer) clearInterval(verifyTimer);
    } finally {
      clearInterval(unzipTimer);
      verifying = false;
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
      folders = (data.folders || []) as TFolder[];
      pagination = (data.pagination || []) as TPagination[];
      totalCount = data.totalCount || 0;

      handleFilesListed({ files, folders, pagination, totalCount });

      listMsg = `Found ${files.length} file${files.length === 1 ? '' : 's'} and ${folders.length} folder${folders.length === 1 ? '' : 's'}.`;

      // 🔗 NEW: after a successful first list, persist to backend once
      await maybePersistFolderStructure();
    } catch (e: any) {
      listMsg = `List error: ${e?.message ?? e}`;
    } finally {
      listBusy = false;
    }
  }

  function handleFilesListed(payload: any) {
    // future pipeline hook. For now, log & expose to UI.
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

  // open a folder tile (drill in)
  function openFolder(folder: TFolder) {
    const next = `${(folder.location || '').replace(/^\/+|\/+$/g, '')}/${folder.name}`.replace(/^\/+/, '');
    listLocation = next;
    refreshList();
  }

  // 🔥 LLM BACKEND INTEGRATION (auto-save + streaming UI)

  let analysisMessage = 'Scan routes and identify potential issues';

  // Persist folder structure once per uploaded zip
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
        folderStructure: {
          rootLocation: listLocation,
          ...lastListJson
        }
      };

      const r = await fetch(`${backendUrl}/review-zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    }
  }

  type StreamEvent = { id: number; type: string; data: any };
  let events: StreamEvent[] = [];
  let eventId = 0;
  let controller: AbortController | null = null;

  type Conn = 'disconnected' | 'connecting' | 'connected';
  let connectionStatus: Conn = 'disconnected';
  let isThinking = false;

  function statusDotClass() {
    return connectionStatus === 'connected'
      ? 'bg-green-500'
      : connectionStatus === 'connecting'
      ? 'bg-yellow-500'
      : 'bg-red-500';
  }

  // refs for auto-scroll
  let streamContainer: HTMLDivElement;
  let pageEnd: HTMLDivElement;

  async function scrollToLatest() {
    // wait for DOM to update, then scroll container and page
    await tick();
    if (streamContainer) {
      streamContainer.scrollTo({ top: streamContainer.scrollHeight, behavior: 'smooth' });
    }
    // also nudge the whole page down to keep stream in view
    if (pageEnd) {
      pageEnd.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } else {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }

  function addEvent(type: string, data: any) {
    events = [...events, { id: eventId++, type, data }];
    // simple "thinking" heuristic
    const thinkingEvents = ['start','progress','directory_scan_started','file_access_started','file_analysis_started'];
    isThinking = thinkingEvents.includes(type);
    scrollToLatest();
  }

  function clearEvents() {
    events = [];
    eventId = 0;
    isThinking = false;
  }

  function parseSSELine(line: string) {
    if (line.startsWith('event: ')) {
      return { type: 'event', value: line.slice(7).trim() };
    }
    if (line.startsWith('data: ')) {
      return { type: 'data', value: line.slice(6).trim() };
    }
    if (line.startsWith(': ')) {
      return { type: 'comment', value: line.slice(2) };
    }
    return null;
  }

  async function startAnalysis() {
    if (!uploadedFileId) {
      saveMsg = 'Upload a zip first';
      return;
    }
    // ensure saved
    if (!folderSaved) {
      await maybePersistFolderStructure();
      if (!folderSaved) return;
    }

    clearEvents();
    controller?.abort();
    controller = new AbortController();
    connectionStatus = 'connecting';

    try {
      const res = await fetch(`${backendUrl}/ai/review/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, zipFileId: uploadedFileId, message: analysisMessage }),
        signal: controller.signal
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      if (!res.body) throw new Error('No response body');

      connectionStatus = 'connected';

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent: string | null = null;
      let currentData: any = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const parsed = parseSSELine(line);
          if (parsed?.type === 'event') {
            currentEvent = parsed.value;
          } else if (parsed?.type === 'data') {
            try { currentData = JSON.parse(parsed.value); }
            catch { currentData = { message: parsed.value, timestamp: Date.now() }; }
          } else if (line === '' && currentEvent && currentData) {
            addEvent(currentEvent, currentData);
            currentEvent = null;
            currentData = null;
          }
        }
      }

      connectionStatus = 'disconnected';
      isThinking = false;
    } catch (err: any) {
      connectionStatus = 'disconnected';
      if (err?.name !== 'AbortError') {
        addEvent('error', { message: `Connection failed: ${err?.message ?? err}`, timestamp: Date.now() });
      }
    }
  }

  function stopAnalysis() {
    controller?.abort();
    connectionStatus = 'disconnected';
    isThinking = false;
  }

  // Collapsibles (default collapsed)
  let showFolders = false;
  let showFiles = false;
  let showJson = false;

  // Stepper view
  function stepClass(state: 'done'|'current'|'future') {
    return state === 'done'
      ? 'bg-green-100 text-green-800 ring-1 ring-green-200'
      : state === 'current'
      ? 'bg-gray-900 text-white'
      : 'bg-gray-100 text-gray-600';
  }

  function stepState(n: number): 'done'|'current'|'future' {
    const s1 = !!uploadedFileId || extracting || verifying || !!extractLocation;
    const s2 = !!extractLocation && !verifying;
    const s3 = files.length > 0;
    const s4 = folderSaved;
    const s5 = events.length > 0;
    const states = [s1, s2, s3, s4, s5];

    const idx = states.findIndex((ok) => !ok);
    const current = idx === -1 ? 5 : idx + 1;

    if (n < current && states[n-1]) return 'done';
    if (n === current) return 'current';
    return 'future';
  }

  // Markdown → safe HTML
  function escapeHtml(s: string) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function sanitizeHtml(s: string) {
    // strip script tags + inline events
    return s
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi,'')
      .replace(/\son\w+="[^"]*"/gi,'')
      .replace(/\son\w+='[^']*'/gi,'');
  }

  function mdToHtml(md: string) {
    // Normalize CRLF -> LF and trim edges to avoid phantom blank lines
    let out = (md ?? '').replace(/\r\n?/g, '\n').trim();

    // fenced code with optional language token
    out = out.replace(/```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_m, lang, code) => {
      const language = lang ? ` data-language="${escapeHtml(String(lang))}"` : '';
      const cleaned = String(code).replace(/^\n+|\n+$/g, '');
      return `<pre class="rounded-lg border bg-gray-50 p-3 overflow-auto"${language}><code>${escapeHtml(cleaned)}</code></pre>`;
    });

    // horizontal rules (---, ***, ___) on their own line
    out = out.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr class="my-4 border-t border-gray-200" />');

    // images
    out = out.replace(
      /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
      '<img src="$2" alt="$1" class="rounded border max-w-full my-2" loading="lazy" referrerpolicy="no-referrer" />'
    );

    // headings
    out = out.replace(/^\s*###### (.*)$/gm, '<h6 class="font-semibold mt-3 mb-1">$1</h6>');
    out = out.replace(/^\s*##### (.*)$/gm, '<h5 class="font-semibold mt-3 mb-1">$1</h5>');
    out = out.replace(/^\s*#### (.*)$/gm, '<h4 class="font-semibold mt-3 mb-1">$1</h4>');
    out = out.replace(/^\s*### (.*)$/gm, '<h3 class="font-semibold text-base mt-3 mb-1">$1</h3>');
    out = out.replace(/^\s*## (.*)$/gm, '<h2 class="font-semibold text-lg mt-4 mb-2">$1</h2>');
    out = out.replace(/^\s*# (.*)$/gm, '<h1 class="font-semibold text-xl mt-4 mb-2">$1</h1>');

    // lists
    out = out.replace(/^(?:\s*[-*] .*(?:\n|$))+?/gm, (block) => {
      const items = block
        .trim()
        .split('\n')
        .map((line) => line.replace(/^\s*[-*] (.*)$/, '<li>$1</li>'))
        .join('');
      return `<ul class="list-disc pl-5 my-2 space-y-1">${items}</ul>`;
    });

    // links (do after images)
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer" class="underline text-blue-600">$1</a>'
    );

    // bold / italic / inline code
    out = out.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^\*])\*(.*?)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-gray-100 border">$1</code>');

    // paragraphs: group consecutive non-HTML lines into a single paragraph.
    // Inside a paragraph, keep single line breaks as <br /> (no extra vertical gaps).
    out = out.replace(/(^|\n)(?!\s*<)([^\n][\s\S]*?)(?=\n{2,}|$)/g, (_m, pfx, block) => {
      const html = String(block).trim().replace(/\n+/g, '<br />');
      return `${pfx}<p class="my-2">${html}</p>`;
    });

    return sanitizeHtml(out.trim());
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
        <p class="text-sm text-gray-600"><span class="font-medium">Click to upload</span></p>
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
                <div class="border rounded-xl p-3 flex flex-col gap-2 bg-white">
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

    <!-- JSON debug -->
    <!-- <div class="border rounded-2xl bg-white">
      <button class="w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
        on:click={() => showJson = !showJson}>
        <span>Listed JSON (testing)</span>
        <span class="flex items-center gap-2 text-xs text-gray-600">
          {lastListJson ? 'Available' : 'Empty'}
          <svg class="w-4 h-4 transition-transform" style={`transform: rotate(${showJson ? 180 : 0}deg);`} viewBox="0 0 20 20"><path d="M5 8l5 5 5-5H5z" /></svg>
        </span>
      </button>
      {#if showJson}
        <div class="p-4">
          {#if lastListJson}
            <pre class="text-xs bg-gray-50 p-3 rounded-lg overflow-auto max-h-80 border">{JSON.stringify(lastListJson, null, 2)}</pre>
          {:else}
            <div class="text-xs text-gray-500">Nothing listed yet.</div>
          {/if}
        </div>
      {/if}
    </div> -->
  </div>

  <!-- AI Review (stream) -->
  <div class="border rounded-2xl p-5 space-y-4 bg-white">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">AI Review</h2>
      <div class="flex items-center gap-2 text-xs">
        <span class="w-2.5 h-2.5 rounded-full {statusDotClass()}"></span>
        <span class="capitalize">{connectionStatus}</span>
      </div>
    </div>

    <div>
      <label for="request-message" class="text-xs text-gray-600">Request Message</label>
      <textarea id="request-message" rows="2" class="w-full rounded-xl border px-3 py-2 text-sm" bind:value={analysisMessage}
        placeholder="What should the reviewer look for?"></textarea>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <button class="px-3 py-2 rounded-xl border text-sm hover:bg-gray-50 disabled:opacity-60"
        on:click={maybePersistFolderStructure} disabled={saving || !lastListJson || !uploadedFileId}>
        {saving ? 'Saving…' : (folderSaved ? 'Saved ✓' : 'Save structure')}
      </button>

      <button class="px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-medium hover:bg-black disabled:opacity-60"
        on:click={startAnalysis}
        disabled={!folderSaved || connectionStatus === 'connected'}>
        Start Analysis
      </button>

      <button class="px-3 py-2 rounded-xl border text-sm hover:bg-gray-50 disabled:opacity-60"
        on:click={stopAnalysis} disabled={connectionStatus !== 'connected'}>
        Stop
      </button>

      <button class="px-3 py-2 rounded-xl border text-sm hover:bg-gray-50"
        on:click={clearEvents}>
        Clear
      </button>

      {#if saveMsg}<div class="text-sm text-gray-600">{saveMsg}</div>{/if}
    </div>

    <!-- Stream panel -->
    <div class="border rounded-xl overflow-hidden">
      <div class="px-4 py-2 border-b bg-gray-50 text-sm font-medium">Analysis Stream</div>
      <div class="max-h-[60vh] overflow-y-auto divide-y" bind:this={streamContainer}>
        {#if events.length === 0}
          <div class="py-16 text-center text-sm text-gray-500">
            Click <span class="font-medium">Start Analysis</span> to begin streaming AI code review
          </div>
        {:else}
          {#each events as e (e.id)}
            <div class="p-4 space-y-2">
              <div class="flex items-center gap-2">
                <span class="text-[11px] font-mono px-2 py-0.5 rounded-full bg-gray-100">{e.type}</span>
                <span class="text-xs text-gray-500">{new Date(e.data?.timestamp || Date.now()).toLocaleTimeString()}</span>
              </div>

              {#if e.type === 'analysis_result'}
                <div class="text-sm">Analysis completed successfully</div>
                {#if e.data?.message}
                  <div class="markdown-body text-[13px] leading-6">
                    {@html mdToHtml(e.data.message)}
                  </div>
                {/if}
              {:else}
                <div class="text-sm">{e.data?.message || e.data?.status || 'Event received'}</div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
      {#if isThinking}
        <div class="px-4 py-2 text-xs text-gray-600 italic border-t flex items-center gap-2">
          <span class="w-3 h-3 border-2 border-gray-200 border-t-gray-600 rounded-full animate-spin"></span>
          Processing…
        </div>
      {/if}
    </div>
  </div>

  <!-- sentinel for page-level auto-scroll -->
  <div bind:this={pageEnd}></div>
</div>

<style>
  :global(table) { border-collapse: separate; border-spacing: 0; }
</style>