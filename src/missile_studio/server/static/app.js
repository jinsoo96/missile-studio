/* missile-studio web UI v2. Vanilla JS, no build step. Shell = icon rail + list pane + main. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k === 'style') n.style.cssText = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const I = (name, cls) => window.icon(name, cls);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const md = (s) => DOMPurify.sanitize(marked.parse(String(s ?? ''), { breaks: true, gfm: true }));
  const fmtMs = (ms) => ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const rel = (ts) => { const d = Date.now() / 1000 - ts; if (d < 60) return 'just now'; if (d < 3600) return `${Math.floor(d / 60)}m ago`; if (d < 86400) return `${Math.floor(d / 3600)}h ago`; return new Date(ts * 1000).toLocaleDateString(); };
  const initials = (s) => (s || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const avatarStyle = (s) => `background: hsl(${hue(s)} 55% 48%)`;
  const shortModel = (m) => (m || '').includes('|') ? m.split('|')[1] : m || '';

  // ---------------------------------------------------------------- toast / modal / menu
  let toastTimer;
  function toast(msg, isErr) { $('.toast')?.remove(); const t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, msg); document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3200); }
  function modal({ title, body, footer, wide }) {
    const bd = el('div', { class: 'backdrop', onclick: (e) => { if (e.target === bd) close(); } });
    const m = el('div', { class: 'modal', style: wide ? 'width:min(900px,100%)' : '' },
      el('header', {}, el('h3', {}, title), el('span', { class: 'spacer' }), el('button', { class: 'btn quiet icon sm', onclick: () => close(), 'aria-label': 'close' }, I('x', 'sm'))),
      el('div', { class: 'body' }, body), footer ? el('footer', {}, footer) : null);
    bd.append(m); $('#layer').append(bd);
    function close() { bd.remove(); document.removeEventListener('keydown', esc_); }
    const esc_ = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc_);
    return { close, root: m };
  }
  function confirmDialog(text, okLabel = 'Delete') {
    return new Promise((res) => {
      const m = modal({ title: 'Are you sure?', body: el('p', { style: 'margin:0' }, text), footer: [el('button', { class: 'btn', onclick: () => { m.close(); res(false); } }, 'Cancel'), el('button', { class: 'btn danger', onclick: () => { m.close(); res(true); } }, okLabel)] });
    });
  }
  function menu(anchor, items, { searchable = false, onPick } = {}) {
    $('.menu')?.remove();
    const r = anchor.getBoundingClientRect();
    const m = el('div', { class: 'menu', style: `left:${Math.min(r.left, window.innerWidth - 440)}px; top:${r.bottom + 6}px` });
    let list;
    const render = (q = '') => {
      list.innerHTML = '';
      const ql = q.toLowerCase();
      for (const it of items) {
        if (it.group) { if (!q) list.append(el('div', { class: 'mgroup' }, it.group)); continue; }
        if (ql && !(it.label + ' ' + (it.sub || '')).toLowerCase().includes(ql)) continue;
        list.append(el('div', { class: 'mitem' + (it.selected ? ' sel' : ''), onclick: () => { m.remove(); onPick(it); } }, it.icon ? I(it.icon, 'sm') : null, el('span', { class: 'truncate' }, it.label), it.sub ? el('span', { class: 'sub' }, it.sub) : null, it.selected ? I('check', 'sm') : null));
      }
      if (!list.children.length) list.append(el('div', { class: 'mitem muted' }, 'no matches'));
    };
    if (searchable) { const inp = el('input', { class: 'input', placeholder: 'Search…', oninput: () => render(inp.value) }); m.append(el('div', { class: 'msearch' }, inp)); setTimeout(() => inp.focus(), 0); }
    list = el('div'); m.append(list); render();
    document.body.append(m);
    const off = (e) => { if (!m.contains(e.target) && e.target !== anchor) { m.remove(); document.removeEventListener('mousedown', off); } };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
    if (m.getBoundingClientRect().bottom > window.innerHeight) m.style.top = Math.max(8, r.top - m.offsetHeight - 6) + 'px';
  }
  const switchEl = (checked, onchange) => { const b = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!checked), onclick: () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onchange(v); } }); return b; };
  const field = (label, control, help) => el('div', { class: 'field' }, el('label', {}, label), control, help ? el('div', { class: 'help' }, help) : null);

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
  $('#loginForm').addEventListener('submit', async (e) => { e.preventDefault(); token = $('#loginToken').value.trim(); try { await api('/api/login', { method: 'POST', body: { token } }); localStorage.setItem('missile_token', token); $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); await boot(); } catch { $('#loginErr').textContent = 'That token was not accepted.'; } });

  // ---------------------------------------------------------------- state
  const S = { st: null, convs: [], conv: null, messages: [], streaming: false, abort: null, view: 'chat', settingsPage: 'providers', sel: {}, attachments: [], search: '', asstPick: null };
  const theme = { get: () => document.documentElement.getAttribute('data-theme') || '', toggle() { const cur = this.get() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const next = cur === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', next); try { localStorage.setItem('missile_theme', next); } catch {} render(); } };
  async function loadState() { S.st = await api('/api/state'); }
  async function loadConvs() { S.convs = await api('/api/conversations'); }
  const providerOf = (id) => S.st.providers.find((p) => p.id === id);
  const assistantOf = (id) => S.st.assistants.find((a) => a.id === id);
  const currentTarget = () => { const c = S.conv; const pid = c?.provider_id || S.sel.provider || S.st.default.provider || S.st.providers[0]?.id || ''; const p = providerOf(pid); const model = c?.model || S.sel.model || (pid === S.st.default.provider ? S.st.default.model : '') || p?.default_model || p?.models?.[0] || ''; const aid = c?.assistant_id || S.sel.assistant || S.st.default.assistant || 'default'; return { pid, model, aid, provider: p, assistant: assistantOf(aid) }; };

  // ---------------------------------------------------------------- shell
  function render() {
    const app = $('#app'); app.innerHTML = '';
    if (S.view.startsWith('settings')) { app.append(renderSettings()); return; }
    const shell = el('div', { class: 'shell' + (S.view === 'chat' || S.view === 'assistants' ? '' : ' no-pane') });
    shell.append(renderRail());
    if (S.view === 'chat') { shell.append(renderConvPane()); shell.append(renderChatMain()); }
    else if (S.view === 'assistants') { shell.append(renderAssistantPane()); shell.append(renderChatMain()); }
    app.append(shell);
  }
  function renderRail() {
    const btn = (name, icon, label, onclick) => el('button', { class: S.view === name || (name === 'settings' && S.view.startsWith('settings')) ? 'active' : '', onclick, 'aria-label': label }, I(icon), el('span', { class: 'tip' }, label));
    const rail = el('div', { class: 'rail' },
      el('div', { class: 'logo' }, '🚀'),
      btn('chat', 'chat', 'Chat', () => { S.view = 'chat'; render(); }),
      btn('assistants', 'sparkles', 'Assistants', () => { S.view = 'assistants'; render(); }),
      btn('settings', 'settings', 'Settings', () => { S.view = 'settings'; render(); }),
      el('div', { class: 'bottom' },
        el('button', { onclick: () => theme.toggle(), 'aria-label': 'theme' }, I(theme.get() === 'dark' || (!theme.get() && matchMedia('(prefers-color-scheme: dark)').matches) ? 'sun' : 'moon'), el('span', { class: 'tip' }, 'Theme')),
        el('button', { onclick: () => window.open('/admin', '_blank'), 'aria-label': 'admin' }, I('shield'), el('span', { class: 'tip' }, 'Admin console')),
      ));
    return rail;
  }

  // ---------------------------------------------------------------- conversations pane
  function groupLabel(ts) { const d = new Date(ts * 1000), now = new Date(); const sameDay = d.toDateString() === now.toDateString(); if (sameDay) return 'Today'; const y = new Date(now); y.setDate(now.getDate() - 1); if (d.toDateString() === y.toDateString()) return 'Yesterday'; if (now - d < 7 * 86400e3) return 'Previous 7 days'; return 'Older'; }
  function renderConvPane() {
    const pane = el('div', { class: 'pane' });
    pane.append(el('div', { class: 'pane-head' }, el('h2', {}, 'Chats'), el('span', { class: 'spacer' }), el('button', { class: 'btn primary sm', onclick: newConv }, I('plus', 'sm'), 'New chat')));
    const search = el('input', { class: 'input', placeholder: 'Search chats', value: S.search, oninput: (e) => { S.search = e.target.value; renderList(); } });
    pane.append(el('div', { class: 'pane-search' }, I('search', 'sm'), search));
    const list = el('div', { class: 'pane-list' }); pane.append(list);
    function renderList() {
      list.innerHTML = ''; let last = '';
      const q = S.search.toLowerCase();
      const items = S.convs.filter((c) => !q || (c.title || '').toLowerCase().includes(q));
      for (const c of items) {
        const g = groupLabel(c.updated_at); if (g !== last) { list.append(el('div', { class: 'pane-group' }, g)); last = g; }
        const a = assistantOf(c.assistant_id);
        list.append(el('div', { class: 'pane-item' + (S.conv && S.conv.id === c.id ? ' active' : ''), onclick: () => openConv(c.id) },
          el('div', { class: 'em' }, a?.emoji || '💬'),
          el('div', { class: 'body' }, el('div', { class: 'title truncate' }, c.title || 'New chat'), el('div', { class: 'sub truncate' }, `${shortModel(c.model) || providerOf(c.provider_id)?.label || ''}`)),
          el('button', { class: 'x', title: 'Delete', onclick: async (e) => { e.stopPropagation(); if (await confirmDialog('Delete this chat and its messages?')) { await api('/api/conversations/' + c.id, { method: 'DELETE' }); if (S.conv?.id === c.id) { S.conv = null; S.messages = []; } await loadConvs(); render(); } } }, I('trash', 'xs'))));
      }
      if (!items.length) list.append(el('div', { class: 'muted tiny', style: 'padding:14px 10px' }, S.convs.length ? 'No chats match.' : 'No chats yet. Start one.'));
    }
    renderList();
    return pane;
  }
  function renderAssistantPane() {
    const pane = el('div', { class: 'pane' });
    pane.append(el('div', { class: 'pane-head' }, el('h2', {}, 'Assistants'), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: () => { S.view = 'settings'; S.settingsPage = 'assistants'; render(); } }, I('edit', 'sm'), 'Manage')));
    const list = el('div', { class: 'pane-list' }); pane.append(list);
    const cur = currentTarget();
    for (const a of S.st.assistants) {
      list.append(el('div', { class: 'pane-item' + (cur.aid === a.id ? ' active' : ''), onclick: async () => { S.sel.assistant = a.id; if (S.conv) { await api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { assistant_id: a.id } }); S.conv.assistant_id = a.id; } render(); } },
        el('div', { class: 'em' }, a.emoji || '🤖'),
        el('div', { class: 'body' }, el('div', { class: 'title truncate' }, a.name), el('div', { class: 'sub truncate' }, (a.system_prompt || 'No system prompt').slice(0, 60)))));
    }
    list.append(el('div', { style: 'padding:10px' }, el('button', { class: 'btn sm', style: 'width:100%', onclick: () => { S.view = 'settings'; S.settingsPage = 'assistants'; S.sel.newAssistant = true; render(); } }, I('plus', 'sm'), 'Add assistant')));
    return pane;
  }

  // ---------------------------------------------------------------- chat main
  function modelPicker() {
    const t = currentTarget();
    const pill = el('button', { class: 'picker', title: 'Choose model' }, el('span', { class: 'pv' }, (t.provider?.label || t.pid || 'no provider').split(' ')[0]), el('span', { class: 'name truncate' }, shortModel(t.model) || 'pick a model'), I('chevron', 'xs'));
    pill.addEventListener('click', () => {
      const items = [];
      for (const p of S.st.providers) {
        const models = [...new Set([p.default_model, ...(p.models || [])].filter(Boolean))];
        items.push({ group: p.label || p.id });
        if (!models.length) items.push({ label: '(no models: Discover in Settings)', sub: p.id, pid: p.id, model: '' });
        for (const m of models.slice(0, 400)) items.push({ label: shortModel(m), sub: p.id, pid: p.id, model: m, selected: p.id === t.pid && m === t.model });
      }
      if (!items.length) items.push({ label: 'Add a provider in Settings', sub: '', pid: '', model: '' });
      menu(pill, items, { searchable: true, onPick: async (it) => { if (!it.pid) { S.view = 'settings'; S.settingsPage = 'providers'; render(); return; } S.sel.provider = it.pid; S.sel.model = it.model; if (S.conv) { await api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { provider_id: it.pid, model: it.model } }); S.conv.provider_id = it.pid; S.conv.model = it.model; } render(); } });
    });
    return pill;
  }
  function renderChatMain() {
    const t = currentTarget();
    const main = el('div', { class: 'main' });
    const asstBtn = el('button', { class: 'btn quiet', style: 'padding:0 8px' }, el('span', { class: 'asst' }, el('span', { class: 'em' }, t.assistant?.emoji || '🤖'), t.assistant?.name || 'Assistant'), I('chevron', 'xs'));
    asstBtn.addEventListener('click', () => menu(asstBtn, S.st.assistants.map((a) => ({ label: a.name, sub: a.id, id: a.id, selected: a.id === t.aid })), { onPick: async (it) => { S.sel.assistant = it.id; if (S.conv) { await api('/api/conversations/' + S.conv.id, { method: 'PATCH', body: { assistant_id: it.id } }); S.conv.assistant_id = it.id; } render(); } }));
    const toolsOn = S.sel.tools !== false;
    const toolsBtn = t.provider?.kind === 'agentserver' ? el('span', { class: 'chip info' }, I('cloud', 'xs'), 'tools run on the agent server') : el('button', { class: 'btn quiet sm', title: 'Toggle local tools for this chat', onclick: () => { S.sel.tools = !toolsOn; render(); } }, I('wrench', 'sm'), toolsOn ? `${S.st.tools.length} tools` : 'tools off', switchEl(toolsOn, (v) => { S.sel.tools = v; render(); }));
    main.append(el('div', { class: 'topbar' }, asstBtn, modelPicker(), toolsBtn, el('span', { class: 'spacer' }), S.conv ? el('span', { class: 'muted tiny truncate', style: 'max-width:320px' }, S.conv.title || '') : null, S.conv ? el('button', { class: 'btn quiet icon sm', title: 'Delete chat', onclick: async () => { if (await confirmDialog('Delete this chat and its messages?')) { await api('/api/conversations/' + S.conv.id, { method: 'DELETE' }); S.conv = null; S.messages = []; await loadConvs(); render(); } } }, I('trash', 'sm')) : null));
    const scroll = el('div', { class: 'chat-scroll' }); const inner = el('div', { class: 'chat-inner' }); scroll.append(inner); main.append(scroll);
    renderMessages(inner);
    main.append(renderComposer());
    return main;
  }
  function toolCard(call, result) {
    const state = result ? (result.is_error ? 'err' : 'ok') : 'run';
    const d = el('details', { class: 'tool ' + state, open: state !== 'ok' });
    const stateText = result ? `${result.decision || (result.is_error ? 'error' : 'ok')}${result.duration_ms != null ? ' · ' + fmtMs(result.duration_ms) : ''}` : 'running…';
    d.append(el('summary', {}, el('span', { class: 'dot' }), I('wrench', 'sm'), el('span', { class: 'tname' }, call.name), el('span', { class: 'tstate' }, stateText, I('chevron', 'xs'))));
    const body = el('div', { class: 'tbody' });
    const args = JSON.stringify(call.arguments ?? {}, null, 1);
    body.append(el('div', { class: 'lbl' }, 'arguments'), el('pre', {}, args.length > 2000 ? args.slice(0, 2000) + '…' : args));
    if (result) { body.append(el('div', { class: 'lbl' }, 'result'), el('pre', {}, String(result.text || result.content || '').slice(0, 6000))); for (const im of result.images || []) body.append(el('img', { src: `data:${im.mime_type || 'image/png'};base64,${im.data}` })); }
    d.append(body);
    return d;
  }
  function assistantTurn(m, toolResults, live) {
    const t = currentTarget();
    const node = el('div', { class: 'turn-ai' }, el('div', { class: 'av' }, t.assistant?.emoji || '🚀'));
    const body = el('div', { class: 'body' }); node.append(body);
    body.append(el('div', { class: 'head' }, el('span', { class: 'name' }, t.assistant?.name || 'Assistant'), el('span', { class: 'model' }, shortModel(m?.meta?.model || t.model))));
    const content = el('div'); body.append(content);
    if (m) {
      if (m.thinking) content.append(el('details', { class: 'think' }, el('summary', {}, I('brain', 'sm'), 'Thinking'), el('div', { class: 'tbody' }, m.thinking)));
      if (m.content) content.append(el('div', { class: 'md', html: md(m.content) }));
      for (const c of m.tool_calls || []) content.append(toolCard(c, toolResults[c.id]));
      const meta = el('div', { class: 'meta' });
      if (m.meta?.duration_ms) meta.append(el('span', {}, `Processed · ${fmtMs(m.meta.duration_ms)}`));
      if (m.meta?.usage) meta.append(el('span', {}, `${m.meta.usage.input_tokens || 0}↑ ${m.meta.usage.output_tokens || 0}↓ tokens`));
      if (m.content) meta.append(el('span', { class: 'actions' }, el('button', { class: 'btn quiet icon sm', title: 'Copy', onclick: () => navigator.clipboard.writeText(m.content).then(() => toast('copied')) }, I('copy', 'xs'))));
      body.append(meta);
    }
    return { node, content, body };
  }
  function addCopyButtons(root) { root.querySelectorAll('pre').forEach((pre) => { if (pre.querySelector('.copy-btn')) return; pre.append(el('button', { class: 'copy-btn', onclick: () => navigator.clipboard.writeText(pre.innerText.replace(/copy$/, '')).then(() => toast('copied')) }, 'copy')); }); }
  function renderMessages(inner) {
    inner.innerHTML = '';
    if (!S.conv || !S.messages.length) {
      const t = currentTarget();
      const sugg = ['Summarize the files in my workspace', 'What tools do you have? Show one example each', 'Write a short project README from notes/', 'Explain this error: ECONNREFUSED 127.0.0.1:11434'];
      inner.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, t.assistant?.emoji || '🚀'), el('h3', {}, t.assistant?.name ? `Chat with ${t.assistant.name}` : 'What can I help with?'), el('div', {}, t.provider ? `${t.provider.label || t.pid} · ${shortModel(t.model) || 'pick a model'} · ${S.st.tools.length} tools` : 'Add a provider in Settings to start.'), el('div', { class: 'sugg' }, sugg.map((s) => el('button', { onclick: () => { $('#composerInput').value = s; send(); } }, s)))));
      return;
    }
    const toolResults = {}; for (const m of S.messages) if (m.role === 'tool') toolResults[m.tool_call_id] = { text: m.content, is_error: m.is_error, images: m.images, decision: m.decision, duration_ms: m.duration_ms };
    // group consecutive assistant/tool messages into one turn
    let i = 0;
    while (i < S.messages.length) {
      const m = S.messages[i];
      if (m.role === 'user') {
        const text = typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        const bub = el('div', { class: 'bubble' }, text);
        for (const p of (Array.isArray(m.content) ? m.content : [])) if (p.type === 'image_url') bub.append(el('img', { src: p.image_url.url }));
        inner.append(el('div', { class: 'turn-user' }, bub, el('div', { class: 'av' }, '🧑')));
        i++; continue;
      }
      if (m.role === 'assistant') {
        // merge the chain assistant(tool_calls) -> tools -> assistant ... into one visual turn
        const { node, content, body } = assistantTurn(null, toolResults);
        body.querySelector('.head .model').textContent = shortModel(m.meta?.model || '');
        let totalMs = 0, usage = null, lastText = '';
        while (i < S.messages.length && S.messages[i].role !== 'user') {
          const mm = S.messages[i];
          if (mm.role === 'assistant') {
            if (mm.thinking) content.append(el('details', { class: 'think' }, el('summary', {}, I('brain', 'sm'), 'Thinking'), el('div', { class: 'tbody' }, mm.thinking)));
            if (mm.content) { content.append(el('div', { class: 'md', html: md(mm.content) })); lastText = mm.content; }
            for (const c of mm.tool_calls || []) content.append(toolCard(c, toolResults[c.id]));
            if (mm.meta?.duration_ms) totalMs += mm.meta.duration_ms; if (mm.meta?.usage) usage = mm.meta.usage;
          }
          i++;
        }
        const meta = el('div', { class: 'meta' }); if (totalMs) meta.append(el('span', {}, `Processed · ${fmtMs(totalMs)}`)); if (usage) meta.append(el('span', {}, `${usage.input_tokens || 0}↑ ${usage.output_tokens || 0}↓ tokens`));
        if (lastText) meta.append(el('span', { class: 'actions' }, el('button', { class: 'btn quiet icon sm', title: 'Copy', onclick: () => navigator.clipboard.writeText(lastText).then(() => toast('copied')) }, I('copy', 'xs'))));
        body.append(meta); inner.append(node); continue;
      }
      i++;
    }
    addCopyButtons(inner);
    requestAnimationFrame(() => { inner.parentElement.scrollTop = inner.parentElement.scrollHeight; });
  }
  function renderComposer() {
    const t = currentTarget();
    const wrap = el('div', { class: 'composer-wrap' });
    const box = el('div', { class: 'composer' });
    const att = el('div', { class: 'attachments' + (S.attachments.length ? '' : ' hidden') }); box.append(att);
    const ta = el('textarea', { id: 'composerInput', rows: 1, placeholder: t.provider ? 'Type a message. Enter to send, Shift+Enter for a new line.' : 'Add a provider in Settings first…' });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(260, ta.scrollHeight) + 'px'; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    box.append(ta);
    const fileInput = el('input', { type: 'file', multiple: true, style: 'display:none', onchange: async (e) => { for (const f of e.target.files) { const fd = new FormData(); fd.append('file', f); try { S.attachments.push(await api('/api/upload', { method: 'POST', body: fd })); } catch (err) { toast(`${f.name}: ${err.message}`, true); } } e.target.value = ''; renderAtt(); } });
    const bar = el('div', { class: 'bar' },
      el('button', { class: 'btn quiet icon sm', title: 'Attach file or image', onclick: () => fileInput.click() }, I('paperclip', 'sm')), fileInput,
      el('button', { class: 'btn quiet icon sm', title: 'New chat', onclick: newConv }, I('plus', 'sm')),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted tiny truncate', style: 'max-width:260px' }, t.provider ? `${t.provider.label || t.pid} · ${shortModel(t.model)}` : ''),
      S.streaming ? el('button', { class: 'stop', id: 'btnStop', onclick: stopTurn }, I('stop', 'sm'), 'Stop') : el('button', { class: 'send', id: 'btnSend', title: 'Send', onclick: send, disabled: !t.provider }, I('send', 'sm')));
    box.append(bar); wrap.append(box);
    wrap.append(el('div', { class: 'hintline' }, 'Tools that need approval pause the turn and ask you here. Every tool call is in the audit log.'));
    function renderAtt() { att.innerHTML = ''; att.classList.toggle('hidden', !S.attachments.length); S.attachments.forEach((a, i) => att.append(el('span', { class: 'chip' }, a.data_url ? '🖼' : '📄', a.name, el('button', { onclick: () => { S.attachments.splice(i, 1); renderAtt(); } }, '✕')))); }
    renderAtt();
    document.onpaste = async (e) => { for (const it of e.clipboardData?.items || []) if (it.type.startsWith('image/')) { const fd = new FormData(); fd.append('file', it.getAsFile(), 'pasted.png'); try { S.attachments.push(await api('/api/upload', { method: 'POST', body: fd })); renderAtt(); } catch (err) { toast(err.message, true); } } };
    return wrap;
  }
  async function newConv() { S.conv = null; S.messages = []; S.view = 'chat'; render(); $('#composerInput')?.focus(); }
  async function openConv(id) { S.conv = await api('/api/conversations/' + id); S.messages = S.conv.messages || []; S.view = 'chat'; render(); }
  async function stopTurn() { if (S.conv) await api(`/api/chat/${S.conv.id}/stop`, { method: 'POST' }).catch(() => {}); if (S.abort) S.abort.abort(); }

  async function send() {
    const ta = $('#composerInput'); const text = (ta?.value || '').trim(); if (!text || S.streaming) return;
    const t = currentTarget(); if (!t.pid) return toast('Add a provider first (Settings → Model providers)', true);
    if (!S.conv) { S.conv = await api('/api/conversations', { method: 'POST', body: { assistant_id: t.aid, provider_id: t.pid, model: t.model } }); S.messages = []; await loadConvs(); }
    const atts = S.attachments.splice(0);
    S.messages.push({ role: 'user', content: atts.some((a) => a.data_url) ? [{ type: 'text', text }, ...atts.filter((a) => a.data_url).map((a) => ({ type: 'image_url', image_url: { url: a.data_url } }))] : text });
    S.streaming = true; render();
    const inner = $('.chat-inner'); const scroll = inner.parentElement;
    const { node, content } = assistantTurn(null, {}); inner.append(node);
    let textBuf = '', thinkBuf = '', mdEl = null, thinkEl = null, statusEl = null; const cards = {}; const t0 = Date.now();
    const flush = () => { if (!mdEl) { mdEl = el('div', { class: 'md cursor' }); content.append(mdEl); } mdEl.innerHTML = md(textBuf); scroll.scrollTop = scroll.scrollHeight; };
    S.abort = new AbortController();
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify({ conversation_id: S.conv.id, text, provider_id: t.pid, model: t.model, assistant_id: t.aid, attachments: atts, tools: S.sel.tools === false ? 'none' : null }), signal: S.abort.signal });
      if (!r.ok) throw new Error((await r.text()) || r.statusText);
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx; while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'); if (!data) continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          handle(ev);
        }
      }
    } catch (e) { if (e.name !== 'AbortError') content.append(el('div', { class: 'error-line' }, e.message)); }
    finally { S.streaming = false; S.abort = null; try { S.conv = await api('/api/conversations/' + S.conv.id); S.messages = S.conv.messages || []; await loadConvs(); } catch {} render(); }
    function handle(ev) {
      switch (ev.type) {
        case 'text_delta': textBuf += ev.text; flush(); break;
        case 'thinking_delta': thinkBuf += ev.text; if (!thinkEl) { const d = el('details', { class: 'think', open: true }, el('summary', {}, I('brain', 'sm'), 'Thinking')); thinkEl = el('div', { class: 'tbody' }); d.append(thinkEl); content.prepend(d); } thinkEl.textContent = thinkBuf; break;
        case 'tool_call': { if (mdEl) mdEl.classList.remove('cursor'); mdEl = null; textBuf = ''; const c = toolCard(ev, null); cards[ev.id] = { card: c, call: ev }; content.append(c); scroll.scrollTop = scroll.scrollHeight; break; }
        case 'tool_result': { const k = cards[ev.id]; const nc = toolCard(k ? k.call : { name: ev.name, arguments: {} }, ev); if (k) k.card.replaceWith(nc); else content.append(nc); cards[ev.id] = { card: nc, call: k ? k.call : { name: ev.name } }; break; }
        case 'approval_required': { const a = el('div', { class: 'approval', 'data-approval': ev.id }, el('div', { class: 'ttl' }, I('alert', 'sm'), `${ev.name} wants to run`, el('span', { class: 'muted tiny', style: 'font-weight:400' }, ev.reason || '')), el('pre', {}, JSON.stringify(ev.arguments, null, 1).slice(0, 2000)), el('div', { class: 'row' }, ...[['Allow once', 'allow', 'btn primary sm'], ['Allow for this chat', 'allow_session', 'btn sm'], ['Always allow', 'allow_always', 'btn sm'], ['Deny', 'deny', 'btn danger sm']].map(([l, d, cls]) => el('button', { class: cls, onclick: async () => { await api('/api/approvals/' + ev.id, { method: 'POST', body: { decision: d } }).catch((e) => toast(e.message, true)); a.remove(); } }, l)))); content.append(a); scroll.scrollTop = scroll.scrollHeight; break; }
        case 'remote_tool': case 'status': { if (!statusEl) { statusEl = el('div', { class: 'status-line' }); content.append(statusEl); } statusEl.innerHTML = ''; statusEl.append(I('activity', 'xs'), ev.type === 'remote_tool' ? `${ev.event} ${ev.name || ''}` : (ev.event === 'max_iterations' ? 'stopped: max iterations reached' : `${ev.event}…`)); break; }
        case 'error': content.append(el('div', { class: 'error-line' }, ev.message)); break;
        case 'done': if (statusEl) statusEl.remove(); if (mdEl) mdEl.classList.remove('cursor'); break;
      }
    }
  }
  setInterval(async () => { if (!S.st || S.view !== 'chat') return; try { const p = await api('/api/approvals'); for (const a of p) if (!$(`[data-approval="${a.id}"]`) && S.streaming) { /* rendered from the stream */ } } catch {} }, 5000);

  // ---------------------------------------------------------------- settings
  const SETTINGS_NAV = [
    { grp: 'Models' }, { id: 'providers', label: 'Model providers', icon: 'cloud' }, { id: 'default', label: 'Default model', icon: 'box' },
    { grp: 'Tools' }, { id: 'mcp', label: 'MCP servers', icon: 'plug' }, { id: 'tools', label: 'Tools & policy', icon: 'wrench' }, { id: 'assistants', label: 'Assistants', icon: 'sparkles' }, { id: 'agents', label: 'Agent servers', icon: 'bot' },
    { grp: 'Studio' }, { id: 'audit', label: 'Audit log', icon: 'list' }, { id: 'general', label: 'General', icon: 'settings' },
  ];
  function renderSettings() {
    const root = el('div', { class: 'settings' });
    const nav = el('div', { class: 'snav' }, el('h2', {}, 'Settings'));
    nav.append(el('button', { onclick: () => { S.view = 'chat'; render(); } }, I('chat', 'sm'), 'Back to chat'));
    for (const n of SETTINGS_NAV) { if (n.grp) { nav.append(el('div', { class: 'grp' }, n.grp)); continue; } nav.append(el('button', { class: S.settingsPage === n.id ? 'active' : '', onclick: () => { S.settingsPage = n.id; render(); } }, I(n.icon, 'sm'), n.label)); }
    root.append(nav);
    const content = el('div', { class: 'scontent' }); root.append(content);
    ({ providers: pageProviders, default: pageDefault, mcp: pageMcp, tools: pageTools, assistants: pageAssistants, agents: pageAgents, audit: pageAudit, general: pageGeneral }[S.settingsPage] || pageProviders)(content);
    return root;
  }
  const page = (title, sub, ...kids) => el('div', { class: 'page' }, el('h1', {}, title, sub ? el('small', {}, sub) : null), ...kids);

  // ---- providers
  function pageProviders(content) {
    const list = el('div', { class: 'listbox' });
    const selId = S.sel.providerId && providerOf(S.sel.providerId) ? S.sel.providerId : (S.st.providers[0]?.id || '');
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'width:100%', onclick: addProviderModal }, I('plus', 'sm'), 'Add provider')));
    for (const p of S.st.providers) list.append(el('div', { class: 'lrow' + (p.id === selId ? ' active' : ''), onclick: () => { S.sel.providerId = p.id; render(); } }, el('div', { class: 'em', style: avatarStyle(p.id) }, initials(p.label || p.id)), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, p.label || p.id), el('div', { class: 'sub truncate' }, `${p.kind} · ${p.models.length} models`)), el('span', { class: 'dot ' + (p.enabled === false ? '' : (p.has_key || p.kind === 'agentserver' || /127\.0\.0\.1|localhost/.test(p.base_url) ? 'ok' : 'warn')) })));
    if (!S.st.providers.length) list.append(el('div', { class: 'muted tiny', style: 'padding:14px' }, 'No providers yet.'));
    const detail = el('div');
    const p = providerOf(selId);
    if (p) detail.append(providerDetail(p)); else detail.append(el('div', { class: 'card' }, el('h3', {}, 'Pick a preset to begin'), el('p', { class: 'muted', style: 'margin:0' }, 'OpenAI, Anthropic, Gemini, DashScope, OpenRouter, Groq, DeepSeek, Mistral, xAI, or local Ollama / LM Studio / vLLM / llama.cpp. Any OpenAI-compatible endpoint works.'), el('div', {}, el('button', { class: 'btn primary', onclick: addProviderModal }, I('plus', 'sm'), 'Add provider'))));
    content.append(page('Model providers', 'where your models come from', el('div', { class: 'split' }, list, detail)));
  }
  function providerDetail(p) {
    const card = el('div', { class: 'card' });
    const draft = { ...p };
    card.append(el('h3', {}, el('span', { class: 'em', style: `${avatarStyle(p.id)};width:28px;height:28px;border-radius:8px;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700` }, initials(p.label || p.id)), p.label || p.id, el('span', { class: 'chip' }, p.kind), S.st.default.provider === p.id ? el('span', { class: 'chip primary' }, 'default') : null, el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, 'enabled'), switchEl(p.enabled !== false, async (v) => { await api('/api/providers', { method: 'POST', body: { id: p.id, enabled: v } }); await loadState(); })));
    const keyIn = el('input', { class: 'input', type: 'password', placeholder: p.has_key ? 'saved · type to replace' : (p.kind === 'agentserver' ? '(not used)' : 'paste API key, or set an env var below'), oninput: (e) => { draft.api_key = e.target.value; } });
    const eye = el('button', { class: 'btn icon', title: 'show', onclick: () => { keyIn.type = keyIn.type === 'password' ? 'text' : 'password'; } }, I('eye', 'sm'));
    const testOut = el('pre', { class: 'out hidden' });
    const testBtn = el('button', { class: 'btn', onclick: async () => { testOut.classList.remove('hidden'); testOut.textContent = 'testing…'; try { const r = await api('/api/providers/test', { method: 'POST', body: { ...draft } }); testOut.textContent = r.ok ? `OK · ${r.count} models · ${r.ms}ms\n${r.models.slice(0, 40).join('\n')}${r.count > 40 ? '\n…' : ''}` : 'FAIL · ' + r.error; } catch (e) { testOut.textContent = e.message; } } }, I('activity', 'sm'), 'Test');
    if (p.kind !== 'agentserver') card.append(field('API key', el('div', { class: 'row', style: 'flex-wrap:nowrap' }, keyIn, eye, testBtn), 'Stored in config.json on this machine. Never sent back to the browser.'), field('API key from environment variable', el('input', { class: 'input', value: p.api_key_env || '', placeholder: 'OPENAI_API_KEY', oninput: (e) => { draft.api_key_env = e.target.value; } })));
    card.append(field('Base URL', el('input', { class: 'input', value: p.base_url || '', oninput: (e) => { draft.base_url = e.target.value; } })));
    if (p.kind === 'agentserver') card.append(el('div', { class: 'grid2' }, field('Login e-mail', el('input', { class: 'input', value: p.email || '', oninput: (e) => { draft.email = e.target.value; } })), field('Password', el('div', { class: 'row', style: 'flex-wrap:nowrap' }, el('input', { class: 'input', type: 'password', placeholder: p.has_password ? 'saved · type to replace' : '', oninput: (e) => { draft.password = e.target.value; } }), testBtn))));
    card.append(testOut);
    // models
    const models = [...new Set([p.default_model, ...(p.models || [])].filter(Boolean))];
    const modelsBox = el('div', { class: 'pill-list' });
    const renderModels = () => { modelsBox.innerHTML = ''; for (const m of models.slice(0, 300)) modelsBox.append(el('span', { class: 'chip' + (m === draft.default_model ? ' sel' : ''), title: 'set as default model', onclick: () => { draft.default_model = m; renderModels(); } }, shortModel(m))); if (models.length > 300) modelsBox.append(el('span', { class: 'muted tiny' }, `+${models.length - 300} more`)); if (!models.length) modelsBox.append(el('span', { class: 'muted tiny' }, 'No models yet. Discover, or type one below.')); };
    renderModels();
    const addModel = el('input', { class: 'input', placeholder: 'add a model id manually', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = addModel.value.trim(); if (v) { models.unshift(v); draft.models = [...new Set([...(draft.models || []), v])]; if (!draft.default_model) draft.default_model = v; addModel.value = ''; renderModels(); } } } });
    card.append(el('div', { class: 'sect' }, `Models · ${models.length}`), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { try { const r = await api(`/api/providers/${encodeURIComponent(p.id)}/models`, { method: 'POST' }); toast(`${r.models.length} models`); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('refresh', 'sm'), p.kind === 'agentserver' ? 'Sync agents' : 'Discover models'), addModel), modelsBox);
    // advanced
    const adv = el('details', {}, el('summary', { class: 'muted', style: 'cursor:pointer' }, 'Advanced: extra request body, headers, label, TLS'));
    adv.append(el('div', { class: 'grid2', style: 'margin-top:10px' }, field('Label', el('input', { class: 'input', value: p.label || '', oninput: (e) => { draft.label = e.target.value; } })), field('Allow self-signed TLS', switchEl(!!p.allow_insecure_tls, (v) => { draft.allow_insecure_tls = v; })), field('Extra body (JSON)', el('input', { class: 'input', value: Object.keys(p.extra_body || {}).length ? JSON.stringify(p.extra_body) : '', placeholder: '{"enable_thinking": false}', oninput: (e) => { draft._extra = e.target.value; } }), 'Merged into every request. Qwen/vLLM thinking switches live here.'), field('Headers (JSON)', el('input', { class: 'input', value: Object.keys(p.headers || {}).length ? JSON.stringify(p.headers) : '', placeholder: '{"X-Title": "missile"}', oninput: (e) => { draft._headers = e.target.value; } }))));
    card.append(adv);
    card.append(el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { try { const body = { ...draft }; delete body._extra; delete body._headers; if (draft._extra !== undefined) body.extra_body = draft._extra ? JSON.parse(draft._extra) : {}; if (draft._headers !== undefined) body.headers = draft._headers ? JSON.parse(draft._headers) : {}; if (!body.api_key) delete body.api_key; if (!body.password) delete body.password; await api('/api/providers', { method: 'POST', body }); toast('saved'); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('check', 'sm'), 'Save'), el('button', { class: 'btn', onclick: async () => { await api('/api/default', { method: 'POST', body: { provider: p.id, model: draft.default_model || p.default_model } }); toast('default updated'); await loadState(); render(); } }, 'Use as default'), el('span', { class: 'spacer' }), el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(`Remove provider ${p.id}?`)) { await api('/api/providers/' + encodeURIComponent(p.id), { method: 'DELETE' }); S.sel.providerId = ''; await loadState(); render(); } } }, I('trash', 'sm'), 'Remove')));
    return card;
  }
  function addProviderModal() {
    const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px' });
    const m = modal({ title: 'Add a provider', body: [el('p', { class: 'muted', style: 'margin:0' }, 'Pick a preset. You can change everything afterwards.'), grid], wide: true });
    for (const pr of S.st.presets) grid.append(el('button', { class: 'btn', style: 'height:auto;padding:10px 12px;justify-content:flex-start;text-align:left;gap:10px', onclick: () => { m.close(); createFromPreset(pr); } }, el('span', { class: 'em', style: `${avatarStyle(pr.id)};width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700;flex:none` }, initials(pr.label)), el('span', { style: 'min-width:0' }, el('div', { class: 'truncate', style: 'font-weight:600' }, pr.label), el('div', { class: 'muted tiny truncate' }, pr.needs_key ? 'API key' : 'no key · local'))));
  }
  function createFromPreset(pr) {
    let id = pr.id; let n = 2; while (providerOf(id)) id = `${pr.id}-${n++}`;
    const draft = { id, kind: pr.kind, label: pr.label, base_url: pr.base_url, default_model: pr.hint && !pr.hint.startsWith('(') ? pr.hint : '', extra_body: pr.extra_body || {}, api_key: '', email: '', password: '' };
    const body = [field('Id', el('input', { class: 'input', value: draft.id, oninput: (e) => { draft.id = e.target.value.trim(); } })), field('Base URL', el('input', { class: 'input', value: draft.base_url, oninput: (e) => { draft.base_url = e.target.value; } }))];
    if (pr.kind === 'agentserver') body.push(field('Login e-mail', el('input', { class: 'input', oninput: (e) => { draft.email = e.target.value; } })), field('Password', el('input', { class: 'input', type: 'password', oninput: (e) => { draft.password = e.target.value; } })));
    else body.push(field('API key', el('input', { class: 'input', type: 'password', placeholder: pr.needs_key ? 'sk-…' : 'not needed for local servers', oninput: (e) => { draft.api_key = e.target.value; } })));
    body.push(field('Default model', el('input', { class: 'input', value: draft.default_model, placeholder: pr.hint, oninput: (e) => { draft.default_model = e.target.value.trim(); } }), 'Leave empty and press Discover after saving.'));
    const m = modal({ title: `Add ${pr.label}`, body, footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: async () => { try { const b = { ...draft }; if (b.default_model) b.models = [b.default_model]; if (!b.api_key) delete b.api_key; if (!b.password) delete b.password; await api('/api/providers', { method: 'POST', body: b }); m.close(); S.sel.providerId = b.id; await loadState(); render(); try { const r = await api(`/api/providers/${encodeURIComponent(b.id)}/models`, { method: 'POST' }); toast(`${r.models.length} models found`); await loadState(); render(); } catch (e) { toast('saved. Discover failed: ' + e.message.slice(0, 120), true); } } catch (e) { toast(e.message, true); } } }, 'Save')] });
  }
  // ---- default model
  function pageDefault(content) {
    const d = S.st.default; const card = el('div', { class: 'card' });
    const sp = el('select', { class: 'select' }, el('option', { value: '' }, '(none)'), ...S.st.providers.map((p) => el('option', { value: p.id, selected: p.id === d.provider }, p.label || p.id)));
    const sm = el('select', { class: 'select' });
    const fillModels = () => { sm.innerHTML = ''; const p = providerOf(sp.value); for (const m of [...new Set([p?.default_model, ...(p?.models || [])].filter(Boolean))]) sm.append(el('option', { value: m, selected: m === d.model }, shortModel(m))); };
    sp.addEventListener('change', fillModels); fillModels();
    const sa = el('select', { class: 'select' }, ...S.st.assistants.map((a) => el('option', { value: a.id, selected: a.id === d.assistant }, a.name)));
    card.append(el('h3', {}, 'Defaults for new chats'), el('div', { class: 'grid2' }, field('Provider', sp), field('Model', sm)), field('Assistant', sa), el('div', {}, el('button', { class: 'btn primary', onclick: async () => { await api('/api/default', { method: 'POST', body: { provider: sp.value, model: sm.value, assistant: sa.value } }); toast('saved'); await loadState(); render(); } }, 'Save')));
    content.append(page('Default model', 'used when a chat does not pick one', card));
  }
  // ---- mcp
  function pageMcp(content) {
    const list = el('div', { class: 'listbox' });
    const names = S.st.mcp.map((s) => s.name); const selName = names.includes(S.sel.mcpName) ? S.sel.mcpName : names[0];
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'flex:1', onclick: () => mcpModal() }, I('plus', 'sm'), 'Add server'), el('button', { class: 'btn sm', onclick: importModal, title: 'Import from Claude Code, Cursor, …' }, I('download', 'sm'))));
    for (const s of S.st.mcp) list.append(el('div', { class: 'lrow' + (s.name === selName ? ' active' : ''), onclick: () => { S.sel.mcpName = s.name; render(); } }, el('span', { class: 'dot ' + (s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'err' : s.status === 'connecting' ? 'warn' : '') }), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, s.name), el('div', { class: 'sub truncate' }, `${s.status} · ${s.tool_count} tools · ${s.config.transport}`))));
    if (!S.st.mcp.length) list.append(el('div', { class: 'muted tiny', style: 'padding:14px' }, 'No MCP servers yet.'));
    const s = S.st.mcp.find((x) => x.name === selName);
    const detail = el('div');
    if (s) {
      const c = s.config; const card = el('div', { class: 'card' });
      card.append(el('h3', {}, s.name, el('span', { class: 'chip ' + (s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'err' : '') }, s.status), el('span', { class: 'chip' }, `${s.tool_count} tools`), el('span', { class: 'chip' }, c.transport), el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, 'enabled'), switchEl(c.enabled !== false, async (v) => { await api('/api/mcp', { method: 'POST', body: { name: s.name, config: { ...c, enabled: v } } }); setTimeout(async () => { await loadState(); render(); }, 800); })));
      card.append(el('div', { class: 'mono muted', style: 'overflow-wrap:anywhere' }, c.transport === 'stdio' ? [c.command, ...(c.args || [])].join(' ') : c.url));
      if (s.error) card.append(el('div', { class: 'error-line' }, s.error.slice(0, 400)));
      if (s.server_info?.name) card.append(el('div', { class: 'muted tiny' }, `server: ${s.server_info.name} ${s.server_info.version || ''}`));
      const tools = S.st.tools.filter((t) => t.server === s.name);
      if (tools.length) card.append(el('div', { class: 'sect' }, 'Tools'), el('div', { class: 'pill-list' }, tools.map((t) => el('span', { class: 'chip', title: t.description }, t.name, t.read_only ? ' · ro' : '', t.destructive ? ' · destructive' : ''))));
      card.append(el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => mcpModal(s.name, c) }, I('edit', 'sm'), 'Edit'), el('button', { class: 'btn', onclick: async () => { await api(`/api/mcp/${encodeURIComponent(s.name)}/restart`, { method: 'POST' }); toast('restarting'); setTimeout(async () => { await loadState(); render(); }, 1500); } }, I('refresh', 'sm'), 'Restart'), el('span', { class: 'spacer' }), el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(`Remove ${s.name}?`)) { await api('/api/mcp/' + encodeURIComponent(s.name), { method: 'DELETE' }); S.sel.mcpName = ''; await loadState(); render(); } } }, I('trash', 'sm'), 'Remove')));
      card.append(el('div', { class: 'muted tiny' }, 'Use this studio from other MCP clients: add a stdio server with command ', el('code', {}, 'ms'), ' and args ', el('code', {}, 'hub'), '. Export the standard JSON at ', el('a', { href: '/api/mcp/export', target: '_blank' }, '/api/mcp/export'), '.'));
      detail.append(card);
    } else detail.append(el('div', { class: 'card' }, el('h3', {}, 'Add your first MCP server'), el('p', { class: 'muted', style: 'margin:0' }, 'stdio commands (npx / uvx / python …), Streamable HTTP or SSE URLs. Or import the servers you already use in Claude Code, Claude Desktop, Cursor, Windsurf, VS Code or Cherry Studio.'), el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => mcpModal() }, I('plus', 'sm'), 'Add server'), el('button', { class: 'btn', onclick: importModal }, I('download', 'sm'), 'Import'))));
    content.append(page('MCP servers', 'tools from your machine and the network', el('div', { class: 'split' }, list, detail)));
  }
  const kv = (txt) => Object.fromEntries(txt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  function mcpModal(name = '', c = { transport: 'stdio', enabled: true }) {
    const d = { name, transport: c.transport || 'stdio', command: c.command || '', args: (c.args || []).join('\n'), env: Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'), cwd: c.cwd || '', url: c.url || '', headers: Object.entries(c.headers || {}).map(([k, v]) => `${k}=${v}`).join('\n'), enabled: c.enabled !== false };
    const stdio = el('div', { style: 'display:grid;gap:12px' }, field('Command', el('input', { class: 'input', value: d.command, placeholder: 'npx', oninput: (e) => { d.command = e.target.value; } })), field('Arguments (one per line)', el('textarea', { class: 'textarea', value: d.args, placeholder: '-y\n@modelcontextprotocol/server-filesystem\n.', oninput: (e) => { d.args = e.target.value; } })), field('Environment (KEY=VALUE per line)', el('textarea', { class: 'textarea', style: 'min-height:56px', value: d.env, oninput: (e) => { d.env = e.target.value; } })), field('Working directory', el('input', { class: 'input', value: d.cwd, oninput: (e) => { d.cwd = e.target.value; } })));
    const http = el('div', { style: 'display:grid;gap:12px' }, field('URL', el('input', { class: 'input', value: d.url, placeholder: 'http://127.0.0.1:8000/mcp', oninput: (e) => { d.url = e.target.value; } })), field('Headers (KEY=VALUE per line)', el('textarea', { class: 'textarea', style: 'min-height:56px', value: d.headers, oninput: (e) => { d.headers = e.target.value; } })));
    const tr = el('select', { class: 'select', onchange: (e) => { d.transport = e.target.value; stdio.classList.toggle('hidden', d.transport !== 'stdio'); http.classList.toggle('hidden', d.transport === 'stdio'); } }, el('option', { value: 'stdio', selected: d.transport === 'stdio' }, 'stdio (command)'), el('option', { value: 'http', selected: d.transport === 'http' }, 'Streamable HTTP'), el('option', { value: 'sse', selected: d.transport === 'sse' }, 'SSE'));
    stdio.classList.toggle('hidden', d.transport !== 'stdio'); http.classList.toggle('hidden', d.transport === 'stdio');
    const m = modal({ title: name ? `Edit ${name}` : 'Add MCP server', body: [el('div', { class: 'grid2' }, field('Name', el('input', { class: 'input', value: d.name, placeholder: 'filesystem', oninput: (e) => { d.name = e.target.value.trim(); } })), field('Transport', tr)), stdio, http], footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: async () => { if (!d.name) return toast('name required', true); const cfg = { transport: d.transport, enabled: d.enabled, command: d.command, args: d.args.split('\n').map((s) => s.trim()).filter(Boolean), env: kv(d.env), cwd: d.cwd, url: d.url, headers: kv(d.headers) }; try { await api('/api/mcp', { method: 'POST', body: { name: d.name, config: cfg } }); m.close(); S.sel.mcpName = d.name; toast('saved · connecting'); await loadState(); render(); setTimeout(async () => { await loadState(); render(); }, 2500); setTimeout(async () => { await loadState(); render(); }, 7000); } catch (e) { toast(e.message, true); } } }, 'Save & connect')] });
  }
  async function importModal() {
    const box = el('div', { style: 'display:grid;gap:8px' }, el('div', { class: 'muted' }, 'scanning…'));
    const ta = el('textarea', { class: 'textarea', placeholder: '{"mcpServers": {"fs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}}}' });
    const m = modal({ title: 'Import MCP servers', body: [box, el('details', {}, el('summary', { class: 'muted', style: 'cursor:pointer' }, 'Paste JSON (mcpServers / servers)'), ta, el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn', onclick: async () => { try { const r = await api('/api/mcp/import', { method: 'POST', body: { source: 'json', json_text: ta.value } }); toast(`imported ${r.added.length}`); m.close(); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, 'Import JSON')))], wide: true });
    try { const src = await api('/api/mcp/import/sources'); box.innerHTML = ''; for (const s of src) box.append(el('div', { class: 'card', style: 'padding:12px 14px;gap:6px' }, el('div', { class: 'row' }, el('b', {}, s.source), el('span', { class: 'chip ' + (s.available ? 'ok' : '') }, s.available ? `${s.servers.length} servers` : 'not found'), el('span', { class: 'spacer' }), s.available ? el('button', { class: 'btn sm primary', onclick: async () => { const r = await api('/api/mcp/import', { method: 'POST', body: { source: s.source } }); toast(`imported ${r.added.length}`); m.close(); await loadState(); render(); } }, 'Import all') : null), el('div', { class: 'muted tiny mono truncate' }, s.available ? s.servers.join(', ') : s.paths.join(' | ')))); } catch (e) { box.textContent = e.message; }
  }
  // ---- tools & policy
  function pageTools(content) {
    const pol = S.st.policy; const bt = S.st.builtin_tools;
    const polCard = el('div', { class: 'card' });
    const selDef = el('select', { class: 'select' }, ...['allow', 'ask', 'block'].map((v) => el('option', { value: v, selected: v === pol.default }, v)));
    const selRO = el('select', { class: 'select' }, ...['allow', 'ask', 'block'].map((v) => el('option', { value: v, selected: v === pol.read_only_default }, v)));
    const ws = el('input', { class: 'input', value: bt.workspace || '', placeholder: bt.workspace_resolved });
    const sw = { shell: bt.shell, filesystem: bt.filesystem, web: bt.web };
    polCard.append(el('h3', {}, 'Defaults'), el('div', { class: 'grid2' }, field('Tools that write or run things', selDef, 'ask = pause and show an approval card'), field('Read-only tools', selRO)), el('div', { class: 'sect' }, 'Local tools'), field('Workspace folder', ws, 'Local file and shell tools cannot leave this folder.'), el('div', { class: 'row' }, ...Object.keys(sw).map((k) => el('span', { class: 'row' }, switchEl(sw[k], (v) => { sw[k] = v; }), k === 'web' ? 'web fetch' : k))), el('div', {}, el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/policy', { method: 'PUT', body: { ...pol, default: selDef.value, read_only_default: selRO.value } }); await api('/api/builtin-tools', { method: 'PUT', body: { ...sw, workspace: ws.value.trim() } }); toast('saved'); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, 'Save')));
    const tb = el('tbody');
    for (const t of S.st.tools) {
      const sel = el('select', { class: 'select', onchange: async (e) => { const rules = { ...pol.rules }; if (e.target.value) rules[t.full_name] = e.target.value; else delete rules[t.full_name]; await api('/api/policy', { method: 'PUT', body: { ...pol, rules } }); pol.rules = rules; toast('rule saved'); } }, el('option', { value: '' }, 'default'), ...['allow', 'ask', 'block'].map((v) => el('option', { value: v, selected: pol.rules[t.full_name] === v }, v)));
      tb.append(el('tr', {}, el('td', { class: 'mono' }, t.full_name), el('td', {}, t.server), el('td', {}, t.read_only ? el('span', { class: 'chip ok' }, 'read-only') : null, ' ', t.destructive ? el('span', { class: 'chip warn' }, 'destructive') : null), el('td', {}, sel), el('td', { class: 'muted' }, (t.description || '').slice(0, 140))));
    }
    content.append(page('Tools & policy', 'what the agent may run, and when to ask you', polCard, el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'tool'), el('th', {}, 'server'), el('th', {}, 'flags'), el('th', {}, 'rule'), el('th', {}, 'description'))), tb))));
  }
  // ---- assistants
  function pageAssistants(content) {
    const list = el('div', { class: 'listbox' });
    const ids = S.st.assistants.map((a) => a.id);
    let sel = S.sel.newAssistant ? null : (ids.includes(S.sel.assistantId) ? S.sel.assistantId : ids[0]);
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'width:100%', onclick: () => { S.sel.newAssistant = true; render(); } }, I('plus', 'sm'), 'New assistant')));
    for (const a of S.st.assistants) list.append(el('div', { class: 'lrow' + (a.id === sel ? ' active' : ''), onclick: () => { S.sel.newAssistant = false; S.sel.assistantId = a.id; render(); } }, el('div', { class: 'em', style: 'background:var(--bg-subtle);color:var(--fg);font-size:16px' }, a.emoji || '🤖'), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, a.name), el('div', { class: 'sub truncate' }, a.model ? `${a.provider || 'default'} / ${shortModel(a.model)}` : 'default model')), S.st.default.assistant === a.id ? el('span', { class: 'chip primary' }, 'default') : null));
    const a = sel ? assistantOf(sel) : { id: '', name: '', emoji: '🤖', system_prompt: '', provider: '', model: '', tools: 'all', max_iterations: 25 };
    const d = { ...a, tools: Array.isArray(a.tools) ? a.tools.join(', ') : a.tools };
    const card = el('div', { class: 'card' },
      el('h3', {}, sel ? `Edit ${a.name}` : 'New assistant'),
      el('div', { class: 'grid2' }, field('Emoji', el('input', { class: 'input', value: d.emoji || '', oninput: (e) => { d.emoji = e.target.value; } })), field('Id', el('input', { class: 'input', value: d.id, disabled: !!sel, placeholder: 'writer', oninput: (e) => { d.id = e.target.value.trim(); } }))),
      field('Name', el('input', { class: 'input', value: d.name, oninput: (e) => { d.name = e.target.value; } })),
      field('System prompt', el('textarea', { class: 'textarea', style: 'min-height:160px', value: d.system_prompt || '', oninput: (e) => { d.system_prompt = e.target.value; } })),
      el('div', { class: 'grid2' }, field('Provider (optional)', el('select', { class: 'select', onchange: (e) => { d.provider = e.target.value; } }, el('option', { value: '' }, '(default)'), ...S.st.providers.map((p) => el('option', { value: p.id, selected: p.id === d.provider }, p.label || p.id)))), field('Model (optional)', el('input', { class: 'input', value: d.model || '', oninput: (e) => { d.model = e.target.value.trim(); } }))),
      el('div', { class: 'grid2' }, field('Tools', el('input', { class: 'input', value: d.tools, placeholder: 'all · none · local__*, filesystem__read_file', oninput: (e) => { d.tools = e.target.value; } })), field('Max tool iterations', el('input', { class: 'input', type: 'number', value: d.max_iterations || 25, oninput: (e) => { d.max_iterations = parseInt(e.target.value || '25', 10); } }))),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { const tv = (d.tools || '').trim(); const tools = !tv || tv === 'all' ? 'all' : tv === 'none' ? 'none' : tv.split(',').map((s) => s.trim()).filter(Boolean); try { await api('/api/assistants', { method: 'POST', body: { id: d.id, name: d.name, emoji: d.emoji, system_prompt: d.system_prompt, provider: d.provider, model: d.model, tools, max_iterations: d.max_iterations } }); toast('saved'); S.sel.newAssistant = false; S.sel.assistantId = d.id; await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('check', 'sm'), 'Save'), sel ? el('button', { class: 'btn', onclick: async () => { await api('/api/default', { method: 'POST', body: { assistant: a.id } }); await loadState(); render(); } }, 'Use as default') : null, el('span', { class: 'spacer' }), sel && a.id !== 'default' ? el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(`Delete assistant ${a.name}?`)) { await api('/api/assistants/' + a.id, { method: 'DELETE' }); S.sel.assistantId = ''; await loadState(); render(); } } }, I('trash', 'sm'), 'Delete') : null));
    content.append(page('Assistants', 'system prompt + preferred model + tool set', el('div', { class: 'split' }, list, card)));
  }
  // ---- agent servers
  function pageAgents(content) {
    const xs = S.st.providers.filter((p) => p.kind === 'agentserver');
    const card = el('div', { class: 'card' });
    if (!xs.length) card.append(el('h3', {}, 'No agent server configured'), el('p', { class: 'muted', style: 'margin:0' }, 'Add a provider with the "Agent server" preset (server URL + e-mail + password). Then its agents appear here and as models in chat.'), el('div', {}, el('button', { class: 'btn primary', onclick: () => { S.settingsPage = 'providers'; render(); addProviderModal(); } }, 'Add provider')));
    else {
      const sel = el('select', { class: 'select' }, ...xs.map((p) => el('option', { value: p.id, selected: p.id === S.sel.agentProvider }, `${p.label || p.id} (${p.base_url})`)));
      const trust = { v: false };
      const agentsBox = el('div', { class: 'pill-list' });
      const bridgeBox = el('div');
      const renderBridges = () => { bridgeBox.innerHTML = ''; for (const b of S.st.bridges) bridgeBox.append(el('div', { class: 'row' }, el('span', { class: 'dot ' + (b.status === 'connected' ? 'ok' : b.status === 'connecting' ? 'warn' : 'err') }), el('b', {}, b.provider_id), el('span', { class: 'chip' }, b.status), el('span', { class: 'chip' }, `${b.tool_count} tools`), el('span', { class: 'chip' }, `${b.calls} calls`), el('span', { class: 'muted tiny' }, b.device_name), b.error ? el('span', { class: 'muted tiny', style: 'color:var(--destructive)' }, b.error.slice(0, 120)) : null)); if (!S.st.bridges.length) bridgeBox.append(el('div', { class: 'muted tiny' }, 'Bridge not running. Start it to let the server\'s agents call your local tools and MCP servers (through your policy).')); };
      renderBridges();
      card.append(el('h3', {}, 'Agent server'), field('Server', sel), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { agentsBox.innerHTML = 'loading…'; try { const ag = await api(`/api/agents/${encodeURIComponent(sel.value)}`); agentsBox.innerHTML = ''; for (const a of ag) agentsBox.append(el('span', { class: 'chip', style: 'cursor:pointer', title: 'chat with this agent', onclick: async () => { const p = providerOf(sel.value); const model = `${a.id}|${a.name}`; await api('/api/providers', { method: 'POST', body: { id: p.id, default_model: model, models: [...new Set([model, ...(p.models || [])])] } }); await loadState(); S.sel.provider = p.id; S.sel.model = model; S.conv = null; S.messages = []; S.view = 'chat'; render(); } }, a.name)); if (!ag.length) agentsBox.textContent = 'no agents'; } catch (e) { agentsBox.textContent = e.message; } } }, I('refresh', 'sm'), 'List agents')), agentsBox, el('div', { class: 'sect' }, 'Device bridge'), bridgeBox, el('div', { class: 'row' }, switchEl(false, (v) => { trust.v = v; }), el('span', { class: 'muted tiny' }, 'trust: run "ask" tools without approval'), el('span', { class: 'spacer' }), el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/bridge/start', { method: 'POST', body: { provider_id: sel.value, trust: trust.v } }); toast('bridge starting'); setTimeout(async () => { await loadState(); render(); }, 2500); } catch (e) { toast(e.message, true); } } }, I('link', 'sm'), 'Start bridge'), el('button', { class: 'btn', onclick: async () => { await api('/api/bridge/stop', { method: 'POST', body: { provider_id: sel.value } }); await loadState(); render(); } }, 'Stop')));
    }
    content.append(page('Agent servers', 'chat with hosted agents, or lend this machine to them', card));
  }
  // ---- audit
  async function pageAudit(content) {
    const tb = el('tbody'); const wrap = page('Audit log', 'every tool call, decision and result', el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => { S.settingsPage = 'audit'; render(); } }, I('refresh', 'sm'), 'Refresh')), el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'time'), el('th', {}, 'tool'), el('th', {}, 'decision'), el('th', {}, 'took'), el('th', {}, 'arguments'), el('th', {}, 'result'))), tb)));
    content.append(wrap);
    try { const rows = await api('/api/audit?limit=300'); for (const r of rows) tb.append(el('tr', {}, el('td', { class: 'muted tiny' }, new Date(r.ts * 1000).toLocaleString()), el('td', { class: 'mono' }, r.tool), el('td', {}, el('span', { class: 'chip ' + (r.is_error ? 'err' : r.decision === 'allow' ? 'ok' : 'warn') }, r.decision + (r.is_error ? ' · error' : ''))), el('td', {}, fmtMs(r.duration_ms)), el('td', { class: 'mono' }, (r.arguments || '').slice(0, 160)), el('td', { class: 'mono' }, (r.result_excerpt || '').slice(0, 160)))); if (!rows.length) tb.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Nothing yet.'))); } catch (e) { toast(e.message, true); }
  }
  // ---- general
  function pageGeneral(content) {
    const st = S.st;
    content.append(page('General', 'this studio', el('div', { class: 'card' }, el('h3', {}, 'Server'), el('div', { class: 'grid2' }, field('Version', el('div', {}, 'missile-studio ' + st.version)), field('Bound to', el('div', {}, `${st.server.host}:${st.server.port}` + (st.server.auth_required ? ' · token required' : ' · loopback, no token'))), field('Config file', el('code', {}, st.config_path)), field('Data folder', el('code', {}, st.home))), el('div', { class: 'muted tiny' }, 'Change host/port/token with ', el('code', {}, 'ms serve --host 0.0.0.0 --port 7700 --token …'), ' or ', el('code', {}, 'ms config set-token …'), '. The admin console at ', el('a', { href: '/admin', target: '_blank' }, '/admin'), ' manages tokens, logs, retention and system status.')),
      el('div', { class: 'card' }, el('h3', {}, 'Appearance'), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => { document.documentElement.setAttribute('data-theme', 'light'); localStorage.setItem('missile_theme', 'light'); render(); } }, I('sun', 'sm'), 'Light'), el('button', { class: 'btn', onclick: () => { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('missile_theme', 'dark'); render(); } }, I('moon', 'sm'), 'Dark'), el('button', { class: 'btn', onclick: () => { document.documentElement.removeAttribute('data-theme'); localStorage.removeItem('missile_theme'); render(); } }, 'System'))),
      el('div', { class: 'card' }, el('h3', {}, 'Use this studio elsewhere'), el('div', { class: 'md', html: md('- **Terminal / SSH**: `ms chat`, `ms ask "…" --json`\n- **As one MCP server** for Claude Code, Cursor, Claude Desktop: `ms hub` (stdio) or `ms hub --http --port 7701`\n- **Lend tools to an agent server**: `ms bridge --provider <id>`\n- **API**: `Authorization: Bearer <token>`, docs at [/api/docs](/api/docs)') }))));
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try { const h = await fetch('/api/health').then((r) => r.json()); if (h.auth_required && !token) return showLogin(); } catch {}
    try { await loadState(); await loadConvs(); } catch (e) { if (e.message !== 'unauthorized') toast(e.message, true); return; }
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    if (!S.st.providers.length) { S.view = 'settings'; S.settingsPage = 'providers'; }
    render();
    setInterval(async () => { if (S.view.startsWith('settings') && (S.settingsPage === 'mcp' || S.settingsPage === 'agents')) { try { await loadState(); } catch {} } }, 6000);
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newConv(); } if (e.key === ',' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); S.view = 'settings'; render(); } });
  }
  boot();
})();
