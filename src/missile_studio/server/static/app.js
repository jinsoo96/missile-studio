/* missile-studio web UI: vanilla JS, no build step. Talks to /api/*, streams /api/chat as SSE. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) n.setAttribute(k, v);
    }
    for (const k of kids) if (k !== null && k !== undefined) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const md = (s) => DOMPurify.sanitize(marked.parse(String(s ?? ''), { breaks: true, gfm: true }));
  const toast = (msg, isErr) => { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 3500); };

  // ---------------------------------------------------------------- auth / api
  let token = localStorage.getItem('missile_token') || new URLSearchParams(location.search).get('token') || '';
  if (new URLSearchParams(location.search).get('token')) { localStorage.setItem('missile_token', token); history.replaceState({}, '', location.pathname); }
  const headers = () => token ? { Authorization: 'Bearer ' + token } : {};
  async function api(path, opts = {}) {
    const o = { ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers(), ...(opts.headers || {}) } };
    if (o.body && typeof o.body !== 'string' && !(o.body instanceof FormData)) o.body = JSON.stringify(o.body);
    const r = await fetch(path, o);
    if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
    if (!r.ok) { let d = ''; try { d = (await r.json()).detail; } catch { d = await r.text(); } throw new Error(typeof d === 'string' ? d : JSON.stringify(d)); }
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  }
  function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = $('#loginToken').value.trim();
    try { await api('/api/login', { method: 'POST', body: { token } }); localStorage.setItem('missile_token', token); $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); await boot(); }
    catch (err) { $('#loginErr').textContent = 'bad token'; }
  });

  // ---------------------------------------------------------------- state
  const S = { state: null, convs: [], conv: null, messages: [], streaming: false, attachments: [], abort: null, view: 'chat', editingProvider: null };

  async function loadState() { S.state = await api('/api/state'); $('#version').textContent = 'v' + S.state.version; renderHead(); renderProviders(); renderMcp(); renderTools(); renderAssistants(); renderAgents(); renderApprovals(S.state.approvals); }
  async function loadConvs() { S.convs = await api('/api/conversations'); renderConvs(); }

  // ---------------------------------------------------------------- views
  $$('.nav').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  function switchView(v) { S.view = v; $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === v)); $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v)); if (v === 'audit') loadAudit(); if (v === 'mcp') loadImportSources(); if (v !== 'chat') loadState().catch(() => {}); }

  // ---------------------------------------------------------------- chat head
  function renderHead() {
    const st = S.state; const sp = $('#selProvider'); const cur = sp.value || (S.conv && S.conv.provider_id) || st.default.provider;
    sp.innerHTML = st.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label || p.id)}</option>`).join('') || '<option value="">(no provider: add one in Providers)</option>';
    sp.value = st.providers.some((p) => p.id === cur) ? cur : (st.providers[0]?.id || '');
    renderModels();
    const sa = $('#selAssistant'); const curA = sa.value || (S.conv && S.conv.assistant_id) || st.default.assistant;
    sa.innerHTML = st.assistants.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    sa.value = st.assistants.some((a) => a.id === curA) ? curA : 'default';
  }
  function renderModels(keep) {
    const p = S.state.providers.find((x) => x.id === $('#selProvider').value); const sm = $('#selModel');
    const cur = keep || sm.value || (S.conv && S.conv.model) || (p && p.default_model) || '';
    const models = p ? [...new Set([p.default_model, ...(p.models || [])].filter(Boolean))] : [];
    sm.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m.includes('|') ? m.split('|')[1] : m)}</option>`).join('') || '<option value="">(click ⟳ to discover models)</option>';
    if (models.includes(cur)) sm.value = cur;
  }
  $('#selProvider').addEventListener('change', () => { renderModels(); persistConvTarget(); });
  $('#selModel').addEventListener('change', persistConvTarget);
  $('#selAssistant').addEventListener('change', persistConvTarget);
  async function persistConvTarget() { if (!S.conv) return; try { await api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { provider_id: $('#selProvider').value, model: $('#selModel').value, assistant_id: $('#selAssistant').value } }); } catch {} }
  $('#btnRefreshModels').addEventListener('click', async () => {
    const pid = $('#selProvider').value; if (!pid) return toast('add a provider first', true);
    try { const r = await api(`/api/providers/${encodeURIComponent(pid)}/models`, { method: 'POST' }); await loadState(); renderModels(); toast(`${r.models.length} models`); } catch (e) { toast(e.message, true); }
  });

  // ---------------------------------------------------------------- conversations
  function renderConvs() {
    const list = $('#convList'); list.innerHTML = '';
    for (const c of S.convs) {
      const item = el('div', { class: 'conv-item' + (S.conv && S.conv.id === c.id ? ' active' : ''), onclick: () => openConv(c.id) }, c.title || 'New chat', el('span', { class: 'meta' }, `${c.provider_id || ''} ${c.model ? '· ' + (c.model.includes('|') ? c.model.split('|')[1] : c.model) : ''}`));
      list.append(item);
    }
  }
  async function newConv() {
    const c = await api('/api/conversations', { method: 'POST', body: { assistant_id: $('#selAssistant').value || 'default', provider_id: $('#selProvider').value, model: $('#selModel').value } });
    await loadConvs(); await openConv(c.id); $('#input').focus();
  }
  $('#newChat').addEventListener('click', newConv);
  async function openConv(id) {
    S.conv = await api('/api/conversations/' + id); S.messages = S.conv.messages || [];
    $('#convTitle').textContent = S.conv.title || '';
    if (S.conv.provider_id && S.state.providers.some((p) => p.id === S.conv.provider_id)) { $('#selProvider').value = S.conv.provider_id; renderModels(S.conv.model); }
    if (S.conv.assistant_id) $('#selAssistant').value = S.conv.assistant_id;
    renderConvs(); renderMessages(); switchView('chat');
  }
  $('#btnDeleteConv').addEventListener('click', async () => { if (!S.conv || !confirm('Delete this conversation?')) return; await api('/api/conversations/' + S.conv.id, { method: 'DELETE' }); S.conv = null; S.messages = []; $('#messages').innerHTML = ''; $('#convTitle').textContent = ''; await loadConvs(); });

  // ---------------------------------------------------------------- messages
  function toolCard(call, result) {
    const card = el('div', { class: 'toolcall' + (result ? (result.is_error ? ' error' : ' ok') : '') });
    card.append(el('span', { class: 'tname' }, '⚙ ' + call.name), result ? el('span', { class: 'dur' }, `${result.duration_ms != null ? result.duration_ms + 'ms ' : ''}${result.decision || (result.is_error ? 'error' : 'ok')}`) : el('span', { class: 'dur' }, 'running…'));
    const args = JSON.stringify(call.arguments ?? {}, null, 0); card.append(el('pre', {}, args.length > 1200 ? args.slice(0, 1200) + '…' : args));
    if (result) { const txt = result.text || result.content || ''; card.append(el('pre', {}, String(txt).slice(0, 4000))); for (const im of result.images || []) card.append(el('img', { src: `data:${im.mime_type || 'image/png'};base64,${im.data}` })); }
    return card;
  }
  function renderMessages() {
    const box = $('#messages'); box.innerHTML = '';
    const toolResults = {}; for (const m of S.messages) if (m.role === 'tool') toolResults[m.tool_call_id] = { text: m.content, is_error: m.is_error, images: m.images };
    for (const m of S.messages) {
      if (m.role === 'tool') continue;
      const node = el('div', { class: 'msg ' + m.role }, el('div', { class: 'avatar' }, m.role === 'user' ? '🧑' : '🚀'));
      const body = el('div', { class: 'body' }); node.append(body);
      if (m.role === 'user') {
        let text = typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        const bub = el('div', { class: 'bubble' }, text); body.append(bub);
        for (const p of (Array.isArray(m.content) ? m.content : [])) if (p.type === 'image_url') bub.append(el('img', { src: p.image_url.url, style: 'max-width:280px;display:block;margin-top:6px;border-radius:6px' }));
      } else {
        if (m.thinking) body.append(el('details', { class: 'thinking-box' }, el('summary', {}, 'thinking'), el('div', { class: 'thinking' }, m.thinking)));
        if (m.content) body.append(el('div', { class: 'bubble', html: md(m.content) }));
        for (const c of m.tool_calls || []) body.append(toolCard(c, toolResults[c.id]));
        if (m.meta) body.append(el('div', { class: 'meta' }, `${m.meta.provider || ''} · ${m.meta.model || ''}`));
      }
      box.append(node);
    }
    box.scrollTop = box.scrollHeight;
  }

  // ---------------------------------------------------------------- attachments
  $('#btnAttach').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      const fd = new FormData(); fd.append('file', f);
      try { const r = await api('/api/upload', { method: 'POST', body: fd }); S.attachments.push(r); } catch (err) { toast(`${f.name}: ${err.message}`, true); }
    }
    e.target.value = ''; renderAttach();
  });
  function renderAttach() { const bar = $('#attachBar'); bar.innerHTML = ''; S.attachments.forEach((a, i) => bar.append(el('span', { class: 'chip' }, (a.data_url ? '🖼 ' : '📄 ') + a.name, el('button', { onclick: () => { S.attachments.splice(i, 1); renderAttach(); } }, '✕')))); }
  document.addEventListener('paste', async (e) => { for (const it of e.clipboardData.items) if (it.type.startsWith('image/')) { const f = it.getAsFile(); const fd = new FormData(); fd.append('file', f, 'pasted.png'); try { S.attachments.push(await api('/api/upload', { method: 'POST', body: fd })); renderAttach(); } catch (err) { toast(err.message, true); } } });

  // ---------------------------------------------------------------- send / stream
  const input = $('#input');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(220, input.scrollHeight) + 'px'; });
  $('#btnSend').addEventListener('click', send);
  $('#btnStop').addEventListener('click', async () => { if (S.conv) await api(`/api/chat/${S.conv.id}/stop`, { method: 'POST' }).catch(() => {}); if (S.abort) S.abort.abort(); });

  async function send() {
    const text = input.value.trim(); if (!text || S.streaming) return;
    if (!$('#selProvider').value) return toast('add a provider first (Providers tab)', true);
    if (!S.conv) { const c = await api('/api/conversations', { method: 'POST', body: { assistant_id: $('#selAssistant').value || 'default', provider_id: $('#selProvider').value, model: $('#selModel').value } }); S.conv = c; S.messages = []; await loadConvs(); }
    input.value = ''; input.style.height = 'auto';
    const atts = S.attachments.splice(0); renderAttach();
    const body = { conversation_id: S.conv.id, text, provider_id: $('#selProvider').value, model: $('#selModel').value, assistant_id: $('#selAssistant').value, attachments: atts, tools: $('#chkTools').checked ? null : 'none' };
    S.streaming = true; $('#btnStop').classList.remove('hidden'); $('#btnSend').disabled = true;
    // optimistic user bubble
    S.messages.push({ role: 'user', content: atts.some((a) => a.data_url) ? [{ type: 'text', text }, ...atts.filter((a) => a.data_url).map((a) => ({ type: 'image_url', image_url: { url: a.data_url } }))] : text });
    renderMessages();
    const box = $('#messages');
    let live = el('div', { class: 'msg assistant' }, el('div', { class: 'avatar' }, '🚀')); const body_ = el('div', { class: 'body' }); live.append(body_); box.append(live);
    let textBuf = '', thinkBuf = '', bubble = null, thinkEl = null, status = null; const calls = {};
    const flushText = () => { if (!bubble) { bubble = el('div', { class: 'bubble cursor' }); body_.append(bubble); } bubble.innerHTML = md(textBuf); box.scrollTop = box.scrollHeight; };
    S.abort = new AbortController();
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify(body), signal: S.abort.signal });
      if (!r.ok) throw new Error((await r.text()) || r.statusText);
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx; while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'); if (!data) continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          handleEvent(ev);
        }
      }
    } catch (e) { if (e.name !== 'AbortError') { body_.append(el('div', { class: 'toolcall error' }, 'error: ' + e.message)); } }
    finally {
      S.streaming = false; S.abort = null; $('#btnStop').classList.add('hidden'); $('#btnSend').disabled = false; if (bubble) bubble.classList.remove('cursor');
      try { await openConv(S.conv.id); await loadConvs(); } catch {}
    }
    function handleEvent(ev) {
      switch (ev.type) {
        case 'text_delta': textBuf += ev.text; flushText(); break;
        case 'thinking_delta': thinkBuf += ev.text; if (!thinkEl) { thinkEl = el('div', { class: 'thinking' }); body_.prepend(thinkEl); } thinkEl.textContent = thinkBuf; break;
        case 'tool_call': { if (bubble) bubble.classList.remove('cursor'); bubble = null; textBuf = ''; const card = toolCard(ev, null); calls[ev.id] = card; body_.append(card); box.scrollTop = box.scrollHeight; break; }
        case 'tool_result': { const card = calls[ev.id]; const nc = toolCard({ name: ev.name, arguments: card ? JSON.parse(card.querySelector('pre').textContent.replace(/…$/, '') || '{}') : {} }, ev); if (card) card.replaceWith(nc); else body_.append(nc); calls[ev.id] = nc; break; }
        case 'approval_required': renderApprovals([{ id: ev.id, name: ev.name, arguments: ev.arguments, reason: ev.reason }], true); break;
        case 'remote_tool': if (!status) { status = el('div', { class: 'status-line' }); body_.append(status); } status.textContent = `☁ ${ev.event} ${ev.name || ''}`; break;
        case 'status': if (!status) { status = el('div', { class: 'status-line' }); body_.append(status); } status.textContent = ev.event === 'max_iterations' ? 'stopped: max iterations' : `… ${ev.event}`; break;
        case 'error': body_.append(el('div', { class: 'toolcall error' }, 'error: ' + ev.message)); break;
        case 'done': if (status) status.remove(); break;
      }
    }
  }

  // ---------------------------------------------------------------- approvals
  function renderApprovals(list, append) {
    const box = $('#approvals'); if (!append) box.innerHTML = '';
    for (const a of list) {
      if ($(`[data-approval="${a.id}"]`)) continue;
      const node = el('div', { class: 'approval', 'data-approval': a.id }, el('div', {}, el('b', {}, a.name), ' wants to run. ', el('span', { class: 'hint' }, a.reason || '')), el('pre', {}, JSON.stringify(a.arguments, null, 1).slice(0, 2000)));
      const row = el('div', { class: 'row' });
      for (const [label, d, cls] of [['Allow once', 'allow', 'primary'], ['Allow for this chat', 'allow_session', ''], ['Always allow', 'allow_always', ''], ['Deny', 'deny', 'danger']]) row.append(el('button', { class: cls, onclick: async () => { await api('/api/approvals/' + a.id, { method: 'POST', body: { decision: d } }).catch((e) => toast(e.message, true)); node.remove(); } }, label));
      node.append(row); box.append(node);
    }
  }
  setInterval(async () => { if (!S.state) return; try { const p = await api('/api/approvals'); if (p.length) renderApprovals(p, true); } catch {} }, 4000);

  // ---------------------------------------------------------------- providers view
  function renderProviders() {
    const st = S.state; const list = $('#providerList'); list.innerHTML = '';
    const pp = $('#pPreset'); if (!pp.options.length) { pp.innerHTML = '<option value="">(custom)</option>' + st.presets.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join(''); }
    for (const p of st.providers) {
      const card = el('div', { class: 'card' },
        el('div', { class: 'title' }, p.label || p.id, el('span', { class: 'badge' }, p.kind), st.default.provider === p.id ? el('span', { class: 'badge acc' }, 'default') : null, p.has_key ? el('span', { class: 'badge ok' }, 'key') : (p.kind === 'openai' ? el('span', { class: 'badge' }, 'no key') : null)),
        el('div', { class: 'sub' }, `${p.id} · ${p.base_url || ''} · ${p.models.length} models · default ${p.default_model || '-'}`),
        el('div', { class: 'row' },
          el('button', { onclick: () => editProvider(p) }, 'Edit'),
          el('button', { onclick: async () => { try { const r = await api(`/api/providers/${p.id}/models`, { method: 'POST' }); toast(`${r.models.length} models`); await loadState(); } catch (e) { toast(e.message, true); } } }, 'Discover models'),
          el('button', { onclick: async () => { await api('/api/default', { method: 'POST', body: { provider: p.id, model: p.default_model } }); await loadState(); } }, 'Make default'),
          el('button', { class: 'danger', onclick: async () => { if (confirm(`Remove provider ${p.id}?`)) { await api('/api/providers/' + p.id, { method: 'DELETE' }); await loadState(); } } }, 'Remove')));
      list.append(card);
    }
    if (!st.providers.length) list.append(el('div', { class: 'hint' }, 'No providers yet. Pick a preset on the right, paste a key (or a local base URL for Ollama/vLLM/LM Studio) and Save.'));
  }
  $('#pPreset').addEventListener('change', () => { const pr = S.state.presets.find((p) => p.id === $('#pPreset').value); if (!pr) return; $('#pId').value = pr.id; $('#pLabel').value = pr.label; $('#pKind').value = pr.kind; $('#pBase').value = pr.base_url; $('#pModel').value = pr.hint && !pr.hint.startsWith('(') ? pr.hint : ''; $('#pExtra').value = pr.extra_body ? JSON.stringify(pr.extra_body) : ''; $('#agentFields').classList.toggle('hidden', pr.kind !== 'agentserver'); });
  $('#pKind').addEventListener('change', () => $('#agentFields').classList.toggle('hidden', $('#pKind').value !== 'agentserver'));
  function editProvider(p) { S.editingProvider = p.id; $('#providerFormTitle').textContent = 'Edit ' + p.id; $('#pId').value = p.id; $('#pLabel').value = p.label || ''; $('#pKind').value = p.kind; $('#pBase').value = p.base_url || ''; $('#pKey').value = ''; $('#pKey').placeholder = p.has_key ? 'saved (leave blank to keep)' : ''; $('#pKeyEnv').value = p.api_key_env || ''; $('#pModel').value = p.default_model || ''; $('#pExtra').value = Object.keys(p.extra_body || {}).length ? JSON.stringify(p.extra_body) : ''; $('#pHeaders').value = Object.keys(p.headers || {}).length ? JSON.stringify(p.headers) : ''; $('#pEmail').value = p.email || ''; $('#pPassword').value = ''; $('#agentFields').classList.toggle('hidden', p.kind !== 'agentserver'); }
  function providerBody() { let extra = {}, hdr = {}; try { extra = $('#pExtra').value ? JSON.parse($('#pExtra').value) : {}; hdr = $('#pHeaders').value ? JSON.parse($('#pHeaders').value) : {}; } catch { toast('extra body / headers must be JSON', true); throw new Error('json'); }
    const b = { id: $('#pId').value.trim(), label: $('#pLabel').value.trim(), kind: $('#pKind').value, base_url: $('#pBase').value.trim(), api_key_env: $('#pKeyEnv').value.trim(), default_model: $('#pModel').value.trim(), extra_body: extra, headers: hdr, email: $('#pEmail').value.trim() };
    if ($('#pKey').value) b.api_key = $('#pKey').value; if ($('#pPassword').value) b.password = $('#pPassword').value; if (b.default_model) b.models = [b.default_model]; return b; }
  $('#providerForm').addEventListener('submit', async (e) => { e.preventDefault(); try { const b = providerBody(); if (S.editingProvider && S.state.providers.find((p) => p.id === b.id)) { const old = S.state.providers.find((p) => p.id === b.id); b.models = [...new Set([...(b.models || []), ...(old.models || [])])]; } await api('/api/providers', { method: 'POST', body: b }); toast('saved'); S.editingProvider = null; $('#providerFormTitle').textContent = 'Add provider'; await loadState(); } catch (err) { if (err.message !== 'json') toast(err.message, true); } });
  $('#pTest').addEventListener('click', async () => { try { const b = providerBody(); $('#pTestOut').textContent = 'testing…'; const r = await api('/api/providers/test', { method: 'POST', body: b }); $('#pTestOut').textContent = r.ok ? `OK ${r.count} models in ${r.ms}ms\n` + r.models.slice(0, 60).join('\n') : 'FAIL ' + r.error; } catch (err) { if (err.message !== 'json') $('#pTestOut').textContent = err.message; } });
  $('#pCancel').addEventListener('click', () => { S.editingProvider = null; $('#providerForm').reset(); $('#providerFormTitle').textContent = 'Add provider'; $('#pTestOut').textContent = ''; });

  // ---------------------------------------------------------------- mcp view
  function renderMcp() {
    const list = $('#mcpList'); list.innerHTML = '';
    for (const s of S.state.mcp) {
      const c = s.config; const badge = s.status === 'connected' ? 'ok' : (s.status === 'failed' ? 'err' : (s.status === 'connecting' ? 'warn' : ''));
      list.append(el('div', { class: 'card' },
        el('div', { class: 'title' }, s.name, el('span', { class: 'badge ' + badge }, s.status), el('span', { class: 'badge' }, `${s.tool_count} tools`), el('span', { class: 'badge' }, c.transport)),
        el('div', { class: 'sub' }, c.transport === 'stdio' ? [c.command, ...(c.args || [])].join(' ') : c.url),
        s.error ? el('div', { class: 'err' }, s.error.slice(0, 300)) : null,
        el('div', { class: 'row' },
          el('button', { onclick: () => editMcp(s.name, c) }, 'Edit'),
          el('button', { onclick: async () => { await api(`/api/mcp/${encodeURIComponent(s.name)}/restart`, { method: 'POST' }); toast('restarting'); setTimeout(loadState, 1500); } }, 'Restart'),
          el('button', { onclick: async () => { await api('/api/mcp', { method: 'POST', body: { name: s.name, config: { ...c, enabled: !c.enabled } } }); setTimeout(loadState, 800); } }, c.enabled ? 'Disable' : 'Enable'),
          el('button', { class: 'danger', onclick: async () => { if (confirm(`Remove ${s.name}?`)) { await api('/api/mcp/' + encodeURIComponent(s.name), { method: 'DELETE' }); await loadState(); } } }, 'Remove'))));
    }
    if (!S.state.mcp.length) list.append(el('div', { class: 'hint' }, 'No MCP servers. Add one on the right or import from Claude Code / Claude Desktop / Cursor below.'));
  }
  async function loadImportSources() { try { const src = await api('/api/mcp/import/sources'); const box = $('#importSources'); box.innerHTML = ''; for (const s of src) box.append(el('div', { class: 'card' }, el('div', { class: 'title' }, s.source, el('span', { class: 'badge ' + (s.available ? 'ok' : '') }, s.available ? `${s.servers.length} servers` : 'not found')), el('div', { class: 'sub' }, s.available ? s.servers.join(', ') : s.paths.join(' | ')), s.available ? el('div', { class: 'row' }, el('button', { onclick: async () => { const r = await api('/api/mcp/import', { method: 'POST', body: { source: s.source } }); toast(`imported ${r.added.length}`); setTimeout(loadState, 1000); } }, 'Import all')) : null)); } catch {} }
  $('#btnImportJson').addEventListener('click', async () => { try { const r = await api('/api/mcp/import', { method: 'POST', body: { source: 'json', json_text: $('#importJson').value } }); toast(`imported ${r.added.length}`); setTimeout(loadState, 1000); } catch (e) { toast(e.message, true); } });
  $('#mTransport').addEventListener('change', () => { const t = $('#mTransport').value; $('#mStdio').classList.toggle('hidden', t !== 'stdio'); $('#mHttp').classList.toggle('hidden', t === 'stdio'); });
  function editMcp(name, c) { $('#mcpFormTitle').textContent = 'Edit ' + name; $('#mName').value = name; $('#mTransport').value = c.transport; $('#mTransport').dispatchEvent(new Event('change')); $('#mCommand').value = c.command || ''; $('#mArgs').value = (c.args || []).join('\n'); $('#mEnv').value = Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'); $('#mCwd').value = c.cwd || ''; $('#mUrl').value = c.url || ''; $('#mHeaders').value = Object.entries(c.headers || {}).map(([k, v]) => `${k}=${v}`).join('\n'); $('#mEnabled').checked = c.enabled !== false; }
  const kv = (txt) => Object.fromEntries(txt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  $('#mcpForm').addEventListener('submit', async (e) => { e.preventDefault(); const t = $('#mTransport').value; const cfg = { transport: t, enabled: $('#mEnabled').checked, command: $('#mCommand').value.trim(), args: $('#mArgs').value.split('\n').map((s) => s.trim()).filter(Boolean), env: kv($('#mEnv').value), cwd: $('#mCwd').value.trim(), url: $('#mUrl').value.trim(), headers: kv($('#mHeaders').value) }; try { await api('/api/mcp', { method: 'POST', body: { name: $('#mName').value.trim(), config: cfg } }); toast('saved, connecting…'); $('#mcpFormTitle').textContent = 'Add MCP server'; setTimeout(loadState, 1500); setTimeout(loadState, 6000); } catch (err) { toast(err.message, true); } });
  $('#mCancel').addEventListener('click', () => { $('#mcpForm').reset(); $('#mcpFormTitle').textContent = 'Add MCP server'; });

  // ---------------------------------------------------------------- tools view
  function renderTools() {
    const st = S.state; $('#polDefault').value = st.policy.default; $('#polRO').value = st.policy.read_only_default;
    $('#btWorkspace').value = st.builtin_tools.workspace || ''; $('#btWorkspace').placeholder = st.builtin_tools.workspace_resolved; $('#btShell').checked = st.builtin_tools.shell; $('#btFs').checked = st.builtin_tools.filesystem; $('#btWeb').checked = st.builtin_tools.web;
    const tb = $('#toolTable tbody'); tb.innerHTML = '';
    for (const t of st.tools) {
      const sel = el('select', { onchange: async (e) => { const rules = { ...st.policy.rules }; if (e.target.value) rules[t.full_name] = e.target.value; else delete rules[t.full_name]; await api('/api/policy', { method: 'PUT', body: { ...st.policy, rules } }); st.policy.rules = rules; toast('policy saved'); } }, el('option', { value: '' }, '(default)'), el('option', { value: 'allow' }, 'allow'), el('option', { value: 'ask' }, 'ask'), el('option', { value: 'block' }, 'block'));
      sel.value = st.policy.rules[t.full_name] || '';
      tb.append(el('tr', {}, el('td', { class: 'mono' }, t.full_name), el('td', {}, t.server), el('td', {}, (t.read_only ? 'read-only ' : '') + (t.destructive ? 'destructive' : '')), el('td', {}, sel), el('td', {}, (t.description || '').slice(0, 160))));
    }
  }
  $('#btnSavePolicy').addEventListener('click', async () => { try { await api('/api/policy', { method: 'PUT', body: { ...S.state.policy, default: $('#polDefault').value, read_only_default: $('#polRO').value } }); await api('/api/builtin-tools', { method: 'PUT', body: { shell: $('#btShell').checked, filesystem: $('#btFs').checked, web: $('#btWeb').checked, workspace: $('#btWorkspace').value.trim() } }); toast('saved'); await loadState(); } catch (e) { toast(e.message, true); } });

  // ---------------------------------------------------------------- assistants view
  function renderAssistants() {
    const st = S.state; const list = $('#assistantList'); list.innerHTML = '';
    $('#aProvider').innerHTML = '<option value="">(default)</option>' + st.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label || p.id)}</option>`).join('');
    for (const a of st.assistants) list.append(el('div', { class: 'card' }, el('div', { class: 'title' }, a.name, el('span', { class: 'badge' }, a.id), st.default.assistant === a.id ? el('span', { class: 'badge acc' }, 'default') : null), el('div', { class: 'sub' }, `${a.provider || '-'} / ${a.model || '-'} · tools ${Array.isArray(a.tools) ? a.tools.join(', ') : a.tools}`), el('div', { class: 'hint' }, (a.system_prompt || '').slice(0, 200)), el('div', { class: 'row' }, el('button', { onclick: () => { $('#aId').value = a.id; $('#aName').value = a.name; $('#aSystem').value = a.system_prompt || ''; $('#aProvider').value = a.provider || ''; $('#aModel').value = a.model || ''; $('#aTools').value = Array.isArray(a.tools) ? a.tools.join(', ') : a.tools; $('#aIter').value = a.max_iterations || 25; } }, 'Edit'), el('button', { onclick: async () => { await api('/api/default', { method: 'POST', body: { assistant: a.id } }); await loadState(); } }, 'Make default'), a.id !== 'default' ? el('button', { class: 'danger', onclick: async () => { await api('/api/assistants/' + a.id, { method: 'DELETE' }); await loadState(); } }, 'Remove') : null)));
  }
  $('#assistantForm').addEventListener('submit', async (e) => { e.preventDefault(); const tv = $('#aTools').value.trim(); const tools = !tv || tv === 'all' ? 'all' : (tv === 'none' ? 'none' : tv.split(',').map((s) => s.trim()).filter(Boolean)); try { await api('/api/assistants', { method: 'POST', body: { id: $('#aId').value.trim(), name: $('#aName').value.trim(), system_prompt: $('#aSystem').value, provider: $('#aProvider').value, model: $('#aModel').value.trim(), tools, max_iterations: parseInt($('#aIter').value || '25', 10) } }); toast('saved'); await loadState(); } catch (err) { toast(err.message, true); } });
  $('#aCancel').addEventListener('click', () => $('#assistantForm').reset());

  // ---------------------------------------------------------------- agent server view
  function renderAgents() {
    const xs = S.state.providers.filter((p) => p.kind === 'agentserver'); const sel = $('#xProvider'); const cur = sel.value;
    sel.innerHTML = xs.map((p) => `<option value="${esc(p.id)}">${esc(p.label || p.id)} (${esc(p.base_url)})</option>`).join('') || '<option value="">(add an agent server provider first)</option>'; if (xs.some((p) => p.id === cur)) sel.value = cur;
    const box = $('#xBridgeStatus'); box.innerHTML = '';
    for (const b of S.state.bridges) box.append(el('div', { class: 'card' }, el('div', { class: 'title' }, 'bridge ' + b.provider_id, el('span', { class: 'badge ' + (b.status === 'connected' ? 'ok' : (b.status === 'connecting' ? 'warn' : 'err')) }, b.status), el('span', { class: 'badge' }, `${b.tool_count} tools`), el('span', { class: 'badge' }, `${b.calls} calls`)), el('div', { class: 'sub' }, `${b.device_name} · ${b.device_id}`), b.error ? el('div', { class: 'err' }, b.error) : null));
    if (!S.state.bridges.length) box.append(el('div', { class: 'hint' }, 'Bridge not running.'));
  }
  $('#xListAgents').addEventListener('click', async () => { const pid = $('#xProvider').value; if (!pid) return; const box = $('#xAgents'); box.innerHTML = 'loading…'; try { const ag = await api(`/api/agents/${pid}`); box.innerHTML = ''; for (const a of ag) box.append(el('div', { class: 'card' }, el('div', { class: 'title' }, a.name, el('span', { class: 'badge' }, a.owner)), el('div', { class: 'sub' }, a.id), el('div', { class: 'row' }, el('button', { class: 'primary', onclick: async () => { const p = S.state.providers.find((x) => x.id === pid); const model = `${a.id}|${a.name}`; await api('/api/providers', { method: 'POST', body: { id: pid, default_model: model, models: [...new Set([model, ...(p.models || [])])] } }); await loadState(); $('#selProvider').value = pid; renderModels(model); toast(`chat now uses ${a.name}`); switchView('chat'); } }, 'Chat with this agent')))); if (!ag.length) box.textContent = 'no agents'; } catch (e) { box.textContent = e.message; } });
  $('#xBridgeStart').addEventListener('click', async () => { const pid = $('#xProvider').value; if (!pid) return; try { await api('/api/bridge/start', { method: 'POST', body: { provider_id: pid, trust: $('#xTrust').checked } }); toast('bridge starting'); setTimeout(loadState, 1500); setTimeout(loadState, 5000); } catch (e) { toast(e.message, true); } });
  $('#xBridgeStop').addEventListener('click', async () => { const pid = $('#xProvider').value; await api('/api/bridge/stop', { method: 'POST', body: { provider_id: pid } }); await loadState(); });

  // ---------------------------------------------------------------- audit
  async function loadAudit() { try { const rows = await api('/api/audit?limit=300'); const tb = $('#auditTable tbody'); tb.innerHTML = ''; for (const r of rows) tb.append(el('tr', {}, el('td', {}, new Date(r.ts * 1000).toLocaleString()), el('td', { class: 'mono' }, r.tool), el('td', {}, el('span', { class: 'badge ' + (r.is_error ? 'err' : (r.decision === 'allow' ? 'ok' : 'warn')) }, r.decision + (r.is_error ? ' · error' : ''))), el('td', {}, r.duration_ms), el('td', { class: 'mono' }, (r.arguments || '').slice(0, 200)), el('td', { class: 'mono' }, (r.result_excerpt || '').slice(0, 200)))); } catch (e) { toast(e.message, true); } }
  $('#btnAuditRefresh').addEventListener('click', loadAudit);

  // ---------------------------------------------------------------- boot
  async function boot() {
    try { const h = await fetch('/api/health').then((r) => r.json()); if (h.auth_required && !token) return showLogin(); }
    catch { }
    try { await loadState(); await loadConvs(); if (S.convs.length) await openConv(S.convs[0].id); }
    catch (e) { if (e.message !== 'unauthorized') toast(e.message, true); return; }
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    setInterval(() => { if (S.view === 'mcp' || S.view === 'agents') loadState().catch(() => {}); }, 5000);
  }
  boot();
})();
