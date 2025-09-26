<script lang="ts">
  import { onMount, tick } from 'svelte';

  export let backendUrl: string;
  export let userId: string;
  export let uploadedFileId: string | null;
  export let folderSaved: boolean;
  export let initialConversations: any[] | undefined;

  /* title to use when starting a chat (we pass the zip base from parent) */
  export let chatTitle: string | undefined;

  type Msg = { kind: 'msg'; role: 'user' | 'assistant'; content: string; createdAt?: string };
  type StreamEvent = { id: number; type: string; time: number; data: any };
  type Activity = { kind: 'activity'; id: number; events: StreamEvent[]; active: boolean };
  type Row = Msg | Activity;

  type Conversation = {
    id: string;
    title?: string;
    zip_file_id?: string;
    created_at?: string;
    updated_at?: string;
    last_message_at?: string | null;
    message_count?: number;
  };
  let conversations: Conversation[] = Array.isArray(initialConversations) ? initialConversations : [];
  let selectedConversationId: string | null = conversations[0]?.id ?? null;

  let timeline: Row[] = [];
  let conversationId: string | null = null;

  let input = '';
  let connecting = false;
  let streamContainer: HTMLDivElement;

  let activeActivityIdx: number | null = null;
  let evtId = 0;
  let assistantDraft = '';

  let isThinking = false;
  const THINKING_START = new Set(['start','progress','directory_scan_started','file_access_started','file_analysis_started']);
  const THINKING_STOP  = new Set(['directory_scan_complete','file_access_complete','file_analysis_complete','finished','error','operation_error']);

  $: canChat = !!conversationId && !!uploadedFileId && !!folderSaved;
  $: isDisconnected = !!uploadedFileId && !folderSaved;

  const CONV_KEY = (u: string, fid: string) => `acr:conv:${u}:${fid}`;
  const SEL_KEY  = (u: string, fid: string) => `acr:convsel:${u}:${fid}`;

  function persistConversation() {
    if (conversationId && uploadedFileId) {
      try { sessionStorage.setItem(CONV_KEY(userId, uploadedFileId), conversationId); } catch {}
    }
  }
  function hydrateConversation() {
    if (!uploadedFileId) return;
    try {
      const saved = sessionStorage.getItem(CONV_KEY(userId, uploadedFileId));
      if (saved) {
        conversationId = saved;
        loadMessages();
      }
    } catch {}
  }
  function hydrateSelectedId(): string | null {
    if (!uploadedFileId) return null;
    try { return sessionStorage.getItem(SEL_KEY(userId, uploadedFileId)) || null; } catch { return null; }
  }
  $: if (uploadedFileId && selectedConversationId) {
    try { sessionStorage.setItem(SEL_KEY(userId, uploadedFileId), selectedConversationId); } catch {}
  }

  onMount(() => {
    hydrateConversation();
    if (!conversations.length) loadConversationList();
  });

  async function loadConversationList() {
    try {
      const url = `${backendUrl}/chat/conversations?userId=${encodeURIComponent(userId)}${uploadedFileId ? `&zipFileId=${encodeURIComponent(uploadedFileId)}` : ''}`;
      const r = await fetch(url);
      const d = await r.json();
      if (r.ok && Array.isArray(d?.conversations)) {
        conversations = d.conversations;
        if (!selectedConversationId) {
          const savedSel = hydrateSelectedId();
          if (savedSel && conversations.some(c => c.id === savedSel)) {
            selectedConversationId = savedSel;
          } else if (conversations.length) {
            selectedConversationId = conversations[0].id;
          }
        }
      }
    } catch {}
  }

  let lastZipForList: string | null = null;
  $: if (uploadedFileId && uploadedFileId !== lastZipForList) {
    lastZipForList = uploadedFileId;
    loadConversationList();
  }

  /* HARD RESET when a different zip is selected */
  let lastZipSeen: string | null = null;
  $: if ((uploadedFileId ?? null) !== lastZipSeen) {
    lastZipSeen = uploadedFileId ?? null;
    timeline = [];
    conversationId = null;
    selectedConversationId = null;
    assistantDraft = '';
    input = '';
    connecting = false;
    activeActivityIdx = null;
    evtId = 0;
    isThinking = false;
    if (uploadedFileId) {
      hydrateConversation();
    } else {
      conversations = [];
    }
  }

  async function openSelectedConversation() {
    if (!selectedConversationId) return;
    conversationId = selectedConversationId;
    timeline = [];
    persistConversation();
    await loadMessages();
  }

  /* ---------- tiny helpers ---------- */
  function escapeHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function sanitizeHtml(s: string) {
    return s.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi,'').replace(/\son\w+="[^"]*"/gi,'').replace(/\son\w+='[^']*'/gi,'');
  }

  // 👇 Detect & upgrade long signed/asset URLs into download buttons
  function isDownloadUrl(u: string): boolean {
    try {
      const url = new URL(u);
      const host = url.hostname.toLowerCase();
      const qs = url.search.toLowerCase();
      const looksSigned = qs.includes('expires=') || qs.includes('signature=') || qs.includes('key-pair-id=');
      const isAssetHost = /cloudfront\.net|amazonaws\.com|blob\.core\.windows\.net|googleapis\.com/.test(host);
      const longQuery = url.search.length > 30;
      const hasExt = /\.[a-z0-9]+$/i.test(url.pathname);
      return (looksSigned || isAssetHost || longQuery) && (hasExt || looksSigned);
    } catch { return false; }
  }
  function fileNameFromUrl(u: string): string {
    try {
      const url = new URL(u);
      const last = url.pathname.split('/').pop() || 'file';
      return decodeURIComponent(last.replace(/\+/g, ' '));
    } catch { return 'file'; }
  }
  function enhanceDownloadButtons(html: string): string {
    return html.replace(/<a\s+([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi, (_m, pre, href, post, inner) => {
      if (!isDownloadUrl(href)) return _m;
      const name = fileNameFromUrl(href);
      // keep target/rel if present; otherwise set safe defaults
      const hasTarget = /target=/.test(pre + post);
      const hasRel = /rel=/.test(pre + post);
      const target = hasTarget ? '' : ' target="_blank"';
      const rel = hasRel ? '' : ' rel="noreferrer"';
      return `<a href="${href}"${target}${rel}
        class="inline-flex items-center text-xs gap-2 px-2 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition"
      >
        <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"/>
        </svg>
        Download ${escapeHtml(name)}
      </a>`;
    });
  }

  function mdToHtml(md: string) {
    let out = (md ?? '').replace(/\r\n?/g, '\n').trim();
    out = out.replace(/```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_m, lang, code) => {
      const language = lang ? ` data-language="${escapeHtml(String(lang))}"` : '';
      const cleaned = String(code).replace(/^\n+|\n+$/g, '');
      return `<pre class="rounded-xl border bg-gray-50 p-3 overflow-auto"${language}><code>${escapeHtml(cleaned)}</code></pre>`;
    });
    out = out.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr class="my-4 border-t border-gray-200" />');
    out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,'<img src="$2" alt="$1" class="rounded border max-w-full my-2" loading="lazy" referrerpolicy="no-referrer" />');
    out = out.replace(/^\s*###### (.*)$/gm, '<h6 class="font-semibold mt-3 mb-1">$1</h6>');
    out = out.replace(/^\s*##### (.*)$/gm, '<h5 class="font-semibold mt-3 mb-1">$1</h5>');
    out = out.replace(/^\s*#### (.*)$/gm, '<h4 class="font-semibold mt-3 mb-1">$1</h4>');
    out = out.replace(/^\s*### (.*)$/gm, '<h3 class="font-semibold text-base mt-3 mb-1">$1</h3>');
    out = out.replace(/^\s*## (.*)$/gm, '<h2 class="font-semibold text-lg mt-4 mb-2">$1</h2>');
    out = out.replace(/^\s*# (.*)$/gm, '<h1 class="font-semibold text-xl mt-4 mb-2">$1</h1>');
    out = out.replace(/^(?:\s*[-*] .*(?:\n|$))+?/gm, (block) => {
      const items = block.trim().split('\n').map((line) => line.replace(/^\s*[-*] (.*)$/, '<li>$1</li>')).join('');
      return `<ul class="list-disc pl-5 my-2 space-y-1">${items}</ul>`;
    });
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer" class="underline">$1</a>');
    out = out.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^\*])\*(.*?)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-gray-50 border border-gray-100 text-pink-500">$1</code>');
    out = out.replace(/(^|\n)(?!\s*<)([^\n][\s\S]*?)(?=\n{2,}|$)/g, (_m, pfx, block) => {
      const html = String(block).trim().replace(/\n+/g, '<br />');
      return `${pfx}<p class="my-2">${html}</p>`;
    });

    // 🔷 finally, upgrade raw anchors that look like download links into buttons
    out = enhanceDownloadButtons(out);

    return sanitizeHtml(out.trim());
  }

  async function autoScroll() { await tick(); if (streamContainer) streamContainer.scrollTo({ top: streamContainer.scrollHeight, behavior: 'smooth' }); }
  function parseSSELine(line: string) {
    if (line.startsWith('event: ')) return { type: 'event', value: line.slice(7).trim() };
    if (line.startsWith('data: '))  return { type: 'data',  value: line.slice(6).trim() };
    if (line.startsWith(': '))      return { type: 'comment', value: line.slice(2) };
    return null;
  }

  const OMIT = new Set(['fileId','downloadUrl']);
  function scrub(obj: any): any {
    if (Array.isArray(obj)) return obj.map(scrub);
    if (obj && typeof obj === 'object') {
      const out: any = {};
      for (const [k,v] of Object.entries(obj)) { if (OMIT.has(k)) continue; out[k] = scrub(v); }
      return out;
    }
    return obj;
  }

  function eventTitle(ev: StreamEvent): string {
    const d = ev.data || {};
    switch (ev.type) {
      case 'progress': return d.message || 'Progress';
      case 'directory_scan_started': return 'Scanning project structure';
      case 'directory_scan_complete': {
        const s = d.summary || {}; const files = s.filesCount ?? s.files ?? '—'; const folders = s.foldersCount ?? s.folders ?? '—';
        return `Scan complete — ${files} files, ${folders} folders`;
      }
      case 'file_access_started': return 'Authorizing file access';
      case 'file_access_complete': return 'File access granted';
      case 'file_analysis_started': { const name = d.parameters?.name || d.name || d.fileName || 'file'; return `Reading ${name}`; }
      case 'file_analysis_complete': { const name = d.fileName || d.name || 'file'; const ms = typeof d.durationMs === 'number' ? ` in ${d.durationMs}ms` : ''; return `Analyzed ${name}${ms}`; }
      case 'history_loaded': return d.message || 'Loaded conversation history';
      case 'message_saved': return `Saved ${d.role || 'message'}`;
      case 'error':
      case 'operation_error': return d.message || 'Error';
      case 'finished': return d.message || 'Finished';
      case 'review_summary': return d.message || 'Review summary';
      default: return d.message || ev.type;
    }
  }

  function eventBadgeClasses(t: string) {
    if (t.includes('error')) return 'bg-rose-100 text-rose-800 border border-rose-200';
    if (t.includes('complete')) return 'bg-emerald-100 text-emerald-800 border border-emerald-200';
    if (t.includes('started')) return 'bg-sky-100 text-sky-800 border border-sky-200';
    if (t === 'progress' || t === 'review_summary') return 'bg-amber-100 text-amber-900 border border-amber-200';
    if (t === 'finished') return 'bg-indigo-100 text-indigo-800 border border-indigo-200';
    return 'bg-gray-100 text-gray-800 border border-gray-200';
  }
  function eventStripeClasses(t: string) {
    if (t.includes('error')) return 'border-rose-300 bg-rose-50/60';
    if (t.includes('complete')) return 'border-emerald-300 bg-emerald-50/60';
    if (t.includes('started')) return 'border-sky-300 bg-sky-50/60';
    if (t === 'progress' || t === 'review_summary') return 'border-amber-300 bg-amber-50/60';
    if (t === 'finished') return 'border-indigo-300 bg-indigo-50/60';
    return 'border-gray-300 bg-gray-50/60';
  }

  const Icon = {
    user: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 1116 0v1H4v-1z"/></svg>`,

    // simple outlined brain
    assistant: () => `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 640 640"><path fill="#ffffff" d="M264 64C227.4 64 196.5 88.6 187 122.1C139.6 131.8 104 173.7 104 224C104 235.3 105.8 246.2 109.1 256.3C86.4 275.4 72 304 72 336C72 359.7 80 381.6 93.3 399.1C89.8 409.5 88 420.5 88 432C88 486 129.2 530.5 181.9 535.5C197.5 559.8 224.8 576 256 576C281.2 576 304 565.4 320 548.4C336 565.4 358.8 576 384 576C415.1 576 442.4 559.8 458.1 535.5C510.8 530.4 552 486 552 432C552 420.5 550.1 409.5 546.7 399.1C560.1 381.6 568 359.7 568 336C568 304 553.5 275.4 530.9 256.3C534.2 246.1 536 235.2 536 224C536 173.7 500.4 131.8 453 122.1C443.5 88.6 412.6 64 376 64C354.2 64 334.4 72.7 320 86.9C305.6 72.8 285.8 64 264 64zM296 144L296 491.1C295.9 491.7 295.8 492.3 295.7 493C293.2 512.7 276.4 528 256 528C239.2 528 224.8 517.7 218.9 502.9C215.1 493.3 205.6 487.3 195.3 487.9C194.2 488 193.1 488 192.1 488C161.2 488 136.1 462.9 136.1 432C136.1 422.5 138.5 413.5 142.6 405.7C147.7 396.1 145.7 384.3 137.8 376.9C126.8 366.7 120 352.1 120 336C120 314.4 132.2 295.6 150.3 286.2C156.2 283.2 160.5 277.8 162.3 271.5C164.1 265.2 163.2 258.3 159.8 252.6C154.8 244.2 151.9 234.5 151.9 224C151.9 193.1 177 168 207.9 168C221.2 168 231.9 157.3 231.9 144C231.9 126.3 246.2 112 263.9 112C281.6 112 295.9 126.3 295.9 144zM344 491.1L344 144C344 126.3 358.3 112 376 112C393.7 112 408 126.3 408 144C408 157.3 418.7 168 432 168C462.9 168 488 193.1 488 224C488 234.5 485.1 244.3 480.1 252.6C476.7 258.3 475.8 265.1 477.6 271.5C479.4 277.9 483.8 283.2 489.6 286.2C507.6 295.5 519.9 314.3 519.9 336C519.9 352.1 513.1 366.7 502.1 376.9C494.2 384.3 492.2 396.1 497.3 405.7C501.5 413.5 503.8 422.4 503.8 432C503.8 462.9 478.7 488 447.8 488C446.7 488 445.6 488 444.6 487.9C434.3 487.3 424.8 493.4 421 502.9C415.1 517.6 400.6 528 383.9 528C363.5 528 346.7 512.7 344.2 493C344.1 492.4 344 491.7 343.9 491.1z"/></svg>`,

    bolt: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M13 3L4 14h7l-1 7 9-11h-7l1-7z"/></svg>`
  };

  async function startChat() {
    if (!folderSaved || !uploadedFileId) return;
    const r = await fetch(`${backendUrl}/chat/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, zipFileId: uploadedFileId, title: (chatTitle || '').trim() || undefined })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || 'Failed to start chat');
    conversationId = d.conversationId;
    persistConversation();

    conversations = [
      {
        id: conversationId ?? '',
        title: (chatTitle || '').trim() || 'New chat',
        zip_file_id: uploadedFileId,
        created_at: new Date().toISOString(),
        message_count: 0,
        last_message_at: null
      },
      ...conversations
    ];
    selectedConversationId = conversationId;
    await loadMessages();
  }

  async function loadMessages() {
    if (!conversationId) return;
    const r = await fetch(`${backendUrl}/chat/${conversationId}/messages`);
    const d = await r.json();
    const msgs: Msg[] = Array.isArray(d?.messages)
      ? d.messages.map((m:any) => ({ kind:'msg', role: m.role, content: m.content, createdAt: m.createdAt }))
      : [];
    timeline = msgs;
    await autoScroll();
  }

  function beginActivityRow() {
    const act: Activity = { kind: 'activity', id: Date.now() + Math.random(), events: [], active: true };
    timeline = [...timeline, act];
    activeActivityIdx = timeline.length - 1;
  }
  function addEventToActive(type: string, raw: any) {
    if (activeActivityIdx === null) return;
    const clean = scrub(raw);
    const ev: StreamEvent = { id: evtId++, type, time: Date.now(), data: clean };
    const row = timeline[activeActivityIdx] as Activity;
    row.events = [...row.events, ev];
    timeline = timeline.map((r, idx) => (idx === activeActivityIdx ? row : r));
    if (THINKING_START.has(type)) isThinking = true;
    if (THINKING_STOP.has(type))  isThinking = false;
  }
  function endActivityRow() {
    if (activeActivityIdx === null) return;
    const row = timeline[activeActivityIdx] as Activity;
    row.active = false;
    timeline = timeline.map((r, idx) => (idx === activeActivityIdx ? row : r));
    activeActivityIdx = null;
    isThinking = false;
  }

  async function sendMessage() {
    if (!folderSaved) return;
    if (!conversationId || !uploadedFileId || !input.trim() || connecting) return;

    const userText = input.trim();
    input = '';
    timeline = [...timeline, { kind:'msg', role:'user', content: userText }];
    await autoScroll();

    beginActivityRow();
    assistantDraft = '';
    connecting = true;

    try {
      const res = await fetch(`${backendUrl}/ai/review/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, zipFileId: uploadedFileId, conversationId, message: userText })
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${res.statusText || 'no stream'}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let curEvent: string | null = null;
      let curData: any = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const parsed = parseSSELine(line);
          if (parsed?.type === 'event') curEvent = parsed.value;
          else if (parsed?.type === 'data') { try { curData = JSON.parse(parsed.value); } catch { curData = { message: parsed.value, timestamp: Date.now() }; }
          }
          else if (line === '' && curEvent && curData) {
            if (curEvent === 'analysis_result' && curData?.message) {
              assistantDraft = curData.message;
              addEventToActive('progress', { message: 'Drafting final answer…' });
            } else {
              addEventToActive(curEvent, curData);
            }
            if (curEvent === 'finished') {
              endActivityRow();
              const md = assistantDraft || (curData?.message ?? 'Analysis completed.');
              timeline = [...timeline, { kind:'msg', role:'assistant', content: md }];
              await loadMessages();
            }
            curEvent = null; curData = null;
            await autoScroll();
          }
        }
      }
    } catch (e) {
      addEventToActive('error', { message: String((e as any)?.message || e) });
      endActivityRow();
      timeline = [...timeline, { kind:'msg', role:'assistant', content: `**Error:** ${(e as any)?.message || e}` }];
      await loadMessages();
    } finally {
      connecting = false;
      persistConversation();
      await autoScroll();
    }
  }

  /* ===== Improved past conversations UI ===== */
  let convQuery = '';
  $: filteredConversations = conversations.filter(c =>
    (c.title || '').toLowerCase().includes(convQuery.trim().toLowerCase())
  );

  function displayWhen(c: Conversation) {
    const t = c.last_message_at || c.updated_at || c.created_at;
    try { return new Date(t || Date.now()).toLocaleString() } catch { return ''; }
  }
</script>

<!-- Status + start button (small and subtle) -->
<div class="mb-2 flex items-center justify-between">
  <div class="text-xs text-gray-600 font-light">
    {#if !uploadedFileId}
      Upload & extract a zip to begin
    {:else if isDisconnected}
      Disconnected — structure not saved (read-only)
    {:else if !conversationId}
      Ready to start
    {:else}
      Connected to conversation
    {/if}
  </div>

  {#if uploadedFileId && folderSaved && !conversationId}
    <button
      class="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-black"
      on:click={startChat}>
      Start new chat
    </button>
  {/if}
</div>

<!-- CHAT CARD (light tones + bordered container) -->
<div class="rounded-2xl border border-gray-200 bg-white overflow-hidden">
  <!-- Messages -->
  <div class="max-h-[64vh] min-h-[290px] overflow-y-auto space-y-4 p-4 font-light" bind:this={streamContainer}>
    {#if !conversationId}
      <div class="py-32 text-center text-sm text-gray-500 font-light">
        {#if isDisconnected}
          Project structure is not saved. You can open a past conversation above to read its history.
        {:else}
          Start a chat to ask questions about your codebase
        {/if}
      </div>
    {:else if timeline.length === 0}
      <div class="py-32 text-center text-sm text-gray-500">No messages yet.</div>
    {:else}
      {#each timeline as row, idx}
        {#if row.kind === 'msg'}
          {#if row.role === 'user'}
            <!-- USER (left) -->
            <div class="flex items-start gap-3 justify-end">
              <div class="max-w-[78%] rounded-2xl border border-indigo-100 bg-indigo-50/50 px-4 py-2 text-[13px] text-indigo-900 shadow-sm">
                {row.content}
              </div>
              <div class="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 text-white grid place-items-center shadow ring-2 ring-indigo-100 shrink-0" aria-hidden="true">
                {@html Icon.user()}
              </div>
            </div>
          {:else}
            <!-- ASSISTANT (right) -->
            <div class="flex items-start gap-3">
              <div class="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 text-white grid place-items-center shadow ring-2 ring-emerald-100 shrink-0" aria-hidden="true">
                {@html Icon.assistant()}
              </div>
              <div class="max-w-[78%] rounded-2xl px-4 py-2 text-[13px] text-gray-900 border border-emerald-100 bg-emerald-50/50 shadow-sm">
                <div class="leading-6">
                  {@html mdToHtml(row.content)}
                </div>
              </div>
            </div>
          {/if}
        {:else}
          <!-- Activity events row -->
          <div class="relative rounded-xl border border-sky-200 bg-sky-50/50 overflow-hidden">
            {#if row.active || isThinking}
              <div class="absolute right-3 bottom-3 flex items-center gap-2 text-[11px] text-sky-700">
                <span class="w-3.5 h-3.5 border-2 border-sky-200 border-t-sky-600 rounded-full animate-spin"></span>
                processing
              </div>
            {/if}
            <ul class="divide-y">
              {#each row.events.filter(e => e.type !== 'analysis_result') as ev (ev.id)}
                <li class={`p-3 text-[13px] ${eventStripeClasses(ev.type)}`}>
                  <div class="flex items-start gap-2">
                    <div class="mt-0.5 shrink-0 text-sky-700" aria-hidden="true">
                      {@html Icon.bolt()}
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between gap-2">
                        <span class={`font-mono text-[11px] px-2 py-0.5 rounded ${eventBadgeClasses(ev.type)}`}>{ev.type}</span>
                        <span class="text-[11px] text-gray-500">{new Date(ev.time).toLocaleTimeString()}</span>
                      </div>
                      <div class="mt-1">{eventTitle(ev)}</div>
                      {#if ev.data?.summary}
                        <pre class="mt-2 text-[11px] bg-white/60 border rounded p-2 overflow-auto">{JSON.stringify(ev.data.summary, null, 2)}</pre>
                      {/if}
                      {#if ev.data?.parameters}
                        <details class="mt-2">
                          <summary class="text-xs text-gray-600 cursor-pointer">details</summary>
                          <pre class="mt-1 text-[11px] bg-white/60 border rounded p-2 overflow-auto">{JSON.stringify(ev.data.parameters, null, 2)}</pre>
                        </details>
                      {/if}
                      {#if ev.data?.error}
                        <div class="mt-2 text-xs text-rose-700 break-all">{String(ev.data.error)}</div>
                      {/if}
                    </div>
                  </div>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      {/each}
    {/if}
  </div>

  <!-- Composer -->
  <div class="p-3 border-t border-gray-200 bg-gray-50">
    <div class="flex gap-2 relative">
      <textarea
        class="flex-1 rounded-xl border border-gray-200 px-4 py-2.5 text-sm min-h-[66px] bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:bg-gray-50 disabled:text-gray-400 placeholder:text-xs"
        rows="2"
        placeholder={
          !folderSaved
            ? "To start chating upload your code Repo zip file"
            : (conversationId ? "Shift+Enter = newline • Enter = send" : "Start the chat first")
        }
        bind:value={input}
        disabled={!canChat || connecting}
        on:keydown={(e) => { if (folderSaved && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
      ></textarea>
      <button
        class="h-8 min-w-[60px] px-4 rounded-xl bg-gray-900 text-white text-sm font-medium hover:bg-black disabled:opacity-60 disabled:cursor-not-allowed self-end absolute right-2 bottom-2"
        on:click={sendMessage}
        disabled={!canChat || !input.trim() || connecting}
      >
        {connecting ? 'Sending…' : 'Send'}
      </button>
    </div>
  </div>
</div>

<!-- Past conversations -->
{#if uploadedFileId && conversations.length}
  <div class="mt-2 flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-gray-600">Past conversations</span>
      <select class="rounded-xl border border-gray-200 px-4 py-2 text-gray-600 text-xs min-w-[260px]" bind:value={selectedConversationId} placeholder="Select conversation">
        {#each conversations as c}
          <option value={c.id}>
            {(c.title || 'Conversation')} | {displayWhen(c)} | {(c.message_count ?? 0)} msgs
          </option>
        {/each}
      </select>
      <button class="px-3 py-2 rounded-xl border border-gray-200 text-gray-600 text-xs hover:bg-gray-50" on:click={openSelectedConversation}>
        Open
      </button>
    </div>
  </div>
{/if}