<script lang="ts">
  import { onMount, tick } from 'svelte';

  export let backendUrl: string;
  export let userId: string;
  export let uploadedFileId: string | null;
  export let folderSaved: boolean;
  export let initialConversations: any[] | undefined;

  type Msg = { kind: 'msg'; role: 'user' | 'assistant'; content: string; createdAt?: string };
  type StreamEvent = { id: number; type: string; time: number; data: any };
  type Activity = { kind: 'activity'; id: number; events: StreamEvent[]; active: boolean };
  type Row = Msg | Activity;

  /* conversation list types/state */
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

  // derived flags for UI/permissions
  $: canChat = !!conversationId && !!uploadedFileId && !!folderSaved;   // only true when structure exists
  $: isDisconnected = !!uploadedFileId && !folderSaved;                 // show disconnected banner

  // ---- persist conversation per (userId + uploadedFileId)
  const CONV_KEY = (u: string, fid: string) => `acr:conv:${u}:${fid}`;
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

  onMount(() => {
    hydrateConversation();
    if (!conversations.length) loadConversationList(); // lazy-load if server returned none
  });

  /* fetch list of conversations (optionally filtered by current zip) */
  async function loadConversationList() {
    try {
      const url = `${backendUrl}/chat/conversations?userId=${encodeURIComponent(userId)}${uploadedFileId ? `&zipFileId=${encodeURIComponent(uploadedFileId)}` : ''}`;
      const r = await fetch(url);
      const d = await r.json();
      if (r.ok && Array.isArray(d?.conversations)) {
        conversations = d.conversations;
        if (!selectedConversationId && conversations.length) {
          selectedConversationId = conversations[0].id;
        }
      }
    } catch { /* non-fatal */ }
  }

  /* refresh when a new zip becomes available (not gated by folderSaved) */
  let lastZipForList: string | null = null;
  $: if (uploadedFileId && uploadedFileId !== lastZipForList) {
    lastZipForList = uploadedFileId;
    loadConversationList();
  }

  async function openSelectedConversation() {
    if (!selectedConversationId) return;
    conversationId = selectedConversationId; // can open even if structure missing (read-only)
    timeline = [];
    persistConversation();
    await loadMessages();
  }

  function escapeHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function sanitizeHtml(s: string) {
    return s.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi,'').replace(/\son\w+="[^"]*"/gi,'').replace(/\son\w+='[^']*'/gi,'');
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
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer" class="underline text-blue-600">$1</a>');
    out = out.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^\*])\*(.*?)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-gray-100 border">$1</code>');
    out = out.replace(/(^|\n)(?!\s*<)([^\n][\s\S]*?)(?=\n{2,}|$)/g, (_m, pfx, block) => {
      const html = String(block).trim().replace(/\n+/g, '<br />');
      return `${pfx}<p class="my-2">${html}</p>`;
    });
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
    user: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19a6 6 0 10-6 0m6-11a3 3 0 11-6 0 3 3 0 016 0Z"/></svg>`,
    assistant: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v3m0 12v3m9-9h-3M6 12H3m13.95 5.95-2.12-2.12M8.17 8.17 6.05 6.05m11.9 0-2.12 2.12M8.17 15.83 6.05 17.95"/></svg>`,
    bolt: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M13 3L4 14h7l-1 7 9-11h-7l1-7z"/></svg>`
  };

  async function startChat() {
    if (!folderSaved || !uploadedFileId) return;
    const r = await fetch(`${backendUrl}/chat/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, zipFileId: uploadedFileId })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error || 'Failed to start chat');
    conversationId = d.conversationId;
    persistConversation();
    // add to list so it appears immediately
    conversations = [
      { id: conversationId ?? '', title: 'New chat', zip_file_id: uploadedFileId, created_at: new Date().toISOString(), message_count: 0, last_message_at: null },
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
    // hard block when structure is missing
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
              await loadMessages(); // refresh with DB times/history
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
</script>

<div class="border rounded-2xl p-5 space-y-4 bg-white">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-semibold">Code Review Chat</h2>
    <div class="text-xs text-gray-600">
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
  </div>

  <!-- Past conversations: visible even if structure is missing -->
  {#if uploadedFileId && conversations.length}
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-gray-600">Past conversations</span>
      <select class="rounded-xl border px-2 py-1 text-sm min-w-[260px]" bind:value={selectedConversationId}>
        {#each conversations as c}
          <option value={c.id}>
            {c.title || 'Conversation'} ·
            {new Date(c.last_message_at || c.created_at || Date.now()).toLocaleString()} ·
            {(c.message_count ?? 0)} msgs
          </option>
        {/each}
      </select>
      <button class="px-2 py-1 rounded-xl border text-sm hover:bg-gray-50" on:click={openSelectedConversation}>
        Open
      </button>
    </div>
  {/if}

  {#if uploadedFileId && folderSaved && !conversationId}
    <button
      class="px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-medium hover:bg-black"
      on:click={startChat}>
      Start new chat
    </button>
  {/if}

  <div class="border rounded-xl overflow-hidden">
    <div class="px-4 py-2 border-b bg-gray-50 text-sm font-medium">Conversation</div>

    <div class="max-h-[70vh] overflow-y-auto divide-y" bind:this={streamContainer}>
      {#if !conversationId}
        <div class="py-16 text-center text-sm text-gray-500">
          {#if isDisconnected}
            Project structure is not saved. You can open a past conversation above to read its history.
          {:else}
            Start a chat to ask questions about your codebase
          {/if}
        </div>
      {:else if timeline.length === 0}
        <div class="py-16 text-center text-sm text-gray-500">No messages yet.</div>
      {:else}
        {#each timeline as row, idx}
          {#if row.kind === 'msg'}
            <div class="p-4">
              <div class="flex items-start gap-3">
                <div class="shrink-0 mt-1">
                  {#if row.role === 'user'}
                    <div class="w-7 h-7 rounded-full bg-indigo-600 text-white grid place-items-center shadow ring-2 ring-indigo-200" aria-hidden="true">
                      {@html Icon.user()}
                    </div>
                  {:else}
                    <div class="w-7 h-7 rounded-full bg-emerald-600 text-white grid place-items-center shadow ring-2 ring-emerald-200" aria-hidden="true">
                      {@html Icon.assistant()}
                    </div>
                  {/if}
                </div>
                <div class="flex-1">
                  {#if row.role === 'assistant'}
                    <div class="rounded-xl border bg-emerald-50/60 border-emerald-200 p-3">
                      <div class="markdown-body text-[13px] leading-6">
                        {@html mdToHtml(row.content)}
                      </div>
                    </div>
                  {:else}
                    <div class="rounded-xl border bg-indigo-50/60 border-indigo-200 p-3 text-sm whitespace-pre-wrap">
                      {row.content}
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          {:else}
            <!-- Inline activity -->
            <div class="px-4 py-2">
              <div class="relative rounded-xl border border-sky-200 bg-sky-50/50 overflow-hidden">
                {#if row.active || isThinking}
                  <div class="absolute right-2 top-2 flex items-center gap-2 text-[11px] text-sky-700">
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
            </div>
          {/if}
        {/each}
      {/if}
    </div>

    <div class="p-3 border-t flex gap-2 items-end">
      <textarea
        class="flex-1 rounded-xl border px-3 py-2 text-sm min-h-[44px] focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:bg-gray-50 disabled:text-gray-400"
        rows="2"
        placeholder={
          !folderSaved
            ? "Project structure missing — read-only. Open a past conversation to view history."
            : (conversationId ? "Ask something about your code…" : "Start the chat first")
        }
        bind:value={input}
        disabled={!canChat || connecting}
        on:keydown={(e) => { if (folderSaved && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
      ></textarea>
      <button
        class="h-10 min-w-[92px] px-4 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-black disabled:opacity-60 disabled:cursor-not-allowed self-center"
        on:click={sendMessage}
        disabled={!canChat || !input.trim() || connecting}
      >
        {connecting ? 'Sending…' : 'Send'}
      </button>
    </div>
  </div>
</div>