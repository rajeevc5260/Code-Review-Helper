<script lang="ts">
  import { onMount, tick } from 'svelte';

  /*** PROPS ***/
  export let backendUrl: string;
  export let userId: string;
  export let nsEndpoint: string = '/document-analyser?ns=1';
  export let maxSnippetsDefault: number = 10;

  export let uploadedFileId: string | null = null;
  export let initialConversations: any[] | undefined = undefined;
  export let chatTitle: string | undefined = undefined;

  /*** TYPES ***/
  type Msg = { kind: 'msg'; role: 'user' | 'assistant'; content: string; createdAt?: string };
  type StreamEvent = { id: number; type: 'analyse_started' | 'processing' | 'result' | string; time: number; data: any };
  type Activity = { kind: 'activity'; id: number; events: StreamEvent[]; active: boolean };
  type Row = Msg | Activity;

  type EvidenceItem = { idx: number; snippet: string; fileId: string | null; fileName: string | null };
  type FileItem = { id: string; name: string };

  type Conversation = {
    id: string;
    title?: string;
    doc_file_id?: string;
    created_at?: string;
    updated_at?: string;
    last_message_at?: string | null;
    message_count?: number;
  };

  /*** STATE ***/
  // retrieval namespace
  let namespaceId: string | null = null;
  let nsError: string | null = null;

  // conversations
  let conversations: Conversation[] = Array.isArray(initialConversations) ? initialConversations : [];
  let selectedConversationId: string | null = conversations[0]?.id ?? null;
  let conversationId: string | null = null;

  // timeline + streaming
  let timeline: Row[] = [];
  let streamContainer: HTMLDivElement | null = null;

  let query = '';
  let connecting = false;

  let activeActivityIdx: number | null = null;
  let currentActivityId: number | null = null;
  let seenEventTypes = new Set<string>();
  let evtId = 0;
  let assistantDraft = '';

  let isThinking = false;
  const THINKING_START = new Set(['analyse_started','processing']);
  const THINKING_STOP  = new Set(['result','error']);

  // RHS panel
  let resultText = '';
  let evidence: EvidenceItem[] = [];
  let files: FileItem[] = [];

  // signed URL cache
  const urlCache = new Map<string, string>();
  const fetchingId = new Set<string>();

  const maxSnippets = maxSnippetsDefault;

  /*** PERSISTENCE KEYS (per-user, per-doc) ***/
  const CONV_KEY = (u: string, fid: string) => `adr:conv:${u}:${fid}`;
  const SEL_KEY  = (u: string, fid: string) => `adr:convsel:${u}:${fid}`;

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

  /*** INIT ***/
  onMount(async () => {
    try {
      const r = await fetch(nsEndpoint);
      const d = await r.json();
      if (!r.ok || !d?.namespaceId) throw new Error(d?.error || 'Failed to resolve namespace id');
      namespaceId = d.namespaceId;
    } catch (e: any) {
      nsError = String(e?.message || e);
    }

    hydrateConversation();
    if (!conversations.length) loadConversationList();
  });

  // refresh convo list when doc changes
  let lastDocForList: string | null = null;
  $: if (uploadedFileId && uploadedFileId !== lastDocForList) {
    lastDocForList = uploadedFileId;
    loadConversationList();
  }

  /* HARD RESET when a different doc id is passed */
  let lastDocSeen: string | null = null;
  $: if ((uploadedFileId ?? null) !== lastDocSeen) {
    lastDocSeen = uploadedFileId ?? null;
    timeline = [];
    resultText = '';
    files = [];
    evidence = [];
    conversationId = null;
    selectedConversationId = null;
    assistantDraft = '';
    query = '';
    connecting = false;
    activeActivityIdx = null;
    currentActivityId = null;
    seenEventTypes.clear();
    isThinking = false;

    if (uploadedFileId) {
      hydrateConversation();
    } else {
      conversations = [];
    }
  }

  /*** CONVERSATIONS ***/
  async function loadConversationList() {
    if (!userId) return;
    try {
      const qp = uploadedFileId ? `&docFileId=${encodeURIComponent(uploadedFileId)}` : '';
      const url = `${backendUrl}/doc-chat/conversations?userId=${encodeURIComponent(userId)}${qp}`;
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

  async function startChat() {
    if (!uploadedFileId) return;
    const r = await fetch(`${backendUrl}/doc-chat/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        docFileId: uploadedFileId,
        title: (chatTitle || '').trim() || undefined
      })
    });
    const d = await r.json();
    if (!r.ok || !d?.conversationId) throw new Error(d?.error || 'Failed to start chat');
    conversationId = d.conversationId;
    persistConversation();

    conversations = [
      {
        id: conversationId ?? '',
        title: (chatTitle || '').trim() || 'New chat',
        doc_file_id: uploadedFileId,
        created_at: new Date().toISOString(),
        message_count: 0,
        last_message_at: null
      },
      ...conversations
    ];
    selectedConversationId = conversationId;
    await loadMessages();
  }

  async function openSelectedConversation() {
    if (!selectedConversationId) return;
    conversationId = selectedConversationId;
    timeline = [];
    persistConversation();
    await loadMessages();
  }

  async function loadMessages() {
    if (!conversationId) return;
    try {
      const r = await fetch(`${backendUrl}/doc-chat/${conversationId}/messages`);
      const d = await r.json();
      const msgs: Msg[] = Array.isArray(d?.messages)
        ? d.messages.map((m:any) => ({ kind:'msg', role: m.role, content: m.content, createdAt: m.createdAt }))
        : [];
      timeline = msgs;
      await autoScroll();
    } catch {}
  }

  /*** UI HELPERS ***/
  function escapeHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function sanitizeHtml(s: string) {
    return s.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi,'')
            .replace(/\son\w+="[^"]*"/gi,'')
            .replace(/\son\w+='[^']*'/gi,'');
  }

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
    return html.replace(/<a\s+([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi, (_m, pre, href, post) => {
      if (!isDownloadUrl(href)) return _m;
      const name = fileNameFromUrl(href);
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
    return sanitizeHtml(enhanceDownloadButtons(out.trim()));
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
      case 'analyse_started': return d.message || 'Starting analysis';
      case 'processing': return d.message || 'Processing…';
      case 'result': return d.message ? 'Result ready' : 'Result';
      default: return d.message || ev.type;
    }
  }

  function eventBadgeClasses(t: string) {
    if (t.includes('error')) return 'bg-rose-100 text-rose-800 border border-rose-200';
    if (t === 'result') return 'bg-emerald-100 text-emerald-800 border border-emerald-200';
    if (t === 'analyse_started') return 'bg-sky-100 text-sky-800 border border-sky-200';
    if (t === 'processing') return 'bg-amber-100 text-amber-900 border-amber-200';
    return 'bg-gray-100 text-gray-800 border-gray-200';
  }
  function eventStripeClasses(t: string) {
    if (t.includes('error')) return 'border-rose-300 bg-rose-50/60';
    if (t === 'result') return 'border-emerald-300 bg-emerald-50/60';
    if (t === 'analyse_started') return 'border-sky-300 bg-sky-50/60';
    if (t === 'processing') return 'border-amber-300 bg-amber-50/60';
    return 'border-gray-300 bg-gray-50/60';
  }

  const Icon = {
    user: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 1116 0v1H4v-1z"/></svg>`,
    assistant: () => `<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 640 640"><path fill="#ffffff" d="M264 64C227.4 64 196.5 88.6 187 122.1C139.6 131.8 104 173.7 104 224C104 235.3 105.8 246.2 109.1 256.3C86.4 275.4 72 304 72 336C72 359.7 80 381.6 93.3 399.1C89.8 409.5 88 420.5 88 432C88 486 129.2 530.5 181.9 535.5C197.5 559.8 224.8 576 256 576C281.2 576 304 565.4 320 548.4C336 565.4 358.8 576 384 576C415.1 576 442.4 559.8 458.1 535.5C510.8 530.4 552 486 552 432C552 420.5 550.1 409.5 546.7 399.1C560.1 381.6 568 359.7 568 336C568 304 553.5 275.4 530.9 256.3C534.2 246.1 536 235.2 536 224C536 173.7 500.4 131.8 453 122.1C443.5 88.6 412.6 64 376 64C354.2 64 334.4 72.7 320 86.9C305.6 72.8 285.8 64 264 64z"/></svg>`,
    bolt: () => `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M13 3L4 14h7l-1 7 9-11h-7l1-7z"/></svg>`
  };

  /*** TIMELINE HELPERS ***/
  async function addUserMessage(text: string) {
    timeline = [...timeline, { kind:'msg', role:'user', content: text }];
    await autoScroll();
  }
  function beginActivityRow() {
    const act: Activity = { kind: 'activity', id: Date.now() + Math.random(), events: [], active: true };
    timeline = [...timeline, act];
    activeActivityIdx = timeline.length - 1;
    currentActivityId = act.id;
    seenEventTypes = new Set();
  }
  function addEventToActive(type: string, raw: any) {
    if (activeActivityIdx === null) return;
    if (type === 'analyse_started' || type === 'processing') {
      if (seenEventTypes.has(type)) return;
      seenEventTypes.add(type);
    }
    const clean = scrub(raw);
    const ev: StreamEvent = { id: evtId++, type, time: Date.now(), data: clean };
    const row = timeline[activeActivityIdx] as Activity;
    row.events = [...row.events, ev];
    timeline = timeline.map((r, idx) => (idx === activeActivityIdx ? row : r));
    if (THINKING_START.has(type)) isThinking = true;
    if (THINKING_STOP.has(type))  isThinking = false;
  }
  function removeActiveActivityRow() {
    if (currentActivityId === null) return;
    timeline = timeline.filter(r => !(r.kind === 'activity' && (r as Activity).id === currentActivityId));
    activeActivityIdx = null;
    currentActivityId = null;
    seenEventTypes.clear();
    isThinking = false;
  }

  /*** SEND QUERY ***/
  async function runAnalysis() {
    if (!namespaceId) return;
    if (!conversationId || !uploadedFileId) return;
    const q = query.trim();
    if (q.length < 1 || connecting) return;

    files = [];
    evidence = [];
    resultText = '';
    assistantDraft = '';

    await addUserMessage(q);
    beginActivityRow();
    connecting = true;

    try {
      const res = await fetch(`${backendUrl}/ai/docs-analyzer/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespaceId,
          query: q,
          maxSnippets,
          userId,
          docFileId: uploadedFileId,
          conversationId,
          chatTitle
        })
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
          else if (parsed?.type === 'data') { try { curData = JSON.parse(parsed.value); } catch { curData = { message: parsed.value, ts: Date.now() }; } }
          else if (line === '' && curEvent && curData) {
            if (curEvent === 'result') {
              const msg = (curData?.message ?? '').trim();
              resultText = msg;
              files = Array.isArray(curData?.files) ? curData.files : [];
              evidence = Array.isArray(curData?.evidence) ? curData.evidence : [];
              assistantDraft = msg || 'No answer was generated.';
              addEventToActive('result', { ok: true, files: files.length, evidence: evidence.length });

              removeActiveActivityRow();

              timeline = [...timeline, { kind:'msg', role:'assistant', content: assistantDraft }];
              await loadMessages();
              await autoScroll();
            } else {
              addEventToActive(curEvent, curData);
            }
            curEvent = null; curData = null;
            await autoScroll();
          }
        }
      }
    } catch (e) {
      addEventToActive('error', { message: String((e as any)?.message || e) });
      removeActiveActivityRow();
      timeline = [...timeline, { kind:'msg', role:'assistant', content: `**Error:** ${(e as any)?.message || e}` }];
      await loadMessages();
      await autoScroll();
    } finally {
      connecting = false;
      persistConversation();
    }
  }

  /*** FILE ACTIONS ***/
  async function openFile(id: string) {
    if (urlCache.has(id)) {
      const url = urlCache.get(id)!;
      window.open(url, '_blank', 'noreferrer');
      return;
    }
    if (fetchingId.has(id)) return;
    fetchingId.add(id);
    try {
      const r = await fetch(`/document-analyser?id=${encodeURIComponent(id)}`);
      const d = await r.json();
      if (!r.ok || !d?.url) throw new Error(d?.error || 'Failed to get URL');
      urlCache.set(id, d.url);
      window.open(d.url, '_blank', 'noreferrer');
    } catch (e: any) {
      alert(`Unable to fetch download URL: ${e?.message || e}`);
    } finally {
      fetchingId.delete(id);
    }
  }

  /*** INPUT UX ***/
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runAnalysis();
    }
  }

  // computed flags
  $: canChat = !!conversationId && !!uploadedFileId;
</script>

<!-- STATUS + START BUTTON -->
<div class="mb-2 flex items-center justify-between">
  <div class="text-xs text-gray-600 font-light">
    {#if nsError}
      <span class="text-rose-600">Namespace error:</span> {nsError}
    {:else if !namespaceId}
      Resolving namespace…
    {:else if !uploadedFileId}
      Upload a document to begin
    {:else if !conversationId}
      Ready to start
    {:else}
      Connected to conversation
    {/if}
  </div>

  {#if uploadedFileId && !conversationId}
    <button
      class="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-black"
      on:click={startChat}>
      Start new chat
    </button>
  {/if}
</div>

<!-- LAYOUT -->
<div class="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-3">
  <!-- CHAT -->
  <div class="rounded-2xl border border-gray-200 bg-white overflow-hidden">
    <div class="max-h-[64vh] min-h-[290px] overflow-y-auto space-y-4 p-4 font-light" bind:this={streamContainer}>
      {#if !conversationId}
        <div class="py-24 text-center text-sm text-gray-500 font-light">
          Start a chat to ask questions about the uploaded document.
        </div>
      {:else if timeline.length === 0}
        <div class="py-24 text-center text-sm text-gray-500 font-light">No messages yet.</div>
      {:else}
        {#each timeline as row, idx}
          {#if row.kind === 'msg'}
            {#if row.role === 'user'}
              <div class="flex items-start gap-3 justify-end">
                <div class="max-w-[78%] rounded-2xl border border-indigo-100 bg-indigo-50/50 px-4 py-2 text-[13px] text-indigo-900 shadow-sm">
                  {row.content}
                </div>
                <div class="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 text-white grid place-items-center shadow ring-2 ring-indigo-100 shrink-0" aria-hidden="true">
                  {@html Icon.user()}
                </div>
              </div>
            {:else}
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
            <div class="relative rounded-xl border border-sky-200 bg-sky-50/50 overflow-hidden">
              {#if row.active || isThinking}
                <div class="absolute right-3 bottom-3 flex items-center gap-2 text-[11px] text-sky-700">
                  <span class="w-3.5 h-3.5 border-2 border-sky-200 border-t-sky-600 rounded-full animate-spin"></span>
                  processing
                </div>
              {/if}
              <ul class="divide-y">
                {#each row.events as ev (ev.id)}
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
                        {#if ev.data?.message && ev.type !== 'result'}
                          <div class="mt-1 text-[12px] text-gray-700">{ev.data.message}</div>
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
          placeholder={conversationId ? "Shift+Enter = newline • Enter = send" : "Start the chat first"}
          bind:value={query}
          on:keydown={onKey}
          disabled={!canChat || connecting}
        ></textarea>

        <button
          class="h-8 min-w-[60px] px-4 rounded-xl bg-gray-900 text-white text-sm font-medium hover:bg-black disabled:opacity-60 disabled:cursor-not-allowed absolute right-2 bottom-2"
          on:click={runAnalysis}
          disabled={!canChat || !query.trim() || connecting}
        >
          {connecting ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  </div>

  <!-- RHS (Files + Evidence) -->
  <aside class="lg:sticky lg:top-2 space-y-3">
    <div class="rounded-2xl border border-gray-200 bg-white p-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-medium text-gray-900">Files ({files.length})</h3>
        <span class="text-[11px] text-gray-500">from search</span>
      </div>
      {#if !files.length}
        <div class="text-xs text-gray-500 py-8 text-center">No files yet. Ask something first.</div>
      {:else}
        <div class="mt-2 max-h-[22vh] overflow-y-auto pr-1">
          <ul class="divide-y">
            {#each files as f}
              <li class="py-2 flex items-start gap-2">
                <div class="i w-6 h-6 rounded bg-emerald-50 border border-emerald-100 text-emerald-700 grid place-items-center text-[11px]">F</div>
                <div class="min-w-0 flex-1">
                  <div class="text-xs text-gray-900 truncate">{f.name}</div>
                  <div class="mt-1">
                    <button
                      class="inline-flex items-center gap-2 text-[11px] px-2 py-1 rounded border border-gray-200 hover:bg-gray-50"
                      on:click={() => openFile(f.id)}
                      disabled={fetchingId.has(f.id)}
                      title="Get signed link"
                    >
                      {#if fetchingId.has(f.id)}
                        <span class="w-3 h-3 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin"></span>
                      {:else}
                        <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"/></svg>
                      {/if}
                      Download
                    </button>
                  </div>
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>

    <div class="rounded-2xl border border-gray-200 bg-white p-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-medium text-gray-900">Evidence ({evidence.length})</h3>
        <span class="text-[11px] text-gray-500">[#index]</span>
      </div>
      {#if !evidence.length}
        <div class="text-xs text-gray-500 py-8 text-center">Citations appear after the first answer.</div>
      {:else}
        <div class="mt-2 max-h-[64vh] overflow-y-auto pr-1 space-y-2">
          {#each evidence as ev}
            <div class="rounded-lg border border-gray-200 p-2">
              <div class="flex items-baseline justify-between gap-2">
                <span class="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gray-50 border border-gray-200 text-gray-700">#{ev.idx}</span>
                {#if ev.fileName}
                  <span class="text-[11px] text-gray-500 truncate">{ev.fileName}</span>
                {/if}
              </div>
              <div class="mt-1 text-[12px] text-gray-800 leading-5">{ev.snippet}</div>
              <div class="mt-2 flex items-center gap-2">
                {#if ev.fileId}
                  <button class="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border border-gray-200 hover:bg-gray-50" on:click={() => openFile(ev.fileId!)}>
                    <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16"/></svg>
                    Open file
                  </button>
                {/if}
                <button class="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border border-gray-200 hover:bg-gray-50" on:click={() => navigator.clipboard.writeText(ev.snippet)}>
                  <svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7h8a2 2 0 012 2v9a2 2 0 01-2 2H8a2 2 0 01-2-2V9a2 2 0 012-2z"/><path stroke-linecap="round" stroke-linejoin="round" d="M16 7V5a2 2 0 00-2-2H9a2 2 0 00-2 2v2"/></svg>
                  Copy
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </aside>
</div>

<!-- Past conversations -->
{#if uploadedFileId && conversations.length}
  <div class="mt-2 flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-gray-600">Past conversations</span>
      <select class="rounded-xl border border-gray-200 px-4 py-2 text-gray-600 text-xs min-w-[260px]" bind:value={selectedConversationId} placeholder="Select conversation">
        {#each conversations as c}
          <option value={c.id}>
            {(c.title || 'Conversation')} | {(c.message_count ?? 0)} msgs
          </option>
        {/each}
      </select>
      <button class="px-3 py-2 rounded-xl border border-gray-200 text-gray-600 text-xs hover:bg-gray-50" on:click={openSelectedConversation}>
        Open
      </button>
    </div>
  </div>
{/if}